-- When the status on a quote row was observed at 1Click. Status writes run in
-- the background and can land out of order; this lets an older observation be
-- recognised and dropped instead of overwriting a newer status.

ALTER TABLE quotes ADD COLUMN status_observed_at TIMESTAMPTZ;

UPDATE quotes SET status_observed_at = status_updated_at WHERE status IS NOT NULL;
