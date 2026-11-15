/**
 * Rate limiting. Workers run as many short-lived instances that share no
 * memory, so counters cannot live in the process.
 *
 * - Every request: 100 per minute per IP, through the Workers Rate Limiting
 *   binding. It is approximate and counted separately in each Cloudflare
 *   location.
 * - Live quotes: 150 per 10 minutes per IP. The binding only supports 10 and
 *   60 second windows, so this one is counted exactly in a Durable Object,
 *   one per IP.
 *
 * Both let the request through if the limiter itself fails.
 */

import { DurableObject } from 'cloudflare:workers';
import { json } from './http.js';

const TOO_MANY_REQUESTS = { error: 'Too many requests, please try again later.' };

const LIVE_QUOTE_LIMIT = 150;
const LIVE_QUOTE_WINDOW_MS = 10 * 60 * 1000;

/**
 * The key requests are counted under. Cloudflare sets CF-Connecting-IP itself,
 * so a client cannot forge it. An IPv6 customer is usually given a whole /56
 * and can change address within it at will, so IPv6 is counted per /56.
 */
export function rateLimitKey(request: Request): string {
    const ip = request.headers.get('cf-connecting-ip')?.trim() || 'unknown';
    return ip.includes(':') ? ipv6Prefix56(ip) : ip;
}

/** The /56 an IPv6 address belongs to, e.g. "2001:db8:0:100::/56". */
export function ipv6Prefix56(ip: string): string {
    const parts = ip.toLowerCase().split('::');
    // IPv4-mapped and other dotted forms, or anything malformed, are counted as they are.
    if (parts.length > 2 || ip.includes('.')) return ip;
    const head = parts[0] ? parts[0].split(':') : [];
    const tail = parts[1] ? parts[1].split(':') : [];
    const missing = parts.length === 2 ? 8 - head.length - tail.length : 0;
    if (missing < 0) return ip;
    const groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
    if (groups.length !== 8 || !groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) {
        return ip;
    }
    const [a, b, c, d] = groups.map((group) => parseInt(group, 16));
    // 56 bits: the first three groups and the top half of the fourth.
    return `${[a, b, c, d & 0xff00].map((n) => n.toString(16)).join(':')}::/56`;
}

/** Counts one request for the caller. Returns a 429 response if they are over the limit. */
export async function checkGlobalLimit(request: Request, env: Env): Promise<Response | undefined> {
    try {
        const { success } = await env.GLOBAL_LIMITER.limit({ key: rateLimitKey(request) });
        if (!success) return json(TOO_MANY_REQUESTS, 429, { 'Retry-After': '60' });
    } catch (err) {
        console.error('Rate limiter unavailable:', (err as Error).message);
    }
    return undefined;
}

/**
 * Counts one live quote for the caller. Returns either a 429 response, or the
 * RateLimit headers to put on whatever response follows.
 */
export async function checkLiveQuoteLimit(
    request: Request,
    env: Env,
): Promise<{ limited: Response } | { headers: Record<string, string> }> {
    try {
        const id = env.LIVE_QUOTE_LIMITER.idFromName(rateLimitKey(request));
        const hit = await env.LIVE_QUOTE_LIMITER.get(id).hit(
            LIVE_QUOTE_LIMIT,
            LIVE_QUOTE_WINDOW_MS,
        );
        const resetSeconds = String(Math.ceil(hit.resetMs / 1000));
        const headers = {
            'RateLimit-Policy': `${LIVE_QUOTE_LIMIT};w=${LIVE_QUOTE_WINDOW_MS / 1000}`,
            'RateLimit-Limit': String(LIVE_QUOTE_LIMIT),
            'RateLimit-Remaining': String(hit.remaining),
            'RateLimit-Reset': resetSeconds,
        };
        if (!hit.allowed) {
            return { limited: json(TOO_MANY_REQUESTS, 429, { ...headers, 'Retry-After': resetSeconds }) };
        }
        return { headers };
    } catch (err) {
        console.error('Live quote limiter unavailable:', (err as Error).message);
        return { headers: {} };
    }
}

interface LimitWindow {
    start: number;
    count: number;
}

/**
 * Counts hits for one IP in a fixed window that starts at the first hit.
 * A rejected hit still counts.
 */
export class LiveQuoteLimiter extends DurableObject {
    async hit(
        limit: number,
        windowMs: number,
    ): Promise<{ allowed: boolean; remaining: number; resetMs: number }> {
        const now = Date.now();
        let window = await this.ctx.storage.get<LimitWindow>('window');
        if (!window || now - window.start >= windowMs) {
            window = { start: now, count: 0 };
            // Forget this IP once its window is over.
            await this.ctx.storage.setAlarm(now + windowMs);
        }
        window.count += 1;
        // Once over the limit the answer cannot change until the window ends,
        // so stop writing: a flood must not use up the storage allowance.
        if (window.count <= limit + 1) {
            await this.ctx.storage.put('window', window);
        }
        return {
            allowed: window.count <= limit,
            remaining: Math.max(0, limit - window.count),
            resetMs: window.start + windowMs - now,
        };
    }

    async alarm(): Promise<void> {
        await this.ctx.storage.deleteAll();
    }
}
