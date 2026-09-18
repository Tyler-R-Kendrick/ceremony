import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { ConnectionLifecycle } from "../../../src/core/connectors/index.js";
import { canTransitionLifecycle } from "../../../src/core/connectors/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  composioAccountStatuses,
  composioLifecycle,
  composioUnimplementedEndpoints,
  composioEndpoints,
  isExecutableStatus,
  isTerminalStatus,
  unrestrictedMetaTools,
} from "../../../src/server/connectors/providers/composio/index.js";
import { canaryValues } from "../fixtures/builders.js";
import {
  ACCOUNT_A,
  AUTH_CONFIG,
  READ_TOOL,
  TOOLKIT,
  TOOLKIT_VERSION,
  WRITE_TOOL,
  account,
  activeConnection,
  defaultSettings,
  harness,
  stringsIn,
  type Harness,
} from "./harness.js";

/*
 * CO-04: expiry, inactive and revoked accounts, stale session recovery and
 * version-drift handling, plus the negative-capability report for toolkit
 * features the current account does not support.
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

describe("Composio lifecycle mapping", () => {
  it("translates every documented status into a distinct Ceremony lifecycle", () => {
    const expected: Record<string, ConnectionLifecycle> = {
      INITIALIZING: "authorization-required",
      INITIATED: "human-required",
      ACTIVE: "active",
      INACTIVE: "degraded",
      EXPIRED: "expired",
      FAILED: "reconnect-required",
      REVOKED: "upstream-revoked",
      DELETED: "reconnect-required",
    };
    for (const status of composioAccountStatuses)
      assert.equal(composioLifecycle(status), expected[status], status);
    // A status this adapter has not reviewed is never assumed usable.
    assert.equal(composioLifecycle("SOMETHING_NEW"), "indeterminate");
    assert.equal(composioLifecycle(""), "indeterminate");
  });

  it("keeps every mapped lifecycle reachable from verification", () => {
    for (const status of composioAccountStatuses)
      assert.ok(
        canTransitionLifecycle("verifying", composioLifecycle(status)),
        `verifying -> ${composioLifecycle(status)}`,
      );
  });

  it("marks only ACTIVE as executable, and names the terminal statuses", () => {
    assert.ok(isExecutableStatus("ACTIVE"));
    for (const status of ["INITIATED", "INACTIVE", "EXPIRED", "FAILED"])
      assert.ok(!isExecutableStatus(status), status);
    assert.ok(isTerminalStatus("EXPIRED"));
    assert.ok(!isTerminalStatus("INITIATED"));
  });

  it("reports the native outcome of an expired, inactive or revoked account", async () => {
    const cases: Array<[string, string, string]> = [
      ["EXPIRED", "expired", "composio.account.expired"],
      ["INACTIVE", "denied", "composio.account.inactive"],
      ["REVOKED", "denied", "composio.account.revoked"],
      ["INITIATED", "pending", "composio.account.initiated"],
      ["SOMETHING_NEW", "indeterminate", "composio.account.something-new"],
    ];
    for (const [status, state, code] of cases) {
      const h = await start({ double: { accounts: [account({ status })] } });
      const connection = activeConnection(h.binding);
      const result = await h.adapter.verify!(h.context({ connection }));
      assert.equal(result.state, state, status);
      assert.equal(result.code, code, status);
      assert.equal(
        (result.adapterState as { composioLifecycle?: string })
          .composioLifecycle,
        composioLifecycle(status),
      );
      // Nothing of the broker's credential bag survives verification.
      const text = stringsIn(result).join(" ");
      for (const canary of canaryValues) assert.ok(!text.includes(canary));
    }
  });
});

describe("Composio disconnect and revoke", () => {
  it("unlinks locally without asking Composio for anything", async () => {
    const h = await start({ double: { accounts: [account()] } });
    const connection = activeConnection(h.binding);
    const result = await h.adapter.disconnect!(
      h.context({ connection }),
      "local",
    );
    assert.deepEqual(result, {
      local: "applied",
      broker: "not-attempted",
      upstream: "not-attempted",
    });
    assert.equal(
      h.double.requests.filter((item) => item.method === "DELETE").length,
      0,
    );
  });

  it("refuses a permanent broker deletion unless the deployment enabled it", async () => {
    const h = await start({ double: { accounts: [account()] } });
    const connection = activeConnection(h.binding);
    const result = await h.adapter.disconnect!(
      h.context({ connection }),
      "broker",
    );
    assert.deepEqual(result, {
      local: "not-attempted",
      broker: "unsupported",
      upstream: "not-attempted",
    });
    assert.equal(
      h.double.requests.filter((item) => item.method === "DELETE").length,
      0,
    );
  });

  it("deletes the connected account when the deployment enabled it, and claims nothing upstream", async () => {
    const h = await start({
      double: { accounts: [account()] },
      adapter: { allowBrokerDeletion: true },
    });
    const connection = activeConnection(h.binding);
    const result = await h.adapter.disconnect!(
      h.context({ connection }),
      "broker",
    );
    assert.deepEqual(result, {
      local: "not-attempted",
      broker: "applied",
      upstream: "not-attempted",
    });
    assert.equal(
      h.double.received("DELETE", `/api/v3/connected_accounts/${ACCOUNT_A}`)
        .length,
      1,
    );
    assert.equal(
      h.double.accounts.find((item) => item.id === ACCOUNT_A)?.status,
      "DELETED",
    );
  });

  it("reports upstream revocation as a native limitation, not as a deletion", async () => {
    const h = await start({
      double: { accounts: [account()] },
      adapter: { allowBrokerDeletion: true },
    });
    const connection = activeConnection(h.binding);
    const upstream = await h.adapter.disconnect!(
      h.context({ connection }),
      "upstream",
    );
    assert.equal(upstream.upstream, "unsupported");
    const revoked = await h.adapter.revoke!(h.context({ connection }));
    assert.deepEqual(revoked, {
      local: "not-attempted",
      broker: "not-attempted",
      upstream: "unsupported",
    });
    assert.equal(
      h.double.requests.filter((item) => item.method === "DELETE").length,
      0,
      "revoke performs no broker deletion",
    );
  });
});

describe("Composio negative-capability report", () => {
  it("names every approved tool the current account cannot use", async () => {
    const GHOST = "GITHUB_GHOST_TOOL";
    const h = await start({
      double: {
        toolkits: [
          {
            slug: TOOLKIT,
            name: "GitHub",
            enabled: true,
            composio_managed_auth_schemes: ["OAUTH2"],
            auth_config_details: [
              {
                mode: "OAUTH2",
                name: "GitHub OAuth",
                required_scopes: ["repo"],
              },
            ],
            meta: { toolkit_version: TOOLKIT_VERSION },
          },
        ],
        authConfigs: [
          {
            id: AUTH_CONFIG,
            auth_scheme: "OAUTH2",
            toolkit: { slug: TOOLKIT },
            restrict_to_following_tools: [READ_TOOL],
          },
        ],
        accounts: [account({ status: "INACTIVE" })],
        tools: [
          {
            slug: READ_TOOL,
            version: TOOLKIT_VERSION,
            available_versions: [TOOLKIT_VERSION],
            scopes: ["repo"],
            toolkit: { slug: TOOLKIT },
          },
          {
            slug: WRITE_TOOL,
            version: TOOLKIT_VERSION,
            available_versions: [TOOLKIT_VERSION],
            scopes: ["admin:org"],
            deprecated: { is_deprecated: true },
            toolkit: { slug: TOOLKIT },
          },
        ],
      },
      binding: {
        settings: defaultSettings({ tools: [READ_TOOL, WRITE_TOOL, GHOST] }),
      },
    });
    const connection = activeConnection(h.binding);
    const report = await h.adapter.discover!(h.context({ connection }), {
      scope: { kind: "negative-capabilities" },
    });
    assert.deepEqual(report.items, []);
    const codes = report.issues.map((issue) => issue.code).sort();
    assert.deepEqual(
      [...new Set(codes)],
      [
        "composio.account.not-active",
        "composio.tool.absent",
        "composio.tool.deprecated",
        "composio.tool.restricted",
        "composio.tool.scope-missing",
      ],
    );
    for (const issue of report.issues) {
      if (issue.severity === "blocking")
        assert.notEqual(issue.executionImpact, "none", issue.code);
      if (issue.severity === "info")
        assert.equal(issue.executionImpact, "none");
    }
    const deprecated = report.issues.find(
      (issue) => issue.code === "composio.tool.deprecated",
    );
    assert.equal(deprecated?.severity, "warning");
    assert.equal(deprecated?.executionImpact, "none");
    // Producing the report runs no tool.
    assert.equal(
      h.double.requests.filter((item) =>
        item.url.pathname.includes("/tools/execute/"),
      ).length,
      0,
    );
  });

  it("records the documented operations it drives and the ones it does not", () => {
    for (const value of Object.values(composioEndpoints))
      assert.match(value, /^(GET|POST|PATCH|DELETE) \/api\/v3\//);
    const unimplemented = Object.keys(composioUnimplementedEndpoints);
    assert.ok(
      unimplemented.includes("POST /api/v3/connected_accounts/link"),
      "the auth-link session endpoint is recorded as not driven",
    );
    for (const reason of Object.values(composioUnimplementedEndpoints))
      assert.ok(reason.length > 20, reason);
    assert.ok(unrestrictedMetaTools.has("COMPOSIO_MANAGE_CONNECTIONS"));
    assert.ok(unrestrictedMetaTools.has("COMPOSIO_REMOTE_BASH_TOOL"));
    assert.ok(!unrestrictedMetaTools.has("COMPOSIO_GET_TOOL_SCHEMAS"));
  });

  it("reports an error that arrives without a connection as not found", async () => {
    const h = await start({ double: { accounts: [account()] } });
    await assert.rejects(
      () => h.adapter.verify!(h.context()),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "composio.connection.missing",
    );
  });
});
