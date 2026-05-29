import { db } from "@/db/client";
import { partners, auditLog } from "@/db/schema";
import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import { requirePartnerWrite } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * /partners/[id]/edit — change a partner's editable fields. Audit-logs every
 * save with full before/after JSON. Kind is immutable; everything else can
 * be changed by super_admin or the partner's fleet_admin.
 */

type ParticipationMode = "send_only" | "receive_only" | "send_and_receive" | "inactive";
type PartnerStatus = "pending_approval" | "active" | "warning" | "suspended";

const MODES: ParticipationMode[] = ["send_and_receive", "send_only", "receive_only", "inactive"];
const STATUSES: PartnerStatus[] = ["active", "warning", "pending_approval", "suspended"];

async function savePartnerAction(formData: FormData) {
  "use server";

  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await requirePartnerWrite(id);

  const [existing] = await db.select().from(partners).where(eq(partners.id, id));
  if (!existing) return;

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;

  const next = {
    name,
    legalName: nullable(formData.get("legalName")),
    contactEmail: nullable(formData.get("contactEmail")),
    participationMode: (String(formData.get("participationMode") ?? existing.participationMode)) as ParticipationMode,
    status: (String(formData.get("status") ?? existing.status)) as PartnerStatus,
    operatingRegions: csvList(formData.get("operatingRegions")),
    vehicleTypes: csvList(formData.get("vehicleTypes")),
    bookingTypes: (["asap", "prebook"] as const).filter(
      (b) => formData.get(`bookingType_${b}`) === "on",
    ),
    adapterKey: String(formData.get("adapterKey") ?? existing.adapterKey),
    webhookUrl: nullable(formData.get("webhookUrl")),
    billingNotes: nullable(formData.get("billingNotes")),
    updatedAt: new Date(),
  };

  if (next.bookingTypes.length === 0) next.bookingTypes = existing.bookingTypes;

  await db.update(partners).set(next).where(eq(partners.id, id));

  await db.insert(auditLog).values({
    category: "admin",
    actor: "admin_user",
    actorRef: "portal",
    action: "partner.updated",
    subjectType: "partner",
    subjectId: id,
    before: existing as unknown as Record<string, unknown>,
    after: { ...existing, ...next } as unknown as Record<string, unknown>,
  });

  revalidatePath("/partners");
  revalidatePath(`/partners/${id}`);
  revalidatePath("/audit");
  redirect(`/partners/${id}`);
}

function nullable(raw: FormDataEntryValue | null): string | null {
  const s = String(raw ?? "").trim();
  return s.length ? s : null;
}

