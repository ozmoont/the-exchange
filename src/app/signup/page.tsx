import { db } from "@/db/client";
import { partners, auditLog } from "@/db/schema";
import { redirect } from "next/navigation";
import Link from "next/link";
import { eq, and, ilike } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * Public partner signup page.
 *
 * A fleet operator lands here, fills in the form, and we create a partner
 * row with status='pending_approval'. A super admin reviews on /signups and
 * approves — at which point the applicant gets a magic-link email and can
 * sign in to complete their integration (paste iCabbi credentials).
 *
 * Auth: this page is in middleware.ts's PUBLIC_PREFIXES list, so it's
 * accessible without a session. The submit action does extra validation on
 * the server (no duplicate names, no bot floods) before inserting.
 *
 * Rate limiting will live in P0-4 of the readiness plan; for now we rely on
 * Vercel's per-route concurrency limits.
 */

async function submitSignupAction(formData: FormData) {
  "use server";

  const fleetName = String(formData.get("fleetName") ?? "").trim();
  const applicantEmail = String(formData.get("applicantEmail") ?? "").trim().toLowerCase();
  const operatingCity = String(formData.get("operatingCity") ?? "").trim();
  const vehicleTypesRaw = String(formData.get("vehicleTypes") ?? "").trim();
  const expectedDailyVolume = String(formData.get("expectedDailyVolume") ?? "").trim();
  const applicationNotes = String(formData.get("applicationNotes") ?? "").trim();

  // Basic validation. We deliberately keep these checks loose — a real fleet
  // shouldn't be turned away by overly strict input rules. Server-side dedup
  // by name + email is the only hard gate.
  if (!fleetName || fleetName.length < 3) {
    redirect(`/signup?error=${encodeURIComponent("Fleet name must be at least 3 characters")}`);
  }
  if (!applicantEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(applicantEmail)) {
    redirect(`/signup?error=${encodeURIComponent("Please enter a valid email address")}`);
  }
  if (!operatingCity) {
    redirect(`/signup?error=${encodeURIComponent("Operating city is required")}`);
  }

  // Dedup — refuse if a partner with the same name OR the same applicant
  // email is already in the pending queue. Approved partners CAN share a
  // city / fleet style; we only block duplicate applications.
  const existing = await db
    .select()
    .from(partners)
    .where(
      and(
        eq(partners.status, "pending_approval"),
        ilike(partners.applicantEmail, applicantEmail),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    redirect(
      `/signup?error=${encodeURIComponent(
        "We already have a pending application from that email. We'll be in touch shortly.",
      )}`,
    );
  }

  const sameName = await db
    .select()
    .from(partners)
    .where(ilike(partners.name, fleetName))
    .limit(1);

  if (sameName.length > 0) {
    redirect(
      `/signup?error=${encodeURIComponent(
        "A partner with that fleet name already exists in the network. Try adding your city or trading name.",
      )}`,
    );
  }

  const vehicleTypes = vehicleTypesRaw
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

  const [inserted] = await db
    .insert(partners)
    .values({
      kind: "icabbi_fleet",
      name: fleetName,
      legalName: null,
      contactEmail: applicantEmail,
      participationMode: "send_and_receive",
      status: "pending_approval",
      operatingRegions: [operatingCity],
      vehicleTypes: vehicleTypes.length ? vehicleTypes : ["standard"],
      bookingTypes: ["asap", "prebook"],
      adapterKey: "icabbi", // assume iCabbi unless we hear otherwise; super admin can swap
      applicantEmail,
      applicationNotes: [
        applicationNotes,
        expectedDailyVolume ? `Expected daily volume: ${expectedDailyVolume}` : null,
      ]
        .filter(Boolean)
        .join("\n\n"),
    })
    .returning({ id: partners.id });

  await db.insert(auditLog).values({
    category: "admin",
    actor: "system",
    actorRef: "signup_form",
    action: "partner.signup_received",
    subjectType: "partner",
    subjectId: inserted.id,
    before: null,
    after: { name: fleetName, applicantEmail, operatingCity },
  });

  redirect(`/signup?submitted=${inserted.id}`);
}

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; submitted?: string }>;
}) {
  const sp = await searchParams;
  const error = sp.error;
  const submitted = sp.submitted;

  if (submitted) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16">
        <div className="card p-8 text-center">
          <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full bg-success/40 text-2xl text-success-fg">
            ✓
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Application received</h1>
          <p className="mt-3 text-sm text-ink-muted max-w-md mx-auto">
            We&apos;ve received your application to join The Exchange. A team
            member will review it and email you back within 2 business days.
          </p>
          <p className="mt-2 text-xs text-ink-subtle">
            Your application reference is <code>{submitted.slice(0, 8)}</code>
          </p>
          <Link
            href="/login"
            className="mt-6 inline-block text-sm text-ink hover:underline"
          >
            Already a member? Sign in →
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <div className="mb-8">
        <p className="text-xs uppercase tracking-[0.2em] text-ink-muted font-semibold">
          The Exchange — Apply to join
        </p>
        <h1 className="text-3xl font-bold tracking-tight mt-2">
          Get your fleet on the network
        </h1>
        <p className="mt-3 text-sm text-ink-muted max-w-prose">
          Apply to receive cross-network bookings from other UK fleets, and route
          your own overflow into The Exchange. Approval typically takes 2 business days.
        </p>
      </div>

      {error && (
        <div className="mb-6 rounded-md bg-danger/30 border border-red-300 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <form action={submitSignupAction} className="card p-6 space-y-5">
        <Field label="Fleet name" hint="The trading name your drivers operate under">
          <input
            name="fleetName"
            required
            minLength={3}
            placeholder="e.g. Bristol Star Cabs"
            className="input"
          />
        </Field>

        <Field
          label="Your email"
          hint="We'll send your magic-link login here when your application is approved"
        >
          <input
            name="applicantEmail"
            type="email"
            required
            placeholder="ops@yourfleet.co.uk"
            className="input"
          />
        </Field>

        <Field
          label="Operating city / region"
          hint="Where most of your drivers pick up. You can add more regions later."
        >
          <input
            name="operatingCity"
            required
            placeholder="e.g. Bristol, Greater London, Greater Manchester"
            className="input"
          />
        </Field>

        <Field
          label="Vehicle types you operate"
          hint="Comma-separated. Use 'standard', 'exec', 'wav' (wheelchair accessible), or 'mpv'."
        >
          <input
            name="vehicleTypes"
            placeholder="standard, exec"
            defaultValue="standard"
            className="input"
          />
        </Field>

        <Field
          label="Expected daily booking volume"
          hint="Rough estimate — helps us plan capacity. Optional."
        >
          <input
            name="expectedDailyVolume"
            placeholder="e.g. 200 jobs/day"
            className="input"
          />
        </Field>

        <Field
          label="Anything else we should know"
          hint="Current dispatch system (iCabbi / Autocab / Cordic), references, special requirements. Optional."
        >
          <textarea
            name="applicationNotes"
            rows={4}
            placeholder="We run iCabbi on the bounds cluster. Mostly airport runs..."
            className="input font-sans resize-y"
          />
        </Field>

        <div className="pt-2">
          <button type="submit" className="btn-primary">
            Submit application
          </button>
          <Link
            href="/login"
            className="ml-4 text-sm text-ink-muted hover:text-ink"
          >
            Already a member? Sign in
          </Link>
        </div>

        <p className="text-xs text-ink-subtle border-t border-border pt-4">
          By submitting you confirm you have authority to sign your fleet up to a
          partner network. We&apos;ll never share your operational data with other
          fleets without your explicit allow-rule.
        </p>
      </form>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="block text-sm font-semibold text-ink">{label}</span>
      {hint && <span className="block text-xs text-ink-muted">{hint}</span>}
      {children}
    </label>
  );
}
