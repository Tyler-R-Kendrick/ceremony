import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  analyzeUrlTemplate,
  definitionFor,
  entrySchemaFor,
  parseProviderCatalogEntry,
  PROVIDER_CATALOG_LIMITS,
  resolveUrlTemplate,
  resolveValueTemplate,
  reviewCatalogBinding,
  type ProviderCatalogEntryInput,
} from "../../../src/server/connectors/formats/provider-catalog/index.js";

/*
 * The catalog entry is the one place a URL can come from, so these tests hold
 * its grammar: HTTPS only, one template form, values that fill whole leftmost
 * host labels and nothing else, and resolution that proves the filled URL is
 * the one the template described.
 */

function oauthEntry(
  overrides: Partial<Record<string, unknown>> = {},
): ProviderCatalogEntryInput {
  return {
    id: "tenant-desk",
    displayName: "Tenant Desk",
    auth: {
      mode: "oauth2-authorization-code",
      authorizationUrl:
        "https://${connectionConfig.subdomain}.tenant-desk.example/oauth/authorize",
      tokenUrl:
        "https://${connectionConfig.subdomain}.tenant-desk.example/oauth/token",
      scopes: ["read"],
      authorizationParams: { access_type: "offline" },
    },
    proxy: {
      baseUrl: "https://${connectionConfig.subdomain}.tenant-desk.example/api",
    },
    connectionConfig: [
      {
        name: "subdomain",
        label: "Subdomain",
        configuration: "TENANT_DESK_SUBDOMAIN",
        format: "dns-label",
      },
    ],
    ...overrides,
  } as ProviderCatalogEntryInput;
}

function reason(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof ConnectorError) return error.detail ?? error.code;
    throw error;
  }
  return undefined;
}

test("a well-formed entry parses and fills its defaults", () => {
  const entry = parseProviderCatalogEntry(oauthEntry());
  assert.equal(entry.auth.mode, "oauth2-authorization-code");
  if (entry.auth.mode !== "oauth2-authorization-code") return;
  assert.equal(entry.auth.pkce, true);
  assert.equal(entry.auth.scopeSeparator, " ");
  assert.equal(entry.auth.tokenRequestAuth, "client_secret_post");
  assert.equal(entry.auth.refresh, true);
  assert.deepEqual(entry.categories, []);
});

test("endpoints must be HTTPS; loopback HTTP needs the host's explicit opt-in", () => {
  for (const url of [
    "http://api.example.test/token",
    "ftp://api.example.test/token",
    "//api.example.test/token",
  ])
    assert.ok("error" in analyzeUrlTemplate(url), url);
  assert.ok("error" in analyzeUrlTemplate("http://127.0.0.1:8080/token"));
  assert.ok(
    !(
      "error" in
      analyzeUrlTemplate("http://127.0.0.1:8080/token", {
        allowLoopbackHttp: true,
      })
    ),
  );
  // The opt-in admits loopback, never an arbitrary plain-HTTP host.
  assert.ok(
    "error" in
      analyzeUrlTemplate("http://api.example.test/token", {
        allowLoopbackHttp: true,
      }),
  );
  assert.equal(
    reason(() =>
      parseProviderCatalogEntry(
        oauthEntry({
          proxy: { baseUrl: "http://api.tenant-desk.example" },
        }),
      ),
    ),
    "catalog.url.scheme",
  );
});

