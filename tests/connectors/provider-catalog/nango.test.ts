import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  definitionFor,
  importNangoProviders,
  providerCatalogBindingSettings,
  type NangoProviderImport,
} from "../../../src/server/connectors/formats/provider-catalog/index.js";

/*
 * Nango's providers.yaml format, read from a synthetic fixture written for
 * these tests. Each auth mode maps to a typed entry; a mode the runtime cannot
 * execute is kept as a described entry with its reason and a blocking issue,
 * so a reviewer sees the whole file and nothing disappears.
 */

const fixture = readFileSync(
  new URL("./fixtures/providers.yaml", import.meta.url),
  "utf8",
);
const imported = importNangoProviders(fixture);
const byKey = new Map(imported.providers.map((item) => [item.nangoKey, item]));

function provider(key: string): NangoProviderImport {
  const found = byKey.get(key);
  assert.ok(found, `provider ${key} was imported`);
  return found;
}

function codes(item: NangoProviderImport): string[] {
  return item.issues.map((issue) => issue.code);
}

test("every provider key yields exactly one entry; none is dropped", () => {
  const keys = [...fixture.matchAll(/^([a-z][a-z0-9-]*):$/gm)].map(
    (match) => match[1],
  );
  assert.equal(keys.length, 15);
  assert.deepEqual(
    imported.providers.map((item) => item.nangoKey),
    keys,
  );
  assert.deepEqual(imported.issues, []);
});

test("OAUTH2 maps endpoints, default scopes and non-reserved parameters", () => {
  const acme = provider("acme-crm");
  assert.equal(acme.executable, true);
  const auth = acme.entry.auth;
  assert.equal(auth.mode, "oauth2-authorization-code");
  if (auth.mode !== "oauth2-authorization-code") return;
  assert.equal(
    auth.authorizationUrl,
    "https://auth.acme-crm.example/oauth/authorize",
  );
  assert.equal(auth.tokenUrl, "https://auth.acme-crm.example/oauth/token");
  assert.deepEqual(auth.scopes, ["contacts.read", "deals.read"]);
  // response_type=code is what the flow always sends: adapted, reported.
  assert.deepEqual(auth.authorizationParams, {
    access_type: "offline",
    prompt: "consent",
  });
  assert.ok(codes(acme).includes("catalog.nango.parameter-redundant"));
  assert.equal(auth.tokenRequestAuth, "client_secret_post");
  assert.deepEqual(acme.entry.categories, ["crm", "sales"]);
  assert.equal(
    acme.entry.docsUrl,
    "https://docs.acme-crm.example/integrations/oauth",
  );
  assert.deepEqual(acme.entry.proxy, {
    baseUrl: "https://api.acme-crm.example/v2",
    headers: { "accept-version": "2026-01" },
    verification: { method: "GET", path: "/me" },
  });
});

test("OAUTH2 keeps a comma separator, basic client auth and query parameters", () => {
  const chat = provider("team-chat");
  const auth = chat.entry.auth;
  assert.equal(auth.mode, "oauth2-authorization-code");
  if (auth.mode !== "oauth2-authorization-code") return;
  assert.equal(auth.scopeSeparator, ",");
  assert.equal(auth.tokenRequestAuth, "client_secret_basic");
  assert.equal(
    auth.authorizationUrl,
    "https://chat.example/oauth/v2/authorize",
  );
  assert.deepEqual(auth.authorizationParams, { user_scope: "identify" });
  assert.ok(codes(chat).includes("catalog.nango.query-to-parameter"));
});

test("templated hosts become DNS-label connection fields; aliases inherit", () => {
  const desk = provider("tenant-desk");
  assert.equal(desk.executable, true);
  assert.deepEqual(desk.entry.connectionConfig, [
    {
      name: "subdomain",
      label: "Desk subdomain",
      configuration: "TENANT_DESK_SUBDOMAIN",
      format: "dns-label",
    },
  ]);
  // The provider's own pattern is replaced by the fixed format, and said so.
  assert.ok(codes(desk).includes("catalog.nango.connection-config-format"));
  // A Nango feature with no catalog equivalent is reported, not dropped.
  assert.ok(codes(desk).includes("catalog.nango.key-not-mapped"));

  const sandbox = provider("tenant-desk-sandbox");
  assert.equal(sandbox.entry.id, "tenant-desk-sandbox");
  assert.equal(sandbox.entry.displayName, "Tenant Desk (sandbox)");
  assert.equal(sandbox.entry.auth.mode, "oauth2-authorization-code");
  assert.equal(
    sandbox.entry.connectionConfig[0]?.configuration,
    "TENANT_DESK_SANDBOX_SUBDOMAIN",
  );
  assert.ok(codes(sandbox).includes("catalog.nango.alias-resolved"));
});

