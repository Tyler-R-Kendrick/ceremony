import assert from "node:assert/strict";
import { test } from "node:test";
import {
  discoverProviderAuth,
  isProviderOwnedAuth,
} from "../src/server/provider-discovery.js";

test("provider ownership does not conflate unrelated public-suffix tenants", () => {
  for (const [origin, issuer, expected] of [
    ["https://provider.co.uk", "https://unrelated.co.uk", false],
    ["https://provider.github.io", "https://unrelated.github.io", false],
    ["https://provider.example", "https://provider.example", true],
    ["https://provider.example", "https://auth.provider.example", true],
    ["https://auth.provider.example", "https://provider.example", true],
    ["invalid", "invalid", false],
    ["invalid", "https://provider.example.", false],
    ["https://provider.example.", "invalid", false],
  ] as const) {
    assert.equal(
      isProviderOwnedAuth({
        origin,
        issuer,
        authorizationEndpoint: `${issuer}/authorize`,
      }),
      expected,
    );
  }
});

test("default discovery never follows delegated metadata into HTTPS loopback", async (t) => {
  const internal: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "127.0.0.1") internal.push(url.href);
    if (
      url.origin === "https://provider.example" &&
      url.pathname === "/.well-known/oauth-protected-resource"
    )
      return Response.json({
        authorization_servers: ["https://127.0.0.1:9443"],
      });
    return new Response("", { status: 404 });
  });
  const found = await discoverProviderAuth(["https://provider.example"]);
  assert.equal(found.authorizationEndpoint, undefined);
  assert.deepEqual(internal, []);
});
