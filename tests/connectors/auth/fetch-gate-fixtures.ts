/*
 * Sources the gate has to refuse, one for each rule (so that each rule, on
 * its own, is what fails a test when it is taken out), and sources it has to
 * accept. They are served from memory beside the real sources under
 * `src/server/connectors/`, so their relative imports resolve to the
 * registry's own files and the checker reads them as it reads any source.
 */

export const fixturePath = (n: number) =>
  `src/server/connectors/gate-fixture-${n}.ts`;

const HEAD = `import * as oauth from "oauth4webapi";
import { requestOptions, wireFetch } from "./auth/wire.js";
import { boundResponse } from "./auth/response-bound.js";
declare const as: oauth.AuthorizationServer, client: oauth.Client, auth: oauth.ClientAuth, token: string;
`;
const custom = (body: string) => `${HEAD}
await oauth.refreshTokenGrantRequest(as, client, auth, token, {
  [oauth.customFetch]: ${body},
});`;

export type Refused = { name: string; source: string; expect: RegExp };
const UNBOUNDED = /does not read its answer under the ceiling/;
const OPTIONS = /do not resolve to the bounded transport/;

export const refused: Refused[] = [
  // The custom fetch's own body.
  {
    name: "the body is read before the answer is bounded (reads)",
    expect: UNBOUNDED,
    source: custom(
      `async (url, init) => { const other = await fetch(url, init); await other.text(); return boundResponse(await fetch(url, init)); }`,
    ),
  },
  {
    name: "an answer is built from bytes (new Response)",
    expect: UNBOUNDED,
    source: custom(
      `async (url, init) => { const r = await fetch(url, init); new Response(r.body); return boundResponse(r); }`,
    ),
  },
  {
    name: "the answer is handed to a helper first",
    expect: UNBOUNDED,
    source: `${custom(`async (url, init) => { const r = await fetch(url, init); await inspect(r); return boundResponse(r); }`)}
declare function inspect(r: Response): Promise<void>;`,
  },
  {
    name: "the bounder is given something that is not an unread answer (unread)",
    expect: UNBOUNDED,
    source: `${custom(`async (url, init) => boundResponse(cached(url))`)}
declare function cached(url: string): Response;`,
  },
  {
    name: "a branch of the custom fetch returns the answer raw",
    expect: UNBOUNDED,
    source: custom(
      `async (url, init) => { const r = await fetch(url, init); if (r.status === 200) return r; return boundResponse(r); }`,
    ),
  },
  {
    name: "the bounder's result is dropped",
    expect: UNBOUNDED,
    source: custom(
      `async (url, init) => { const r = await fetch(url, init); await boundResponse(r); return r; }`,
    ),
  },
  {
    name: "the marker is only in a comment",
    expect: UNBOUNDED,
    source: custom(`/* boundResponse( */ (url, init) => fetch(url, init)`),
  },
  {
    name: "method shorthand",
    expect: UNBOUNDED,
    source: `${HEAD}
await oauth.refreshTokenGrantRequest(as, client, auth, token, { async [oauth.customFetch](url: string, init: RequestInit) { return fetch(url, init); } });`,
  },
  {
    name: "assignment form on an options object",
    expect: UNBOUNDED,
    source: `${HEAD}
const options: Record<symbol, unknown> = {};
options[oauth.customFetch] = (url: string, init: RequestInit) => fetch(url, init);
await oauth.refreshTokenGrantRequest(as, client, auth, token, options);`,
  },
  // What vouches for an answer (registered()).
  {
    name: "a boundResponse of the file's own",
    expect: UNBOUNDED,
    source: `import * as oauth from "oauth4webapi";
declare const as: oauth.AuthorizationServer, client: oauth.Client, auth: oauth.ClientAuth, token: string;
const boundResponse = (response: Response) => response;
await oauth.refreshTokenGrantRequest(as, client, auth, token, { [oauth.customFetch]: async (url, init) => boundResponse(await fetch(url, init)) });`,
  },
  {
    name: "a boundResponse imported from a module that is not the transport",
    expect: UNBOUNDED,
    source: `import * as oauth from "oauth4webapi";
import { readBoundedBody as boundResponse } from "./bounded-body.js";
declare const as: oauth.AuthorizationServer, client: oauth.Client, auth: oauth.ClientAuth, token: string;
await oauth.refreshTokenGrantRequest(as, client, auth, token, { [oauth.customFetch]: async (url, init) => boundResponse(await fetch(url, init)) });`,
  },
  // Names resolve by declaration, not by spelling.
  {
    name: "bounded options in a let that is reassigned",
    expect: OPTIONS,
    source: `${HEAD}
let opts: object = requestOptions({ fetch, allowLoopbackHttp: false });
opts = { signal: AbortSignal.timeout(1) };
await oauth.refreshTokenGrantRequest(as, client, auth, token, opts);`,
  },
  {
    name: "a parameter named like a bounded const in another scope",
    expect: OPTIONS,
    source: `${HEAD}
function elsewhere(x: Parameters<typeof requestOptions>[0]) { const opts = requestOptions(x); return opts; }
export const refresh = (opts: object) => oauth.refreshTokenGrantRequest(as, client, auth, token, opts);`,
  },
  // The options of a call.
  {
    name: "a bounded and an unbounded branch (merge)",
    expect: OPTIONS,
    source: `${HEAD}
declare const flag: boolean;
await oauth.refreshTokenGrantRequest(as, client, auth, token, flag ? requestOptions({ fetch, allowLoopbackHttp: false }) : { signal: AbortSignal.timeout(1) });`,
  },
  {
    name: "one call bounded and another not",
    expect: OPTIONS,
    source: `${HEAD}
await oauth.refreshTokenGrantRequest(as, client, auth, token, requestOptions({ fetch, allowLoopbackHttp: false }));
await oauth.revocationRequest(as, client, auth, token, { signal: AbortSignal.timeout(1) });`,
  },
  {
    name: "a spread after the bounded fetch that may replace it",
    expect: OPTIONS,
    source: `${HEAD}
declare const extra: oauth.RevocationRequestOptions;
await oauth.revocationRequest(as, client, auth, token, { ...requestOptions({ fetch, allowLoopbackHttp: false }), ...extra });`,
  },
  {
    name: "no options at all, so the global fetch",
    expect: /without options/,
    source: `${HEAD}
await oauth.validateApplicationLevelSignature(as, new Response(""));`,
  },
  {
    name: "jose's key set with options that carry no custom fetch",
    expect: OPTIONS,
    source: `import { createRemoteJWKSet } from "jose";
createRemoteJWKSet(new URL("https://issuer.example/jwks"), { timeoutDuration: 5000 });`,
  },
  {
    name: "spread arguments",
    expect: /spread arguments/,
    source: `${HEAD}
declare const args: Parameters<typeof oauth.refreshTokenGrantRequest>;
await oauth.refreshTokenGrantRequest(...args);`,
  },
  // Ceilings.
  {
    name: "a ceiling raised on the bounder",
    expect: /ceiling of Infinity bytes/,
    source: custom(
      `async (url, init) => boundResponse(await fetch(url, init), Number.MAX_SAFE_INTEGER)`,
    ),
  },
  {
    name: "a ceiling raised on the options",
    expect: /ceiling of 1000000000000 bytes/,
    source: `${HEAD}
await oauth.refreshTokenGrantRequest(as, client, auth, token, requestOptions({ fetch, allowLoopbackHttp: false, maxResponseBytes: 1e12 }));`,
  },
  {
    name: "a ceiling that is not a constant",
    expect: /not a constant the compiler can see/,
    source: `${HEAD}
declare const configured: number;
await oauth.refreshTokenGrantRequest(as, client, auth, token, requestOptions({ fetch, allowLoopbackHttp: false, maxResponseBytes: configured }));`,
  },
  {
    name: "a ceiling passed on by a helper and raised by its caller",
    expect: /ceiling of 2097152 bytes/,
    source: `${HEAD}
const opts = (limit: number) => requestOptions({ fetch, allowLoopbackHttp: false, maxResponseBytes: limit });
await oauth.refreshTokenGrantRequest(as, client, auth, token, opts(2 * 1024 * 1024));`,
  },
  {
    name: "options the ceiling rule cannot see into",
    expect: /cannot see into/,
    source: `${HEAD}
declare const wire: Parameters<typeof wireFetch>[0];
const send = wireFetch({ ...wire });
await oauth.refreshTokenGrantRequest(as, client, auth, token, { [oauth.customFetch]: (url, init) => send(url, init) });`,
  },
  // Uses that hide calls.
  {
    name: "a default import",
    expect: /default-imports/,
    source: `import oauth from "oauth4webapi";\nvoid oauth;`,
  },
  {
    name: "the namespace bound to a variable",
    expect: /namespace as a value/,
    source: `import * as oauth from "oauth4webapi";\nconst o = oauth;\nvoid o;`,
  },
  {
    name: "a request function taken as a value",
    expect: /used as a value/,
    source: `import * as oauth from "oauth4webapi";\nconst refresh = oauth.refreshTokenGrantRequest;\nvoid refresh;`,
  },
  {
    name: "a member read by a computed name",
    expect: /computed name/,
    source: `import * as oauth from "oauth4webapi";\ndeclare const name: keyof typeof oauth;\nvoid oauth[name];`,
  },
  {
    name: "the custom fetch symbol through an alias",
    expect: /names the custom fetch in a form the gate does not read/,
    source: `import * as oauth from "oauth4webapi";\nconst key = oauth.customFetch;\nvoid key;`,
  },
  {
    name: "the custom fetch as a getter",
    expect: /a member the gate does not read/,
    source: `${HEAD}
await oauth.refreshTokenGrantRequest(as, client, auth, token, { get [oauth.customFetch]() { return (u: string, i: RequestInit) => fetch(u, i); } });`,
  },
  // Loading.
  {
    name: "a dynamic import of the library",
    expect: /loads oauth4webapi dynamically/,
    source: `const o = await import("oauth4webapi");\nvoid o;`,
  },
  {
    name: "an import whose name is computed",
    expect: /computed at run time/,
    source: `const name = "oauth4" + "webapi";\nconst o = await import(name);\nvoid o;`,
  },
  {
    name: "an import of a template that is not a relative path",
    expect: /computed at run time/,
    source: `declare const base: string;\nconst o = await import(\`\${base}/oauth4webapi\`);\nvoid o;`,
  },
  {
    name: "a require of the library",
    expect: /through require/,
    source: `declare const require: (id: string) => unknown;\nexport {};\nconst o = require("oauth4webapi");\nvoid o;`,
  },
  {
    name: "a createRequire whose require loads the library",
    expect: /require the gate cannot follow/,
    source: `import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nconst o = load("oauth4webapi");\nvoid o;`,
  },
  {
    name: "a re-export of the library",
    expect: /re-exports oauth4webapi/,
    source: `export * from "oauth4webapi";`,
  },
];

