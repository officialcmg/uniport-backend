/**
 * The HTTP app: CORS, rate limiting, health check and the /api routes.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ApiErrorResponse } from './api/contract.js';
import { intentsRoutes } from './api/intents.js';
import { globalLimiter } from './rate-limit.js';

export const app = new Hono();

// CORS — open to all origins (SDK can be used from any domain). It comes first
// so that rate-limited and failed responses can still be read by a browser.
app.use(cors());

app.use(globalLimiter);

app.get('/health', (c) =>
    c.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'Uniport Backend',
    }),
);

app.use('/api/*', async (c, next) => {
    if (!process.env.NEAR_API_KEY) {
        console.error('NEAR_API_KEY is not set');
        return c.json<ApiErrorResponse>(
            { code: 'INTERNAL_ERROR', message: 'The service is not configured.' },
            503,
        );
    }
    await next();
});

app.route('/api', intentsRoutes);

app.onError((err, c) => {
    console.error('Unhandled error:', err);
    return c.json({ error: 'Internal server error' }, 500);
});
