const { Pool } = require('pg');

// Only DATABASE_URL supplies connection details. Never log the URL or raw errors.
async function connectPostgres({ env = process.env, PoolClass = Pool, logger = console } = {}) {
    if (!env.DATABASE_URL) {
        logger.info('[PostgreSQL] Connection check skipped: DATABASE_URL is not configured.');
        return null;
    }

    let pool;
    try {
        pool = new PoolClass({
            connectionString: env.DATABASE_URL,
            max: 3,
            connectionTimeoutMillis: 10000,
            statement_timeout: 5000,
            query_timeout: 6000
        });
        pool.on('error', () => {
            logger.error('[PostgreSQL] Connection lost. Check database availability and connection settings.');
        });
        await pool.query('SELECT 1');
        logger.info('[PostgreSQL] Connection successful.');
        return pool;
    } catch {
        logger.error('[PostgreSQL] Connection failed. Check DATABASE_URL, network access and SSL settings.');
        if (pool) await pool.end().catch(() => {});
        return null;
    }
}

module.exports = { connectPostgres };
