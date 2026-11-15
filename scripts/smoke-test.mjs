#!/usr/bin/env node
/**
 * Smoke test for a running backend, on either runtime.
 *
 *   node scripts/smoke-test.mjs <base-url> [--live]
 *
 * Without --live only dry quotes are requested. With --live it also requests
 * one real quote (creates a deposit address at 1Click and a database row; no
 * funds move) and polls its status.
 */

const base = (process.argv[2] ?? '').replace(/\/$/, '');
const live = process.argv.includes('--live');
if (!base) {
    console.error('Usage: node scripts/smoke-test.mjs <base-url> [--live]');
    process.exit(2);
}

const ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const quoteBody = (dry) => ({
    dry,
    swapType: 'EXACT_INPUT',
    originAsset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
    destinationAsset: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
    amount: '5000000',
    refundTo: ADDRESS,
    recipient: ADDRESS,
});

let failed = 0;
function check(name, ok, detail = '') {
    if (!ok) failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function call(method, path, body, headers = {}) {
    const started = Date.now();
    const res = await fetch(base + path, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        json = undefined;
    }
    return { status: res.status, json, text, headers: res.headers, ms: Date.now() - started };
}

const post = (path, body, headers) => call('POST', path, body, headers);
const get = (path) => call('GET', path);

{
    const r = await get('/health');
    check('health returns 200 healthy', r.status === 200 && r.json?.status === 'healthy', `${r.ms} ms`);
}
{
    const r = await call('OPTIONS', '/api/quote', undefined, {
        origin: 'https://example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
    });
    check(
        'CORS preflight allows any origin',
        r.status === 204 && r.headers.get('access-control-allow-origin') === '*',
        `status ${r.status}`,
    );
}
{
    const r = await post('/api/quote', { dry: true });
    check(
        'invalid quote is rejected with VALIDATION_ERROR',
        r.status === 400 && r.json?.code === 'VALIDATION_ERROR' && Array.isArray(r.json?.details),
        `status ${r.status}`,
    );
}
{
    const r = await post('/api/quote', '{not json');
    check('malformed JSON is rejected with VALIDATION_ERROR', r.status === 400 && r.json?.code === 'VALIDATION_ERROR', `status ${r.status}`);
}
{
    const r = await post('/api/quote', quoteBody(true));
    const q = r.json?.quote;
    check(
        'dry quote returns amounts and no deposit address',
        r.status === 200 && q?.amountOut && q?.depositAddress === '' && typeof r.json?.correlationId === 'string',
        `status ${r.status}, ${r.ms} ms`,
    );
    check('dry quote is not counted by the live-quote limit', r.headers.get('ratelimit-policy') !== '150;w=600');
}
{
    const r = await post('/api/quote', { ...quoteBody(true), recipient: 'not-an-address' });
    check(
        '1Click rejection is passed through as QUOTE_FAILED',
        r.status === 400 && r.json?.code === 'QUOTE_FAILED' && r.json?.details !== undefined,
        `status ${r.status}`,
    );
}
{
    const r = await post('/api/deposit', { txHash: '0xdeadbeef', depositAddress: '0x0000000000000000000000000000000000000001' });
    check(
        'bogus deposit is rejected with DEPOSIT_SUBMISSION_FAILED',
        r.status >= 400 && r.json?.code === 'DEPOSIT_SUBMISSION_FAILED',
        `status ${r.status}`,
    );
}
{
    const r = await get('/api/status/0x0000000000000000000000000000000000000001');
    check(
        'unknown deposit address gives STATUS_CHECK_FAILED',
        r.status >= 400 && r.json?.code === 'STATUS_CHECK_FAILED',
        `status ${r.status}`,
    );
}
{
    const r = await get('/no-such-route');
    check('unknown route returns 404', r.status === 404);
}

if (live) {
    const r = await post('/api/quote', quoteBody(false));
    const address = r.json?.quote?.depositAddress;
    check('live quote returns a deposit address', r.status === 200 && !!address, `status ${r.status}, ${r.ms} ms`);
    check(
        'live quote carries the 150-per-10-minutes limit headers',
        r.headers.get('ratelimit-policy') === '150;w=600' && r.headers.get('ratelimit-remaining') !== null,
        `policy ${r.headers.get('ratelimit-policy')}, remaining ${r.headers.get('ratelimit-remaining')}`,
    );
    if (address) {
        const s = await get(`/api/status/${address}`);
        check('status of the new quote is PENDING_DEPOSIT', s.status === 200 && s.json?.status === 'PENDING_DEPOSIT', `status ${s.status}`);
        console.log(`      deposit address ${address}, correlation ID ${r.json.correlationId}`);
    }
}

console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
