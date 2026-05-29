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
