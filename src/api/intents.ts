/**
 * Uniport Intents API routes
 *
 * Proxies cross-chain swap requests to the 1Click API.
 * The API key is stored server-side — frontend SDK never touches it.
 */

import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { QuoteRequest } from '@defuse-protocol/one-click-sdk-typescript';
import {
    parseDepositRequestBody,
    parseQuoteRequestBody,
    type ApiErrorResponse,
} from './contract.js';
import {
    findQuoteProblem,
    isQuoteVerificationEnabled,
} from './quote-verification.js';
import { recordQuote, recordStatus } from '../db/records.js';
import {
    OneClickError,
    getExecutionStatus,
    getQuote,
    submitDepositTx,
} from '../one-click.js';
import { limitLiveQuote } from '../rate-limit.js';

export const intentsRoutes = new Hono();

const SWAP_TYPE_MAP = {
    EXACT_INPUT: QuoteRequest.swapType.EXACT_INPUT,
    EXACT_OUTPUT: QuoteRequest.swapType.EXACT_OUTPUT,
    FLEX_INPUT: QuoteRequest.swapType.FLEX_INPUT,
    ANY_INPUT: QuoteRequest.swapType.ANY_INPUT,
} as const;

const DEPOSIT_MODE_MAP = {
    SIMPLE: QuoteRequest.depositMode.SIMPLE,
    MEMO: QuoteRequest.depositMode.MEMO,
} as const;

const MAX_BODY_BYTES = 100 * 1024;

function sendError(c: Context, status: number, error: ApiErrorResponse): Response {
    return c.json(error, status as ContentfulStatusCode);
}

/**
 * Reads a JSON request body. Returns the parsed value, or the error response
 * to send. A body that is not sent as JSON is treated as empty, so it fails
 * validation with the list of missing fields.
 */
async function readJsonBody(c: Context): Promise<{ body: unknown } | { error: Response }> {
    const tooLarge = () => ({
        error: sendError(c, 413, {
            code: 'VALIDATION_ERROR',
            message: 'Request body is too large.',
        }),
    });
    if (Number(c.req.header('content-length') ?? 0) > MAX_BODY_BYTES) return tooLarge();

    const raw = await c.req.arrayBuffer();
    if (raw.byteLength > MAX_BODY_BYTES) return tooLarge();

    if (!/^application\/json\b/i.test(c.req.header('content-type') ?? '')) return { body: {} };
    if (raw.byteLength === 0) return { body: {} };

    try {
        const body: unknown = JSON.parse(new TextDecoder().decode(raw));
        if (typeof body === 'object' && body !== null) return { body };
    } catch {
        // Falls through to the error below.
    }
    return {
        error: sendError(c, 400, {
            code: 'VALIDATION_ERROR',
            message: 'Request body must be valid JSON.',
        }),
    };
}

// ============================================================================
// POST /api/quote
// ============================================================================

intentsRoutes.post('/quote', async (c) => {
    const read = await readJsonBody(c);
    if ('error' in read) return read.error;

    // Live quotes create a deposit address at 1Click and a database row, so they
    // get a tighter limit than the global one. Dry quotes are only price checks
    // and are not counted.
    if ((read.body as { dry?: unknown }).dry !== true) {
        const limited = await limitLiveQuote(c);
        if (limited) return limited;
    }

    try {
        const parsed = parseQuoteRequestBody(read.body);

        if (!parsed.value) {
            return sendError(c, 400, {
                code: 'VALIDATION_ERROR',
                message: 'Invalid quote request.',
                details: parsed.errors,
            });
        }

        const {
            dry,
            swapType,
            slippageTolerance,
            depositMode,
            originAsset,
            destinationAsset,
            amount,
            refundTo,
            recipient,
            deadline,
            referral,
        } = parsed.value;

        const isExactOutput = swapType === 'EXACT_OUTPUT';
        const intentsRefundAccount =
            process.env.UNIPORT_INTENTS_REFUND_ACCOUNT?.trim().toLowerCase();

        if (isExactOutput && !intentsRefundAccount) {
            return sendError(c, 503, {
                code: 'INTERNAL_ERROR',
                message: 'Exact-output payments are not configured.',
            });
        }

        const quoteRequest: QuoteRequest = {
            dry: dry ?? false,
            swapType: swapType
                ? SWAP_TYPE_MAP[swapType]
                : QuoteRequest.swapType.EXACT_INPUT,
            slippageTolerance: slippageTolerance ?? 100,
            depositMode: depositMode ? DEPOSIT_MODE_MAP[depositMode] : undefined,
            originAsset,
            depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
            destinationAsset,
            amount,
            refundTo: isExactOutput ? intentsRefundAccount! : refundTo!,
            refundType: isExactOutput
                ? QuoteRequest.refundType.INTENTS
                : QuoteRequest.refundType.ORIGIN_CHAIN,
            recipient,
            recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
            deadline: deadline ?? new Date(Date.now() + 3600000).toISOString(),
            referral: referral ?? 'uniport',
        };

        const response = await getQuote(quoteRequest);

        // Never hand a payer a deposit address that 1Click didn't sign for this request.
        if (isQuoteVerificationEnabled()) {
            const problem = await findQuoteProblem(response, quoteRequest);
            if (problem) {
                console.error(
                    `Rejected unverified quote (${problem}); correlationId=${response.correlationId}`
                );
                return sendError(c, 502, {
                    code: 'QUOTE_UNVERIFIED',
                    message: 'Could not verify the quote. Please try again.',
                });
            }
        }

        // Dry quotes have no deposit address and are never paid, so only live ones are kept.
        if (!quoteRequest.dry && response.quote.depositAddress) {
            recordQuote({
                correlationId: response.correlationId,
                depositAddress: response.quote.depositAddress,
                depositMemo: response.quote.depositMemo,
                swapType: quoteRequest.swapType,
                originAsset,
                destinationAsset,
                amount,
                amountIn: response.quote.amountIn,
                amountOut: response.quote.amountOut,
                minAmountOut: response.quote.minAmountOut,
                amountOutUsd: response.quote.amountOutUsd,
                recipient,
                refundTo: quoteRequest.refundTo,
                referral: quoteRequest.referral,
                deadline: response.quote.deadline,
            });
        }

        return c.json({
            quote: {
                depositAddress: response.quote.depositAddress ?? '',
                depositMemo: response.quote.depositMemo,
                amountIn: response.quote.amountIn,
                amountInFormatted: response.quote.amountInFormatted,
                minAmountIn: response.quote.minAmountIn,
                amountOut: response.quote.amountOut,
                amountOutFormatted: response.quote.amountOutFormatted,
                amountOutUsd: response.quote.amountOutUsd,
                minAmountOut: response.quote.minAmountOut,
                deadline: response.quote.deadline,
                timeWhenInactive: response.quote.timeWhenInactive,
            },
            correlationId: response.correlationId,
        });
    } catch (error) {
        if (error instanceof OneClickError) {
            return sendError(c, error.status, {
                code: 'QUOTE_FAILED',
                message: 'Quote failed.',
                details: error.body,
            });
        }
        console.error('Quote error:', error);
        return sendError(c, 500, {
            code: 'INTERNAL_ERROR',
            message: 'Internal server error.',
        });
    }
});

