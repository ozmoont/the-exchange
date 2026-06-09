import { db } from "@/db/client";
import { partners, auditLog } from "@/db/schema";
import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import { requireSuperAdmin } from "@/lib/auth";
import { clearMappingCache } from "@/lib/mapping-layer";

/**
 * H2 — admin UI for editing a partner's field mapping config.
 *
 * Pragmatic shape: JSON textarea + schema validation on submit. Full
 * form-per-canonical-field UI is a follow-up. The textarea approach gets
 * us configured-from-UI today without 100 form inputs and exposes the
 * full shape so operators can copy/paste templates.
 *
 * Spec: docs/specs/H2-mapping-layer.md.
 */

export const dynamic = "force-dynamic";

const CANONICAL_FIELDS = [
  // Pre-routing
  "pickup.lat",
  "pickup.lng",
  "pickup.address",
  "dropoff.lat",
  "dropoff.lng",
  "dropoff.address",
  "vehicle_type",
  "eta_minutes",
  // Passenger
  "passenger.name",
  "passenger.phone",
  "passenger.count",
  // Fare
  "fare.amount",
  "fare.currency",
  // Booking
  "booking.id",
  "booking.type",
  "booking.scheduled_at",
  "booking.status",
  // Driver
  "driver.name",
  "driver.phone",
  "driver.vehicle_reg",
  "driver.location.lat",
  "driver.location.lng",
] as const;

const TEMPLATE_FREENOW = `{
  "fields": {
    "pickup.lat":         { "partner_field": "latitude", "required": true },
    "pickup.lng":         { "partner_field": "longitude", "required": true },
    "pickup.address":     { "partner_field": "pickup_address" },
    "dropoff.lat":        { "partner_field": "dest_latitude" },
    "dropoff.lng":        { "partner_field": "dest_longitude" },
    "dropoff.address":    { "partner_field": "dest_address" },
    "vehicle_type":       { "partner_field": "service_class", "value_lookup": { "saloon": "ECO", "exec": "BUSINESS", "mpv": "VAN" } },
    "eta_minutes":        { "partner_field": "eta_seconds", "transform": { "type": "multiply", "value": 60 } },
    "passenger.name":     { "partner_field": "customer_name" },
    "passenger.phone":    { "partner_field": "customer_mobile" },
    "fare.amount":        { "partner_field": "total_pence", "transform": { "type": "multiply", "value": 100 } },
    "booking.id":         { "partner_field": "job_id" }
  },
  "endpoints": {
    "create_booking": "https://partner.example.com/bookings",
    "quote":          "https://partner.example.com/quote",
    "cancel":         "https://partner.example.com/cancellations"
  }
}`;

async function saveMappingsAction(formData: FormData) {
  "use server";
  const actor = await requireSuperAdmin();
  const partnerId = String(formData.get("partnerId") ?? "");
  if (!partnerId) return;

  const raw = String(formData.get("fieldMappings") ?? "").trim();
  const authMechanism = String(formData.get("authMechanism") ?? "icabbi_app_secret") as
    | "icabbi_app_secret"
    | "oauth2"
    | "api_key_header"
    | "basic";

  let parsed: unknown = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      redirect(
        `/partners/${partnerId}/mappings?error=invalid_json&detail=${encodeURIComponent(msg)}`,
      );
    }
    if (!parsed || typeof parsed !== "object" || !("fields" in parsed)) {
      redirect(`/partners/${partnerId}/mappings?error=invalid_shape`);
    }
  }

  const [before] = await db.select().from(partners).where(eq(partners.id, partnerId));
  if (!before) return;

  await db
    .update(partners)
    .set({
      fieldMappings: (parsed ?? null) as Record<string, unknown> | null,
      authMechanism,
      updatedAt: new Date(),
    })
    .where(eq(partners.id, partnerId));

  // Bust the in-memory mapping cache so the next routing decision picks
  // up the new config immediately.
  clearMappingCache(partnerId);

  await db.insert(auditLog).values({
    category: "admin",
    actor: "admin_user",
    actorRef: actor.email,
    action: "partner.mappings_updated",
    subjectType: "partner",
    subjectId: partnerId,
    before: {
      fieldMappings: before.fieldMappings,
      authMechanism: before.authMechanism,
    },
    after: {
      fieldMappings: parsed,
      authMechanism,
    },
  });

  revalidatePath(`/partners/${partnerId}/mappings`);
  revalidatePath(`/partners/${partnerId}`);
  redirect(`/partners/${partnerId}/mappings?saved=1`);
}

