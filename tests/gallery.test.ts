import assert from "node:assert/strict";
import test from "node:test";
import { flowKinds, snapshotSchema } from "../src/core/schema.js";
import {
  carrierFor,
  catalogue,
  journeys,
  specimen,
  walls,
} from "../scripts/gallery-data.js";
import { authScenarios } from "./doubles/auth-provider/scenarios.js";

/**
 * The published catalogue is generated, not written, and these are the claims
 * that generation has to keep true. A gallery is worth exactly as much as its
 * agreement with the thing it depicts.
 */

test("every scenario the doubles drive reaches the published catalogue", () => {
  const published = catalogue();
  assert.equal(published.length, authScenarios.length);
  assert.deepEqual(
    published.map((entry) => entry.id).sort(),
    authScenarios.map((scenario) => scenario.id).sort(),
  );
});

test("every scenario states an outcome the page can print", () => {
  // "unstated" is the fallback for an expectation shape this reducer does not
  // understand. One appearing means the scenario format moved and the page is
  // quietly printing less than it used to.
  for (const entry of catalogue())
    assert.notEqual(entry.outcome, "unstated", `${entry.id} has no outcome`);
});

test("every flow kind is shown, and shown as a sequence it really walks", () => {
  for (const kind of flowKinds) {
    const steps = journeys[kind];
    assert.ok(steps?.length, `${kind} has no journey`);
    // Every flow starts by saying what is about to happen and ends completed;
    // a journey that skipped either would be depicting a different product.
    assert.equal(steps[0], "intro", `${kind} does not start at intro`);
    assert.equal(steps.at(-1), "complete", `${kind} does not end complete`);
    assert.equal(new Set(steps).size, steps.length, `${kind} repeats a screen`);
  }
});

test("every flow kind is carried by a connector this project really ships", () => {
  for (const kind of flowKinds) {
    const { manifest, method } = carrierFor(kind);
    assert.equal(method.kind, kind);
    assert.ok(manifest.methods.includes(method));
  }
});

test("every screen on the page is one the production schema accepts", () => {
  for (const kind of flowKinds)
    for (const step of journeys[kind]) {
      const snapshot = specimen(kind, step);
      // specimen() parses on the way out; re-parsing proves the value it
      // returned is still acceptable rather than merely having been built.
      assert.deepEqual(snapshotSchema.parse(snapshot), snapshot);
      assert.equal(snapshot.step, step);
      assert.equal(snapshot.method.kind, kind);
    }
  for (const step of walls) assert.equal(specimen("form", step).step, step);
});

test("a redirect carries somewhere to go and a wait carries a code", () => {
  // The screens differ in what they must show, and a specimen missing that
  // field would render an empty screen that looks like a styling bug.
  assert.ok(specimen("oauth-code", "redirect").authorizationUrl);
  assert.ok(specimen("device", "waiting").userCode);
  assert.ok(specimen("api-key", "complete").outcome);
  assert.ok(specimen("form", "error").message);
});

test("anonymous access completes owned by nobody, and can still be claimed", () => {
  assert.equal(
    specimen("authmd-anonymous", "complete").outcome?.ownership,
    "anonymous",
  );
  assert.ok(journeys["authmd-anonymous"].includes("claim"));
  // No other flow has anything to claim.
  for (const kind of flowKinds)
    if (kind !== "authmd-anonymous")
      assert.ok(!journeys[kind].includes("claim"), `${kind} claims ownership`);
});

test("the registration variants the catalogue documents are all published", () => {
  const registration = catalogue().filter(
    (entry) => entry.goal === "registration",
  );
  assert.equal(
    registration.length,
    authScenarios.filter((scenario) => scenario.goal === "registration").length,
  );
  // More than one flow kind creates accounts, which is the point of grouping
  // by goal rather than by mechanism.
  assert.ok(
    new Set(registration.map((entry) => entry.flowKind)).size > 1,
    "registration should span more than one flow kind",
  );
  // A variant nobody can act on is not a variant.
  for (const entry of registration)
    assert.ok(entry.provides.length, `${entry.id} asks for nothing`);
});
