/**
 * iCabbi webhook event constants — single source of truth.
 *
 * The shape of iCabbi's webhook subscription API:
 *   POST {baseUrl}/eventlisteners/create
 *   body: { name, event, url, format: "json", template: "#json" }
 *
 * One POST per event. The response carries `eventlistener.id` which we
 * persist so we can later DELETE the same id when re-registering or
 * tearing down the partner. iCabbi's list endpoint returns 401 for our
 * key, so we cannot reconcile from source — we must track listener ids
 * ourselves on the partner row.
 *
 * Everything in this module is reused by:
 *   - src/adapters/icabbi.ts (resetWebhookListeners)
 *   - src/app/api/webhooks/ingest/[partnerId]/route.ts (event allowlist)
 *   - src/app/partners/[id]/integration/page.tsx (UI badges / counts)
 *
 * To add a new event: one-line append below. Existing partner rows will
 * NOT be auto-extended — operators must run "Reset Webhooks" for each
 * connected partner. (Same gap Frank documents on the iCabbi-side
 * project — they accept it because reset is cheap.)
 */

export const ICABBI_WEBHOOK_EVENTS = [
  // Booking lifecycle — fired in order during a typical trip.
  "request:save",                  // a new booking is saved (pre-allocate)
  "booking:allocate",              // a driver/vehicle is being allocated
  "booking:driver_designate",      // driver assigned to the booking
  "booking:driver_undesignate",    // driver unassigned (rare but real)
  "booking:driver_enroute",        // driver heading to pickup
  "booking:arrived",               // driver at pickup
  "booking:madecontact",           // driver and passenger connected
  "booking:completed",             // trip done — fare may be final here

  // Cancellation / exception events — terminal states.
  "booking:booking_cancelled",     // passenger or dispatcher cancelled
  "booking:drivercancelled",       // driver cancelled
  "booking:dispatch_cancelled",    // dispatch system cancelled
  "booking:noshow",                // passenger didn't show

  // Mutation events.
  "booking:edit",                  // booking fields edited post-creation
] as const;

export type IcabbiWebhookEvent = (typeof ICABBI_WEBHOOK_EVENTS)[number];

/**
 * Listener name prefix used when registering with iCabbi. The final name
 * is `<prefix>_<event_with_colons_replaced_by_underscores>`, e.g.
 *   exchange_booking_completed
 *
 * Prefix is configurable so multiple Exchange tenants (staging / prod /
 * a partner's own instance) can coexist on the same iCabbi tenant
 * without listener-name collisions. Defaults to "exchange" which is
 * fine for single-tenant prod.
 */
export function getListenerNamePrefix(): string {
  const v = process.env.ICABBI_WEBHOOK_NAME_PREFIX;
  if (v && /^[a-zA-Z0-9_-]{1,32}$/.test(v)) return v;
  return "exchange";
}

/**
 * Compose the per-listener name iCabbi expects. Strict ASCII to avoid
 * any encoding surprises in their dispatcher UI (we don't know which
 * fonts/encodings their console uses).
 *
 *   buildListenerName("booking:completed") → "exchange_booking_completed"
 */
export function buildListenerName(event: IcabbiWebhookEvent): string {
  return `${getListenerNamePrefix()}_${event.replace(/:/g, "_")}`;
}

/**
 * Allowlist used by the inbound webhook route to reject events we
 * didn't subscribe to (defends against accidental writes to the audit
 * trail from arbitrary POSTs that have a valid token). Includes the
 * 13 registered events plus the catch-all "status_update" string our
 * own iCabbi adapter's normaliseInboundWebhook synthesizes when the
 * partner's payload doesn't carry an explicit event type.
 */
export const ICABBI_ALLOWED_INBOUND_EVENTS: ReadonlySet<string> = new Set<string>([
  ...ICABBI_WEBHOOK_EVENTS,
  "status_update",
]);
