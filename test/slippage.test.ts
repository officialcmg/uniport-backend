import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SLIPPAGE_BPS, STABLECOIN_SLIPPAGE_BPS, isStablecoinPair, slippageFor } from '../src/api/slippage.js';
import { STABLECOIN_ASSETS } from '../src/api/stablecoins.js';

const baseUSDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const arbUSDC = 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near';
const arbUSDT = 'nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near';
const eth = 'nep141:eth.omft.near';
const btc = 'nep141:btc.omft.near';

test('the list holds the main dollar tokens and nothing volatile', () => {
    for (const asset of [baseUSDC, arbUSDC, arbUSDT]) assert.ok(STABLECOIN_ASSETS.has(asset), asset);
    for (const asset of [eth, btc]) assert.ok(!STABLECOIN_ASSETS.has(asset), asset);
    assert.ok(STABLECOIN_ASSETS.size >= 20);
});

test('a pair is stable only when both sides are', () => {
    assert.equal(isStablecoinPair(arbUSDC, baseUSDC), true);
    assert.equal(isStablecoinPair(arbUSDT, baseUSDC), true);
    assert.equal(isStablecoinPair(eth, baseUSDC), false);
    assert.equal(isStablecoinPair(baseUSDC, btc), false);
    assert.equal(isStablecoinPair('unknown', baseUSDC), false);
});

test('stablecoin pairs get 0.3%, whatever the caller asked for above that', () => {
    assert.equal(STABLECOIN_SLIPPAGE_BPS, 30);
    assert.equal(slippageFor(arbUSDC, baseUSDC, undefined), 30);
    assert.equal(slippageFor(arbUSDC, baseUSDC, 100), 30);
    assert.equal(slippageFor(arbUSDC, baseUSDC, 300), 30);
    // A caller may ask for less.
    assert.equal(slippageFor(arbUSDC, baseUSDC, 10), 10);
    assert.equal(slippageFor(arbUSDC, baseUSDC, 0), 0);
});

test('other pairs keep 1% by default and the caller\'s own value otherwise', () => {
    assert.equal(DEFAULT_SLIPPAGE_BPS, 100);
    assert.equal(slippageFor(eth, baseUSDC, undefined), 100);
    assert.equal(slippageFor(eth, baseUSDC, 50), 50);
    assert.equal(slippageFor(baseUSDC, btc, 300), 300);
    assert.equal(slippageFor(eth, baseUSDC, 0), 0);
});
