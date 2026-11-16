/** The rules for who may ask for a quote. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    decideAccess,
    isLocalOrigin,
    originAllowed,
    recipientAllowed,
    type App,
    type AppLookup,
} from '../src/apps.js';

const ID = 'app_000SYW7RiJxkEgOGxsWbE4';
const app: App = {
    id: '11111111-1111-1111-1111-111111111111',
    status: 'active',
    allowedOrigins: ['https://shop.example.com', 'https://*.preview.example.com'],
    allowLocalhost: true,
    recipientAllowlist: null,
};
const found: AppLookup = { state: 'found', app };

function decide(overrides: Partial<Parameters<typeof decideAccess>[0]>) {
    return decideAccess({
        appId: ID,
        tagValid: true,
        lookup: found,
        origin: 'https://shop.example.com',
        enforced: true,
        ...overrides,
    });
}

test('a registered app on an allowed origin is let through', () => {
    assert.deepEqual(decide({}), { kind: 'app', app, publicId: ID });
    assert.equal(decide({ origin: 'https://pr-12.preview.example.com' }).kind, 'app');
    assert.equal(decide({ origin: 'http://localhost:3000' }).kind, 'app');
});

test('a registered app with no Origin (a server or script) is let through', () => {
    assert.equal(decide({ origin: null }).kind, 'app');
});

test('a registered app on another site is refused', () => {
    for (const origin of [
        'https://evil.example.org',
        'https://example.com',
        'https://preview.example.com',
        'http://shop.example.com',
        'https://shop.example.com.evil.org',
        'null',
    ]) {
        const result = decide({ origin });
        assert.equal(result.kind, 'refused', origin);
        assert.equal(result.kind === 'refused' && result.code, 'ORIGIN_NOT_ALLOWED', origin);
    }
});

test('localhost is refused when the app turns it off', () => {
    const lookup: AppLookup = { state: 'found', app: { ...app, allowLocalhost: false } };
    const result = decide({ lookup, origin: 'http://localhost:5173' });
    assert.equal(result.kind === 'refused' && result.code, 'ORIGIN_NOT_ALLOWED');
});

test('unknown, disabled, suspended and malformed IDs are refused', () => {
    const cases = [
        decide({ lookup: { state: 'missing' } }),
        decide({ tagValid: false, lookup: undefined }),
        decide({ lookup: { state: 'found', app: { ...app, status: 'suspended' } } }),
        decide({ appId: 'not-an-app-id', tagValid: undefined, lookup: undefined }),
        decide({ appId: 'sk_live_abc', tagValid: undefined, lookup: undefined }),
    ];
    for (const result of cases) {
        assert.equal(result.kind === 'refused' && result.code, 'APP_NOT_FOUND');
    }
});

test('an ID that cannot be checked is treated as unidentified, not refused', () => {
    for (const overrides of [
        { lookup: { state: 'unavailable' } as AppLookup },
        { tagValid: undefined, lookup: undefined },
    ]) {
        assert.deepEqual(decide(overrides), {
            kind: 'anonymous',
            tier: 'unidentified',
            claimedId: ID,
        });
    }
});

test('no ID: localhost and servers get the local allowance', () => {
    for (const origin of [null, 'http://localhost:3000', 'http://127.0.0.1:8080', 'http://app.localhost']) {
        assert.deepEqual(decide({ appId: undefined, origin }), { kind: 'anonymous', tier: 'local' });
    }
});

test('no ID from a website: allowed until enforced, then refused', () => {
    const origin = 'https://shop.example.com';
    assert.deepEqual(decide({ appId: undefined, origin, enforced: false }), {
        kind: 'anonymous',
        tier: 'unidentified',
    });
    const result = decide({ appId: undefined, origin, enforced: true });
    assert.equal(result.kind === 'refused' && result.code, 'APP_ID_REQUIRED');
});

test('isLocalOrigin', () => {
    assert.equal(isLocalOrigin('http://localhost'), true);
    assert.equal(isLocalOrigin('http://[::1]:3000'), true);
    assert.equal(isLocalOrigin('https://localhost.evil.org'), false);
    assert.equal(isLocalOrigin('https://notlocalhost'), false);
    assert.equal(isLocalOrigin('garbage'), false);
});

test('originAllowed ignores case and trailing slashes, and needs the scheme to match', () => {
    assert.equal(originAllowed('https://Shop.Example.com', ['https://shop.example.com/']), true);
    assert.equal(originAllowed('https://shop.example.com:8443', ['https://shop.example.com']), false);
    assert.equal(originAllowed('https://a.b.example.com', ['https://*.example.com']), true);
    assert.equal(originAllowed('https://example.com', ['https://*.example.com']), false);
    assert.equal(originAllowed('https://evilexample.com', ['https://*.example.com']), false);
    assert.equal(originAllowed('http://a.example.com', ['https://*.example.com']), false);
    assert.equal(originAllowed('https://shop.example.com', []), false);
});

test('recipientAllowed', () => {
    assert.equal(recipientAllowed('anything', null), true);
    assert.equal(recipientAllowed('anything', []), true);
    const list = ['0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', 'merchant.near'];
    assert.equal(recipientAllowed('0xD8DA6BF26964AF9D7EED9E03E53415D37AA96045'.replace('0X', '0x'), list), true);
    assert.equal(recipientAllowed('merchant.near', list), true);
    assert.equal(recipientAllowed('Merchant.near', list), false);
    assert.equal(recipientAllowed('0x000000000000000000000000000000000000dEaD', list), false);
});
