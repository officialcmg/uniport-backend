import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { OpenAPI } from '@defuse-protocol/one-click-sdk-typescript';
import { intentsRouter } from './api/intents.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ============================================================================
// Validate required environment variables
// ============================================================================

if (!process.env.NEAR_API_KEY) {
    console.error('❌ NEAR_API_KEY environment variable is required');
    process.exit(1);
}

// ============================================================================
// Configure 1Click SDK with the server-side API key
// ============================================================================

OpenAPI.BASE = process.env.ONECLICK_BASE_URL || 'https://1click.chaindefuser.com';
OpenAPI.TOKEN = process.env.NEAR_API_KEY;

// ============================================================================
// Middleware
// ============================================================================

// CORS — open to all origins (SDK can be used from any domain)
app.use(cors());

// Parse JSON bodies
app.use(express.json());

// Basic rate limiting — 100 requests per minute per IP
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
});
app.use(limiter);

// ============================================================================
// Health check
// ============================================================================

app.get('/health', (_req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'Uniport Backend',
    });
});

// ============================================================================
// Routes
// ============================================================================

app.use('/api', intentsRouter);

// ============================================================================
// Error handler
// ============================================================================

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
});

// ============================================================================
// Start
// ============================================================================

app.listen(PORT, () => {
    console.log(`🚀 Uniport Backend running on port ${PORT}`);
    console.log(`   Health:  http://localhost:${PORT}/health`);
    console.log(`   Quote:   POST http://localhost:${PORT}/api/quote`);
    console.log(`   Deposit: POST http://localhost:${PORT}/api/deposit`);
    console.log(`   Status:  GET  http://localhost:${PORT}/api/status/:depositAddress`);
});
