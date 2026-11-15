/**
 * Applies the SQL files in migrations/ that have not run yet, in name order.
 * Usage: npm run migrate
 *
 * Uses the direct connection (DATABASE_URL_UNPOOLED) when available, since
 * migrations should not go through Neon's pooler.
 */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: ['.env.local', '.env'] });

const migrationsDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../migrations',
);

async function main(): Promise<void> {
    const connectionString =
        process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
    if (!connectionString) {
        throw new Error('Set DATABASE_URL_UNPOOLED or DATABASE_URL to run migrations.');
    }

    const client = new pg.Client({ connectionString });
    await client.connect();

    try {
        await client.query(
            `CREATE TABLE IF NOT EXISTS schema_migrations (
                name TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )`,
        );
        const applied = new Set(
            (await client.query('SELECT name FROM schema_migrations')).rows.map(
                (row) => row.name as string,
            ),
        );

        const files = (await readdir(migrationsDir))
            .filter((file) => file.endsWith('.sql'))
            .sort();

        for (const file of files) {
            if (applied.has(file)) continue;
            const sql = await readFile(path.join(migrationsDir, file), 'utf8');
            await client.query('BEGIN');
            try {
                await client.query(sql);
                await client.query(
                    'INSERT INTO schema_migrations (name) VALUES ($1)',
                    [file],
                );
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            }
            console.log(`Applied ${file}`);
        }
        console.log('Migrations are up to date.');
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
});
