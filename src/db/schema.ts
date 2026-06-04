import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  real,
  jsonb,
  boolean,
  pgEnum,
  index,
  unique,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------- enums ----------

export const partnerKindEnum = pgEnum("partner_kind", [
  "icabbi_fleet",
  "external_aggregator", // CMAC, FreeNow, Uber, etc.
  "external_corporate",  // CMAC-shaped corporate booking
]);

export const participationModeEnum = pgEnum("participation_mode", [
  "send_only",
  "receive_only",
  "send_and_receive",
  "inactive",
]);

export const partnerStatusEnum = pgEnum("partner_status", [
  "pending_approval",
  "active",
  "warning",
  "suspended",
]);

export const ruleEnum = pgEnum("rule", ["allow", "block"]);

export const transitStatusEnum = pgEnum("transit_status", [
  "received",       // we have the booking from the originator
  "routing",        // routing engine is selecting a partner
  "no_match",       // no eligible partner — failed back to originator
  "pushed",         // sent to receiver, awaiting confirmation
  "accepted",
  "driver_assigned",
  "driver_arrived", // driver at pickup location (iCabbi ARRIVED event)
  "en_route",
  "on_board",
  "completed",
  "cancelled",
  "failed",
  "paused",         // held by kill switch
  "error_auth",
  "error_other",
]);

export const eventActorEnum = pgEnum("event_actor", [
  "system",
  "admin_user",
  "api_key",
  "partner_webhook",
]);

// ---------- partners ----------

export const partners = pgTable("partners", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: partnerKindEnum("kind").notNull(),
  name: text("name").notNull(),
  legalName: text("legal_name"),
  contactEmail: text("contact_email"),
  participationMode: participationModeEnum("participation_mode")
    .notNull()
    .default("inactive"),
  status: partnerStatusEnum("status").notNull().default("pending_approval"),
  // Why the partner is in their current status. For auto-suspend, holds a
  // machine-readable reason like 'acceptance_rate_0.37_over_67_pushed_7d'.
  // For manual status changes, optional freeform note from the admin.
  // Null on pristine partners that have only ever had their default status.
  statusReason: text("status_reason"),
  // After a human manually re-activates a partner (e.g. unsuspending a fleet
  // that auto-suspend caught), set this to now + 7 days. enforceReliability-
  // Thresholds skips partners whose cooldown is still active, giving fresh
  // metrics time to roll in before the engine considers them again. Prevents
  // immediate re-suspend on stale data.
  autoSuspendCooldownUntil: timestamp("auto_suspend_cooldown_until"),
  // operational rules — see notes below
  operatingRegions: jsonb("operating_regions").$type<string[]>().notNull().default([]),
  serviceZones: jsonb("service_zones").$type<string[]>().notNull().default([]),
  vehicleTypes: jsonb("vehicle_types").$type<string[]>().notNull().default([]),
  bookingTypes: jsonb("booking_types").$type<("asap" | "prebook")[]>().notNull().default(["asap"]),
  // Geographic coverage — used by the routing engine to filter candidates
  // by distance from pickup. centroidLat/Lng = the partner's typical
  // "centre of operations" (depot or city centre); serviceRadiusKm = how
  // far they'll send drivers. Null = no geo restriction (legacy partners).
  centroidLat: real("centroid_lat"),
  centroidLng: real("centroid_lng"),
  serviceRadiusKm: integer("service_radius_km"),
  // credentials for outbound calls (encrypted JSON blob; shape depends on adapter)
  credentials: jsonb("credentials").$type<Record<string, unknown>>(),
  // partner-specific adapter id — must match a registered adapter key
  adapterKey: text("adapter_key").notNull(),
  // partner-controlled webhook URL where we send status updates if they want push
  webhookUrl: text("webhook_url"),
  // Per-fleet PII config. When true, driver name / mobile / vehicle reg flow
  // back to the demand fleet on status events. Default false — most fleets
  // don't need it. Opt-in for corporate / VIP / regulated accounts.
  driverDetailsRequired: boolean("driver_details_required").notNull().default(false),
  // ---------- self-service signup ----------
  // Populated when a partner applies via /signup. Cleared on no rule —
  // remains alongside other fields after approval as the application record.
  // applicantEmail becomes the first fleet_admin user on the partner when
  // the application is approved.
  applicantEmail: text("applicant_email"),
  applicationNotes: text("application_notes"),
  // ---------- reliability metrics (recomputed periodically) ----------
  // All metrics are over a rolling 7-day window.
  // Null means "not yet computed" — routing treats these as neutral (no penalty).
  //
  // acceptanceRate: fraction of bookings pushed to this fleet that they
  //   advanced past 'pushed' within the accept window.
  // completionRate: fraction of accepted bookings that reached 'completed'.
  // autoRerouteRate: fraction of bookings pushed where the accept window
  //   expired and we re-routed away from this fleet.
  // medianAcceptanceMs: milliseconds from 'pushed' to first onward state, p50.
  // totalPushed7d: denominator for the rates above. Below 5 → metrics are
  //   too small a sample to be statistically meaningful; routing ignores
  //   the reliability term until we have enough data.
  acceptanceRate: real("acceptance_rate"),
  completionRate: real("completion_rate"),
  autoRerouteRate: real("auto_reroute_rate"),
  medianAcceptanceMs: integer("median_acceptance_ms"),
  totalPushed7d: integer("total_pushed_7d"),
  metricsUpdatedAt: timestamp("metrics_updated_at"),
  // freeform billing notes — captured during negotiation
  billingNotes: text("billing_notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  statusIdx: index("partners_status_idx").on(t.status),
  kindIdx: index("partners_kind_idx").on(t.kind),
  // P1-E5: routing engine filters candidates by participation_mode IN
  // ('receive_only', 'send_and_receive'). At ~100 partners today this is a
  // seqscan-and-discard; matters at 1k+.
  participationModeIdx: index("partners_participation_mode_idx").on(t.participationMode),
}));

