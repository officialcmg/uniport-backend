/**
 * The hash 1Click signs for a quote.
 *
 * This reproduces quoteHash() from the 1Click SDK (v0.1.26) so that the SDK,
 * and the libraries it bundles, need not be loaded on every request. The
 * fields and their handling are copied from the SDK's buildSignedQuoteRequest,
 * buildSignedQuote and hashQuote; SHA-256 comes from the runtime.
 *
 * test/quote-verification.test.ts checks this against the SDK's own quoteHash
 * and against 1Click's signatures on real quotes. Run `npm test` after every
 * SDK upgrade: if 1Click changes what it signs, this file has to follow.
 */

import type { QuoteResponse } from '@defuse-protocol/one-click-sdk-typescript';
import { base58 } from '@scure/base';

function signedQuoteRequest(response: QuoteResponse): Record<string, unknown> {
    const { quoteRequest } = response;
    return {
        dry: quoteRequest.dry,
        swapType: quoteRequest.swapType,
        slippageTolerance: quoteRequest.slippageTolerance,
        originAsset: quoteRequest.originAsset,
        depositType: quoteRequest.depositType,
        destinationAsset: quoteRequest.destinationAsset,
        amount: quoteRequest.amount,
        refundTo: quoteRequest.refundTo,
        refundType: quoteRequest.refundType,
        recipient: quoteRequest.recipient,
        recipientType: quoteRequest.recipientType,
        deadline: quoteRequest.deadline,
        quoteWaitingTimeMs: quoteRequest.quoteWaitingTimeMs || undefined,
        referral: quoteRequest.referral || undefined,
        virtualChainRecipient: quoteRequest.virtualChainRecipient || undefined,
        virtualChainRefundRecipient: quoteRequest.virtualChainRefundRecipient || undefined,
        customRecipientMsg: quoteRequest.customRecipientMsg || undefined,
    };
}

function signedQuote(response: QuoteResponse): Record<string, unknown> {
    const { quote } = response;
    const amounts = {
        amountIn: quote.amountIn,
        amountInFormatted: quote.amountInFormatted,
        amountInUsd: quote.amountInUsd,
        minAmountIn: quote.minAmountIn,
        amountOut: quote.amountOut,
        amountOutFormatted: quote.amountOutFormatted,
        amountOutUsd: quote.amountOutUsd,
        minAmountOut: quote.minAmountOut,
    };
    if (response.quoteRequest.dry) return amounts;
    return {
        ...amounts,
        depositAddress: quote.depositAddress || undefined,
        depositMemo: quote.depositMemo || undefined,
        deadline: quote.deadline || undefined,
        timeWhenInactive: quote.timeWhenInactive || undefined,
        timeEstimate: quote.timeEstimate || undefined,
        refundFee: quote.refundFee || undefined,
        withdrawFee: quote.withdrawFee || undefined,
    };
}

/** JSON with object keys in sorted order and undefined properties left out. */
export function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((item) => (item === undefined ? 'null' : stableStringify(item))).join(',')}]`;
    }
    if (typeof value === 'object' && value !== null) {
        const object = value as Record<string, unknown>;
        const parts: string[] = [];
        for (const key of Object.keys(object).sort()) {
            if (object[key] === undefined) continue;
            parts.push(`${JSON.stringify(key)}:${stableStringify(object[key])}`);
        }
        return `{${parts.join(',')}}`;
    }
    return JSON.stringify(value);
}

/** The bytes 1Click signs: the base58 SHA-256 of the quote's signed fields, as text. */
export async function quoteHashBytes(response: QuoteResponse): Promise<Uint8Array<ArrayBuffer>> {
    const data = stableStringify({
        ...signedQuoteRequest(response),
        ...signedQuote(response),
        timestamp: response.timestamp,
    });
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
    return new TextEncoder().encode(base58.encode(new Uint8Array(digest)));
}
