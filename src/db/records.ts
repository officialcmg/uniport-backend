/**
 * Records quotes and payment status changes in Postgres.
 *
 * Every function here is fire-and-forget: it returns immediately and never
 * throws, so a slow or unavailable database cannot delay or fail a request.
 */

import { getPool } from './pool.js';

export interface QuoteRecord {
    correlationId?: string;
    depositAddress: string;
    depositMemo?: string;
    swapType: string;
    originAsset: string;
    destinationAsset: string;
    amount: string;
    amountIn?: string;
    amountOut?: string;
    minAmountOut?: string;
    amountOutUsd?: string;
    recipient: string;
    refundTo: string;
    referral?: string;
    deadline?: string;
}

export interface StatusRecord {
    depositAddress: string;
    depositMemo?: string;
    status: string;
    correlationId?: string;
    originTxHashes?: string[];
    destinationTxHashes?: string[];
}

function run(label: string, text: string, values: unknown[]): void {
    const pool = getPool();
    if (!pool) return;
    pool.query(text, values).catch((err: Error) => {
        console.error(`Could not record ${label}:`, err.message);
    });
}

function json(value: unknown): string | null {
    return value === undefined ? null : JSON.stringify(value);
}

/** Saves a live quote. A repeat of the same deposit address and memo is ignored. */
export function recordQuote(quote: QuoteRecord): void {
    run(
        'quote',
        `INSERT INTO quotes (
            correlation_id, deposit_address, deposit_memo, swap_type,
            origin_asset, destination_asset, amount, amount_in, amount_out,
            min_amount_out, amount_out_usd, recipient, refund_to, referral, deadline
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        ON CONFLICT (deposit_address, deposit_memo) DO NOTHING`,
        [
            quote.correlationId ?? null,
            quote.depositAddress,
            quote.depositMemo ?? '',
            quote.swapType,
            quote.originAsset,
            quote.destinationAsset,
            quote.amount,
            quote.amountIn ?? null,
            quote.amountOut ?? null,
            quote.minAmountOut ?? null,
            quote.amountOutUsd ?? null,
            quote.recipient,
            quote.refundTo,
            quote.referral ?? null,
            quote.deadline ?? null,
        ],
    );
}

/**
 * Records a status seen for a deposit. Clients poll, so an event row is only
 * written when the status differs from the last one recorded; the quote row
 * always carries the latest status and transaction hashes.
 */
export function recordStatus(seen: StatusRecord): void {
    const memo = seen.depositMemo ?? '';
    const originTxHashes = json(seen.originTxHashes);
    const destinationTxHashes = json(seen.destinationTxHashes);

    run(
        'status event',
        `INSERT INTO quote_status_events (
            deposit_address, deposit_memo, status, correlation_id,
            origin_tx_hashes, destination_tx_hashes
        )
        SELECT $1, $2, $3, $4, $5::jsonb, $6::jsonb
        WHERE $3 IS DISTINCT FROM (
            SELECT status FROM quote_status_events
            WHERE deposit_address = $1 AND deposit_memo = $2
            ORDER BY id DESC LIMIT 1
        )`,
        [
            seen.depositAddress,
            memo,
            seen.status,
            seen.correlationId ?? null,
            originTxHashes,
            destinationTxHashes,
        ],
    );

    run(
        'quote status',
        `UPDATE quotes SET
            status_updated_at = CASE
                WHEN status IS DISTINCT FROM $3 THEN now() ELSE status_updated_at
            END,
            status = $3,
            origin_tx_hashes = COALESCE($4::jsonb, origin_tx_hashes),
            destination_tx_hashes = COALESCE($5::jsonb, destination_tx_hashes)
        WHERE deposit_address = $1 AND deposit_memo = $2
          AND (status IS DISTINCT FROM $3
               OR origin_tx_hashes IS DISTINCT FROM COALESCE($4::jsonb, origin_tx_hashes)
               OR destination_tx_hashes IS DISTINCT FROM COALESCE($5::jsonb, destination_tx_hashes))`,
        [seen.depositAddress, memo, seen.status, originTxHashes, destinationTxHashes],
    );
}
