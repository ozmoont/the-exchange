import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendMagicLinkEmail, sendPartnerApprovalEmail } from "@/lib/email";

/**
 * Email sender (src/lib/email.ts). Per function: RESEND_API_KEY set → POST to
 * Resend (assert URL/method/headers/body); no key → dev fallback that prints
 * the link to console and never hits the network. Plus two security props: the
 * API key leaks nowhere, and approval emails HTML-escape the user-supplied
 * fleet name against markup injection.
 */

const API_KEY = "re_TEST_SECRET_KEY_12345";
const ORIGINAL_RESEND = process.env.RESEND_API_KEY;
const ORIGINAL_FROM = process.env.AUTH_EMAIL_FROM;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // Default dev mode (no key); Resend-path tests set the key. fetch always
  // stubbed so no test hits the network.
  delete process.env.RESEND_API_KEY;
  delete process.env.AUTH_EMAIL_FROM;
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => "" }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (ORIGINAL_RESEND === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = ORIGINAL_RESEND;
  if (ORIGINAL_FROM === undefined) delete process.env.AUTH_EMAIL_FROM;
  else process.env.AUTH_EMAIL_FROM = ORIGINAL_FROM;
});

describe("sendMagicLinkEmail — dev fallback (no RESEND_API_KEY)", () => {
  it("logs the recipient and magic-link URL to the console and never calls fetch", async () => {
    // Local sign-in: link must be in terminal scrollback, no network call.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await sendMagicLinkEmail({ to: "dev@example.com", url: "http://localhost:3000/magic?t=abc" });

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("MAGIC LINK (RESEND_API_KEY not set — dev mode)");
    expect(output).toContain("To:  dev@example.com");
    expect(output).toContain("URL: http://localhost:3000/magic?t=abc");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("sendMagicLinkEmail — Resend path (RESEND_API_KEY set)", () => {
  it("POSTs to the Resend API with Bearer auth and a complete JSON body", async () => {
    // Resend wire contract: endpoint, method, auth/content headers, and a
    // body whose text+html both carry the sign-in URL.
    process.env.RESEND_API_KEY = API_KEY;
    await sendMagicLinkEmail({ to: "user@fleet.ie", url: "https://app.example/magic?t=tok" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body as string);
    expect(body.to).toBe("user@fleet.ie");
    expect(body.subject).toBe("Sign in to The Exchange");
    // Default sender when AUTH_EMAIL_FROM is unset.
    expect(body.from).toBe("The Exchange <onboarding@resend.dev>");
    expect(body.text).toContain("https://app.example/magic?t=tok");
    expect(body.html).toContain("https://app.example/magic?t=tok");
  });

  it("uses AUTH_EMAIL_FROM as the sender when configured", async () => {
    // Env override (verified domain) must win over the resend.dev default.
    process.env.RESEND_API_KEY = API_KEY;
    process.env.AUTH_EMAIL_FROM = "The Exchange <auth@theexchange.ie>";
    await sendMagicLinkEmail({ to: "a@b.c", url: "https://x/magic" });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.from).toBe("The Exchange <auth@theexchange.ie>");
  });

  it("does not log the magic link when actually sending via Resend", async () => {
    // Dev banner is dev-only — in prod the link belongs in the email, not logs.
    process.env.RESEND_API_KEY = API_KEY;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await sendMagicLinkEmail({ to: "a@b.c", url: "https://x/magic?t=secret-link" });
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).not.toContain("secret-link");
  });

  it("throws with the Resend status and response body when the API rejects", async () => {
    // Auth flow needs a diagnosable error (Resend status + body), not silence.
    process.env.RESEND_API_KEY = API_KEY;
    fetchMock.mockResolvedValueOnce({ ok: false, status: 422, text: async () => '{"message":"invalid to"}' });
    await expect(sendMagicLinkEmail({ to: "bad", url: "https://x" })).rejects.toThrow(
      'Resend send failed: 422 {"message":"invalid to"}',
    );
  });

  it("still throws a clean error when reading the failure body itself fails", async () => {
    // res.text() can reject (cut connection); the .catch("") guard keeps the
    // original status instead of masking it with a secondary read failure.
    process.env.RESEND_API_KEY = API_KEY;
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error("body read failed");
      },
    });
    await expect(sendMagicLinkEmail({ to: "a@b.c", url: "https://x" })).rejects.toThrow(
      "Resend send failed: 500 ",
    );
  });

  it("never leaks RESEND_API_KEY into console output or the thrown error (secret hygiene)", async () => {
    // Key's only legitimate destination is the Authorization header. Force
    // the noisiest path (failed send formats an error) while capturing every
    // console channel, then assert the key appears nowhere.
    process.env.RESEND_API_KEY = API_KEY;
    const captured: string[] = [];
    const channels = ["log", "info", "warn", "error", "debug"] as const;
    const spies = channels.map((c) =>
      vi.spyOn(console, c).mockImplementation((...args: unknown[]) => {
        captured.push(args.map(String).join(" "));
      }),
    );
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => "unauthorized" });

    let thrown: Error | null = null;
    try {
      await sendMagicLinkEmail({ to: "a@b.c", url: "https://x/magic" });
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).not.toBeNull();
    expect(thrown!.message).not.toContain(API_KEY);
    expect(captured.join("\n")).not.toContain(API_KEY);
    // Sanity: the key DID reach the Authorization header (not vacuously unused).
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      Authorization: `Bearer ${API_KEY}`,
    });
    spies.forEach((s) => s.mockRestore());
  });
});

