// Migration to create invoice_files table for storing invoice file metadata
exports.up = function (knex) {
  return knex.schema.createTable('invoice_files', function (table) {
    table.increments('id').primary();
    table.string('tenant_id').notNullable();
    table.string('invoice_id').notNullable();
    table.string('s3_key').notNullable();
    table.string('sha256').notNullable();
    table.string('mime_type').notNullable();
    table.integer('size').notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.index(['tenant_id', 'invoice_id'], 'idx_invoice_files_tenant_invoice');
  });
};

exports.down = function (knex) {
  return knex.schema.dropTable('invoice_files');
};
