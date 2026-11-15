/**
 * Cloudflare Workers entry: CORS, rate limiting and routing.
 */

import { handleDeposit, handleQuote, handleStatus } from './api/routes.js';
import { errorResponse, json, preflight } from './http.js';
import { checkGlobalLimit } from './rate-limit.js';

export { LiveQuoteLimiter } from './rate-limit.js';

const STATUS_PREFIX = '/api/status/';

// Lets browser code read the rate-limit headers.
const EXPOSED_HEADERS =
    'RateLimit-Policy, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After';

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const limited = await checkGlobalLimit(request, env);
    if (limited) return limited;

    const { pathname, searchParams } = new URL(request.url);
    const method = request.method;

    if (pathname === '/health' && (method === 'GET' || method === 'HEAD')) {
        return json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            service: 'Uniport Backend',
        });
    }

    if (pathname.startsWith('/api/')) {
        if (!env.NEAR_API_KEY) {
            console.error('NEAR_API_KEY is not set');
            return errorResponse(503, {
                code: 'INTERNAL_ERROR',
                message: 'The service is not configured.',
            });
        }
        if (method === 'POST' && pathname === '/api/quote') {
            return handleQuote(request, env, ctx);
        }
        if (method === 'POST' && pathname === '/api/deposit') {
            return handleDeposit(request, env);
        }
        if (method === 'GET' && pathname.startsWith(STATUS_PREFIX)) {
            const encoded = pathname.slice(STATUS_PREFIX.length);
            if (encoded && !encoded.includes('/')) {
                let depositAddress: string;
                try {
                    depositAddress = decodeURIComponent(encoded);
                } catch {
                    return errorResponse(400, {
                        code: 'VALIDATION_ERROR',
                        message: 'Invalid depositAddress parameter.',
                    });
                }
                return handleStatus(depositAddress, searchParams.get('memo') ?? undefined, env, ctx);
            }
        }
    }

    return new Response('404 Not Found', { status: 404 });
}

export default {
    async fetch(request, env, ctx): Promise<Response> {
        if (request.method === 'OPTIONS') return preflight(request);

        let response: Response;
        try {
            response = await route(request, env, ctx);
        } catch (err) {
            console.error('Unhandled error:', err);
            response = json({ error: 'Internal server error' }, 500);
        }
        // CORS — open to all origins (SDK can be used from any domain), on every
        // response so a browser can read errors and rate-limit replies too.
        response.headers.set('Access-Control-Allow-Origin', '*');
        response.headers.set('Access-Control-Expose-Headers', EXPOSED_HEADERS);
        return request.method === 'HEAD' ? new Response(null, response) : response;
    },
} satisfies ExportedHandler<Env>;
