import { db } from "@/db/client";
import { auditLog } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { requireSuperAdmin } from "@/lib/auth";
import Link from "next/link";

export const dynamic = "force-dynamic";

const CATEGORIES = ["booking", "admin", "credential", "permission", "fee"] as const;
type Category = (typeof CATEGORIES)[number];

const PAGE_SIZE = 100;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  await requireSuperAdmin();
  const sp = await searchParams;
  const filter = (CATEGORIES as readonly string[]).includes(sp.category ?? "")
    ? (sp.category as Category)
    : null;

  const rows = filter
    ? await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.category, filter))
        .orderBy(desc(auditLog.createdAt))
        .limit(PAGE_SIZE)
    : await db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(PAGE_SIZE);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs uppercase tracking-[0.2em] text-ink-muted font-semibold">
          Compliance trail
        </p>
        <h1 className="text-3xl font-bold tracking-tight mt-1">Audit log</h1>
        <p className="text-sm text-ink-muted mt-2 max-w-2xl">
          Immutable record of every consequential platform action — partner registrations,
          rule changes, fee updates, kill-switch toggles, credential rotations. Last {PAGE_SIZE}{" "}
          entries shown. Secrets never appear here; only presence flags do.
        </p>
      </div>

      <div className="flex gap-2 flex-wrap">
        <Chip href="/audit" label="all" active={filter === null} />
        {CATEGORIES.map((c) => (
          <Chip key={c} href={`/audit?category=${c}`} label={c} active={filter === c} />
        ))}
      </div>

      <div className="card overflow-hidden">
        {rows.length === 0 ? (
          <p className="px-6 py-12 text-center text-sm text-ink-muted">
            {filter ? `No ${filter} entries yet.` : "No audit entries yet. Trigger one by toggling the kill switch or adding a partner."}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-ink-subtle">
              <tr>
                <th className="text-left px-5 py-3 font-semibold">When</th>
                <th className="text-left px-5 py-3 font-semibold">Category</th>
                <th className="text-left px-5 py-3 font-semibold">Actor</th>
                <th className="text-left px-5 py-3 font-semibold">Action</th>
                <th className="text-left px-5 py-3 font-semibold">Subject</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className="px-5 py-3 whitespace-nowrap">
                    <div>{new Date(r.createdAt).toLocaleString()}</div>
                    <div className="text-xs text-ink-subtle">{relativeTime(r.createdAt)}</div>
                  </td>
                  <td className="px-5 py-3"><CategoryBadge category={r.category} /></td>
                  <td className="px-5 py-3 text-ink-muted">
                    <div>{r.actor}</div>
                    {r.actorRef && <div className="text-xs text-ink-subtle">{r.actorRef}</div>}
                  </td>
                  <td className="px-5 py-3">
                    <code className="text-xs">{r.action}</code>
                  </td>
                  <td className="px-5 py-3">
                    {r.subjectType ? (
                      <>
                        <div className="text-xs text-ink-subtle">{r.subjectType}</div>
                        <code className="text-xs">{r.subjectId?.slice(0, 16)}…</code>
                      </>
                    ) : (
                      <span className="text-ink-subtle">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Chip({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`px-3 py-1 rounded-full text-xs font-semibold border border-border-strong ${
        active ? "bg-ink text-white" : "bg-white text-ink hover:bg-surface-muted"
      }`}
    >
      {label}
    </Link>
  );
}

function CategoryBadge({ category }: { category: string }) {
  const cls =
    category === "credential" ? "badge-danger" :
    category === "permission" ? "badge-success" :
    category === "fee" ? "badge-info" :
    category === "admin" ? "badge-warning" :
    "badge-neutral";
  return <span className={cls}>{category}</span>;
}

function relativeTime(d: Date | string) {
  const sec = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}
