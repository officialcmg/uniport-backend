-- Developer apps and their public App IDs, and which app each quote belongs to.

CREATE TABLE apps (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The dashboard user who owns the app (neon_auth user id), or 'system'.
    owner_user_id       TEXT NOT NULL,
    name                TEXT NOT NULL,
    -- active | suspended | deleted
    status              TEXT NOT NULL DEFAULT 'active',
    -- Websites allowed to use the app's ID, e.g. https://shop.example.com or
    -- https://*.example.com.
    allowed_origins     TEXT[] NOT NULL DEFAULT '{}',
    allow_localhost     BOOLEAN NOT NULL DEFAULT true,
    -- When set, the app may only take payments to these addresses.
    recipient_allowlist TEXT[],
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX apps_owner_idx ON apps (owner_user_id);

-- The public IDs developers put in their code. An app can have several, so an
-- ID can be replaced without losing the app's settings or history.
CREATE TABLE app_ids (
    id          TEXT PRIMARY KEY,
    app_id      UUID NOT NULL REFERENCES apps (id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    disabled_at TIMESTAMPTZ
);

CREATE INDEX app_ids_app_idx ON app_ids (app_id);

ALTER TABLE quotes
    -- The app the quote was made for; NULL for anonymous quotes.
    ADD COLUMN app_id UUID REFERENCES apps (id),
    -- The App ID the caller sent, kept even when it could not be checked.
    ADD COLUMN app_public_id TEXT,
    -- The website the quote was requested from.
    ADD COLUMN origin TEXT;

CREATE INDEX quotes_app_created_idx ON quotes (app_id, created_at DESC);
