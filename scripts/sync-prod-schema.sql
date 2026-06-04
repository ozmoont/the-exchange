-- Idempotent schema sync for production.
--
-- All recent schema changes that drizzle-kit push tried to apply but bailed
-- on because the transit_status enum already had 'driver_arrived' added.
-- Every statement uses IF NOT EXISTS / ALTER TYPE ... ADD VALUE IF NOT EXISTS
-- (Postgres 9.6+) so this is safe to run repeatedly.
--
-- Run via:
--   psql "$DATABASE_URL" -f scripts/sync-prod-schema.sql

BEGIN;

-- ---------- transit_status enum ----------
-- driver_arrived may already exist; this won't error if so.
ALTER TYPE transit_status ADD VALUE IF NOT EXISTS 'driver_arrived';

-- ---------- partners table ----------
ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS centroid_lat        real,
  ADD COLUMN IF NOT EXISTS centroid_lng        real,
  ADD COLUMN IF NOT EXISTS service_radius_km   integer,
  ADD COLUMN IF NOT EXISTS driver_details_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS applicant_email     text,
  ADD COLUMN IF NOT EXISTS application_notes   text,
  ADD COLUMN IF NOT EXISTS status_reason       text,
  ADD COLUMN IF NOT EXISTS acceptance_rate     real,
  ADD COLUMN IF NOT EXISTS completion_rate     real,
  ADD COLUMN IF NOT EXISTS auto_reroute_rate   real,
  ADD COLUMN IF NOT EXISTS median_acceptance_ms integer,
  ADD COLUMN IF NOT EXISTS total_pushed_7d     integer,
  ADD COLUMN IF NOT EXISTS metrics_updated_at  timestamp,
  ADD COLUMN IF NOT EXISTS auto_suspend_cooldown_until timestamp;

-- ---------- transits table ----------
ALTER TABLE transits
  ADD COLUMN IF NOT EXISTS partnership_coid                text,
  ADD COLUMN IF NOT EXISTS recipient_client_id             text,
  ADD COLUMN IF NOT EXISTS recipient_server_name           text,
  ADD COLUMN IF NOT EXISTS recipient_site_id               text,
  ADD COLUMN IF NOT EXISTS track_my_taxi_link              text,
  ADD COLUMN IF NOT EXISTS accept_deadline                 timestamp,
  ADD COLUMN IF NOT EXISTS reroute_count                   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reconciled_at                   timestamp,
  ADD COLUMN IF NOT EXISTS reconciled_originator_total_pence integer,
  ADD COLUMN IF NOT EXISTS reconciled_recipient_total_pence  integer,
  ADD COLUMN IF NOT EXISTS reconciled_drift_pence            integer,
  ADD COLUMN IF NOT EXISTS reconciled_flagged              boolean NOT NULL DEFAULT false;

-- ---------- network_controls ----------
ALTER TABLE network_controls
  ADD COLUMN IF NOT EXISTS last_demo_tick_at           timestamp,
  ADD COLUMN IF NOT EXISTS last_reliability_compute_at timestamp,
  ADD COLUMN IF NOT EXISTS last_reconciliation_run_at  timestamp;

-- ---------- rate_limit_buckets (P0-4 rate limiting) ----------
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  key          text NOT NULL,
  window_start timestamp NOT NULL,
  count        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX IF NOT EXISTS rate_limit_window_idx ON rate_limit_buckets (window_start);

-- ---------- synthetic_test_runs (P1-O4 synthetic monitoring) ----------
CREATE TABLE IF NOT EXISTS synthetic_test_runs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at                   timestamp NOT NULL DEFAULT now(),
  outcome                  text NOT NULL,
  transit_id               uuid,
  originator_partner_id    uuid,
  elapsed_ms               integer NOT NULL,
  error_message            text
);
CREATE INDEX IF NOT EXISTS synthetic_test_runs_ran_at_idx ON synthetic_test_runs (ran_at);

-- ---------- P1-E5 query optimisation indexes ----------
-- See docs/specs/P1-E5-query-optimisation.md for rationale.
-- All idempotent; safe to re-run.
CREATE INDEX IF NOT EXISTS partners_participation_mode_idx
  ON partners (participation_mode);
CREATE INDEX IF NOT EXISTS transits_created_at_idx
  ON transits (created_at DESC);
CREATE INDEX IF NOT EXISTS transits_originator_idx
  ON transits (originator_partner_id);
CREATE INDEX IF NOT EXISTS transits_recipient_created_idx
  ON transits (recipient_partner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS transits_accept_deadline_idx
  ON transits (accept_deadline)
  WHERE status = 'pushed' AND accept_deadline IS NOT NULL;
CREATE INDEX IF NOT EXISTS transits_reconciled_flagged_idx
  ON transits (id)
  WHERE reconciled_flagged = true;
CREATE INDEX IF NOT EXISTS transit_events_transit_created_idx
  ON transit_events (transit_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_idx
  ON audit_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS webhook_deliveries_received_at_idx
  ON webhook_deliveries (received_at DESC);

COMMIT;

-- Confirm we have everything
SELECT 'partners new columns' AS table_name, column_name
FROM information_schema.columns
WHERE table_name = 'partners'
  AND column_name IN (
    'driver_details_required', 'applicant_email', 'application_notes',
    'status_reason', 'acceptance_rate', 'completion_rate',
    'auto_reroute_rate', 'median_acceptance_ms', 'total_pushed_7d',
    'metrics_updated_at', 'centroid_lat'
  )
ORDER BY column_name;

SELECT 'transits new columns' AS table_name, column_name
FROM information_schema.columns
WHERE table_name = 'transits'
  AND column_name IN (
    'partnership_coid', 'recipient_client_id', 'recipient_server_name',
    'recipient_site_id', 'track_my_taxi_link', 'accept_deadline',
    'reroute_count', 'reconciled_at', 'reconciled_drift_pence',
    'reconciled_flagged'
  )
ORDER BY column_name;
