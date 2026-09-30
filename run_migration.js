const knexConfig = require('./knexfile');
const knex = require('knex')(knexConfig);
knex.migrate.latest()
  .then(() => {
    console.log('Migration completed');
    process.exit(0);
  })
  .catch(err => {
    console.error('Migration failed', err);
    process.exit(1);
  });
