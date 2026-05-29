/**
 * UK coverage map. Server component, plain SVG, no client-side libraries.
 *
 * Renders a UK outline (simplified path) overlaid with:
 *   - Fleet centroids: ringed circles sized by win count, brand-coloured.
 *   - Recent pickup points: small dots coloured by booking status group
 *     (success / in-flight / failed).
 *   - A handful of major city labels for orientation.
 *
 * Lat/lng are projected with a simple equirectangular projection centered on
 * the UK. Adequate for the rough heat-map view we want — no need for a real
 * map library.
 */

import { statusMeta, type StatusTone } from "@/lib/status-labels";

// UK bounding box used for the projection. Lat/lng inside this rect maps to
// 0..VIEW_W / 0..VIEW_H. Anything outside is clamped (rare — would only
// happen if someone seeded data offshore).
const LAT_MIN = 49.5; // Lizard Point area
const LAT_MAX = 59.0; // Northern Shetland is excluded; covers John o' Groats
const LNG_MIN = -8.5; // West coast of NI / Outer Hebrides
const LNG_MAX = 2.0;  // East Anglia coast

const VIEW_W = 700;
const VIEW_H = 900;

// Project lat/lng → SVG x/y. Y is flipped because SVG origin is top-left.
function project(lat: number, lng: number): { x: number; y: number } {
  const x = ((lng - LNG_MIN) / (LNG_MAX - LNG_MIN)) * VIEW_W;
  const y = VIEW_H - ((lat - LAT_MIN) / (LAT_MAX - LAT_MIN)) * VIEW_H;
  return { x: clamp(x, 0, VIEW_W), y: clamp(y, 0, VIEW_H) };
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

// Simplified UK outline — drawn as a series of points at coastal cities.
// Detail is intentionally low; the goal is "you can see it's the UK", not
// surveyor accuracy. Closing path forms the silhouette.
const UK_OUTLINE_LATLNG: Array<[number, number]> = [
  // Southern England (west to east)
  [50.10, -5.55], // Land's End
  [50.20, -3.55], // S Devon
  [50.40, -2.45], // Weymouth
  [50.74, -1.27], // Isle of Wight north
  [50.78, -0.80], // Worthing
  [50.85, 0.55],  // Hastings
  [51.10, 1.34],  // Dover
  [51.38, 1.40],  // Margate
  // Up the east coast
  [52.06, 1.34],  // Felixstowe
  [52.62, 1.73],  // Lowestoft
  [53.07, 0.31],  // Boston
  [53.58, -0.06], // Hull (approx)
  [54.27, -0.40], // Scarborough
  [54.95, -1.36], // Whitley Bay
  [55.57, -1.62], // Bamburgh
  [56.06, -2.71], // Dunbar
  [56.45, -2.59], // Carnoustie
  [57.15, -2.06], // Aberdeen
  [57.70, -2.30], // Banff
  [58.65, -3.05], // John o' Groats
  // North coast of Scotland
  [58.55, -4.30], // Bettyhill
  [58.50, -5.10], // Cape Wrath area
  // West coast of Scotland
  [58.20, -5.50], // Coigach
  [57.70, -5.70], // Ullapool W
  [57.10, -5.80], // Skye
  [56.65, -6.20], // Mull
  [55.93, -6.10], // Islay
  [55.30, -5.30], // Kintyre tip
  [55.00, -5.40], // S Kintyre
  [54.95, -4.95], // Mull of Galloway
  [54.85, -4.30], // Wigtown bay
  [54.85, -3.50], // Solway
  // Cumbria into Wales
  [54.10, -3.20], // Barrow
  [53.85, -3.05], // Blackpool
  [53.35, -3.00], // Liverpool bay
  [53.30, -4.30], // Anglesey
  [52.92, -4.85], // Llŷn peninsula
  [52.40, -4.10], // Aberystwyth
  [51.80, -4.70], // Pembrokeshire N
  [51.65, -5.30], // St David's
  [51.40, -4.10], // Carmarthen bay
  [51.55, -3.20], // Cardiff approx
  [51.30, -3.05], // Bristol channel S
  [51.10, -4.20], // N Devon
  [50.20, -5.55], // Lizard south (close loop)
];

const UK_PATH = (() => {
  const parts = UK_OUTLINE_LATLNG.map(([lat, lng], i) => {
    const { x, y } = project(lat, lng);
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return parts.join(" ") + " Z";
})();

// Northern Ireland — drawn as a separate path.
const NI_OUTLINE_LATLNG: Array<[number, number]> = [
  [55.20, -6.20], // Portrush area
  [55.20, -6.05], // Ballycastle
  [54.85, -5.55], // Larne / coast
  [54.55, -5.55], // Belfast Lough
  [54.30, -5.55], // Strangford / Down
  [54.10, -6.30], // Newry / S Down
  [54.10, -7.30], // Fermanagh corner
  [54.50, -8.00], // West edge
  [55.00, -7.65], // Donegal border
  [55.20, -6.95], // Coleraine area
];

const NI_PATH = (() => {
  const parts = NI_OUTLINE_LATLNG.map(([lat, lng], i) => {
    const { x, y } = project(lat, lng);
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return parts.join(" ") + " Z";
})();

// Reference cities — never drawn as fleet/job markers, just orientation labels.
const REFERENCE_CITIES: Array<{ name: string; lat: number; lng: number }> = [
  { name: "London", lat: 51.507, lng: -0.128 },
  { name: "Birmingham", lat: 52.486, lng: -1.890 },
  { name: "Manchester", lat: 53.481, lng: -2.244 },
  { name: "Leeds", lat: 53.801, lng: -1.549 },
  { name: "Glasgow", lat: 55.864, lng: -4.252 },
  { name: "Edinburgh", lat: 55.953, lng: -3.188 },
  { name: "Cardiff", lat: 51.481, lng: -3.179 },
  { name: "Belfast", lat: 54.597, lng: -5.930 },
  { name: "Newcastle", lat: 54.978, lng: -1.617 },
  { name: "Aberdeen", lat: 57.149, lng: -2.094 },
];

// Fleet marker tone — used for the ring; size scales with win count.
const FLEET_COLOR_FILL = "rgba(37, 99, 235, 0.18)"; // blue-600 @ 18%
const FLEET_COLOR_STROKE = "#2563eb";

// Pickup marker colour by booking status tone.
const PICKUP_COLOR: Record<StatusTone, string> = {
  success: "#16a34a", // green-600 — completed
  info: "#0ea5e9",    // sky-500 — in flight
  danger: "#dc2626",  // red-600 — error / no match / cancelled
  warning: "#f59e0b", // amber-500 — paused
  neutral: "#94a3b8", // slate-400
};

type Fleet = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  wins: number;
};

type Pickup = {
  lat: number;
  lng: number;
  status: string;
};

export function UKCoverageMap({
  fleets,
  pickups,
}: {
  fleets: Fleet[];
  pickups: Pickup[];
}) {
  const maxWins = Math.max(1, ...fleets.map((f) => f.wins));

  // Compute fleet radii. Sqrt scale so a fleet with 100 wins isn't 100× bigger
  // than one with 1 win.
  const fleetRadius = (wins: number) => {
    const base = 4;
    const max = 22;
    return base + (Math.sqrt(wins / maxWins) * (max - base));
  };

  return (
    <div className="card p-4">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-ink-subtle font-semibold">
            Network coverage
          </p>
          <p className="text-sm text-ink-muted mt-0.5">
            {fleets.length} fleets · {pickups.length} recent pickups
          </p>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-ink-muted">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-green-600" /> completed
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-sky-500" /> in flight
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-red-600" /> failed
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full ring-2 ring-blue-600 bg-blue-600/20" /> fleet
          </span>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="w-full h-auto max-h-[640px]"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="UK coverage map showing partner fleets and recent pickup locations"
      >
        {/* Sea background — uses CSS var so it adapts if globals.css gets darker */}
        <rect x="0" y="0" width={VIEW_W} height={VIEW_H} fill="#f8fafc" />

        {/* UK + NI silhouettes */}
        <path d={UK_PATH} fill="#e2e8f0" stroke="#cbd5e1" strokeWidth="1" />
        <path d={NI_PATH} fill="#e2e8f0" stroke="#cbd5e1" strokeWidth="1" />

        {/* Reference city labels — drawn first so markers sit on top */}
        {REFERENCE_CITIES.map((c) => {
          const { x, y } = project(c.lat, c.lng);
          return (
            <g key={c.name}>
              <circle cx={x} cy={y} r="1.5" fill="#94a3b8" />
              <text
                x={x + 5}
                y={y - 4}
                fontSize="10"
                fill="#64748b"
                style={{ pointerEvents: "none" }}
              >
                {c.name}
              </text>
            </g>
          );
        })}

        {/* Pickup heat dots — small, semi-transparent so overlapping pickups
            create visible density */}
        {pickups.map((p, i) => {
          const { x, y } = project(p.lat, p.lng);
          const tone = statusMeta(p.status).tone;
          const color = PICKUP_COLOR[tone];
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r="2.5"
              fill={color}
              fillOpacity="0.65"
            />
          );
        })}

        {/* Fleet centroids — drawn last so they sit on top of pickup dots */}
        {fleets.map((f) => {
          const { x, y } = project(f.lat, f.lng);
          const r = fleetRadius(f.wins);
          return (
            <g key={f.id}>
              <circle
                cx={x}
                cy={y}
                r={r}
                fill={FLEET_COLOR_FILL}
                stroke={FLEET_COLOR_STROKE}
                strokeWidth="1.5"
              />
              <title>{`${f.name} — ${f.wins} job${f.wins === 1 ? "" : "s"} won`}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
