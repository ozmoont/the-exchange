import { db } from "@/db/client";
import { transits, transitEvents, partners } from "@/db/schema";
import { asc, eq, inArray } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import { forwardStatusUpdate } from "@/lib/routing";
import { requireUser } from "@/lib/auth";
import { statusBadgeClass, statusLabel, statusMeta } from "@/lib/status-labels";
import { RoutingTrace } from "@/components/routing-trace";
import { AcceptCountdown } from "@/components/accept-countdown";
import { canSeeDriverDetail, DRIVER_DETAILS_HIDDEN_EXPLAINER } from "@/lib/pii";

export const dynamic = "force-dynamic";

/**
 * /transits/[id] — full timeline of one transit.
 *
 * Simulate-status buttons call the same `forwardStatusUpdate` server function
 * that real iCabbi webhooks land on. Fleet roles can only view transits where
 * their partner is involved; fleet_admin can simulate, fleet_user can only view.
 */

const HAPPY_PATH = ["accepted", "driver_assigned", "driver_arrived", "en_route", "on_board", "completed"] as const;
const TERMINAL: ReadonlySet<string> = new Set(["completed", "cancelled", "failed"]);
/**
 * Terminal-failed statuses that admins can manually re-route from. Excludes
 * 'completed' (don't re-route something that already succeeded) and 'paused'
 * (the kill-switch resume handles those automatically).
 */
const FAILED_RETRYABLE: ReadonlySet<string> = new Set([
  "no_match",
  "cancelled",
  "failed",
  "error_auth",
  "error_other",
]);

