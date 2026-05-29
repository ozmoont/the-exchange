import { db } from "@/db/client";
import { users, partners, auditLog } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * /users — super-admin-only page to manage who can sign in.
 *
 * Three roles:
 *   - super_admin: full network access
 *   - fleet_admin: scoped to one partner; can edit fleet config + rules + fees
 *   - fleet_user:  scoped to one partner; read + light configure
 *
 * fleet_admin and fleet_user MUST have a partner_id. super_admin MUST NOT.
 * After invite, the user signs in via magic link the same way the founder does
 * — their record is already in the users table, so isEmailAllowed() returns
 * true and the bootstrap path doesn't fire.
 */

type Role = "super_admin" | "fleet_admin" | "fleet_user";

async function inviteUserAction(formData: FormData) {
  "use server";
  const inviter = await requireSuperAdmin();

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "fleet_user") as Role;
  const partnerId = String(formData.get("partnerId") ?? "") || null;

  if (!email) redirect("/users?error=missing_email");
  if ((role === "fleet_admin" || role === "fleet_user") && !partnerId) {
    redirect("/users?error=fleet_role_needs_partner");
  }
  if (role === "super_admin" && partnerId) {
    redirect("/users?error=super_admin_no_partner");
  }

  // Upsert: re-inviting an existing email updates their role/partner
  const [existing] = await db.select().from(users).where(eq(users.email, email));
  if (existing) {
    await db
      .update(users)
      .set({ role, partnerId, updatedAt: new Date(), invitedBy: inviter.email })
      .where(eq(users.id, existing.id));
    await db.insert(auditLog).values({
      category: "permission",
      actor: "admin_user",
      actorRef: inviter.email,
      action: "user.updated",
      subjectType: "user",
      subjectId: existing.id,
      before: { role: existing.role, partnerId: existing.partnerId },
      after: { role, partnerId },
    });
  } else {
    const [created] = await db
      .insert(users)
      .values({ email, role, partnerId, invitedBy: inviter.email })
      .returning();
    await db.insert(auditLog).values({
      category: "permission",
      actor: "admin_user",
      actorRef: inviter.email,
      action: "user.invited",
      subjectType: "user",
      subjectId: created.id,
      after: { email, role, partnerId },
    });
  }

  revalidatePath("/users");
  redirect("/users?saved=1");
}

