import assert from "node:assert/strict";
import { test } from "node:test";
import { startAuthProvider } from "../doubles/auth-provider/server.js";
import { totpCode } from "../../src/server/totp.js";

/**
 * The auth double's authenticator, over plain HTTP: enrolment turns the
 * factor on only for a code from the seed it showed, and every code from a
 * seed is accepted once (RFC 6238 section 5.2) - the code that confirmed the
 * enrolment cannot also sign the account in, while the next period's code
 * can. What the double enforces here is what makes a client's
 * single-use rule (`nextTotpCode`) necessary rather than decorative.
 */

const account = {
  email: "owner-enrol@ceremony.invalid",
  username: "owner-enrol",
  password: "pw-enrolment-fixture-7f3a",
};

/** A browser with one cookie jar, that does not follow redirects. */
function browser(origin: string) {
  const jar = new Map<string, string>();
  return async (path: string, form?: Record<string, string>) => {
    const response = await fetch(`${origin}${path}`, {
      method: form ? "POST" : "GET",
      redirect: "manual",
      headers: {
        cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
        ...(form
          ? { "content-type": "application/x-www-form-urlencoded" }
          : {}),
      },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    });
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(";");
      const at = pair!.indexOf("=");
      jar.set(pair!.slice(0, at), pair!.slice(at + 1));
    }
    return {
      status: response.status,
      location: response.headers.get("location") ?? "",
      html: await response.text(),
    };
  };
}

const signIn = (visit: ReturnType<typeof browser>) =>
  visit("/signin?next=/", {
    username: account.username,
    password: account.password,
  });

test("TOTP-ENROL: a code confirms the enrolment once, and sign-in needs a later one", async (t) => {
  const provider = await startAuthProvider({
    layout: "classic-card",
    enrollTotp: true,
    accounts: [account],
  });
  t.after(() => provider.close());

  // Sign-in on an account with no authenticator goes to the setup page.
  const first = browser(provider.origin);
  const signedIn = await signIn(first);
  assert.equal(signedIn.status, 302);
  assert.match(signedIn.location, /^\/mfa\/setup/);
  const setup = await first(signedIn.location);
  const key = /id="totp-setup-key"[^>]*value="([A-Z2-7 ]+)"/.exec(
    setup.html,
  )?.[1];
  assert.ok(key, "the setup page shows a key");
  const seed = key.replace(/\s/g, "");

  // A wrong code does not turn the factor on; the seed's code does.
  const wrong = await first(signedIn.location, { code: "000000" });
  assert.equal(wrong.status, 200);
  assert.equal(provider.account(account.email)?.totpSeed, undefined);
  const now = Date.now();
  const code = totpCode(seed, now);
  const enrolled = await first(signedIn.location, { code });
  assert.equal(enrolled.status, 302);
  assert.equal(provider.account(account.email)?.totpSeed, seed);

  // A new browser signs in, and is asked for a code. The one that confirmed
  // the enrolment is spent; the next period's is not.
  const second = browser(provider.origin);
  const again = await signIn(second);
  assert.equal(again.status, 200);
  assert.match(again.html, /Two-factor authentication/);
  const reused = await second("/mfa?next=/", { code });
  assert.equal(reused.status, 200, "a spent code is refused");
  assert.match(reused.html, /incorrect or has expired/);
  const later = await second("/mfa?next=/", {
    code: totpCode(seed, now + 30_000),
  });
  assert.equal(later.status, 302, "the next period's code signs in");
  assert.equal(
    (await second("/api/whoami")).status,
    200,
    "the second browser is signed in",
  );
});
