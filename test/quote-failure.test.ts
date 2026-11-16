import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyQuoteFailure } from '../src/api/quote-failure.js';

// The messages are ones 1Click returned on 16 Nov 2026.
const body = (message: unknown) => ({ message, correlationId: 'x', path: '/v0/quote' });

test('no liquidity', () => {
    assert.equal(classifyQuoteFailure(body('No liquidity available')).code, 'NO_LIQUIDITY');
});

test('bridge minimum carries the amount', () => {
    const failure = classifyQuoteFailure(body('Amount is too low for bridge, try at least 8300'));
    assert.equal(failure.code, 'AMOUNT_TOO_LOW');
    assert.deepEqual(failure.minimum, { amount: '8300' });
});

test('dollar minimum carries the dollars', () => {
    const failure = classifyQuoteFailure(body('Temporary swap limits: minimum swap amount is $100'));
    assert.equal(failure.code, 'AMOUNT_TOO_LOW');
    assert.deepEqual(failure.minimum, { usd: '100' });
    assert.deepEqual(classifyQuoteFailure(body('Temporary swap limits: minimum swap amount is $1,000')).minimum, { usd: '1000' });
});

test('addresses', () => {
    assert.equal(classifyQuoteFailure(body('recipient is not valid')).code, 'INVALID_RECIPIENT');
    assert.equal(classifyQuoteFailure(body('refundTo is not valid')).code, 'INVALID_REFUND_ADDRESS');
});

test('a missing Stellar trustline', () => {
    assert.equal(classifyQuoteFailure(body('Recipient has no trustline for this asset')).code, 'RECIPIENT_NOT_READY');
});

test('a list of messages is read as one', () => {
    assert.equal(classifyQuoteFailure(body(['amount must be a number', 'recipient is not valid'])).code, 'INVALID_RECIPIENT');
});

test('anything else stays QUOTE_FAILED', () => {
    for (const value of [body('Something new'), body(undefined), null, 'text', {}]) {
        const failure = classifyQuoteFailure(value);
        assert.equal(failure.code, 'QUOTE_FAILED');
        assert.equal(failure.minimum, undefined);
    }
});
