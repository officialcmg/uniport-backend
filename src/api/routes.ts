/**
 * The /api routes.
 *
 * Proxies cross-chain swap requests to the 1Click API.
 * The API key is stored server-side — frontend SDK never touches it.
 */

import type { QuoteRequest } from '@defuse-protocol/one-click-sdk-typescript';
import { parseDepositRequestBody, parseQuoteRequestBody } from './contract.js';
import {
    findQuoteProblem,
    isQuoteVerificationEnabled,
    signatureCheckable,
    signatureVerifies,
} from './quote-verification.js';
import { queryRows } from '../db/query.js';
import { recordQuote, recordStatus } from '../db/records.js';
import { errorResponse, json, readJsonBody } from '../http.js';
import { OneClickError, getExecutionStatus, getQuote, submitDepositTx } from '../one-click.js';
import { recipientAllowed, resolveAccess } from '../apps.js';
import { LOCAL_LIVE_QUOTE_LIMIT, checkAppLimit, checkLiveQuoteLimit } from '../rate-limit.js';

// The SDK declares these request fields as enums. Its runtime code is not
// loaded (see one-click.ts), so the values are written out and typed here.
type Enum<Field extends keyof QuoteRequest> = NonNullable<QuoteRequest[Field]>;
const EXACT_INPUT = 'EXACT_INPUT' as Enum<'swapType'>;
const ORIGIN_CHAIN_DEPOSIT = 'ORIGIN_CHAIN' as Enum<'depositType'>;
const ORIGIN_CHAIN_REFUND = 'ORIGIN_CHAIN' as Enum<'refundType'>;
const INTENTS_REFUND = 'INTENTS' as Enum<'refundType'>;
const DESTINATION_CHAIN = 'DESTINATION_CHAIN' as Enum<'recipientType'>;

// How 1Click attributes quotes made with Uniport's API key. It is never taken
// from the request, so a caller cannot relabel them.
const REFERRAL = 'uniport';

/** The status to answer with when 1Click fails: its own if it is an error status, else 502. */
function upstreamErrorStatus(error: OneClickError): number {
    return error.status >= 400 && error.status <= 599 ? error.status : 502;
}

/** Answers a failure that did not come from 1Click as an error response. */
function unexpectedError(what: string, error: unknown, headers?: Record<string, string>): Response {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    console.error(`${what} error:`, error);
    return errorResponse(
        timedOut ? 504 : 500,
        {
            code: 'INTERNAL_ERROR',
            message: timedOut ? '1Click did not respond in time.' : 'Internal server error.',
        },
        headers,
    );
}

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

    // Who is asking: a registered app, or nobody in particular.
    const access = await resolveAccess(request, env);
    if (access.kind === 'refused') {
        return errorResponse(403, { code: access.code, message: access.message });
    }
    if (access.kind === 'app') {
        const limited = await checkAppLimit(access.app.id, env);
        if (limited) return limited;
    }

    // Live quotes create a deposit address at 1Click and a database row, so they
    // get a tighter limit than the global one. Dry quotes are only price checks
    // and are not counted.
    let limitHeaders: Record<string, string> = {};
    if ((read.body as { dry?: unknown }).dry !== true) {
        const limit = await checkLiveQuoteLimit(
            request,
            env,
            access.kind === 'anonymous' && access.tier === 'local'
                ? LOCAL_LIVE_QUOTE_LIMIT
                : undefined,
        );
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
        } = parsed.value;

        if (
            access.kind === 'app' &&
            !recipientAllowed(recipient, access.app.recipientAllowlist)
        ) {
            return errorResponse(
                403,
                {
                    code: 'RECIPIENT_NOT_ALLOWED',
                    message: 'This app only accepts payments to the addresses on its recipient list.',
                },
                limitHeaders,
            );
        }

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
            referral: REFERRAL,
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
                appId: access.kind === 'app' ? access.app.id : undefined,
                appPublicId: access.kind === 'app' ? access.publicId : access.claimedId,
                origin: request.headers.get('origin') ?? undefined,
            });
        }

        return json(
            {
                quote: {
                    // 1Click's signature does not cover these fields on a dry quote,
                    // so a dry quote never carries a deposit address.
                    depositAddress: quoteRequest.dry ? '' : (response.quote.depositAddress ?? ''),
                    depositMemo: quoteRequest.dry ? undefined : response.quote.depositMemo,
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
                upstreamErrorStatus(error),
                {
                    code: 'QUOTE_FAILED',
                    message: 'Quote failed.',
                    details: error.body,
                },
                limitHeaders,
            );
        }
        return unexpectedError('Quote', error, limitHeaders);
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
            return errorResponse(upstreamErrorStatus(error), {
                code: 'DEPOSIT_SUBMISSION_FAILED',
                message: 'Submit deposit failed.',
                details: error.body,
            });
        }
        return unexpectedError('Deposit', error);
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
        if (typeof status !== 'string') {
            console.error('1Click returned a status response without a status');
            return errorResponse(502, {
                code: 'STATUS_CHECK_FAILED',
                message: 'Status check failed.',
            });
        }
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

        // Recorded under the address and memo as 1Click has them, not as the
        // caller spelled them: 1Click accepts any letter case, and the quote
        // was saved with 1Click's.
        const quoted = response.quoteResponse?.quote;
        recordStatus(env, ctx, {
            depositAddress: quoted?.depositAddress || depositAddress,
            depositMemo: quoted?.depositMemo ?? memo,
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
            return errorResponse(upstreamErrorStatus(error), {
                code: 'STATUS_CHECK_FAILED',
                message: 'Status check failed.',
                details: error.body,
            });
        }
        return unexpectedError('Status', error);
    }
}

