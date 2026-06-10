import { db } from "@/db/client";
import { partners, auditLog } from "@/db/schema";
import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import Link from "next/link";
import { clearAdapterCache } from "@/adapters/registry";
import { encryptCredentials, decryptIfNeeded } from "@/lib/crypto";
import { resetWebhookListeners, type WebhookListenerRecord } from "@/adapters/icabbi";
import { requireSuperAdmin } from "@/lib/auth";

/**
 * Build the per-partner webhook callback URL with the shared-secret token
 * appended as a query parameter. iCabbi cannot sign outbound webhooks,
 * so the inbound route at /api/webhooks/ingest/[partnerId] authenticates
 * by comparing this token (constant-time) against creds.webhookSecret.
 * The secret is base64url (no /+= chars), already URL-safe.
 */
function buildCallbackUrl(appUrl: string, partnerId: string, token: string): string {
  return `${appUrl}/api/webhooks/ingest/${partnerId}?token=${encodeURIComponent(token)}`;
}

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
  /**
   * iCabbi listener provider ids per event, returned from
   * /eventlisteners/create. Used to delete-then-create on re-register.
   * See src/adapters/icabbi.ts → resetWebhookListeners.
   */
  webhookListeners?: WebhookListenerRecord[];
  /**
   * @deprecated legacy single-id field from the pre-eventlisteners
   * scheme. Read only during disconnect cleanup of partners onboarded
   * before the rewrite. Cleared on next reconnect.
   */
  webhookSubscriptionId?: string;
  /**
   * Per-partner API base URL override. Required for sandbox tenants that
   * aren't on the production host (e.g. staging is at
   * https://1stagingapi.icabbi.com/1staging).
   */
  apiBaseUrl?: string;
  /**
   * H1.5 — Bearer token iCabbi uses to authenticate when calling our
   * inbound endpoints (/api/icabbi/bookings, /api/icabbi/cancellations).
   * Generated on first Connect. Shown once via the SecretReveal banner.
   * Rotation is via the same path as the webhook secret.
   */
  inboundBearerToken?: string;
};

/** Collect provider ids from both the new array shape and the legacy
 * single-id field. Used by reset/disconnect to ensure we delete every
 * listener iCabbi has on file even for partners mid-migration. */