// ---------- bilateral rules (the allow/block matrix) ----------
// One row per (originator, recipient). Mutual allow required to route.
// rule = "allow" means originator is willing to *send* to recipient.
// To complete a route, both rows must be "allow":
//   (A, B, allow) AND (B, A, allow)

export const partnerRules = pgTable("partner_rules", {
  originatorId: uuid("originator_id").notNull().references(() => partners.id, { onDelete: "cascade" }),
  recipientId: uuid("recipient_id").notNull().references(() => partners.id, { onDelete: "cascade" }),
  rule: ruleEnum("rule").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.originatorId, t.recipientId] }),
  recipientIdx: index("partner_rules_recipient_idx").on(t.recipientId),
}));

// ---------- fee configuration (per partner pair OR per partner) ----------
// Fees travel with the booking. The fee_snapshot on a transit is built by
// resolving this table at routing time. Snapshot is non-retroactive.

export const feeConfigs = pgTable("fee_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  // scope = "partner" applies to all transits where this partner is the recipient
  // scope = "pair" applies to a specific originator->recipient pair
  scope: text("scope", { enum: ["partner", "pair"] }).notNull(),
  originatorId: uuid("originator_id").references(() => partners.id, { onDelete: "cascade" }),
  recipientId: uuid("recipient_id").notNull().references(() => partners.id, { onDelete: "cascade" }),

  // network-level fees (iCabbi <-> fleet)
  sendFeePence: integer("send_fee_pence").notNull().default(20),     // originator earns
  receiveFeePence: integer("receive_fee_pence").notNull().default(40), // recipient is charged

  // trip-level fees (passenger-facing, per the King County WAV / Blue Line requirement)
  techFeePence: integer("tech_fee_pence").notNull().default(0),
  techFeeBps: integer("tech_fee_bps").notNull().default(0), // basis points of fare
  bookingFeePence: integer("booking_fee_pence").notNull().default(0),
  adminFeePence: integer("admin_fee_pence").notNull().default(0),
  adminFeeBps: integer("admin_fee_bps").notNull().default(0),

  // apply rules
  applyToAsap: boolean("apply_to_asap").notNull().default(true),
  applyToPrebook: boolean("apply_to_prebook").notNull().default(true),
  applyToChannels: jsonb("apply_to_channels").$type<("app" | "web" | "phone" | "api")[]>()
    .notNull()
    .default(["app", "web", "phone", "api"]),

  effectiveFrom: timestamp("effective_from").notNull().defaultNow(),
  effectiveTo: timestamp("effective_to"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdBy: text("created_by"), // user id or "system"
}, (t) => ({
  recipientIdx: index("fee_configs_recipient_idx").on(t.recipientId),
  pairIdx: index("fee_configs_pair_idx").on(t.originatorId, t.recipientId),
}));

