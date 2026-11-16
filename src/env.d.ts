/** Bindings, variables and secrets declared in wrangler.jsonc. */
interface Env {
    /** Workers Rate Limiting binding: 100 requests per minute per IP. */
    GLOBAL_LIMITER: RateLimit;
    /** Workers Rate Limiting binding: 600 quote requests per minute per app. */
    APP_LIMITER: RateLimit;
    /** One Durable Object per IP, counting live quotes. */
    LIVE_QUOTE_LIMITER: DurableObjectNamespace<import('./rate-limit.js').LiveQuoteLimiter>;
    NEAR_API_KEY?: string;
    /** Neon connection string. Optional: without it nothing is recorded. */
    DATABASE_URL?: string;
    ONECLICK_BASE_URL?: string;
    UNIPORT_INTENTS_REFUND_ACCOUNT?: string;
    VERIFY_QUOTE_SIGNATURES?: string;
    /** Key for the tag inside App IDs (see app-id.ts). The dashboard holds the same value. */
    APP_ID_HMAC_SECRET?: string;
    /** "on" makes websites send an App ID; anything else lets them through without one. */
    APP_ID_ENFORCEMENT?: string;
}
