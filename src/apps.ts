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
const LOOKUP_TIMEOUT_MS = 1_500;

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
        // Better an answer that is a little old than none.
        if (known) return known.app ? { state: 'found', app: known.app } : { state: 'missing' };
        return { state: 'unavailable' };
    }
}

/** Is this a page served from the developer's own machine? */
export function isLocalOrigin(origin: string): boolean {
    try {
        const { hostname } = new URL(origin);
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
    /** A registered app, on an origin it allows. */
    | { kind: 'app'; app: App; publicId: string }
    /**
     * No app. `local` is a developer's machine or a script, which gets a small
     * allowance; `unidentified` is a website without an ID (allowed only until
     * App IDs are enforced) or an ID that could not be checked.
     */
    | { kind: 'anonymous'; tier: 'local' | 'unidentified'; claimedId?: string }
    | { kind: 'refused'; code: ApiErrorCode; message: string };

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
            code: 'APP_ID_REQUIRED',
            message: `This site needs a Uniport App ID. Create one at ${DASHBOARD} and pass it as appId.`,
        };
    }

    const notFound: Access = {
        kind: 'refused',
        code: 'APP_NOT_FOUND',
        message: `Unknown or disabled App ID. Check it at ${DASHBOARD}.`,
    };
    if (!looksLikeAppId(appId) || tagValid === false) return notFound;
    // The ID could not be checked (no secret configured, or the database is
    // down): let the payment through as an unidentified caller rather than fail it.
    if (tagValid === undefined || !lookup || lookup.state === 'unavailable') {
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
                code: 'ORIGIN_NOT_ALLOWED',
                message: `This App ID is not allowed on ${origin}. Add the site to the app's allowed origins at ${DASHBOARD}.`,
            };
        }
    }
    return { kind: 'app', app, publicId: appId };
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