export default async function PartnerMappingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string; detail?: string }>;
}) {
  await requireSuperAdmin();
  const { id } = await params;
  const sp = await searchParams;
  const [partner] = await db.select().from(partners).where(eq(partners.id, id));
  if (!partner) notFound();

  const current = partner.fieldMappings as { fields?: Record<string, unknown> } | null;
  const mappedFieldKeys = current?.fields ? Object.keys(current.fields) : [];
  const mappedSet = new Set(mappedFieldKeys);
  const currentJson = current ? JSON.stringify(current, null, 2) : "";

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-ink-muted font-semibold">
            H2 mapping layer (Epic 3)
          </p>
          <h1 className="text-3xl font-bold tracking-tight mt-1">{partner.name}</h1>
          <div className="text-xs text-ink-subtle mt-2">
            partner kind <code>{partner.kind}</code> · current adapter <code>{partner.adapterKey}</code> · auth <code>{partner.authMechanism}</code>
          </div>
        </div>
        <Link href={`/partners/${id}`} className="text-sm text-ink-muted hover:text-ink">
          ← Back to partner
        </Link>
      </div>

      {/* Banners */}
      {sp.saved === "1" && (
        <Banner tone="success">Mapping config saved. In-memory cache cleared.</Banner>
      )}
      {sp.error === "invalid_json" && (
        <Banner tone="error">
          JSON didn&apos;t parse: <code>{sp.detail ?? "(no detail)"}</code>. Fix the syntax below.
        </Banner>
      )}
      {sp.error === "invalid_shape" && (
        <Banner tone="error">
          Parsed JSON is missing the required <code>fields</code> object. See the spec.
        </Banner>
      )}

      {/* Coverage at a glance */}
      <section className="card p-5">
        <h2 className="text-base font-semibold mb-3">Canonical field coverage</h2>
        <p className="text-sm text-ink-muted mb-4">
          {mappedSet.size} of {CANONICAL_FIELDS.length} canonical fields mapped.
          Unmapped optional fields are omitted from outbound calls.
          Unmapped <strong>required</strong> fields block routing — flag them by
          including <code>required: true</code> in the mapping entry.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {CANONICAL_FIELDS.map((field) => {
            const isMapped = mappedSet.has(field);
            return (
              <span
                key={field}
                className={`text-[11px] font-mono px-2 py-1 rounded ${
                  isMapped
                    ? "bg-success/40 text-success-fg"
                    : "bg-surface-muted text-ink-subtle"
                }`}
                title={isMapped ? "Mapped" : "Not mapped"}
              >
                {field}
              </span>
            );
          })}
        </div>
      </section>

      {/* Editor */}
      <form action={saveMappingsAction} className="space-y-4">
        <input type="hidden" name="partnerId" value={partner.id} />

        <section className="card p-5 space-y-4">
          <h2 className="text-base font-semibold">Mapping config (JSON)</h2>
          <p className="text-sm text-ink-muted">
            Shape per <code>docs/specs/H2-mapping-layer.md</code>. Submit a
            top-level object with <code>fields</code> (required) and{" "}
            <code>endpoints</code> (optional). Each field entry needs a{" "}
            <code>partner_field</code>; can also carry{" "}
            <code>transform</code> (<code>divide</code> or <code>multiply</code>),
            <code>value_lookup</code> (canonical→partner enum), and{" "}
            <code>value_lookup_reverse</code> (partner→canonical, for
            receive-only fields like booking.status).
          </p>

          <label className="grid gap-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
              fieldMappings
            </span>
            <textarea
              name="fieldMappings"
              defaultValue={currentJson || TEMPLATE_FREENOW}
              rows={28}
              className="input font-mono text-xs leading-relaxed"
              spellCheck={false}
              placeholder={TEMPLATE_FREENOW}
            />
          </label>

          <label className="grid gap-1 max-w-xs">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
              auth mechanism (outbound)
            </span>
            <select
              name="authMechanism"
              defaultValue={partner.authMechanism}
              className="input"
            >
              <option value="icabbi_app_secret">icabbi_app_secret (App-Key + Secret-Key)</option>
              <option value="api_key_header">api_key_header (single static key)</option>
              <option value="basic">basic (HTTP Basic)</option>
              <option value="oauth2" disabled>oauth2 (not implemented yet)</option>
            </select>
          </label>
        </section>

        <div className="flex items-center gap-4">
          <button type="submit" className="btn-primary">Save mapping config</button>
          <span className="text-xs text-ink-muted">
            Saves into <code>partners.field_mappings</code> + <code>partners.auth_mechanism</code>.
            In-memory cache is cleared so the next routing decision picks up the new config.
            Audit-logged.
          </span>
        </div>
      </form>

      <div className="text-xs text-ink-muted">
        To switch this partner to the generic mapped adapter, also set{" "}
        <code>adapterKey = &quot;generic_mapped&quot;</code> on the partner edit page.
        Until then the partner continues using <code>{partner.adapterKey}</code>{" "}
        and the mapping is dormant config.
      </div>
    </div>
  );
}

function Banner({ tone, children }: { tone: "success" | "warning" | "error"; children: React.ReactNode }) {
  const cls =
    tone === "success"
      ? "bg-success text-success-fg"
      : tone === "warning"
      ? "bg-warning text-warning-fg"
      : "bg-danger text-danger-fg";
  return <div className={`p-3 rounded-md text-sm ${cls}`}>{children}</div>;
}