test("OAUTH2_CC maps the token endpoint and extra token parameters", () => {
  const metrics = provider("metrics-hub");
  const auth = metrics.entry.auth;
  assert.equal(auth.mode, "oauth2-client-credentials");
  if (auth.mode !== "oauth2-client-credentials") return;
  assert.equal(auth.tokenUrl, "https://login.metrics-hub.example/oauth2/token");
  assert.deepEqual(auth.tokenParams, { audience: "api-metrics-hub" });
  assert.deepEqual(auth.scopes, ["metrics.read"]);
});

test("API_KEY placements become typed credential placements, never header templates", () => {
  const bearer = provider("bearer-notes");
  assert.deepEqual(bearer.entry.auth, { mode: "bearer" });
  assert.deepEqual(bearer.entry.proxy?.headers, {});

  const header = provider("header-mail");
  assert.deepEqual(header.entry.auth, {
    mode: "api-key",
    placement: "header",
    name: "x-api-key",
    prefix: "",
  });
  assert.deepEqual(header.entry.proxy?.headers, {});
  assert.ok(codes(header).includes("catalog.nango.key-not-mapped"));

  const query = provider("query-weather");
  assert.deepEqual(query.entry.auth, {
    mode: "api-key",
    placement: "query",
    name: "appid",
    prefix: "",
  });
  for (const item of [bearer, header, query])
    assert.ok(!JSON.stringify(item.entry).includes("${apiKey}"));
});

test("BASIC and NONE map to their modes", () => {
  const board = provider("issue-board");
  assert.deepEqual(board.entry.auth, {
    mode: "basic",
    passwordOptional: false,
  });
  assert.equal(board.entry.connectionConfig[0]?.format, "dns-label");
  assert.deepEqual(provider("open-data").entry.auth, { mode: "none" });
});

test("unsupported modes are imported as described entries with a reason", () => {
  for (const [key, native, code] of [
    ["legacy-signer", "OAUTH1", "catalog.nango.auth-mode-unsupported"],
    ["app-installer", "APP", "catalog.nango.auth-mode-unsupported"],
    [
      "reserved-token-params",
      "OAUTH2",
      "catalog.nango.token-params-unsupported",
    ],
    ["plain-http", "OAUTH2", "catalog.url.scheme"],
  ] as const) {
    const item = provider(key);
    assert.equal(item.executable, false, key);
    assert.equal(item.entry.auth.mode, "unsupported", key);
    if (item.entry.auth.mode !== "unsupported") continue;
    assert.equal(item.entry.auth.native, native, key);
    assert.ok(item.entry.auth.reason.length > 10, key);
    const blocking = item.issues.find((issue) => issue.code === code);
    assert.ok(blocking, `${key} carries ${code}`);
    assert.equal(blocking.severity, "blocking");
    assert.equal(blocking.executionImpact, "blocks-authorization");
    // Nothing of a non-executable entry can be contacted: no URLs survive.
    assert.equal(item.entry.proxy, undefined, key);
  }
  // A key the reader does not know is still reported.
  assert.ok(
    codes(provider("legacy-signer")).includes("catalog.nango.key-unknown"),
  );
});

