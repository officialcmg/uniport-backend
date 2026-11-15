/**
 * Background database writes to Neon Postgres.
 *
 * Writes are one HTTPS request to Neon's SQL-over-HTTP endpoint (the same one
 * Neon's serverless driver uses), sent with fetch. A Postgres connection, even
 * through Hyperdrive, costs more CPU for its handshake than a Worker on
 * Cloudflare's free plan is allowed for a whole request, and the driver
 * package is more code than this needs.
 *
 * A Worker may be stopped as soon as its response is sent, so each write is
 * handed to waitUntil to let it finish. The database is optional: without
 * DATABASE_URL nothing is recorded.
 */

export interface Statement {
    text: string;
    values: (string | null)[];
}

const TIMEOUT_MS = 10_000;

/** Applies the statements in order, as one transaction. Returns whether it went through. */
async function write(connectionString: string, what: string, statements: Statement[]): Promise<boolean> {
    try {
        const host = new URL(connectionString).hostname;
        const response = await fetch(`https://${host}/sql`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Neon-Connection-String': connectionString,
            },
            body: JSON.stringify({
                queries: statements.map(({ text, values }) => ({ query: text, params: values })),
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (response.ok) {
            // The rows are not needed; release the body without parsing it.
            await response.body?.cancel();
            return true;
        }
        const detail = (await response.text()).slice(0, 300);
        console.error(`Could not record ${what}: HTTP ${response.status} ${detail}`);
    } catch (err) {
        console.error(`Could not record ${what}:`, (err as Error).message);
    }
    return false;
}

/**
 * Runs the statements after the response has been sent. Fire-and-forget:
 * returns immediately and never throws. `onDone` is told whether they went
 * through.
 */
export function runInBackground(
    env: Env,
    ctx: ExecutionContext,
    what: string,
    statements: Statement[],
    onDone?: (applied: boolean) => void,
): void {
    try {
        if (!env.DATABASE_URL) {
            onDone?.(false);
            return;
        }
        ctx.waitUntil(
            write(env.DATABASE_URL, what, statements).then((applied) => onDone?.(applied)),
        );
    } catch (err) {
        console.error(`Could not start recording ${what}:`, (err as Error).message);
        onDone?.(false);
    }
}