export const accepted: Array<{ name: string; source: string }> = [
  {
    name: "the bounded builder, a helper that returns it and a custom fetch that bounds what it fetched",
    source: `${HEAD}
type Ctx = { fetch: typeof fetch };
declare const ctx: Ctx;
const wire = (c: Ctx) => requestOptions({ fetch: c.fetch, allowLoopbackHttp: false });
const own = (c: Ctx) => ({ [oauth.customFetch]: async (url: string, init: RequestInit) => boundResponse(await c.fetch(url, init)) });
await oauth.refreshTokenGrantRequest(as, client, auth, token, wire(ctx));
await oauth.revocationRequest(as, client, auth, token, { ...wire(ctx), additionalParameters: {} });
await oauth.introspectionRequest(as, client, auth, token, own(ctx));
await oauth.deviceCodeGrantRequest(as, client, auth, token, {
  [oauth.customFetch]: async (url, init) => { const answer = await ctx.fetch(url, init as RequestInit); return boundResponse(answer, 65536); },
});`,
  },
  {
    name: "named imports, a renamed import and a fetch another bounded transport made",
    source: `import { customFetch as cf, discoveryRequest as discover } from "oauth4webapi";
import { wireFetch } from "./auth/wire.js";
const send = wireFetch({ fetch, allowLoopbackHttp: false, maxResponseBytes: 65536 });
await discover(new URL("https://issuer.example"), { [cf]: (url, init) => send(url, init) });`,
  },
  {
    name: "jose's key set given a bounded fetch",
    source: `import { createRemoteJWKSet, customFetch as joseFetch } from "jose";
import { boundResponse } from "./auth/response-bound.js";
createRemoteJWKSet(new URL("https://issuer.example/jwks"), { [joseFetch]: async (url, options) => boundResponse(await fetch(url, options as RequestInit)) });`,
  },
  {
    name: "the library's pure functions, and a require that only resolves",
    source: `import * as oauth from "oauth4webapi";
import { createRequire } from "node:module";
declare const as: oauth.AuthorizationServer, client: oauth.Client, response: Response;
await oauth.processRefreshTokenResponse(as, client, response);
createRequire(import.meta.url).resolve("oauth4webapi");
const relative = await import(\`./auth/wire.js?probe=\${Date.now()}\`);
void relative;`,
  },
];

/** Hand reads Part B must count beyond the review's seven. */
export const extraReads: Array<[string, string]> = [
  [
    "a member of an answer chosen at run time",
    `declare const name: "json" | "text";\nexport const x = async (u: string) => (await fetch(u))[name]();`,
  ],
  [
    "Reflect.apply of a reader",
    `export const x = async (u: string) => { const r = await fetch(u); return Reflect.apply(r.json, r, []); };`,
  ],
];
