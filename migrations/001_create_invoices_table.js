exports.up = function(knex) {
  return knex.schema.createTable('invoices', function(table) {
    table.increments('id').primary();
    table.string('invoice_id').unique().notNullable(); // Unique identifier like inv_123
    table.decimal('amount', 15, 2).notNullable();
    table.string('customer').notNullable();
    table.string('status').notNullable().defaultTo('pending');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.timestamp('deleted_at').nullable();
    table.string('tenant_id').notNullable(); // For multi-tenancy
    table.string('sme_id').nullable(); // SME owner identifier
    table.string('currency', 3).nullable();
    table.date('due_date').nullable();
    table.text('description').nullable();
    table.json('metadata').nullable(); // For additional data
  });
};

exports.down = function(knex) {
  return knex.schema.dropTable('invoices');
};