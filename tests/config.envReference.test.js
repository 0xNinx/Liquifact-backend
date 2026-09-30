'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function envExampleKeys() {
  const env = read('.env.example');
  const keys = [];
  for (const line of env.split(/\r?\n/)) {
    // Only match active (uncommented) environment variable assignments
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      continue;
    }
    const match = trimmed.match(/^([A-Z][A-Z0-9_]*)=/);
    if (match) {
      keys.push(match[1]);
    }
  }
  return keys;
}

function documentedRows() {
  const docs = read('docs/configuration.md');
  const section = docs.match(/<!-- env-reference:start -->([\s\S]*?)<!-- env-reference:end -->/);
  if (!section) {
    throw new Error('docs/configuration.md is missing env-reference markers');
  }

  const rows = new Map();
  for (const line of section[1].split(/\r?\n/)) {
    const match = line.match(/^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|(.+)\|$/);
    if (match) {
      const columns = match[2].split('|').map((column) => column.trim());
      rows.set(match[1], columns);
    }
  }
  return rows;
}

function scopedCodeKeys() {
  const keys = new Set();
  const files = [
    'src/config/index.js',
    'src/services/escrowSubmit.js',
    'src/middleware/rateLimit.js',
    'src/metrics.js',
  ];

  for (const file of files) {
    const source = read(file);
    for (const match of source.matchAll(/^\s{4}([A-Z][A-Z0-9_]+):/gm)) {
      keys.add(match[1]);
    }
    for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) {
      keys.add(match[1]);
    }
    for (const match of source.matchAll(/process\.env\[['"]([A-Z][A-Z0-9_]+)['"]\]/g)) {
      keys.add(match[1]);
    }
    for (const match of source.matchAll(/parseRateLimitEnv\('([A-Z][A-Z0-9_]+)'/g)) {
      keys.add(match[1]);
    }
  }

  return [...keys].sort();
}

describe('environment variable reference', () => {
  it('documents all active .env.example keys and keeps template keys unique', () => {
    const exampleKeys = envExampleKeys();
    const duplicateKeys = exampleKeys.filter((key, index) => exampleKeys.indexOf(key) !== index);
    const docsKeys = [...documentedRows().keys()];

    expect(duplicateKeys).toEqual([]);
    // Every active key in .env.example must be documented
    for (const key of exampleKeys) {
      expect(docsKeys).toContain(key);
    }
  });

  it('documents every env var read by the scoped configuration consumers', () => {
    const example = new Set(envExampleKeys());
    const docs = documentedRows();
    const codeKeys = scopedCodeKeys();

    const missingFromExample = codeKeys.filter((key) => !example.has(key));
    const missingFromDocs = codeKeys.filter((key) => !docs.has(key));

    expect(missingFromExample).toEqual([]);
    expect(missingFromDocs).toEqual([]);
  });

  it('flags secret variables in the reference table', () => {
    const rows = documentedRows();
    const secretKeys = [
      'API_KEYS',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'DATABASE_URL',
      'ESCROW_CUSTODIAL_KEY_ID',
      'ESCROW_DOCUMENT_CUSTODIAL_KEY_ID',
      'ESCROW_PLATFORM_SECRET',
      'JWT_SECRET',
      'KYC_PROVIDER_API_KEY',
      'KYC_PROVIDER_SECRET',
      'METRICS_BEARER_TOKEN',
      'REDIS_URL',
      'SENTRY_DSN',
    ];

    for (const key of secretKeys) {
      expect(rows.get(key)).toBeDefined();
      expect(rows.get(key)[3]).toContain('Secret');
    }
  });
});