async function retryRoutingAction(formData: FormData) {
  "use server";
  const transitId = String(formData.get("transitId") ?? "");
  if (!transitId) return;

  const user = await requireUser();
  if (user.role !== "super_admin") redirect("/");

  const { db } = await import("@/db/client");
  const { transits, auditLog } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const { routeBooking } = await import("@/lib/routing");

  const [t] = await db.select().from(transits).where(eq(transits.id, transitId));
  if (!t) return;
  if (!FAILED_RETRYABLE.has(t.status)) return; // guard

  const before = {
    status: t.status,
    recipientPartnerId: t.recipientPartnerId,
    rerouteCount: t.rerouteCount,
  };

  // Reset the transit so routeBooking treats it like a fresh attempt. We
  // keep the booking_payload and the original transit id (audit continuity)
  // but clear everything routing-related so the engine doesn't see prior
  // state as "already pushed".
  await db
    .update(transits)
    .set({
      status: "received",
      recipientPartnerId: null,
      recipientBookingExternalId: null,
      feeSnapshot: null,
      routingTrace: null,
      acceptDeadline: null,
      rerouteCount: 0,
      partnershipCoid: null,
      recipientClientId: null,
      recipientServerName: null,
      recipientSiteId: null,
      trackMyTaxiLink: null,
      updatedAt: new Date(),
    })
    .where(eq(transits.id, transitId));

  await db.insert(auditLog).values({
    category: "booking",
    actor: "admin_user",
    actorRef: user.email,
    action: "transit.manual_retry",
    subjectType: "transit",
    subjectId: transitId,
    before,
    after: { reset_to: "received" },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const booking = t.bookingPayload as any;
  const result = await routeBooking({
    originatorPartnerId: t.originatorPartnerId,
    booking,
  });

  revalidatePath(`/transits/${transitId}`);
  revalidatePath("/bookings");
  redirect(`/transits/${transitId}?retried=${result.outcome}`);
}

async function simulateStatusAction(formData: FormData) {
  "use server";
  const transitId = String(formData.get("transitId") ?? "");
  const newStatus = String(formData.get("newStatus") ?? "");
  if (!transitId || !newStatus) return;

  // When advancing to driver_assigned, attach realistic driver/vehicle data
  // so the driver panel surfaces immediately. Mirrors the shape Karhoo
  // sends in the DriverDetails webhook event.
  const baseDetail: Record<string, unknown> = {
    simulated: true,
    via: "transit_detail_page",
    at: new Date().toISOString(),
  };
  const detail =
    newStatus === "driver_assigned"
      ? { ...baseDetail, ...sampleDriverDetail() }
      : baseDetail;

  await forwardStatusUpdate({
    transitId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    newStatus: newStatus as any,
    detail,
  });

  revalidatePath(`/transits/${transitId}`);
  revalidatePath("/bookings");
}

function sampleDriverDetail() {
  const samples = [
    {
      driver: { first_name: "Michael", last_name: "Higgins", phone_number: "+353 1 555 0099", license_number: "ZXZ151YTY" },
      description: "Renault Scenic (Black)",
      vehicle_class: "MPV",
      vehicle_license_plate: "12-D-9999",
      make: "Renault",
      model: "Scenic",
      colour: "BLACK",
      passenger_capacity: 4,
      luggage_capacity: 3,
      tags: ["child-seat"],
    },
    {
      driver: { first_name: "Aoife", last_name: "Murphy", phone_number: "+353 1 555 0123", license_number: "DR-0049" },
      description: "Skoda Octavia (Silver)",
      vehicle_class: "Saloon",
      vehicle_license_plate: "22-D-4421",
      make: "Skoda",
      model: "Octavia",
      colour: "SILVER",
      passenger_capacity: 4,
      luggage_capacity: 3,
      tags: [],
    },
    {
      driver: { first_name: "Diarmuid", last_name: "O'Brien", phone_number: "+353 1 555 0188", license_number: "RA-2200" },
      description: "Mercedes E-Class (Black)",
      vehicle_class: "Executive",
      vehicle_license_plate: "23-D-0188",
      make: "Mercedes-Benz",
      model: "E-Class",
      colour: "BLACK",
      passenger_capacity: 4,
      luggage_capacity: 2,
      tags: ["electric", "premium"],
    },
  ];
  return samples[Math.floor(Math.random() * samples.length)];
}

export default async function TransitDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ retried?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const retriedOutcome = sp.retried ?? null;
  const user = await requireUser();
  const [transit] = await db.select().from(transits).where(eq(transits.id, id));
  if (!transit) notFound();

  if (user.role !== "super_admin") {
    const involved =
      user.partnerId &&
      (user.partnerId === transit.originatorPartnerId ||
        user.partnerId === transit.recipientPartnerId);
    if (!involved) redirect("/");
  }
  const canSimulate = user.role === "super_admin" || user.role === "fleet_admin";

  const [originator] = await db
    .select()
    .from(partners)
    .where(eq(partners.id, transit.originatorPartnerId));
  const [recipient] = transit.recipientPartnerId
    ? await db.select().from(partners).where(eq(partners.id, transit.recipientPartnerId))
    : [null];

  const events = await db
    .select()
    .from(transitEvents)
    .where(eq(transitEvents.transitId, id))
    .orderBy(asc(transitEvents.createdAt));

  const isTerminal = TERMINAL.has(transit.status);
  const currentIndex = HAPPY_PATH.indexOf(transit.status as (typeof HAPPY_PATH)[number]);
  const nextHappy =
    currentIndex >= 0 && currentIndex < HAPPY_PATH.length - 1
      ? HAPPY_PATH[currentIndex + 1]
      : transit.status === "pushed"
      ? "accepted"
      : null;

  const booking = transit.bookingPayload as Record<string, unknown>;
  const fs = transit.feeSnapshot;

  // Find the most recent event that carries driver/vehicle data. iCabbi's
  // DriverDetails webhook event populates the transit_event.detail jsonb
  // with the full driver + vehicle payload; we render it as a card.
  const driverEvent = [...events].reverse().find((e) => {
    const d = e.detail as Record<string, unknown> | null;
    return d && d.driver && typeof d.driver === "object";
  });
  const rawDriverDetail = driverEvent?.detail as DriverEventDetail | undefined;
  // PII gate: originator-side viewers only see driver detail when the
  // originator partner has driverDetailsRequired=true. Recipients always see
  // their own driver. Super admins see everything.
  const driverDetailVisible = canSeeDriverDetail(user, transit, originator ?? null);
  const driverDetail = driverDetailVisible ? rawDriverDetail : undefined;

  // Resolve partner names for the routing trace. Pull every recipientId that
  // appears in waterfallAttempts in one query.
  const trace = transit.routingTrace as
    | {
        waterfallAttempts?: Array<{ recipientId: string }>;
        winner?: string | null;
      }
    | null;
  const traceIds = new Set<string>();
  if (trace?.waterfallAttempts) {
    for (const a of trace.waterfallAttempts) traceIds.add(a.recipientId);
  }
  if (trace?.winner) traceIds.add(trace.winner);
  const tracedPartners = traceIds.size
    ? await db.select().from(partners).where(inArray(partners.id, [...traceIds]))
    : [];
  const partnerNames = new Map(tracedPartners.map((p) => [p.id, p.name]));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-ink-muted font-semibold">
            Booking
          </p>
          <h1 className="text-3xl font-bold tracking-tight mt-1">
            <code className="text-2xl">{transit.originatorBookingExternalId}</code>
          </h1>
          <div className="text-xs text-ink-subtle mt-2">
            <code>{transit.id}</code>
          </div>
        </div>
        <Link href="/bookings" className="text-sm text-ink-muted hover:text-ink">← All bookings</Link>
      </div>

      {retriedOutcome && (
        <div
          className={`rounded-md border px-4 py-3 text-sm ${
            retriedOutcome === "pushed"
              ? "bg-success/40 border-green-300 text-success-fg"
              : retriedOutcome === "no_match"
              ? "bg-warning/40 border-yellow-300 text-warning-fg"
              : "bg-danger/30 border-red-300 text-red-800"
          }`}
        >
          Retry routing completed: <strong>{retriedOutcome}</strong>
          {retriedOutcome === "pushed" && " — booking is back in the network."}
          {retriedOutcome === "no_match" && " — still no eligible partner. Try again later or fix routing rules."}
          {retriedOutcome === "error" && " — every candidate errored again. Check partner credentials."}
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-6">
        <Section title="Route">
          <KV
            k="Status"
            v={
              <span className="flex items-center gap-2 flex-wrap">
                <StatusBadge status={transit.status} />
                {transit.status === "pushed" && transit.acceptDeadline && (
                  <AcceptCountdown deadlineIso={new Date(transit.acceptDeadline).toISOString()} />
                )}
                {transit.rerouteCount > 0 && (
                  <span className="text-xs text-ink-muted">
                    · auto-rerouted {transit.rerouteCount}×
                  </span>
                )}
              </span>
            }
          />
          <KV
            k="Originator"
            v={originator ? <Link href={`/partners/${originator.id}`} className="text-ink hover:underline">{originator.name}</Link> : "—"}
          />
          <KV
            k="Recipient"
            v={recipient ? <Link href={`/partners/${recipient.id}`} className="text-ink hover:underline">{recipient.name}</Link> : "—"}
          />
          <KV k="Originator booking id" v={<code className="text-xs">{transit.originatorBookingExternalId}</code>} />
          <KV
            k="Recipient booking id"
            v={transit.recipientBookingExternalId ? <code className="text-xs">{transit.recipientBookingExternalId}</code> : "—"}
          />
          <KV k="Created" v={new Date(transit.createdAt).toLocaleString()} />
          <KV k="Updated" v={new Date(transit.updatedAt).toLocaleString()} />
        </Section>

        <Section title="Fee snapshot">
          {fs ? (
            <>
              <KV k="Send fee" v={`${fs.sendFeePence}p`} />
              <KV k="Receive fee" v={`${fs.receiveFeePence}p`} />
              <KV k="Tech fee" v={`${fs.techFeePence}p + ${fs.techFeeBps / 100}%`} />
              <KV k="Booking fee" v={`${fs.bookingFeePence}p`} />
              <KV k="Admin fee" v={`${fs.adminFeePence}p + ${fs.adminFeeBps / 100}%`} />
              <KV k="Passenger add-ons" v={`${fs.computedPassengerAddOnsPence}p`} />
              <KV k="Fare at snapshot" v={fs.fareAtSnapshotPence !== null ? `${fs.fareAtSnapshotPence}p` : "—"} />
              <KV k="Resolved from" v={<code className="text-xs">{fs.resolvedFromFeeConfigId}</code>} />
            </>
          ) : (
            <p className="text-sm text-ink-muted">No fee snapshot — booking didn&apos;t reach routing stage.</p>
          )}
        </Section>
      </div>

      {driverDetail && <DriverPanel driver={driverDetail} />}
      {!driverDetailVisible && rawDriverDetail && (
        <div className="card p-4 bg-surface-muted/40 text-sm text-ink-muted flex items-center gap-2">
          <span aria-hidden className="text-lg">🔒</span>
          <span>{DRIVER_DETAILS_HIDDEN_EXPLAINER}</span>
        </div>
      )}

      {user.role === "super_admin" && FAILED_RETRYABLE.has(transit.status) && (
        <section className="card bg-info/30 border-l-4 border-l-sky-500 p-5">
          <h2 className="text-base font-semibold text-info-fg mb-1">
            Retry routing
          </h2>
          <p className="text-sm text-ink-muted mb-4 max-w-prose">
            This booking ended at <code>{transit.status}</code>. Retrying resets
            the recipient + accept deadline + reroute count and replays the
            routing engine with the original booking payload — useful when a
            transient issue caused the original failure (partner outage,
            credential rot, network blip) and the underlying state has since
            recovered.
          </p>
          <form action={retryRoutingAction}>
            <input type="hidden" name="transitId" value={transit.id} />
            <button type="submit" className="btn-primary">
              Retry routing
            </button>
          </form>
          <p className="text-xs text-ink-subtle mt-3">
            Audit-logged as <code>transit.manual_retry</code> with the actor and
            original status. Booking payload is preserved.
          </p>
        </section>
      )}

      {canSimulate && !isTerminal && transit.recipientPartnerId && (
        <section className="card bg-warning/60 border-yellow-400 p-5">
          <h2 className="text-base font-semibold text-yellow-900 mb-1">Simulate next status</h2>
          <p className="text-sm text-yellow-900/80 mb-4">
            In production these statuses arrive via webhooks from the recipient. With mock adapters
            they don&apos;t fire automatically — use these buttons to drive the lifecycle by hand.
            The same server function is called either way.
          </p>
          <div className="flex flex-wrap gap-2">
            {nextHappy && (
              <SimulateButton transitId={transit.id} newStatus={nextHappy} action={simulateStatusAction} variant="primary" />
            )}
            {HAPPY_PATH.filter((s) => s !== nextHappy && s !== transit.status).map((s) => (
              <SimulateButton key={s} transitId={transit.id} newStatus={s} action={simulateStatusAction} variant="secondary" />
            ))}
            <SimulateButton transitId={transit.id} newStatus="cancelled" action={simulateStatusAction} variant="danger" />
            <SimulateButton transitId={transit.id} newStatus="failed" action={simulateStatusAction} variant="danger" />
          </div>
        </section>
      )}

      {isTerminal && (
        <div className="card p-4 text-sm text-ink-muted">
          Booking is in terminal state <code>{transit.status}</code>. No further status changes will be accepted.
        </div>
      )}

      {/* Reconciliation — only show if we've run it on this transit */}
      {transit.reconciledAt && (
        <Section
          title={
            transit.reconciledFlagged
              ? "Reconciliation — flagged for review"
              : "Reconciliation"
          }
        >
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-ink-subtle font-semibold">
                Originator billed
              </div>
              <div className="text-lg font-bold tabular-nums mt-0.5">
                {fmtPence(transit.reconciledOriginatorTotalPence)}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-ink-subtle font-semibold">
                Recipient billed
              </div>
              <div className="text-lg font-bold tabular-nums mt-0.5">
                {fmtPence(transit.reconciledRecipientTotalPence)}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-ink-subtle font-semibold">
                Drift
              </div>
              <div
                className={`text-lg font-bold tabular-nums mt-0.5 ${
                  transit.reconciledFlagged ? "text-red-700" : "text-ink"
                }`}
              >
                {fmtPence(transit.reconciledDriftPence)}
              </div>
            </div>
          </div>
          {transit.reconciledFlagged && (
            <p className="mt-3 text-xs text-red-700">
              Drift exceeds the 5% threshold — review the fee snapshot against
              both partners&apos; payment records. Likely causes: different tariff,
              surcharges, or processing fees added on one side.
            </p>
          )}
          <p className="mt-2 text-xs text-ink-subtle">
            Reconciled {new Date(transit.reconciledAt).toLocaleString()} ·
            Compared to feeSnapshot.receiveFeePence ={" "}
            <code>{transit.feeSnapshot?.receiveFeePence ?? "—"}p</code>
          </p>
        </Section>
      )}

      <Section title="Routing decision">
        <RoutingTrace trace={transit.routingTrace} partnerNames={partnerNames} />
      </Section>

      <Section title="Event timeline">
        {events.length === 0 ? (
          <p className="text-sm text-ink-muted">No events yet.</p>
        ) : (
          <ol className="divide-y divide-border">
            {events.map((e) => (
              <li key={e.id} className="grid grid-cols-[180px_140px_1fr] gap-3 py-3 text-sm">
                <span className="text-ink-subtle">{new Date(e.createdAt).toLocaleString()}</span>
                <span><StatusBadge status={e.status} /></span>
                <span className="text-ink-muted font-mono text-xs break-words">
                  {e.actor}
                  {e.detail ? ` · ${JSON.stringify(e.detail)}` : ""}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section title="Booking payload (originator view)">
        <pre className="bg-ink text-slate-200 p-3 rounded-md overflow-auto text-xs leading-relaxed">
          {JSON.stringify(booking, null, 2)}
        </pre>
      </Section>
    </div>
  );
}

function SimulateButton({
  transitId,
  newStatus,
  action,
  variant,
}: {
  transitId: string;
  newStatus: string;
  action: (formData: FormData) => void;
  variant: "primary" | "secondary" | "danger";
}) {
  const cls =
    variant === "primary" ? "btn-primary" : variant === "danger" ? "btn-danger" : "btn-secondary";
  return (
    <form action={action}>
      <input type="hidden" name="transitId" value={transitId} />
      <input type="hidden" name="newStatus" value={newStatus} />
      <button type="submit" className={cls}>
        {newStatus.replace(/_/g, " ")}
      </button>
    </form>
  );
}

function fmtPence(p: number | null | undefined): string {
  if (p == null) return "—";
  return p >= 100 ? `£${(p / 100).toFixed(2)}` : `${p}p`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card p-5">
      <h2 className="text-base font-semibold mb-4">{title}</h2>
      {children}
    </section>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[180px_1fr] text-sm py-1 items-center">
      <span className="text-ink-muted">{k}</span>
      <span>{v}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const meta = statusMeta(status);
  return (
    <span className={statusBadgeClass(status)} title={meta.description}>
      {statusLabel(status)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Driver panel
// ---------------------------------------------------------------------------

type DriverEventDetail = {
  driver?: {
    first_name?: string;
    last_name?: string;
    phone_number?: string;
    photo_url?: string;
    license_number?: string;
  };
  description?: string;
  vehicle_class?: string;
  vehicle_license_plate?: string;
  make?: string;
  model?: string;
  colour?: string;
  passenger_capacity?: number;
  luggage_capacity?: number;
  tags?: string[];
};

function DriverPanel({ driver }: { driver: DriverEventDetail }) {
  const d = driver.driver ?? {};
  const driverName = [d.first_name, d.last_name].filter(Boolean).join(" ") || "Unknown driver";
  const vehicleParts = [driver.colour, driver.make, driver.model].filter(Boolean);
  const vehicleLabel =
    driver.description ?? (vehicleParts.length ? vehicleParts.join(" ") : driver.vehicle_class ?? "Vehicle");
  const colourCapitalised = driver.colour ? driver.colour.charAt(0).toUpperCase() + driver.colour.slice(1).toLowerCase() : null;

  return (
    <section className="card p-5 bg-info/30 border-blue-200">
      <div className="flex items-start gap-4">
        {d.photo_url ? (
          <img
            src={d.photo_url}
            alt={driverName}
            className="h-14 w-14 rounded-full object-cover border-2 border-white shadow-card"
          />
        ) : (
          <div className="h-14 w-14 rounded-full bg-info-fg/20 text-info-fg flex items-center justify-center font-bold text-lg">
            {(d.first_name?.[0] ?? "?") + (d.last_name?.[0] ?? "")}
          </div>
        )}

        <div className="flex-1 min-w-0">
          <div className="text-xs uppercase tracking-wide text-info-fg/70 font-semibold">
            Driver assigned
          </div>
          <div className="flex items-baseline gap-3 flex-wrap mt-1">
            <h2 className="text-lg font-bold text-info-fg">{driverName}</h2>
            {d.phone_number && (
              <a href={`tel:${d.phone_number}`} className="text-sm text-info-fg hover:underline">
                {d.phone_number}
              </a>
            )}
          </div>

          <div className="mt-2 text-sm text-info-fg/90">
            {vehicleLabel}
            {driver.vehicle_license_plate && (
              <>
                {" · "}
                <code className="bg-white/60 px-1.5 py-0.5 rounded font-mono text-xs">
                  {driver.vehicle_license_plate}
                </code>
              </>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-info-fg/80">
            {driver.vehicle_class && <span><strong>Class:</strong> {driver.vehicle_class}</span>}
            {colourCapitalised && <span><strong>Colour:</strong> {colourCapitalised}</span>}
            {typeof driver.passenger_capacity === "number" && (
              <span><strong>Passengers:</strong> {driver.passenger_capacity}</span>
            )}
            {typeof driver.luggage_capacity === "number" && (
              <span><strong>Luggage:</strong> {driver.luggage_capacity}</span>
            )}
            {d.license_number && (
              <span><strong>Licence:</strong> <code className="font-mono">{d.license_number}</code></span>
            )}
          </div>

          {driver.tags && driver.tags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {driver.tags.map((t) => (
                <span key={t} className="bg-white/70 text-info-fg px-2 py-0.5 rounded-full text-xs font-medium">
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
