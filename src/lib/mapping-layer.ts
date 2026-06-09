/**
 * H2 Mapping Layer — runtime engine.
 *
 * Per iCabbi BDD Epic 3 + STRATEGY.md decision #13. Translates between our
 * canonical schema (docs/CANONICAL_FIELDS.md) and a partner's native field
 * names + value vocabularies + units, driven entirely by configuration
 * stored in `partners.fieldMappings`. No code changes required to add or
 * modify a partner.
 *
 * This file is the library. The first consumer is a future
 * `generic_mapped` adapter — not yet wired (per spec out-of-scope). Today
 * the engine sits unused until partner #4.
 *
 * NFR: <50ms per call. All transformations are local computation, no
 * I/O. Config is cached in-memory keyed by partner id; cache is
 * invalidated when admin saves a new mapping.
 *
 * Spec: docs/specs/H2-mapping-layer.md
 */

import { log } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Types — the on-disk shape of partners.fieldMappings
// ---------------------------------------------------------------------------

export type MappingConfig = {
  fields: Record<string, FieldMapping>;
  endpoints?: {
    create_booking?: string;
    quote?: string;
    cancel?: string;
  };
};

export type FieldMapping = {
  /** The field name the partner uses on the wire. */
  partner_field: string;
  /** When true, applyMapping fails if the canonical value is missing. */
  required?: boolean;
  /**
   * Numeric transformation applied EMITTING (canonical → partner).
   *   divide   — partnerValue = canonicalValue / N (e.g. minutes → seconds via multiply)
   *   multiply — partnerValue = canonicalValue * N (e.g. £ → pence via multiply: 100)
   * Reverse direction is the inverse.
   *
   * For unit conversions: think in terms of how the partner expects the
   * value. If the partner wants eta_seconds and we have eta_minutes,
   * use multiply: 60.
   */
  transform?: { type: "divide" | "multiply"; value: number };
  /**
   * Forward value lookup: canonical enum → partner enum.
   * Emitted: lookup the canonical value as a key, use the partner value.
   * Received: reverse lookup — find the canonical value where the
   * partner value matches.
   * Example: { saloon: "ECO", exec: "BUSINESS" } for vehicle_type.
   */
  value_lookup?: Record<string, string>;
  /**
   * Receive-only value lookup: partner enum → canonical enum. Used when
   * the canonical value flows FROM the partner only (e.g. booking.status
   * comes back from the partner; we don't tell them their status).
   * Example: { ACCEPTED: "Accepted", IN_PROGRESS: "Passenger On Board" }.
   */
  value_lookup_reverse?: Record<string, string>;
};

export type ApplyMappingSuccess = {
  ok: true;
  payload: Record<string, unknown>;
  warnings: string[];
};

export type ApplyMappingFailure = {
  ok: false;
  /** Canonical fields that were marked required but had no value. */
  missing: string[];
  warnings: string[];
};

export type ApplyMappingResult = ApplyMappingSuccess | ApplyMappingFailure;

export type ReverseMappingResult =
  | { ok: true; canonical: Record<string, unknown>; warnings: string[] }
  | { ok: false; warnings: string[] };

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Translate a canonical object (e.g. NormalisedBooking) into the partner's
 * wire shape. Output keys are flat partner field names; nested canonical
 * paths (`pickup.lat`) are resolved against the input object's structure.
 *
 * Returns `ok:false` only when a `required: true` canonical field has no
 * value to map. All other inconsistencies produce warnings but still
 * yield a payload (best-effort emission).
 */
