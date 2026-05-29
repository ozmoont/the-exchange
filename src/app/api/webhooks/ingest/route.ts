import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { routeBooking } from "@/lib/routing";
import { getAdapterForPartner } from "@/adapters/registry";
import { isFreshDelivery } from "@/lib/idempotency";

const BodySchema = z.object({
  originatorPartnerId: z.string().uuid(),
  eventId: z.string().min(1),
  payload: z.record(z.unknown()),
});

/**
 * The originator (an iCabbi tenant or an external partner like CMAC) posts
 * "this booking is going to the network" here. We normalise via the partner's
 * adapter, run the routing engine, return the assigned recipient.
 *
 * In production this is the receiver of webhook events configured in iCabbi.
 */
export async function POST(req: NextRequest) {
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const { originatorPartnerId, eventId, payload } = parsed.data;

  // Idempotency: drop duplicates silently
  const fresh = await isFreshDelivery(`ingest:${originatorPartnerId}`, eventId, payload);
  if (!fresh) {
    return NextResponse.json({ status: "duplicate" }, { status: 200 });
  }

  const adapter = await getAdapterForPartner(originatorPartnerId);
  const normalised = await adapter.normaliseInboundWebhook(payload);
  if (!normalised || normalised.kind !== "create") {
    return NextResponse.json({ error: "not_a_booking_create" }, { status: 422 });
  }

  const result = await routeBooking({
    originatorPartnerId,
    booking: normalised.booking,
  });

  return NextResponse.json(result, { status: 200 });
}