// ============================================================================
// POST /api/deposit
// ============================================================================

intentsRoutes.post('/deposit', async (c) => {
    const read = await readJsonBody(c);
    if ('error' in read) return read.error;

    try {
        const parsed = parseDepositRequestBody(read.body);

        if (!parsed.value) {
            return sendError(c, 400, {
                code: 'VALIDATION_ERROR',
                message: 'Invalid deposit submission.',
                details: parsed.errors,
            });
        }

        const { txHash, depositAddress, memo, nearSenderAccount } = parsed.value;

        await submitDepositTx({
            txHash,
            depositAddress,
            memo,
            nearSenderAccount,
        });

        return c.json({ success: true });
    } catch (error) {
        if (error instanceof OneClickError) {
            return sendError(c, error.status, {
                code: 'DEPOSIT_SUBMISSION_FAILED',
                message: 'Submit deposit failed.',
                details: error.body,
            });
        }
        console.error('Deposit error:', error);
        return sendError(c, 500, {
            code: 'INTERNAL_ERROR',
            message: 'Internal server error.',
        });
    }
});

// ============================================================================
// GET /api/status/:depositAddress
// ============================================================================

intentsRoutes.get('/status/:depositAddress', async (c) => {
    try {
        const depositAddress = c.req.param('depositAddress');
        const memo = c.req.query('memo');

        if (!depositAddress) {
            return sendError(c, 400, {
                code: 'VALIDATION_ERROR',
                message: 'Missing depositAddress parameter.',
            });
        }

        const response = await getExecutionStatus(depositAddress, memo);

        const observedAt = new Date();
        const status = response.status;
        const isComplete = ['SUCCESS', 'REFUNDED', 'FAILED'].includes(status);
        const isSuccess = status === 'SUCCESS';

        const swapDetails = response.swapDetails;
        const destinationTxHashes = swapDetails?.destinationChainTxHashes?.map(
            (tx) => tx.hash,
        );
        const originTxHashes = swapDetails?.originChainTxHashes?.map(
            (tx) => tx.hash,
        );
        // Index-aligned with the hash arrays, so the SDK can link each hash to 1Click's own explorer URL.
        const destinationTxExplorerUrls =
            swapDetails?.destinationChainTxHashes?.map(
                (tx) => tx.explorerUrl || null,
            );
        const originTxExplorerUrls = swapDetails?.originChainTxHashes?.map(
            (tx) => tx.explorerUrl || null,
        );

        recordStatus({
            depositAddress,
            depositMemo: memo,
            status,
            correlationId: response.correlationId,
            originTxHashes,
            destinationTxHashes,
            observedAt,
        });

        return c.json({
            status,
            isComplete,
            isSuccess,
            correlationId: response.correlationId,
            destinationTxHashes,
            originTxHashes,
            destinationTxExplorerUrls,
            originTxExplorerUrls,
        });
    } catch (error) {
        if (error instanceof OneClickError) {
            return sendError(c, error.status, {
                code: 'STATUS_CHECK_FAILED',
                message: 'Status check failed.',
                details: error.body,
            });
        }
        console.error('Status error:', error);
        return sendError(c, 500, {
            code: 'INTERNAL_ERROR',
            message: 'Internal server error.',
        });
    }
});
