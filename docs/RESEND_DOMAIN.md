# Resend domain verification

Without a verified domain, Resend's sandbox sender (`onboarding@resend.dev`) only delivers to the email you used to sign up — every other recipient is silently refused. That's why test recipients never received a magic link during initial testing.

Verifying a domain takes about 10 minutes (mostly DNS propagation) and removes the sandbox restriction completely. Once done, you can sign in with any email on the allowlist, invite Frank, and flip `DISABLE_AUTH` off.

## What you need

- A domain you control (apex like `your-domain.example`, or a subdomain like `auth.your-domain.example`).
- Admin access to that domain's DNS at your registrar (Cloudflare, Namecheap, GoDaddy, etc.).
- About 15 minutes for the DNS records to propagate after you add them.

## Steps

### 1. Add the domain in Resend

Sign in at [resend.com](https://resend.com) → **Domains** → **Add Domain**.

Enter your domain (e.g. `your-domain.example`). If you want emails to come from a subdomain (cleaner — keeps your apex domain's SPF intact), enter `auth.your-domain.example` instead. Either works; subdomain is the recommended pattern for transactional email.

Click **Add**. Resend shows you a table of DNS records to add. There are typically 3–4:

| Type | Name | Value |
|------|------|-------|
| MX | `send.your-domain.example` (or `send.auth.your-domain.example`) | `feedback-smtp.eu-west-1.amazonses.com` (priority 10) |
| TXT | `send.your-domain.example` | `v=spf1 include:amazonses.com ~all` |
| TXT | `resend._domainkey.your-domain.example` | (long DKIM string starting with `p=`) |
| TXT (optional, recommended) | `_dmarc.your-domain.example` | `v=DMARC1; p=none;` |

Keep this Resend tab open — you'll come back to it.

### 2. Add the records at your DNS host

Open a second tab at your registrar's DNS settings. For each row Resend showed:

- Copy the **Type** and **Name** and **Value** exactly.
- For the **Name**, most registrars only want the subdomain part (e.g. `send` for `send.your-domain.example`). If your registrar wants the full hostname, paste the full thing.
- For the MX record, set the priority to `10`.
- TTL: whatever default the registrar suggests (usually 300 or 3600 seconds).

Save each record.

### 3. Wait for verification

Back in Resend → Domains → your domain. Click **Verify DNS records**. Resend polls your DNS; usually verifies within 1–5 minutes but can take up to an hour depending on your registrar's propagation.

Status flips from "Not Started" → "Pending" → "Verified".

### 4. Set the from address in Vercel

Once verified, decide on a sending address. Common choices:

- `login@your-domain.example` (good for magic links)
- `noreply@your-domain.example` (impersonal, also fine)
- `The Exchange <login@your-domain.example>` (display-name + address — best UX)

Vercel → Settings → Environment Variables → **Add New** (or edit existing if you already added it as blank):

| Name | Value |
|------|-------|
| `AUTH_EMAIL_FROM` | `The Exchange <login@your-domain.example>` |

Save.

### 5. Re-enable auth

Same env vars panel — find `DISABLE_AUTH` → edit → change value to `false` (or delete the row entirely). Save.

### 6. Redeploy

Deployments → most recent → ⋯ → **Redeploy**. About 2 minutes.

### 7. Test

Open the live URL in an incognito window (so you don't have any leftover demo-mode state). You should see the landing page. Sign in with any email on `ALLOWED_EMAILS` — the magic link should land in their inbox within seconds, sent from your verified domain.

## Troubleshooting

**Records show "Pending" for more than 30 minutes.** Most likely the DNS records weren't saved correctly. Use [dig.dev](https://dig.dev) or [mxtoolbox.com](https://mxtoolbox.com) to query the records you added — if they don't resolve, the registrar didn't save them. Double-check the **Name** field; some registrars want just `send`, others want `send.your-domain.example`.

**Verified but emails still bounce.** Check Resend's **Emails** tab for the most recent send. If you see `bounced` with a Gmail/Outlook error, the recipient address is invalid or the receiving server reports a spam-filter rejection. Sending domains less than a few days old sometimes get soft-rejected by spam filters — wait a day and retry, or warm up the domain by sending a few legit-looking emails first.

**Verified but `AUTH_EMAIL_FROM` rejected.** The `from` address must use the verified domain. `login@your-domain.example` works if `your-domain.example` is verified; `login@auth.your-domain.example` works if `auth.your-domain.example` is verified. Cross-domain `from` is refused.

## What happens after this is done

- Anyone on `ALLOWED_EMAILS` can sign in via magic link.
- New users invited through `/users` (super_admin only) get real emails too — they don't have to be added to the env var.
- The `DISABLE_AUTH` escape hatch stays in the code as a one-line flip-back-on switch, but you shouldn't need it again.
- You can now share the live URL with Frank without worrying about it being publicly accessible.
