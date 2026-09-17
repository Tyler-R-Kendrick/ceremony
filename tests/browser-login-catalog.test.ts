import assert from "node:assert/strict";
import test from "node:test";
import {
  admittedCatalogOrigin,
  browserLoginCatalog,
  catalogProfileSchema,
  catalogSequenceSchema,
  catalogOriginSchema,
  browserLoginCatalogSchema,
  executableProfile,
} from "../src/browser-login/catalog.js";

test("catalog is bundled, fixture-only for execution, and discovery-only for live providers", () => {
  assert.equal(browserLoginCatalog.length, 4);
  for (const profile of browserLoginCatalog) {
    assert.equal(
      catalogProfileSchema.safeParse(profile).success,
      true,
      profile.id,
    );
    if (profile.executable)
      assert.equal(profile.discoveryOnly, false, profile.id);
    if (profile.discoveryOnly)
      assert.equal(profile.executable, false, profile.id);
  }
});

test("only the owned fixture profile is executable at loopback origins", () => {
  const fixtureOrigin = "http://127.0.0.1:4919";
  assert.equal(executableProfile("github-login"), undefined);
  assert.equal(executableProfile("nonexistent"), undefined);
  assert.equal(
    executableProfile("owned-fixture-login")?.fixtureOrigin,
    "http://127.0.0.1",
  );
  assert.equal(
    admittedCatalogOrigin(
      "owned-fixture-login",
      `${fixtureOrigin}/login`,
      fixtureOrigin,
    ),
    fixtureOrigin,
  );
  assert.throws(() =>
    admittedCatalogOrigin("github-login", "https://github.com/login"),
  );
  assert.throws(() =>
    admittedCatalogOrigin("owned-fixture-login", "https://github.com/login"),
  );
  assert.throws(() => admittedCatalogOrigin("nonexistent", fixtureOrigin));
});

test("fixture alternatives never combine both credential paths", () => {
  const fixture = executableProfile("owned-fixture-login")!;
  assert.deepEqual(fixture.sequences, [
    ["combined", "verification"],
    ["identifier", "password", "verification"],
  ]);
  assert.deepEqual(fixture.steps, fixture.sequences[0]);
});

test("fixture admission requires a separately captured run-start origin", () => {
  assert.throws(() =>
    admittedCatalogOrigin("owned-fixture-login", "http://127.0.0.1:4919"),
  );
});

const fixtureId = "owned-fixture-login";
const fixture = executableProfile(fixtureId)!;
const origin = "http://127.0.0.1:4919";

test("discovery metadata declares exact provider origins without execution claims", () => {
  const expected = [
    ["github-login", "https://github.com", "https://github.com/login"],
    [
      "google-login",
      "https://accounts.google.com",
      "https://accounts.google.com/ServiceLogin",
    ],
    [
      "microsoft-login",
      "https://login.microsoftonline.com",
      "https://login.microsoftonline.com/",
    ],
  ];
  for (const [id, declared, entry] of expected) {
    const profile = browserLoginCatalog.find((p) => p.id === id)!;
    assert.deepEqual(profile.declaredOrigins, [declared]);
    assert.equal(profile.entry, entry);
    assert.equal(profile.validation, "pending-validation");
    assert.deepEqual(profile.verification, { strategy: "unvalidated" });
    assert.deepEqual(profile.sequences, []);
    assert.deepEqual(profile.steps, []);
    assert.deepEqual(profile.allowedFrameOrigins, []);
    assert.equal(profile.maxSubmissions, 0);
    assert.equal("evidence" in profile, false);
    assert.equal(executableProfile(id!, origin), undefined);
    assert.throws(
      () => admittedCatalogOrigin(id!, entry!, origin),
      /not executable/,
    );
  }
});

test("run binding is immutable, independent, and checks full origin including port and scheme", () => {
  const bound = executableProfile(fixtureId, origin)!;
  assert.equal(bound.fixtureOrigin, origin);
  assert.equal(bound.entry, `${origin}/login`);
  assert.deepEqual(bound.declaredOrigins, [origin]);
  assert.equal(
    executableProfile(fixtureId, "http://127.0.0.1:4920")!.fixtureOrigin,
    "http://127.0.0.1:4920",
  );
  assert.equal(fixture.fixtureOrigin, "http://127.0.0.1");
  assert.equal(
    admittedCatalogOrigin(fixtureId, `${origin}/account?view=1`, origin),
    origin,
  );
  for (const value of [
    "http://127.0.0.1:4920/login",
    "https://127.0.0.1:4919/login",
    "http://127.0.0.1/login",
    "http://localhost:4919/login",
    "http://127.0.0.2:4919/login",
    "https://github.com/login",
    "http://127.0.0.1.evil.test:4919/login",
    "http://user:pass@127.0.0.1:4919/login",
    ` ${origin}/login`,
    `${origin}/lo\ngin`,
    "not a URL",
  ])
    assert.throws(() => admittedCatalogOrigin(fixtureId, value, origin), value);
  assert.throws(
    () => admittedCatalogOrigin("missing", origin, origin),
    /not executable/,
  );
});

