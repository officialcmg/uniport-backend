/**
 * Developer apps: looking one up from its App ID, and deciding whether a quote
 * request may go ahead.
 */

import { looksLikeAppId, verifyAppId } from './app-id.js';
import type { ApiErrorCode } from './api/contract.js';
import { queryRows } from './db/query.js';

export interface App {
    /** Internal id (apps.id), stable across App ID rotation. */
    id: string;
    status: string;
    allowedOrigins: string[];
    allowLocalhost: boolean;
    /** When set and not empty, the only recipients the app may be paid to. */
    recipientAllowlist: string[] | null;
}

/** `unavailable` means the database could not be asked and nothing was remembered. */
export type AppLookup =
    | { state: 'found'; app: App }
    | { state: 'missing' }
    | { state: 'unavailable' };

const REMEMBER_MS = 60_000;
const MAX_REMEMBERED = 500;
// Long enough for Neon to wake from idle, which the first lookup after a quiet
// spell has to wait for.
const LOOKUP_TIMEOUT_MS = 4_000;
const RETRY_AFTER_FAILURE_MS = 10_000;
let lastLookupFailure = 0;

/**
 * What this Worker instance learned about each App ID in the last minute, so
 * most quotes need no database round trip. IDs that do not exist are
 * remembered too. A change made in the dashboard therefore takes up to a
 * minute to reach every instance.
 */
const remembered = new Map<string, { app: App | null; at: number }>();

interface AppRow {
    id: string;
    status: string;
    allowed_origins: string[] | null;
    allow_localhost: boolean;
    recipient_allowlist: string[] | null;
}

/** Finds the app an App ID belongs to. The ID must already have passed verifyAppId. */
export async function lookupApp(env: Env, publicId: string): Promise<AppLookup> {
    const known = remembered.get(publicId);
    const now = Date.now();
    if (known && now - known.at < REMEMBER_MS) {
        return known.app ? { state: 'found', app: known.app } : { state: 'missing' };
    }
    const fromMemory = (): AppLookup =>
        known
            ? known.app
                ? { state: 'found', app: known.app }
                : { state: 'missing' }
            : { state: 'unavailable' };
    // The database just failed to answer: do not make every request wait for it again.
    if (now - lastLookupFailure < RETRY_AFTER_FAILURE_MS) return fromMemory();

    try {
        const rows = await queryRows<AppRow>(
            env,
            // Arrays are returned as JSON so they arrive as arrays, not Postgres text.
            `SELECT a.id, a.status, a.allow_localhost,
                    to_jsonb(a.allowed_origins) AS allowed_origins,
                    to_jsonb(a.recipient_allowlist) AS recipient_allowlist
             FROM app_ids i JOIN apps a ON a.id = i.app_id
             WHERE i.id = $1 AND i.disabled_at IS NULL`,
            [publicId],
            LOOKUP_TIMEOUT_MS,
        );
        const row = rows[0];
        const app: App | null = row
            ? {
                  id: row.id,
                  status: row.status,
                  allowedOrigins: row.allowed_origins ?? [],
                  allowLocalhost: row.allow_localhost,
                  recipientAllowlist: row.recipient_allowlist,
              }
            : null;
        remembered.delete(publicId);
        remembered.set(publicId, { app, at: now });
        for (const oldest of remembered.keys()) {
            if (remembered.size <= MAX_REMEMBERED) break;
            remembered.delete(oldest);
        }
        return app ? { state: 'found', app } : { state: 'missing' };
    } catch (err) {
        console.error('App lookup failed:', (err as Error).message);
        lastLookupFailure = Date.now();
        // Better an answer that is a little old than none.
        return fromMemory();
    }
}

/** Is this a page served from the developer's own machine? */
export function isLocalOrigin(origin: string): boolean {
    try {
        const { hostname, protocol } = new URL(origin);
        if (protocol !== 'http:' && protocol !== 'https:') return false;
        return (
            hostname === 'localhost' ||
            hostname === '127.0.0.1' ||
            hostname === '[::1]' ||
            hostname.endsWith('.localhost')
        );
    } catch {
        return false;
    }
}