async function revokeUserAction(formData: FormData) {
  "use server";
  const inviter = await requireSuperAdmin();
  const userId = String(formData.get("userId") ?? "");
  if (!userId) return;

  // Can't revoke yourself — prevents accidental lockout
  if (userId === inviter.id) {
    redirect("/users?error=cant_revoke_self");
  }

  const [existing] = await db.select().from(users).where(eq(users.id, userId));
  if (!existing) return;

  await db.delete(users).where(eq(users.id, userId));

  await db.insert(auditLog).values({
    category: "permission",
    actor: "admin_user",
    actorRef: inviter.email,
    action: "user.revoked",
    subjectType: "user",
    subjectId: userId,
    before: { email: existing.email, role: existing.role, partnerId: existing.partnerId },
  });

  revalidatePath("/users");
  redirect("/users?revoked=1");
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; revoked?: string; error?: string }>;
}) {
  const current = await requireSuperAdmin();
  const sp = await searchParams;

  const rows = await db
    .select({ u: users, p: partners })
    .from(users)
    .leftJoin(partners, eq(users.partnerId, partners.id))
    .orderBy(desc(users.createdAt));

  const allPartners = await db.select().from(partners).orderBy(partners.name);

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-end justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-ink-muted font-semibold">Access</p>
          <h1 className="text-3xl font-bold tracking-tight mt-1">Users</h1>
          <p className="text-sm text-ink-muted mt-2 max-w-2xl">
            Anyone in this list can sign in via magic link. Fleet roles see only their assigned
            partner; super admins see the whole network. You cannot revoke yourself.
          </p>
        </div>
      </div>

      {sp.saved === "1" && (
        <Banner tone="success">User saved.</Banner>
      )}
      {sp.revoked === "1" && (
        <Banner tone="warning">User revoked. Their existing session will be invalidated on next request.</Banner>
      )}
      {sp.error === "missing_email" && (
        <Banner tone="danger">Email is required.</Banner>
      )}
      {sp.error === "fleet_role_needs_partner" && (
        <Banner tone="danger">Fleet roles must be assigned to a partner.</Banner>
      )}
      {sp.error === "super_admin_no_partner" && (
        <Banner tone="danger">Super admins are network-wide and cannot be scoped to a partner.</Banner>
      )}
      {sp.error === "cant_revoke_self" && (
        <Banner tone="danger">You cannot revoke your own account.</Banner>
      )}

      {/* Invite form */}
      <form action={inviteUserAction} className="card p-5 space-y-4">
        <h2 className="font-semibold">Invite or update a user</h2>
        <div className="grid md:grid-cols-3 gap-4">
          <label className="block">
            <span className="label">Email</span>
            <input
              name="email"
              type="email"
              required
              placeholder="someone@fleet.com"
              className="input"
              autoComplete="off"
            />
          </label>
          <label className="block">
            <span className="label">Role</span>
            <select name="role" defaultValue="fleet_user" className="input">
              <option value="fleet_user">Fleet user</option>
              <option value="fleet_admin">Fleet admin</option>
              <option value="super_admin">Super admin</option>
            </select>
          </label>
          <label className="block">
            <span className="label">Partner (fleet roles only)</span>
            <select name="partnerId" defaultValue="" className="input">
              <option value="">— None (super admin) —</option>
              {allPartners.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" className="btn-primary">Save user</button>
          <p className="text-xs text-ink-muted">
            Re-submitting an existing email updates their role/partner. Every change is audit-logged.
          </p>
        </div>
      </form>

      {/* Roster */}
      <div className="card">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="font-semibold">Roster ({rows.length})</h2>
        </div>
        {rows.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-ink-muted">
            No users yet. Invite one above.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-ink-subtle">
              <tr>
                <th className="text-left px-5 py-3 font-semibold">Email</th>
                <th className="text-left px-5 py-3 font-semibold">Role</th>
                <th className="text-left px-5 py-3 font-semibold">Partner</th>
                <th className="text-left px-5 py-3 font-semibold">Last login</th>
                <th className="text-right px-5 py-3 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map(({ u, p }) => (
                <tr key={u.id}>
                  <td className="px-5 py-3">
                    <div className="font-medium">{u.email}</div>
                    {u.id === current.id && (
                      <div className="text-xs text-ink-subtle">(you)</div>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <span className={roleTone(u.role)}>{u.role.replace("_", " ")}</span>
                  </td>
                  <td className="px-5 py-3 text-ink-muted">
                    {p ? p.name : <span className="text-ink-subtle">—</span>}
                  </td>
                  <td className="px-5 py-3 text-xs text-ink-muted">
                    {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : <span className="text-ink-subtle">never</span>}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {u.id !== current.id && (
                      <form action={revokeUserAction} className="inline">
                        <input type="hidden" name="userId" value={u.id} />
                        <button type="submit" className="text-xs text-red-700 hover:underline">
                          Revoke
                        </button>
                      </form>
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

function roleTone(role: string) {
  if (role === "super_admin") return "badge-danger";
  if (role === "fleet_admin") return "badge-info";
  return "badge-neutral";
}

function Banner({ tone, children }: { tone: "success" | "warning" | "danger"; children: React.ReactNode }) {
  const cls =
    tone === "success" ? "bg-success text-success-fg" :
    tone === "warning" ? "bg-warning text-warning-fg" :
    "bg-danger text-danger-fg";
  return <div className={`p-3 rounded-md text-sm ${cls}`}>{children}</div>;
}
