/*
 * Sources the gate has to refuse, each an unbounded read of an OAuth answer
 * in a form someone could write, and sources it has to accept. They live
 * under `src/server/connectors/` so that their relative imports resolve to
 * the registry's files, as a real source's would.
 */

export const FILE = "src/server/connectors/fixture.ts";

const HEAD = `import * as oauth from "oauth4webapi";
import { requestOptions } from "./auth/wire.js";
import { boundResponse } from "./auth/response-bound.js";
`;

export type Refused = { name: string; source: string; expect: RegExp };

export const refused: Refused[] = [
  {
    name: "bounds after reading: the body is read first and the ceiling is applied to a copy",
    expect: /does not read its answer under the ceiling/,
    source: `${HEAD}
await oauth.refreshTokenGrantRequest(as, client, auth, token, {
  [oauth.customFetch]: async (url, init) => {
    const bytes = await (await fetch(url, init)).arrayBuffer();
    return boundResponse(new Response(bytes));
  },
});`,
  },
  {
    name: "the marker is only in a comment",
    expect: /does not read its answer under the ceiling/,
    source: `${HEAD}
await oauth.refreshTokenGrantRequest(as, client, auth, token, {
  // boundResponse( is applied elsewhere
  [oauth.customFetch]: (url, init) => fetch(url, init),
});`,
  },
  {
    name: "method shorthand with a stray requestOptions( elsewhere in the file",
    expect: /does not read its answer under the ceiling/,
    source: `${HEAD}
const unrelated = requestOptions({ fetch });
await oauth.refreshTokenGrantRequest(as, client, auth, token, {
  async [oauth.customFetch](url, init) {
    return fetch(url, init);
  },
});`,
  },
  {
    name: "assignment form on an options object",
    expect: /does not read its answer under the ceiling/,
    source: `${HEAD}
const options = {};
options[oauth.customFetch] = (url, init) => fetch(url, init);
await oauth.refreshTokenGrantRequest(as, client, auth, token, options);`,
  },
  {
    name: "the namespace imported under another name",
    expect: /without options/,
    source: `import * as o from "oauth4webapi";
await o.refreshTokenGrantRequest(as, client, auth, token);`,
  },
  {
    name: "named imports",
    expect: /do not resolve to the bounded transport/,
    source: `import { customFetch, refreshTokenGrantRequest } from "oauth4webapi";
await refreshTokenGrantRequest(as, client, auth, token, {
  [customFetch]: (url, init) => fetch(url, init),
});`,
  },
  {
    name: "a named import renamed, called with no options",
    expect: /without options/,
    source: `import { refreshTokenGrantRequest as refresh } from "oauth4webapi";
await refresh(as, client, auth, token);`,
  },
  {
    name: "jose's remote key set with its default fetch",
    expect: /without options/,
    source: `import { createRemoteJWKSet } from "jose";
const keys = createRemoteJWKSet(new URL(uri));`,
  },
  {
    name: "jose's remote key set with options that carry no custom fetch",
    expect: /do not resolve to the bounded transport/,
    source: `import { createRemoteJWKSet } from "jose";
const keys = createRemoteJWKSet(new URL(uri), { timeoutDuration: 5000 });`,
  },
  {
    name: "a signature check that fetches a key set, with no ceiling (no Request in its name)",
    expect: /without options/,
    source: `import * as oauth from "oauth4webapi";
await oauth.validateApplicationLevelSignature(as, response);`,
  },
  {
    name: "one call bounded and another call in the same file not",
    expect: /do not resolve to the bounded transport/,
    source: `${HEAD}
const bounded = requestOptions({ fetch });
await oauth.refreshTokenGrantRequest(as, client, auth, token, bounded);
await oauth.revocationRequest(as, client, auth, token, { signal });`,
  },
  {
    name: "a second custom fetch, unbounded, next to a bounded one",
    expect: /does not read its answer under the ceiling/,
    source: `${HEAD}
await oauth.authorizationCodeGrantRequest(as, client, auth, params, uri, verifier, {
  [oauth.customFetch]: async (url, init) => boundResponse(await send(url, init)),
});
await oauth.refreshTokenGrantRequest(as, client, auth, token, {
  [oauth.customFetch]: async (url, init) => send(url, init),
});`,
  },
  {
    name: "a branch of the custom fetch that returns the answer raw",
    expect: /does not read its answer under the ceiling/,
    source: `${HEAD}
await oauth.refreshTokenGrantRequest(as, client, auth, token, {
  [oauth.customFetch]: async (url, init) => {
    const response = await fetch(url, init);
    if (response.status === 200) return response;
    return boundResponse(response);
  },
});`,
  },
  {
    name: "the ceiling is applied but its result is dropped",
    expect: /does not read its answer under the ceiling/,
    source: `${HEAD}
await oauth.refreshTokenGrantRequest(as, client, auth, token, {
  [oauth.customFetch]: async (url, init) => {
    const response = await fetch(url, init);
    await boundResponse(response);
    return response;
  },
});`,
  },
  {
    name: "a boundResponse of the file's own that bounds nothing",
    expect: /does not read its answer under the ceiling/,
    source: `import * as oauth from "oauth4webapi";
const boundResponse = (response) => response;
await oauth.refreshTokenGrantRequest(as, client, auth, token, {
  [oauth.customFetch]: async (url, init) => boundResponse(await fetch(url, init)),
});`,
  },
  {
    name: "a boundResponse imported from a module that is not the transport",
    expect: /does not read its answer under the ceiling/,
    source: `import * as oauth from "oauth4webapi";
import { boundResponse } from "./not-the-transport.js";
await oauth.refreshTokenGrantRequest(as, client, auth, token, {
  [oauth.customFetch]: async (url, init) => boundResponse(await fetch(url, init)),
});`,
  },
  {
    name: "options that arrive as a parameter",
    expect: /do not resolve to the bounded transport/,
    source: `import * as oauth from "oauth4webapi";
export const refresh = (options) =>
  oauth.refreshTokenGrantRequest(as, client, auth, token, options);`,
  },
  {
    name: "the custom fetch reached through an alias of its symbol",
    expect: /names the custom fetch in a form the gate does not read/,
    source: `${HEAD}
const key = oauth.customFetch;
const options = { [key]: (url, init) => fetch(url, init) };
await oauth.refreshTokenGrantRequest(as, client, auth, token, options);`,
  },
  {
    name: "the library bound to a variable and called through it",
    expect: /namespace as a value/,
    source: `import * as oauth from "oauth4webapi";
const o = oauth;
await o.refreshTokenGrantRequest(as, client, auth, token);`,
  },
  {
    name: "a request function taken out of the namespace as a value",
    expect: /used as a value/,
    source: `import * as oauth from "oauth4webapi";
const refresh = oauth.refreshTokenGrantRequest;
await refresh(as, client, auth, token);`,
  },
  {
    name: "a request function reached by a computed name",
    expect: /computed name/,
    source: `import * as oauth from "oauth4webapi";
await oauth[name](as, client, auth, token);`,
  },
  {
    name: "spread arguments the gate cannot place",
    expect: /spread arguments/,
    source: `import * as oauth from "oauth4webapi";
await oauth.refreshTokenGrantRequest(...args);`,
  },
  {
    name: "a dynamic import of the library",
    expect: /imports oauth4webapi dynamically/,
    source: `const oauth = await import("oauth4webapi");
await oauth.refreshTokenGrantRequest(as, client, auth, token);`,
  },
  {
    name: "a require of the library",
    expect: /requires oauth4webapi/,
    source: `const oauth = require("oauth4webapi");
await oauth.refreshTokenGrantRequest(as, client, auth, token);`,
  },
  {
    name: "a re-export of the library",
    expect: /re-exports oauth4webapi/,
    source: `export * from "oauth4webapi";`,
  },
];