test("a template can fill whole leftmost host labels only, under a fixed suffix", () => {
  const cases: Array<[string, string]> = [
    // A value alone would choose the whole host.
    [
      "https://${connectionConfig.subdomain}/api",
      "catalog.template.host-suffix",
    ],
    [
      "https://${connectionConfig.subdomain}.example/api",
      "catalog.template.host-suffix",
    ],
    // A value inside the registrable domain would choose the domain.
    [
      "https://api.${connectionConfig.subdomain}.example/api",
      "catalog.template.host-position",
    ],
    // Half a label lets a value append its own domain.
    [
      "https://${connectionConfig.subdomain}evil.tenant-desk.example/api",
      "catalog.template.host-partial",
    ],
    ["https://api.example.test:${connectionConfig.port}/", "catalog.url.host"],
    // Userinfo is how a URL is made to lie about its host.
    ["https://user@api.example.test/", "catalog.url.characters"],
    ["https://api.example.test/a#b", "catalog.url.characters"],
    // Only field references; a credential or expression is never spliced in.
    ["https://api.example.test/${apiKey}", "catalog.template.variable"],
    [
      "https://api.example.test/${connectionConfig.x+1}",
      "catalog.template.variable",
    ],
    [
      "https://api.example.test/${connectionConfig.x",
      "catalog.template.variable",
    ],
    ["https://api.example.test/a/../b", "catalog.url.path"],
    ["https://api.example.test/a%2Fb", "catalog.url.path"],
    ["https://api.example.test//b", "catalog.url.path"],
    ["https://api.example.test/a?b=c", "catalog.url.query"],
  ];
  for (const [template, code] of cases) {
    const analysis = analyzeUrlTemplate(template);
    assert.ok("error" in analysis, template);
    assert.equal("error" in analysis && analysis.error, code, template);
  }
});

test("values are validated by position and cannot move the request elsewhere", () => {
  const entry = parseProviderCatalogEntry(oauthEntry());
  const template = entry.proxy!.baseUrl;
  const ok = resolveUrlTemplate(entry, template, { subdomain: "Acme-1" });
  assert.equal(ok.url.href, "https://acme-1.tenant-desk.example/api");
  for (const value of [
    "evil.example/x",
    "attacker.example",
    "a@b",
    "x:1",
    "..",
    "-bad",
    "a".repeat(64),
    "%2e%2e",
    "",
  ])
    assert.ok(
      reason(() => resolveUrlTemplate(entry, template, { subdomain: value })),
      JSON.stringify(value),
    );
  assert.equal(
    reason(() => resolveUrlTemplate(entry, template, {})),
    "catalog.connection-config.missing",
  );
});

test("path and parameter values are single URL tokens", () => {
  const entry = parseProviderCatalogEntry({
    id: "path-tenant",
    displayName: "Path tenant",
    auth: { mode: "bearer" },
    proxy: {
      baseUrl:
        "https://api.path-tenant.example/accounts/${connectionConfig.account}",
      headers: { "x-account": "acct-${connectionConfig.account}" },
    },
    connectionConfig: [
      {
        name: "account",
        label: "Account",
        configuration: "PATH_TENANT_ACCOUNT",
      },
    ],
  });
  const template = entry.proxy!.baseUrl;
  assert.equal(
    resolveUrlTemplate(entry, template, { account: "a_1.b" }).url.pathname,
    "/accounts/a_1.b",
  );
  for (const value of ["../admin", "a/b", "a?b", "..", ".", "a b"])
    assert.ok(
      reason(() => resolveUrlTemplate(entry, template, { account: value })),
      value,
    );
  assert.equal(
    resolveValueTemplate(entry, entry.proxy!.headers["x-account"]!, {
      account: "42",
    }),
    "acct-42",
  );
  assert.ok(
    reason(() =>
      resolveValueTemplate(entry, entry.proxy!.headers["x-account"]!, {
        account: "42\r\nx-injected: 1",
      }),
    ),
  );
});

