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
  ADD COLUMN IF NOT EXISTS metrics_updated_at  timestamp;

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
