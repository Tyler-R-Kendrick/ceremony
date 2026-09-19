import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type {
  AuthorizationIntent,
  AuthorizationStart,
} from "../../../src/server/connectors/adapter.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type { HandoffRecord } from "../../../src/server/connectors/ports.js";
import { canaryValues } from "../fixtures/builders.js";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  AUTH_CONFIG,
  OTHER_AUTH_CONFIG,
  READ_TOOL,
  TOOLKIT,
  TOOLKIT_VERSION,
  account,
  activeConnection,
  defaultSettings,
  harness,
  makeConnection,
  stringsIn,
  type Harness,
} from "./harness.js";

/*
 * CO-02: constrained account authorization and connect sessions, selection and
 * reconnect, private human links, authoritative account verification, and
 * native lifecycle mapping. Oracle AC-EXT-03 lives here and in execute.test.ts.
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

function intent(
  overrides: Partial<AuthorizationIntent> = {},
): AuthorizationIntent {
  return {
    ownerKind: "user",
    requestedPermissions: ["repo"],
    accountSwitch: false,
    interruption: "allowed",
    ...overrides,
  };
}

function handoffRecord(
  start: Extract<AuthorizationStart, { kind: "handoff" }>,
  overrides: Partial<HandoffRecord> = {},
): HandoffRecord {
  return {
    ...start.handoff,
    handoffRef: "handoff:composio-1",
    connectionRef: "connection:composio-1",
    bindingRef: "binding:composio-1",
    generation: 0,
    tenantId: "tenant-a",
    subjectId: "subject-1",
    sessionId: "session-1",
    state: "issued",
    issuedAt: 0,
    ...overrides,
  };
}

/**
 * A binding that pins no connected account, which is what a host uses to
 * onboard one: an account that does not exist yet cannot appear in a list
 * approved earlier.
 */
const unpinned = {
  permittedTargets: [{ kind: "github-owner", id: "octocat" }],
};

function bodyOf(request: { body: Buffer }): Record<string, unknown> {
  return JSON.parse(request.body.toString("utf8")) as Record<string, unknown>;
}

