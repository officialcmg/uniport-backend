/**
 * Calls to the 1Click API.
 *
 * The SDK's own request layer (axios) costs more CPU per call than a Worker on
 * Cloudflare's free plan is allowed for a whole request, so the three
 * endpoints this backend uses are called with fetch directly. The SDK is still
 * the source of the request and response types and of the quote hash.
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
    method: 'GET' | 'POST',
    path: string,
    options: { query?: Record<string, string | undefined>; body?: unknown } = {},
): Promise<T> {
    const base = (process.env.ONECLICK_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const url = new URL(base + path);
    for (const [name, value] of Object.entries(options.query ?? {})) {
        if (value !== undefined) url.searchParams.set(name, value);
    }

    const response = await fetch(url, {
        method,
        headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${process.env.NEAR_API_KEY}`,
            ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
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

    if (!response.ok) throw new OneClickError(response.status, body);
    return body as T;
}

export function getQuote(quoteRequest: QuoteRequest): Promise<QuoteResponse> {
    return request('POST', '/v0/quote', { body: quoteRequest });
}

export function getExecutionStatus(
    depositAddress: string,
    depositMemo?: string,
): Promise<GetExecutionStatusResponse> {
    return request('GET', '/v0/status', { query: { depositAddress, depositMemo } });
}

export function submitDepositTx(deposit: SubmitDepositTxRequest): Promise<unknown> {
    return request('POST', '/v0/deposit/submit', { body: deposit });
}