function collectExistingProviderIds(creds: ICabbiCreds): string[] {
  const out: string[] = [];
  for (const l of creds.webhookListeners ?? []) {
    if (l.providerId) out.push(l.providerId);
  }
  if (creds.webhookSubscriptionId) out.push(creds.webhookSubscriptionId);
  return out;
}

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
  const apiBaseUrlInput = String(formData.get("apiBaseUrl") ?? "").trim();
  // Normalise: drop trailing slash + empty string → undefined so we don't
  // persist "" and trigger the override branch on every call.
  const apiBaseUrl = apiBaseUrlInput
    ? apiBaseUrlInput.replace(/\/$/, "")
    : existingCreds.apiBaseUrl;

  if (!appKey || !secretKey) {
    redirect(`/partners/${id}/integration?error=incomplete`);
  }

  const isFirstConnect = !existingCreds.webhookSecret;
  const webhookSecret = existingCreds.webhookSecret ?? randomBytes(32).toString("base64url");
  // H1.5 — issue an inbound Bearer token for iCabbi to authenticate when
  // calling our /api/icabbi/* endpoints. 48-byte base64url. Same lifecycle
  // as the webhook secret: generated on first Connect, rotated via the
  // rotateWebhookSecretAction (TBD: consider separating the rotation
  // controls if we ever need to rotate independently).
  const inboundBearerToken =
    existingCreds.inboundBearerToken ?? randomBytes(48).toString("base64url");

  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  // Token-in-URL auth — iCabbi can't sign HMAC, so the shared secret
  // travels on the query string. The inbound route compares it in
  // constant time against creds.webhookSecret.
  const callbackUrl = buildCallbackUrl(appUrl, id, webhookSecret);
  const registration = await resetWebhookListeners({
    appKey,
    secretKey,
    callbackUrl,
    existingProviderIds: collectExistingProviderIds(existingCreds),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });

  const credentials: ICabbiCreds = {
    appKey,
    secretKey,
    webhookSecret,
    inboundBearerToken,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    // Always persist listeners we actually created — even if SOME failed.
    // The errors[] array lets the UI nudge the operator to retry.
    ...(registration.created.length > 0
      ? { webhookListeners: registration.created }
      : {}),
    // Clear legacy single-id once we've successfully migrated this partner
    // to the array shape. Until then it stays put so a future reset still
    // tries to delete the pre-migration listener.
    ...(registration.created.length > 0 ? { webhookSubscriptionId: undefined } : {}),
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

  if (registration.errors.length > 0) {
    console.warn(
      `[integration] Webhook listener reset for partner ${id} had ${registration.errors.length} errors:`,
      registration.errors,
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
      previousListenerCount:
        (existingCreds.webhookListeners?.length ?? 0) +
        (existingCreds.webhookSubscriptionId ? 1 : 0),
    },
    after: {
      adapterKey: "icabbi",
      appKey,
      hasSecretKey: true,
      hasWebhookSecret: true,
      webhookSecretRotated: false,
      listenersDeleted: registration.deleted,
      listenersCreated: registration.created.length,
      registrationErrors: registration.errors.length > 0 ? registration.errors : null,
    },
  });

  revalidatePath(`/partners/${id}`);
  revalidatePath(`/partners/${id}/integration`);
  revalidatePath("/audit");

  const qs = new URLSearchParams();
  qs.set("saved", "1");
  if (isFirstConnect) {
    qs.set("webhookSecret", webhookSecret);
    qs.set("inboundBearerToken", inboundBearerToken);
  }
  qs.set("listenersCreated", String(registration.created.length));
  if (registration.errors.length > 0) {
    qs.set("registrationErrors", String(registration.errors.length));
  }

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
  // H1.5 — rotate the Bearer token at the same time. iCabbi has to update
  // both sides anyway, so packaging them keeps the integration UI simple.
  const newInboundBearerToken = randomBytes(48).toString("base64url");

  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  // Rotating the webhook secret means the callback URL's `?token=`
  // parameter changes — every listener has to be deleted + recreated
  // with the new token, otherwise inbound auth fails on the very next
  // event. resetWebhookListeners handles that atomically.
  let newListeners: WebhookListenerRecord[] | undefined = creds.webhookListeners;
  let registrationErrors: string[] = [];
  if (creds.appKey && creds.secretKey) {
    const callbackUrl = buildCallbackUrl(appUrl, id, newWebhookSecret);
    const reg = await resetWebhookListeners({
      appKey: creds.appKey,
      secretKey: creds.secretKey,
      callbackUrl,
      existingProviderIds: collectExistingProviderIds(creds),
      ...(creds.apiBaseUrl ? { apiBaseUrl: creds.apiBaseUrl } : {}),
    });
    if (reg.created.length > 0) newListeners = reg.created;
    registrationErrors = reg.errors;
    if (reg.errors.length > 0) {
      console.warn(
        `[integration] Webhook listener reset on rotate for ${id} had ${reg.errors.length} errors:`,
        reg.errors,
      );
    }
  }

  const next: ICabbiCreds = {
    ...creds,
    webhookSecret: newWebhookSecret,
    inboundBearerToken: newInboundBearerToken,
    ...(newListeners ? { webhookListeners: newListeners } : {}),
    // Legacy field gets cleared on the first successful rotate.
    webhookSubscriptionId: undefined,
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
    after: {
      hasWebhookSecret: true,
      webhookSecretRotated: true,
      listenersCreated: newListeners?.length ?? 0,
      registrationErrors: registrationErrors.length > 0 ? registrationErrors : null,
    },
  });

  revalidatePath(`/partners/${id}/integration`);
  revalidatePath("/audit");

  const qs = new URLSearchParams();
  qs.set("rotated", "1");
  qs.set("webhookSecret", newWebhookSecret);
  qs.set("inboundBearerToken", newInboundBearerToken);
  qs.set("listenersCreated", String(newListeners?.length ?? 0));
  if (registrationErrors.length > 0) qs.set("registrationErrors", String(registrationErrors.length));
  redirect(`/partners/${id}/integration?${qs.toString()}`);
}

