/**
 * Guards the copy of the 1Click SDK's quote hashing in src/api/quote-hash.ts.
 * Run with `npm test`, and always after upgrading the SDK.
 *
 * The fixtures are real quotes signed by 1Click.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import {
    quoteHash,
    verifyQuoteSignature,
    type QuoteResponse,
} from '@defuse-protocol/one-click-sdk-typescript';
import stableStringifyReference from 'json-stable-stringify';
import { quoteHashBytes, stableStringify } from '../src/api/quote-hash.js';
import { ONE_CLICK_PUBLIC_KEY, signatureVerifies } from '../src/api/quote-verification.js';

const fixturesDir = new URL('./fixtures/', import.meta.url);
const fixtures = readdirSync(fixturesDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({
        name,
        response: JSON.parse(readFileSync(new URL(name, fixturesDir), 'utf8')) as QuoteResponse,
    }));

test('there are fixtures for dry and live quotes', () => {
    assert.ok(fixtures.some((f) => f.response.quoteRequest.dry));
    assert.ok(fixtures.some((f) => !f.response.quoteRequest.dry));
});

for (const { name, response } of fixtures) {
    test(`${name}: our hash equals the SDK's quoteHash`, async () => {
        const ours = new TextDecoder().decode(await quoteHashBytes(response));
        assert.equal(ours, quoteHash(response));
    });

    test(`${name}: 1Click's signature verifies, as it does with the SDK`, async () => {
        assert.equal(verifyQuoteSignature(response), true);
        assert.equal(await signatureVerifies(response), true);
    });

    test(`${name}: a changed recipient, amount or deposit address is rejected`, async () => {
        const changes: ((r: QuoteResponse) => void)[] = [
            (r) => (r.quoteRequest.recipient = '0x000000000000000000000000000000000000dEaD'),
            (r) => (r.quote.amountOut = '1'),
            (r) => (r.timestamp = new Date(0).toISOString()),
        ];
        if (!response.quoteRequest.dry) {
            changes.push((r) => (r.quote.depositAddress = '0x000000000000000000000000000000000000dEaD'));
        }
        for (const change of changes) {
            const tampered = structuredClone(response);
            change(tampered);
            assert.equal(await signatureVerifies(tampered), false);
            assert.equal(verifyQuoteSignature(tampered), false);
        }
    });

    test(`${name}: a malformed signature is rejected, not thrown`, async () => {
        for (const signature of ['', 'ed25519:', 'not base58 !!', 'ed25519:1111']) {
            assert.equal(await signatureVerifies({ ...response, signature }), false);
        }
    });
}

test("the public key is the SDK's", () => {
    const sdkSource = readFileSync(
        new URL('../node_modules/@defuse-protocol/one-click-sdk-typescript/dist/index.mjs', import.meta.url),
        'utf8',
    );
    assert.ok(sdkSource.includes(`ONE_CLICK_MANAGER_PUB_KEY = "${ONE_CLICK_PUBLIC_KEY}"`));
});

test('stableStringify matches json-stable-stringify', () => {
    const samples: unknown[] = [
        { b: 1, a: 'x', c: undefined, d: null, e: true, f: 1.5 },
        { z: { y: [3, 'two', { b: 1, a: undefined }], x: '"quoted" \\   é' }, a: [] },
        { '10': 1, '9': 2, B: 3, a: 4, '': 5 },
        [undefined, null, { b: 2, a: 1 }],
        'text',
        42,
        null,
    ];
    for (const sample of samples) {
        assert.equal(stableStringify(sample), stableStringifyReference(sample));
    }
});

test('Polygon and Bitcoin quotes skip the signature check; others do not', async () => {
    const { signatureCheckable } = await import('../src/api/quote-verification.js');
    const base = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
    const optimism = 'nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ';
    const polygon = 'nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L';
    assert.equal(signatureCheckable({ originAsset: base, destinationAsset: optimism }), true);
    assert.equal(signatureCheckable({ originAsset: polygon, destinationAsset: base }), false);
    assert.equal(signatureCheckable({ originAsset: base, destinationAsset: polygon }), false);
    assert.equal(signatureCheckable({ originAsset: 'nep141:btc.omft.near', destinationAsset: base }), false);
    // Chain 1370 is not Polygon: the prefix ends with an underscore.
    assert.equal(signatureCheckable({ originAsset: 'nep245:v2_1.omni.hot.tg:1370_abc', destinationAsset: base }), true);
});