// ============================================================================
// GET /v1/payments/:depositAddress
// ============================================================================

const COMPLETE_STATUSES = ['SUCCESS', 'REFUNDED', 'FAILED'];

/**
 * What a merchant's server needs to confirm a payment before fulfilling an
 * order: it should check `appId`, `recipient`, `destinationAsset`, the amount
 * and `status` itself, and never rely on the browser's onSuccess callback.
 *
 * Everything about the payment comes live from 1Click, including the quote
 * 1Click signed. Only `appId` and `createdAt` come from Uniport's own record of
 * the quote. No secret is needed: a deposit address is not guessable, and the
 * rest is visible on chain.
 */
export async function handlePayment(
    depositAddress: string,
    memo: string | undefined,
    env: Env,
    ctx: ExecutionContext,
): Promise<Response> {
    try {
        const response = await getExecutionStatus(env, depositAddress, memo);
        const observedAt = new Date();
        const signed = response.quoteResponse;
        const status = response.status;
        if (typeof status !== 'string' || !signed?.quote || !signed.quoteRequest) {
            console.error('1Click returned an incomplete status response');
            return errorResponse(502, {
                code: 'STATUS_CHECK_FAILED',
                message: 'Status check failed.',
            });
        }

        // The quote this payment was made against must be one 1Click signed.
        const verified =
            !isQuoteVerificationEnabled(env) ||
            !signatureCheckable(signed.quoteRequest) ||
            (await signatureVerifies(signed));
        if (!verified) {
            console.error(`Payment ${depositAddress} has a quote that does not verify`);
            return errorResponse(502, {
                code: 'QUOTE_UNVERIFIED',
                message: 'Could not verify the payment. Please try again.',
            });
        }

        const canonicalAddress = signed.quote.depositAddress || depositAddress;
        const canonicalMemo = signed.quote.depositMemo ?? memo;
        const swapDetails = response.swapDetails;
        const originTxHashes = swapDetails?.originChainTxHashes?.map((tx) => tx.hash);
        const destinationTxHashes = swapDetails?.destinationChainTxHashes?.map((tx) => tx.hash);

        // Which app asked for the quote, from Uniport's record. If the record
        // cannot be read the answer says so, and a merchant checking appId
        // will not accept the payment on a guess.
        let record: { app_public_id: string | null; created_at: string } | undefined;
        let recordRead = true;
        try {
            const rows = await queryRows<{ app_public_id: string | null; created_at: string }>(
                env,
                `SELECT CASE WHEN app_id IS NULL THEN NULL ELSE app_public_id END AS app_public_id,
                        created_at
                 FROM quotes WHERE deposit_address = $1 AND deposit_memo = $2`,
                [canonicalAddress, canonicalMemo ?? ''],
                1_500,
            );
            record = rows[0];
        } catch (err) {
            recordRead = false;
            console.error('Could not read the quote record:', (err as Error).message);
        }

        // A server asking about a payment is as good a status poll as any.
        recordStatus(env, ctx, {
            depositAddress: canonicalAddress,
            depositMemo: canonicalMemo,
            status,
            correlationId: response.correlationId,
            originTxHashes,
            destinationTxHashes,
            observedAt,
        });

        return json({
            depositAddress: canonicalAddress,
            depositMemo: canonicalMemo ?? null,
            status,
            isComplete: COMPLETE_STATUSES.includes(status),
            isSuccess: status === 'SUCCESS',
            appId: record?.app_public_id ?? null,
            appIdKnown: recordRead,
            createdAt: record?.created_at ?? null,
            updatedAt: response.updatedAt ?? null,
            swapType: signed.quoteRequest.swapType,
            recipient: signed.quoteRequest.recipient,
            originAsset: signed.quoteRequest.originAsset,
            destinationAsset: signed.quoteRequest.destinationAsset,
            quotedAmountOut: signed.quote.amountOut,
            minAmountOut: signed.quote.minAmountOut,
            // What was actually delivered; null until the swap completes.
            amountOut: swapDetails?.amountOut ?? null,
            amountOutUsd: swapDetails?.amountOutUsd ?? null,
            refundedAmount: swapDetails?.refundedAmount ?? null,
            originTxHashes: originTxHashes ?? [],
            destinationTxHashes: destinationTxHashes ?? [],
            correlationId: response.correlationId,
            // The quote as 1Click signed it, for anyone who wants to check the signature themselves.
            signedQuote: {
                quoteRequest: signed.quoteRequest,
                quote: signed.quote,
                signature: signed.signature,
                timestamp: signed.timestamp,
            },
        });
    } catch (error) {
        if (error instanceof OneClickError) {
            return errorResponse(upstreamErrorStatus(error), {
                code: 'STATUS_CHECK_FAILED',
                message: 'Status check failed.',
                details: error.body,
            });
        }
        return unexpectedError('Payment', error);
    }
}
