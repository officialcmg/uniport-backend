/**
 * Background database writes: one Postgres connection per request, through
 * Hyperdrive, which keeps the pool to Neon.
 *
 * A Worker may be stopped as soon as its response is sent, so each write is
 * handed to waitUntil to let it finish. The database is optional: without a
 * HYPERDRIVE binding nothing is recorded.
 */

import pg from 'pg';
import { env, waitUntil } from 'cloudflare:workers';

export interface Statement {
    /** What the statement records, for the log line if it fails. */
    label: string;
    text: string;
    values: unknown[];
}

async function write(connectionString: string, statements: Statement[]): Promise<void> {
    try {
        const client = new pg.Client({
            connectionString,
            connectionTimeoutMillis: 5_000,
            query_timeout: 10_000,
        });
        client.on('error', (err) => {
            console.error('Postgres client error:', err.message);
        });
        await client.connect();
        for (const statement of statements) {
            try {
                await client.query(statement.text, statement.values);
            } catch (err) {
                console.error(`Could not record ${statement.label}:`, (err as Error).message);
            }
        }
        // No client.end(): Hyperdrive closes the connection when the request ends.
    } catch (err) {
        console.error('Could not reach Postgres:', (err as Error).message);
    }
}

/**
 * Runs the statements in order on one connection, after the response has been
 * sent. Fire-and-forget: returns immediately and never throws.
 */
export function runInBackground(statements: Statement[]): void {
    try {
        const connectionString = env.HYPERDRIVE?.connectionString;
        if (!connectionString) return;
        waitUntil(write(connectionString, statements));
    } catch (err) {
        console.error('Could not start a database write:', (err as Error).message);
    }
}
