import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getAdapterForPartner } from "@/adapters/registry";
import { isFreshDelivery } from "@/lib/idempotency";
import { routeBooking } from "@/lib/routing";
import type { Partner } from "@/db/schema";

/**
 * <InboundWebhookSimulator />
 *
 * Renders on external-partner detail pages. Builds a payload in the partner's
 * NATIVE webhook shape (currently CMAC's `cmac.booking_request`), then
 * exercises the SAME pipeline that `/api/webhooks/ingest` runs in production:
 *
 *   isFreshDelivery (idempotency)
 *   → getAdapterForPartner
 *   → adapter.normaliseInboundWebhook (translate native → NormalisedBooking)
 *   → routeBooking (pick recipient, snapshot fees, push)
 *
 * Differs from the partner detail page's "Send a test booking" form, which
 * builds a NormalisedBooking directly and bypasses the adapter's translation
 * layer. This simulator exercises the integration boundary, which is the
 * point of failure when a real CMAC or FreeNow integration ships.
 *
 * To extend for a new external partner (e.g. FreeNow), branch on
 * `partner.adapterKey` and build the appropriate payload shape inside
 * `buildPayload` below.
 */

export function InboundWebhookSimulator({ partner }: { partner: Partner }) {
  // Only render for external partners that can originate
  const canOriginate =
    partner.participationMode === "send_only" || partner.participationMode === "send_and_receive";
  const isExternal = partner.kind === "external_aggregator" || partner.kind === "external_corporate";
  if (!isExternal) return null;

  if (!canOriginate) {
    return (
      <section style={containerStyle}>
        <h2 style={titleStyle}>Simulate inbound webhook</h2>
        <p style={{ color: "#7f1d1d", fontSize: 13, margin: 0 }}>
          This partner&apos;s participation mode is <code>{partner.participationMode}</code>, so it
          can&apos;t send inbound bookings. Switch to <code>send_only</code> or{" "}
          <code>send_and_receive</code> first.
        </p>
      </section>
    );
  }

  const futureISOLocal = toLocalDatetimeValue(new Date(Date.now() + 60 * 60_000));

  return (
    <section style={containerStyle}>
      <h2 style={titleStyle}>Simulate inbound webhook</h2>
      <p style={{ color: "#7f1d1d", fontSize: 13, marginTop: 0 }}>
        Sends a <code>cmac.booking_request</code>-shaped payload through{" "}
        <code>/api/webhooks/ingest</code>-equivalent code: idempotency check, then the adapter
        translates the native shape into a <code>NormalisedBooking</code>, then the routing engine
        picks an eligible recipient and pushes. This is how real CMAC traffic will flow in
        production — payload format, normalisation, and routing all exercised end-to-end.
      </p>

      <form action={simulateInboundAction} style={{ display: "grid", gap: 12, marginTop: 12 }}>
        <input type="hidden" name="originatorPartnerId" value={partner.id} />

        <div style={twoCol}>
          <Field label="CMAC booking reference" hint="Auto-prefixed with timestamp — change if you want">
            <input
              name="reference"
              defaultValue={`CMAC-${Math.floor(Date.now() / 1000)}`}
              style={input}
              required
            />
          </Field>
          <Field label="Scheduled for" hint="Pre-book ride time">
            <input
              name="scheduledFor"
              type="datetime-local"
              defaultValue={futureISOLocal}
              style={input}
              required
            />
          </Field>
        </div>

        <Field label="Pickup address">
          <input name="pickupAddress" defaultValue="The Shelbourne Hotel, Dublin" style={input} required />
        </Field>
        <Field label="Dropoff address">
          <input name="dropoffAddress" defaultValue="Dublin Airport, Terminal 2" style={input} required />
        </Field>

        <div style={threeCol}>
          <Field label="Vehicle type">
            <input name="vehicleType" defaultValue="executive" style={input} />
          </Field>
          <Field label="Passengers">
            <input name="pax" type="number" min={1} max={8} defaultValue={1} style={input} />
          </Field>
          <Field label="Fare estimate (£)">
            <input name="farePounds" type="number" step="0.5" defaultValue="35" style={input} />
          </Field>
        </div>

        <div style={twoCol}>
          <Field label="Traveller name">
            <input name="travellerName" defaultValue="Corporate Traveller" style={input} />
          </Field>
          <Field label="Traveller phone">
            <input name="travellerPhone" defaultValue="+44 20 7000 0000" style={input} />
          </Field>
        </div>

        <Field label="Notes" hint="Optional — anything to pass to the receiving fleet">
          <input name="notes" placeholder="VIP — meet and greet" style={input} />
        </Field>

        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 12 }}>
          <button type="submit" style={primaryBtn}>
            Send inbound webhook
          </button>
          <span style={{ fontSize: 12, color: "#7f1d1d" }}>
            Routes to the lowest-receive-fee mutually-allowed iCabbi fleet whose vehicle and
            booking types match.
          </span>
        </div>
      </form>
    </section>
  );
}