async function disconnectAction(formData: FormData) {
  "use server";
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const [partner] = await db.select().from(partners).where(eq(partners.id, id));
  if (!partner) return;

  const creds = readCreds(partner.credentials);
  const existingIds = collectExistingProviderIds(creds);
  if (existingIds.length > 0 && creds.appKey && creds.secretKey) {
    // Use resetWebhookListeners with empty events to delete-only.
    // Best-effort: errors logged but disconnect still proceeds — we'd
    // rather leave orphan listeners on iCabbi than block teardown.
    const del = await resetWebhookListeners({
      appKey: creds.appKey,
      secretKey: creds.secretKey,
      callbackUrl: "", // unused when events is empty
      existingProviderIds: existingIds,
      events: [], // delete-only
      ...(creds.apiBaseUrl ? { apiBaseUrl: creds.apiBaseUrl } : {}),
    });
    if (del.errors.length > 0) {
      console.warn(
        `[integration] Listener deregistration partial-failure for ${id}: ${del.errors.length} errors`,
        del.errors,
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
    inboundBearerToken?: string;
    listenersCreated?: string;
    registrationErrors?: string;
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
  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  const webhookUrl = `${appUrl}/api/webhooks/ingest/${partner.id}`;
  // The URL we'd register with iCabbi includes ?token=<webhookSecret>.
  // We can't reveal the actual secret post-creation, so show a tokenised
  // form when we have it (after a fresh save) and a placeholder otherwise.
  const webhookUrlWithToken = sp.webhookSecret
    ? `${webhookUrl}?token=${sp.webhookSecret}`
    : `${webhookUrl}?token=<webhook-secret>`;
  const inboundBookingsUrl = `${appUrl}/api/icabbi/bookings`;
  const inboundCancellationsUrl = `${appUrl}/api/icabbi/cancellations`;

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
            <strong>Connected.</strong> Routes via the real iCabbi adapter — App-Key
            authenticated against{" "}
            <code>{creds.apiBaseUrl ?? icabbiBase}</code>.
          </>
        ) : (
          <>
            <strong>Not connected.</strong> Using the mock adapter. Paste the partner&apos;s
            iCabbi App-Key and Secret-Key below to go live. Most production tenants talk to{" "}
            <code>{icabbiBase}</code>; sandbox / staging tenants live on different clusters
            (e.g. <code>https://1stagingapi.icabbi.com/1staging</code>) — set the API URL
            field below accordingly. The App-Key/Secret-Key pair identifies the tenant.
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
      {sp.saved === "1" && sp.inboundBearerToken && (
        <SecretReveal
          title="Inbound Bearer token generated (H1.5 outbound flow)"
          body="iCabbi sends this in the Authorization header when offering bookings to The Exchange as a virtual fleet. Configure it in their dispatch fleet-config under 'Authorization: Bearer <token>'. Shown once."
          secret={sp.inboundBearerToken}
        />
      )}
      {sp.rotated === "1" && sp.webhookSecret && (
        <SecretReveal
          title="Webhook signing secret rotated"
          body="Update iCabbi's webhook configuration with this new secret immediately. The previous secret will no longer be accepted."
          secret={sp.webhookSecret}
        />
      )}
      {sp.rotated === "1" && sp.inboundBearerToken && (
        <SecretReveal
          title="Inbound Bearer token rotated"
          body="Update iCabbi's fleet-config Authorization header with this new Bearer token. The previous token will no longer be accepted."
          secret={sp.inboundBearerToken}
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
      {sp.listenersCreated && Number(sp.listenersCreated) > 0 && (
        <Banner tone="success">
          {sp.listenersCreated} webhook listener{Number(sp.listenersCreated) === 1 ? "" : "s"} auto-registered with iCabbi.
        </Banner>
      )}
      {sp.registrationErrors && Number(sp.registrationErrors) > 0 && (
        <Banner tone="warning">
          {sp.registrationErrors} listener registration{Number(sp.registrationErrors) === 1 ? "" : "s"} failed.
          Check the server logs and click <strong>Save credentials</strong> again to retry the failed events.
        </Banner>
      )}

      {/* Preview block — what happens when you click Connect */}
      {!isConnected && (
        <section className="card p-5 bg-info/20 border border-info/30">
          <h2 className="text-base font-semibold mb-2">What happens when you click Connect</h2>
          <ol className="text-sm text-ink-muted space-y-1.5 list-decimal pl-5">
            <li>
              We encrypt your App-Key and Secret-Key with AES-256-GCM and store
              the ciphertext (never plaintext).
            </li>
            <li>
              We generate a per-fleet webhook signing secret and show it to you{" "}
              <strong>once</strong>. Save it.
            </li>
            <li>
              We call iCabbi&apos;s webhook subscription API with the URL below
              and your signing secret — so iCabbi knows where to POST status
              events for cross-network bookings.
            </li>
            <li>
              The adapter flips from <code>mock_icabbi</code> to{" "}
              <code>icabbi</code>. From now on every routing decision and
              outbound booking call uses the real iCabbi API.
            </li>
            <li>
              Every step is audit-logged. Visit <Link href="/audit" className="underline">/audit</Link> after
              connecting to see exactly what happened.
            </li>
          </ol>
          <div className="mt-4 pt-4 border-t border-info/30">
            <div className="text-[10px] uppercase tracking-wide text-ink-subtle font-semibold mb-1">
              Inbound webhook URL we will register with iCabbi
            </div>
            <code className="block text-xs bg-ink/5 px-3 py-2 rounded font-mono break-all">
              {webhookUrl}
            </code>
          </div>
        </section>
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

          <Field
            label="API URL"
            hint={
              "Per-partner override. Leave blank for production " +
              "(https://api.icabbi.com/v2). Use the sandbox URL when iCabbi " +
              "provides one — e.g. https://1stagingapi.icabbi.com/1staging for " +
              "Staging 1 test tenants. No trailing slash needed."
            }
          >
            <input
              name="apiBaseUrl"
              type="text"
              defaultValue={creds.apiBaseUrl ?? ""}
              placeholder={icabbiBase}
              className="input font-mono"
              autoComplete="off"
              spellCheck={false}
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

            {(creds.webhookListeners && creds.webhookListeners.length > 0) || creds.webhookSubscriptionId ? (
              <Banner tone="success">
                Auto-registered with iCabbi · {creds.webhookListeners?.length ?? 0} listener
                {(creds.webhookListeners?.length ?? 0) === 1 ? "" : "s"} active
                {creds.webhookSubscriptionId ? " (+ legacy single-subscription on file, will migrate on next rotate)" : ""}
              </Banner>
            ) : (
              <Banner tone="warning">
                Not auto-registered. Give iCabbi the URL and signing secret manually.
              </Banner>
            )}

            <Field label="Inbound webhook URL (auto-registered with iCabbi on Connect)">
              <input value={webhookUrlWithToken} readOnly className="input font-mono" />
              <p className="text-xs text-ink-muted mt-1.5">
                iCabbi cannot sign outbound webhooks. The shared secret travels on the URL as
                <code>?token=…</code>; the inbound route compares it in constant time against the
                stored webhook secret.
              </p>
            </Field>
            <Field label="Webhook secret">
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
                Generates a new secret + tears down all 13 listeners on iCabbi and re-registers
                them with the new token. Atomic from your perspective.
              </span>
            </form>
          </Section>

          {/* H1.5 outbound flow — iCabbi calls us when they have no driver */}
          <Section title="Inbound from iCabbi (virtual fleet — H1.5)">
            <p className="text-sm text-ink-muted">
              When iCabbi has no driver coverage on this tenant, their Networking
              Engine offers the booking to The Exchange (registered as a virtual
              fleet on their side per <code>STRATEGY.md</code> decision #12).
              Configure these URLs in iCabbi&apos;s fleet-config UI for this
              tenant, alongside the Bearer token shown at connect time.
            </p>

            <Field label="Bookings endpoint (offer a booking to The Exchange)">
              <input value={inboundBookingsUrl} readOnly className="input font-mono" />
            </Field>

            <Field label="Cancellations endpoint (cancel a previously-offered booking)">
              <input value={inboundCancellationsUrl} readOnly className="input font-mono" />
            </Field>

            <Field label="Authentication header">
              <input
                value="Authorization: Bearer <token shown at connect time>"
                readOnly
                className="input font-mono"
              />
            </Field>

            <Field label="Inbound Bearer token">
              <input
                value={
                  creds.inboundBearerToken
                    ? "•".repeat(48) + " (saved, only shown once)"
                    : "not generated"
                }
                readOnly
                className="input font-mono"
              />
            </Field>

            <p className="text-xs text-ink-muted">
              Lost the token? Use the Rotate button above — it regenerates both
              the webhook signing secret and this Bearer token together. iCabbi
              will need to update both on their side.
            </p>
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
