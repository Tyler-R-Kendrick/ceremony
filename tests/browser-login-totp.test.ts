import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { managedBackends } from "../src/server/browser-backends.js";
import { createBrowserLoginService } from "../src/server/browser-login-service.js";
import { createBrowserSessionRegistry } from "../src/server/browser-sessions.js";
import {
  createFixtureVerifier,
  createVerifierRegistry,
} from "../src/server/browser-verification.js";
import { compileLoginPlan, PlanRejected } from "../src/server/login-plan.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import { totpCode } from "../src/server/totp.js";
import type { ActorContext } from "../src/core/operation-contracts.js";

/**
 * An authenticator step answered from a held seed, in a real browser.
 *
 * The provider here is owned and tiny: one form that asks for an authenticator
 * code, checks it against the seed it enrolled, and sets a session cookie. Its
 * own record of what it accepted is the oracle, and the fixture verifier asks
 * it — through the browser's cookie jar — who is signed in.
 *
 * The privacy half matters as much as the login half. The seed is the
 * long-lived secret: every case serializes what left the service (result and
 * every step it reported) and hunts for the seed and the codes in it. Two
 * pages misbehave on purpose — one prints the seed, one mirrors the typed code
 * into an alert — and both must stop the attempt by name before anything is
 * submitted.
 */

/** Synthetic enrolment secret. Nothing else in the repository produces it. */
const SEED = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const SEED_GROUPED_LOWER = "jbsw y3dp ehpk 3pxp jbsw y3dp ehpk 3pxp";
const seedRef = "ref-totp-seed";
const actor: ActorContext = {
  tenantId: "tenant-totp",
  subjectId: "subject-totp",
  sessionId: "client-totp",
  actorKind: "human",
  capabilities: ["executor"],
};

let server: Server;
let origin: string;
/** Codes the provider accepted, in order. The login's ground truth. */
const accepted: string[] = [];
/** Every code value the provider received, accepted or not. */
const received: string[] = [];

const form = (extra = "", mirror = false) =>
  `<!doctype html><html><head><title>Two-step verification</title></head><body>
  <h1>Enter your authenticator code</h1>${extra}
  ${mirror ? '<div role="alert" id="mirror"></div>' : ""}
  <form method="post" action="/verify">
    <label for="otp">Authenticator code</label>
    <input id="otp" name="otp" type="text" inputmode="numeric" autocomplete="one-time-code" required
      ${mirror ? "oninput=\"document.getElementById('mirror').textContent='You typed '+this.value\"" : ""}>
    <button type="submit">Verify</button>
  </form></body></html>`;

before(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const html = (body: string, status = 200) => {
      response.writeHead(status, { "content-type": "text/html" });
      response.end(body);
    };
    if (request.method === "GET" && url.pathname === "/signin")
      return html(form());
    if (request.method === "GET" && url.pathname === "/signin-leaky")
      return html(form(`<h2>Backup key: ${SEED_GROUPED_LOWER}</h2>`));
    if (request.method === "GET" && url.pathname === "/signin-mirror")
      return html(form("", true));
    if (request.method === "POST" && url.pathname === "/verify") {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const code = new URLSearchParams(body).get("otp") ?? "";
        received.push(code);
        const now = Date.now();
        // One step either side, as real providers allow for clock skew.
        const valid = [-30_000, 0, 30_000].some(
          (skew) => totpCode(SEED, now + skew) === code,
        );
        if (!valid) return html(form('<p role="alert">Invalid code</p>'));
        accepted.push(code);
        response.writeHead(303, {
          location: "/account",
          "set-cookie": "session=ada; Path=/; HttpOnly",
        });
        response.end();
      });
      return;
    }
    if (url.pathname === "/account")
      return html(
        "<!doctype html><title>Signed in</title><h1>Welcome back</h1>",
      );
    if (url.pathname === "/api/whoami") {
      const signedIn = /(?:^|;\s*)session=ada(?:;|$)/.test(
        request.headers.cookie ?? "",
      );
      response.writeHead(signedIn ? 200 : 401, {
        "content-type": "application/json",
      });
      response.end(signedIn ? '{"account":"ada"}' : "{}");
      return;
    }
    html("not found", 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function planFor(path: string, refs: Record<string, string>) {
  return compileLoginPlan(
    {
      connectorId: "owned-totp-login",
      engine: "chromium",
      ownership: "managed",
      entryUrl: `${origin}${path}`,
      navigationOrigins: [origin],
      credentialRecipients: { "totp-code": [origin] },
      account: { kind: "expect", accountRef: "ada" },
      continuation: "retain-for-authorized-agent",
      trustMode: "constrained-auth",
      interactionRounds: 0,
      requireVerification: true,
      verifierOrigin: origin,
      credentialRefs: refs,
      sessionTtlMs: 600_000,
    },
    {
      backends: managedBackends(),
      knownConnectors: new Set(["owned-totp-login"]),
      revision: 1,
    },
  );
}

function harness() {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "totp",
    keys: { totp: new Uint8Array(32) },
  });
  const sessions = createBrowserSessionRegistry({ store });
  const asked: string[] = [];
  const service = createBrowserLoginService({
    sessions,
    verifiers: createVerifierRegistry([createFixtureVerifier({ origin })]),
    credentials: {
      resolve: async (_actor, _plan, role) => {
        asked.push(role);
        return role === "totp-seed" ? SEED : undefined;
      },
    },
  });
  return {
    service,
    asked,
    async close() {
      await sessions.disposeAll();
      await store.close();
    },
  };
}