async function simulateInboundAction(formData: FormData) {
  "use server";

  const originatorPartnerId = String(formData.get("originatorPartnerId") ?? "");
  if (!originatorPartnerId) return;

  // Build the native CMAC payload shape. Adding a new external partner =
  // branch here on the adapter and build its shape instead.
  const reference = String(formData.get("reference") ?? `CMAC-${Date.now()}`);
  const scheduledForLocal = String(formData.get("scheduledFor") ?? "");
  const scheduledFor = scheduledForLocal
    ? new Date(scheduledForLocal).toISOString()
    : new Date(Date.now() + 3600_000).toISOString();
  const fare = Number(String(formData.get("farePounds") ?? "0").trim());
  const fareEstimatePence = Number.isFinite(fare) && fare > 0 ? Math.round(fare * 100) : undefined;

  const payload = {
    type: "cmac.booking_request",
    data: {
      reference,
      pickup: { lat: 53.339, lng: -6.258, address: String(formData.get("pickupAddress") ?? "") },
      dropoff: { lat: 53.421, lng: -6.27, address: String(formData.get("dropoffAddress") ?? "") },
      scheduledFor,
      vehicleType: String(formData.get("vehicleType") ?? "executive"),
      pax: Number(formData.get("pax") ?? 1),
      fareEstimatePence,
      traveller: {
        name: String(formData.get("travellerName") ?? "Corporate Traveller"),
        phone: String(formData.get("travellerPhone") ?? ""),
      },
      notes: String(formData.get("notes") ?? "") || undefined,
    },
  };

  // Generate a unique event id per submission so idempotency doesn't swallow
  // repeat clicks. In production, the partner's system supplies this.
  const eventId = `simulator-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Mirror the /api/webhooks/ingest route handler exactly
  const fresh = await isFreshDelivery(`ingest:${originatorPartnerId}`, eventId, payload);
  if (!fresh) {
    // Shouldn't happen with a fresh eventId, but handle for parity
    redirect(`/bookings?outcome=duplicate`);
  }

  const adapter = await getAdapterForPartner(originatorPartnerId);
  const normalised = await adapter.normaliseInboundWebhook(payload);

  if (!normalised || normalised.kind !== "create") {
    redirect(`/bookings?outcome=not_a_booking_create`);
  }

  const result = await routeBooking({
    originatorPartnerId,
    booking: normalised.booking,
  });

  revalidatePath("/bookings");
  revalidatePath(`/partners/${originatorPartnerId}`);

  if (result.outcome === "pushed") {
    redirect(`/transits/${result.transitId}?source=inbound_simulator`);
  }
  redirect(`/bookings?highlight=${result.transitId}&outcome=${result.outcome}`);
}

function toLocalDatetimeValue(d: Date): string {
  // datetime-local expects YYYY-MM-DDTHH:MM in the user's local time
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "grid", gap: 4 }}>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
      {hint && <span style={{ fontSize: 11, color: "#64748b" }}>{hint}</span>}
      {children}
    </label>
  );
}

const containerStyle: React.CSSProperties = {
  marginTop: 24,
  padding: 16,
  background: "#fff7ed",
  border: "1px solid #fb923c",
  borderRadius: 8,
};

const titleStyle: React.CSSProperties = {
  margin: "0 0 8px",
  fontSize: 16,
  color: "#7c2d12",
};

const input: React.CSSProperties = {
  padding: "6px 10px",
  fontSize: 13,
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  background: "white",
};

const twoCol: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 12,
};

const threeCol: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr 1fr",
  gap: 12,
};

const primaryBtn: React.CSSProperties = {
  padding: "8px 16px",
  fontSize: 13,
  fontWeight: 600,
  background: "#7c2d12",
  color: "white",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  justifySelf: "start",
};