test("OAUTH2 token_params become the entry's static code-exchange parameters", () => {
  const item = provider("audience-token-params");
  assert.equal(item.executable, true);
  const auth = item.entry.auth;
  assert.equal(auth.mode, "oauth2-authorization-code");
  if (auth.mode !== "oauth2-authorization-code") return;
  // The redundant grant type is dropped with an issue; the rest is kept as
  // written, templates and all, for the adapter to fill per connection.
  assert.deepEqual(auth.tokenParams, {
    audience: "https://api.audience-token.example/${connectionConfig.region}",
  });
  assert.ok(codes(item).includes("catalog.nango.parameter-redundant"));
  assert.ok(!codes(item).includes("catalog.nango.token-params-unsupported"));
  assert.deepEqual(
    item.entry.connectionConfig.map((field) => field.name),
    ["region"],
  );
  // A parameter the grant owns is still refused, whichever grant it is.
  for (const [name, value] of [
    ["code", "x"],
    ["client_secret", "x"],
    ["redirect_uri", "https://elsewhere.example/cb"],
    ["code_verifier", "x"],
    ["resource", "https://api.example"],
    ["audience", "${apiKey}"],
  ] as Array<[string, string]>) {
    const [refused] = importNangoProviders(
      JSON.stringify({
        probe: {
          auth_mode: "OAUTH2",
          authorization_url: "https://auth.probe.example/authorize",
          token_url: "https://auth.probe.example/token",
          token_params: { [name]: value },
        },
      }),
    ).providers;
    assert.equal(refused?.executable, false, name);
    assert.ok(
      refused?.issues.some(
        (issue) => issue.code === "catalog.nango.token-params-unsupported",
      ),
      name,
    );
  }
});

test("loopback HTTP endpoints import only when the host opts in", () => {
  const document = {
    local: {
      auth_mode: "OAUTH2",
      authorization_url: "http://127.0.0.1:4010/authorize",
      token_url: "http://127.0.0.1:4010/token",
      proxy: { base_url: "http://127.0.0.1:4011" },
    },
  };
  assert.equal(importNangoProviders(document).providers[0]?.executable, false);
  assert.equal(
    importNangoProviders(document, { allowLoopbackHttp: true }).providers[0]
      ?.executable,
    true,
  );
});

test("a credential spliced into anything but a typed placement is refused", () => {
  const result = importNangoProviders({
    spliced: {
      auth_mode: "API_KEY",
      proxy: {
        base_url: "https://api.spliced.example",
        headers: { authorization: "Basic ${base64(${apiKey}:x)}" },
      },
    },
    extra: {
      auth_mode: "OAUTH2",
      authorization_url: "https://auth.extra.example/authorize",
      token_url: "https://auth.extra.example/token",
      proxy: {
        base_url: "https://api.extra.example",
        headers: { "x-account": "${accountId}" },
      },
    },
    override: {
      auth_mode: "OAUTH2",
      authorization_url: "https://auth.override.example/authorize",
      token_url: "https://auth.override.example/token",
      authorization_params: { redirect_uri: "https://evil.example/cb" },
    },
  });
  for (const item of result.providers) {
    assert.equal(item.executable, false, item.nangoKey);
    assert.ok(
      item.issues.some((issue) => issue.severity === "blocking"),
      item.nangoKey,
    );
  }
});

test("an imported entry becomes a non-executable draft definition and bounded settings", async () => {
  const acme = provider("acme-crm");
  const definition = await definitionFor(acme.entry, {
    authorityNamespace: "nango",
    issues: acme.issues,
  });
  assert.equal(definition.identity.ecosystem, "provider-catalog");
  assert.deepEqual(
    definition.declaredServers.map((server) => server.url),
    ["https://api.acme-crm.example/v2"],
  );
  assert.deepEqual(
    definition.capabilities.map((capability) => capability.nativeId),
    ["proxy.get", "proxy.post", "proxy.put", "proxy.patch", "proxy.delete"],
  );
  // Nothing about proxy output is known until a reviewer classifies it.
  assert.ok(
    definition.capabilities.every(
      (capability) => capability.dataClassification === "unknown",
    ),
  );
  assert.equal(definition.authentication[0]?.kind, "oauth-authorization-code");
  assert.deepEqual(
    definition.configuration.map((item) => [item.name, item.classification]),
    [
      ["ACME_CRM_CLIENT_ID", "public"],
      ["ACME_CRM_CLIENT_SECRET", "secret"],
    ],
  );
  const settings = providerCatalogBindingSettings(definition);
  assert.ok(JSON.stringify(settings).length < 16 * 1024);

  const signer = provider("legacy-signer");
  const described = await definitionFor(signer.entry, {
    authorityNamespace: "nango",
    issues: signer.issues,
  });
  assert.equal(described.authentication[0]?.kind, "unsupported");
  assert.equal(described.capabilities.length, 0);
  assert.equal(described.compatibility.dimensions.authorize, "unsupported");
});
