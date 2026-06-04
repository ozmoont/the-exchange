import { db } from "@/db/client";
import { partners, users, auditLog } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import Link from "next/link";
import { requireSuperAdmin, createMagicLinkToken } from "@/lib/auth";
import { sendPartnerApprovalEmail } from "@/lib/email";

export const dynamic = "force-dynamic";

/**
 * Super-admin review queue for self-service partner signups.
 *
 * Lists every partner with status='pending_approval'. Approve flips them to
 * 'active', creates a user row (role=fleet_admin) for the applicant email,
 * generates a magic link, and emails it. Reject marks them 'suspended' with
 * the rejection reason captured in the audit log.
 *
 * Approval is irreversible from this UI — once approved the partner shows up
 * in the regular /partners list. To pause an approved partner use the
 * Suspend action on /partners.
 */

async function approveAction(formData: FormData) {
  "use server";
  const user = await requireSuperAdmin();

  const partnerId = String(formData.get("partnerId") ?? "");
  if (!partnerId) return;

  const [partner] = await db.select().from(partners).where(eq(partners.id, partnerId));
  if (!partner) return;
  if (partner.status !== "pending_approval") return;
  if (!partner.applicantEmail) return;

  // 1. Activate the partner
  await db
    .update(partners)
    .set({ status: "active", updatedAt: new Date() })
    .where(eq(partners.id, partnerId));

  // 2. Ensure a fleet_admin user exists for the applicant
  const existingUser = await db
    .select()
    .from(users)
    .where(eq(users.email, partner.applicantEmail))
    .limit(1);

  if (existingUser.length === 0) {
    await db.insert(users).values({
      email: partner.applicantEmail,
      role: "fleet_admin",
      partnerId: partner.id,
      invitedBy: user.email,
    });
  } else if (!existingUser[0].partnerId) {
    // User exists but isn't linked to a partner — link them.
    await db
      .update(users)
      .set({ partnerId: partner.id, role: "fleet_admin" })
      .where(eq(users.id, existingUser[0].id));
  }

  // 3. Send welcome email with magic link
  const token = await createMagicLinkToken(partner.applicantEmail);
  const baseUrl =
    process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "https://the-exchange-z2wp.vercel.app";
  const url = `${baseUrl}/auth/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent(
    `/partners/${partner.id}/integration`,
  )}`;

  try {
    await sendPartnerApprovalEmail({
      to: partner.applicantEmail,
      url,
      fleetName: partner.name,
    });
  } catch (err) {
    // Don't block the approval if the email fails — log and surface in audit.
    console.error("[signup approve] welcome email failed:", err);
  }

  // 4. Audit log
  await db.insert(auditLog).values({
    category: "admin",
    actor: "admin_user",
    actorRef: user.email,
    action: "partner.signup_approved",
    subjectType: "partner",
    subjectId: partner.id,
    before: { status: "pending_approval" },
    after: { status: "active", invitedUserEmail: partner.applicantEmail },
  });

  revalidatePath("/signups");
  revalidatePath("/partners");
  redirect(`/partners/${partner.id}?approved=1`);
}

async function rejectAction(formData: FormData) {
  "use server";
  const user = await requireSuperAdmin();

  const partnerId = String(formData.get("partnerId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim() || "no_reason_given";
  if (!partnerId) return;

  const [partner] = await db.select().from(partners).where(eq(partners.id, partnerId));
  if (!partner) return;
  if (partner.status !== "pending_approval") return;

  await db
    .update(partners)
    .set({ status: "suspended", updatedAt: new Date() })
    .where(eq(partners.id, partnerId));

  await db.insert(auditLog).values({
    category: "admin",
    actor: "admin_user",
    actorRef: user.email,
    action: "partner.signup_rejected",
    subjectType: "partner",
    subjectId: partner.id,
    before: { status: "pending_approval" },
    after: { status: "suspended", reason },
  });

  revalidatePath("/signups");
  redirect("/signups");
}

export default async function SignupsPage() {
  await requireSuperAdmin();

  const pending = await db
    .select()
    .from(partners)
    .where(eq(partners.status, "pending_approval"))
    .orderBy(desc(partners.createdAt));

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs uppercase tracking-[0.2em] text-ink-muted font-semibold">
          Admin
        </p>
        <h1 className="text-3xl font-bold tracking-tight mt-1">Pending applications</h1>
        <p className="text-sm text-ink-muted mt-2 max-w-2xl">
          Fleet operators who applied to join the network via <code>/signup</code>.
          Approving sends them a magic-link email and links the applicant to a
          new <code>fleet_admin</code> user on their partner row.
        </p>
      </div>

      {pending.length === 0 ? (
        <div className="card p-12 text-center">
          <p className="text-sm text-ink-muted">
            No pending applications. New signups will appear here.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {pending.map((p) => (
            <ApplicationCard
              key={p.id}
              partner={p}
              approveAction={approveAction}
              rejectAction={rejectAction}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ApplicationCard({
  partner: p,
  approveAction,
  rejectAction,
}: {
  partner: typeof partners.$inferSelect;
  approveAction: (formData: FormData) => Promise<void>;
  rejectAction: (formData: FormData) => Promise<void>;
}) {
  return (
    <div className="card p-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold">{p.name}</h2>
          <div className="mt-1 text-sm text-ink-muted">
            {p.applicantEmail ? (
              <a href={`mailto:${p.applicantEmail}`} className="hover:underline">
                {p.applicantEmail}
              </a>
            ) : (
              <span className="text-ink-subtle">no email captured</span>
            )}
            {" · "}
            <span>{p.operatingRegions[0] ?? "no region"}</span>
            {" · "}
            <span>applied {new Date(p.createdAt).toLocaleString()}</span>
          </div>
        </div>
        <div className="text-xs text-ink-subtle">
          <code>{p.id.slice(0, 8)}…</code>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <KV k="Vehicles" v={p.vehicleTypes.join(", ") || "—"} />
        <KV k="Booking types" v={p.bookingTypes.join(", ")} />
        <KV k="Mode (default)" v={p.participationMode.replace(/_/g, " ")} />
        <KV k="Adapter (default)" v={p.adapterKey} />
      </div>

      {p.applicationNotes && (
        <div className="mt-4 rounded-md bg-surface-muted/50 p-3 text-sm whitespace-pre-wrap">
          {p.applicationNotes}
        </div>
      )}

      <div className="mt-6 grid md:grid-cols-2 gap-4">
        <form action={approveAction}>
          <input type="hidden" name="partnerId" value={p.id} />
          <button type="submit" className="btn-primary w-full">
            Approve & send welcome email
          </button>
          <p className="mt-2 text-xs text-ink-subtle">
            Creates a fleet_admin user for {p.applicantEmail ?? "the applicant"} and emails them a magic link.
          </p>
        </form>
        <form action={rejectAction} className="space-y-2">
          <input type="hidden" name="partnerId" value={p.id} />
          <input
            type="text"
            name="reason"
            placeholder="Reason (audit log)"
            className="input"
          />
          <button type="submit" className="btn-danger w-full">
            Reject
          </button>
        </form>
      </div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-ink-subtle font-semibold">{k}</div>
      <div className="text-sm text-ink mt-0.5">{v}</div>
    </div>
  );
}
