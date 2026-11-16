/**
 * Reads from Neon Postgres over its SQL-over-HTTP endpoint, with fetch (see
 * background.ts for why there is no driver).
 */

/**
 * Runs one statement and returns its rows as objects. Throws if the database
 * is not configured, does not answer in time, or rejects the statement.
 */
export async function queryRows<Row>(
    env: Env,
    text: string,
    values: (string | null)[],
    timeoutMs: number,
): Promise<Row[]> {
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
    const host = new URL(env.DATABASE_URL).hostname;
    const response = await fetch(`https://${host}/sql`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Neon-Connection-String': env.DATABASE_URL,
        },
        body: JSON.stringify({ query: text, params: values }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
        const detail = (await response.text()).slice(0, 200);
        throw new Error(`Neon answered ${response.status}: ${detail}`);
    }
    const body = (await response.json()) as { rows?: Row[] };
    return body.rows ?? [];
}
