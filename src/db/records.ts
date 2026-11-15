/**
 * Records quotes and payment status changes in Postgres.
 *
 * Every function here is fire-and-forget: it returns immediately and never
 * throws, so a slow or unavailable database cannot delay or fail a request.
 */

import { runInBackground } from './background.js';

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
    /** When the status was read from 1Click. Defaults to now. */
    observedAt?: Date;
}

/**
 * What this Worker instance last wrote for each deposit. Clients poll the
 * status every few seconds and it rarely changes, so an observation identical
 * to the last one written is skipped without touching the database. It is
 * only a shortcut: another instance, or this one after a restart, goes to the
 * database, where the statements below make repeats harmless.
 */
const lastRecorded = new Map<string, string>();
const MAX_REMEMBERED = 500;

function json(value: unknown): string | null {
    return value === undefined ? null : JSON.stringify(value);
}

/** Saves a live quote. A repeat of the same deposit address and memo is ignored. */
export function recordQuote(quote: QuoteRecord): void {
    runInBackground([
        {
            label: 'quote',
            text: `INSERT INTO quotes (
            correlation_id, deposit_address, deposit_memo, swap_type,
            origin_asset, destination_asset, amount, amount_in, amount_out,
            min_amount_out, amount_out_usd, recipient, refund_to, referral, deadline
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        ON CONFLICT (deposit_address, deposit_memo) DO NOTHING`,
            values: [
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
        },
    ]);
}

/**
 * Records a status seen for a deposit. Clients poll, so an event row is only
 * written when the status differs from the last one recorded; the quote row
 * always carries the latest status and transaction hashes.
 *
 * Writes run in the background and can reach the database out of order, so
 * each carries the time the status was observed. An observation older than
 * one already recorded is dropped rather than overwriting it.
 */
export function recordStatus(seen: StatusRecord): void {
    const memo = seen.depositMemo ?? '';
    const originTxHashes = json(seen.originTxHashes);
    const destinationTxHashes = json(seen.destinationTxHashes);
    const observedAt = seen.observedAt ?? new Date();

    const key = `${seen.depositAddress}|${memo}`;
    const fingerprint = `${seen.status}|${originTxHashes}|${destinationTxHashes}`;
    if (lastRecorded.get(key) === fingerprint) return;

    // Remembered straight away, so polls arriving while this write is still
    // running do not each start their own; forgotten again if it fails.
    lastRecorded.delete(key);
    lastRecorded.set(key, fingerprint);
    for (const oldest of lastRecorded.keys()) {
        if (lastRecorded.size <= MAX_REMEMBERED) break;
        lastRecorded.delete(oldest);
    }
    const forgetIfFailed = (applied: boolean) => {
        if (!applied && lastRecorded.get(key) === fingerprint) lastRecorded.delete(key);
    };

    // One call, so the statements run in this order in one transaction.
    runInBackground([
        {
            // Writes for the same deposit from different Worker instances wait
            // for each other, so two cannot both decide the status is new.
            label: 'status lock',
            text: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
            values: [key],
        },
        {
            label: 'status event',
            text: `INSERT INTO quote_status_events (
            deposit_address, deposit_memo, status, correlation_id,
            origin_tx_hashes, destination_tx_hashes, observed_at
        )
        SELECT $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::timestamptz
        WHERE NOT EXISTS (
            SELECT 1 FROM quote_status_events
            WHERE deposit_address = $1 AND deposit_memo = $2
              AND observed_at > $7::timestamptz
        )
        AND $3 IS DISTINCT FROM (
            SELECT status FROM quote_status_events
            WHERE deposit_address = $1 AND deposit_memo = $2
            ORDER BY observed_at DESC, id DESC LIMIT 1
        )`,
            values: [
            seen.depositAddress,
            memo,
            seen.status,
            seen.correlationId ?? null,
            originTxHashes,
            destinationTxHashes,
            observedAt,
            ],
        },
        {
            label: 'quote status',
            text: `UPDATE quotes SET
            status_updated_at = CASE
                WHEN status IS DISTINCT FROM $3 THEN $6::timestamptz ELSE status_updated_at
            END,
            status = $3,
            status_observed_at = $6::timestamptz,
            origin_tx_hashes = COALESCE($4::jsonb, origin_tx_hashes),
            destination_tx_hashes = COALESCE($5::jsonb, destination_tx_hashes)
        WHERE deposit_address = $1 AND deposit_memo = $2
          AND (status_observed_at IS NULL OR status_observed_at <= $6::timestamptz)
          AND (status IS DISTINCT FROM $3
               OR origin_tx_hashes IS DISTINCT FROM COALESCE($4::jsonb, origin_tx_hashes)
               OR destination_tx_hashes IS DISTINCT FROM COALESCE($5::jsonb, destination_tx_hashes))`,
            values: [
            seen.depositAddress,
            memo,
            seen.status,
            originTxHashes,
            destinationTxHashes,
            observedAt,
            ],
        },
    ], forgetIfFailed);
}
