import { beforeEach, describe, expect, it, vi } from "vitest";
import { webhookDeliveries } from "@/db/schema";

/**
 * Webhook idempotency (src/lib/idempotency.ts) — the dedupe layer stopping a
 * re-delivered webhook from double-applying state transitions (double
 * completion, double fees). The (source, sourceEventId) unique constraint
 * lives in Postgres; the mocked insert simulates its violation as a throw.
 */

const dbController = {
  /** When set, insert rejects like a unique violation. */
  insertError: null as Error | null,
  inserts: [] as { table: unknown; values: Record<string, unknown> }[],
  updates: [] as { table: unknown; set: Record<string, unknown> }[],
};

vi.mock("@/db/client", () => ({
  db: {
    insert: (table: unknown) => ({
      values: async (vals: Record<string, unknown>) => {
        if (dbController.insertError) throw dbController.insertError;
        dbController.inserts.push({ table, values: vals });
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: async (_cond: unknown) => {
          dbController.updates.push({ table, set });
        },
      }),
    }),
  },
}));

import {
  isFreshDelivery,
  recordWebhookOutcome,
  recordRejectedDelivery,
} from "@/lib/idempotency";

beforeEach(() => {
  dbController.insertError = null;
  dbController.inserts = [];
  dbController.updates = [];
});

describe("isFreshDelivery — first-seen vs duplicate", () => {
  it("returns true for a first-time delivery and records the payload", async () => {
    // First sighting: row written with the raw payload for the inspector.
    const payload = { event: "trip.completed", id: "evt-1" };
    await expect(isFreshDelivery("icabbi", "evt-1", payload)).resolves.toBe(true);
    expect(dbController.inserts).toHaveLength(1);
    expect(dbController.inserts[0].table).toBe(webhookDeliveries);
    expect(dbController.inserts[0].values).toMatchObject({
      source: "icabbi",
      sourceEventId: "evt-1",
      payload,
    });
  });

  it("returns false when the insert hits the unique constraint (duplicate)", async () => {
    // THE idempotency property: a redelivery reads stale → caller ack-and-skips.
    dbController.insertError = new Error(
      'duplicate key value violates unique constraint "webhook_deliveries_source_event_unique"',
    );
    await expect(isFreshDelivery("icabbi", "evt-1", {})).resolves.toBe(false);
  });

  it("treats ANY insert failure as a duplicate (fail-closed dedupe)", async () => {
    // FLAG (actual behavior): blanket catch — a transient DB outage also
    // reads "duplicate" → event skipped, not retried. Tightening is a source change.
    dbController.insertError = new Error("connection refused");
    await expect(isFreshDelivery("icabbi", "evt-2", {})).resolves.toBe(false);
  });
});

describe("recordWebhookOutcome", () => {
  it("updates the delivery row with the outcome and a processedAt stamp", async () => {
    // Inspector needs outcome + processedAt written together.
    await recordWebhookOutcome("icabbi", "evt-1", "applied");
    expect(dbController.updates).toHaveLength(1);
    expect(dbController.updates[0].table).toBe(webhookDeliveries);
    expect(dbController.updates[0].set.outcome).toBe("applied");
    expect(dbController.updates[0].set.processedAt).toBeInstanceOf(Date);
  });

  it("records security-relevant outcomes like auth_invalid", async () => {
    // auth_invalid surfaces rejected callers in the audit trail unmodified.
    await recordWebhookOutcome("icabbi", "evt-2", "auth_invalid");
    expect(dbController.updates[0].set.outcome).toBe("auth_invalid");
  });
});

describe("recordRejectedDelivery — pre-idempotency rejections", () => {
  it("writes a synthetic-id row carrying the reason and payload", async () => {
    // Pre-dedupe rejections (bad HMAC, unknown partner) still get an audit
    // row; the "rejected-" synthetic id encodes the reason and can't collide
    // with a real envelope id.
    const payload = { raw: "tampered" };
    await recordRejectedDelivery("icabbi", "signature_invalid", payload);
    expect(dbController.inserts).toHaveLength(1);
    const v = dbController.inserts[0].values;
    expect(v.source).toBe("icabbi");
    expect(v.outcome).toBe("signature_invalid");
    expect(v.payload).toBe(payload);
    expect(v.processedAt).toBeInstanceOf(Date);
    expect(String(v.sourceEventId)).toMatch(/^rejected-signature_invalid-\d+-[a-z0-9]*$/);
  });

  it("generates distinct synthetic ids for back-to-back rejections", async () => {
    // Same-millisecond rejections stay distinct via the random suffix.
    await recordRejectedDelivery("icabbi", "auth_invalid", {});
    await recordRejectedDelivery("icabbi", "auth_invalid", {});
    const [a, b] = dbController.inserts.map((i) => i.values.sourceEventId);
    expect(a).not.toBe(b);
  });

  it("swallows insert failures instead of crashing the webhook handler", async () => {
    // Best-effort audit: a DB hiccup must not turn a clean 401 into a 500.
    dbController.insertError = new Error("unique constraint race");
    await expect(
      recordRejectedDelivery("icabbi", "error", {}),
    ).resolves.toBeUndefined();
  });
});
