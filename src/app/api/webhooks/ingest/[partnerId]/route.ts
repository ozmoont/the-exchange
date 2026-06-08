import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { db } from "@/db/client";
import { partners, transits } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getAdapterForPartner } from "@/adapters/registry";
import { isFreshDelivery, recordWebhookOutcome, recordRejectedDelivery } from "@/lib/idempotency";
import { receiveBooking, forwardStatusUpdate } from "@/lib/routing";
import {
  checkRateLimit,
  LIMIT_INGEST_PER_PARTNER,
  WINDOW_INGEST_SECONDS,
} from "@/lib/rate-limit";
import { decryptIfNeeded } from "@/lib/crypto";

/**
 * Per-partner webhook receiver. Each connected partner gets a unique URL:
 *   POST /api/webhooks/ingest/<partnerId>
 *
 * Authentication: HMAC-SHA512 of the raw body, signed with the partner's
 * webhookSecret (stored in partners.credentials.webhookSecret). The signature
 * is sent in the X-Karhoo-Request-Signature header as lowercase hex.
 *
 * Per the iCabbi/Karhoo webhook contract:
 *   - 200-ack the request when verified and processed (or skipped as a duplicate).
 *   - Return 200 even if the event is one we don't handle (FinalFareReleased,
 *     DriverPositionChanged) — they'll retry on 4xx/5xx and we don't want that.
 *   - Only return 4xx for genuine bad input (missing partner, bad signature).
 *
 * The same code path handles two flows:
 *   - kind: "status" — translates to forwardStatusUpdate on the receiving transit
 *   - kind: "create" — would run the routing engine for inbound network bookings
 *     (the originator-fires-create case is still TBD; left in for forward compat)
 */

