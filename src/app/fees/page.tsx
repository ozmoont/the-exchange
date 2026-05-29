import { db } from "@/db/client";
import { partners, feeConfigs, auditLog } from "@/db/schema";
import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * /fees — per-partner default fee config editor.
 *
 * Shows a card for every active partner. Each card displays the currently-
 * effective `scope: "partner"` config (or the system default fallback) and
 * lets you save a new config. Saving:
 *   - Closes the previous row (sets effectiveTo = now)
 *   - Inserts a new row with effectiveFrom = now
 *   - Writes an audit_log entry
 *
 * Pair-level overrides (originator → recipient specific) are scoped out of V1
 * — they remain SQL-only until a real customer needs the UI.
 */

type EffectiveConfig = {
  id: string | null; // null = system default fallback
  sendFeePence: number;
  receiveFeePence: number;
  techFeePence: number;
  techFeeBps: number;
  bookingFeePence: number;
  adminFeePence: number;
  adminFeeBps: number;
  applyToAsap: boolean;
  applyToPrebook: boolean;
  applyToChannels: ("app" | "web" | "phone" | "api")[];
  effectiveFrom: Date | null;
};

const SYSTEM_DEFAULT: EffectiveConfig = {
  id: null,
  sendFeePence: 20,
  receiveFeePence: 40,
  techFeePence: 0,
  techFeeBps: 0,
  bookingFeePence: 0,
  adminFeePence: 0,
  adminFeeBps: 0,
  applyToAsap: true,
  applyToPrebook: true,
  applyToChannels: ["app", "web", "phone", "api"],
  effectiveFrom: null,
};

async function saveFeeConfig(formData: FormData) {
  "use server";
  const recipientId = String(formData.get("recipientId") ?? "");
  if (!recipientId) return;

  const newRow = {
    scope: "partner" as const,
    recipientId,
    sendFeePence: parsePence(formData.get("sendFee")),
    receiveFeePence: parsePence(formData.get("receiveFee")),
    techFeePence: parsePence(formData.get("techFeeFixed")),
    techFeeBps: parsePercentBps(formData.get("techFeePct")),
    bookingFeePence: parsePence(formData.get("bookingFee")),
    adminFeePence: parsePence(formData.get("adminFeeFixed")),
    adminFeeBps: parsePercentBps(formData.get("adminFeePct")),
    applyToAsap: formData.get("applyToAsap") === "on",
    applyToPrebook: formData.get("applyToPrebook") === "on",
    applyToChannels: (["app", "web", "phone", "api"] as const).filter(
      (c) => formData.get(`channel_${c}`) === "on",
    ),
    createdBy: "portal",
  };

  // Snapshot the previous effective row for the audit log
  const now = new Date();
  const [previous] = await db
    .select()
    .from(feeConfigs)
    .where(
      and(
        eq(feeConfigs.scope, "partner"),
        eq(feeConfigs.recipientId, recipientId),
        lte(feeConfigs.effectiveFrom, now),
        or(isNull(feeConfigs.effectiveTo), gte(feeConfigs.effectiveTo, now)),
      ),
    )
    .orderBy(desc(feeConfigs.effectiveFrom))
    .limit(1);

  if (previous) {
    await db
      .update(feeConfigs)
      .set({ effectiveTo: now })
      .where(eq(feeConfigs.id, previous.id));
  }

  const [inserted] = await db.insert(feeConfigs).values(newRow).returning();

  await db.insert(auditLog).values({
    category: "fee",
    actor: "admin_user",
    actorRef: "portal",
    action: previous ? "fee.updated" : "fee.created",
    subjectType: "partner",
    subjectId: recipientId,
    before: previous ?? null,
    after: inserted,
  });

  revalidatePath("/fees");
}

