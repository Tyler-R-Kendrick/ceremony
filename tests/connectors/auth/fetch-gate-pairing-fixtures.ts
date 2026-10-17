import type { Refused } from "./fetch-gate-fixtures.js";

/*
 * Sources for the pairing rule (fetch-gate-pairing.ts): one production module
 * with one bounded site, and test files that do or do not serve it an endless
 * body by name. Each test file is judged against that module alone.
 */

export const pairingSite = "src/server/connectors/gate-pairing-site.ts";
export const pairingPath = (n: number) =>
  `tests/connectors/gate-pairing-${n}.test.ts`;

export const pairingModules: Record<string, string> = {
  [pairingSite]: `import { readBoundedBytes } from "../../core/bounded-body.js";
export async function pairedRead(u: string) {
  return readBoundedBytes(await fetch(u), 65536, () => new Error("too large"));
}`,
};

const SITE = `${pairingSite}#pairedRead`;
const DOUBLE = `import assert from "node:assert/strict";
import test from "node:test";
import { assertReadUnder, endlessBody, endlessFetch, endlessResponse, type Pulled, type Sites } from "./doubles/endless-body.js";
declare const seen: Pulled;
declare const other: Pulled;
void endlessBody;
void test;
`;
const ASSERTS = 'assertReadUnder(assert, seen, 65536, "paired");';

export const pairingRefused: Refused[] = [
  {
    name: "a bounded site no test serves an endless body to",
    expect:
      /gate-pairing-site\.ts#pairedRead: no test serves it an endless body/,
    source: `${DOUBLE}// Named in a string, but nothing is served to it.
export const site = "${SITE}";
export const serve = () => [endlessFetch, endlessResponse];`,
  },
  {
    name: "a test naming a site that is not a bounded site",
    expect:
      /names src\/server\/connectors\/gate-pairing-site\.ts#elsewhere, which is not a bounded site/,
    source: `${DOUBLE}export const serve = () => endlessFetch(seen, ["${SITE}", "${pairingSite}#elsewhere"]);
export const check = () => ${ASSERTS}`,
  },
  {
    name: "sites named in a form the gate cannot read",
    expect: /form the gate cannot read/,
    source: `${DOUBLE}declare const sites: Sites;
export const serve = () => [endlessFetch(seen, ["${SITE}"]), endlessResponse(seen, sites)];
export const check = () => ${ASSERTS}`,
  },
  {
    name: "a site named to something that is not the endless-body double",
    expect:
      /gate-pairing-site\.ts#pairedRead: no test serves it an endless body/,
    source: `const endlessFetch = (served: unknown, sites: string[]) => [served, sites];
export const serve = () => endlessFetch({ pulled: 0 }, ["${SITE}"]);`,
  },
  {
    name: "a wrapper around the double that one caller names no sites to",
    expect: /form the gate cannot read/,
    source: `${DOUBLE}declare const unread: Sites;
const serve = (sites: Sites) => endlessFetch(seen, sites);
export const named = serve(["${SITE}"]);
export const unnamed = serve(unread);
export const check = () => ${ASSERTS}`,
  },
  {
    name: "an endless answer that is served and thrown away",
    expect: /discards the endless answer it serves/,
    source: `${DOUBLE}export const run = () => {
  endlessFetch(seen, ["${SITE}"]);
  ${ASSERTS}
};`,
  },
  {
    name: "an endless answer held in a variable nothing uses",
    expect: /in a variable nothing uses/,
    source: `${DOUBLE}export const run = () => {
  const served = endlessFetch(seen, ["${SITE}"]);
  ${ASSERTS}
};`,
  },
  {
    name: "a counter that is served and never asserted on",
    expect: /counter never reaches assertReadUnder/,
    source: `${DOUBLE}export const serve = () => endlessFetch(seen, ["${SITE}"]);`,
  },
  {
    name: "a counter that is served and another counter asserted on",
    expect: /counter never reaches assertReadUnder/,
    source: `${DOUBLE}export const serve = () => endlessFetch(seen, ["${SITE}"]);
export const check = () => assertReadUnder(assert, other, 65536, "paired");`,
  },
  {
    name: "an assertion in a branch that never runs",
    expect: /counter never reaches assertReadUnder/,
    source: `${DOUBLE}export const run = () => {
  const served = endlessFetch(seen, ["${SITE}"]);
  if (false) ${ASSERTS}
  return served;
};`,
  },
  {
    name: "an assertion made by a wrapper that only a skipped test calls",
    expect: /counter never reaches assertReadUnder/,
    source: `${DOUBLE}const bounded = (counter: Pulled) => assertReadUnder(assert, counter, 65536, "paired");
test.skip("paired", () => bounded(seen));
export const serve = () => endlessFetch(seen, ["${SITE}"]);`,
  },
  {
    name: "a serve in a branch that never runs",
    expect: /in a branch that never runs/,
    source: `${DOUBLE}export const run = () => {
  if (false) return endlessFetch(seen, ["${SITE}"]);
  ${ASSERTS}
};`,
  },
  {
    name: "a serve behind a condition that is always false",
    expect: /in a branch that never runs/,
    source: `${DOUBLE}export const run = () => {
  const served = 0 && endlessFetch(seen, ["${SITE}"]);
  ${ASSERTS}
  return served;
};`,
  },
  {
    name: "a serve after a return",
    expect: /where it never runs/,
    source: `${DOUBLE}export const run = () => {
  ${ASSERTS}
  return 1;
  return endlessFetch(seen, ["${SITE}"]);
};`,
  },
  {
    name: "a serve in a test that is skipped",
    expect: /in a test that is skipped/,
    source: `${DOUBLE}test.skip("paired", () => {
  const served = endlessFetch(seen, ["${SITE}"]);
  ${ASSERTS}
  return served;
});`,
  },
  {
    name: "a serve in a test marked todo by its options",
    expect: /in a test that is skipped/,
    source: `${DOUBLE}test("paired", { todo: true }, () => {
  const served = endlessFetch(seen, ["${SITE}"]);
  ${ASSERTS}
  return served;
});`,
  },
  {
    name: "a serve in a test skipped by its options",
    expect: /in a test that is skipped/,
    source: `${DOUBLE}test("paired", { skip: "later" }, () => {
  const served = endlessFetch(seen, ["${SITE}"]);
  ${ASSERTS}
  return served;
});`,
  },
];