export type Accepted = { name: string; source: string };

export const accepted: Accepted[] = [
  {
    name: "the bounded builder, a helper that returns it and a custom fetch that bounds what it fetched",
    source: `${HEAD}
const wire = (ctx) => requestOptions({ fetch: ctx.fetch });
const own = (ctx) => ({
  [oauth.customFetch]: async (url, init) => boundResponse(await ctx.fetch(url, init)),
});
await oauth.refreshTokenGrantRequest(as, client, auth, token, wire(ctx));
await oauth.revocationRequest(as, client, auth, token, { ...wire(ctx), additionalParameters: {} });
await oauth.introspectionRequest(as, client, auth, token, own(ctx));
await oauth.deviceCodeGrantRequest(as, client, auth, code, {
  ...(dpop ? { DPoP: dpop } : {}),
  [oauth.customFetch]: async (url, init) => {
    const answer = await ctx.fetch(url, init);
    return boundResponse(answer, 65536);
  },
});`,
  },
  {
    name: "named imports and the fetch of another bounded transport",
    source: `import { customFetch, discoveryRequest } from "oauth4webapi";
import { wireFetch } from "./auth/wire.js";
const send = wireFetch({ fetch, allowLoopbackHttp: false });
await discoveryRequest(issuer, {
  [customFetch]: (url, init) => send(url, init),
});`,
  },
  {
    name: "jose's remote key set given a bounded fetch",
    source: `import { createRemoteJWKSet, customFetch as joseFetch } from "jose";
import { boundResponse } from "./auth/response-bound.js";
const keys = createRemoteJWKSet(new URL(uri), {
  [joseFetch]: async (url, options) => boundResponse(await fetch(url, options)),
});`,
  },
  {
    name: "a library that is imported and only its pure functions are used",
    source: `import * as oauth from "oauth4webapi";
const parsed = await oauth.processRefreshTokenResponse(as, client, response);`,
  },
];