test("run start accepts canonical HTTP loopback origins only, never page URLs or aliases", () => {
  for (const value of [
    "http://127.0.0.1:0",
    `${origin}/`,
    `${origin}/login`,
    `${origin}?q=1`,
    `${origin}#fragment`,
    "http://localhost:4919",
    "http://[::1]:4919",
    "http://127.1:4919",
    "http://2130706433:4919",
    "http://127.0.0.1:04919",
    "https://127.0.0.1:4919",
    "https://github.com",
    "http://127.0.0.1:65536",
    "http://user@127.0.0.1:4919",
    "",
    "not a URL",
  ])
    assert.throws(() => executableProfile(fixtureId, value), value);
});

test("sequences reject partial, reordered, repeated, and concatenated alternatives", () => {
  for (const sequence of [
    [],
    ["identifier"],
    ["password", "verification"],
    ["combined"],
    ["verification"],
    ["verification", "combined"],
    ["password", "identifier", "verification"],
    ["combined", "identifier", "password", "verification"],
    ["identifier", "verification"],
    ["combined", "verification", "verification"],
    ["identifier", "password", "password", "verification"],
  ])
    assert.equal(
      catalogSequenceSchema.safeParse(sequence).success,
      false,
      JSON.stringify(sequence),
    );
});

test("schema enforces budgets, modes, verification, origin declarations, and unique alternatives", () => {
  for (const patch of [
    { executable: false },
    { discoveryOnly: true },
    { validation: "pending-validation" },
    { originBinding: "exact" },
    { fixtureOrigin: undefined },
    { fixtureOrigin: "bad" },
    { fixtureOrigin: "http://127.0.0.1:0" },
    { entry: "bad" },
    { entry: "https://github.com/login" },
    { entry: "http://127.0.0.1/login?q=1" },
    { entry: "http://127.0.0.1/login#fragment" },
    { declaredOrigins: [] },
    { declaredOrigins: ["http://127.0.0.1", "https://github.com"] },
    { allowedFrameOrigins: ["https://github.com"] },
    { sequences: [] },
    { sequences: [fixture.sequences[0], fixture.sequences[0]] },
    { steps: ["identifier", "password", "verification"] },
    { maxSubmissions: 0 },
    { maxSubmissions: 1 },
    { maxSubmissions: 3 },
    { maxSubmissions: 1.5 },
    { maxSubmissions: NaN },
    { verification: { strategy: "unvalidated" } },
    {
      verification: {
        strategy: "fixture-account",
        path: "//evil.test/account",
      },
    },
    { evidence: "Unproven claim" },
  ])
    assert.equal(
      catalogProfileSchema.safeParse({ ...fixture, ...patch }).success,
      false,
      JSON.stringify(patch),
    );
  assert.equal(
    catalogProfileSchema.safeParse({
      ...fixture,
      sequences: [fixture.sequences[0]],
      maxSubmissions: 1,
    }).success,
    true,
  );
  assert.equal(
    browserLoginCatalogSchema.safeParse([fixture, fixture]).success,
    false,
  );
});

test("parsed catalog metadata is deeply frozen and detached from input", () => {
  const input = JSON.parse(JSON.stringify(fixture));
  const parsed = catalogProfileSchema.parse(input);
  input.sequences[0][0] = "password";
  assert.equal(parsed.sequences[0]![0], "combined");
  for (const value of [
    browserLoginCatalog,
    parsed,
    parsed.sequences,
    ...parsed.sequences,
    parsed.steps,
    parsed.declaredOrigins,
    parsed.allowedFrameOrigins,
    parsed.verification,
  ]) {
    assert.equal(Object.isFrozen(value), true);
    assert.throws(() =>
      Object.defineProperty(value, "injected", { value: true }),
    );
  }
});

test("exact origin declarations and discovery-only invariants fail closed", () => {
  for (const value of [
    "https://github.com/",
    "https://*.github.com",
    "https://GITHUB.com",
    "https://github.com:443",
    "https://user@github.com",
    "http://github.com",
    "https://github.com/login",
    "https://github.com?",
    "https://github.com#",
    "bad",
  ]) {
    // Wildcards may parse as hostnames but are not exact declarations.
    assert.equal(catalogOriginSchema.safeParse(value).success, false, value);
  }
  const discovery = browserLoginCatalog.find((p) => p.id === "github-login")!;
  for (const patch of [
    { executable: true, discoveryOnly: false },
    { discoveryOnly: false },
    { validation: "fixture-only" },
    { originBinding: "run-start-loopback" },
    { fixtureOrigin: "http://127.0.0.1" },
    { maxSubmissions: 1 },
    {
      sequences: [["combined", "verification"]],
      steps: ["combined", "verification"],
    },
    { verification: { strategy: "fixture-account", path: "/account" } },
    { allowedFrameOrigins: ["https://github.com"] },
    { declaredOrigins: ["https://github.com", "https://github.com"] },
    { steps: ["identifier"] },
  ])
    assert.equal(
      catalogProfileSchema.safeParse({ ...discovery, ...patch }).success,
      false,
      JSON.stringify(patch),
    );
});
