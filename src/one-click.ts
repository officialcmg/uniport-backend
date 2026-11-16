/**
 * Calls to the 1Click API, with fetch.
 *
 * The 1Click SDK is not used at runtime: its request layer (axios) alone costs
 * more CPU per call than a Worker on Cloudflare's free plan is allowed for a
 * whole request. It is a dev dependency, for the request and response types.
 */

import type {
    GetExecutionStatusResponse,
    QuoteRequest,
    QuoteResponse,
    SubmitDepositTxRequest,
} from '@defuse-protocol/one-click-sdk-typescript';

const DEFAULT_BASE_URL = 'https://1click.chaindefuser.com';
const TIMEOUT_MS = 30_000;

/** 1Click answered with an error status. `body` is its parsed response. */
export class OneClickError extends Error {
    constructor(
        readonly status: number,
        readonly body: unknown,
    ) {
        super(`1Click responded with ${status}`);
    }
}

async function request<T>(
    env: Env,
    method: 'GET' | 'POST',
    path: string,
    options: { query?: Record<string, string | undefined>; body?: unknown } = {},
): Promise<T> {
    let url = (env.ONECLICK_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '') + path;
    const query = Object.entries(options.query ?? {})
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
    if (query.length > 0) url += `?${query.join('&')}`;

    const headers: Record<string, string> = {
        Accept: 'application/json',
        'X-API-Key': env.NEAR_API_KEY ?? '',
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(url, {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const text = await response.text();
    let body: unknown = text;
    try {
        body = JSON.parse(text);
    } catch {
        // Not JSON; keep the raw text.
    }

    // Anything but a 2xx is a failure, including a redirect or an empty 3xx.
    if (!response.ok) throw new OneClickError(response.status, body);
    return body as T;
}

export function getQuote(env: Env, quoteRequest: QuoteRequest): Promise<QuoteResponse> {
    return request(env, 'POST', '/v0/quote', { body: quoteRequest });
}

export function getExecutionStatus(
    env: Env,
    depositAddress: string,
    depositMemo?: string,
): Promise<GetExecutionStatusResponse> {
    return request(env, 'GET', '/v0/status', { query: { depositAddress, depositMemo } });
}

export function submitDepositTx(env: Env, deposit: SubmitDepositTxRequest): Promise<unknown> {
    return request(env, 'POST', '/v0/deposit/submit', { body: deposit });
}
