const { Pool } = require('pg');

// Render Postgres (and most managed Postgres providers) require SSL.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

// Creates the table this backend needs if it doesn't already exist.
// Safe to run every time the server starts.
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS topups (
      id SERIAL PRIMARY KEY,
      external_id TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL,
      amount NUMERIC NOT NULL,
      channel_code TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      xendit_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

module.exports = { pool, ensureSchema };
