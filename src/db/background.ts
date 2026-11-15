/**
 * Background database writes to Neon Postgres.
 *
 * Writes go over HTTPS with Neon's serverless driver: one request, no
 * connection to set up. A Postgres connection (even through Hyperdrive) costs
 * more CPU for its handshake than a Worker on Cloudflare's free plan is
 * allowed for a whole request.
 *
 * A Worker may be stopped as soon as its response is sent, so each write is
 * handed to waitUntil to let it finish. The database is optional: without
 * DATABASE_URL nothing is recorded.
 */

import { neon } from '@neondatabase/serverless';
import { waitUntil } from 'cloudflare:workers';

export interface Statement {
    /** What the statement records, for the log line if it fails. */
    label: string;
    text: string;
    values: unknown[];
}

const TIMEOUT_MS = 10_000;

/** Applies the statements in order, as one transaction. Returns whether it went through. */
async function write(connectionString: string, statements: Statement[]): Promise<boolean> {
    try {
        const sql = neon(connectionString, {
            fetchOptions: { signal: AbortSignal.timeout(TIMEOUT_MS) },
        });
        await sql.transaction(
            statements.map((statement) => sql.query(statement.text, statement.values)),
        );
        return true;
    } catch (err) {
        const what = statements.map((statement) => statement.label).join(' and ');
        console.error(`Could not record ${what}:`, (err as Error).message);
        return false;
    }
}

/**
 * Runs the statements after the response has been sent. Fire-and-forget:
 * returns immediately and never throws. `onDone` is told whether they went
 * through.
 */
export function runInBackground(
    statements: Statement[],
    onDone?: (applied: boolean) => void,
): void {
    try {
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) {
            onDone?.(false);
            return;
        }
        waitUntil(write(connectionString, statements).then((applied) => onDone?.(applied)));
    } catch (err) {
        console.error('Could not start a database write:', (err as Error).message);
        onDone?.(false);
    }
}