describe("sendPartnerApprovalEmail — dev fallback", () => {
  it("logs recipient, fleet name and URL without calling fetch", async () => {
    // Same dev contract as the magic link: testable locally, no email infra.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await sendPartnerApprovalEmail({ to: "ops@fleet.ie", url: "http://localhost/in", fleetName: "Galway Cabs" });

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("APPROVAL EMAIL (RESEND_API_KEY not set — dev mode)");
    expect(output).toContain("To:    ops@fleet.ie");
    expect(output).toContain("Fleet: Galway Cabs");
    expect(output).toContain("URL:   http://localhost/in");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("sendPartnerApprovalEmail — Resend path", () => {
  it("sends with a fleet-personalised subject and next-steps copy", async () => {
    // Subject carries the fleet name; text + html both include the sign-in URL.
    process.env.RESEND_API_KEY = API_KEY;
    await sendPartnerApprovalEmail({ to: "ops@fleet.ie", url: "https://x/in?t=1", fleetName: "Galway Cabs" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(init.body as string);
    expect(body.subject).toBe("Welcome to The Exchange — Galway Cabs is approved");
    expect(body.text).toContain("https://x/in?t=1");
    expect(body.html).toContain("https://x/in?t=1");
    expect(body.text).toContain("iCabbi App-Key");
  });

  it("HTML-escapes the fleet name in the html body (injection guard)", async () => {
    // fleetName is public-form input; raw HTML interpolation would let an
    // applicant inject markup. escapeHtml must neutralise all five chars.
    process.env.RESEND_API_KEY = API_KEY;
    const hostile = `<script>alert("x")&'</script>`;
    await sendPartnerApprovalEmail({ to: "a@b.c", url: "https://x", fleetName: hostile });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.html).not.toContain("<script>");
    expect(body.html).toContain("&lt;script&gt;");
    expect(body.html).toContain("&quot;x&quot;");
    expect(body.html).toContain("&amp;");
    expect(body.html).toContain("&#39;");
    // FLAG (actual behaviour): the text/plain part embeds fleetName raw —
    // fine for plain text; asserted so a future change is deliberate.
    expect(body.text).toContain(hostile);
  });

  it("throws with status and body when Resend rejects the approval email", async () => {
    // Silent failure would strand a newly-approved partner with no link —
    // the caller must see it.
    process.env.RESEND_API_KEY = API_KEY;
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, text: async () => "forbidden" });
    await expect(
      sendPartnerApprovalEmail({ to: "a@b.c", url: "https://x", fleetName: "F" }),
    ).rejects.toThrow("Resend send failed: 403 forbidden");
  });
});
