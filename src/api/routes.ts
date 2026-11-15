/**
 * The /api routes.
 *
 * Proxies cross-chain swap requests to the 1Click API.
 * The API key is stored server-side — frontend SDK never touches it.
 */

import type { QuoteRequest } from '@defuse-protocol/one-click-sdk-typescript';
import { parseDepositRequestBody, parseQuoteRequestBody } from './contract.js';
import { findQuoteProblem, isQuoteVerificationEnabled } from './quote-verification.js';
import { recordQuote, recordStatus } from '../db/records.js';
import { errorResponse, json, readJsonBody } from '../http.js';
import { OneClickError, getExecutionStatus, getQuote, submitDepositTx } from '../one-click.js';
import { checkLiveQuoteLimit } from '../rate-limit.js';

// The SDK declares these request fields as enums. Its runtime code is not
// loaded (see one-click.ts), so the values are written out and typed here.
type Enum<Field extends keyof QuoteRequest> = NonNullable<QuoteRequest[Field]>;
const EXACT_INPUT = 'EXACT_INPUT' as Enum<'swapType'>;
const ORIGIN_CHAIN_DEPOSIT = 'ORIGIN_CHAIN' as Enum<'depositType'>;
const ORIGIN_CHAIN_REFUND = 'ORIGIN_CHAIN' as Enum<'refundType'>;
const INTENTS_REFUND = 'INTENTS' as Enum<'refundType'>;
const DESTINATION_CHAIN = 'DESTINATION_CHAIN' as Enum<'recipientType'>;

// ============================================================================
// POST /api/quote
// ============================================================================

export async function handleQuote(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
): Promise<Response> {
    const read = await readJsonBody(request);
    if ('error' in read) return read.error;

    // Live quotes create a deposit address at 1Click and a database row, so they
    // get a tighter limit than the global one. Dry quotes are only price checks
    // and are not counted.
    let limitHeaders: Record<string, string> = {};
    if ((read.body as { dry?: unknown }).dry !== true) {
        const limit = await checkLiveQuoteLimit(request, env);
        if ('limited' in limit) return limit.limited;
        limitHeaders = limit.headers;
    }

    try {
        const parsed = parseQuoteRequestBody(read.body);

        if (!parsed.value) {
            return errorResponse(
                400,
                {
                    code: 'VALIDATION_ERROR',
                    message: 'Invalid quote request.',
                    details: parsed.errors,
                },
                limitHeaders,
            );
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
        const intentsRefundAccount = env.UNIPORT_INTENTS_REFUND_ACCOUNT?.trim().toLowerCase();

        if (isExactOutput && !intentsRefundAccount) {
            return errorResponse(
                503,
                {
                    code: 'INTERNAL_ERROR',
                    message: 'Exact-output payments are not configured.',
                },
                limitHeaders,
            );
        }

        const quoteRequest: QuoteRequest = {
            dry: dry ?? false,
            swapType: (swapType as Enum<'swapType'> | undefined) ?? EXACT_INPUT,
            slippageTolerance: slippageTolerance ?? 100,
            depositMode: depositMode as Enum<'depositMode'> | undefined,
            originAsset,
            depositType: ORIGIN_CHAIN_DEPOSIT,
            destinationAsset,
            amount,
            refundTo: isExactOutput ? intentsRefundAccount! : refundTo!,
            refundType: isExactOutput ? INTENTS_REFUND : ORIGIN_CHAIN_REFUND,
            recipient,
            recipientType: DESTINATION_CHAIN,
            deadline: deadline ?? new Date(Date.now() + 3600000).toISOString(),
            referral: referral ?? 'uniport',
        };

        const response = await getQuote(env, quoteRequest);

        // Never hand a payer a deposit address that 1Click didn't sign for this request.
        if (isQuoteVerificationEnabled(env)) {
            const problem = await findQuoteProblem(response, quoteRequest);
            if (problem) {
                console.error(
                    `Rejected unverified quote (${problem}); correlationId=${response.correlationId}`
                );
                return errorResponse(
                    502,
                    {
                        code: 'QUOTE_UNVERIFIED',
                        message: 'Could not verify the quote. Please try again.',
                    },
                    limitHeaders,
                );
            }
        }

        // Dry quotes have no deposit address and are never paid, so only live ones are kept.
        if (!quoteRequest.dry && response.quote.depositAddress) {
            recordQuote(env, ctx, {
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

        return json(
            {
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
            },
            200,
            limitHeaders,
        );
    } catch (error) {
        if (error instanceof OneClickError) {
            return errorResponse(
                error.status,
                {
                    code: 'QUOTE_FAILED',
                    message: 'Quote failed.',
                    details: error.body,
                },
                limitHeaders,
            );
        }
        console.error('Quote error:', error);
        return errorResponse(
            500,
            {
                code: 'INTERNAL_ERROR',
                message: 'Internal server error.',
            },
            limitHeaders,
        );
    }
}

// ============================================================================
// POST /api/deposit
// ============================================================================

export async function handleDeposit(request: Request, env: Env): Promise<Response> {
    const read = await readJsonBody(request);
    if ('error' in read) return read.error;

    try {
        const parsed = parseDepositRequestBody(read.body);

        if (!parsed.value) {
            return errorResponse(400, {
                code: 'VALIDATION_ERROR',
                message: 'Invalid deposit submission.',
                details: parsed.errors,
            });
        }

        const { txHash, depositAddress, memo, nearSenderAccount } = parsed.value;

        await submitDepositTx(env, {
            txHash,
            depositAddress,
            memo,
            nearSenderAccount,
        });

        return json({ success: true });
    } catch (error) {
        if (error instanceof OneClickError) {
            return errorResponse(error.status, {
                code: 'DEPOSIT_SUBMISSION_FAILED',
                message: 'Submit deposit failed.',
                details: error.body,
            });
        }
        console.error('Deposit error:', error);
        return errorResponse(500, {
            code: 'INTERNAL_ERROR',
            message: 'Internal server error.',
        });
    }
}

// ============================================================================
// GET /api/status/:depositAddress
// ============================================================================

export async function handleStatus(
    depositAddress: string,
    memo: string | undefined,
    env: Env,
    ctx: ExecutionContext,
): Promise<Response> {
    try {
        const response = await getExecutionStatus(env, depositAddress, memo);

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

        recordStatus(env, ctx, {
            depositAddress,
            depositMemo: memo,
            status,
            correlationId: response.correlationId,
            originTxHashes,
            destinationTxHashes,
            observedAt,
        });

        return json({
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
            return errorResponse(error.status, {
                code: 'STATUS_CHECK_FAILED',
                message: 'Status check failed.',
                details: error.body,
            });
        }
        console.error('Status error:', error);
        return errorResponse(500, {
            code: 'INTERNAL_ERROR',
            message: 'Internal server error.',
        });
    }
}