export function applyMapping(
  canonical: Record<string, unknown>,
  config: MappingConfig,
): ApplyMappingResult {
  const payload: Record<string, unknown> = {};
  const missing: string[] = [];
  const warnings: string[] = [];

  for (const [canonicalPath, mapping] of Object.entries(config.fields)) {
    const value = getByPath(canonical, canonicalPath);
    if (value === undefined || value === null) {
      if (mapping.required) {
        missing.push(canonicalPath);
      }
      // Unmapped optional field → omit. Per BDD Story 3.1 ("the unmapped
      // field is omitted from the request and a mapping gap warning is
      // logged but the booking is not blocked").
      continue;
    }

    let transformed: unknown = value;

    // 1. Apply value_lookup if present and the value is a string we can
    //    look up. Unknown values pass through unchanged + warning.
    if (mapping.value_lookup && typeof value === "string") {
      const mapped = mapping.value_lookup[value];
      if (mapped === undefined) {
        warnings.push(
          `value_lookup miss for "${canonicalPath}": canonical value "${value}" not in lookup table; passing through unchanged`,
        );
      } else {
        transformed = mapped;
      }
    }

    // 2. Apply numeric transformation. Per spec: divide/multiply are
    //    applied EMITTING; reverse is the inverse on receive.
    if (mapping.transform && typeof transformed === "number") {
      transformed = applyTransform(transformed, mapping.transform, "emit");
    } else if (mapping.transform) {
      warnings.push(
        `transform "${mapping.transform.type}" on "${canonicalPath}" expects a number; got ${typeof transformed}; skipping transform`,
      );
    }

    setByPath(payload, mapping.partner_field, transformed);
  }

  if (missing.length > 0) {
    return { ok: false, missing, warnings };
  }
  return { ok: true, payload, warnings };
}

/**
 * Translate a partner-shaped payload back into canonical keys + values.
 * Used when the partner responds (e.g. quote response, status webhook).
 *
 * Always succeeds (warnings only) — receiving a partial payload is
 * normal. Caller decides whether missing fields are a problem.
 */
export function reverseMapping(
  partnerPayload: Record<string, unknown>,
  config: MappingConfig,
): ReverseMappingResult {
  const canonical: Record<string, unknown> = {};
  const warnings: string[] = [];

  for (const [canonicalPath, mapping] of Object.entries(config.fields)) {
    const partnerValue = getByPath(partnerPayload, mapping.partner_field);
    if (partnerValue === undefined || partnerValue === null) continue;

    let recovered: unknown = partnerValue;

    // 1. Reverse numeric transformation
    if (mapping.transform && typeof recovered === "number") {
      recovered = applyTransform(recovered, mapping.transform, "receive");
    } else if (mapping.transform) {
      warnings.push(
        `reverse transform "${mapping.transform.type}" on "${canonicalPath}" expects a number; got ${typeof recovered}; skipping`,
      );
    }

    // 2. Reverse value lookup. Two cases:
    //    (a) value_lookup is forward-only (canonical → partner). To reverse,
    //        find the canonical key whose partner-value matches recovered.
    //    (b) value_lookup_reverse is a receive-only map (partner → canonical).
    //        Apply directly.
    if (mapping.value_lookup_reverse && typeof recovered === "string") {
      const mapped = mapping.value_lookup_reverse[recovered];
      if (mapped === undefined) {
        warnings.push(
          `value_lookup_reverse miss on "${canonicalPath}": partner value "${recovered}" not in reverse table`,
        );
      } else {
        recovered = mapped;
      }
    } else if (mapping.value_lookup && typeof recovered === "string") {
      const inverse = invertLookup(mapping.value_lookup);
      const mapped = inverse[recovered];
      if (mapped === undefined) {
        warnings.push(
          `value_lookup inverse miss on "${canonicalPath}": partner value "${recovered}" not in forward table`,
        );
      } else {
        recovered = mapped;
      }
    }

    setByPath(canonical, canonicalPath, recovered);
  }

  return { ok: true, canonical, warnings };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function applyTransform(
  value: number,
  transform: { type: "divide" | "multiply"; value: number },
  direction: "emit" | "receive",
): number {
  // "emit" applies the transform as declared. "receive" applies the
  // inverse — flip divide ↔ multiply.
  const effective =
    direction === "emit"
      ? transform.type
      : transform.type === "divide"
      ? "multiply"
      : "divide";
  if (transform.value === 0) {
    log.warn("mapping-layer: refusing zero-division/multiplication", { transform });
    return value;
  }
  return effective === "divide" ? value / transform.value : value * transform.value;
}

function invertLookup(forward: Record<string, string>): Record<string, string> {
  const inv: Record<string, string> = {};
  for (const [k, v] of Object.entries(forward)) {
    if (inv[v] !== undefined) {
      // Two canonical values map to the same partner value — inversion
      // ambiguous. Keep the first (deterministic). Caller can use
      // value_lookup_reverse instead if disambiguation is needed.
      continue;
    }
    inv[v] = k;
  }
  return inv;
}

/**
 * Resolve a dot-notation path against a nested object. Returns undefined
 * for any missing intermediate. Does NOT throw.
 */
export function getByPath(obj: Record<string, unknown>, path: string): unknown {
  if (!path) return undefined;
  let cursor: unknown = obj;
  for (const segment of path.split(".")) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * Write a value at a dot-notation path, creating intermediate objects as
 * needed. Used to build the partner payload + canonical recovery shape.
 */
export function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  if (!path) return;
  const segments = path.split(".");
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const existing = cursor[seg];
    if (existing === undefined || existing === null || typeof existing !== "object") {
      cursor[seg] = {};
    }
    cursor = cursor[seg] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]] = value;
}

