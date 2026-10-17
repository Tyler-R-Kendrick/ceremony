import type { Refused } from "./fetch-gate-fixtures.js";

/*
 * Sources for the rule that follows a function passing a ceiling of its own
 * parameter on to a bounder (fetch-gate-forwards.ts), with
 * `readBoundedBody` (src/server/connectors/bounded-body.ts) as the
 * forwarding helper. Each runs with the helper's own file, the reader it
 * forwards to and the modules below, so the gate sees the helper hand its
 * ceiling on; the finding is reported at the fixture's call.
 *
 * The first is the probe the previous gate gave no finding for: the helper
 * re-exported under another name by a second module and called through that
 * name with 2 ** 40, while the same call by the helper's own name was
 * refused.
 */

export const forwardPath = (n: number) =>
  `src/server/connectors/gate-forward-${n}.ts`;

/** What every fixture here is run with: the helper's file, its reader and the modules below. */
export const forwardContext = [
  "src/server/connectors/bounded-body.ts",
  "src/core/bounded-body.ts",
  "src/server/connectors/gate-forward-relay.ts",
  "src/server/connectors/gate-forward-holder.ts",
];

export const forwardModules: Record<string, string> = {
  "src/server/connectors/gate-forward-relay.ts": `export { readBoundedBody as readBody } from "./bounded-body.js";`,
  "src/server/connectors/gate-forward-holder.ts": `import { readBoundedBody } from "./bounded-body.js";
export const readHeld = readBoundedBody;`,
};

const RAISED = /hands the reader a ceiling of 1099511627776 bytes/;
const VALUE = /takes readBoundedBody as a value/;
const DEFAULT = /exports \w+ as the default/;
const SPREAD = /is called with spread arguments the gate cannot place/;
const COMPUTED = /reads readBoundedBody by a computed name/;

export const forwardRefused: Refused[] = [
  {
    name: "a forwarding helper re-exported under another name by a second module and called through it",
    expect: RAISED,
    source: `import { readBody } from "./gate-forward-relay.js";
export const body = async (u: string) => readBody(await fetch(u), 2 ** 40, "probe.too-large");`,
  },
  {
    name: "a forwarding helper held in a const and called through it",
    expect: RAISED,
    source: `import { readBoundedBody } from "./bounded-body.js";
const read = readBoundedBody;
export const body = async (u: string) => read(await fetch(u), 2 ** 40, "probe.too-large");`,
  },
  {
    name: "a forwarding helper held in a const another module exports",
    expect: RAISED,
    source: `import { readHeld as held } from "./gate-forward-holder.js";
export const body = async (u: string) => held(await fetch(u), 2 ** 40, "probe.too-large");`,
  },
  {
    name: "a forwarding helper held in a let",
    expect: VALUE,
    source: `import { readBoundedBody } from "./bounded-body.js";
let read = readBoundedBody;
export const body = async (u: string) => read(await fetch(u), 2 ** 40, "probe.too-large");`,
  },
  {
    name: "a forwarding helper re-exported as a module's default",
    expect: DEFAULT,
    source: `export { readBoundedBody as default } from "./bounded-body.js";`,
  },
  {
    name: "a forwarding helper exported as a default",
    expect: DEFAULT,
    source: `import { readBoundedBody } from "./bounded-body.js";
export default readBoundedBody;`,
  },
  {
    name: "a forwarding helper held in a const that is exported as a default",
    expect: DEFAULT,
    source: `import { readBoundedBody } from "./bounded-body.js";
const read = readBoundedBody;
export { read as default };`,
  },
  {
    name: "a forwarding helper called with spread arguments",
    expect: SPREAD,
    source: `import { readBoundedBody } from "./bounded-body.js";
export const body = async (u: string) => {
  const args = [await fetch(u), 2 ** 40, "probe.too-large"] as const;
  return readBoundedBody(...args);
};`,
  },
  {
    name: "the reader called with spread arguments",
    expect: SPREAD,
    source: `import { readBoundedBytes } from "../../core/bounded-body.js";
export const body = async (u: string) => {
  const args = [await fetch(u), 2 ** 40, () => new Error("too large")] as const;
  return readBoundedBytes(...args);
};`,
  },
  {
    name: "a forwarding helper called through its module namespace by a computed name",
    expect: COMPUTED,
    source: `import * as bounded from "./bounded-body.js";
export const body = async (u: string) => bounded["readBoundedBody"](await fetch(u), 2 ** 40, "probe.too-large");`,
  },
  {
    name: "a forwarding helper handed on as a value",
    expect: VALUE,
    source: `import { readBoundedBody } from "./bounded-body.js";
export const relay = { read: readBoundedBody };`,
  },
];

export const forwardAccepted: Array<{ name: string; source: string }> = [
  {
    name: "a forwarding helper called through a re-export, a const and a renamed import within its bound",
    source: `import { readBody } from "./gate-forward-relay.js";
import { readHeld as held } from "./gate-forward-holder.js";
import { readBoundedBody } from "./bounded-body.js";
const read = readBoundedBody;
export type Reader = typeof readBoundedBody;
export const body = async (u: string) => [
  await readBody(await fetch(u), 65536, "probe.too-large"),
  await read(await fetch(u), 65536, "probe.too-large"),
  await held(await fetch(u), 65536, "probe.too-large"),
];`,
  },
];
