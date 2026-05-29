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
  "received",      // we have the booking from the originator
  "routing",       // routing engine is selecting a partner
  "no_match",      // no eligible partner — failed back to originator
  "pushed",        // sent to receiver, awaiting confirmation
  "accepted",
  "driver_assigned",
  "en_route",
  "on_board",
  "completed",
  "cancelled",
  "failed",
  "paused",        // held by kill switch
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
  // freeform billing notes — captured during negotiation
  billingNotes: text("billing_notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  statusIdx: index("partners_status_idx").on(t.status),
  kindIdx: index("partners_kind_idx").on(t.kind),
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
}));

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