test("the entry refuses reserved parameters, credential headers and undeclared fields", () => {
  const invalid: Array<[string, ProviderCatalogEntryInput]> = [
    [
      "reserved authorization parameter",
      oauthEntry({
        auth: {
          ...(oauthEntry().auth as object),
          authorizationParams: { redirect_uri: "https://evil.example/cb" },
        },
      }),
    ],
    [
      "authorization as a default header",
      oauthEntry({
        proxy: {
          baseUrl: "https://${connectionConfig.subdomain}.tenant-desk.example",
          headers: { authorization: "Bearer fixed" },
        },
      }),
    ],
    [
      "api key in a hop-by-hop header",
      {
        id: "k",
        displayName: "K",
        auth: { mode: "api-key", placement: "header", name: "host" },
      },
    ],
    ["undeclared field", oauthEntry({ connectionConfig: [] })],
    [
      "host field that is not a DNS label",
      oauthEntry({
        connectionConfig: [
          {
            name: "subdomain",
            label: "Subdomain",
            configuration: "TENANT_DESK_SUBDOMAIN",
            format: "token",
          },
        ],
      }),
    ],
    [
      "reserved client-credentials parameter",
      {
        id: "cc",
        displayName: "CC",
        auth: {
          mode: "oauth2-client-credentials",
          tokenUrl: "https://login.cc.example/token",
          tokenParams: { client_secret: "inline" },
        },
      },
    ],
    [
      "templated issuer",
      oauthEntry({
        auth: {
          ...(oauthEntry().auth as object),
          issuer: "https://${connectionConfig.subdomain}.tenant-desk.example",
        },
      }),
    ],
    [
      "templated key set",
      oauthEntry({
        auth: {
          ...(oauthEntry().auth as object),
          jwksUrl:
            "https://${connectionConfig.subdomain}.tenant-desk.example/jwks",
        },
      }),
    ],
    ...[
      "code",
      "redirect_uri",
      "code_verifier",
      "client_secret",
      "resource",
    ].map((name): [string, ProviderCatalogEntryInput] => [
      `reserved authorization-code token parameter ${name}`,
      oauthEntry({
        auth: {
          ...(oauthEntry().auth as object),
          tokenParams: { [name]: "chosen-elsewhere" },
        },
      }),
    ]),
    ...["refresh_token", "grant_type", "client_secret", "scope"].map(
      (name): [string, ProviderCatalogEntryInput] => [
        `reserved refresh parameter ${name}`,
        oauthEntry({
          auth: {
            ...(oauthEntry().auth as object),
            refreshParams: { [name]: "chosen-elsewhere" },
          },
        }),
      ],
    ),
    [
      "unknown key",
      { ...oauthEntry(), extra: true } as ProviderCatalogEntryInput,
    ],
  ];
  for (const [label, input] of invalid)
    assert.equal(entrySchemaFor().safeParse(input).success, false, label);
});

test("every list and string in an entry is bounded", () => {
  const scopes = Array.from(
    { length: PROVIDER_CATALOG_LIMITS.scopes + 1 },
    (_, index) => `scope${index}`,
  );
  assert.equal(
    entrySchemaFor().safeParse(
      oauthEntry({ auth: { ...(oauthEntry().auth as object), scopes } }),
    ).success,
    false,
  );
  const long = `https://api.example.test/${"a".repeat(PROVIDER_CATALOG_LIMITS.urlLength)}`;
  assert.ok("error" in analyzeUrlTemplate(long));
  const params = Object.fromEntries(
    Array.from({ length: PROVIDER_CATALOG_LIMITS.parameters + 1 }, (_, i) => [
      `p${i}`,
      "v",
    ]),
  );
  assert.equal(
    entrySchemaFor().safeParse(
      oauthEntry({
        auth: { ...(oauthEntry().auth as object), authorizationParams: params },
      }),
    ).success,
    false,
  );
  assert.equal(
    entrySchemaFor().safeParse(oauthEntry({ displayName: "x".repeat(121) }))
      .success,
    false,
  );
});

test("review names a templated issuer host as a family of origins, never an exact one", async () => {
  const entry = parseProviderCatalogEntry(oauthEntry());
  const definition = await definitionFor(entry, { authorityNamespace: "test" });
  const reviewed = reviewCatalogBinding(
    { definition, destinations: [], operations: [], profileId: "oauth2" },
    {},
  );
  assert.deepEqual(reviewed.issuer, {
    issuer: "https://*.tenant-desk.example",
    origins: ["https://*.tenant-desk.example"],
  });
  assert.equal(
    reviewed.settings["provider-catalog/digest"] !== undefined,
    true,
  );
});
