import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type { AuthorizationServerOptions } from "../doubles/authorization-server.js";
import {
  approve,
  catalogHarness,
  CLIENT_ID,
  CLIENT_SECRET,
  completeRedirect,
  importDocument,
  startOAuthServer,
  startProviderApi,
} from "./harness.js";

/*
 * `openid` for a catalog entry that names its issuer. The authorization asks
 * the issuer's own metadata for the keys that verify the ID token, through the
 * same fetch every other request uses; the ID token is checked for signature,
 * issuer, audience, expiry, issue time and the nonce this attempt sent, and
 * only the verified subject leaves the engine, as the connection's account.
 * The fixture authorization server generates its signing keys when it starts.
 */

type Server = Awaited<ReturnType<typeof startOAuthServer>>;

function catalog(
  server: Server,
  api: { origin: string },
  auth: Record<string, unknown> = {},
) {
  return {
    catalog: "ceremony.provider-catalog/v1",
    providers: [
      {
        id: "local-idp",
        displayName: "Local IdP",
        auth: {
          mode: "oauth2-authorization-code",
          authorizationUrl: `${server.origin}/authorize`,
          tokenUrl: `${server.origin}/token`,
          issuer: server.issuer,
          // A caller may only name scopes the reviewed entry declares, so
          // `openid` is one of the entry's own.
          scopes: ["items.read", "openid"],
          ...auth,
        },
        proxy: { baseUrl: `${api.origin}/v2` },
      },
    ],
  };
}

async function bound(
  t: TestContext,
  options: {
    server?: AuthorizationServerOptions;
    auth?: (server: Server) => Record<string, unknown>;
  } = {},
) {
  const server = await startOAuthServer(t, {
    openidConnect: true,
    subject: "ada",
    scopes: ["openid", "items.read"],
    ...options.server,
  });
  const api = await startProviderApi(t);
  const harness = await catalogHarness(t);
  harness.setConfiguration(harness.actor, "LOCAL_IDP_CLIENT_ID", CLIENT_ID);
  harness.setConfiguration(
    harness.actor,
    "LOCAL_IDP_CLIENT_SECRET",
    CLIENT_SECRET,
  );
  const { definitions } = await importDocument(
    harness,
    catalog(server, api, options.auth?.(server)),
  );
  const profileId = definitions[0]!.authentication[0]!.id;
  const approved = await approve(harness, {
    definitionRef: definitions[0]!.definitionRef,
    destination: `${api.origin}/v2`,
    profileId,
  });
  const connect = (requested: string[] = []) =>
    harness.service.connect(harness.actor, {
      bindingRef: approved.reference.bindingRef,
      intent: { profileId, requestedPermissions: requested },
    });
  return { server, api, harness, approved, connect };
}

const presented = (view: unknown) =>
  (view as { presentation?: { url?: string } }).presentation?.url;

const refused = (detail: string) => (error: unknown) =>
  error instanceof ConnectorError && error.detail === detail;

test("openid discovers the issuer's keys, binds a nonce and yields only the verified subject", async (t) => {
  const { server, harness, connect } = await bound(t);
  const view = await connect();
  const url = presented(view);
  assert.ok(url);
  const authorization = new URL(url);
  assert.equal(authorization.searchParams.get("scope"), "items.read openid");
  assert.ok(authorization.searchParams.get("nonce"), "a nonce is sent");
  assert.ok(server.counts.metadata >= 1, "the issuer's metadata was read");

  const done = await completeRedirect(harness, url);
  assert.equal((done as { lifecycle: string }).lifecycle, "active");
  assert.ok(server.counts.jwks >= 1, "the signature was checked");
  // The only identity that surfaces is the verified subject; the ID token,
  // its other claims and the nonce reach no projection.
  const text = JSON.stringify(done);
  assert.ok(text.includes("ada"), "the verified subject names the account");
  for (const hidden of [
    "id_token",
    "eyJ",
    authorization.searchParams.get("nonce")!,
    CLIENT_SECRET,
  ])
    assert.ok(!text.includes(hidden), `${hidden} stays private`);
  const exchange = server.tokenRequests.find(
    (item) => item.grantType === "authorization_code",
  );
  assert.ok(exchange);
});

