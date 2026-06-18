import pg from 'pg';
import logger from '../utils/logger.js';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 120000,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

pool.on('error', (err) => {
  logger.error('Unexpected PostgreSQL pool error:', err);
});

export async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  if (duration > 500) {
    logger.warn('Slow query', { text, duration, rows: result.rowCount });
  }
  return result;
}

export async function getClient() {
  return pool.connect();
}

export async function testConnection() {
  try {
    const res = await query('SELECT NOW()');
    logger.info('PostgreSQL connected:', res.rows[0].now);
    return true;
  } catch (error) {
    logger.error('PostgreSQL connection failed:', error.message);
    return false;
  }
}

export default { query, getClient, testConnection };
