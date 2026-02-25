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

export const intentsRouter = Router();

// ============================================================================
// POST /api/quote
// ============================================================================

intentsRouter.post('/quote', async (req, res) => {
    try {
        const {
            dry,
            swapType,
            slippageTolerance,
            originAsset,
            destinationAsset,
            amount,
            refundTo,
            recipient,
            deadline,
            referral,
        } = req.body;

        // Validate required fields
        if (!originAsset || !destinationAsset || !amount || !recipient) {
            res.status(400).json({
                error: 'Missing required fields: originAsset, destinationAsset, amount, recipient',
            });
            return;
        }

        const quoteRequest: QuoteRequest = {
            dry: dry ?? false,
            swapType: swapType ?? QuoteRequest.swapType.EXACT_INPUT,
            slippageTolerance: slippageTolerance ?? 100,
            originAsset,
            depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
            destinationAsset,
            amount,
            refundTo: refundTo ?? '',
            refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
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
                amountOut: response.quote.amountOut,
                amountOutFormatted: response.quote.amountOutFormatted,
                amountOutUsd: response.quote.amountOutUsd,
                deadline: response.quote.deadline,
                timeWhenInactive: response.quote.timeWhenInactive,
            },
            correlationId: response.correlationId,
        });
    } catch (error) {
        if (error instanceof ApiError) {
            res.status(error.status).json({
                error: `Quote failed`,
                details: error.body,
            });
            return;
        }
        console.error('Quote error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================================================
// POST /api/deposit
// ============================================================================

intentsRouter.post('/deposit', async (req, res) => {
    try {
        const { txHash, depositAddress, memo, nearSenderAccount } = req.body;

        if (!txHash || !depositAddress) {
            res.status(400).json({
                error: 'Missing required fields: txHash, depositAddress',
            });
            return;
        }

        await OneClickService.submitDepositTx({
            txHash,
            depositAddress,
            memo,
            nearSenderAccount,
        });

        res.json({ success: true });
    } catch (error) {
        if (error instanceof ApiError) {
            res.status(error.status).json({
                error: 'Submit deposit failed',
                details: error.body,
            });
            return;
        }
        console.error('Deposit error:', error);
        res.status(500).json({ error: 'Internal server error' });
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
            res.status(400).json({ error: 'Missing depositAddress parameter' });
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

        res.json({
            status,
            isComplete,
            isSuccess,
            correlationId: response.correlationId,
            destinationTxHashes,
            originTxHashes,
        });
    } catch (error) {
        if (error instanceof ApiError) {
            res.status(error.status).json({
                error: 'Status check failed',
                details: error.body,
            });
            return;
        }
        console.error('Status error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});