// ---------------------------------------------------------------------------
// In-memory cache — per BDD NFR
// ---------------------------------------------------------------------------

const configCache = new Map<string, MappingConfig | null>();

/**
 * Return the cached MappingConfig for a partner. Caller (typically an
 * adapter) supplies the raw config from the partner row's
 * fieldMappings column on first call; subsequent calls hit the cache.
 *
 * Returns null when the partner has no mapping configured (most current
 * partners — they use their hand-coded adapter).
 */
export function loadMappingConfig(
  partnerId: string,
  rawConfig: unknown,
): MappingConfig | null {
  if (configCache.has(partnerId)) return configCache.get(partnerId) ?? null;
  if (!rawConfig || typeof rawConfig !== "object") {
    configCache.set(partnerId, null);
    return null;
  }
  const normalised = normaliseConfig(rawConfig as Record<string, unknown>);
  configCache.set(partnerId, normalised);
  return normalised;
}

/** Invalidate one partner's cached mapping (or all). Call after admin save. */
export function clearMappingCache(partnerId?: string): void {
  if (partnerId) configCache.delete(partnerId);
  else configCache.clear();
}

function normaliseConfig(raw: Record<string, unknown>): MappingConfig | null {
  const fieldsRaw = raw.fields;
  if (!fieldsRaw || typeof fieldsRaw !== "object") return null;
  const fields: Record<string, FieldMapping> = {};
  for (const [k, v] of Object.entries(fieldsRaw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const m = v as Record<string, unknown>;
    if (typeof m.partner_field !== "string") continue;
    fields[k] = {
      partner_field: m.partner_field,
      ...(typeof m.required === "boolean" ? { required: m.required } : {}),
      ...(m.transform && typeof m.transform === "object"
        ? { transform: m.transform as FieldMapping["transform"] }
        : {}),
      ...(m.value_lookup && typeof m.value_lookup === "object"
        ? { value_lookup: m.value_lookup as Record<string, string> }
        : {}),
      ...(m.value_lookup_reverse && typeof m.value_lookup_reverse === "object"
        ? { value_lookup_reverse: m.value_lookup_reverse as Record<string, string> }
        : {}),
    };
  }
  return {
    fields,
    ...(raw.endpoints && typeof raw.endpoints === "object"
      ? { endpoints: raw.endpoints as MappingConfig["endpoints"] }
      : {}),
  };
}
