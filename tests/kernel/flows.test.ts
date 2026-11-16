import assert from "node:assert/strict";
import test from "node:test";
import {
  check,
  compose,
  cooperate,
  derive,
  type Ceremony,
} from "../../src/kernel/index.js";
import { catalog } from "../../src/kernel/flows/catalog.js";
import { githubUserAccess } from "../../src/kernel/flows/github-app.js";

/** For each family: the steps from nothing, and the interfaces it needs. */
const expected: Record<
  keyof typeof catalog,
  { readonly fromNothing: string[]; readonly components: string[] }
> = {
  apiKey: {
    fromNothing: ["collect", "verify"],
    components: ["collect:necessary"],
  },
  httpBasic: {
    fromNothing: ["collect", "verify"],
    components: ["collect:necessary"],
  },
  oauthAuthorizationCode: {
    fromNothing: ["registerClient", "authorize", "exchangeCode"],
    components: ["authorize:necessary"],
  },
  oauthDevice: {
    fromNothing: ["registerClient", "startDevice", "approveOnDevice"],
    components: ["approveOnDevice:necessary"],
  },
  oauthClientCredentials: { fromNothing: ["requestToken"], components: [] },
  oauthTokenExchange: { fromNothing: ["exchange"], components: [] },
  passwordSignIn: {
    fromNothing: ["enterPassword", "submitPassword", "finishSignIn"],
    components: ["enterPassword:necessary", "enterOneTimeCode:contingent"],
  },
  magicLink: {
    fromNothing: ["askAddress", "followLink", "redeemLink"],
    components: ["askAddress:necessary", "followLink:necessary"],
  },
  passkey: {
    fromNothing: ["requestChallenge", "signChallenge", "verifyAssertion"],
    components: ["signChallenge:necessary"],
  },
  federatedSignIn: {
    fromNothing: ["signInAtProvider", "validateAssertion"],
    components: ["signInAtProvider:necessary"],
  },
  mutualTls: { fromNothing: ["handshake"], components: [] },
};

for (const [name, family] of Object.entries(catalog)) {
  const ceremony = family as unknown as Ceremony;
  test(`${name}: every property holds against every allowed environment`, () => {
    const result = check(ceremony, { invalidations: 1 });
    assert.equal(result.complete, true);
    assert.equal(result.bounds.faultDepth, null);
    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.operatorsUnused, []);
    assert.deepEqual(result.outcomesUnseen, []);
  });

  test(`${name}: the steps and the interfaces are the ones derived`, () => {
    const derived = derive(ceremony);
    // "Nothing" still includes what the host configures.
    const configured = Object.entries(ceremony.facts)
      .filter(([, declared]) => declared.given)
      .map(([fact]) => fact);
    assert.deepEqual(
      {
        fromNothing: cooperate(ceremony, configured).acts,
        components: derived.components.map(
          (component) => `${component.operator}:${component.need}`,
        ),
      },
      expected[name as keyof typeof catalog],
    );
  });
}

test("refreshing is preferred to asking the person again, and a refused refresh falls back to consent", () => {
  const ceremony = catalog.oauthAuthorizationCode as unknown as Ceremony;
  const withRefresh = cooperate(ceremony, ["client", "refreshToken"]);
  assert.deepEqual(withRefresh.acts, ["refresh"]);

  const result = check(ceremony, {
    invalidations: 1,
    worlds: [["client", "refreshToken"]],
  });
  assert.deepEqual(result.violations, []);
  assert.ok(result.endings.some((ending) => ending.key === "success"));
  assert.ok(result.operatorsUsed.includes("authorize"));
});

test("GitHub user access holds for every combination of up to three faults", () => {
  const result = check(githubUserAccess as unknown as Ceremony, {
    invalidations: 2,
    faultDepth: 3,
  });
  assert.equal(result.complete, true);
  assert.equal(result.bounds.faultDepth, 3);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(
    derive(githubUserAccess as unknown as Ceremony, {
      faultDepth: 2,
    }).components.map((component) => `${component.operator}:${component.need}`),
    [
      "chooseTarget:necessary",
      "registerApp:necessary",
      "authorizeUser:necessary",
      "authorizeUserByDevice:contingent",
    ],
  );
});

test("two ways to a session compose into a fallback, and the composite still holds", () => {
  const either = compose(
    { id: "passkey-or-password", title: "Sign in", goal: ["session"] },
    catalog.passkey,
    catalog.passwordSignIn,
  ) as unknown as Ceremony;

  const run = cooperate(either, []);
  assert.deepEqual(run.acts, [
    "requestChallenge",
    "signChallenge",
    "verifyAssertion",
  ]);

  const result = check(either, { invalidations: 1, faultDepth: 3 });
  assert.equal(result.complete, true);
  assert.deepEqual(result.violations, []);
  const fallback = result.endings.find((ending) => ending.key === "success");
  assert.ok(fallback);
  assert.ok(result.operatorsUsed.includes("enterPassword"));
  assert.deepEqual(
    derive(either, { faultDepth: 2 }).components.map(
      (component) => `${component.operator}:${component.need}`,
    ),
    [
      "signChallenge:necessary",
      "enterPassword:contingent",
      "enterOneTimeCode:contingent",
    ],
  );
});

test("parts that disagree about a shared fact do not compose", () => {
  assert.throws(
    () =>
      compose(
        { id: "clash", title: "clash", goal: ["accessToken"] },
        catalog.oauthClientCredentials,
        {
          ...catalog.oauthTokenExchange,
          facts: {
            ...catalog.oauthTokenExchange.facts,
            accessToken: {
              ...catalog.oauthTokenExchange.facts.accessToken,
              secret: false,
            },
          },
        },
      ),
    /declare it differently/,
  );
});
