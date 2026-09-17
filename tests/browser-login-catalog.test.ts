import assert from "node:assert/strict";
import test from "node:test";
import {
  admittedCatalogOrigin,
  browserLoginCatalog,
  catalogProfileSchema,
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
    admittedCatalogOrigin("owned-fixture-login", fixtureOrigin),
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
