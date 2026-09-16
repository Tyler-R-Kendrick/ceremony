import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  disambiguateProvider,
  providerCatalog,
} from "../src/core/connector-authoring.js";

// The public catalog permits keys and display names to differ. Synthetic entries
// also exercise ambiguity without depending on today's built-in provider names.
function addProviders(t: TestContext, entries: Record<string, string>) {
  for (const [key, name] of Object.entries(entries)) {
    assert.equal(Object.hasOwn(providerCatalog, key), false);
    providerCatalog[key] = {
      name,
      description: "Synthetic provider-resolution fixture.",
      methods: ["oauth-code"],
      origins: ["https://provider.example"],
    };
    t.after(() => {
      delete providerCatalog[key];
    });
  }
}

test("provider aliases preserve the query and need no alternatives", () => {
  for (const [query, resolved] of [
    ["gh", "github"],
    [" GHE ", "github"],
    ["goog", "google"],
  ]) {
    assert.deepEqual(disambiguateProvider(query!), {
      query,
      resolved,
      confidence: "high",
      alternatives: [],
    });
  }
});

test("exact provider keys take precedence over a known first token", (t) => {
  addProviders(t, { "github-enterprise": "GitHub Enterprise" });
  for (const [query, resolved] of [
    ["GitHub", "github"],
    ["GitHub Enterprise", "github-enterprise"],
  ]) {
    assert.deepEqual(disambiguateProvider(query!), {
      query,
      resolved,
      confidence: "high",
      alternatives: [],
    });
  }
});

test("a known provider family accepts an otherwise unknown qualifier", () => {
  const query = "Jira Cloud";
  assert.deepEqual(disambiguateProvider(query), {
    query,
    resolved: "jira",
    confidence: "high",
    alternatives: [],
  });
});

test("one-edit corrections include insertions deletions and substitutions", () => {
  for (const [query, resolved] of [
    ["githb", "github"],
    ["githubb", "github"],
    ["neom", "neon"],
    ["slac", "slack"],
  ]) {
    assert.deepEqual(disambiguateProvider(query!), {
      query,
      resolved,
      confidence: "high",
      alternatives: [],
    });
  }
});

test("short or two-edit names suggest a provider without silently choosing it", () => {
  for (const [query, alternative] of [
    ["jir", "jira"],
    ["gihb", "github"],
  ]) {
    assert.deepEqual(disambiguateProvider(query!), {
      query,
      resolved: query,
      confidence: "low",
      alternatives: [alternative],
    });
  }
});

test("missing and distant names preserve a trimmed fallback without suggestions", () => {
  for (const [query, resolved] of [
    ["", ""],
    ["   ", ""],
    ["  !!!  ", "!!!"],
    ["Unrecognized Provider", "unrecognized-provider"],
  ]) {
    assert.deepEqual(disambiguateProvider(query!), {
      query,
      resolved,
      confidence: "low",
      alternatives: [],
    });
  }
});

for (const [query, resolved] of [
  ["constructor", "constructor"],
  ["constructor-cloud", "constructor-cloud"],
  ["toString", "tostring"],
]) {
  test(`prototype member ${query} is not a provider alias or catalog family`, () => {
    assert.deepEqual(disambiguateProvider(query!), {
      query,
      resolved,
      confidence: "low",
      alternatives: [],
    });
  });
}

test("tied closest providers stay unresolved with only the three nearest alternatives", (t) => {
  // Insert a distance-two entry first: insertion order must not outrank distance.
  addProviders(t, {
    quarxx: "Quarxx",
    quarts: "Quarts",
    quarxy: "Quarxy",
    quartx: "Quartx",
  });
  assert.deepEqual(disambiguateProvider("quartz"), {
    query: "quartz",
    resolved: "quartz",
    confidence: "low",
    alternatives: ["quarts", "quartx", "quarxx"],
  });
});

test("fuzzy resolution accepts either the catalog key or its distinct display name", (t) => {
  addProviders(t, { northstar: "Copper Cloud" });
  for (const query of ["northstr", "copper-clod"]) {
    assert.deepEqual(disambiguateProvider(query), {
      query,
      resolved: "northstar",
      confidence: "high",
      alternatives: [],
    });
  }
});
