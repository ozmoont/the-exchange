import { db } from "@/db/client";
import { transits, transitEvents, partners } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import { forwardStatusUpdate } from "@/lib/routing";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * /transits/[id] — full timeline of one transit.
 *
 * Simulate-status buttons call the same `forwardStatusUpdate` server function
 * that real iCabbi webhooks land on. Fleet roles can only view transits where
 * their partner is involved; fleet_admin can simulate, fleet_user can only view.
 */

const HAPPY_PATH = ["accepted", "driver_assigned", "en_route", "on_board", "completed"] as const;
const TERMINAL: ReadonlySet<string> = new Set(["completed", "cancelled", "failed"]);

async function simulateStatusAction(formData: FormData) {
  "use server";
  const transitId = String(formData.get("transitId") ?? "");
  const newStatus = String(formData.get("newStatus") ?? "");
  if (!transitId || !newStatus) return;

  await forwardStatusUpdate({
    transitId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    newStatus: newStatus as any,
    detail: { simulated: true, via: "transit_detail_page", at: new Date().toISOString() },
  });

  revalidatePath(`/transits/${transitId}`);
  revalidatePath("/bookings");
}

export default async function TransitDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser();
  const [transit] = await db.select().from(transits).where(eq(transits.id, id));
  if (!transit) notFound();

  if (user.role !== "super_admin") {
    const involved =
      user.partnerId &&
      (user.partnerId === transit.originatorPartnerId ||
        user.partnerId === transit.recipientPartnerId);
    if (!involved) redirect("/");
  }
  const canSimulate = user.role === "super_admin" || user.role === "fleet_admin";

  const [originator] = await db
    .select()
    .from(partners)
    .where(eq(partners.id, transit.originatorPartnerId));
  const [recipient] = transit.recipientPartnerId
    ? await db.select().from(partners).where(eq(partners.id, transit.recipientPartnerId))
    : [null];

  const events = await db
    .select()
    .from(transitEvents)
    .where(eq(transitEvents.transitId, id))
    .orderBy(asc(transitEvents.createdAt));

  const isTerminal = TERMINAL.has(transit.status);
  const currentIndex = HAPPY_PATH.indexOf(transit.status as (typeof HAPPY_PATH)[number]);
  const nextHappy =
    currentIndex >= 0 && currentIndex < HAPPY_PATH.length - 1
      ? HAPPY_PATH[currentIndex + 1]
      : transit.status === "pushed"
      ? "accepted"
      : null;

  const booking = transit.bookingPayload as Record<string, unknown>;
  const fs = transit.feeSnapshot;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-ink-muted font-semibold">
            Transit
          </p>
          <h1 className="text-3xl font-bold tracking-tight mt-1">
            <code className="text-2xl">{transit.originatorBookingExternalId}</code>
          </h1>
          <div className="text-xs text-ink-subtle mt-2">
            <code>{transit.id}</code>
          </div>
        </div>
        <Link href="/bookings" className="text-sm text-ink-muted hover:text-ink">← All transits</Link>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <Section title="Route">
          <KV k="Status" v={<StatusBadge status={transit.status} />} />
          <KV
            k="Originator"
            v={originator ? <Link href={`/partners/${originator.id}`} className="text-ink hover:underline">{originator.name}</Link> : "—"}
          />
          <KV
            k="Recipient"
            v={recipient ? <Link href={`/partners/${recipient.id}`} className="text-ink hover:underline">{recipient.name}</Link> : "—"}
          />
          <KV k="Originator booking id" v={<code className="text-xs">{transit.originatorBookingExternalId}</code>} />
          <KV
            k="Recipient booking id"
            v={transit.recipientBookingExternalId ? <code className="text-xs">{transit.recipientBookingExternalId}</code> : "—"}
          />
          <KV k="Created" v={new Date(transit.createdAt).toLocaleString()} />
          <KV k="Updated" v={new Date(transit.updatedAt).toLocaleString()} />
        </Section>

        <Section title="Fee snapshot">
          {fs ? (
            <>
              <KV k="Send fee" v={`${fs.sendFeePence}p`} />
              <KV k="Receive fee" v={`${fs.receiveFeePence}p`} />
              <KV k="Tech fee" v={`${fs.techFeePence}p + ${fs.techFeeBps / 100}%`} />
              <KV k="Booking fee" v={`${fs.bookingFeePence}p`} />
              <KV k="Admin fee" v={`${fs.adminFeePence}p + ${fs.adminFeeBps / 100}%`} />
              <KV k="Passenger add-ons" v={`${fs.computedPassengerAddOnsPence}p`} />
              <KV k="Fare at snapshot" v={fs.fareAtSnapshotPence !== null ? `${fs.fareAtSnapshotPence}p` : "—"} />
              <KV k="Resolved from" v={<code className="text-xs">{fs.resolvedFromFeeConfigId}</code>} />
            </>
          ) : (
            <p className="text-sm text-ink-muted">No fee snapshot — transit didn&apos;t reach routing stage.</p>
          )}
        </Section>
      </div>

      {canSimulate && !isTerminal && transit.recipientPartnerId && (
        <section className="card bg-warning/60 border-yellow-400 p-5">
          <h2 className="text-base font-semibold text-yellow-900 mb-1">Simulate next status</h2>
          <p className="text-sm text-yellow-900/80 mb-4">
            In production these statuses arrive via webhooks from the recipient. With mock adapters
            they don&apos;t fire automatically — use these buttons to drive the lifecycle by hand.
            The same server function is called either way.
          </p>
          <div className="flex flex-wrap gap-2">
            {nextHappy && (
              <SimulateButton transitId={transit.id} newStatus={nextHappy} action={simulateStatusAction} variant="primary" />
            )}
            {HAPPY_PATH.filter((s) => s !== nextHappy && s !== transit.status).map((s) => (
              <SimulateButton key={s} transitId={transit.id} newStatus={s} action={simulateStatusAction} variant="secondary" />
            ))}
            <SimulateButton transitId={transit.id} newStatus="cancelled" action={simulateStatusAction} variant="danger" />
            <SimulateButton transitId={transit.id} newStatus="failed" action={simulateStatusAction} variant="danger" />
          </div>
        </section>
      )}

      {isTerminal && (
        <div className="card p-4 text-sm text-ink-muted">
          Transit is in terminal state <code>{transit.status}</code>. No further status changes will be accepted.
        </div>
      )}

      <Section title="Event timeline">
        {events.length === 0 ? (
          <p className="text-sm text-ink-muted">No events yet.</p>
        ) : (
          <ol className="divide-y divide-border">
            {events.map((e) => (
              <li key={e.id} className="grid grid-cols-[180px_140px_1fr] gap-3 py-3 text-sm">
                <span className="text-ink-subtle">{new Date(e.createdAt).toLocaleString()}</span>
                <span><StatusBadge status={e.status} /></span>
                <span className="text-ink-muted font-mono text-xs break-words">
                  {e.actor}
                  {e.detail ? ` · ${JSON.stringify(e.detail)}` : ""}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section title="Booking payload (originator view)">
        <pre className="bg-ink text-slate-200 p-3 rounded-md overflow-auto text-xs leading-relaxed">
          {JSON.stringify(booking, null, 2)}
        </pre>
      </Section>
    </div>
  );
}

function SimulateButton({
  transitId,
  newStatus,
  action,
  variant,
}: {
  transitId: string;
  newStatus: string;
  action: (formData: FormData) => void;
  variant: "primary" | "secondary" | "danger";
}) {
  const cls =
    variant === "primary" ? "btn-primary" : variant === "danger" ? "btn-danger" : "btn-secondary";
  return (
    <form action={action}>
      <input type="hidden" name="transitId" value={transitId} />
      <input type="hidden" name="newStatus" value={newStatus} />
      <button type="submit" className={cls}>
        {newStatus.replace(/_/g, " ")}
      </button>
    </form>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card p-5">
      <h2 className="text-base font-semibold mb-4">{title}</h2>
      {children}
    </section>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[180px_1fr] text-sm py-1 items-center">
      <span className="text-ink-muted">{k}</span>
      <span>{v}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "completed"
      ? "badge-success"
      : status === "cancelled" || status === "failed" || status === "no_match" || status.startsWith("error_")
      ? "badge-danger"
      : status === "paused"
      ? "badge-warning"
      : ["pushed", "accepted", "driver_assigned", "en_route", "on_board"].includes(status)
      ? "badge-info"
      : "badge-neutral";
  return <span className={cls}>{status.replace(/_/g, " ")}</span>;
}
