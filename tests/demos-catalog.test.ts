import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { demoCatalog, findDemos } from "../scripts/demos/catalog.js";
import { providerPhase } from "../scripts/demos/phases.js";
import { disclosure } from "../scripts/demos/story.js";
import { productNames } from "../scripts/demos/captions.js";
import { startAuthProvider } from "./doubles/auth-provider/server.js";

/**
 * The demo catalog and its pure helpers. Nothing here records video: that
 * launches a browser and encodes for about a minute per demo, so it runs only
 * under `npm run demos:record`, never as part of `npm test`.
 */

test("DEMO-ORDER: account registration is the first demo", () => {
  // Registration is what API-only agents most often cannot finish, so it is
  // the scenario a viewer sees first.
  assert.equal(demoCatalog[0]?.id, "agent-creates-account");
  assert.equal(demoCatalog[0]?.scenario, "registration-with-emailed-code");
  assert.deepEqual(
    findDemos([]).map((entry) => entry.id),
    demoCatalog.map((entry) => entry.id),
  );
});

test("DEMO-ORDER: every demo is uniquely named, has a module, and a stitched one exists", () => {
  const ids = demoCatalog.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of demoCatalog)
    assert.ok(
      existsSync(new URL(`../scripts/demos/${entry.id}.ts`, import.meta.url)),
      `${entry.id} has no module`,
    );
  const stitched = demoCatalog.filter(
    (entry) => (entry.chain?.length ?? 0) > 1,
  );
  assert.ok(stitched.length >= 1);
  for (const entry of stitched)
    assert.ok(entry.chain!.includes("verified"), entry.id);
  // The stitched run the docs feature chains registration into access.
  assert.ok(
    stitched.some(
      (entry) =>
        entry.chain!.includes("register") && entry.chain!.includes("consent"),
    ),
  );
  assert.throws(() => findDemos(["no-such-demo"]), /Unknown demo/);
});

test("DEMO-HONESTY: every title card says the provider is a self-hosted double", () => {
  for (const entry of demoCatalog) {
    const card = disclosure(entry, 21).join("\n");
    assert.match(card, /self-hosted test provider/);
    assert.match(
      card,
      /An invented product: not a real service, no real accounts/,
    );
    assert.match(card, /seed 21/);
    assert.match(card, /no model is called/);
  }
});

test("DEMO-PHASES: the chain position follows the driver's page and proposal", () => {
  const signup = "/auth/new";
  const at = (
    previous: Parameters<typeof providerPhase>[0],
    pathname: string,
    action: string,
    role?: string,
  ) => providerPhase(previous, { pathname, action, role }, signup);
  assert.equal(at(undefined, "/signin", "click"), "sign-in");
  assert.equal(at("sign-in", signup, "fill", "email"), "register");
  // The confirmation form is served from the sign-up URL itself.
  assert.equal(
    at("register", signup, "fill", "verification-code"),
    "verify-email",
  );
  assert.equal(at("verify-email", signup, "click"), "verify-email");
  assert.equal(at("verify-email", "/authorize", "click"), "consent");
  assert.equal(at(undefined, "/signin", "fill", "totp-code"), "second-factor");
  // A two-factor form answered from the identifier-first password URL.
  assert.equal(
    at("sign-in", "/signin/password", "fill", "totp-code"),
    "second-factor",
  );
  assert.equal(
    at("second-factor", "/signin/password", "click"),
    "second-factor",
  );
  assert.equal(
    at(undefined, "/signin/password", "fill", "password"),
    "sign-in",
  );
  // A page the map does not know leaves the phase where it was.
  assert.equal(at("consent", "/elsewhere", "wait"), "consent");
});

test("DEMO-HONESTY: the product a caption names is the one the layout renders", async () => {
  for (const entry of demoCatalog) {
    const provider = await startAuthProvider({ layout: entry.layout });
    try {
      const page = await (await fetch(`${provider.origin}/signin`)).text();
      assert.ok(
        page.includes(productNames[entry.layout]!),
        `${entry.layout} does not render ${productNames[entry.layout]}`,
      );
    } finally {
      await provider.close();
    }
  }
});
