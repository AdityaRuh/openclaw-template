/**
 * Postgres client — connection pool shared by bot, health, troubleshoot.
 */

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX || '10', 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000
});

pool.on('error', (err) => {
  console.error(JSON.stringify({ level: 'error', source: 'db', message: 'pool error', detail: err.message }));
});

async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    return res;
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', source: 'db', code: 'QUERY_FAILED',
      sql: text.slice(0, 120), message: err.message
    }));
    throw err;
  } finally {
    const ms = Date.now() - start;
    if (ms > 1000) {
      console.warn(JSON.stringify({ level: 'warn', source: 'db', code: 'SLOW_QUERY', ms, sql: text.slice(0, 120) }));
    }
  }
}

async function log(level, source, code, message, context = {}) {
  try {
    await pool.query(
      'INSERT INTO logs (level, source, code, message, context) VALUES ($1,$2,$3,$4,$5)',
      [level, source, code, message, context]
    );
  } catch (err) {
    // Never let logging crash the caller
    console.error('log() failed:', err.message);
  }
}

async function close() {
  await pool.end();
}

module.exports = { pool, query, log, close };
