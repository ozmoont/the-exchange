import { db } from "@/db/client";
import { partners, partnerRules, auditLog } from "@/db/schema";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Self-serve form to register a new partner. Defaults to an iCabbi fleet,
 * but supports CMAC-shaped external partners too.
 *
 * On submit we:
 *   1. Insert the partner.
 *   2. Auto-create mutual `allow` rules with every existing active partner of
 *      the same kind. This is intentional for MVP — you can revoke from the
 *      Allow/Block screen. Without it, a brand-new fleet would be invisible
 *      to the routing engine and "add a fleet and test" wouldn't work.
 *   3. Audit-log the registration.
 */

async function createPartnerAction(formData: FormData) {
  "use server";

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return; // could pass back errors via searchParams; MVP keeps it terse

  const kind = (String(formData.get("kind") ?? "icabbi_fleet")) as
    | "icabbi_fleet"
    | "external_aggregator"
    | "external_corporate";

  const adapterKey = kind === "icabbi_fleet" ? "mock_icabbi" : "mock_cmac";

  const participationMode = (String(formData.get("participationMode") ?? "send_and_receive")) as any;

  const operatingRegions = String(formData.get("operatingRegions") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const vehicleTypes = String(formData.get("vehicleTypes") ?? "standard")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const acceptsPrebook = formData.get("acceptsPrebook") === "on";
  const acceptsAsap = formData.get("acceptsAsap") === "on";
  const bookingTypes = [
    ...(acceptsAsap ? ["asap" as const] : []),
    ...(acceptsPrebook ? ["prebook" as const] : []),
  ];

  const contactEmail = String(formData.get("contactEmail") ?? "").trim() || null;
  const tenantLabel = String(formData.get("tenantLabel") ?? "").trim() || name.toLowerCase().replace(/\W+/g, "-");

  const [created] = await db
    .insert(partners)
    .values({
      kind,
      name,
      contactEmail,
      participationMode,
      status: "active", // MVP: skip the pending_approval state for self-serve
      operatingRegions,
      vehicleTypes,
      bookingTypes: bookingTypes.length ? bookingTypes : ["asap"],
      adapterKey,
      credentials: { tenantLabel },
    })
    .returning();

  // Auto-create mutual allow rules with every existing active partner.
  // The user can revoke on the Allow/Block page.
  const existing = await db.select().from(partners).where(eq(partners.status, "active"));
  const others = existing.filter((p) => p.id !== created.id);
  if (others.length) {
    await db.insert(partnerRules).values(
      others.flatMap((p) => [
        { originatorId: created.id, recipientId: p.id, rule: "allow" as const },
        { originatorId: p.id, recipientId: created.id, rule: "allow" as const },
      ]),
    );
  }

  await db.insert(auditLog).values({
    category: "admin",
    actor: "admin_user",
    actorRef: "portal",
    action: "partner.created",
    subjectType: "partner",
    subjectId: created.id,
    after: created as unknown as Record<string, unknown>,
  });

  revalidatePath("/partners");
  revalidatePath("/rules");
  redirect(`/partners/${created.id}`);
}

export default async function NewPartnerPage() {
  await requireSuperAdmin();
  return (
    <div style={{ maxWidth: 640 }}>
      <h1>Add a partner</h1>
      <p style={{ color: "#64748b" }}>
        Adds a partner to the network and creates mutual allow rules with every existing active
        partner. You can revoke any of those rules on the{" "}
        <a href="/rules">Allow/Block</a> page before sending a test booking.
      </p>

      <form action={createPartnerAction} style={{ display: "grid", gap: 16, marginTop: 24 }}>
        <Field label="Name">
          <input name="name" required placeholder="e.g. Galway Taxis" style={input} />
        </Field>

        <Field label="Kind">
          <select name="kind" defaultValue="icabbi_fleet" style={input}>
            <option value="icabbi_fleet">iCabbi fleet</option>
            <option value="external_corporate">External corporate (CMAC-shaped)</option>
            <option value="external_aggregator">External aggregator (FreeNow / Uber)</option>
          </select>
        </Field>

        <Field label="Participation mode">
          <select name="participationMode" defaultValue="send_and_receive" style={input}>
            <option value="send_and_receive">Send and receive</option>
            <option value="send_only">Send only (push overflow out)</option>
            <option value="receive_only">Receive only (take inbound from network)</option>
            <option value="inactive">Inactive</option>
          </select>
        </Field>

        <Field label="Operating regions" hint="Comma-separated, e.g. IE-D, IE-G, GB">
          <input name="operatingRegions" defaultValue="IE-D" style={input} />
        </Field>

        <Field label="Vehicle types accepted" hint="Comma-separated, e.g. standard, exec, wav">
          <input name="vehicleTypes" defaultValue="standard, exec" style={input} />
        </Field>

        <Field label="Booking types">
          <label style={{ marginRight: 16 }}>
            <input type="checkbox" name="acceptsAsap" defaultChecked /> ASAP
          </label>
          <label>
            <input type="checkbox" name="acceptsPrebook" defaultChecked /> Pre-book
          </label>
        </Field>

        <Field label="Contact email" hint="Optional">
          <input name="contactEmail" type="email" placeholder="ops@example.com" style={input} />
        </Field>

        <Field
          label="Tenant label"
          hint="iCabbi tenant identifier — defaults to slugified name. Used by the mock adapter; in production this is replaced by real credentials."
        >
          <input name="tenantLabel" placeholder="dublin" style={input} />
        </Field>

        <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
          <button type="submit" style={primaryBtn}>Add partner</button>
          <a href="/partners" style={secondaryBtn}>Cancel</a>
        </div>
      </form>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <span style={{ fontWeight: 600, fontSize: 14 }}>{label}</span>
      {hint && <span style={{ fontSize: 12, color: "#64748b" }}>{hint}</span>}
      {children}
    </label>
  );
}

const input: React.CSSProperties = {
  padding: "8px 10px",
  fontSize: 14,
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  background: "white",
};

const primaryBtn: React.CSSProperties = {
  padding: "10px 16px",
  fontSize: 14,
  fontWeight: 600,
  background: "#0f172a",
  color: "white",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
};

const secondaryBtn: React.CSSProperties = {
  padding: "10px 16px",
  fontSize: 14,
  background: "white",
  color: "#0f172a",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  textDecoration: "none",
  display: "inline-block",
};