// ---------- booking transits (one row per network journey of a booking) ----------

export const transits = pgTable("transits", {
  id: uuid("id").primaryKey().defaultRandom(),

  originatorPartnerId: uuid("originator_partner_id").notNull().references(() => partners.id),
  // originator's id for this booking in their own system (idempotency)
  originatorBookingExternalId: text("originator_booking_external_id").notNull(),

  recipientPartnerId: uuid("recipient_partner_id").references(() => partners.id),
  // once we've pushed, the receiver's id for the booking on their side
  recipientBookingExternalId: text("recipient_booking_external_id"),

  // iCabbi cross-tenant partnership linkage. Populated when Position #2 is in
  // play — recipient is on a different iCabbi tenant and the coid mechanism
  // carries the booking. Allows us to reconcile a booking on both sides via
  // iCabbi's native partnership protocol. Null for non-iCabbi recipients or
  // intra-tenant routing.
  partnershipCoid: text("partnership_coid"),
  recipientClientId: text("recipient_client_id"),       // iCabbi tenant id (e.g. "30092")
  recipientServerName: text("recipient_server_name"),   // iCabbi cluster (e.g. "bounds")
  recipientSiteId: text("recipient_site_id"),           // sub-site within recipient tenant
  // Passenger tracking URL from the recipient adapter — when present, we can
  // pass this through to the originator so the demand-side passenger keeps
  // their existing tracking experience.
  trackMyTaxiLink: text("track_my_taxi_link"),

  // Acceptance window. Set when status moves to 'pushed' (initial route or
  // re-route) — recipient must move past 'pushed' before this timestamp or
  // the recheckStaleAcceptances() job will reroute to the next candidate.
  // Cleared by forwardStatusUpdate once the booking advances. NULL on
  // bookings that never reached 'pushed' (no_match, paused, etc.) and on
  // bookings that successfully advanced.
  acceptDeadline: timestamp("accept_deadline"),
  // How many times this booking has been auto-rerouted. 0 = first push.
  rerouteCount: integer("reroute_count").notNull().default(0),

  // ---------- post-completion reconciliation ----------
  // After a booking reaches 'completed' we ask both adapters what they
  // actually billed for the trip. We compare to feeSnapshot to detect
  // drift — useful when partners use different tariff IDs, surcharges, or
  // processing fees. Real iCabbi data exposed this: the demand side had a
  // £10 processing_fee that didn't appear on the supply side. We flag drift
  // > 5% for super-admin review.
  reconciledAt: timestamp("reconciled_at"),
  reconciledOriginatorTotalPence: integer("reconciled_originator_total_pence"),
  reconciledRecipientTotalPence: integer("reconciled_recipient_total_pence"),
  reconciledDriftPence: integer("reconciled_drift_pence"),
  reconciledFlagged: boolean("reconciled_flagged").notNull().default(false),

  status: transitStatusEnum("status").notNull().default("received"),

  // full inbound payload from the originator (denormalised on purpose for audit)
  bookingPayload: jsonb("booking_payload").$type<Record<string, unknown>>().notNull(),

  // fee snapshot captured at routing time — non-retroactive
  feeSnapshot: jsonb("fee_snapshot").$type<FeeSnapshot | null>(),

  // why-this-recipient explanation for the audit trail
  routingTrace: jsonb("routing_trace").$type<Record<string, unknown>>(),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  originatorIdempotency: unique("transits_originator_idempotency").on(
    t.originatorPartnerId,
    t.originatorBookingExternalId,
  ),
  statusIdx: index("transits_status_idx").on(t.status),
  recipientIdx: index("transits_recipient_idx").on(t.recipientPartnerId),
  // P1-E5 indexes ----------------------------------------------------------
  // /bookings ORDER BY created_at DESC LIMIT 200 + dashboard recent + 14-day
  // distribution sparkline all want a created_at sort. desc() matches the
  // hot access pattern.
  createdAtIdx: index("transits_created_at_idx").on(t.createdAt.desc()),
  // Fleet-scoped dashboard + partner-detail "your bookings" view.
  originatorIdx: index("transits_originator_idx").on(t.originatorPartnerId),
  // Reliability recompute outer filter (recipient + 7d window) and partner-
  // detail "active to me" feed. Composite >> two singles for this access
  // pattern; the existing recipientIdx stays for full-history per-recipient
  // queries that don't use a time bound.
  recipientCreatedIdx: index("transits_recipient_created_idx").on(
    t.recipientPartnerId,
    t.createdAt.desc(),
  ),
  // recheckStaleAcceptances() runs every 60s scanning for expired accept
  // deadlines. Partial keeps this index 10s–100s of rows even at scale, vs.
  // the millions a full status-based scan would touch over time.
  acceptDeadlineIdx: index("transits_accept_deadline_idx")
    .on(t.acceptDeadline)
    .where(sql`status = 'pushed' AND accept_deadline IS NOT NULL`),
  // Dashboard banner check — typically 0–10 rows. Partial keeps it microscopic.
  reconciledFlaggedIdx: index("transits_reconciled_flagged_idx")
    .on(t.id)
    .where(sql`reconciled_flagged = true`),
}));

