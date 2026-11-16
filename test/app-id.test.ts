/**
 * App ID format. The fixed vector here is also checked by the dashboard
 * (uniport-landing), which creates IDs with the same secret.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appIdFromRandom, generateAppId, looksLikeAppId, verifyAppId } from '../src/app-id.js';

const SECRET = 'test-secret-not-used-anywhere';
const VECTOR_RANDOM = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
export const VECTOR_ID = 'app_000SYW7RiJxkEgOGxsWbE4';

test('the shared vector encodes as expected', async () => {
    assert.equal(await appIdFromRandom(VECTOR_RANDOM, SECRET), VECTOR_ID);
    assert.equal(await verifyAppId(VECTOR_ID, SECRET), true);
});

test('generated IDs have the right shape and verify', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
        const id = await generateAppId(SECRET);
        assert.match(id, /^app_[0-9A-Za-z]{22}$/);
        assert.equal(looksLikeAppId(id), true);
        assert.equal(await verifyAppId(id, SECRET), true);
        seen.add(id);
    }
    assert.equal(seen.size, 200);
});

test('an ID made with another secret does not verify', async () => {
    const id = await generateAppId('another-secret');
    assert.equal(await verifyAppId(id, SECRET), false);
});

test('changing any character breaks the ID', async () => {
    const id = await generateAppId(SECRET);
    for (let i = 4; i < id.length; i++) {
        const swapped = id[i] === 'a' ? 'b' : 'a';
        const tampered = id.slice(0, i) + swapped + id.slice(i + 1);
        assert.equal(await verifyAppId(tampered, SECRET), false, `position ${i}`);
    }
});

test('malformed values are rejected, not thrown', async () => {
    const bad = [
        '',
        'app_',
        'app_short',
        'APP_0000jMqHbkhtP5Oyh3AiXR',
        'sk_live_0000jMqHbkhtP5Oyh3A',
        'app_0000jMqHbkhtP5Oyh3AiX!',
        'app_000SYW7RiJxkEgOGxsWbE4x',
        // 22 characters, but a number too large for 16 bytes.
        'app_zzzzzzzzzzzzzzzzzzzzzz',
        ' app_000SYW7RiJxkEgOGxsWbE4',
    ];
    for (const value of bad) assert.equal(await verifyAppId(value, SECRET), false, value);
});