// Domains under which anyone can register a site. A wildcard over one of these
// would allow other people's websites.
const SHARED_DOMAINS = new Set([
    'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'github.io', 'gitlab.io',
    'web.app', 'firebaseapp.com', 'herokuapp.com', 'onrender.com', 'railway.app', 'fly.dev',
    'azurewebsites.net', 'cloudfront.net', 'amazonaws.com', 'appspot.com', 'surge.sh',
    'glitch.me', 'replit.app', 'ngrok.io', 'ngrok-free.app', 'co.uk', 'com.au', 'co.jp',
    'com.br', 'co.in', 'co.nz', 'co.za', 'com.mx', 'com.sg', 'com.tr', 'com.cn',
]);

/**
 * Checks an allowed-origin entry before it is saved, and returns it in the
 * one form the Worker compares against: an exact origin such as
 * https://shop.example.com, or a subdomain wildcard such as
 * https://*.example.com. Throws with a message for the developer otherwise.
 *
 * The dashboard (uniport-landing, lib/dashboard/origins.ts) applies the same rules.
 */
export function normaliseAllowedOrigin(entry: string): string {
    const value = entry.trim();
    const wildcard = value.match(/^(https?):\/\/\*\.([^/*:]+)\/?$/i);
    if (wildcard) {
        const domain = wildcard[2].toLowerCase().replace(/\.$/, '');
        const labels = domain.split('.');
        if (labels.length < 2 || labels.some((label) => !/^[a-z0-9-]+$/.test(label))) {
            throw new Error(`"${value}" is too broad: a wildcard needs a domain you own, such as https://*.example.com.`);
        }
        if (SHARED_DOMAINS.has(domain)) {
            throw new Error(`"${value}" would allow other people's sites on ${domain}. List your own sites one by one.`);
        }
        return `${wildcard[1].toLowerCase()}://*.${domain}`;
    }
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`"${value}" is not a website address. Use one like https://shop.example.com.`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`"${value}" must start with https:// or http://.`);
    }
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
        throw new Error(`"${value}" should be just the site, with no path: ${url.origin}.`);
    }
    if (value.includes('*')) {
        throw new Error(`"${value}" is not a supported wildcard. Use the form https://*.example.com.`);
    }
    return url.origin;
}

/**
 * Does an origin match one of the app's allowed origins? An entry is an exact
 * origin (https://shop.example.com) or a subdomain wildcard
 * (https://*.example.com), which matches any depth of subdomain but not
 * example.com itself.
 */
export function originAllowed(origin: string, allowedOrigins: string[]): boolean {
    let url: URL;
    try {
        url = new URL(origin);
    } catch {
        return false;
    }
    // Only real websites: not "null", extensions, or other schemes.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const normalised = url.origin.toLowerCase();
    return allowedOrigins.some((entry) => {
        const allowed = entry.trim().toLowerCase().replace(/\/+$/, '');
        const wildcard = allowed.match(/^(https?:\/\/)\*\.(.+)$/);
        if (!wildcard) return allowed === normalised;
        const [, scheme, rest] = wildcard;
        return normalised.startsWith(scheme) && normalised.slice(scheme.length).endsWith(`.${rest}`);
    });
}

/** Is a recipient on the app's list? EVM addresses are compared without regard to case. */
export function recipientAllowed(recipient: string, allowlist: string[] | null): boolean {
    if (!allowlist || allowlist.length === 0) return true;
    const normalise = (address: string) =>
        /^0x[0-9a-fA-F]{40}$/.test(address.trim()) ? address.trim().toLowerCase() : address.trim();
    const wanted = normalise(recipient);
    return allowlist.some((entry) => normalise(entry) === wanted);
}

export type Access =
    /**
     * A registered app. `fromBrowser` is true when the request came from a
     * website the app allows; false when it had no Origin, so it came from a
     * server or script and anyone who knows the public ID could have sent it.
     */
    | { kind: 'app'; app: App; publicId: string; fromBrowser: boolean }
    /**
     * No app. `local` is a developer's machine or a script, which gets a small
     * allowance; `unidentified` is a website without an ID (allowed only until
     * App IDs are enforced) or an ID that could not be checked.
     */
    | { kind: 'anonymous'; tier: 'local' | 'unidentified'; claimedId?: string }
    | { kind: 'refused'; status: 403 | 503; code: ApiErrorCode; message: string };

const DASHBOARD = 'https://uniport.dev/dashboard';

/**
 * The rules for who may ask for a quote. Pure: everything it needs is passed
 * in, so every case can be tested without a Worker or a database.
 */
export function decideAccess(input: {
    /** The X-Uniport-App-Id header, if sent. */
    appId: string | undefined;
    /** Whether that ID has a valid tag; `undefined` if it could not be checked. */
    tagValid: boolean | undefined;
    /** The lookup result, when the tag was valid. */
    lookup: AppLookup | undefined;
    /** The Origin header: set by browsers, absent from servers and scripts. */
    origin: string | null;
    /** Whether websites must send an App ID. */
    enforced: boolean;
}): Access {
    const { appId, tagValid, lookup, origin, enforced } = input;

    if (!appId) {
        if (!origin || isLocalOrigin(origin)) return { kind: 'anonymous', tier: 'local' };
        if (!enforced) return { kind: 'anonymous', tier: 'unidentified' };
        return {
            kind: 'refused',
            status: 403,
            code: 'APP_ID_REQUIRED',
            message: `This site needs a Uniport App ID. Create one at ${DASHBOARD} and pass it as appId.`,
        };
    }

    const notFound: Access = {
        kind: 'refused',
        status: 403,
        code: 'APP_NOT_FOUND',
        message: `Unknown or disabled App ID. Check it at ${DASHBOARD}.`,
    };
    if (!looksLikeAppId(appId) || tagValid === false) return notFound;
    // The ID could not be checked: no secret is configured, or the database
    // did not answer. Before App IDs are enforced, let the payment through as
    // an unidentified caller rather than fail it. Once they are, a website must
    // not get a quote on an ID nobody checked, so it is asked to try again.
    if (tagValid === undefined || !lookup || lookup.state === 'unavailable') {
        if (enforced && origin && !isLocalOrigin(origin)) {
            return {
                kind: 'refused',
                status: 503,
                code: 'INTERNAL_ERROR',
                message: 'Could not check the App ID just now. Please try again.',
            };
        }
        return { kind: 'anonymous', tier: 'unidentified', claimedId: appId };
    }
    if (lookup.state === 'missing' || lookup.app.status !== 'active') return notFound;

    const { app } = lookup;
    // A request with no Origin comes from a server or a script, which could
    // send any Origin it liked, so there is nothing to check.
    if (origin) {
        const allowed = isLocalOrigin(origin)
            ? app.allowLocalhost
            : originAllowed(origin, app.allowedOrigins);
        if (!allowed) {
            return {
                kind: 'refused',
                status: 403,
                code: 'ORIGIN_NOT_ALLOWED',
                message: `This App ID is not allowed on ${origin}. Add the site to the app's allowed origins at ${DASHBOARD}.`,
            };
        }
    }
    return { kind: 'app', app, publicId: appId, fromBrowser: origin !== null };
}

/** Works out who is asking for a quote: checks the App ID's tag, then looks the app up. */
export async function resolveAccess(request: Request, env: Env): Promise<Access> {
    const appId = request.headers.get('x-uniport-app-id')?.trim() || undefined;
    const origin = request.headers.get('origin');
    const enforced = env.APP_ID_ENFORCEMENT?.trim().toLowerCase() === 'on';

    let tagValid: boolean | undefined;
    let lookup: AppLookup | undefined;
    if (appId && looksLikeAppId(appId) && env.APP_ID_HMAC_SECRET) {
        try {
            tagValid = await verifyAppId(appId, env.APP_ID_HMAC_SECRET);
            if (tagValid) lookup = await lookupApp(env, appId);
        } catch (err) {
            console.error('App ID check failed:', (err as Error).message);
            tagValid = undefined;
        }
    }
    return decideAccess({ appId, tagValid, lookup, origin, enforced });
}
