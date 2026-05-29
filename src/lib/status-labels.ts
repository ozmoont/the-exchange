/**
 * Friendly labels + tone + descriptions for every booking ("transit") status.
 *
 * The DB enum uses operational language (`pushed`, `error_other`) — useful
 * for code, opaque for humans. This module is the one place we map those
 * codes to copy users see. Update here only.
 *
 * `tone` maps to the Tailwind `badge-*` classes already in globals.css.
 *
 * Grouping (`group`) powers the /bookings?status= filter — users click a
 * stat card on /distribution and land on the matching slice.
 */

export type StatusGroup =
  | "in_flight"
  | "completed"
  | "no_match"
  | "paused"
  | "error"
  | "cancelled";

export type StatusTone = "success" | "danger" | "warning" | "info" | "neutral";

export type StatusMeta = {
  label: string;
  tone: StatusTone;
  group: StatusGroup;
  description: string;
};

export const STATUS_META: Record<string, StatusMeta> = {
  received: {
    label: "Received",
    tone: "neutral",
    group: "in_flight",
    description: "Booking received by The Exchange, not yet routed.",
  },
  routing: {
    label: "Picking fleet",
    tone: "info",
    group: "in_flight",
    description: "The Exchange is choosing the best partner fleet for this job.",
  },
  no_match: {
    label: "No match",
    tone: "danger",
    group: "no_match",
    description: "No eligible partner fleet could take this job (no mutual allow / out of service area / wrong vehicle type).",
  },
  pushed: {
    label: "Sent to fleet",
    tone: "info",
    group: "in_flight",
    description: "Job pushed to a partner fleet, awaiting their acceptance.",
  },
  accepted: {
    label: "Accepted by fleet",
    tone: "info",
    group: "in_flight",
    description: "Partner fleet accepted the job.",
  },
  driver_assigned: {
    label: "Driver assigned",
    tone: "info",
    group: "in_flight",
    description: "Partner fleet assigned a driver.",
  },
  en_route: {
    label: "Driver en route",
    tone: "info",
    group: "in_flight",
    description: "Driver is on the way to pick up the passenger.",
  },
  on_board: {
    label: "Passenger on board",
    tone: "info",
    group: "in_flight",
    description: "Passenger has been picked up.",
  },
  completed: {
    label: "Completed",
    tone: "success",
    group: "completed",
    description: "Trip delivered.",
  },
  cancelled: {
    label: "Cancelled",
    tone: "danger",
    group: "cancelled",
    description: "Booking cancelled before completion.",
  },
  failed: {
    label: "Failed",
    tone: "danger",
    group: "error",
    description: "Trip could not be completed.",
  },
  paused: {
    label: "Paused (kill switch)",
    tone: "warning",
    group: "paused",
    description: "Routing was halted by the network kill switch.",
  },
  error_auth: {
    label: "Partner auth error",
    tone: "danger",
    group: "error",
    description: "Partner adapter rejected the request — credentials invalid or expired.",
  },
  error_other: {
    label: "Routing error",
    tone: "danger",
    group: "error",
    description: "Routing failed: all eligible partners errored.",
  },
};

const FALLBACK: StatusMeta = {
  label: "Unknown",
  tone: "neutral",
  group: "in_flight",
  description: "Unknown status.",
};

export function statusMeta(status: string): StatusMeta {
  return STATUS_META[status] ?? FALLBACK;
}

export function statusLabel(status: string): string {
  return statusMeta(status).label;
}

export function statusBadgeClass(status: string): string {
  const tone = statusMeta(status).tone;
  switch (tone) {
    case "success":
      return "badge-success";
    case "danger":
      return "badge-danger";
    case "warning":
      return "badge-warning";
    case "info":
      return "badge-info";
    default:
      return "badge-neutral";
  }
}

/** All status codes that belong to the same UI group as a given group key. */
export const STATUSES_BY_GROUP: Record<StatusGroup, string[]> = {
  in_flight: ["received", "routing", "pushed", "accepted", "driver_assigned", "en_route", "on_board"],
  completed: ["completed"],
  no_match: ["no_match"],
  paused: ["paused"],
  error: ["failed", "error_auth", "error_other"],
  cancelled: ["cancelled"],
};

export const GROUP_LABEL: Record<StatusGroup, string> = {
  in_flight: "In flight",
  completed: "Completed",
  no_match: "No match",
  paused: "Paused",
  error: "Errors",
  cancelled: "Cancelled",
};
