import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  composioConfigurationNames,
  composioUserId,
} from "../../../src/server/connectors/providers/composio/index.js";
import { canaries, canaryValues } from "../fixtures/builders.js";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  AUTH_CONFIG,
  OTHER_AUTH_CONFIG,
  READ_TOOL,
  TENANT,
  TOOLKIT,
  TOOLKIT_VERSION,
  OLD_VERSION,
  WRITE_TOOL,
  account,
  capabilityFor,
  harness,
  stringsIn,
  type Harness,
} from "./harness.js";

/*
 * CO-01: toolkit, auth-configuration and connected-account discovery with
 * versioned capability metadata and host-derived user identity.
 */

const open: Harness[] = [];
async function start(...args: Parameters<typeof harness>) {
  const created = await harness(...args);
  open.push(created);
  return created;
}
after(async () => {
  for (const item of open) await item.close();
});

describe("Composio discovery", () => {
  it("authenticates with the documented project API key header", async () => {
    const h = await start();
    await h.adapter.discover!(h.context(), { scope: { kind: "toolkit" } });
    const [request] = h.double.received("GET", "/api/v3/toolkits");
    assert.ok(request, "a toolkits listing was sent");
    assert.equal(
      request.headers["x-api-key"],
      "composio-project-api-key-fixture",
    );
    assert.equal(request.headers["authorization"], undefined);
  });

  it("refuses to run when the project API key is not configured", async () => {
    const h = await start();
    h.ports.configuration.set(composioConfigurationNames.apiKey, undefined);
    await assert.rejects(
      () => h.adapter.discover!(h.context(), {}),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "configuration-required",
    );
  });

  it("preserves the toolkit slug and its opaque release version", async () => {
    const h = await start();
    const result = await h.adapter.discover!(h.context(), {
      scope: { kind: "toolkit" },
    });
    const github = result.items.find(
      (item) => item.identity.nativeId === TOOLKIT,
    );
    assert.ok(github);
    assert.equal(github.identity.nativeVersion, TOOLKIT_VERSION);
    assert.equal(github.identity.ecosystem, "composio");
    // The service slug groups a directory; it never replaces the native id.
    assert.equal(github.provenance?.slug, TOOLKIT);
  });

  it("records a toolkit without a stated version as unversioned, with an issue", async () => {
    const h = await start();
    const result = await h.adapter.discover!(h.context(), {
      scope: { kind: "toolkit" },
    });
    const slack = result.items.find(
      (item) => item.identity.nativeId === "slack",
    );
    assert.ok(slack);
    assert.equal(slack.identity.nativeVersion, "unversioned");
    assert.ok(
      result.issues.some((issue) => issue.code === "composio.version.absent"),
      "the absent version is reported rather than assumed",
    );
  });

  it("separates auth configs from toolkits and marks the approved ones", async () => {
    const h = await start();
    const result = await h.adapter.discover!(h.context(), {
      scope: { kind: "auth-config" },
    });
    const [request] = h.double.received("GET", "/api/v3/auth_configs");
    assert.equal(request?.url.searchParams.get("toolkit_slug"), TOOLKIT);
    const approved = result.items.find(
      (item) => item.identity.nativeId === `auth_config/${AUTH_CONFIG}`,
    );
    const other = result.items.find(
      (item) => item.identity.nativeId === `auth_config/${OTHER_AUTH_CONFIG}`,
    );
    assert.equal(approved?.provenance?.approved, "yes");
    assert.equal(other?.provenance?.approved, "no");
    // The nanoid is preserved verbatim, prefix and all.
    assert.ok(approved!.identity.nativeId.includes("ac_"));
  });

  it("never lets an auth config's credentials reach a discovery result", async () => {
    const h = await start();
    const result = await h.adapter.discover!(h.context(), {
      scope: { kind: "auth-config" },
    });
    const text = stringsIn(result).join(" ");
    for (const canary of canaryValues)
      assert.ok(!text.includes(canary), `projected canary ${canary}`);
  });

  it("reports a non-hosted auth scheme as blocking when it is approved", async () => {
    const h = await start({
      binding: {
        settings: {
          toolkit: { slug: TOOLKIT, version: TOOLKIT_VERSION },
          authConfigs: [OTHER_AUTH_CONFIG],
          tools: [READ_TOOL],
        },
      },
    });
    const result = await h.adapter.discover!(h.context(), {
      scope: { kind: "auth-config" },
    });
    const issue = result.issues.find(
      (item) => item.code === "composio.auth-scheme.not-hosted",
    );
    assert.ok(issue);
    assert.equal(issue.severity, "blocking");
    assert.equal(issue.executionImpact, "blocks-authorization");
  });

  it("lists connected accounts for the derived user, never a supplied one", async () => {
    const h = await start({
      double: { accounts: [account(), account({ id: ACCOUNT_B })] },
    });
    const result = await h.adapter.discover!(h.context(), {
      scope: { kind: "connected-account", user_id: "attacker-chosen" },
    });
    const [request] = h.double.received("GET", "/api/v3/connected_accounts");
    assert.deepEqual(request?.url.searchParams.getAll("user_ids"), [h.userId]);
    assert.deepEqual(request?.url.searchParams.getAll("auth_config_ids"), [
      AUTH_CONFIG,
    ]);
    assert.deepEqual(request?.url.searchParams.getAll("toolkit_slugs"), [
      TOOLKIT,
    ]);
    assert.equal(result.items.length, 2);
    assert.ok(
      !request!.url.search.includes("attacker-chosen"),
      "a scope key is not a user identity",
    );
  });

  it("derives a different Composio user per tenant and owner kind", () => {
    const base = {
      tenantId: TENANT,
      ownerKind: "user" as const,
      ownerId: "s1",
    };
    const other = { ...base, tenantId: "tenant-b" };
    const organization = { ...base, ownerKind: "organization" as const };
    assert.notEqual(composioUserId(base), composioUserId(other));
    assert.notEqual(composioUserId(base), composioUserId(organization));
    assert.equal(composioUserId(base), composioUserId({ ...base }));
    assert.notEqual(
      composioUserId(base),
      composioUserId(base, new TextEncoder().encode("host-key")),
    );
    assert.match(composioUserId(base), /^cer_[0-9a-f]{64}$/);
    assert.ok(!composioUserId(base).includes(canaries.email));
  });

  it("drops an account the broker returned for another user or auth config", async () => {
    const h = await start({
      double: {
        accounts: [
          account(),
          account({ id: ACCOUNT_B, user_id: "cer_someone_else" }),
          account({
            id: "ca_fixtureaccountccc",
            auth_config: { id: OTHER_AUTH_CONFIG, auth_scheme: "API_KEY" },
          }),
        ],
      },
    });
    const result = await h.adapter.discover!(h.context(), {
      scope: { kind: "connected-account" },
    });
    assert.deepEqual(
      result.items.map((item) => item.provenance?.id),
      [ACCOUNT_A],
    );
  });

  it("carries versioned capability metadata for each tool", async () => {
    const h = await start();
    const result = await h.adapter.discover!(h.context(), {
      scope: { kind: "tool" },
    });
    const read = result.items.find(
      (item) => item.provenance?.slug === READ_TOOL,
    );
    assert.ok(read);
    assert.equal(read.identity.nativeId, `${TOOLKIT}/${READ_TOOL}`);
    assert.equal(read.identity.nativeVersion, TOOLKIT_VERSION);
    assert.equal(
      read.provenance?.availableVersions,
      `${TOOLKIT_VERSION},${OLD_VERSION}`,
    );
    assert.ok(
      result.items.some((item) => item.provenance?.slug === WRITE_TOOL),
    );
  });

  it("rejects an unknown discovery scope rather than guessing one", async () => {
    const h = await start();
    await assert.rejects(
      () => h.adapter.discover!(h.context(), { scope: { kind: "everything" } }),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "invalid-request",
    );
  });

  it("reports configuration readiness per dimension", async () => {
    const h = await start();
    const ready = capabilityFor(h.adapter, "discover", [
      composioConfigurationNames.apiKey,
    ]);
    const missing = capabilityFor(h.adapter, "discover", []);
    assert.equal(ready?.configuration, "ready");
    assert.equal(missing?.configuration, "missing");
    assert.equal(ready?.evidence, "protocol-fixture");
    const events = capabilityFor(h.adapter, "events", [
      composioConfigurationNames.apiKey,
    ]);
    assert.equal(events?.implementation, "unsupported");
    assert.equal(events?.evidence, "not-tested");
    assert.deepEqual(h.adapter.custody, [
      "external-credential-broker",
      "external-execution-broker",
    ]);
  });

  it("reports every dimension exactly as the adapter implements it", async () => {
    // A published column an adapter cannot serve is worse than an honest
    // absence, and a negative capability an adapter does serve understates
    // what a host can rely on. The declaration is checked against the methods
    // rather than trusted: `delegate` has no method here (a session tool is
    // `invoke` on a bound `session:<TOOL>` route), while `revoke` has one and
    // answers that Composio documents no provider-side revocation.
    const h = await start();
    const present = [composioConfigurationNames.apiKey];
    const dimensions: Array<[string, keyof typeof h.adapter]> = [
      ["discover", "discover"],
      ["authorize", "authorize"],
      ["reconnect", "reconnect"],
      ["verify", "verify"],
      ["invoke", "invoke"],
      ["disconnect", "disconnect"],
      ["revoke", "revoke"],
      ["delegate", "delegate"],
      ["import", "import"],
      ["export", "export"],
    ];
    for (const [dimension, method] of dimensions) {
      const row = capabilityFor(h.adapter, dimension, present);
      assert.equal(
        row?.implementation === "implemented",
        typeof h.adapter[method] === "function",
        `${dimension} is reported as ${row?.implementation} but the method is ${typeof h.adapter[method]}`,
      );
    }
  });
});
