import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { parseHTML } from "linkedom";
import { snapshotSelectors } from "../../src/core/browser-contracts.js";
import {
  createIdentityFixture,
  type IdentityFixture,
} from "./identity-provider.js";

// The oracle only has authority if it is itself proven, so these tests interrogate
// it with plain fetch: no browser, no extension, no agent. Anything a browser test
// would later believe on the fixture's word is established here first.

async function fixtureFor(t: TestContext): Promise<IdentityFixture> {
  const fixture = await createIdentityFixture();
  t.after(() => fixture.close());
  return fixture;
}

/** A `Set-Cookie` header carries attributes a `Cookie` header must not repeat. */
const cookiePair = (setCookie: string) => setCookie.split(";")[0] ?? "";

async function submit(
  url: string,
  fields: Record<string, string>,
  cookie?: string,
) {
  const response = await fetch(url, {
    method: "POST",
    redirect: "manual",
    ...(cookie ? { headers: { cookie } } : {}),
    body: new URLSearchParams(fields),
  });
  await response.text();
  return response;
}

test("a correct combined submission opens a session the server itself recognizes", async (t) => {
  const fixture = await fixtureFor(t);
  const owner = fixture.accounts[0];
  assert.ok(owner);
  const listening = new URL(fixture.origin);
  assert.equal(listening.hostname, "127.0.0.1");
  // An ephemeral port, so two suites can run at once and neither owns 4174.
  assert.notEqual(listening.port, "");
  assert.notEqual(listening.port, "4174");

  const response = await submit(fixture.url("/signin"), {
    identifier: owner.identifier,
    password: owner.password,
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/account");
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 1);
  const issued = cookies[0] ?? "";
  assert.match(issued, /^ceremony_session=/);
  assert.match(issued, /HttpOnly/);

  const whoami = await fetch(fixture.url("/api/whoami"), {
    headers: { cookie: cookiePair(issued) },
  });
  assert.equal(whoami.status, 200);
  assert.deepEqual(await whoami.json(), { account: owner.account });
  // The same claim, read from the server's own map rather than its response.
  assert.equal(fixture.accountForCookie(issued), owner.account);
  assert.equal(fixture.sessionsFor(owner.account).length, 1);
});

test("each account is a distinct identity, not a shared logged-in flag", async (t) => {
  const fixture = await fixtureFor(t);
  const owner = fixture.accounts[0];
  const deputy = fixture.accounts[1];
  assert.ok(owner);
  assert.ok(deputy);
  assert.notEqual(owner.account, deputy.account);
  assert.notEqual(owner.password, deputy.password);

  const response = await submit(fixture.url("/signin"), {
    identifier: deputy.identifier,
    password: deputy.password,
  });
  const issued = response.headers.getSetCookie()[0] ?? "";
  assert.equal(fixture.accountForCookie(issued), deputy.account);
  assert.deepEqual(fixture.sessionsFor(owner.account), []);
});

test("a wrong password opens no session", async (t) => {
  const fixture = await fixtureFor(t);
  const owner = fixture.accounts[0];
  const deputy = fixture.accounts[1];
  assert.ok(owner);
  assert.ok(deputy);

  const response = await submit(fixture.url("/signin"), {
    identifier: owner.identifier,
    password: deputy.password,
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/signin?error=invalid");
  assert.deepEqual(response.headers.getSetCookie(), []);
  assert.deepEqual(fixture.sessionsFor(owner.account), []);

  const whoami = await fetch(fixture.url("/api/whoami"));
  assert.equal(whoami.status, 401);
  assert.deepEqual(await whoami.json(), { error: "unauthenticated" });

  const recorded = fixture.submissions();
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.account, owner.account);
  assert.equal(recorded[0]?.passwordMatched, false);
});

test("/account omits the account marker without a session", async (t) => {
  const fixture = await fixtureFor(t);
  const signedOut = await fetch(fixture.url("/account"));
  const body = await signedOut.text();
  assert.equal(signedOut.status, 200);
  assert.doesNotMatch(body, /<data[^>]*id="account"/);
  assert.match(body, /Signed out/);
});

test("/account renders the marker in the shape the extension verifies", async (t) => {
  const fixture = await fixtureFor(t);
  const owner = fixture.accounts[0];
  assert.ok(owner);
  const issued =
    (
      await submit(fixture.url("/signin"), {
        identifier: owner.identifier,
        password: owner.password,
      })
    ).headers.getSetCookie()[0] ?? "";
  const account = await fetch(fixture.url("/account"), {
    headers: { cookie: cookiePair(issued) },
  });
  const body = await account.text();
  // `verify-fixture` compares both the value attribute and the trimmed text.
  assert.match(
    body,
    new RegExp(
      `<data id="account" value="${owner.account}">${owner.account}</data>`,
    ),
  );
});

test("/forged looks signed in and the server still refuses", async (t) => {
  const fixture = await fixtureFor(t);
  const owner = fixture.accounts[0];
  assert.ok(owner);
  const forged = await fetch(fixture.url("/forged"));
  const body = await forged.text();
  assert.match(body, /Signed in as account-owner/);
  // It even carries the contract's own element: a DOM marker is not authority.
  assert.match(body, /<data id="account" value="account-owner"/);
  assert.match(body, /Sign out/);
  assert.deepEqual(forged.headers.getSetCookie(), []);

  const whoami = await fetch(fixture.url("/api/whoami"));
  assert.equal(whoami.status, 401);
  assert.deepEqual(fixture.sessionsFor(owner.account), []);
});

test("submissions() records exactly one entry per POST", async (t) => {
  const fixture = await fixtureFor(t);
  const owner = fixture.accounts[0];
  assert.ok(owner);
  assert.deepEqual(fixture.submissions(), []);

  await submit(fixture.url("/signin"), {
    identifier: owner.identifier,
    password: owner.password,
  });
  assert.equal(fixture.submissions().length, 1);

  const identified = await submit(fixture.url("/signin-identifier"), {
    identifier: owner.identifier,
  });
  assert.equal(fixture.submissions().length, 2);
  await submit(
    fixture.url("/signin-password"),
    { password: owner.password },
    cookiePair(identified.headers.getSetCookie()[0] ?? ""),
  );
  const recorded = fixture.submissions();
  assert.equal(recorded.length, 3);
  assert.deepEqual(
    recorded.map((entry) => entry.path),
    ["/signin", "/signin-identifier", "/signin-password"],
  );
  assert.deepEqual(
    recorded.map((entry) => entry.passwordMatched),
    [true, false, true],
  );
  for (const entry of recorded) {
    assert.equal(entry.account, owner.account);
    assert.equal(typeof entry.at, "number");
  }
});

test("the identifier-first flow needs both documents", async (t) => {
  const fixture = await fixtureFor(t);
  const owner = fixture.accounts[0];
  assert.ok(owner);

  const first = await (await fetch(fixture.url("/signin-identifier"))).text();
  assert.match(first, /name="identifier"/);
  assert.doesNotMatch(first, /type="password"/);

  // The password document is not reachable by URL alone; step one authorizes it.
  const premature = await (await fetch(fixture.url("/signin-password"))).text();
  assert.doesNotMatch(premature, /type="password"/);
  assert.match(premature, /Start again/);

  const identified = await submit(fixture.url("/signin-identifier"), {
    identifier: owner.identifier,
  });
  assert.equal(identified.headers.get("location"), "/signin-password");
  const token = cookiePair(identified.headers.getSetCookie()[0] ?? "");
  assert.match(token, /^ceremony_identified=/);

  const second = await (
    await fetch(fixture.url("/signin-password"), { headers: { cookie: token } })
  ).text();
  assert.match(second, /type="password"/);

  const done = await submit(
    fixture.url("/signin-password"),
    { password: owner.password },
    token,
  );
  assert.equal(done.status, 303);
  assert.equal(done.headers.get("location"), "/account");
  const issued = done.headers
    .getSetCookie()
    .find((value) => value.startsWith("ceremony_session="));
  assert.ok(issued);
  assert.equal(fixture.accountForCookie(issued), owner.account);
});

test("the canary reports what reached the server and what never did", async (t) => {
  const fixture = await fixtureFor(t);
  const owner = fixture.accounts[0];
  assert.ok(owner);
  const neverTyped = "fixture-never-submitted-value";

  await submit(fixture.url("/signin"), {
    identifier: owner.identifier,
    password: owner.password,
  });
  assert.equal(fixture.canary.sawValue(owner.password), true);
  assert.equal(fixture.canary.sawValue(neverTyped), false);

  const echoed = await (await fetch(fixture.canary.url)).text();
  assert.match(echoed, new RegExp(owner.identifier));
  assert.doesNotMatch(echoed, new RegExp(neverTyped));
  const received = fixture.canary.received();
  assert.deepEqual(
    received.map((entry) => entry.field),
    ["identifier", "password"],
  );
  assert.equal(received[0]?.path, "/signin");
});

test("a submitted secret never surfaces on the account page", async (t) => {
  const fixture = await fixtureFor(t);
  const owner = fixture.accounts[0];
  assert.ok(owner);
  const issued =
    (
      await submit(fixture.url("/signin"), {
        identifier: owner.identifier,
        password: owner.password,
      })
    ).headers.getSetCookie()[0] ?? "";
  const account = await (
    await fetch(fixture.url("/account"), {
      headers: { cookie: cookiePair(issued) },
    })
  ).text();
  assert.equal(account.includes(owner.password), false);
});

test("/challenge and /passkey match the repo's own snapshot selectors", async (t) => {
  const fixture = await fixtureFor(t);
  const challenge = parseHTML(
    await (await fetch(fixture.url("/challenge"))).text(),
  ).document;
  assert.notEqual(challenge.querySelector(snapshotSelectors.challenge), null);
  assert.equal(challenge.querySelector(snapshotSelectors.passkey), null);

  const passkey = parseHTML(
    await (await fetch(fixture.url("/passkey"))).text(),
  ).document;
  assert.notEqual(passkey.querySelector(snapshotSelectors.passkey), null);
  assert.equal(passkey.querySelector(snapshotSelectors.challenge), null);
  // Passkey-required means there is nothing a password could be typed into.
  assert.equal(passkey.querySelector('input[type="password"]'), null);

  const attempted = await submit(fixture.url("/passkey"), {
    credential: "owner@fixture.test",
  });
  assert.equal(attempted.status, 200);
  assert.equal(fixture.submissions().length, 1);
  assert.equal(fixture.sessionsFor("account-owner").length, 0);
});

test("/slow declares a delayed transition to /account", async (t) => {
  const fixture = await fixtureFor(t);
  const body = await (await fetch(fixture.url("/slow?ms=1200"))).text();
  assert.match(body, /data-slow-delay="1200"/);
  assert.match(body, /location\.assign\("\/account"\)/);
  // Serving must not itself block, or a settling test measures the fixture.
  const started = Date.now();
  await (await fetch(fixture.url("/slow"))).text();
  assert.ok(Date.now() - started < 1000);
});

test("the partner origin is a separate server with separate sessions", async (t) => {
  const fixture = await fixtureFor(t);
  const owner = fixture.accounts[0];
  assert.ok(owner);
  assert.notEqual(fixture.partner.origin, fixture.origin);

  const issued =
    (
      await submit(fixture.url("/signin"), {
        identifier: owner.identifier,
        password: owner.password,
      })
    ).headers.getSetCookie()[0] ?? "";
  const crossed = await fetch(fixture.partner.url("/api/whoami"), {
    headers: { cookie: cookiePair(issued) },
  });
  assert.equal(crossed.status, 401);
  await crossed.text();
  assert.equal(fixture.partner.accountForCookie(issued), undefined);

  const sso = await (await fetch(fixture.partner.url("/sso"))).text();
  assert.match(sso, new RegExp(`href="${fixture.origin}/signin"`));
  const back = await fetch(fixture.url("/sso?redirect=1"), {
    redirect: "manual",
  });
  await back.text();
  assert.equal(
    back.headers.get("location"),
    `${fixture.partner.origin}/signin`,
  );
});

test("accountForCookie reads every form a test is likely to hold", async (t) => {
  const fixture = await fixtureFor(t);
  const owner = fixture.accounts[0];
  assert.ok(owner);
  const issued =
    (
      await submit(fixture.url("/signin"), {
        identifier: owner.identifier,
        password: owner.password,
      })
    ).headers.getSetCookie()[0] ?? "";
  const id = fixture.sessionsFor(owner.account)[0];
  assert.ok(id);
  assert.equal(fixture.accountForCookie(id), owner.account);
  assert.equal(fixture.accountForCookie(cookiePair(issued)), owner.account);
  assert.equal(fixture.accountForCookie(issued), owner.account);
  assert.equal(
    fixture.accountForCookie(`other=1; ${cookiePair(issued)}`),
    owner.account,
  );
  assert.equal(fixture.accountForCookie("ceremony_session=forged"), undefined);
});

test("signing out and reset() both retract the server's belief", async (t) => {
  const fixture = await fixtureFor(t);
  const owner = fixture.accounts[0];
  assert.ok(owner);
  const issued =
    (
      await submit(fixture.url("/signin"), {
        identifier: owner.identifier,
        password: owner.password,
      })
    ).headers.getSetCookie()[0] ?? "";
  const cookie = cookiePair(issued);
  const out = await fetch(fixture.url("/signout"), {
    headers: { cookie },
    redirect: "manual",
  });
  await out.text();
  assert.equal(fixture.accountForCookie(cookie), undefined);
  const whoami = await fetch(fixture.url("/api/whoami"), {
    headers: { cookie },
  });
  assert.equal(whoami.status, 401);
  await whoami.text();

  fixture.reset();
  assert.deepEqual(fixture.submissions(), []);
  assert.deepEqual(fixture.canary.received(), []);
  assert.deepEqual(fixture.sessionsFor(owner.account), []);
});

test("close() releases both origins", async () => {
  const fixture = await createIdentityFixture();
  const { origin, partner } = fixture;
  await fixture.close();
  await assert.rejects(() => fetch(new URL("/account", origin).href));
  await assert.rejects(() => fetch(new URL("/account", partner.origin).href));
});
