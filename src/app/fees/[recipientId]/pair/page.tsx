import { db } from "@/db/client";
import { partners, feeConfigs, auditLog } from "@/db/schema";
import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/auth";
import Link from "next/link";

export const dynamic = "force-dynamic";

/**
 * /fees/[recipientId]/pair — manage pair-level fee overrides for one recipient.
 *
 * A pair override applies only when a specific originator sends to this
 * recipient. Used for negotiated affiliate rates (Blue Line hub model,
 * King County WAV special pricing).
 *
 * resolveFeeSnapshot (src/lib/fees.ts) already checks pair overrides before
 * falling back to the partner default — saving a row here makes it live
 * immediately. Old pair rows are closed out (effectiveTo = now) on update,
 * preserving the audit trail without affecting in-flight bookings.
 */

async function savePairAction(formData: FormData) {
  "use server";
  await requireSuperAdmin();

  const recipientId = String(formData.get("recipientId") ?? "");
  const originatorId = String(formData.get("originatorId") ?? "");
  if (!recipientId || !originatorId || recipientId === originatorId) return;

  const newRow = {
    scope: "pair" as const,
    originatorId,
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

  const now = new Date();
  const [previous] = await db
    .select()
    .from(feeConfigs)
    .where(
      and(
        eq(feeConfigs.scope, "pair"),
        eq(feeConfigs.originatorId, originatorId),
        eq(feeConfigs.recipientId, recipientId),
        lte(feeConfigs.effectiveFrom, now),
        or(isNull(feeConfigs.effectiveTo), gte(feeConfigs.effectiveTo, now)),
      ),
    )
    .orderBy(desc(feeConfigs.effectiveFrom))
    .limit(1);

  if (previous) {
    await db.update(feeConfigs).set({ effectiveTo: now }).where(eq(feeConfigs.id, previous.id));
  }
  const [inserted] = await db.insert(feeConfigs).values(newRow).returning();

  await db.insert(auditLog).values({
    category: "fee",
    actor: "admin_user",
    actorRef: "portal",
    action: previous ? "pair_fee.updated" : "pair_fee.created",
    subjectType: "fee_pair",
    subjectId: `${originatorId}->${recipientId}`,
    before: previous ?? null,
    after: inserted,
  });

  revalidatePath(`/fees/${recipientId}/pair`);
  redirect(`/fees/${recipientId}/pair?saved=1&originator=${originatorId}`);
}

async function removePairAction(formData: FormData) {
  "use server";
  await requireSuperAdmin();

  const recipientId = String(formData.get("recipientId") ?? "");
  const originatorId = String(formData.get("originatorId") ?? "");
  if (!recipientId || !originatorId) return;

  // Soft-end: don't delete the row, just set effectiveTo so resolver stops
  // picking it up. Keeps audit/history intact.
  const now = new Date();
  const [active] = await db
    .select()
    .from(feeConfigs)
    .where(
      and(
        eq(feeConfigs.scope, "pair"),
        eq(feeConfigs.originatorId, originatorId),
        eq(feeConfigs.recipientId, recipientId),
        lte(feeConfigs.effectiveFrom, now),
        or(isNull(feeConfigs.effectiveTo), gte(feeConfigs.effectiveTo, now)),
      ),
    )
    .orderBy(desc(feeConfigs.effectiveFrom))
    .limit(1);

  if (active) {
    await db.update(feeConfigs).set({ effectiveTo: now }).where(eq(feeConfigs.id, active.id));
    await db.insert(auditLog).values({
      category: "fee",
      actor: "admin_user",
      actorRef: "portal",
      action: "pair_fee.removed",
      subjectType: "fee_pair",
      subjectId: `${originatorId}->${recipientId}`,
      before: active,
    });
  }

  revalidatePath(`/fees/${recipientId}/pair`);
  redirect(`/fees/${recipientId}/pair?removed=1`);
}

function parsePence(raw: FormDataEntryValue | null) {
  const n = Number(String(raw ?? "0").trim());
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}
function parsePercentBps(raw: FormDataEntryValue | null) {
  const pct = Number(String(raw ?? "0").trim());
  return Number.isFinite(pct) && pct >= 0 ? Math.round(pct * 100) : 0;
}

export default async function PairFeesPage({
  params,
  searchParams,
}: {
  params: Promise<{ recipientId: string }>;
  searchParams: Promise<{ saved?: string; removed?: string; originator?: string }>;
}) {
  await requireSuperAdmin();
  const { recipientId } = await params;
  const sp = await searchParams;

  const [recipient] = await db.select().from(partners).where(eq(partners.id, recipientId));
  if (!recipient) notFound();

  // All active originators except the recipient itself
  const otherPartners = await db
    .select()
    .from(partners)
    .where(eq(partners.status, "active"))
    .orderBy(partners.name);
  const candidates = otherPartners.filter((p) => p.id !== recipientId);

  // Current active pair overrides for this recipient
  const now = new Date();
  const active = await db
    .select()
    .from(feeConfigs)
    .where(
      and(
        eq(feeConfigs.scope, "pair"),
        eq(feeConfigs.recipientId, recipientId),
        lte(feeConfigs.effectiveFrom, now),
        or(isNull(feeConfigs.effectiveTo), gte(feeConfigs.effectiveTo, now)),
      ),
    )
    .orderBy(desc(feeConfigs.effectiveFrom));

  const activeByOriginator = new Map(active.map((c) => [c.originatorId, c]));

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-ink-muted font-semibold">Pair overrides</p>
          <h1 className="text-3xl font-bold tracking-tight mt-1">{recipient.name}</h1>
          <p className="text-sm text-ink-muted mt-2 max-w-2xl">
            Override the partner-default fees for specific originators sending to{" "}
            <strong>{recipient.name}</strong>. Used for negotiated affiliate rates and
            commercial agreements that differ from the network standard.
          </p>
        </div>
        <Link href="/fees" className="text-sm text-ink-muted hover:text-ink">← All partner fees</Link>
      </div>

      {sp.saved === "1" && <Banner tone="success">Pair override saved.</Banner>}
      {sp.removed === "1" && <Banner tone="warning">Pair override removed — fees revert to partner default for new bookings from this originator.</Banner>}

      <div className="grid gap-4">
        {candidates.map((originator) => {
          const cfg = activeByOriginator.get(originator.id);
          return (
            <details
              key={originator.id}
              open={!!cfg || sp.originator === originator.id}
              className="card"
            >
              <summary className="px-5 py-4 cursor-pointer flex items-center justify-between hover:bg-surface-muted">
                <div>
                  <div className="font-medium">{originator.name} → {recipient.name}</div>
                  <div className="text-xs text-ink-subtle">{originator.kind.replace("_", " ")}</div>
                </div>
                <span className={cfg ? "badge-info" : "badge-neutral"}>
                  {cfg ? "override active" : "uses partner default"}
                </span>
              </summary>
              <div className="px-5 pb-5">
                <form action={savePairAction} className="grid gap-4 mt-2">
                  <input type="hidden" name="recipientId" value={recipientId} />
                  <input type="hidden" name="originatorId" value={originator.id} />

                  <fieldset>
                    <legend className="text-xs uppercase tracking-wide font-semibold text-ink-muted mb-2">
                      Network fees
                    </legend>
                    <div className="grid grid-cols-2 gap-3">
                      <label>
                        <span className="label">Send fee (p)</span>
                        <input name="sendFee" type="number" min={0} className="input" defaultValue={cfg?.sendFeePence ?? 20} />
                      </label>
                      <label>
                        <span className="label">Receive fee (p)</span>
                        <input name="receiveFee" type="number" min={0} className="input" defaultValue={cfg?.receiveFeePence ?? 40} />
                      </label>
                    </div>
                  </fieldset>

                  <fieldset>
                    <legend className="text-xs uppercase tracking-wide font-semibold text-ink-muted mb-2">
                      Trip fees (passenger-facing)
                    </legend>
                    <div className="grid grid-cols-3 gap-3">
                      <label>
                        <span className="label">Tech fixed (p)</span>
                        <input name="techFeeFixed" type="number" min={0} className="input" defaultValue={cfg?.techFeePence ?? 0} />
                      </label>
                      <label>
                        <span className="label">Tech % of fare</span>
                        <input name="techFeePct" type="number" step="0.1" min={0} className="input" defaultValue={cfg ? cfg.techFeeBps / 100 : 0} />
                      </label>
                      <label>
                        <span className="label">Booking fixed (p)</span>
                        <input name="bookingFee" type="number" min={0} className="input" defaultValue={cfg?.bookingFeePence ?? 0} />
                      </label>
                      <label>
                        <span className="label">Admin fixed (p)</span>
                        <input name="adminFeeFixed" type="number" min={0} className="input" defaultValue={cfg?.adminFeePence ?? 0} />
                      </label>
                      <label>
                        <span className="label">Admin % of fare</span>
                        <input name="adminFeePct" type="number" step="0.1" min={0} className="input" defaultValue={cfg ? cfg.adminFeeBps / 100 : 0} />
                      </label>
                    </div>
                  </fieldset>

                  <fieldset>
                    <legend className="text-xs uppercase tracking-wide font-semibold text-ink-muted mb-2">
                      Applies to
                    </legend>
                    <div className="flex gap-4 flex-wrap text-sm">
                      <label><input type="checkbox" name="applyToAsap" defaultChecked={cfg?.applyToAsap ?? true} /> ASAP</label>
                      <label><input type="checkbox" name="applyToPrebook" defaultChecked={cfg?.applyToPrebook ?? true} /> Pre-book</label>
                      <span className="border-l border-border-strong pl-4">
                        {(["app", "web", "phone", "api"] as const).map((c) => (
                          <label key={c} className="mr-3">
                            <input
                              type="checkbox"
                              name={`channel_${c}`}
                              defaultChecked={cfg ? cfg.applyToChannels.includes(c) : true}
                            />{" "}
                            {c}
                          </label>
                        ))}
                      </span>
                    </div>
                  </fieldset>

                  <div className="flex items-center gap-3 pt-2">
                    <button type="submit" className="btn-primary">
                      {cfg ? "Update override" : "Add override"}
                    </button>
                    {cfg && (
                      <form action={removePairAction} className="inline">
                        <input type="hidden" name="recipientId" value={recipientId} />
                        <input type="hidden" name="originatorId" value={originator.id} />
                        <button type="submit" className="btn-danger">Remove override</button>
                      </form>
                    )}
                    {cfg?.effectiveFrom && (
                      <span className="text-xs text-ink-muted ml-auto">
                        Effective since {new Date(cfg.effectiveFrom).toLocaleString()}
                      </span>
                    )}
                  </div>
                </form>
              </div>
            </details>
          );
        })}
        {candidates.length === 0 && (
          <p className="text-center text-sm text-ink-muted py-8">
            No other partners to set overrides against yet.
          </p>
        )}
      </div>
    </div>
  );
}

function Banner({ tone, children }: { tone: "success" | "warning"; children: React.ReactNode }) {
  const cls = tone === "success" ? "bg-success text-success-fg" : "bg-warning text-warning-fg";
  return <div className={`p-3 rounded-md text-sm ${cls}`}>{children}</div>;
}
