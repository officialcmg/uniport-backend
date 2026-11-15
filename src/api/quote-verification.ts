/**
 * 1Click quote verification
 *
 * 1Click signs each quote, covering the request it answered and, for non-dry
 * quotes, the deposit address and memo. A valid signature proves 1Click made
 * the quote; comparing the signed request with ours proves it was made for
 * this payment, not replayed from another one with a different recipient.
 */

import {
    QuoteRequest,
    QuoteResponse,
    quoteHash,
    verifyQuoteSignature,
} from '@defuse-protocol/one-click-sdk-typescript';
import { base58 } from '@scure/base';

// 1Click's signing key. Copied from the SDK, which does not export it; check
// it against the SDK's ONE_CLICK_MANAGER_PUB_KEY whenever the SDK is upgraded.
const ONE_CLICK_PUBLIC_KEY = 'ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc';

function decodeEd25519(value: string): Uint8Array<ArrayBuffer> {
    const decoded = base58.decode(value.replace(/^ed25519:/, ''));
    // Copy into a plain ArrayBuffer-backed array, which is what Web Crypto accepts.
    return new Uint8Array(decoded);
}

/**
 * Checks 1Click's signature on a quote.
 *
 * The SDK's verifyQuoteSignature() does the Ed25519 check in plain JavaScript,
 * which costs tens of milliseconds of CPU: more than a Worker on Cloudflare's
 * free plan is allowed per request. The runtime's native Ed25519 gives the
 * same answer in a fraction of a millisecond, so it is tried first. If it does
 * not confirm the signature for any reason, the SDK's own check decides, so a
 * quote is never rejected only because the two disagree.
 */
async function signatureVerifies(response: QuoteResponse): Promise<boolean> {
    try {
        const key = await crypto.subtle.importKey(
            'raw',
            decodeEd25519(ONE_CLICK_PUBLIC_KEY),
            { name: 'Ed25519' },
            false,
            ['verify']
        );
        const verified = await crypto.subtle.verify(
            'Ed25519',
            key,
            decodeEd25519(response.signature),
            new TextEncoder().encode(quoteHash(response))
        );
        if (verified) return true;
    } catch {
        // Fall through to the SDK's check.
    }
    return verifyQuoteSignature(response);
}

// Fields that decide where funds go and how much moves.
const BOUND_FIELDS = [
    'dry',
    'swapType',
    'originAsset',
    'destinationAsset',
    'amount',
    'recipient',
    'recipientType',
    'refundTo',
    'refundType',
    'depositType',
] as const satisfies readonly (keyof QuoteRequest)[];

// Assets whose quotes 1Click signs in a way its own verifyQuoteSignature()
// rejects (checked against live quotes on SDK 0.1.26). Quotes involving them
// skip the signature check but must still match our request.
const UNVERIFIABLE_SIGNATURE_ASSETS = new Set(['nep141:btc.omft.near']);

/** Set VERIFY_QUOTE_SIGNATURES=false to switch verification off (e.g. if 1Click changes its signing). */
export function isQuoteVerificationEnabled(): boolean {
    return process.env.VERIFY_QUOTE_SIGNATURES?.trim().toLowerCase() !== 'false';
}

/** Returns why the quote can't be trusted, or null if it can. */
export async function findQuoteProblem(
    response: QuoteResponse,
    request: QuoteRequest
): Promise<string | null> {
    const signatureExempt =
        UNVERIFIABLE_SIGNATURE_ASSETS.has(request.originAsset) ||
        UNVERIFIABLE_SIGNATURE_ASSETS.has(request.destinationAsset);
    if (!signatureExempt && !(await signatureVerifies(response))) {
        return 'signature does not verify';
    }
    const signed = response.quoteRequest;
    const mismatched = BOUND_FIELDS.filter(
        (field) => signed?.[field] !== request[field]
    );
    if (mismatched.length > 0) {
        return `signed request differs in ${mismatched.join(', ')}`;
    }
    return null;
}
