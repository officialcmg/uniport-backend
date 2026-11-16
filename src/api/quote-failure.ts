import type { ApiErrorCode } from './contract.js';

/**
 * Why 1Click refused a quote, as a code the SDK can act on. 1Click only gives
 * a sentence, so this is the one place that reads it; everything downstream
 * uses the code.
 */
export interface QuoteFailure {
    code: Extract<
        ApiErrorCode,
        | 'NO_LIQUIDITY'
        | 'AMOUNT_TOO_LOW'
        | 'INVALID_RECIPIENT'
        | 'INVALID_REFUND_ADDRESS'
        | 'RECIPIENT_NOT_READY'
        | 'QUOTE_FAILED'
    >;
    /** A plain statement of the cause, for the developer. */
    message: string;
    /** For AMOUNT_TOO_LOW, the least 1Click will take, when it says. */
    minimum?: {
        /** In the origin token's smallest units. */
        amount?: string;
        /** In US dollars. */
        usd?: string;
    };
}

/** The sentence in a 1Click error body: `message` is a string or a list of them. */
export function oneClickMessage(body: unknown): string {
    if (typeof body !== 'object' || body === null) return '';
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.filter((part) => typeof part === 'string').join(' ');
    return '';
}

export function classifyQuoteFailure(body: unknown): QuoteFailure {
    const text = oneClickMessage(body);

    if (/no liquidity/i.test(text)) {
        return { code: 'NO_LIQUIDITY', message: 'No route is available for this amount right now.' };
    }
    if (/too low|too small|minimum swap amount|below (the )?minimum/i.test(text)) {
        const amount = text.match(/at least (\d+)/i)?.[1];
        const usd = text.match(/minimum swap amount is \$\s*([\d,.]+)/i)?.[1]?.replace(/,/g, '');
        return {
            code: 'AMOUNT_TOO_LOW',
            message: 'The amount is below the minimum for this route.',
            ...(amount || usd ? { minimum: { ...(amount && { amount }), ...(usd && { usd }) } } : {}),
        };
    }
    if (/recipient is not valid/i.test(text)) {
        return { code: 'INVALID_RECIPIENT', message: 'The recipient address is not valid for the destination chain.' };
    }
    if (/refundto is not valid|refund.{0,20}not valid/i.test(text)) {
        return { code: 'INVALID_REFUND_ADDRESS', message: 'The refund address is not valid for the chain the payer sends from.' };
    }
    if (/trustline/i.test(text)) {
        return { code: 'RECIPIENT_NOT_READY', message: 'The recipient cannot receive this token yet (a Stellar trustline is missing).' };
    }
    return { code: 'QUOTE_FAILED', message: 'Quote failed.' };
}