/** Everything the service handed outward during one login, serialized whole. */
async function loginAndCollect(path: string) {
  const h = harness();
  const steps: unknown[] = [];
  const acceptedBefore = accepted.length;
  const receivedBefore = received.length;
  try {
    const result = await h.service.login(actor, {
      plan: planFor(path, { "totp-seed": seedRef }),
      onStep: (step) => steps.push(step),
    });
    return {
      result,
      asked: [...h.asked],
      surface: JSON.stringify({ result, steps }),
      accepted: accepted.slice(acceptedBefore),
      received: received.slice(receivedBefore),
    };
  } finally {
    await h.close();
  }
}

/** The codes that could have been typed during a test that just ran. */
function recentCodes(): string[] {
  const now = Date.now();
  return [-60_000, -30_000, 0, 30_000].map((skew) =>
    totpCode(SEED, now + skew),
  );
}

describe("TOTP-SEED: an authenticator step answered from a held seed", () => {
  test("the provider accepts a code derived at fill time and the account is verified", async () => {
    const run = await loginAndCollect("/signin");
    assert.equal(
      run.result.status,
      "verified",
      `expected verified, got ${JSON.stringify(run.result)}`,
    );
    // The provider's own record: exactly one code, accepted.
    assert.equal(run.accepted.length, 1);
    assert.deepEqual(run.received, run.accepted);
    // The service asked for the seed and never for a code it could not hold.
    assert.ok(run.asked.includes("totp-seed"));
    assert.ok(!run.asked.includes("totp-code"));
    // Neither the seed nor the code that was typed left the service.
    assert.ok(!run.surface.includes(SEED));
    assert.ok(!run.surface.includes(run.accepted[0]!));
  });

  test("a page that prints the seed stops the attempt before anything is typed", async () => {
    const run = await loginAndCollect("/signin-leaky");
    assert.deepEqual(run.result.status, "blocked");
    assert.equal(
      "reason" in run.result ? run.result.reason : undefined,
      "protected-value-exposed",
    );
    // Nothing reached the provider: the canary fired on the first read.
    assert.deepEqual(run.received, []);
    assert.ok(!run.surface.includes(SEED));
    assert.ok(!run.surface.toLowerCase().includes(SEED_GROUPED_LOWER));
  });

  test("a page that mirrors the typed code stops before it is submitted", async () => {
    const run = await loginAndCollect("/signin-mirror");
    assert.equal(run.result.status, "blocked");
    assert.equal(
      "reason" in run.result ? run.result.reason : undefined,
      "protected-value-exposed",
    );
    assert.deepEqual(run.received, []);
    for (const code of recentCodes()) assert.ok(!run.surface.includes(code));
  });
});

describe("TOTP-PLAN: a seed and a code for one step are one answer too many", () => {
  test("declaring both is refused rather than one quietly winning", () => {
    assert.throws(
      () =>
        planFor("/signin", {
          "totp-seed": seedRef,
          "totp-code": "ref-static-code",
        }),
      (error: unknown) =>
        error instanceof PlanRejected &&
        error.reason === "unknown-credential-reference" &&
        error.detail === "totp-code",
    );
  });
});