function parsePence(raw: FormDataEntryValue | null): number {
  const n = Number(String(raw ?? "0").trim());
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

function parsePercentBps(raw: FormDataEntryValue | null): number {
  // input is a percentage (e.g. "3" or "3.0"); stored as basis points
  const pct = Number(String(raw ?? "0").trim());
  return Number.isFinite(pct) && pct >= 0 ? Math.round(pct * 100) : 0;
}

export default async function FeesPage({
  searchParams,
}: {
  searchParams: Promise<{ partner?: string }>;
}) {
  await requireSuperAdmin();
  const sp = await searchParams;
  const filterPartnerId = sp.partner ?? null;

  const allPartners = await db
    .select()
    .from(partners)
    .where(eq(partners.status, "active"))
    .orderBy(partners.name);

  const now = new Date();
  const effectiveConfigs = await db
    .select()
    .from(feeConfigs)
    .where(
      and(
        eq(feeConfigs.scope, "partner"),
        lte(feeConfigs.effectiveFrom, now),
        or(isNull(feeConfigs.effectiveTo), gte(feeConfigs.effectiveTo, now)),
      ),
    )
    .orderBy(desc(feeConfigs.effectiveFrom));

  // Map by recipient — first hit wins because of the DESC order
  const byRecipient = new Map<string, EffectiveConfig>();
  for (const c of effectiveConfigs) {
    if (byRecipient.has(c.recipientId)) continue;
    byRecipient.set(c.recipientId, {
      id: c.id,
      sendFeePence: c.sendFeePence,
      receiveFeePence: c.receiveFeePence,
      techFeePence: c.techFeePence,
      techFeeBps: c.techFeeBps,
      bookingFeePence: c.bookingFeePence,
      adminFeePence: c.adminFeePence,
      adminFeeBps: c.adminFeeBps,
      applyToAsap: c.applyToAsap,
      applyToPrebook: c.applyToPrebook,
      applyToChannels: c.applyToChannels,
      effectiveFrom: c.effectiveFrom,
    });
  }

  const visiblePartners = filterPartnerId
    ? allPartners.filter((p) => p.id === filterPartnerId)
    : allPartners;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ margin: 0 }}>Fees</h1>
        {filterPartnerId && (
          <a href="/fees" style={{ fontSize: 14, color: "#0f172a" }}>
            ← View all partners
          </a>
        )}
      </div>
      <p style={{ color: "#64748b" }}>
        Per-partner default fees applied when a booking is routed to this partner. Network fees
        (send / receive) flow between iCabbi and the partner fleets. Trip fees (tech / booking /
        admin) are added to the passenger fare and travel with the booking payload — required by
        the King County WAV service and Blue Line affiliate billing. Changes take effect immediately
        and apply to new bookings only.
      </p>
      <p style={{ color: "#64748b", fontSize: 13, marginTop: -8 }}>
        Need different rates for a specific originator → recipient pair? Each partner card
        below has a <em>Pair overrides</em> link.
      </p>

      <div style={{ display: "grid", gap: 16, marginTop: 24 }}>
        {visiblePartners.map((p) => {
          const cfg = byRecipient.get(p.id) ?? SYSTEM_DEFAULT;
          const isCustom = cfg.id !== null;
          return (
            <div
              key={p.id}
              style={{
                background: "white",
                border: "1px solid #e2e8f0",
                borderRadius: 8,
                padding: 16,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: 16 }}>{p.name}</h2>
                  <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
                    {p.kind} · adapter <code>{p.adapterKey}</code>
                    {isCustom && cfg.effectiveFrom && (
                      <> · effective from {cfg.effectiveFrom.toLocaleString()}</>
                    )}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  <a
                    href={`/fees/${p.id}/pair`}
                    style={{ fontSize: 12, color: "#0f172a", textDecoration: "underline" }}
                  >
                    Pair overrides →
                  </a>
                  <span
                    style={{
                      fontSize: 11,
                      padding: "2px 8px",
                      borderRadius: 999,
                      background: isCustom ? "#dcfce7" : "#f1f5f9",
                      color: isCustom ? "#166534" : "#475569",
                    }}
                  >
                    {isCustom ? "custom config" : "system default"}
                  </span>
                </div>
              </div>

              <form
                action={saveFeeConfig}
                style={{ display: "grid", gap: 12, marginTop: 16 }}
              >
                <input type="hidden" name="recipientId" value={p.id} />

                <Section label="Network fees (between iCabbi and partner fleets)">
                  <div style={twoCol}>
                    <Field label="Send fee (pence)" hint="Paid to originator when they send to this partner">
                      <input
                        name="sendFee"
                        type="number"
                        min={0}
                        step={1}
                        defaultValue={cfg.sendFeePence}
                        style={input}
                      />
                    </Field>
                    <Field label="Receive fee (pence)" hint="Charged to this partner when they receive a booking">
                      <input
                        name="receiveFee"
                        type="number"
                        min={0}
                        step={1}
                        defaultValue={cfg.receiveFeePence}
                        style={input}
                      />
                    </Field>
                  </div>
                </Section>

                <Section label="Trip fees (passenger-facing, travel with the booking)">
                  <div style={threeCol}>
                    <Field label="Tech fee fixed (p)">
                      <input
                        name="techFeeFixed"
                        type="number"
                        min={0}
                        step={1}
                        defaultValue={cfg.techFeePence}
                        style={input}
                      />
                    </Field>
                    <Field label="Tech fee % of fare">
                      <input
                        name="techFeePct"
                        type="number"
                        min={0}
                        step="0.1"
                        defaultValue={cfg.techFeeBps / 100}
                        style={input}
                      />
                    </Field>
                    <Field label="Booking fee fixed (p)">
                      <input
                        name="bookingFee"
                        type="number"
                        min={0}
                        step={1}
                        defaultValue={cfg.bookingFeePence}
                        style={input}
                      />
                    </Field>
                    <Field label="Admin fee fixed (p)">
                      <input
                        name="adminFeeFixed"
                        type="number"
                        min={0}
                        step={1}
                        defaultValue={cfg.adminFeePence}
                        style={input}
                      />
                    </Field>
                    <Field label="Admin fee % of fare">
                      <input
                        name="adminFeePct"
                        type="number"
                        min={0}
                        step="0.1"
                        defaultValue={cfg.adminFeeBps / 100}
                        style={input}
                      />
                    </Field>
                  </div>
                </Section>

                <Section label="Applies to">
                  <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
                    <label>
                      <input type="checkbox" name="applyToAsap" defaultChecked={cfg.applyToAsap} /> ASAP
                    </label>
                    <label>
                      <input type="checkbox" name="applyToPrebook" defaultChecked={cfg.applyToPrebook} /> Pre-book
                    </label>
                    <span style={{ borderLeft: "1px solid #cbd5e1", paddingLeft: 16 }}>
                      {(["app", "web", "phone", "api"] as const).map((c) => (
                        <label key={c} style={{ marginRight: 12 }}>
                          <input
                            type="checkbox"
                            name={`channel_${c}`}
                            defaultChecked={cfg.applyToChannels.includes(c)}
                          />{" "}
                          {c}
                        </label>
                      ))}
                    </span>
                  </div>
                </Section>

                <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 8 }}>
                  <button type="submit" style={primaryBtn}>
                    Save fees
                  </button>
                  <span style={{ fontSize: 12, color: "#64748b" }}>
                    Saves a new config row effective immediately; old row is closed out and retained for audit.
                  </span>
                </div>
              </form>
            </div>
          );
        })}

        {visiblePartners.length === 0 && (
          <div
            style={{
              padding: 24,
              background: "white",
              border: "1px solid #e2e8f0",
              borderRadius: 8,
              color: "#64748b",
              textAlign: "center",
            }}
          >
            No active partners yet. <a href="/partners/new">Add one →</a>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "#475569",
          marginBottom: 6,
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 4 }}>
      <span style={{ fontSize: 12, fontWeight: 600 }}>{label}</span>
      {hint && <span style={{ fontSize: 11, color: "#64748b" }}>{hint}</span>}
      {children}
    </label>
  );
}

const input: React.CSSProperties = {
  padding: "6px 8px",
  fontSize: 13,
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  background: "white",
};

const twoCol: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 };
const threeCol: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 };

const primaryBtn: React.CSSProperties = {
  padding: "8px 16px",
  fontSize: 13,
  fontWeight: 600,
  background: "#0f172a",
  color: "white",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
};
