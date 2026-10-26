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
    verifyQuoteSignature,
} from '@defuse-protocol/one-click-sdk-typescript';

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
export function findQuoteProblem(
    response: QuoteResponse,
    request: QuoteRequest
): string | null {
    const signatureExempt =
        UNVERIFIABLE_SIGNATURE_ASSETS.has(request.originAsset) ||
        UNVERIFIABLE_SIGNATURE_ASSETS.has(request.destinationAsset);
    if (!signatureExempt && !verifyQuoteSignature(response)) {
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