// ---------- events (append-only timeline per transit) ----------

export const transitEvents = pgTable("transit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  transitId: uuid("transit_id").notNull().references(() => transits.id, { onDelete: "cascade" }),
  status: transitStatusEnum("status").notNull(),
  detail: jsonb("detail").$type<Record<string, unknown>>(),
  actor: eventActorEnum("actor").notNull(),
  actorRef: text("actor_ref"), // user id, api key id, partner id
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  transitIdx: index("transit_events_transit_idx").on(t.transitId),
  createdAtIdx: index("transit_events_created_at_idx").on(t.createdAt),
  // P1-E5: bookings page batches driver-event lookup over many transit ids
  // and takes the latest per transit. The composite ranges scan a partition
  // of the table per transit, sorted DESC.
  transitCreatedIdx: index("transit_events_transit_created_idx").on(
    t.transitId,
    t.createdAt.desc(),
  ),
}));

// ---------- audit log (everything admin-y) ----------

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  category: text("category", { enum: ["booking", "admin", "credential", "permission", "fee"] }).notNull(),
  actor: eventActorEnum("actor").notNull(),
  actorRef: text("actor_ref"),
  action: text("action").notNull(), // e.g. "partner.suspended", "fee.updated", "kill_switch.on"
  subjectType: text("subject_type"),
  subjectId: text("subject_id"),
  before: jsonb("before"),
  after: jsonb("after"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  categoryIdx: index("audit_log_category_idx").on(t.category),
  createdAtIdx: index("audit_log_created_at_idx").on(t.createdAt),
  // P1-E5: dashboard counts "partner.auto_suspended" entries in last 7d.
  // Composite supports the action-then-time access pattern in one scan.
  actionIdx: index("audit_log_action_idx").on(t.action, t.createdAt.desc()),
}));

// ---------- synthetic test runs (P1-O4) ----------
//
// Every hour the synthetic cron fires a test booking through the routing
// engine. Results land here so the dashboard can show "last synthetic: 4
// min ago — pushed (1.2s)" and we can alert on a failing trend.
//
// Outcome values mirror the routing outcomes plus 'timeout' for cases where
// the cron itself didn't finish (>30s expected to indicate a stuck system).
//
// Synthetic transits are tagged via bookingPayload.raw.synthetic=true and
// filtered out of default /bookings and /distribution views — see the
// `synthetic=true` query-param toggle.

export const syntheticTestRuns = pgTable(
  "synthetic_test_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ranAt: timestamp("ran_at").notNull().defaultNow(),
    outcome: text("outcome").notNull(), // 'pushed' | 'no_match' | 'paused' | 'error' | 'timeout' | 'skipped_no_pair'
    transitId: uuid("transit_id"),
    originatorPartnerId: uuid("originator_partner_id"),
    elapsedMs: integer("elapsed_ms").notNull(),
    errorMessage: text("error_message"),
  },
  (t) => ({
    ranAtIdx: index("synthetic_test_runs_ran_at_idx").on(t.ranAt),
  }),
);

// ---------- rate-limit buckets ----------
//
// Fixed-window counter, 1 row per (key, window_start). Each request that
// matches a key:
//   - INSERT ... ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
//   - if count > limit → 429
//
// Window granularity is per-call (a per-partner ingest limit might use a
// 60s window, a magic-link limit a 3600s window). Rows older than 24h are
// fine to garbage-collect via a periodic DELETE.
//
// This is the "pilot scale" implementation — fine for low hundreds of
// requests/minute, predictable on Neon's pooled connections. When traffic
// outgrows it, swap to Upstash Redis using the same checkRateLimit
// signature in lib/rate-limit.ts.