const SIGNATURE_HEADER = "x-karhoo-request-signature";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ partnerId: string }> },
) {
  const { partnerId } = await params;
  if (!partnerId) {
    return NextResponse.json({ error: "missing_partner_id" }, { status: 400 });
  }

  // P0-4: rate limit per partner. 60 events/minute is well above realistic
  // iCabbi traffic — they batch and our peak observed in the analysis is
  // single-digit/minute. Set WEBHOOK_INGEST_RATE_LIMIT env var to tune.
  const rl = await checkRateLimit(
    `ingest:${partnerId}`,
    Number(process.env.WEBHOOK_INGEST_RATE_LIMIT ?? LIMIT_INGEST_PER_PARTNER),
    WINDOW_INGEST_SECONDS,
  );
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited", retry_after_seconds: rl.retryAfterSeconds },
      {
        status: 429,
        headers: { "Retry-After": String(rl.retryAfterSeconds ?? 60) },
      },
    );
  }

  // Load partner + webhook secret
  const [partner] = await db.select().from(partners).where(eq(partners.id, partnerId));
  if (!partner) {
    return NextResponse.json({ error: "partner_not_found" }, { status: 404 });
  }

  // Credentials are AES-256-GCM encrypted at rest. The on-disk shape is
  // `{ __enc: 1, iv, ct, tag }` — without decryption, `webhookSecret` is
  // always undefined and we'd return partner_not_connected on every event
  // even when the partner IS connected. decryptIfNeeded handles both shapes
  // safely (plaintext objects pass through unchanged).
  const creds = (decryptIfNeeded(partner.credentials as Record<string, unknown> | null) ?? {}) as {
    webhookSecret?: string;
  };
  if (!creds.webhookSecret) {
    return NextResponse.json({ error: "partner_not_connected" }, { status: 400 });
  }

  // Read raw body BEFORE parsing — signature is computed over the exact bytes,
  // including any linefeeds / whitespace. Re-parsing then re-serializing would
  // break verification.
  const rawBody = await req.text();
  const provided = req.headers.get(SIGNATURE_HEADER) ?? "";

  // TEMPORARY (2026-06-08 — iCabbi staging integration).
  //
  // iCabbi's UI for outbound webhook configuration takes a URL only — no
  // place to enter a signing secret. Until iCabbi confirms what signing
  // convention they use (item #4 in ICABBI_DEPENDENCIES.md — possibly
  // App-Key/Secret-Key as HMAC material, possibly via separate API
  // registration, possibly no signing at all), we need a way to accept
  // their webhooks without HMAC verification so the inbound demo flow
  // works.
  //
  // ICABBI_SKIP_WEBHOOK_HMAC=true bypasses signature check ONLY. Replay
  // protection (sent_at window), idempotency (envelope id), and rate
  // limiting are still enforced. Every skipped verification logs a loud
  // warning that turns up in audit + Sentry.
  //
  // MUST be set to false (or unset) in production once iCabbi confirms
  // the real signing scheme. Tracked in HANDOVER.md.
  const skipHmac = process.env.ICABBI_SKIP_WEBHOOK_HMAC === "true";
  if (!skipHmac && !verifyHmacSha512(rawBody, provided, creds.webhookSecret)) {
    console.warn(
      `[webhook] HMAC verification failed for partner ${partnerId} (sig provided: ${provided ? "yes" : "no"})`,
    );
    await recordRejectedDelivery(`ingest:${partnerId}`, "signature_invalid", { raw_length: rawBody.length });
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }
  if (skipHmac) {
    console.warn(
      `[webhook] HMAC verification BYPASSED for partner ${partnerId} ` +
        `(ICABBI_SKIP_WEBHOOK_HMAC=true). Sig provided: ${provided ? "yes" : "no"}. ` +
        `THIS IS A TEMPORARY STAGING ACCOMMODATION — must be off in production.`,
    );
  }

  // Parse envelope. iCabbi/Karhoo envelope (assumed shape — iCabbi's actual
  // shape is being learned in production, item #3 in ICABBI_DEPENDENCIES.md):
  //   { id, event_type, sent_at, checksum, attempt_number, data: stringified-json }
  let envelope: Record<string, unknown>;
  try {
    const parsed = rawBody ? JSON.parse(rawBody) : null;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(
        `[webhook] body parsed but not an object for partner ${partnerId}. ` +
          `content-type=${req.headers.get("content-type") ?? "(none)"}. ` +
          `parsed type=${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed}. ` +
          `Body preview: ${rawBody.slice(0, 500)}`,
      );
      return NextResponse.json({ error: "invalid_envelope_shape" }, { status: 400 });
    }
    envelope = parsed as Record<string, unknown>;
  } catch (err) {
    // JSON parse threw — iCabbi may be sending form-encoded, empty body,
    // or some other content type. Log everything so we can see what they
    // actually sent and adjust.
    console.warn(
      `[webhook] JSON.parse failed for partner ${partnerId}. ` +
        `content-type=${req.headers.get("content-type") ?? "(none)"}. ` +
        `body length=${rawBody.length}. ` +
        `err=${err instanceof Error ? err.message : String(err)}. ` +
        `Body preview: ${rawBody.slice(0, 500)}`,
    );
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // iCabbi's actual envelope shape isn't fully documented (item #3 in
  // ICABBI_DEPENDENCIES.md). We try the Karhoo-canonical `id`, then a list
  // of plausible alternatives, then fall back to a deterministic hash of
  // the body so we can still dedupe even when no id is provided.
  //
  // Log the raw envelope keys on every fallback so we can adjust to the
  // real shape once we've seen a few events.
  const envelopeIdRaw =
    envelope.id ??
    (envelope as Record<string, unknown>).event_id ??
    (envelope as Record<string, unknown>).webhook_id ??
    (envelope as Record<string, unknown>).delivery_id ??
    (envelope as Record<string, unknown>).notification_id ??
    null;
  let envelopeId = envelopeIdRaw != null ? String(envelopeIdRaw) : "";
  if (!envelopeId) {
    // Fallback id = sha256(partnerId || rawBody) truncated to 32 chars.
    // Stable across retries of the same event, unique per distinct event.
    const hash = createHash("sha256").update(partnerId).update("|").update(rawBody).digest("hex");
    envelopeId = `body-hash:${hash.slice(0, 32)}`;
    console.warn(
      `[webhook] no envelope id field found for partner ${partnerId} — falling back to body-hash id. ` +
        `Top-level keys: ${Object.keys(envelope).join(",")}. ` +
        `Body preview: ${rawBody.slice(0, 400)}`,
    );
  }

  // P0-5: replay protection. The HMAC signature proves the payload came from
  // an entity that knows our shared secret — but a captured payload can be
  // replayed indefinitely. Reject anything whose sent_at is more than
  // WEBHOOK_MAX_AGE_MS old.
  //
  // iCabbi's actual envelope shape is being learned (item #3). Try several
  // plausible field names for the timestamp. If none present, ALSO try to
  // pull a timestamp from inside a nested `data` object (some webhook
  // platforms inline timestamps there). If still none, allow the event
  // through but log a warning + skip replay protection — better to process
  // events with weaker security guarantees than to silently drop everything
  // because of a field-name mismatch.
  //
  // Window default 5 min covers realistic clock skew + first-retry latency.
  // Set WEBHOOK_MAX_AGE_MS env var to override.
  const maxAgeMs = Number(process.env.WEBHOOK_MAX_AGE_MS ?? 5 * 60_000);
  const env = envelope as Record<string, unknown>;
  const data = (env.data && typeof env.data === "object" ? env.data : null) as Record<string, unknown> | null;

  const sentAtCandidates = [
    env.sent_at,
    env.sentAt,
    env.timestamp,
    env.created_at,
    env.createdAt,
    env.time,
    env.event_time,
    env.eventTime,
    env.occurred_at,
    env.occurredAt,
    data?.sent_at,
    data?.timestamp,
    data?.created_at,
  ];

  let sentAtMs = NaN;
  for (const c of sentAtCandidates) {
    if (typeof c === "string" && c) {
      const parsed = Date.parse(c);
      if (Number.isFinite(parsed)) {
        sentAtMs = parsed;
        break;
      }
    } else if (typeof c === "number" && Number.isFinite(c)) {
      // unix seconds or ms — best guess: if < 10^12, treat as seconds
      sentAtMs = c < 1e12 ? c * 1000 : c;
      break;
    }
  }

  if (!Number.isFinite(sentAtMs)) {
    console.warn(
      `[webhook] no timestamp field found for partner ${partnerId} — skipping replay protection. ` +
        `Top-level keys: ${Object.keys(env).join(",")}. ` +
        `Body preview: ${rawBody.slice(0, 500)}`,
    );
    // Don't reject — let the event through. Replay protection skipped.
  } else {
    const ageMs = Date.now() - sentAtMs;
    if (ageMs > maxAgeMs) {
      console.warn(
        `[webhook] replay-protection rejected stale event ${envelopeId} for partner ${partnerId} (age ${Math.round(ageMs / 1000)}s)`,
      );
      await recordRejectedDelivery(`ingest:${partnerId}`, "signature_invalid", {
        reason: "stale_sent_at",
        envelope_id: envelopeId,
        age_ms: ageMs,
      });
      return NextResponse.json({ error: "stale_event", age_seconds: Math.round(ageMs / 1000) }, { status: 401 });
    }
  }

  // Idempotency: same envelope id from the same partner is a no-op (retries
  // commonly fire when our handler is slow, then again at 10s and 30s).
  // This also catches replay attempts that arrive within the freshness window
  // (the unique-constraint INSERT rejects them).
  const fresh = await isFreshDelivery(`ingest:${partnerId}`, envelopeId, envelope);
  if (!fresh) {
    return NextResponse.json({ status: "duplicate" }, { status: 200 });
  }

  // Dispatch via the partner's adapter
  const adapter = await getAdapterForPartner(partnerId);
  const normalised = await adapter.normaliseInboundWebhook(envelope);

  const source = `ingest:${partnerId}`;

  // No-handler events (FinalFareReleased, DriverPositionChanged, unknown) — ack
  // and move on. Karhoo will not retry on 200.
  if (!normalised) {
    await recordWebhookOutcome(source, envelopeId, "ack_unhandled");
    return NextResponse.json({ status: "acked_unhandled", event_type: envelope.event_type }, { status: 200 });
  }

  if (normalised.kind === "create") {
    try {
      // P0-3: receive + ack in tens of ms. The actual routing happens on the
      // background drain (/api/cron/process-queue or the demo tick). Slow
      // recipient adapters no longer block the originator's webhook ack.
      const result = await receiveBooking({
        originatorPartnerId: partnerId,
        booking: normalised.booking,
      });
      await recordWebhookOutcome(
        source,
        envelopeId,
        result.outcome === "duplicate" ? "duplicate" : "routed",
      );
      return NextResponse.json(
        { status: result.outcome, transitId: result.transitId },
        { status: 200 },
      );
    } catch (err) {
      await recordWebhookOutcome(source, envelopeId, "error");
      throw err;
    }
  }

  if (normalised.kind === "status") {
    const [transit] = await db
      .select()
      .from(transits)
      .where(eq(transits.recipientBookingExternalId, normalised.recipientBookingExternalId));

    if (!transit) {
      console.warn(
        `[webhook] status update for unknown trip ${normalised.recipientBookingExternalId} from partner ${partnerId}`,
      );
      await recordWebhookOutcome(source, envelopeId, "orphan");
      return NextResponse.json({ status: "orphan", trip_id: normalised.recipientBookingExternalId }, { status: 200 });
    }

    try {
      await forwardStatusUpdate({
        transitId: transit.id,
        newStatus: normalised.newStatus as never,
        detail: normalised.detail,
      });
      await recordWebhookOutcome(source, envelopeId, "applied");
      return NextResponse.json({ status: "applied", transit_id: transit.id, new_status: normalised.newStatus }, { status: 200 });
    } catch (err) {
      await recordWebhookOutcome(source, envelopeId, "error");
      throw err;
    }
  }

  await recordWebhookOutcome(source, envelopeId, "ack_unhandled");
  return NextResponse.json({ status: "acked_unhandled" }, { status: 200 });
}

/**
 * HMAC-SHA512 of body bytes, lowercase hex, constant-time compare.
 */
function verifyHmacSha512(body: string, providedHex: string, secret: string): boolean {
  if (!providedHex) return false;
  const expectedHex = createHmac("sha512", secret).update(body, "utf8").digest("hex");
  if (expectedHex.length !== providedHex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expectedHex, "utf8"), Buffer.from(providedHex.toLowerCase(), "utf8"));
  } catch {
    return false;
  }
}
