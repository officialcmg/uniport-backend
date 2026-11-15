-- Live quotes handed out by POST /api/quote, and the status changes
-- GET /api/status has seen for them.

CREATE TABLE quotes (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    correlation_id        TEXT,
    deposit_address       TEXT NOT NULL,
    -- '' when the quote has no memo, so (address, memo) can be a plain unique key.
    deposit_memo          TEXT NOT NULL DEFAULT '',
    swap_type             TEXT NOT NULL,
    origin_asset          TEXT NOT NULL,
    destination_asset     TEXT NOT NULL,
    -- Amounts are base-unit integers that can exceed BIGINT; kept exactly as 1Click sent them.
    amount                TEXT NOT NULL,
    amount_in             TEXT,
    amount_out            TEXT,
    min_amount_out        TEXT,
    amount_out_usd        TEXT,
    recipient             TEXT NOT NULL,
    refund_to             TEXT NOT NULL,
    referral              TEXT,
    deadline              TIMESTAMPTZ,
    -- Latest status seen by /api/status; NULL until someone polls.
    status                TEXT,
    status_updated_at     TIMESTAMPTZ,
    origin_tx_hashes      JSONB,
    destination_tx_hashes JSONB,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (deposit_address, deposit_memo)
);

CREATE INDEX quotes_correlation_id_idx ON quotes (correlation_id);
CREATE INDEX quotes_created_at_idx ON quotes (created_at);

-- One row per status change. Not tied to quotes by a foreign key: a status
-- can be polled for a deposit address whose quote was never saved.
CREATE TABLE quote_status_events (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    deposit_address       TEXT NOT NULL,
    deposit_memo          TEXT NOT NULL DEFAULT '',
    status                TEXT NOT NULL,
    correlation_id        TEXT,
    origin_tx_hashes      JSONB,
    destination_tx_hashes JSONB,
    observed_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX quote_status_events_deposit_idx
    ON quote_status_events (deposit_address, deposit_memo, id DESC);
