import { db } from "@/db/client";
import { partners, auditLog } from "@/db/schema";
import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import Link from "next/link";
import { clearAdapterCache } from "@/adapters/registry";
import { encryptCredentials, decryptIfNeeded } from "@/lib/crypto";
import { registerWebhookSubscription, deleteWebhookSubscription } from "@/adapters/icabbi";
import { requireSuperAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * /partners/[id]/integration — admin-managed iCabbi credential entry.
 *
 * Saves App-Key + Secret-Key (encrypted at rest), generates a webhook signing
 * secret on first connect (shown once), best-effort auto-registers our
 * per-partner webhook URL with iCabbi. Rotate + disconnect handled inline.
 */

type ICabbiCreds = {
  appKey?: string;
  secretKey?: string;
  webhookSecret?: string;
  webhookSubscriptionId?: string;
};

function readCreds(stored: unknown): ICabbiCreds {
  return (decryptIfNeeded(stored as Record<string, unknown> | null) ?? {}) as ICabbiCreds;
}

async function saveCredentialsAction(formData: FormData) {
  "use server";
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const [partner] = await db.select().from(partners).where(eq(partners.id, id));
  if (!partner) return;

  const existingCreds = readCreds(partner.credentials);
  const appKey = String(formData.get("appKey") ?? "").trim();
  const newSecretKey = String(formData.get("secretKey") ?? "").trim();
  const secretKey = newSecretKey || existingCreds.secretKey || "";

  if (!appKey || !secretKey) {
    redirect(`/partners/${id}/integration?error=incomplete`);
  }

  const isFirstConnect = !existingCreds.webhookSecret;
  const webhookSecret = existingCreds.webhookSecret ?? randomBytes(32).toString("base64url");

  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  const webhookUrl = `${appUrl}/api/webhooks/ingest/${id}`;
  const registration = await registerWebhookSubscription({
    appKey,
    secretKey,
    url: webhookUrl,
    sharedSecret: webhookSecret,
  });

  if (registration.ok && existingCreds.webhookSubscriptionId && existingCreds.appKey === appKey) {
    await deleteWebhookSubscription({
      appKey,
      secretKey,
      subscriptionId: existingCreds.webhookSubscriptionId,
    });
  }

  const credentials: ICabbiCreds = {
    appKey,
    secretKey,
    webhookSecret,
    ...(registration.ok ? { webhookSubscriptionId: registration.subscriptionId } : {}),
  };

  await db
    .update(partners)
    .set({
      credentials: encryptCredentials(credentials as Record<string, unknown>) as unknown as Record<string, unknown>,
      adapterKey: "icabbi",
      updatedAt: new Date(),
    })
    .where(eq(partners.id, id));

  clearAdapterCache(id);

  if (!registration.ok) {
    console.warn(
      `[integration] Webhook auto-registration failed for partner ${id}: status=${registration.status} ${registration.message}`,
    );
  }

  await db.insert(auditLog).values({
    category: "credential",
    actor: "admin_user",
    actorRef: "portal",
    action: isFirstConnect ? "partner.icabbi_connected" : "partner.icabbi_updated",
    subjectType: "partner",
    subjectId: id,
    before: {
      adapterKey: partner.adapterKey,
      appKey: existingCreds.appKey ?? null,
      hasSecretKey: !!existingCreds.secretKey,
      hasWebhookSecret: !!existingCreds.webhookSecret,
      hadSubscription: !!existingCreds.webhookSubscriptionId,
    },
    after: {
      adapterKey: "icabbi",
      appKey,
      hasSecretKey: true,
      hasWebhookSecret: true,
      webhookSecretRotated: false,
      webhookRegistered: registration.ok,
      webhookRegistrationError: registration.ok ? null : `${registration.status}: ${registration.message}`,
    },
  });

  revalidatePath(`/partners/${id}`);
  revalidatePath(`/partners/${id}/integration`);
  revalidatePath("/audit");

  const qs = new URLSearchParams();
  qs.set("saved", "1");
  if (isFirstConnect) qs.set("webhookSecret", webhookSecret);
  if (registration.ok) qs.set("subscriptionId", registration.subscriptionId);
  else qs.set("registrationError", `${registration.status}`);

  redirect(`/partners/${id}/integration?${qs.toString()}`);
}

async function rotateWebhookSecretAction(formData: FormData) {
  "use server";
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const [partner] = await db.select().from(partners).where(eq(partners.id, id));
  if (!partner) return;

  const creds = readCreds(partner.credentials);
  const newWebhookSecret = randomBytes(32).toString("base64url");

  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  const webhookUrl = `${appUrl}/api/webhooks/ingest/${id}`;
  let newSubscriptionId = creds.webhookSubscriptionId;
  if (creds.appKey && creds.secretKey) {
    const reg = await registerWebhookSubscription({
      appKey: creds.appKey,
      secretKey: creds.secretKey,
      url: webhookUrl,
      sharedSecret: newWebhookSecret,
    });
    if (reg.ok) {
      newSubscriptionId = reg.subscriptionId;
      if (creds.webhookSubscriptionId) {
        await deleteWebhookSubscription({
          appKey: creds.appKey,
          secretKey: creds.secretKey,
          subscriptionId: creds.webhookSubscriptionId,
        });
      }
    } else {
      console.warn(
        `[integration] Webhook re-registration failed on rotate for ${id}: ${reg.status} ${reg.message}`,
      );
    }
  }

  const next: ICabbiCreds = {
    ...creds,
    webhookSecret: newWebhookSecret,
    webhookSubscriptionId: newSubscriptionId,
  };

  await db
    .update(partners)
    .set({
      credentials: encryptCredentials(next as Record<string, unknown>) as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    })
    .where(eq(partners.id, id));

  clearAdapterCache(id);

  await db.insert(auditLog).values({
    category: "credential",
    actor: "admin_user",
    actorRef: "portal",
    action: "partner.webhook_secret_rotated",
    subjectType: "partner",
    subjectId: id,
    before: { hasWebhookSecret: !!creds.webhookSecret },
    after: { hasWebhookSecret: true, webhookSecretRotated: true },
  });

  revalidatePath(`/partners/${id}/integration`);
  revalidatePath("/audit");

  redirect(`/partners/${id}/integration?rotated=1&webhookSecret=${newWebhookSecret}`);
}

async function disconnectAction(formData: FormData) {
  "use server";
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const [partner] = await db.select().from(partners).where(eq(partners.id, id));
  if (!partner) return;

  const creds = readCreds(partner.credentials);
  if (creds.webhookSubscriptionId && creds.appKey && creds.secretKey) {
    const del = await deleteWebhookSubscription({
      appKey: creds.appKey,
      secretKey: creds.secretKey,
      subscriptionId: creds.webhookSubscriptionId,
    });
    if (!del.ok) {
      console.warn(
        `[integration] Webhook deregistration failed for ${id}: ${del.status} ${del.message ?? ""}`,
      );
    }
  }

  await db
    .update(partners)
    .set({
      credentials: null,
      adapterKey: "mock_icabbi",
      updatedAt: new Date(),
    })
    .where(eq(partners.id, id));

  clearAdapterCache(id);

  await db.insert(auditLog).values({
    category: "credential",
    actor: "admin_user",
    actorRef: "portal",
    action: "partner.icabbi_disconnected",
    subjectType: "partner",
    subjectId: id,
    before: { adapterKey: partner.adapterKey, hadCredentials: !!partner.credentials },
    after: { adapterKey: "mock_icabbi", hadCredentials: false },
  });

  revalidatePath(`/partners/${id}`);
  revalidatePath(`/partners/${id}/integration`);
  redirect(`/partners/${id}/integration?disconnected=1`);
}

export default async function IntegrationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    saved?: string;
    rotated?: string;
    disconnected?: string;
    error?: string;
    webhookSecret?: string;
    subscriptionId?: string;
    registrationError?: string;
  }>;
}) {
  await requireSuperAdmin();
  const { id } = await params;
  const sp = await searchParams;

  const [partner] = await db.select().from(partners).where(eq(partners.id, id));
  if (!partner) notFound();

  const creds = readCreds(partner.credentials);
  const isConnected = partner.adapterKey === "icabbi" && !!creds.appKey;
  const icabbiBase = process.env.ICABBI_API_BASE_URL ?? "https://api.icabbi.com/v2";
  const webhookUrl = `${process.env.APP_URL ?? "http://localhost:3000"}/api/webhooks/ingest/${partner.id}`;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-ink-muted font-semibold">
            iCabbi integration
          </p>
          <h1 className="text-3xl font-bold tracking-tight mt-1">{partner.name}</h1>
          <div className="text-xs text-ink-subtle mt-2">
            adapter <code>{partner.adapterKey}</code>
          </div>
        </div>
        <Link href={`/partners/${id}`} className="text-sm text-ink-muted hover:text-ink">
          ← Back to partner
        </Link>
      </div>

      <div
        className={`p-3 rounded-md text-sm ${
          isConnected ? "bg-success text-success-fg" : "bg-warning text-warning-fg"
        }`}
      >
        {isConnected ? (
          <>
            <strong>Connected.</strong> Routes via the real iCabbi adapter — App-Key authenticated
            against <code>{icabbiBase}</code>.
          </>
        ) : (
          <>
            <strong>Not connected.</strong> Using the mock adapter. Paste the partner&apos;s
            iCabbi App-Key and Secret-Key below to go live. All iCabbi tenants talk to the same
            host (<code>{icabbiBase}</code>) — the App-Key/Secret-Key pair identifies the tenant.
          </>
        )}
      </div>

      {/* Banner states */}
      {sp.saved === "1" && sp.webhookSecret && (
        <SecretReveal
          title="Webhook signing secret generated"
          body="Configure iCabbi to sign outbound webhooks to The Exchange with this secret. You won't see it again — copy it now."
          secret={sp.webhookSecret}
        />
      )}
      {sp.rotated === "1" && sp.webhookSecret && (
        <SecretReveal
          title="Webhook signing secret rotated"
          body="Update iCabbi's webhook configuration with this new secret immediately. The previous secret will no longer be accepted."
          secret={sp.webhookSecret}
        />
      )}
      {sp.saved === "1" && !sp.webhookSecret && (
        <Banner tone="success">Credentials updated.</Banner>
      )}
      {sp.disconnected === "1" && (
        <Banner tone="warning">Disconnected. Partner is now on the mock adapter.</Banner>
      )}
      {sp.error === "incomplete" && (
        <Banner tone="error">App-Key and Secret-Key are both required to connect.</Banner>
      )}
      {sp.subscriptionId && (
        <Banner tone="success">
          Webhook subscription auto-registered with iCabbi (subscription id{" "}
          <code>{sp.subscriptionId}</code>).
        </Banner>
      )}
      {sp.registrationError && (
        <Banner tone="warning">
          Credentials saved, but webhook auto-registration with iCabbi failed (status{" "}
          {sp.registrationError}). Register manually by giving iCabbi the webhook URL and signing
          secret below.
        </Banner>
      )}

      {/* Credential form */}
      <form action={saveCredentialsAction} className="space-y-4">
        <input type="hidden" name="id" value={partner.id} />

        <Section title="iCabbi API credentials">
          <Field
            label="App-Key"
            hint={`Sent in the App-Key header on every call to ${icabbiBase}. Issued by iCabbi to this tenant.`}
            required
          >
            <input
              name="appKey"
              defaultValue={creds.appKey ?? ""}
              required
              className="input"
              autoComplete="off"
            />
          </Field>

          <Field
            label="Secret-Key"
            hint={
              creds.secretKey
                ? "Already saved — leave blank to keep, or paste a new value to rotate"
                : "Sent in the Secret-Key header alongside the App-Key. Issued by iCabbi."
            }
            required={!creds.secretKey}
          >
            <input
              name="secretKey"
              type="password"
              required={!creds.secretKey}
              placeholder={creds.secretKey ? "•".repeat(20) : "paste secret"}
              className="input"
              autoComplete="off"
            />
          </Field>
        </Section>

        <div className="flex items-center gap-4">
          <button type="submit" className="btn-primary">
            {isConnected ? "Update credentials" : "Connect"}
          </button>
          <span className="text-xs text-ink-muted">
            Saving switches the adapter to <code>icabbi</code>. Audit-logged.
          </span>
        </div>
      </form>

      {/* Connected-only sections */}
      {isConnected && (
        <>
          <Section title="Webhook configuration">
            <p className="text-sm text-ink-muted">
              Configure iCabbi to POST network-bound bookings and status updates to this URL,
              signed with the secret shown when you connected (or after rotation).
            </p>

            {creds.webhookSubscriptionId ? (
              <Banner tone="success">
                Auto-registered with iCabbi · subscription <code>{creds.webhookSubscriptionId}</code>
              </Banner>
            ) : (
              <Banner tone="warning">
                Not auto-registered. Give iCabbi the URL and signing secret manually.
              </Banner>
            )}

            <Field label="Inbound webhook URL (give this to iCabbi)">
              <input value={webhookUrl} readOnly className="input font-mono" />
            </Field>
            <Field label="Webhook signing secret">
              <input
                value={creds.webhookSecret ? "•".repeat(32) + " (saved, only shown once)" : "not generated"}
                readOnly
                className="input font-mono"
              />
            </Field>

            <form action={rotateWebhookSecretAction} className="flex items-center gap-4 pt-2">
              <input type="hidden" name="id" value={partner.id} />
              <button type="submit" className="btn-danger">Rotate webhook secret</button>
              <span className="text-xs text-ink-muted">
                Generates a new secret immediately. iCabbi&apos;s side must be updated to match.
              </span>
            </form>
          </Section>

          <section className="card p-5 border-red-200">
            <h2 className="text-base font-semibold text-red-800 mb-2">Disconnect</h2>
            <p className="text-sm text-red-800/80 mb-4">
              Removes credentials and switches the adapter back to <code>mock_icabbi</code>.
              Routing continues against the mock — useful for re-running smoke tests or taking
              the integration offline.
            </p>
            <form action={disconnectAction}>
              <input type="hidden" name="id" value={partner.id} />
              <button type="submit" className="btn-danger">Disconnect from iCabbi</button>
            </form>
          </section>
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card p-5">
      <h2 className="text-base font-semibold mb-4">{title}</h2>
      <div className="grid gap-4">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1">
      <span className="text-sm font-semibold text-ink">
        {label}
        {required && <span className="text-red-600 ml-1">*</span>}
      </span>
      {hint && <span className="text-xs text-ink-muted">{hint}</span>}
      {children}
    </label>
  );
}

function Banner({ tone, children }: { tone: "success" | "warning" | "error"; children: React.ReactNode }) {
  const cls =
    tone === "success"
      ? "bg-success text-success-fg"
      : tone === "warning"
      ? "bg-warning text-warning-fg"
      : "bg-danger text-danger-fg";
  return <div className={`p-3 rounded-md text-sm ${cls}`}>{children}</div>;
}

function SecretReveal({ title, body, secret }: { title: string; body: string; secret: string }) {
  return (
    <div className="p-5 rounded-lg border-2 border-amber-500 bg-amber-50">
      <div className="font-bold text-amber-900 mb-2">{title}</div>
      <div className="text-sm text-amber-900 mb-3">{body}</div>
      <code className="block p-3 rounded bg-ink text-amber-200 text-sm break-all">{secret}</code>
      <div className="text-xs text-amber-900 mt-3">
        This secret will not be shown again. Save it somewhere safe before navigating away.
      </div>
    </div>
  );
}
