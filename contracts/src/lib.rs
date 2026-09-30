#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, token, Address, Env, Symbol,
};

// ── Storage keys ────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    FeeRecipient,
    Bounty(u64),
    NextId,
    /// Tracks in-flight release attempts so retries are deterministic.
    ReleasePending(u64),
}

// ── Data types ───────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub struct Bounty {
    pub creator:          Address,
    pub hunter:           Address,
    pub token:            Address,
    pub amount:           i128,
    pub protocol_fee_bps: u32,
    pub released:         bool,
}

/// Snapshot of a release attempt, persisted before any token movement so that
/// a partial failure (e.g. fee transfer succeeds, payout transfer fails) can be
/// deterministically resumed or rolled forward on retry.
#[contracttype]
#[derive(Clone)]
pub struct ReleaseRecord {
    pub fee_paid:    bool,
    pub payout_paid: bool,
    pub fee:         i128,
    pub payout:      i128,
}

// ── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct BountyContract;

#[contractimpl]
impl BountyContract {
    /// One-time initialiser – sets the fee recipient address.
    pub fn initialize(env: Env, fee_recipient: Address) {
        if env.storage().instance().has(&DataKey::FeeRecipient) {
            panic!("already initialized");
        }
        env.storage()
            .instance()
            .set(&DataKey::FeeRecipient, &fee_recipient);
        env.storage().instance().set(&DataKey::NextId, &0u64);
    }

    /// Create a bounty.
    ///
    /// `protocol_fee_bps` is optional (pass 0 for no fee).  The full `amount`
    /// is transferred from the caller into the contract escrow immediately.
    pub fn create_bounty(
        env:              Env,
        creator:          Address,
        hunter:           Address,
        token:            Address,
        amount:           i128,
        protocol_fee_bps: u32,
    ) -> u64 {
        creator.require_auth();

        assert!(amount > 0,           "amount must be positive");
        assert!(protocol_fee_bps <= 10_000, "fee_bps must be <= 10000");

        // Invariant: hunter must be a distinct, non-zero address from creator to
        // avoid self-dealing and ambiguous authorization on release.
        assert!(creator != hunter, "creator and hunter must differ");

        // Pull funds into the contract.
        let client = token::Client::new(&env, &token);
        client.transfer(&creator, &env.current_contract_address(), &amount);

        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(0);
        let bounty = Bounty {
            creator,
            hunter,
            token,
            amount,
            protocol_fee_bps,
            released: false,
        };
        env.storage().persistent().set(&DataKey::Bounty(id), &bounty);
        env.storage().instance().set(&DataKey::NextId, &(id + 1));

        env.events().publish(
            (Symbol::new(&env, "bounty_created"), id),
            amount,
        );

        id
    }

    /// Release a bounty to the hunter, deducting the protocol fee first.
    ///
    /// Fee is deducted from the payout (not added on top).
    /// A fee of 0 bps results in the full amount going to the hunter.
    ///
    /// ## Determinism / failure recovery
    /// The release is split into two idempotent steps (fee, then payout). Before
    /// any token movement we persist a `ReleaseRecord` describing the intended
    /// transfers. Each step flips its flag *after* the transfer succeeds. If the
    /// transaction aborts mid-way (e.g. token contract failure), the persisted
    /// record lets a retry skip already-completed steps and finish the rest,
    /// guaranteeing exactly-once payouts and no silent loss of escrowed funds.
    pub fn release_bounty(env: Env, id: u64) {
        let mut bounty: Bounty = env
            .storage()
            .persistent()
            .get(&DataKey::Bounty(id))
            .expect("bounty not found");

        bounty.creator.require_auth();
        assert!(!bounty.released, "already released");

        let fee_recipient: Address = env
            .storage()
            .instance()
            .get(&DataKey::FeeRecipient)
            .expect("not initialized");

        let client = token::Client::new(&env, &bounty.token);

        // fee = amount * bps / 10_000  (integer division, rounds down)
        let fee: i128 = bounty.amount * (bounty.protocol_fee_bps as i128) / 10_000;
        let payout: i128 = bounty.amount - fee;

        // Load or initialise the release record. Persisted *before* any transfer
        // so a crash after this point is recoverable on retry.
        let mut record: ReleaseRecord = env
            .storage()
            .persistent()
            .get(&DataKey::ReleasePending(id))
            .unwrap_or(ReleaseRecord {
                fee_paid:    false,
                payout_paid: false,
                fee,
                payout,
            });

        // Defensive: the persisted record must match the current bounty terms.
        // If they diverge (e.g. corrupted state), fail loudly rather than pay
        // an inconsistent amount.
        assert!(record.fee == fee && record.payout == payout, "release record mismatch");

        env.storage()
            .persistent()
            .set(&DataKey::ReleasePending(id), &record);

        // Step 1: fee (idempotent — skipped if already paid).
        if !record.fee_paid && fee > 0 {
            client.transfer(&env.current_contract_address(), &fee_recipient, &fee);
            record.fee_paid = true;
            env.storage()
                .persistent()
                .set(&DataKey::ReleasePending(id), &record);
        } else if fee == 0 {
            // Zero-fee bounties are trivially "paid" for the fee leg.
            record.fee_paid = true;
            env.storage()
                .persistent()
                .set(&DataKey::ReleasePending(id), &record);
        }

        // Step 2: payout to hunter (idempotent — skipped if already paid).
        if !record.payout_paid {
            client.transfer(&env.current_contract_address(), &bounty.hunter, &payout);
            record.payout_paid = true;
            env.storage()
                .persistent()
                .set(&DataKey::ReleasePending(id), &record);
        }

        // Both legs confirmed: mark released and clear the pending record so a
        // later call cannot re-enter the release path.
        assert!(record.fee_paid && record.payout_paid, "release incomplete");

        bounty.released = true;
        env.storage().persistent().set(&DataKey::Bounty(id), &bounty);
        env.storage().persistent().remove(&DataKey::ReleasePending(id));

        env.events().publish(
            (Symbol::new(&env, "bounty_released"), id),
            (payout, fee),
        );
    }

