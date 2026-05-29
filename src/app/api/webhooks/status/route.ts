import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db/client";
import { transits } from "@/db/schema";
import { eq } from "drizzle-orm";
import { forwardStatusUpdate } from "@/lib/routing";
import { getAdapterForPartner } from "@/adapters/registry";
import { isFreshDelivery } from "@/lib/idempotency";

const BodySchema = z.object({
  recipientPartnerId: z.string().uuid(),
  eventId: z.string().min(1),
  payload: z.record(z.unknown()),
});

/**
 * Status webhook receiver. The recipient partner reports back when a booking
 * moves through its lifecycle (accepted, driver_assigned, on_board, completed,
 * cancelled). We look up the transit by recipientBookingExternalId, update
 * status, fire transit_events, and forward to the originator.
 */
export async function POST(req: NextRequest) {
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { recipientPartnerId, eventId, payload } = parsed.data;

  const fresh = await isFreshDelivery(`status:${recipientPartnerId}`, eventId, payload);
  if (!fresh) return NextResponse.json({ status: "duplicate" }, { status: 200 });

  const adapter = await getAdapterForPartner(recipientPartnerId);
  const normalised = await adapter.normaliseInboundWebhook(payload);
  if (!normalised || normalised.kind !== "status") {
    return NextResponse.json({ error: "not_a_status_update" }, { status: 422 });
  }

  const [transit] = await db
    .select()
    .from(transits)
    .where(eq(transits.recipientBookingExternalId, normalised.recipientBookingExternalId));

  if (!transit) {
    return NextResponse.json({ error: "transit_not_found" }, { status: 404 });
  }

  await forwardStatusUpdate({
    transitId: transit.id,
    newStatus: normaliseStatus(normalised.newStatus),
    detail: normalised.detail,
  });

  return NextResponse.json({ status: "ok" });
}

function normaliseStatus(s: string) {
  const map: Record<string, string> = {
    accepted: "accepted",
    driver_assigned: "driver_assigned",
    en_route: "en_route",
    on_board: "on_board",
    completed: "completed",
    cancelled: "cancelled",
    failed: "failed",
  };
  return (map[s] ?? "error_other") as any;
}
