/**
 * The Express app. It runs on Cloudflare Workers through the Node HTTP server
 * support; src/worker.ts is the entry.
 */

import express from 'express';
import cors from 'cors';
import { OpenAPI } from '@defuse-protocol/one-click-sdk-typescript';
import { sendError } from './api/contract.js';
import { createIntentsRouter } from './api/intents.js';
import { globalLimiter } from './rate-limit.js';

export function createApp(): express.Express {
    const app = express();

    // CORS — open to all origins (SDK can be used from any domain)
    app.use(cors());

    // Parse JSON bodies
    app.use(express.json());

    app.use(globalLimiter);

    app.get('/health', (_req, res) => {
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            service: 'Uniport Backend',
        });
    });

    // The 1Click SDK is configured on each request because the environment
    // is not guaranteed to be readable while the module loads.
    app.use('/api', (_req, res, next) => {
        if (!process.env.NEAR_API_KEY) {
            console.error('NEAR_API_KEY is not set');
            sendError(res, 503, {
                code: 'INTERNAL_ERROR',
                message: 'The service is not configured.',
            });
            return;
        }
        OpenAPI.BASE = process.env.ONECLICK_BASE_URL || 'https://1click.chaindefuser.com';
        OpenAPI.TOKEN = process.env.NEAR_API_KEY;
        next();
    });

    app.use('/api', createIntentsRouter());

    app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        // express.json() rejects the body before any route runs.
        if (err?.type === 'entity.parse.failed') {
            sendError(res, 400, {
                code: 'VALIDATION_ERROR',
                message: 'Request body must be valid JSON.',
            });
            return;
        }
        if (err?.type === 'entity.too.large') {
            sendError(res, 413, {
                code: 'VALIDATION_ERROR',
                message: 'Request body is too large.',
            });
            return;
        }
        console.error('Unhandled error:', err);
        res.status(500).json({
            error: 'Internal server error',
            message: process.env.NODE_ENV === 'development' ? err.message : undefined,
        });
    });

    return app;
}
