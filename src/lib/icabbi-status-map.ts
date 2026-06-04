/**
 * Translate iCabbi booking status codes into our internal `transit_status` enum.
 *
 * Real iCabbi statuses observed in production payloads:
 *
 *   NEW             — booking just created, not yet dispatched
 *   DISPATCHED      — sent to drivers / acceptance pool
 *   ASSIGNED        — driver allocated
 *   ACCEPTED        — driver has accepted (subset of ASSIGNED in some tenants)
 *   ARRIVED         — driver at pickup
 *   POB             — passenger on board ("pickup on board")
 *   ON_WAY          — synonym for en route (some tenants emit this)
 *   COMPLETED       — trip finished
 *   CANCELLED       — booking cancelled
 *   NO_SHOW         — passenger didn't show
 *   FAILED          — trip could not be completed
 *   TRANSFERRED     — booking handed off to a partnership tenant (demand-side
 *                     view only — we don't store this for our recipients)
 *
 * `networking_status.status` is a separate event stream that mirrors the
 * cross-tenant trip's lifecycle. Same code values; route through the same map.
 *
 * If an iCabbi status arrives that isn't mapped here, we return `null` and
 * the adapter logs a warning. Better than silently coercing to a wrong state.
 */

import type { transitStatusEnum } from "@/db/schema";

type InternalStatus = (typeof transitStatusEnum.enumValues)[number];

const MAP: Record<string, InternalStatus> = {
  // Pre-acceptance
  NEW: "received",
  DISPATCHED: "pushed",

  // Acceptance + assignment
  ASSIGNED: "driver_assigned",
  ACCEPTED: "accepted",

  // Mid-trip
  ARRIVED: "driver_arrived",
  ON_WAY: "en_route",
  EN_ROUTE: "en_route",
  POB: "on_board",
  ON_BOARD: "on_board",

  // Terminal
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  CANCELED: "cancelled", // US spelling, just in case
  NO_SHOW: "cancelled",
  NOSHOW: "cancelled",
  FAILED: "failed",
};

/**
 * Statuses we deliberately don't map — they're meta-states from iCabbi's
 * point of view that don't correspond to a trip lifecycle change on our side.
 */
const IGNORED = new Set<string>(["TRANSFERRED", "QUEUED", "PROCESSED"]);

/**
 * Map an iCabbi status code to our internal `transit_status`.
 * Returns null for unmapped codes. Adapter should log and not call
 * forwardStatusUpdate when null.
 */
export function mapICabbiStatus(raw: string | null | undefined): InternalStatus | null {
  if (!raw) return null;
  const code = raw.trim().toUpperCase();
  if (IGNORED.has(code)) return null;
  return MAP[code] ?? null;
}

/** True if the iCabbi status is one we intentionally ignore (vs unrecognised). */
export function isIgnoredICabbiStatus(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return IGNORED.has(raw.trim().toUpperCase());
}
