// Bindings, variables and secrets declared in wrangler.jsonc.
declare namespace Cloudflare {
    interface Env {
        /** Hyperdrive config pointing at Neon. Optional: without it nothing is recorded. */
        HYPERDRIVE?: Hyperdrive;
        /** Workers Rate Limiting binding: 100 requests per minute per IP. */
        GLOBAL_LIMITER: RateLimit;
        /** One Durable Object per IP, counting live quotes. */
        LIVE_QUOTE_LIMITER: DurableObjectNamespace<
            import('./rate-limit.js').LiveQuoteLimiter
        >;
        NEAR_API_KEY: string;
        ONECLICK_BASE_URL?: string;
        UNIPORT_INTENTS_REFUND_ACCOUNT?: string;
        VERIFY_QUOTE_SIGNATURES?: string;
    }
}
