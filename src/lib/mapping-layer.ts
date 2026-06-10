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
    create_booking?: EndpointSpec;
    quote?: EndpointSpec;
    cancel?: EndpointSpec;
    get_booking?: EndpointSpec;
    update_booking?: EndpointSpec;
  };
};

/**
 * Endpoint spec — either a plain URL string (assumed POST, no templating)
 * or an object with explicit method + URL template. The URL can contain
 * `{external_id}` which is substituted at call time with the recipient
 * booking's external id (the value the partner returned when we created
 * the booking).
 *
 * CMAC's cancel is `DELETE /Jobs/{id}`, get is `GET /Jobs/{id}` — both
 * need the object shape. FreeNow's POST /bookings is fine as a string.
 */
export type EndpointSpec =
  | string
  | {
      url: string;
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    };

export type FieldMapping = {
  /** The field name the partner uses on the wire. */
  partner_field: string;
  /** When true, applyMapping fails if the canonical value is missing. */
  required?: boolean;
  /**
   * Transformation applied EMITTING (canonical → partner). Three families:
   *
   *   divide          — partnerValue = canonicalValue / N. e.g. seconds →
   *                     minutes via divide: 60.
   *   multiply        — partnerValue = canonicalValue * N. e.g. minutes →
   *                     seconds via multiply: 60. £ → pence via multiply: 100.
   *   format_datetime — convert an ISO 8601 timestamp into the partner's
   *                     wire-shaped date string. CMAC wants "yyyy-MM-dd HH:mm"
   *                     in LOCAL time with NO timezone marker; other partners
   *                     may want similar. Specify `tz` (an IANA timezone) and
   *                     `format` (one of the supported tokens below).
   *
   *                     Supported format tokens (we don't pull in date-fns;
   *                     keep the engine dep-free):
   *                       "yyyy-MM-dd HH:mm"   "yyyy-MM-dd HH:mm:ss"
   *                       "yyyy-MM-ddTHH:mm"   "yyyy-MM-ddTHH:mm:ss"
   *                       "dd/MM/yyyy HH:mm"
   *
   * Reverse direction:
   *   - divide/multiply are inverted on receive.
   *   - format_datetime is RECEIVE-NO-OP — partners send dates back in many
   *     shapes (ISO, epoch, partner-local strings); reverse mapping just
   *     passes the value through. Callers that need parsing handle it.
   */
  transform?:
    | { type: "divide"; value: number }
    | { type: "multiply"; value: number }
    | { type: "format_datetime"; format: string; tz?: string };
  /**
   * Forward value lookup: canonical enum → partner enum.
   * Emitted: lookup the canonical value as a key, use the partner value.
   * Received: reverse lookup — find the canonical value where the
   * partner value matches.
   *
   * Values can be string | number | boolean — some partners use numeric
   * enums (e.g. CMAC: { "saloon": 1, "exec": 6, "mpv": 5, "wav": 14 }).
   * Keys are always strings (JS object key constraint); the engine
   * stringifies canonical values before lookup so numeric canonical
   * values still work.
   */
  value_lookup?: Record<string, string | number | boolean>;
  /**
   * Receive-only value lookup: partner enum → canonical enum. Used when
   * the canonical value flows FROM the partner only (e.g. booking.status
   * comes back from the partner; we don't tell them their status).
   *
   * Same string|number|boolean value tolerance. CMAC example:
   *   { "1": "received", "2": "accepted", "9": "driver_assigned", ... }
   * Keys here represent the PARTNER value; the engine stringifies the
   * incoming partner value before lookup.
   */
  value_lookup_reverse?: Record<string, string | number | boolean>;
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

    // 1. Apply value_lookup if present. Canonical value is stringified
    //    for the key lookup so numeric canonical values work (rare, but
    //    happens when canonical fields are themselves enums-as-numbers).
    //    Emitted value is whatever the config supplies (string, number,
    //    boolean) — partners expecting numeric IDs get them as numbers.
    //    Unknown values pass through unchanged + warning.
    if (mapping.value_lookup && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
      const key = String(value);
      const mapped = mapping.value_lookup[key];
      if (mapped === undefined) {
        warnings.push(
          `value_lookup miss for "${canonicalPath}": canonical value "${key}" not in lookup table; passing through unchanged`,
        );
      } else {
        transformed = mapped;
      }
    }

    // 2. Apply transformation.
    //    divide/multiply: numeric, applied EMITTING; inverse on receive.
    //    format_datetime: string → string, EMIT only (receive is no-op).
    if (mapping.transform) {
      if (mapping.transform.type === "format_datetime") {
        try {
          transformed = formatDateTime(
            transformed,
            mapping.transform.format,
            mapping.transform.tz,
          );
        } catch (err) {
          warnings.push(
            `format_datetime transform on "${canonicalPath}" failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          // Fall through with untransformed value — caller may still want it.
        }
      } else if (typeof transformed === "number") {
        transformed = applyTransform(transformed, mapping.transform, "emit");
      } else {
        warnings.push(
          `transform "${mapping.transform.type}" on "${canonicalPath}" expects a number; got ${typeof transformed}; skipping transform`,
        );
      }
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

    // 1. Reverse transformation.
    //    divide/multiply: inverted on receive.
    //    format_datetime: receive is a pass-through — partners send dates
    //    back in many shapes (ISO, epoch, partner-local strings); leave the
    //    raw value for callers to parse.
    if (mapping.transform && mapping.transform.type === "format_datetime") {
      // no-op
    } else if (mapping.transform && typeof recovered === "number") {
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
    // Partner value is stringified for the key lookup so numeric IDs
    // (e.g. CMAC status=1) match the config keys cleanly.
    const isLookupable = typeof recovered === "string" || typeof recovered === "number" || typeof recovered === "boolean";
    if (mapping.value_lookup_reverse && isLookupable) {
      const key = String(recovered);
      const mapped = mapping.value_lookup_reverse[key];
      if (mapped === undefined) {
        warnings.push(
          `value_lookup_reverse miss on "${canonicalPath}": partner value "${key}" not in reverse table`,
        );
      } else {
        recovered = mapped;
      }
    } else if (mapping.value_lookup && isLookupable) {
      const inverse = invertLookup(mapping.value_lookup);
      const key = String(recovered);
      const mapped = inverse[key];
      if (mapped === undefined) {
        warnings.push(
          `value_lookup inverse miss on "${canonicalPath}": partner value "${key}" not in forward table`,
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

/**
 * Format a date/time value into the partner's expected wire shape.
 *
 * Accepts a string (parsed as ISO) or a Date. Renders in the supplied IANA
 * timezone (default UTC) using a small whitelist of format tokens — no
 * date-fns dependency. Throws on unparseable input or unknown format.
 */
function formatDateTime(value: unknown, format: string, tz?: string): string {
  if (value == null) throw new Error("value is null/undefined");
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`cannot parse "${String(value)}" as a date`);
  }
  // Use Intl.DateTimeFormat for TZ-aware part extraction. en-GB gives us
  // 24h format and dd/MM/yyyy ordering, which we then re-assemble per the
  // requested format token.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const p: Record<string, string> = {};
  for (const part of parts) p[part.type] = part.value;
  // Intl returns "24" for midnight in en-GB; remap to "00" for SQL-friendly
  // output. This bites on Europe/London right at midnight if not fixed.
  if (p.hour === "24") p.hour = "00";

  switch (format) {
    case "yyyy-MM-dd HH:mm":
      return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
    case "yyyy-MM-dd HH:mm:ss":
      return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
    case "yyyy-MM-ddTHH:mm":
      return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
    case "yyyy-MM-ddTHH:mm:ss":
      return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
    case "dd/MM/yyyy HH:mm":
      return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
    default:
      throw new Error(
        `unknown format "${format}" — supported: "yyyy-MM-dd HH:mm", "yyyy-MM-dd HH:mm:ss", "yyyy-MM-ddTHH:mm", "yyyy-MM-ddTHH:mm:ss", "dd/MM/yyyy HH:mm"`,
      );
  }
}

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

function invertLookup(
  forward: Record<string, string | number | boolean>,
): Record<string, string> {
  const inv: Record<string, string> = {};
  for (const [k, v] of Object.entries(forward)) {
    const vKey = String(v);
    if (inv[vKey] !== undefined) {
      // Two canonical values map to the same partner value — inversion
      // ambiguous. Keep the first (deterministic). Caller can use
      // value_lookup_reverse instead if disambiguation is needed.
      continue;
    }
    inv[vKey] = k;
  }
  return inv;
}

/**
 * Resolve an EndpointSpec to { url, method }. The url has `{external_id}`
 * substituted with the supplied id if present in the template.
 */
export function resolveEndpoint(
  spec: EndpointSpec | undefined,
  externalId?: string,
): { url: string; method: string } | null {
  if (!spec) return null;
  if (typeof spec === "string") {
    return { url: substituteId(spec, externalId), method: "POST" };
  }
  return {
    url: substituteId(spec.url, externalId),
    method: spec.method ?? "POST",
  };
}

function substituteId(url: string, externalId?: string): string {
  if (externalId === undefined) return url;
  return url.replace(/\{external_id\}/g, encodeURIComponent(externalId));
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
        ? { value_lookup: m.value_lookup as Record<string, string | number | boolean> }
        : {}),
      ...(m.value_lookup_reverse && typeof m.value_lookup_reverse === "object"
        ? { value_lookup_reverse: m.value_lookup_reverse as Record<string, string | number | boolean> }
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