export const pairingAccepted: Array<{ name: string; source: string }> = [
  {
    name: "a bounded site a test serves an endless body to, by name, and asserts on",
    source: `${DOUBLE}export const serve = () => endlessFetch(seen, ["${SITE}"]);
export const check = () => ${ASSERTS}`,
  },
  {
    name: "a bounded site named through a wrapper around the double, in a parameter",
    source: `${DOUBLE}const serve = (sites: Sites, status = 200) => endlessFetch(seen, sites, status);
export const answer = () => serve(["${SITE}"], 201);
export const check = () => ${ASSERTS}`,
  },
  {
    name: "a bounded site named through a const list, by the response double",
    source: `${DOUBLE}const SITES = ["${SITE}"] as const;
export const serve = () => endlessResponse(seen, SITES);
export const check = () => ${ASSERTS}`,
  },
  {
    name: "an answer held in a const that is used, in a test that runs",
    source: `${DOUBLE}test("paired", { skip: false }, () => {
  const served = endlessFetch(seen, ["${SITE}"]);
  ${ASSERTS}
  return served;
});`,
  },
  {
    name: "a counter passed through wrappers on both sides",
    source: `${DOUBLE}const serve = (counter: Pulled, sites: Sites) => endlessFetch(counter, sites);
const bounded = (counter: Pulled, what: string) => assertReadUnder(assert, counter, 65536, what);
export const run = () => [serve(seen, ["${SITE}"]), bounded(seen, "paired")];`,
  },
  {
    name: "a counter held in an object a function returns, asserted on through it",
    source: `${DOUBLE}const rig = () => {
  const state = { pulled: 0 };
  return { state, fetch: endlessFetch(state, ["${SITE}"]) };
};
export const run = () => {
  const { state, fetch } = rig();
  assertReadUnder(assert, state, 65536, "paired");
  return fetch;
};`,
  },
];
