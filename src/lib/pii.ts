/**
 * PII visibility gates.
 *
 * Driver-level PII (driver name, phone, vehicle reg) lives natively on the
 * recipient (supply) side. The originator (demand) side only sees it when
 * THEIR partner row has `driverDetailsRequired=true` — corporate / VIP /
 * regulated accounts. The default is off (PII minimisation).
 *
 * Storage strategy: we never strip the data from `transit_events.detail`
 * because the recipient fleet needs it to render their own driver assignment.
 * Instead we filter at read time using this helper. Super admins always see
 * everything (operations).
 */

import type { SessionUser } from "@/lib/auth";

type PartnerWithFlag = {
  id: string;
  driverDetailsRequired: boolean;
};

type TransitForView = {
  originatorPartnerId: string;
  recipientPartnerId: string | null;
};

/**
 * Decides whether `viewer` should see driver PII on `transit`. Caller is
 * responsible for hydrating `originator` (the demand-side partner row, with
 * the `driverDetailsRequired` flag).
 *
 * Rules:
 *   - super_admin                   → always allowed
 *   - viewer on recipient fleet     → always allowed (it's their own driver)
 *   - viewer on originator fleet    → allowed iff originator.driverDetailsRequired
 *   - any other authenticated user  → denied
 *   - missing partnerId (super_admin-shaped without role super_admin)  → denied
 */
export function canSeeDriverDetail(
  viewer: SessionUser,
  transit: TransitForView,
  originator: PartnerWithFlag | null,
): boolean {
  if (viewer.role === "super_admin") return true;
  if (!viewer.partnerId) return false;
  if (transit.recipientPartnerId && viewer.partnerId === transit.recipientPartnerId) return true;
  if (viewer.partnerId === transit.originatorPartnerId) {
    return originator?.driverDetailsRequired === true;
  }
  return false;
}

/**
 * Short user-facing explainer for why driver detail is hidden. Used as a
 * tooltip / inline note in the UI when the gate is off.
 */
export const DRIVER_DETAILS_HIDDEN_EXPLAINER =
  "Driver details aren't shared on this booking. Enable on your partner page if your accounts require it.";