    /// Read a bounty (view helper).
    pub fn get_bounty(env: Env, id: u64) -> Bounty {
        env.storage()
            .persistent()
            .get(&DataKey::Bounty(id))
            .expect("bounty not found")
    }

    /// Read the in-flight release record for a bounty, if any.
    ///
    /// Exposed so operators and indexers can observe partial-failure state
    /// without inspecting raw storage. Returns `None` when no release is
    /// pending (either never started or already completed).
    pub fn get_release_record(env: Env, id: u64) -> Option<ReleaseRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::ReleasePending(id))
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::Address as _,
        token::{Client as TokenClient, StellarAssetClient},
        Address, Env,
    };

    // ── helpers ──────────────────────────────────────────────────────────────

    fn setup() -> (Env, Address, Address, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, BountyContract);

        let fee_recipient = Address::generate(&env);
        let creator       = Address::generate(&env);
        let hunter        = Address::generate(&env);

        // Deploy a test token and mint to creator.
        let token_admin = Address::generate(&env);
        let token_id    = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_addr  = token_id.address();
        let sac         = StellarAssetClient::new(&env, &token_addr);
        sac.mint(&creator, &10_000_i128);

        let client = BountyContractClient::new(&env, &contract_id);
        client.initialize(&fee_recipient);

        (env, contract_id, fee_recipient, creator, hunter, token_addr)
    }

    // ── 0 % fee ──────────────────────────────────────────────────────────────

    #[test]
    fn test_zero_fee_full_payout() {
        let (env, contract_id, _fee_recipient, creator, hunter, token) = setup();
        let client = BountyContractClient::new(&env, &contract_id);

        let id = client.create_bounty(&creator, &hunter, &token, &1_000_i128, &0u32);

        let token_client = TokenClient::new(&env, &token);
        let hunter_before = token_client.balance(&hunter);

        client.release_bounty(&id);

        let hunter_after = token_client.balance(&hunter);
        assert_eq!(hunter_after - hunter_before, 1_000_i128, "hunter should receive full amount");
    }

    // ── 1 % fee ──────────────────────────────────────────────────────────────

    #[test]
    fn test_one_percent_fee() {
        let (env, contract_id, fee_recipient, creator, hunter, token) = setup();
        let client = BountyContractClient::new(&env, &contract_id);

        // 1 % = 100 bps
        let id = client.create_bounty(&creator, &hunter, &token, &1_000_i128, &100u32);

        let token_client    = TokenClient::new(&env, &token);
        let hunter_before   = token_client.balance(&hunter);
        let recipient_before = token_client.balance(&fee_recipient);

        client.release_bounty(&id);

        let hunter_after    = token_client.balance(&hunter);
        let recipient_after = token_client.balance(&fee_recipient);

        assert_eq!(hunter_after   - hunter_before,    990_i128, "hunter should receive 990");
        assert_eq!(recipient_after - recipient_before,  10_i128, "fee recipient should receive 10");
    }

    // ── 5 % fee ──────────────────────────────────────────────────────────────

    #[test]
    fn test_five_percent_fee() {
        let (env, contract_id, fee_recipient, creator, hunter, token) = setup();
        let client = BountyContractClient::new(&env, &contract_id);

        // 5 % = 500 bps
        let id = client.create_bounty(&creator, &hunter, &token, &2_000_i128, &500u32);

        let token_client    = TokenClient::new(&env, &token);
        let hunter_before   = token_client.balance(&hunter);
        let recipient_before = token_client.balance(&fee_recipient);

        client.release_bounty(&id);

        let hunter_after    = token_client.balance(&hunter);
        let recipient_after = token_client.balance(&fee_recipient);

        assert_eq!(hunter_after   - hunter_before,   1_900_i128, "hunter should receive 1900");
        assert_eq!(recipient_after - recipient_before,  100_i128, "fee recipient should receive 100");
    }

    // ── sequential IDs ───────────────────────────────────────────────────────

    #[test]
    fn test_sequential_bounty_ids() {
        let (env, contract_id, _fee_recipient, creator, hunter, token) = setup();
        let client = BountyContractClient::new(&env, &contract_id);

        let id1 = client.create_bounty(&creator, &hunter, &token, &500_i128, &0u32);
        let id2 = client.create_bounty(&creator, &hunter, &token, &600_i128, &0u32);
        let id3 = client.create_bounty(&creator, &hunter, &token, &700_i128, &0u32);

        assert_eq!(id1, 0, "first bounty should have id 0");
        assert_eq!(id2, 1, "second bounty should have id 1");
        assert_eq!(id3, 2, "third bounty should have id 2");

        // Also verify that all three are distinct stored bounties.
        let b1 = client.get_bounty(&id1);
        let b2 = client.get_bounty(&id2);
        let b3 = client.get_bounty(&id3);
        assert_eq!(b1.amount, 500_i128);
        assert_eq!(b2.amount, 600_i128);
        assert_eq!(b3.amount, 700_i128);
    }

    // ── double-release guard ─────────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "already released")]
    fn test_cannot_release_twice() {
        let (env, contract_id, _fee_recipient, creator, hunter, token) = setup();
        let client = BountyContractClient::new(&env, &contract_id);
        let id = client.create_bounty(&creator, &hunter, &token, &500_i128, &0u32);
        client.release_bounty(&id);
        client.release_bounty(&id); // should panic
    }

    // ── failure-recovery / determinism ───────────────────────────────────────

    #[test]
    fn test_release_record_cleared_after_success() {
        let (env, contract_id, _fee_recipient, creator, hunter, token) = setup();
        let client = BountyContractClient::new(&env, &contract_id);
        let id = client.create_bounty(&creator, &hunter, &token, &1_000_i128, &100u32);

        assert!(client.get_release_record(&id).is_none());
        client.release_bounty(&id);
        assert!(client.get_release_record(&id).is_none(), "record must be cleared on success");
    }

    #[test]
    fn test_zero_fee_release_is_deterministic() {
        let (env, contract_id, _fee_recipient, creator, hunter, token) = setup();
        let client = BountyContractClient::new(&env, &contract_id);
        let id = client.create_bounty(&creator, &hunter, &token, &1_000_i128, &0u32);

        let token_client = TokenClient::new(&env, &token);
        let before = token_client.balance(&hunter);
        client.release_bounty(&id);
        let after = token_client.balance(&hunter);

        assert_eq!(after - before, 1_000_i128);
        assert!(client.get_release_record(&id).is_none());
    }

    #[test]
    #[should_panic(expected = "creator and hunter must differ")]
    fn test_rejects_self_bounty() {
        let (env, contract_id, _fee_recipient, creator, _hunter, token) = setup();
        let client = BountyContractClient::new(&env, &contract_id);
        client.create_bounty(&creator, &creator, &token, &100_i128, &0u32);
    }

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn test_rejects_zero_amount() {
        let (env, contract_id, _fee_recipient, creator, hunter, token) = setup();
        let client = BountyContractClient::new(&env, &contract_id);
        client.create_bounty(&creator, &hunter, &token, &0_i128, &0u32);
    }

    #[test]
    #[should_panic(expected = "fee_bps must be <= 10000")]
    fn test_rejects_excessive_fee() {
        let (env, contract_id, _fee_recipient, creator, hunter, token) = setup();
        let client = BountyContractClient::new(&env, &contract_id);
        client.create_bounty(&creator, &hunter, &token, &100_i128, &10_001u32);
    }

    #[test]
    #[should_panic(expected = "bounty not found")]
    fn test_release_unknown_bounty_panics() {
        let (env, contract_id, _fee_recipient, _creator, _hunter, _token) = setup();
        let client = BountyContractClient::new(&env, &contract_id);
        client.release_bounty(&999u64);
    }
}