function csvList(raw: FormDataEntryValue | null): string[] {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export default async function EditPartnerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requirePartnerWrite(id);
  const [partner] = await db.select().from(partners).where(eq(partners.id, id));
  if (!partner) notFound();

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-ink-muted font-semibold">
            Edit partner
          </p>
          <h1 className="text-3xl font-bold tracking-tight mt-1">{partner.name}</h1>
          <div className="text-xs text-ink-subtle mt-2">
            <code>{partner.id}</code> · {partner.kind.replace("_", " ")} — kind is immutable
          </div>
        </div>
        <Link href={`/partners/${id}`} className="text-sm text-ink-muted hover:text-ink">
          ← Cancel
        </Link>
      </div>

      <form action={savePartnerAction} className="space-y-5">
        <input type="hidden" name="id" value={partner.id} />

        <Section title="Profile">
          <Field label="Name" required>
            <input name="name" defaultValue={partner.name} required className="input" />
          </Field>
          <Field label="Legal name" hint="Optional — used on invoices and contracts">
            <input name="legalName" defaultValue={partner.legalName ?? ""} className="input" />
          </Field>
          <Field label="Contact email">
            <input
              name="contactEmail"
              type="email"
              defaultValue={partner.contactEmail ?? ""}
              className="input"
            />
          </Field>
        </Section>

        <Section title="Participation">
          <Field label="Mode" hint={modeHelp(partner.participationMode)}>
            <select name="participationMode" defaultValue={partner.participationMode} className="input">
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {m.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Status" hint={statusHelp(partner.status)}>
            <select name="status" defaultValue={partner.status} className="input">
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </Field>

          {partner.status === "active" && (
            <Note tone="warning">
              Changing status to <strong>suspended</strong> stops all new bookings to/from this
              partner immediately. In-flight transits continue receiving status updates so no
              booking is stranded. The change is reversible — switch back to active and routing
              resumes.
            </Note>
          )}
        </Section>

        <Section title="Operational rules">
          <Field label="Operating regions" hint="Comma-separated, e.g. IE-D, IE-G, GB">
            <input
              name="operatingRegions"
              defaultValue={partner.operatingRegions.join(", ")}
              className="input"
            />
          </Field>
          <Field label="Vehicle types" hint="Comma-separated, e.g. standard, exec, wav">
            <input
              name="vehicleTypes"
              defaultValue={partner.vehicleTypes.join(", ")}
              className="input"
            />
          </Field>
          <Field label="Accepted booking types">
            <div className="flex gap-4 text-sm">
              <label>
                <input
                  type="checkbox"
                  name="bookingType_asap"
                  defaultChecked={partner.bookingTypes.includes("asap")}
                />{" "}
                ASAP
              </label>
              <label>
                <input
                  type="checkbox"
                  name="bookingType_prebook"
                  defaultChecked={partner.bookingTypes.includes("prebook")}
                />{" "}
                Pre-book
              </label>
            </div>
            <p className="text-xs text-ink-muted mt-1">
              At least one must be selected — if you uncheck both, the value won&apos;t change.
            </p>
          </Field>
        </Section>

        <Section title="Integration">
          <Field
            label="Adapter key"
            hint={`Identifies which adapter handles this partner. Changing it swaps the integration — e.g. "mock_icabbi" → "icabbi" once the real adapter ships.`}
          >
            <input name="adapterKey" defaultValue={partner.adapterKey} className="input" />
          </Field>
          <Field label="Webhook URL" hint="Where we send outbound status updates if the partner wants push delivery">
            <input
              name="webhookUrl"
              type="url"
              defaultValue={partner.webhookUrl ?? ""}
              className="input"
              placeholder="https://partner.example.com/webhooks/exchange"
            />
          </Field>
        </Section>

        <Section title="Billing notes">
          <Field
            label="Internal notes"
            hint="Not shown to the partner. Useful for capturing negotiated rates, billing cycle, contact people."
          >
            <textarea
              name="billingNotes"
              defaultValue={partner.billingNotes ?? ""}
              rows={4}
              className="input font-sans resize-y"
            />
          </Field>
        </Section>

        <div className="flex items-center gap-4">
          <button type="submit" className="btn-primary">Save changes</button>
          <Link href={`/partners/${id}`} className="text-sm text-ink-muted hover:text-ink">
            Cancel
          </Link>
          <span className="ml-auto text-xs text-ink-muted">
            Every change is audit-logged with before/after.
          </span>
        </div>
      </form>
    </div>
  );
}

function modeHelp(mode: string) {
  switch (mode) {
    case "send_and_receive":
      return "Currently sends and receives bookings. Routes work in both directions.";
    case "send_only":
      return "Currently only originates bookings — receives none from the network.";
    case "receive_only":
      return "Currently only accepts inbound bookings — cannot originate.";
    case "inactive":
      return "Currently neither sends nor receives. Effectively disconnected without losing config.";
    default:
      return "";
  }
}

function statusHelp(status: string) {
  switch (status) {
    case "active":
      return "Visible to the routing engine — eligible to send and receive based on participation mode.";
    case "warning":
      return "Active but degraded. Treated as eligible by routing; surface to ops for investigation.";
    case "pending_approval":
      return "Registered but not yet approved by an admin. Invisible to the routing engine.";
    case "suspended":
      return "Hard pause. Invisible to the routing engine. Reversible.";
    default:
      return "";
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card p-5">
      <h2 className="text-base font-semibold mb-4">{title}</h2>
      <div className="grid gap-4">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1">
      <span className="text-sm font-semibold text-ink">
        {label}
        {required && <span className="text-red-600 ml-1">*</span>}
      </span>
      {hint && <span className="text-xs text-ink-muted">{hint}</span>}
      {children}
    </label>
  );
}

function Note({ tone, children }: { tone: "warning"; children: React.ReactNode }) {
  const cls = tone === "warning" ? "bg-warning text-warning-fg border-yellow-400" : "bg-surface-muted text-ink-muted border-border-strong";
  return (
    <div className={`text-sm p-3 rounded-md border ${cls}`}>
      {children}
    </div>
  );
}
