/**
 * Cloudflare Workers entry.
 *
 * The Express app runs through Cloudflare's Node HTTP server support: the app
 * "listens" on a port that only exists inside the Worker, and
 * httpServerHandler routes incoming requests to it.
 */

import { httpServerHandler } from 'cloudflare:node';
import { createApp } from './app.js';

export { LiveQuoteLimiter } from './rate-limit.js';

const PORT = 3001;

createApp().listen(PORT);

export default httpServerHandler({ port: PORT });
