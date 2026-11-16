/**
 * Small HTTP helpers. There is no web framework: the free Workers plan allows
 * 10 ms of CPU per request, and four routes do not need one.
 */

import type { ApiErrorResponse } from './api/contract.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' };

export function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: headers ? { ...JSON_HEADERS, ...headers } : JSON_HEADERS,
    });
}

export function errorResponse(
    status: number,
    error: ApiErrorResponse,
    headers?: Record<string, string>,
): Response {
    return json(error, status, headers);
}

/** Answers a CORS preflight: any origin, the usual methods, whatever headers were asked for. */
export function preflight(request: Request): Response {
    const headers = new Headers({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,HEAD,PUT,PATCH,POST,DELETE',
        // Without this a browser repeats the preflight every five seconds, and
        // each one counts toward the plan's daily request allowance.
        'Access-Control-Max-Age': '7200',
        Vary: 'Access-Control-Request-Headers',
    });
    const requested = request.headers.get('Access-Control-Request-Headers');
    if (requested) headers.set('Access-Control-Allow-Headers', requested);
    return new Response(null, { status: 204, headers });
}

const MAX_BODY_BYTES = 100 * 1024;

/**
 * Reads a JSON request body. Returns the parsed value, or the error response
 * to send. A body that is not sent as JSON is treated as empty, so it fails
 * validation with the list of missing fields.
 */
export async function readJsonBody(
    request: Request,
): Promise<{ body: unknown } | { error: Response }> {
    const tooLarge = () => ({
        error: errorResponse(413, {
            code: 'VALIDATION_ERROR',
            message: 'Request body is too large.',
        }),
    });
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return tooLarge();

    const raw = await request.arrayBuffer();
    if (raw.byteLength > MAX_BODY_BYTES) return tooLarge();

    if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) {
        return { body: {} };
    }
    if (raw.byteLength === 0) return { body: {} };

    try {
        const body: unknown = JSON.parse(new TextDecoder().decode(raw));
        if (typeof body === 'object' && body !== null) return { body };
    } catch {
        // Falls through to the error below.
    }
    return {
        error: errorResponse(400, {
            code: 'VALIDATION_ERROR',
            message: 'Request body must be valid JSON.',
        }),
    };
}
