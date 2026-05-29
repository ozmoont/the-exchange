import type { PartnerAdapter } from "@/lib/types";
import { MockICabbiAdapter } from "./mock-icabbi";
import { MockCMACAdapter } from "./mock-cmac";
import { ICabbiAdapter, type ICabbiCredentials } from "./icabbi";
import { db } from "@/db/client";
import { partners } from "@/db/schema";
import { eq } from "drizzle-orm";
import { decryptIfNeeded } from "@/lib/crypto";

/**
 * Adapter registry. Maps partners.adapterKey -> constructor.
 *
 * `mock_icabbi` and `mock_cmac` are used for local dev / smoke tests.
 * `icabbi` is the real adapter — instantiated once a partner has live
 * credentials saved. Flip via partners.adapterKey or the partner edit page.
 */

type AdapterFactory = (partnerId: string, credentials: Record<string, unknown> | null) => PartnerAdapter;

const factories: Record<string, AdapterFactory> = {
  mock_icabbi: (partnerId, creds) =>
    new MockICabbiAdapter(partnerId, (creds?.tenantLabel as string) ?? partnerId.slice(0, 4)),
  mock_cmac: (partnerId) => new MockCMACAdapter(partnerId),
  icabbi: (partnerId, creds) => {
    if (!creds) {
      throw new Error(`Partner ${partnerId} has adapterKey "icabbi" but no credentials saved`);
    }
    return new ICabbiAdapter(partnerId, creds as unknown as ICabbiCredentials);
  },
  // cmac: (partnerId, creds) => new CMACAdapter(partnerId, creds as CMACCreds),
};

const cache = new Map<string, PartnerAdapter>();

export async function getAdapterForPartner(partnerId: string): Promise<PartnerAdapter> {
  if (cache.has(partnerId)) return cache.get(partnerId)!;
  const [row] = await db.select().from(partners).where(eq(partners.id, partnerId));
  if (!row) throw new Error(`Partner ${partnerId} not found`);
  const factory = factories[row.adapterKey];
  if (!factory) throw new Error(`No adapter registered for key "${row.adapterKey}"`);
  // Credentials may be encrypted at rest — decryptIfNeeded is plaintext-safe.
  const creds = decryptIfNeeded(row.credentials as Record<string, unknown> | null);
  const adapter = factory(partnerId, creds);
  cache.set(partnerId, adapter);
  return adapter;
}

/**
 * Clear the in-memory adapter cache. Call this after a partner's credentials
 * or adapterKey changes so the next routing decision picks up the new value.
 */
export function clearAdapterCache(partnerId?: string) {
  if (partnerId) cache.delete(partnerId);
  else cache.clear();
}
