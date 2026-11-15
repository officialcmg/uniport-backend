/**
 * Postgres (Neon) connection pool.
 *
 * The database is optional: without DATABASE_URL the backend runs exactly as
 * before and nothing is recorded.
 */

import pg from 'pg';

let pool: pg.Pool | null | undefined;

/** Returns the shared pool, or null when DATABASE_URL is not set. */
export function getPool(): pg.Pool | null {
    if (pool !== undefined) return pool;

    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        console.warn('DATABASE_URL is not set — quotes and statuses will not be recorded.');
        pool = null;
        return pool;
    }

    pool = new pg.Pool({
        connectionString,
        max: 5,
        // Fail fast when the database is unreachable instead of queueing work behind it.
        connectionTimeoutMillis: 5_000,
        query_timeout: 10_000,
        // Neon suspends idle computes; don't hold connections open across that.
        idleTimeoutMillis: 30_000,
    });

    // Idle clients emit 'error' when Neon closes them; unhandled, that would crash the process.
    pool.on('error', (err) => {
        console.error('Postgres pool error:', err.message);
    });

    return pool;
}
