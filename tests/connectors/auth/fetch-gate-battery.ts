/*
 * The independent review's battery, kept as data: twenty sources it fed the
 * gate (eighteen it must refuse, among them the nine that passed the text
 * gate, and two it must accept), and seven hand reads of a body that Part B
 * must count. Served from memory beside the real sources, as the fixtures are.
 */

const HEAD = `import * as oauth from "oauth4webapi";
import { requestOptions } from "./auth/wire.js";
import { boundResponse } from "./auth/response-bound.js";
`;

export const battery: Array<[string, string, string?]> = [
  [
    "SHADOW: options parameter shadowed by a bounded const of the same name in another scope",
    `${HEAD}
function a(x) { const opts = requestOptions(x); return opts; }
export async function b(as, client, auth, token, opts) {
  return oauth.refreshTokenGrantRequest(as, client, auth, token, opts);
}`,
  ],
  [
    "SHADOW: custom fetch parameter shadowed by a bounded const named the same",
    `${HEAD}
import { wireFetch } from "./auth/wire.js";
function a(x) { const f = wireFetch(x); return f; }
export async function b(as, client, auth, token, f) {
  return oauth.refreshTokenGrantRequest(as, client, auth, token, { [oauth.customFetch]: f });
}`,
  ],
  [
    "HELPER READS FIRST: a helper drains a clone, then boundResponse(r)",
    `${HEAD}
const drain = async (r) => { await r.arrayBuffer(); };
await oauth.refreshTokenGrantRequest(as, client, auth, token, {
  [oauth.customFetch]: async (url, init) => {
    const r = await fetch(url, init);
    await drain(r.clone());
    return boundResponse(r);
  },
});`,
  ],
  [
    "ELEMENT-ACCESS READ: r.clone()['arrayBuffer']() then boundResponse(r)",
    `${HEAD}
await oauth.refreshTokenGrantRequest(as, client, auth, token, {
  [oauth.customFetch]: async (url, init) => {
    const r = await fetch(url, init);
    await r.clone()["arrayBuffer"]();
    return boundResponse(r);
  },
});`,
  ],
  [
    "REBUILD HELPER: boundResponse(await rebuild(r)) where rebuild reads whole body into new Response",
    `${HEAD}
const rebuild = async (r) => new Response(await r.arrayBuffer());
await oauth.refreshTokenGrantRequest(as, client, auth, token, {
  [oauth.customFetch]: async (url, init) => boundResponse(await rebuild(await fetch(url, init))),
});`,
  ],
  [
    "CEILING RAISED: boundResponse(r, Number.MAX_SAFE_INTEGER)",
    `${HEAD}
await oauth.refreshTokenGrantRequest(as, client, auth, token, {
  [oauth.customFetch]: async (url, init) => boundResponse(await fetch(url, init), Number.MAX_SAFE_INTEGER),
});`,
  ],
  [
    "CEILING RAISED: requestOptions({ fetch, maxResponseBytes: 1e12 })",
    `${HEAD}
await oauth.refreshTokenGrantRequest(as, client, auth, token, requestOptions({ fetch, maxResponseBytes: 1e12 }));`,
  ],
  [
    "DYNAMIC IMPORT with a computed specifier",
    `const name = "oauth4" + "webapi";
const oauth = await import(name);
await oauth.refreshTokenGrantRequest(as, client, auth, token);`,
  ],
  [
    "createRequire",
    `import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const oauth = req("oauth4webapi");
await oauth.refreshTokenGrantRequest(as, client, auth, token);`,
  ],
  [
    "GETTER customFetch",
    `${HEAD}
await oauth.refreshTokenGrantRequest(as, client, auth, token, { get [oauth.customFetch]() { return (u, i) => fetch(u, i); } });`,
  ],
  [
    "CLASS FIELD customFetch",
    `${HEAD}
class O { [oauth.customFetch] = (u, i) => fetch(u, i); }
await oauth.refreshTokenGrantRequest(as, client, auth, token, new O());`,
  ],
  [
    "Object.assign of a second options object",
    `${HEAD}
const o = requestOptions({ fetch });
Object.assign(o, { [oauth.customFetch]: (u, i) => fetch(u, i) });
await oauth.refreshTokenGrantRequest(as, client, auth, token, o);`,
  ],
  [
    "Object.defineProperty with the symbol",
    `${HEAD}
const o = requestOptions({ fetch });
Object.defineProperty(o, oauth.customFetch, { value: (u, i) => fetch(u, i) });
await oauth.refreshTokenGrantRequest(as, client, auth, token, o);`,
  ],
  [
    "default import",
    `import oauth from "oauth4webapi";
await oauth.refreshTokenGrantRequest(as, client, auth, token);`,
  ],
  [
    "import * as o; passed to a function",
    `import * as o from "oauth4webapi";
use(o);`,
  ],
  ["await import() literal", `const o = await import("oauth4webapi");`],
  [
    "optional call",
    `import * as o from "oauth4webapi";
await o.refreshTokenGrantRequest?.(as, client, auth, token);`,
  ],
  [
    "destructured parameter: const { refreshTokenGrantRequest } = oauth",
    `import * as oauth from "oauth4webapi";
const { refreshTokenGrantRequest } = oauth;
await refreshTokenGrantRequest(as, client, auth, token);`,
  ],
  [
    "bounded fetch wrapped in an unbounded fetch: customFetch: (u,i) => boundedLater(u,i) where inner fn returns raw",
    `${HEAD}
import { wireFetch } from "./auth/wire.js";
const inner = wireFetch({ fetch });
await oauth.refreshTokenGrantRequest(as, client, auth, token, { [oauth.customFetch]: async (u, i) => { const r = await inner(u, i); return r; } });`,
  ],
  [
    "ACCEPT control: the legitimate shape",
    `${HEAD}
await oauth.refreshTokenGrantRequest(as, client, auth, token, requestOptions({ fetch }));`,
  ],
];

/** The two battery sources the gate must accept: an answer from a bounded fetch returned as is, and the legitimate shape. */
export const batteryAccepted = new Set([
  "bounded fetch wrapped in an unbounded fetch: customFetch: (u,i) => boundedLater(u,i) where inner fn returns raw",
  "ACCEPT control: the legitimate shape",
]);

export const batteryReads: Array<[string, string]> = [
  [
    "PART B: response['json']()",
    `export const x = async (r) => (await fetch(r))["json"]();`,
  ],
  [
    "PART B: getReader loop with no ceiling",
    `export const x = async (r) => { const rd = (await fetch(r)).body!.getReader(); const c = []; for (;;) { const { done, value } = await rd.read(); if (done) break; c.push(value); } return c; }`,
  ],
  [
    "PART B: stream consumers text(body)",
    `import { text } from "node:stream/consumers"; export const x = async (r) => text((await fetch(r)).body as any);`,
  ],
  [
    "PART B: for await over body",
    `export const x = async (r) => { let n = 0; for await (const c of (await fetch(r)).body as any) n += c.length; return n; }`,
  ],
  [
    "PART B: new Response(res.body).text()",
    `export const x = async (r) => new Response((await fetch(r)).body).text();`,
  ],
  [
    "PART B: res.json.call(res)",
    `export const x = async (r) => { const res = await fetch(r); return res.json.call(res); }`,
  ],
  [
    "PART B control: res.json()",
    `export const x = async (r) => (await fetch(r)).json();`,
  ],
];
