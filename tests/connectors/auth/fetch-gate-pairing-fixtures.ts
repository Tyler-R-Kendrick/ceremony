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
const DOUBLE = `import { endlessBody, endlessFetch, endlessResponse, type Sites } from "./doubles/endless-body.js";
declare const seen: { pulled: number };
void endlessBody;
`;

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
    source: `${DOUBLE}export const serve = () => endlessFetch(seen, ["${SITE}", "${pairingSite}#elsewhere"]);`,
  },
  {
    name: "sites named in a form the gate cannot read",
    expect: /form the gate cannot read/,
    source: `${DOUBLE}declare const sites: Sites;
export const serve = () => [endlessFetch(seen, ["${SITE}"]), endlessResponse(seen, sites)];`,
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
export const unnamed = serve(unread);`,
  },
];

export const pairingAccepted: Array<{ name: string; source: string }> = [
  {
    name: "a bounded site a test serves an endless body to, by name",
    source: `${DOUBLE}export const serve = () => endlessFetch(seen, ["${SITE}"]);`,
  },
  {
    name: "a bounded site named through a wrapper around the double, in a parameter",
    source: `${DOUBLE}const serve = (sites: Sites, status = 200) => endlessFetch(seen, sites, status);
export const answer = () => serve(["${SITE}"], 201);`,
  },
  {
    name: "a bounded site named through a const list, by the response double",
    source: `${DOUBLE}const SITES = ["${SITE}"] as const;
export const serve = () => endlessResponse(seen, SITES);`,
  },
];
