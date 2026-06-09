import type { PartnerAdapter } from "@/lib/types";
import { MockICabbiAdapter } from "./mock-icabbi";
import { MockCMACAdapter } from "./mock-cmac";
import { MockFreeNowAdapter } from "./mock-freenow";
import { ICabbiAdapter, type ICabbiCredentials } from "./icabbi";
import { GenericMappedAdapter } from "./generic-mapped";
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

// All factories accept (partnerId, credentials, fieldMappings). Hand-coded
// adapters ignore the third arg; generic_mapped uses it. Single signature
// keeps the factories map's typing clean.
type AdapterFactory = (
  partnerId: string,
  credentials: Record<string, unknown> | null,
  fieldMappings: unknown,
) => PartnerAdapter;

const factories: Record<string, AdapterFactory> = {
  mock_icabbi: (partnerId, creds) =>
    new MockICabbiAdapter(partnerId, (creds?.tenantLabel as string) ?? partnerId.slice(0, 4)),
  mock_cmac: (partnerId) => new MockCMACAdapter(partnerId),
  mock_freenow: (partnerId) => new MockFreeNowAdapter(partnerId),
  icabbi: (partnerId, creds) => {
    if (!creds) {
      throw new Error(`Partner ${partnerId} has adapterKey "icabbi" but no credentials saved`);
    }
    return new ICabbiAdapter(partnerId, creds as unknown as ICabbiCredentials);
  },
  // H2 — generic configuration-driven adapter. Reads partner.fieldMappings
  // + partner.credentials + partner.authMechanism at construction. No
  // partner-specific code path.
  generic_mapped: (partnerId, creds, fieldMappings) =>
    new GenericMappedAdapter(
      partnerId,
      (creds ?? {}) as ConstructorParameters<typeof GenericMappedAdapter>[1],
      fieldMappings,
    ),
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
  // Pass fieldMappings as a third arg for adapters that consume it
  // (generic_mapped). Hand-coded adapters ignore it.
  const adapter = factory(partnerId, creds, row.fieldMappings);
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
