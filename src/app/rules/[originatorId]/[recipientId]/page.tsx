import { db } from "@/db/client";
import { partners, partnerRules, auditLog } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Link from "next/link";

export const dynamic = "force-dynamic";

/**
 * /rules/[originatorId]/[recipientId] — edit the rule for one direction.
 * Shows both directions so the editor sees whether mutual allow is in place.
 */

async function saveRuleAction(formData: FormData) {
  "use server";
  const originatorId = String(formData.get("originatorId") ?? "");
  const recipientId = String(formData.get("recipientId") ?? "");
  const target = String(formData.get("target") ?? "clear") as "allow" | "block" | "clear";
  if (!originatorId || !recipientId || originatorId === recipientId) return;

  const [existing] = await db
    .select()
    .from(partnerRules)
    .where(and(eq(partnerRules.originatorId, originatorId), eq(partnerRules.recipientId, recipientId)));

  if (target === "clear") {
    if (existing) {
      await db
        .delete(partnerRules)
        .where(and(eq(partnerRules.originatorId, originatorId), eq(partnerRules.recipientId, recipientId)));
    }
  } else if (existing) {
    if (existing.rule !== target) {
      await db
        .update(partnerRules)
        .set({ rule: target, updatedAt: new Date() })
        .where(and(eq(partnerRules.originatorId, originatorId), eq(partnerRules.recipientId, recipientId)));
    }
  } else {
    await db.insert(partnerRules).values({ originatorId, recipientId, rule: target });
  }

  await db.insert(auditLog).values({
    category: "permission",
    actor: "admin_user",
    actorRef: "portal",
    action: `rule.${target}`,
    subjectType: "partner_rule",
    subjectId: `${originatorId}->${recipientId}`,
    before: existing ?? null,
    after: target === "clear" ? null : { originatorId, recipientId, rule: target },
  });

  revalidatePath("/rules");
  redirect("/rules");
}

export default async function EditRulePage({
  params,
}: {
  params: Promise<{ originatorId: string; recipientId: string }>;
}) {
  const { originatorId, recipientId } = await params;

  const [originator] = await db.select().from(partners).where(eq(partners.id, originatorId));
  const [recipient] = await db.select().from(partners).where(eq(partners.id, recipientId));
  if (!originator || !recipient || originator.id === recipient.id) notFound();

  const [forward] = await db
    .select()
    .from(partnerRules)
    .where(and(eq(partnerRules.originatorId, originatorId), eq(partnerRules.recipientId, recipientId)));

  const [reverse] = await db
    .select()
    .from(partnerRules)
    .where(and(eq(partnerRules.originatorId, recipientId), eq(partnerRules.recipientId, originatorId)));

  const currentForward = forward?.rule ?? "none";
  const currentReverse = reverse?.rule ?? "none";
  const routes = currentForward === "allow" && currentReverse === "allow";

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-ink-muted font-semibold">
            Rule editor
          </p>
          <h1 className="text-3xl font-bold tracking-tight mt-1">
            {originator.name} → {recipient.name}
          </h1>
          <p className="text-sm text-ink-muted mt-2 max-w-2xl">
            You&apos;re editing one direction. Routing requires both directions to be allow —
            the reverse direction&apos;s current state is shown on the right.
          </p>
        </div>
        <Link href="/rules" className="text-sm text-ink-muted hover:text-ink">← Back to routing</Link>
      </div>

      <div
        className={`p-3 rounded-md text-sm ${
          routes ? "bg-success text-success-fg" : "bg-warning text-warning-fg"
        }`}
      >
        <strong>Current state:</strong>{" "}
        {routes
          ? "Bookings route between these partners (both directions are allow)."
          : "Bookings do NOT route between these partners. For routing to work, both directions must be allow."}
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <DirectionCard
          title={`${originator.name} → ${recipient.name}`}
          subtitle="You are editing this direction"
          current={currentForward}
          highlighted
        />
        <DirectionCard
          title={`${recipient.name} → ${originator.name}`}
          subtitle={
            currentReverse === "allow"
              ? "OK — reverse direction is already allow"
              : currentReverse === "block"
              ? `Blocked — ${recipient.name} also needs to allow ${originator.name} for routing`
              : `No rule — you'll need to set this direction too`
          }
          current={currentReverse}
          editHref={`/rules/${recipientId}/${originatorId}`}
        />
      </div>

      <form action={saveRuleAction} className="space-y-4">
        <input type="hidden" name="originatorId" value={originatorId} />
        <input type="hidden" name="recipientId" value={recipientId} />

        <fieldset className="card p-5">
          <legend className="px-2 font-semibold">
            Set rule for {originator.name} → {recipient.name}
          </legend>

          <div className="space-y-2 mt-2">
            <RadioRow
              value="allow"
              label="Allow"
              description={`${originator.name} can send bookings to ${recipient.name}. Combine with reverse-direction allow for routing to actually happen.`}
              defaultChecked={currentForward === "allow"}
            />
            <RadioRow
              value="block"
              label="Block"
              description={`Explicitly prevent bookings from ${originator.name} to ${recipient.name}. Useful if you want to disconnect them while leaving other connections intact.`}
              defaultChecked={currentForward === "block"}
            />
            <RadioRow
              value="clear"
              label="No rule"
              description="Remove any rule. Behaves the same as a block (no routing) but doesn't leave a record. Use when you just want to undo a previous decision."
              defaultChecked={currentForward === "none"}
            />
          </div>
        </fieldset>

        <div className="flex items-center gap-4">
          <button type="submit" className="btn-primary">Save and return to matrix</button>
          <Link href="/rules" className="text-sm text-ink-muted hover:text-ink">Cancel</Link>
        </div>
      </form>
    </div>
  );
}

function DirectionCard({
  title,
  subtitle,
  current,
  highlighted,
  editHref,
}: {
  title: string;
  subtitle: string;
  current: string;
  highlighted?: boolean;
  editHref?: string;
}) {
  return (
    <div className={`card p-5 ${highlighted ? "border-ink" : ""}`}>
      <div className="text-xs uppercase tracking-wide text-ink-subtle font-semibold">
        {highlighted ? "Editing" : "Reverse direction"}
      </div>
      <div className="font-semibold mt-1">{title}</div>
      <div className="mt-2">
        <RuleBadge value={current} />
      </div>
      <div className="text-xs text-ink-muted mt-2 min-h-[2rem]">{subtitle}</div>
      {editHref && (
        <Link href={editHref} className="text-sm text-ink hover:underline">
          Edit this direction →
        </Link>
      )}
    </div>
  );
}

function RuleBadge({ value }: { value: string }) {
  const cls =
    value === "allow" ? "badge-success" :
    value === "block" ? "badge-danger" :
    "badge-neutral";
  return <span className={cls}>{value === "none" ? "no rule" : value}</span>;
}

function RadioRow({
  value,
  label,
  description,
  defaultChecked,
}: {
  value: string;
  label: string;
  description: string;
  defaultChecked: boolean;
}) {
  return (
    <label className="grid grid-cols-[auto_1fr] gap-3 p-3 rounded-md border border-border cursor-pointer hover:bg-surface-muted has-[:checked]:bg-info/30 has-[:checked]:border-accent">
      <input
        type="radio"
        name="target"
        value={value}
        defaultChecked={defaultChecked}
        className="mt-1"
      />
      <div>
        <div className="font-semibold">{label}</div>
        <div className="text-sm text-ink-muted mt-0.5">{description}</div>
      </div>
    </label>
  );
}
