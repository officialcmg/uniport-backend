/**
 * Creates an app and its App ID directly in the database. For apps Uniport
 * runs itself (the demo, the docs); developers use the dashboard.
 *
 *   APP_ID_HMAC_SECRET=... npx tsx scripts/create-app.ts "<name>" <origin> [<origin> ...]
 *
 * Reads DATABASE_URL_UNPOOLED (or DATABASE_URL) from .env.local, like
 * `npm run migrate`. Prints the new App ID.
 */

import dotenv from 'dotenv';
import pg from 'pg';
import { generateAppId } from '../src/app-id.js';

dotenv.config({ path: ['.env.local', '.env'] });

const [name, ...origins] = process.argv.slice(2);
const secret = process.env.APP_ID_HMAC_SECRET;
const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

if (!name || !secret || !connectionString) {
    console.error(
        'Usage: APP_ID_HMAC_SECRET=... npx tsx scripts/create-app.ts "<name>" <origin> [<origin> ...]',
    );
    process.exit(2);
}
for (const origin of origins) {
    if (!/^https?:\/\/[^/]+$/.test(origin)) {
        console.error(`Not an origin (expected e.g. https://shop.example.com): ${origin}`);
        process.exit(2);
    }
}

const client = new pg.Client({ connectionString });
await client.connect();
try {
    const publicId = await generateAppId(secret);
    await client.query('BEGIN');
    const app = await client.query(
        `INSERT INTO apps (owner_user_id, name, allowed_origins) VALUES ('system', $1, $2) RETURNING id`,
        [name, origins],
    );
    await client.query('INSERT INTO app_ids (id, app_id) VALUES ($1, $2)', [publicId, app.rows[0].id]);
    await client.query('COMMIT');
    console.log(publicId);
} catch (error) {
    await client.query('ROLLBACK');
    throw error;
} finally {
    await client.end();
}