test("an ID token signed by a key the issuer never published leaves no connection", async (t) => {
  const { server, harness, connect } = await bound(t, {
    server: { misbehave: { forgedIdTokenSubject: "root" } },
  });
  const url = presented(await connect());
  assert.ok(url);
  // The code was spent and the response read, so this is the issuer's
  // protocol failure, not an uncertain effect; nothing names `root`.
  await assert.rejects(
    completeRedirect(harness, url),
    (error: unknown) =>
      refused("oauth.token.invalid-response")(error) &&
      !JSON.stringify(error).includes("root"),
  );
  assert.equal(server.counts.token, 1);
});

test("metadata naming another issuer is refused before the person is sent anywhere", async (t) => {
  const { server, connect } = await bound(t, {
    server: { misbehave: { issuerMismatch: "https://other-issuer.example" } },
  });
  await assert.rejects(connect(), refused("oauth.metadata.issuer-mismatch"));
  assert.equal(server.counts.authorize, 0);
});

test("an issuer that publishes no keys cannot be asked for an ID token", async (t) => {
  const { server, connect } = await bound(t, {
    server: { misbehave: { omitJwksUri: true } },
  });
  await assert.rejects(connect(), refused("catalog.oidc.jwks-missing"));
  assert.equal(server.counts.authorize, 0);
});

test("discovered endpoints must agree with the reviewed entry", async (t) => {
  const { server, connect } = await bound(t, {
    auth: (issuer) => ({ tokenUrl: `${issuer.origin}/token-elsewhere` }),
  });
  await assert.rejects(connect(), refused("oauth.endpoint.token.conflict"));
  assert.equal(server.counts.authorize, 0);
});

test("a declared key set must be the one the issuer publishes", async (t) => {
  const agreed = await bound(t, {
    auth: (server) => ({ jwksUrl: `${server.origin}/jwks` }),
  });
  const url = presented(await agreed.connect());
  assert.ok(url);
  const done = await completeRedirect(agreed.harness, url);
  assert.equal((done as { lifecycle: string }).lifecycle, "active");

  const differs = await bound(t, {
    auth: (server) => ({ jwksUrl: `${server.origin}/other-keys` }),
  });
  await assert.rejects(
    differs.connect(),
    refused("oauth.endpoint.jwks.conflict"),
  );
  assert.equal(differs.server.counts.authorize, 0);
});

test("without openid the entry is used as reviewed: no discovery, no keys", async (t) => {
  const { server, harness, connect } = await bound(t, {
    server: { openidConnect: false },
    auth: () => ({ scopes: ["items.read"] }),
  });
  const url = presented(await connect());
  assert.ok(url);
  assert.equal(new URL(url).searchParams.get("nonce"), null);
  const done = await completeRedirect(harness, url);
  assert.equal((done as { lifecycle: string }).lifecycle, "active");
  assert.equal(server.counts.metadata, 0);
  assert.equal(server.counts.jwks, 0);
  // Nor can a caller add `openid` to an entry that does not declare it.
  const other = await bound(t, {
    server: { openidConnect: false },
    auth: () => ({ scopes: ["items.read"] }),
  });
  await assert.rejects(
    other.connect(["openid"]),
    refused("catalog.scope.undeclared"),
  );
  assert.equal(other.server.counts.metadata, 0);
});

test("openid is refused for a comma-separated provider", async (t) => {
  const { server, connect } = await bound(t, {
    auth: () => ({ scopeSeparator: "," }),
  });
  await assert.rejects(connect(), refused("catalog.scope.openid-separator"));
  assert.equal(server.counts.metadata, 0);
});

test("a key set on an origin host policy has not admitted is refused at review", async (t) => {
  // The review hands the entry's OAuth origins, key set included, to host
  // issuer policy; an undeclared, unlisted origin never becomes a binding.
  await assert.rejects(
    bound(t, {
      auth: () => ({ jwksUrl: "https://keys.local-idp.example/jwks" }),
    }),
    refused("oauth.issuer.not-permitted"),
  );
});
