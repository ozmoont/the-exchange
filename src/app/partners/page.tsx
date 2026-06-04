import { db } from "@/db/client";
import { partners, auditLog } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { requireUser, requireSuperAdmin } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import Link from "next/link";

export const dynamic = "force-dynamic";

/**
 * /partners — partner directory.
 *
 *   Super admins see the full network with suspend/activate quick actions.
 *   Fleet roles see only their own partner.
 */

async function setStatusAction(formData: FormData) {
  "use server";
  const actor = await requireSuperAdmin();
  const id = String(formData.get("id") ?? "");
  const next = String(formData.get("status") ?? "") as
    | "active"
    | "warning"
    | "suspended"
    | "pending_approval";
  if (!id || !next) return;

  const [before] = await db.select().from(partners).where(eq(partners.id, id));
  if (!before) return;

  // P1-E3 idempotency: if the admin is re-activating a partner that auto-
  // suspend caught, set a 7-day cooldown so we don't immediately re-suspend
  // on the same stale acceptance metrics. Doesn't apply when going to
  // statuses other than 'active'.
  const COOLDOWN_DAYS = 7;
  const updateFields: { status: typeof next; updatedAt: Date; autoSuspendCooldownUntil?: Date; statusReason?: null } = {
    status: next,
    updatedAt: new Date(),
  };
  if (next === "active" && (before.status === "suspended" || before.status === "warning")) {
    updateFields.autoSuspendCooldownUntil = new Date(Date.now() + COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
    updateFields.statusReason = null;
  }

  await db.update(partners).set(updateFields).where(eq(partners.id, id));

  await db.insert(auditLog).values({
    category: "admin",
    actor: "admin_user",
    actorRef: actor.email,
    action: `partner.${next === "active" ? "activated" : next === "suspended" ? "suspended" : `status_${next}`}`,
    subjectType: "partner",
    subjectId: id,
    before: { status: before.status },
    after: {
      status: next,
      ...(updateFields.autoSuspendCooldownUntil
        ? { autoSuspendCooldownUntil: updateFields.autoSuspendCooldownUntil.toISOString() }
        : {}),
    },
  });

  revalidatePath("/partners");
  revalidatePath(`/partners/${id}`);
  revalidatePath("/audit");
}

export default async function PartnersPage() {
  const user = await requireUser();
  const isSuper = user.role === "super_admin";

  const rows = isSuper
    ? await db.select().from(partners).orderBy(desc(partners.createdAt))
    : user.partnerId
    ? await db.select().from(partners).where(eq(partners.id, user.partnerId))
    : [];

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-ink-muted font-semibold">
            {isSuper ? "Network directory" : "Your fleet"}
          </p>
          <h1 className="text-3xl font-bold tracking-tight mt-1">
            {isSuper ? "Partners" : rows[0]?.name ?? "No fleet assigned"}
          </h1>
          {isSuper && (
            <p className="text-sm text-ink-muted mt-2 max-w-2xl">
              Every iCabbi fleet and external partner on The Exchange. Click a row to drill in;
              use the quick actions to suspend or reactivate without leaving the list.
            </p>
          )}
        </div>
        {isSuper && (
          <Link href="/partners/new" className="btn-primary">+ Add partner</Link>
        )}
      </div>

      <div className="card overflow-hidden">
        {rows.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-ink-muted">
            {isSuper
              ? <>No partners yet. <Link href="/partners/new" className="text-accent hover:underline">Add the first →</Link></>
              : "Your account isn't associated with a partner yet. Ask a super admin to assign you."}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-ink-subtle">
              <tr>
                <th className="text-left px-5 py-3 font-semibold">Name</th>
                <th className="text-left px-5 py-3 font-semibold">Kind</th>
                <th className="text-left px-5 py-3 font-semibold">Adapter</th>
                <th className="text-left px-5 py-3 font-semibold">Mode</th>
                <th className="text-left px-5 py-3 font-semibold">Status</th>
                <th className="text-left px-5 py-3 font-semibold">Regions</th>
                {isSuper && <th className="text-right px-5 py-3 font-semibold">Quick action</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((p) => (
                <tr key={p.id} className="hover:bg-surface-muted">
                  <td className="px-5 py-3">
                    <Link href={`/partners/${p.id}`} className="font-medium text-ink hover:underline">
                      {p.name}
                    </Link>
                    <div className="text-xs text-ink-subtle font-mono mt-0.5">{p.id.slice(0, 8)}…</div>
                  </td>
                  <td className="px-5 py-3 text-ink-muted">{p.kind.replace("_", " ")}</td>
                  <td className="px-5 py-3">
                    <code className="text-xs">{p.adapterKey}</code>
                  </td>
                  <td className="px-5 py-3 text-ink-muted">{p.participationMode.replace(/_/g, " ")}</td>
                  <td className="px-5 py-3">
                    <Badge status={p.status} />
                  </td>
                  <td className="px-5 py-3 text-xs text-ink-muted">
                    {p.operatingRegions.length ? p.operatingRegions.join(", ") : <span className="text-ink-subtle">—</span>}
                  </td>
                  {isSuper && (
                    <td className="px-5 py-3 text-right">
                      <QuickActions partner={p} action={setStatusAction} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function QuickActions({
  partner,
  action,
}: {
  partner: { id: string; status: string };
  action: (formData: FormData) => void;
}) {
  // Show "Suspend" for active/warning, "Activate" for suspended/pending
  if (partner.status === "active" || partner.status === "warning") {
    return (
      <form action={action} className="inline">
        <input type="hidden" name="id" value={partner.id} />
        <input type="hidden" name="status" value="suspended" />
        <button type="submit" className="text-xs text-red-700 hover:underline">
          Suspend
        </button>
      </form>
    );
  }
  return (
    <form action={action} className="inline">
      <input type="hidden" name="id" value={partner.id} />
      <input type="hidden" name="status" value="active" />
      <button type="submit" className="text-xs text-emerald-700 hover:underline">
        Activate
      </button>
    </form>
  );
}

function Badge({ status }: { status: string }) {
  const cls =
    status === "active"
      ? "badge-success"
      : status === "warning"
      ? "badge-warning"
      : status === "suspended"
      ? "badge-danger"
      : "badge-neutral";
  return <span className={cls}>{status.replace("_", " ")}</span>;
}
