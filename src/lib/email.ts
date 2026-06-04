/**
 * Email sender. Uses Resend's REST API if RESEND_API_KEY is set, otherwise
 * logs the magic link to the server console (dev mode).
 *
 * No Resend SDK dep — the REST API is simple enough to call with fetch.
 */

export async function sendMagicLinkEmail(args: { to: string; url: string }): Promise<void> {
  const subject = "Sign in to The Exchange";
  const text = `Click this link to sign in:\n\n${args.url}\n\nLink expires in 15 minutes. If you didn't request this, you can ignore it.`;
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="margin:0 0 16px;font-size:18px">Sign in to The Exchange</h2>
      <p style="color:#475569;font-size:14px;line-height:1.5">
        Click below to sign in. The link expires in 15 minutes.
      </p>
      <p style="margin:24px 0">
        <a href="${args.url}" style="display:inline-block;padding:12px 20px;background:#0f172a;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">Sign in</a>
      </p>
      <p style="color:#94a3b8;font-size:12px;line-height:1.5;word-break:break-all">
        Or paste this URL: ${args.url}
      </p>
      <p style="color:#94a3b8;font-size:12px">
        If you didn't request this, you can safely ignore it.
      </p>
    </div>
  `;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Dev mode: print the link prominently so it's findable in terminal scrollback
    const banner = "═".repeat(60);
    console.log(`\n${banner}`);
    console.log("MAGIC LINK (RESEND_API_KEY not set — dev mode)");
    console.log(banner);
    console.log(`To:  ${args.to}`);
    console.log(`URL: ${args.url}`);
    console.log(`${banner}\n`);
    return;
  }

  const from = process.env.AUTH_EMAIL_FROM ?? "The Exchange <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: args.to, subject, text, html }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend send failed: ${res.status} ${body}`);
  }
}

/**
 * Welcome email for a newly-approved partner application. Includes a magic
 * link to their first sign-in and a short list of next steps so they don't
 * land on the dashboard wondering what to do.
 */
export async function sendPartnerApprovalEmail(args: {
  to: string;
  url: string;
  fleetName: string;
}): Promise<void> {
  const subject = `Welcome to The Exchange — ${args.fleetName} is approved`;
  const text =
    `Welcome to The Exchange!\n\n` +
    `Your application for ${args.fleetName} has been approved. ` +
    `Sign in to set up your iCabbi integration and start receiving cross-network bookings:\n\n` +
    `${args.url}\n\n` +
    `Next steps once you're signed in:\n` +
    `  1. Visit the Integration page for your fleet\n` +
    `  2. Paste your iCabbi App-Key and Secret-Key\n` +
    `  3. Review which fleets you want to send to / receive from on the Routing page\n` +
    `  4. We auto-register our inbound webhook with your iCabbi tenant\n\n` +
    `Link expires in 15 minutes. If you missed it, request another from the sign-in page.\n\n` +
    `Questions? Reply to this email.`;

  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
      <h2 style="margin:0 0 8px;font-size:20px">Welcome to The Exchange</h2>
      <p style="color:#475569;font-size:14px;line-height:1.5;margin:0 0 16px">
        Your application for <strong>${escapeHtml(args.fleetName)}</strong> has been approved.
        Sign in to set up your integration and start receiving cross-network bookings.
      </p>
      <p style="margin:24px 0">
        <a href="${args.url}" style="display:inline-block;padding:12px 20px;background:#0f172a;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">Sign in & set up</a>
      </p>
      <div style="background:#f8fafc;border-radius:8px;padding:16px;margin:24px 0;font-size:14px;color:#475569;line-height:1.6">
        <strong style="display:block;margin-bottom:8px;color:#0f172a">Next steps once you're signed in</strong>
        <ol style="margin:0;padding-left:18px">
          <li>Visit the <strong>Integration</strong> page for your fleet</li>
          <li>Paste your iCabbi App-Key and Secret-Key</li>
          <li>Set up routing rules with the partners you want to work with</li>
          <li>We auto-register our inbound webhook with your iCabbi tenant</li>
        </ol>
      </div>
      <p style="color:#94a3b8;font-size:12px;line-height:1.5;word-break:break-all">
        Or paste this URL: ${args.url}
      </p>
      <p style="color:#94a3b8;font-size:12px;margin-top:24px">
        Link expires in 15 minutes. Questions? Reply to this email.
      </p>
    </div>
  `;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    const banner = "═".repeat(60);
    console.log(`\n${banner}`);
    console.log(`APPROVAL EMAIL (RESEND_API_KEY not set — dev mode)`);
    console.log(banner);
    console.log(`To:    ${args.to}`);
    console.log(`Fleet: ${args.fleetName}`);
    console.log(`URL:   ${args.url}`);
    console.log(`${banner}\n`);
    return;
  }

  const from = process.env.AUTH_EMAIL_FROM ?? "The Exchange <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: args.to, subject, text, html }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend send failed: ${res.status} ${body}`);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
