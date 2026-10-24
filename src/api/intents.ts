/**
 * Uniport Intents API Router
 *
 * Proxies cross-chain swap requests to the 1Click SDK.
 * The API key is stored server-side — frontend SDK never touches it.
 */

import { Router } from 'express';
import {
    OneClickService,
    QuoteRequest,
    ApiError,
} from '@defuse-protocol/one-click-sdk-typescript';
import {
    parseDepositRequestBody,
    parseQuoteRequestBody,
    sendError,
} from './contract.js';

export const intentsRouter = Router();

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

// ============================================================================
// POST /api/quote
// ============================================================================

intentsRouter.post('/quote', async (req, res) => {
    try {
        const parsed = parseQuoteRequestBody(req.body);

        if (!parsed.value) {
            sendError(res, 400, {
                code: 'VALIDATION_ERROR',
                message: 'Invalid quote request.',
                details: parsed.errors,
            });
            return;
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
            sendError(res, 503, {
                code: 'INTERNAL_ERROR',
                message: 'Exact-output payments are not configured.',
            });
            return;
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

        const response = await OneClickService.getQuote(quoteRequest);

        res.json({
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
        if (error instanceof ApiError) {
            sendError(res, error.status, {
                code: 'QUOTE_FAILED',
                message: 'Quote failed.',
                details: error.body,
            });
            return;
        }
        console.error('Quote error:', error);
        sendError(res, 500, {
            code: 'INTERNAL_ERROR',
            message: 'Internal server error.',
        });
    }
});

// ============================================================================
// POST /api/deposit
// ============================================================================

intentsRouter.post('/deposit', async (req, res) => {
    try {
        const parsed = parseDepositRequestBody(req.body);

        if (!parsed.value) {
            sendError(res, 400, {
                code: 'VALIDATION_ERROR',
                message: 'Invalid deposit submission.',
                details: parsed.errors,
            });
            return;
        }

        const { txHash, depositAddress, memo, nearSenderAccount } =
            parsed.value;

        await OneClickService.submitDepositTx({
            txHash,
            depositAddress,
            memo,
            nearSenderAccount,
        });

        res.json({ success: true });
    } catch (error) {
        if (error instanceof ApiError) {
            sendError(res, error.status, {
                code: 'DEPOSIT_SUBMISSION_FAILED',
                message: 'Submit deposit failed.',
                details: error.body,
            });
            return;
        }
        console.error('Deposit error:', error);
        sendError(res, 500, {
            code: 'INTERNAL_ERROR',
            message: 'Internal server error.',
        });
    }
});

// ============================================================================
// GET /api/status/:depositAddress
// ============================================================================

intentsRouter.get('/status/:depositAddress', async (req, res) => {
    try {
        const { depositAddress } = req.params;
        const memo = req.query.memo as string | undefined;

        if (!depositAddress) {
            sendError(res, 400, {
                code: 'VALIDATION_ERROR',
                message: 'Missing depositAddress parameter.',
            });
            return;
        }

        const response = await OneClickService.getExecutionStatus(
            depositAddress,
            memo,
        );

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

        res.json({
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
        if (error instanceof ApiError) {
            sendError(res, error.status, {
                code: 'STATUS_CHECK_FAILED',
                message: 'Status check failed.',
                details: error.body,
            });
            return;
        }
        console.error('Status error:', error);
        sendError(res, 500, {
            code: 'INTERNAL_ERROR',
            message: 'Internal server error.',
        });
    }
});