export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.key, t.windowStart] }),
    windowIdx: index("rate_limit_window_idx").on(t.windowStart),
  }),
);

// ---------- webhook idempotency ----------

export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: text("source").notNull(), // "icabbi" | "cmac" | partner adapter key
  sourceEventId: text("source_event_id").notNull(),
  receivedAt: timestamp("received_at").notNull().defaultNow(),
  payload: jsonb("payload").notNull(),
  // Set after the route handler finishes processing the delivery.
  //   applied             — status update was written to a transit
  //   routed              — kind:create produced a routed transit
  //   orphan              — no matching transit for the recipient booking id
  //   duplicate           — idempotency replay (won't reach this codepath in practice — insert fails first)
  //   ack_unhandled       — known event type we deliberately ignore (FinalFareReleased, DriverPositionChanged)
  //   signature_invalid   — HMAC verification failed (route returns 401)
  //   error               — uncaught exception during processing
  outcome: text("outcome"),
  processedAt: timestamp("processed_at"),
}, (t) => ({
  uniq: unique("webhook_deliveries_unique").on(t.source, t.sourceEventId),
  // P1-E5: /webhooks inspector orders by received_at DESC LIMIT 100.
  receivedAtIdx: index("webhook_deliveries_received_at_idx").on(t.receivedAt.desc()),
}));

// ---------- network-level controls ----------

export const networkControls = pgTable("network_controls", {
  id: text("id").primaryKey(), // singleton row, id = "global"
  killSwitch: boolean("kill_switch").notNull().default(false),
  killSwitchReason: text("kill_switch_reason"),
  killSwitchToggledAt: timestamp("kill_switch_toggled_at"),
  killSwitchToggledBy: text("kill_switch_toggled_by"),
  // Demo mode (DISABLE_AUTH=true) ticks one transit forward in its lifecycle
  // periodically so the dashboard feels alive without manual interaction.
  // Stored here for cross-instance cooldown enforcement.
  lastDemoTickAt: timestamp("last_demo_tick_at"),
  // Last time we recomputed per-partner reliability metrics. 5-min cooldown.
  lastReliabilityComputeAt: timestamp("last_reliability_compute_at"),
  // Last time we ran the post-completion reconciliation pass. 1-hour cooldown.
  lastReconciliationRunAt: timestamp("last_reconciliation_run_at"),
});

// ---------- auth ----------

// Users with roles. The email allowlist used to live in an env var; now it's
// a DB table so the founder can invite fleet users without redeploying.
//
// Roles:
//   super_admin — sees and configures everything across the network
//   fleet_admin — sees only their partner; can edit fleet config + rules + fees
//   fleet_user  — sees only their partner; read + light configure
//
// partnerId is null for super_admin and required for the two fleet roles.

export const userRoleEnum = pgEnum("user_role", [
  "super_admin",
  "fleet_admin",
  "fleet_user",
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  role: userRoleEnum("role").notNull().default("fleet_user"),
  partnerId: uuid("partner_id").references(() => partners.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at"),
  invitedBy: text("invited_by"),
}, (t) => ({
  partnerIdx: index("users_partner_idx").on(t.partnerId),
}));

// Magic-link tokens. Single-use; 15-minute TTL. `usedAt` set on consumption.

export const magicLinks = pgTable("magic_links", {
  token: text("token").primaryKey(),
  email: text("email").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
}, (t) => ({
  emailIdx: index("magic_links_email_idx").on(t.email),
}));

// Server-side session records. Cookie is HMAC-signed `sessionId.signature`.
// 14-day TTL. Destroyed on logout.

export const authSessions = pgTable("auth_sessions", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
}, (t) => ({
  emailIdx: index("auth_sessions_email_idx").on(t.email),
}));

// ---------- shared types ----------

export type FeeSnapshot = {
  // network-level
  sendFeePence: number;
  receiveFeePence: number;
  // trip-level
  techFeePence: number;
  techFeeBps: number;
  bookingFeePence: number;
  adminFeePence: number;
  adminFeeBps: number;
  // computed totals based on the booking fare at routing time
  computedPassengerAddOnsPence: number;
  fareAtSnapshotPence: number | null;
  resolvedFromFeeConfigId: string;
};

export type Partner = typeof partners.$inferSelect;
export type NewPartner = typeof partners.$inferInsert;
export type Transit = typeof transits.$inferSelect;
export type NewTransit = typeof transits.$inferInsert;