describe("Composio authorization", () => {
  it("creates a connected account with the documented request body", async () => {
    const h = await start({ binding: unpinned });
    const result = await h.adapter.authorize!(h.context(), intent());
    assert.equal(result.kind, "handoff");
    const [request] = h.double.received("POST", "/api/v3/connected_accounts");
    assert.ok(request);
    const body = bodyOf(request);
    assert.deepEqual(body.auth_config, { id: AUTH_CONFIG });
    const connection = body.connection as Record<string, unknown>;
    assert.equal(connection.user_id, h.userId);
    assert.deepEqual(connection.state, { authScheme: "OAUTH2", val: {} });
    const callback = new URL(String(connection.callback_url));
    // The return route is built from the deployment origin, never from input.
    assert.equal(callback.origin, "https://app.example");
    assert.equal(callback.pathname, "/api/v1/connectors/composio/return");
    assert.ok(callback.searchParams.get("state"));
  });

  it("keeps the hosted authorization URL inside the private handoff bag", async () => {
    const h = await start({ binding: unpinned });
    const result = await h.adapter.authorize!(h.context(), intent());
    assert.equal(result.kind, "handoff");
    if (result.kind !== "handoff") return;
    const url = result.handoff.private.url ?? "";
    assert.ok(url.startsWith(h.double.origin));
    assert.equal(result.handoff.kind, "provider-browser");
    assert.equal(result.handoff.presentation, "popup");
    // Nothing outside `private` may carry the link, the account id or the user.
    const { private: hidden, ...visible } = result.handoff;
    void hidden;
    const text = stringsIn({ ...result, handoff: visible }).join(" ");
    assert.ok(!text.includes(h.double.origin));
    assert.ok(!text.includes(ACCOUNT_A));
    assert.ok(!text.includes(h.userId));
    for (const canary of canaryValues) assert.ok(!text.includes(canary));
  });

  it("refuses a hosted URL from an origin the binding did not approve", async () => {
    const h = await start({
      binding: { ...unpinned, connectOrigin: "https://connect.example" },
    });
    await assert.rejects(
      () => h.adapter.authorize!(h.context(), intent()),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "network-policy" &&
        error.detail === "composio.redirect.origin",
    );
  });

  it("refuses a hosted URL when no origin was approved at all", async () => {
    // Nothing requires a `connect` destination and the adapter was built with
    // no extra authorization origins, so the allowlist is empty. An empty
    // allowlist is the absence of an approval: whatever Composio answers with,
    // nothing has approved where the initiating human would be sent.
    const h = await start({
      binding: { ...unpinned, omitConnectDestination: true },
    });
    await assert.rejects(
      () => h.adapter.authorize!(h.context(), intent()),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "network-policy" &&
        error.detail === "composio.redirect.origin-unapproved",
    );
  });

  it("refuses an attacker's hosted URL with no approved origin to check it against", async () => {
    // The phishing shape: Composio answers with a page on a host the reviewer
    // never saw, and that link would be rendered to the person who started the
    // authorization. A URL is not evidence of anything just because it is
    // HTTPS, so it is refused rather than handed over.
    const phish = "https://attacker.example/phish";
    const h = await start({
      double: { hostedRedirectUrl: phish },
      binding: { ...unpinned, omitConnectDestination: true },
    });
    await assert.rejects(
      () => h.adapter.authorize!(h.context(), intent()),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "network-policy",
    );
    // The created account exists upstream, but no handoff carries the link.
    assert.equal(h.double.created.length, 1);
  });

  it("still admits a hosted URL on an origin the deployment configured", async () => {
    // The refusal above is about an empty allowlist, not about the `connect`
    // destination being the only way to fill one.
    const h = await start({
      double: { hostedRedirectUrl: "https://backend.composio.dev/s/abc" },
      binding: { ...unpinned, omitConnectDestination: true },
      adapter: { authorizationOrigins: ["https://backend.composio.dev"] },
    });
    const result = await h.adapter.authorize!(h.context(), intent());
    assert.equal(result.kind, "handoff");
    if (result.kind !== "handoff") return;
    assert.equal(
      result.handoff.private.url,
      "https://backend.composio.dev/s/abc",
    );
  });

  it("refuses an auth config the binding did not approve", async () => {
    const h = await start();
    await assert.rejects(
      () =>
        h.adapter.authorize!(
          h.context(),
          intent({ target: { kind: "auth-config", id: OTHER_AUTH_CONFIG } }),
        ),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "composio.auth-config.unapproved",
    );
    assert.equal(
      h.double.received("POST", "/api/v3/connected_accounts").length,
      0,
    );
  });

  it("reports an API-key auth config as unsupported instead of collecting a credential", async () => {
    const h = await start({
      binding: {
        ...unpinned,
        settings: defaultSettings({ authConfigs: [OTHER_AUTH_CONFIG] }),
      },
    });
    const result = await h.adapter.authorize!(h.context(), intent());
    assert.deepEqual(result, {
      kind: "unsupported",
      code: "composio.auth-scheme.not-hosted",
    });
    assert.equal(
      h.double.received("POST", "/api/v3/connected_accounts").length,
      0,
    );
  });

  it("will not choose between several active accounts for one toolkit", async () => {
    // AC-EXT-03: the user holds two active GitHub accounts. A heuristic here
    // could hand an agent the more privileged one.
    const h = await start({
      double: { accounts: [account(), account({ id: ACCOUNT_B })] },
      binding: {
        permittedTargets: [
          { kind: "connected-account", id: ACCOUNT_A },
          { kind: "connected-account", id: ACCOUNT_B },
        ],
        settings: defaultSettings({ accountSelection: "single-active" }),
      },
    });
    const result = await h.adapter.authorize!(h.context(), intent());
    assert.deepEqual(result, {
      kind: "human-required",
      code: "composio.account.selection-required",
    });
    assert.equal(
      h.double.received("POST", "/api/v3/connected_accounts").length,
      0,
    );
  });

  it("adopts the one active permitted account only under the single-active policy", async () => {
    const shared: Parameters<typeof harness>[0] = {
      double: { accounts: [account()] },
    };
    const strict = await start({ ...shared, binding: unpinned });
    assert.deepEqual(
      await strict.adapter.authorize!(strict.context(), intent()),
      {
        kind: "human-required",
        code: "composio.account.selection-required",
      },
    );
    const lenient = await start({
      ...shared,
      binding: {
        ...unpinned,
        settings: defaultSettings({ accountSelection: "single-active" }),
      },
    });
    assert.deepEqual(
      await lenient.adapter.authorize!(lenient.context(), intent()),
      { kind: "verify" },
    );
  });

  it("refuses an account outside the binding's permitted targets", async () => {
    const h = await start({
      double: { accounts: [account(), account({ id: ACCOUNT_B })] },
    });
    await assert.rejects(
      () =>
        h.adapter.authorize!(
          h.context(),
          intent({ target: { kind: "connected-account", id: ACCOUNT_B } }),
        ),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "composio.account.not-permitted",
    );
  });

  it("requires explicit switch intent to move a connection to another account", async () => {
    const h = await start({
      double: { accounts: [account(), account({ id: ACCOUNT_B })] },
      binding: {
        permittedTargets: [
          { kind: "connected-account", id: ACCOUNT_A },
          { kind: "connected-account", id: ACCOUNT_B },
        ],
      },
    });
    const connection = activeConnection(h.binding);
    await assert.rejects(
      () =>
        h.adapter.reconnect!(
          h.context({ connection }),
          intent({ target: { kind: "connected-account", id: ACCOUNT_B } }),
        ),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "composio.account.switch-required",
    );
  });

  it("blocks rather than bypasses when interruption is forbidden", async () => {
    const h = await start({ binding: unpinned });
    const result = await h.adapter.authorize!(
      h.context(),
      intent({ interruption: "none" }),
    );
    assert.deepEqual(result, {
      kind: "human-required",
      code: "composio.human.required",
    });
    assert.equal(
      h.double.received("POST", "/api/v3/connected_accounts").length,
      0,
    );
  });

  it("rejects an organization owner rather than promoting a user grant", async () => {
    const h = await start();
    const result = await h.adapter.authorize!(
      h.context(),
      intent({ ownerKind: "organization" }),
    );
    assert.deepEqual(result, {
      kind: "unsupported",
      code: "composio.owner.unsupported",
    });
  });

  it("refuses to mint a new account under a binding pinned to existing ones", async () => {
    const h = await start();
    await assert.rejects(
      () => h.adapter.authorize!(h.context(), intent()),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "composio.account.pin-blocks-new",
    );
    assert.equal(
      h.double.received("POST", "/api/v3/connected_accounts").length,
      0,
    );
  });

  it("completes only against the account the handoff created", async () => {
    const h = await start({ binding: unpinned });
    const started = await h.adapter.authorize!(h.context(), intent());
    assert.equal(started.kind, "handoff");
    if (started.kind !== "handoff") return;
    const handoff = handoffRecord(started);
    const created = h.double.created[0]!;
    h.double.setStatus(created.id, "ACTIVE");
    const connection = makeConnection(h.binding);

    const substituted = new URL(String(handoff.private.url));
    const callback = new URL(
      `https://app.example/api/v1/connectors/composio/return?state=${handoff.correlationKey}&status=success&connected_account_id=${ACCOUNT_B}`,
    );
    void substituted;
    await assert.rejects(
      () =>
        h.adapter.complete!(h.context({ connection, handoff }), {
          kind: "redirect",
          url: callback,
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "composio.account.substituted",
    );

    const wrongState = new URL(
      `https://app.example/api/v1/connectors/composio/return?state=deadbeef&status=success`,
    );
    await assert.rejects(
      () =>
        h.adapter.complete!(h.context({ connection, handoff }), {
          kind: "redirect",
          url: wrongState,
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "composio.callback.correlation",
    );
  });

  it("refuses a callback issued for an older connection generation", async () => {
    const h = await start({ binding: unpinned });
    const started = await h.adapter.authorize!(h.context(), intent());
    if (started.kind !== "handoff") assert.fail("expected a handoff");
    const handoff = handoffRecord(started, { generation: 0 });
    const connection = makeConnection(h.binding, { generation: 1 });
    await assert.rejects(
      () =>
        h.adapter.complete!(h.context({ connection, handoff, generation: 1 }), {
          kind: "redirect",
          url: new URL(
            `https://app.example/return?state=${handoff.correlationKey}`,
          ),
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "composio.handoff.stale-generation",
    );
  });

  it("reads the account back rather than believing the callback's status", async () => {
    const h = await start({ binding: unpinned });
    const started = await h.adapter.authorize!(h.context(), intent());
    if (started.kind !== "handoff") assert.fail("expected a handoff");
    const handoff = handoffRecord(started);
    const connection = makeConnection(h.binding);
    // Composio still has the account at INITIATED; the callback claims success.
    const result = await h.adapter.complete!(
      h.context({ connection, handoff }),
      {
        kind: "redirect",
        url: new URL(
          `https://app.example/return?state=${handoff.correlationKey}&status=success`,
        ),
      },
    );
    assert.equal(result.state, "pending");
    assert.equal(result.code, "composio.account.initiated");
  });

  it("records the native identifiers and broker limits when the account is active", async () => {
    const h = await start({ binding: unpinned });
    const started = await h.adapter.authorize!(h.context(), intent());
    if (started.kind !== "handoff") assert.fail("expected a handoff");
    const handoff = handoffRecord(started);
    const created = h.double.created[0]!;
    h.double.setStatus(created.id, "ACTIVE");
    const result = await h.adapter.complete!(
      h.context({ connection: makeConnection(h.binding), handoff }),
      {
        kind: "redirect",
        url: new URL(
          `https://app.example/return?state=${handoff.correlationKey}&status=success&connected_account_id=${created.id}`,
        ),
      },
    );
    assert.equal(result.state, "complete");
    assert.equal(result.externalIds?.connectedAccountId, created.id);
    assert.equal(result.externalIds?.authConfigId, AUTH_CONFIG);
    assert.equal(result.externalIds?.toolkitSlug, TOOLKIT);
    assert.equal(result.externalIds?.toolkitVersion, TOOLKIT_VERSION);
    assert.deepEqual(result.target, {
      kind: "connected-account",
      id: created.id,
    });
    const kinds = result.claims.map((item) => item.kind).sort();
    assert.deepEqual(kinds, ["account-identity", "credential-accepted"]);
    for (const claim of result.claims) {
      assert.equal(claim.issuer, "external-broker");
      assert.ok(claim.limitations.length > 0);
      // No observed permissions were measured, so none are asserted.
      assert.equal(claim.permissions, undefined);
    }
    const text = stringsIn(result).join(" ");
    for (const canary of canaryValues) assert.ok(!text.includes(canary));
  });

  it("verifies against the connection's own account and refuses a foreign one", async () => {
    const h = await start({ double: { accounts: [account()] } });
    const connection = activeConnection(h.binding);
    const verified = await h.adapter.verify!(h.context({ connection }));
    assert.equal(verified.state, "complete");
    const foreign = activeConnection(h.binding, {
      externalIds: { ...connection.externalIds, connectedAccountId: ACCOUNT_B },
    });
    await assert.rejects(
      () => h.adapter.verify!(h.context({ connection: foreign })),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "composio.account.not-permitted",
    );
  });

  it("refuses a connection whose recorded Composio user is not the caller's", async () => {
    const h = await start({ double: { accounts: [account()] } });
    const connection = activeConnection(h.binding, {
      externalIds: {
        connectedAccountId: ACCOUNT_A,
        authConfigId: AUTH_CONFIG,
        toolkitSlug: TOOLKIT,
        userId: "cer_someone_else",
        authority: h.binding.authorityInstance,
      },
    });
    await assert.rejects(
      () => h.adapter.verify!(h.context({ connection })),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "composio.user.mismatch",
    );
  });

  it("refuses a connection bound to a toolkit this binding does not cover", async () => {
    const h = await start({ double: { accounts: [account()] } });
    const connection = activeConnection(h.binding, {
      externalIds: {
        connectedAccountId: ACCOUNT_A,
        authConfigId: AUTH_CONFIG,
        toolkitSlug: "slack",
        userId: h.userId,
        authority: h.binding.authorityInstance,
      },
    });
    await assert.rejects(
      () => h.adapter.verify!(h.context({ connection })),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "composio.toolkit.mismatch",
    );
    assert.ok(READ_TOOL.length > 0);
  });
});
