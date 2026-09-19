import assert from "node:assert/strict";
import test from "node:test";
import {
  runtimeBindingSchema,
  type RuntimeBinding,
} from "../../../src/server/connectors/binding.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type {
  AdapterCallContext,
  ConnectionRecord,
} from "../../../src/server/connectors/index.js";
import {
  createMergeAdapter,
  mergeConfigurationNames,
} from "../../../src/server/connectors/providers/merge/index.js";
import { startMergeApiDouble } from "../doubles/merge-api.js";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import {
  accountA,
  accountB,
  ACCOUNT_A_PUBLIC,
  ACCOUNT_A_TOKEN,
  ACCOUNT_B_TOKEN,
  incompleteAccount,
  relinkAccount,
} from "../fixtures/merge/accounts.js";

/*
 * Merge as an external credential broker. Merge holds the provider's
 * credentials; the account token is Ceremony's own credential and lives in
 * custody. The double enforces the documented header rules independently, so a
 * call that reached it proves the right headers were sent, and a call that did
 * not reach it proves the adapter refused first.
 */

function bindingFor(
  origin: string,
  overrides: Partial<RuntimeBinding> = {},
): RuntimeBinding {
  return runtimeBindingSchema.parse({
    bindingRef: "binding:merge:1",
    definitionRef: "def:merge:1",
    revision: 1,
    adapterId: "merge",
    adapterVersion: "2026.09.18",
    runtime: "hosted-server",
    custody: "external-credential-broker",
    authorityInstance: origin,
    status: "approved",
    approvedAt: "2026-09-18T00:00:00.000Z",
    policyRevision: "policy-1",
    tenantId: fixtureActor.tenantId,
    destinations: [{ id: "api", origin, network: "loopback-fixture" }],
    operations: [
      {
        operationRef: "op:employees.list",
        nativeId: "hris.employees.list",
        destinationId: "api",
        transport: {
          kind: "http",
          method: "GET",
          pathTemplate: "/hris/v1/employees",
        },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
      {
        operationRef: "op:groups.list",
        nativeId: "hris.groups.list",
        destinationId: "api",
        transport: {
          kind: "http",
          method: "GET",
          pathTemplate: "/hris/v1/groups",
        },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
      {
        operationRef: "op:passthrough.timeoff",
        nativeId: "hris.passthrough.time-off-policies",
        destinationId: "api",
        transport: {
          kind: "delegated",
          route: "GET /v1/time_off_policies",
        },
        effect: "read",
        outputClassification: "personal",
        cost: "metered",
        consent: "confirm",
        replay: "read-only",
        targetParameters: [],
      },
    ],
    configuration: [mergeConfigurationNames.apiKey],
    permittedTargets: [
      { kind: "merge-linked-account", id: accountA.id },
      { kind: "merge-linked-account", id: accountB.id },
    ],
    reviewedDigest: "c".repeat(64),
    settings: {
      "merge.categories": ["hris"],
      "merge.endUsers": {
        [fixtureActor.subjectId]: {
          originId: accountA.endUserOriginId,
          organization: "Acme",
          email: "ops@acme.test",
        },
      },
      "merge.reads": {
        "op:employees.list": {
          category: "hris",
          model: "employees",
          fields: ["id", "first_name", "last_name", "work_email"],
        },
        "op:groups.list": {
          category: "hris",
          model: "groups",
          fields: ["id", "name"],
        },
      },
      "merge.passthrough": {
        "op:passthrough.timeoff": {
          category: "hris",
          path: "/v1/time_off_policies",
          method: "GET",
        },
      },
    },
    ...overrides,
  });
}

async function harness(
  options: {
    accounts?: Parameters<typeof startMergeApiDouble>[0] extends infer T
      ? T extends { accounts?: infer A }
        ? A
        : never
      : never;
    accountToken?: string;
    linkedAccountId?: string;
    bindingOverrides?: Partial<RuntimeBinding>;
    doubleOptions?: Parameters<typeof startMergeApiDouble>[0];
  } = {},
) {
  const double = await startMergeApiDouble({
    accounts: [accountA, accountB, incompleteAccount, relinkAccount],
    ...options.doubleOptions,
  });
  const ports = memoryPorts({ now: () => 1_770_000_000_000 });
  ports.configuration.set(mergeConfigurationNames.apiKey, double.apiKey);
  const binding = bindingFor(double.origin, options.bindingOverrides ?? {});
  const record: ConnectionRecord = {
    connectionRef: "conn:merge:1",
    bindingRef: binding.bindingRef,
    definitionRef: binding.definitionRef,
    ecosystem: "merge",
    service: "merge",
    displayName: "Merge linked account",
    ownerKind: "user",
    custody: "external-credential-broker",
    runtime: "hosted-server",
    lifecycle: "active",
    generation: 1,
    revision: 1,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    tenantId: fixtureActor.tenantId,
    ownerId: fixtureActor.subjectId,
    authorityInstance: binding.authorityInstance,
    bindingRevision: binding.revision,
    policyRevision: binding.policyRevision,
    configurationRevision: "cfg:1",
    externalIds: options.linkedAccountId
      ? { linkedAccountId: options.linkedAccountId }
      : {},
    evidenceRefs: [],
    state: {},
  };
  if (options.accountToken !== undefined) {
    record.credentialRef = await ports.credentials.store(
      {
        tenantId: record.tenantId,
        ownerKind: record.ownerKind,
        ownerId: record.ownerId,
        connectionRef: record.connectionRef,
        bindingRef: record.bindingRef,
        custody: "external-credential-broker",
      },
      { accountToken: options.accountToken },
    );
  }
  await ports.connections.create(record);
  const controller = new AbortController();
  const ctx: AdapterCallContext = {
    actor: fixtureActor,
    binding,
    connection: record,
    generation: 1,
    signal: controller.signal,
    environment: ports.environment({ fetch: globalThis.fetch }),
  };
  return {
    double,
    ports,
    ctx,
    binding,
    adapter: createMergeAdapter(),
    async close() {
      controller.abort();
      await double.close();
    },
  };
}

const rejects = (detail: string) => (error: unknown) =>
  error instanceof ConnectorError && error.detail === detail;

test("the adapter declares external-credential-broker custody and the documented configuration", () => {
  const adapter = createMergeAdapter();
  assert.equal(adapter.id, "merge");
  assert.equal(adapter.ecosystem, "merge");
  assert.deepEqual([...adapter.custody], ["external-credential-broker"]);
  assert.deepEqual(
    adapter.configuration
      .filter((item) => item.required)
      .map((item) => item.name),
    ["MERGE_API_KEY"],
  );
  assert.equal(
    adapter.configuration.find((item) => item.name === "MERGE_API_KEY")
      ?.classification,
    "secret",
  );
  const ready = adapter.capabilities(new Set(["MERGE_API_KEY"]));
  assert.equal(
    ready.find((status) => status.dimension === "invoke")?.configuration,
    "ready",
  );
  assert.ok(
    ready
      .find((status) => status.dimension === "delegate")
      ?.limitations.some((text) => text.includes("fixed in the binding")),
  );
  assert.equal(
    adapter.capabilities(new Set()).find((s) => s.dimension === "invoke")
      ?.configuration,
    "missing",
  );
});

test("link token creation derives the end user from the host mapping and keeps the token private", async () => {
  const h = await harness();
  try {
    const start = await h.adapter.authorize!(h.ctx, {
      ownerKind: "user",
      requestedPermissions: [],
      accountSwitch: false,
      interruption: "allowed",
    });
    assert.equal(start.kind, "handoff");
    if (start.kind !== "handoff") throw new Error("unreachable");
    assert.equal(start.handoff.kind, "connect-widget");
    assert.equal(start.handoff.presentation, "popup");
    assert.equal(start.handoff.correlationKey, accountA.endUserOriginId);
    // The link token is private material, never a public field.
    assert.equal(start.handoff.private.linkToken, "link-token-1");

    const [request] = h.double.linkTokenRequests;
    assert.equal(request?.end_user_origin_id, accountA.endUserOriginId);
    assert.equal(request?.end_user_organization_name, "Acme");
    assert.equal(request?.end_user_email_address, "ops@acme.test");
    assert.deepEqual(request?.categories, ["hris"]);
    assert.equal(request?.link_expiry_mins, 30);
  } finally {
    await h.close();
  }
});

test("an unmapped subject cannot start a Link session for someone else", async () => {
  const h = await harness({
    bindingOverrides: {
      settings: { "merge.categories": ["hris"], "merge.endUsers": {} },
    },
  });
  try {
    await assert.rejects(
      () =>
        h.adapter.authorize!(h.ctx, {
          ownerKind: "user",
          requestedPermissions: [],
          accountSwitch: false,
          interruption: "allowed",
        }),
      rejects("merge.end-user.unmapped"),
    );
    assert.equal(h.double.linkTokenRequests.length, 0);
  } finally {
    await h.close();
  }
});

test("a policy forbidding interruption yields human-required, not a bypass", async () => {
  const h = await harness();
  try {
    const start = await h.adapter.authorize!(h.ctx, {
      ownerKind: "user",
      requestedPermissions: [],
      accountSwitch: false,
      interruption: "none",
    });
    assert.equal(start.kind, "human-required");
    assert.equal(h.double.linkTokenRequests.length, 0);
  } finally {
    await h.close();
  }
});

test("the public token is exchanged once and the account token is stored in custody", async () => {
  const h = await harness();
  try {
    const result = await h.adapter.complete!(h.ctx, {
      kind: "input",
      values: { publicToken: ACCOUNT_A_PUBLIC },
    });
    assert.equal(result.state, "complete");
    assert.equal(result.target?.id, accountA.id);
    assert.equal(result.externalIds?.linkedAccountId, accountA.id);
    assert.ok(result.credentialRef);
    // The account token never appears in the completion result.
    assert.equal(JSON.stringify(result).includes(ACCOUNT_A_TOKEN), false);
    // It is in custody, reachable only through the credential port.
    assert.deepEqual(
      h.ports.inspect.credentialMaterial(result.credentialRef!),
      { accountToken: ACCOUNT_A_TOKEN },
    );
    assert.equal(
      result.claims[0]?.issuer,
      "external-broker",
      "the claim's issuer is the broker, not the provider",
    );

    // A replayed exchange does not call the exchange endpoint again.
    const replay = await h.adapter.complete!(h.ctx, {
      kind: "input",
      values: { publicToken: ACCOUNT_A_PUBLIC },
    });
    assert.equal(replay.code, "merge.account-token.replayed");
    assert.equal(
      h.double.received(
        "GET",
        `/api/integrations/account-token/${ACCOUNT_A_PUBLIC}`,
      ).length,
      1,
    );
  } finally {
    await h.close();
  }
});

test("verify reports the linked account status Merge gives, without reinterpreting it", async () => {
  const complete = await harness({
    accountToken: ACCOUNT_A_TOKEN,
    linkedAccountId: accountA.id,
  });
  try {
    const result = await complete.adapter.verify!(complete.ctx);
    assert.equal(result.state, "complete");
    assert.equal(result.target?.id, accountA.id);
    assert.ok(
      result.claims[0]?.limitations.some((text) =>
        text.includes("Merge holds the upstream credential"),
      ),
    );
    assert.deepEqual(result.claims[0]?.permissions?.observed, []);
    assert.equal(result.claims[0]?.permissions?.semantics, "unknown");
    // The account token went in the documented header.
    const call = complete.double.received(
      "GET",
      "/api/hris/v1/account-details",
    )[0];
    assert.equal(call?.headers["x-account-token"], ACCOUNT_A_TOKEN);
    assert.equal(
      call?.headers.authorization,
      `Bearer ${complete.double.apiKey}`,
    );
  } finally {
    await complete.close();
  }

  const relink = await harness({
    accountToken: relinkAccount.accountToken,
    linkedAccountId: relinkAccount.id,
  });
  try {
    const result = await relink.adapter.verify!(relink.ctx);
    assert.equal(result.state, "human-required");
    assert.equal(result.code, "merge.account.relink-needed");
    assert.deepEqual(result.claims, []);
    // The provider's status detail text is not echoed.
    assert.equal(JSON.stringify(result).includes("no longer valid"), false);
  } finally {
    await relink.close();
  }

  const incomplete = await harness({
    accountToken: incompleteAccount.accountToken,
    linkedAccountId: incompleteAccount.id,
  });
  try {
    const result = await incomplete.adapter.verify!(incomplete.ctx);
    assert.equal(result.state, "pending");
    assert.equal(result.code, "merge.account.incomplete");
  } finally {
    await incomplete.close();
  }
});

test("a token that resolves to another linked account is refused, not accepted", async () => {
  const h = await harness({
    accountToken: ACCOUNT_B_TOKEN,
    linkedAccountId: accountA.id,
  });
  try {
    const result = await h.adapter.verify!(h.ctx);
    assert.equal(result.state, "denied");
    assert.equal(result.code, "merge.account.mismatch");
  } finally {
    await h.close();
  }
});

test("AC-EXT-15: two accounts expose different fields and nothing is fabricated", async () => {
  const a = await harness({
    accountToken: ACCOUNT_A_TOKEN,
    linkedAccountId: accountA.id,
  });
  let accountAResult: unknown;
  try {
    const result = await a.adapter.invoke!(a.ctx, {
      operationRef: "op:employees.list",
      commandId: "cmd-a",
      input: {},
    });
    accountAResult = result.output;
    const output = result.output as {
      results: Array<{
        fields: Record<string, unknown>;
        unsupportedFields?: string[];
      }>;
    };
    assert.equal(output.results.length, 2);
    assert.deepEqual(Object.keys(output.results[0]!.fields).sort(), [
      "first_name",
      "id",
      "last_name",
      "work_email",
    ]);
    assert.equal(output.results[0]!.fields.work_email, "ada@acme.test");
    assert.equal(output.results[0]!.unsupportedFields, undefined);
  } finally {
    await a.close();
  }

  const b = await harness({
    accountToken: ACCOUNT_B_TOKEN,
    linkedAccountId: accountB.id,
  });
  try {
    const result = await b.adapter.invoke!(b.ctx, {
      operationRef: "op:employees.list",
      commandId: "cmd-b",
      input: {},
    });
    const output = result.output as {
      results: Array<{
        fields: Record<string, unknown>;
        unsupportedFields?: string[];
      }>;
    };
    assert.equal(output.results.length, 1);
    // work_email is absent for this account and is reported as unsupported,
    // not as null, not as "" and not borrowed from the other account.
    assert.deepEqual(output.results[0]!.unsupportedFields, ["work_email"]);
    assert.equal(
      Object.hasOwn(output.results[0]!.fields, "work_email"),
      false,
      "absence is preserved as absence",
    );
    assert.equal(JSON.stringify(output).includes("ada@acme.test"), false);
    assert.notDeepEqual(output, accountAResult);
  } finally {
    await b.close();
  }
});

test("AC-EXT-15: a model one account does not support is an error there and works elsewhere", async () => {
  const a = await harness({
    accountToken: ACCOUNT_A_TOKEN,
    linkedAccountId: accountA.id,
  });
  try {
    const result = await a.adapter.invoke!(a.ctx, {
      operationRef: "op:groups.list",
      commandId: "cmd-groups-a",
      input: {},
    });
    assert.equal(result.state, "complete");
  } finally {
    await a.close();
  }

  const b = await harness({
    accountToken: ACCOUNT_B_TOKEN,
    linkedAccountId: accountB.id,
  });
  try {
    await assert.rejects(
      () =>
        b.adapter.invoke!(b.ctx, {
          operationRef: "op:groups.list",
          commandId: "cmd-groups-b",
          input: {},
        }),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "not-found",
      "an unsupported model is reported, not emulated",
    );
  } finally {
    await b.close();
  }
});

test("AC-EXT-15: an account that cannot make requests is denied before reading rows", async () => {
  const h = await harness({
    accountToken: relinkAccount.accountToken,
    linkedAccountId: relinkAccount.id,
  });
  try {
    const result = await h.adapter.invoke!(h.ctx, {
      operationRef: "op:employees.list",
      commandId: "cmd-relink",
      input: {},
    });
    assert.equal(result.state, "denied");
    assert.equal(result.code, "merge.account.cannot-make-request");
    assert.equal(result.output, undefined, "no stale rows were returned");
    assert.equal(h.double.received("GET", "/api/hris/v1/employees").length, 0);
  } finally {
    await h.close();
  }
});

test("account-specific availability is read per account from the documented meta endpoint", async () => {
  const a = await harness({
    accountToken: ACCOUNT_A_TOKEN,
    linkedAccountId: accountA.id,
  });
  try {
    await a.adapter.invoke!(a.ctx, {
      operationRef: "op:employees.list",
      commandId: "cmd-meta-a",
      input: {},
    });
    const meta = a.double.received(
      "GET",
      "/api/hris/v1/employees/meta/post",
    )[0];
    assert.equal(meta?.headers["x-account-token"], ACCOUNT_A_TOKEN);
  } finally {
    await a.close();
  }
});

test("discovery lists only the mapped end user's linked accounts", async () => {
  const h = await harness();
  try {
    const result = await h.adapter.discover!(h.ctx, {});
    assert.deepEqual(
      result.items.map((item) => item.identity.nativeId),
      [accountA.id],
    );
    assert.equal(result.items[0]?.provenance?.status, "COMPLETE");
    assert.equal(result.items[0]?.provenance?.passthroughAvailable, "true");
    const call = h.double.received("GET", "/api/hris/v1/linked-accounts")[0];
    assert.equal(
      call?.url.searchParams.get("end_user_origin_id"),
      accountA.endUserOriginId,
    );
    // Listing linked accounts needs only the API key, as documented.
    assert.equal(call?.headers["x-account-token"], undefined);
  } finally {
    await h.close();
  }
});

test("a category the binding did not approve is refused", async () => {
  const h = await harness();
  try {
    await assert.rejects(
      () => h.adapter.discover!(h.ctx, { scope: { category: "ats" } }),
      rejects("merge.category.unapproved"),
    );
    assert.equal(
      h.double.received("GET", "/api/ats/v1/linked-accounts").length,
      0,
    );
  } finally {
    await h.close();
  }
});

test("passthrough uses the route fixed in the binding and sends the account token", async () => {
  const h = await harness({
    accountToken: ACCOUNT_A_TOKEN,
    linkedAccountId: accountA.id,
  });
  try {
    const result = await h.adapter.delegate!(h.ctx, {
      skill: "op:passthrough.timeoff",
      action: "start",
      commandId: "cmd-pass",
      input: {},
    });
    assert.equal(result.state, "complete");
    const [call] = h.double.passthroughRequests("hris");
    assert.equal(call?.body.method, "GET");
    assert.equal(call?.body.path, "/v1/time_off_policies");
    assert.equal(call?.headers["x-account-token"], ACCOUNT_A_TOKEN);
    // Nothing in the body lets the caller move the request elsewhere.
    assert.equal(call?.body.base_url_override, undefined);
    assert.equal(call?.body.headers, undefined);
    assert.ok(result.effectRef, "passthrough is journaled");
  } finally {
    await h.close();
  }
});

test("AC-EXT-15: an arbitrary passthrough path or URL from input is rejected", async () => {
  const h = await harness({
    accountToken: ACCOUNT_A_TOKEN,
    linkedAccountId: accountA.id,
  });
  try {
    for (const hostile of [
      { path: "/v1/admin/keys" },
      { url: "https://evil.example/steal" },
      { base_url_override: "https://evil.example" },
      { method: "DELETE" },
      { headers: { authorization: "Bearer stolen" } },
    ]) {
      await assert.rejects(
        () =>
          h.adapter.delegate!(h.ctx, {
            skill: "op:passthrough.timeoff",
            action: "start",
            commandId: `cmd-hostile-${Object.keys(hostile)[0]}`,
            input: hostile,
          }),
        (error: unknown) =>
          error instanceof ConnectorError &&
          (error.code === "denied" || error.code === "invalid-request"),
      );
    }
    assert.equal(h.double.passthroughRequests("hris").length, 0);
  } finally {
    await h.close();
  }
});

test("a passthrough operation whose binding route disagrees with the transport is refused", async () => {
  const h = await harness({
    accountToken: ACCOUNT_A_TOKEN,
    linkedAccountId: accountA.id,
    bindingOverrides: {
      settings: {
        "merge.categories": ["hris"],
        "merge.endUsers": {
          [fixtureActor.subjectId]: {
            originId: accountA.endUserOriginId,
            organization: "Acme",
            email: "ops@acme.test",
          },
        },
        "merge.reads": {},
        "merge.passthrough": {
          "op:passthrough.timeoff": {
            category: "hris",
            // Disagrees with the bound transport route.
            path: "/v1/payroll_runs",
            method: "GET",
          },
        },
      },
    },
  });
  try {
    await assert.rejects(
      () =>
        h.adapter.delegate!(h.ctx, {
          skill: "op:passthrough.timeoff",
          action: "start",
          commandId: "cmd-route",
          input: {},
        }),
      rejects("merge.passthrough.route-mismatch"),
    );
    assert.equal(h.double.passthroughRequests("hris").length, 0);
  } finally {
    await h.close();
  }
});

test("a repeated passthrough returns the journaled outcome rather than calling twice", async () => {
  const h = await harness({
    accountToken: ACCOUNT_A_TOKEN,
    linkedAccountId: accountA.id,
  });
  try {
    const first = await h.adapter.delegate!(h.ctx, {
      skill: "op:passthrough.timeoff",
      action: "start",
      commandId: "cmd-repeat",
      input: {},
    });
    const second = await h.adapter.delegate!(h.ctx, {
      skill: "op:passthrough.timeoff",
      action: "start",
      commandId: "cmd-repeat",
      input: {},
    });
    assert.equal(h.double.passthroughRequests("hris").length, 1);
    assert.equal(second.effectRef, first.effectRef);
  } finally {
    await h.close();
  }
});

test("an interrupted passthrough is indeterminate", async () => {
  const h = await harness({
    accountToken: ACCOUNT_A_TOKEN,
    linkedAccountId: accountA.id,
    doubleOptions: {
      accounts: [accountA, accountB],
      failPassthrough: { times: 1, status: 503 },
    },
  });
  try {
    const result = await h.adapter.delegate!(h.ctx, {
      skill: "op:passthrough.timeoff",
      action: "start",
      commandId: "cmd-uncertain",
      input: {},
    });
    assert.equal(result.state, "indeterminate");
    assert.equal(result.code, "merge.passthrough.uncertain");
    assert.equal(
      h.ports.inspect.effects()[0]?.outcome?.status,
      "indeterminate",
    );
  } finally {
    await h.close();
  }
});

test("a read without a stored account token fails rather than using the API key alone", async () => {
  const h = await harness({ linkedAccountId: accountA.id });
  try {
    await assert.rejects(
      () =>
        h.adapter.invoke!(h.ctx, {
          operationRef: "op:employees.list",
          commandId: "cmd-no-token",
          input: {},
        }),
      rejects("merge.account-token.absent"),
    );
    assert.equal(h.double.received("GET", "/api/hris/v1/employees").length, 0);
  } finally {
    await h.close();
  }
});

test("local disconnect drops the token and leaves the linked account at Merge", async () => {
  const h = await harness({
    accountToken: ACCOUNT_A_TOKEN,
    linkedAccountId: accountA.id,
  });
  try {
    const result = await h.adapter.disconnect!(h.ctx, "local");
    assert.equal(result.local, "applied");
    assert.equal(result.broker, "not-attempted");
    assert.equal(result.upstream, "not-attempted");
    assert.deepEqual(h.double.deletedAccounts, []);
    assert.equal(
      h.ports.inspect.credentialMaterial(h.ctx.connection!.credentialRef!),
      undefined,
    );
  } finally {
    await h.close();
  }
});

test("broker deletion is a separate intent, and upstream revocation is reported unsupported", async () => {
  const h = await harness({
    accountToken: ACCOUNT_A_TOKEN,
    linkedAccountId: accountA.id,
  });
  try {
    const broker = await h.adapter.disconnect!(h.ctx, "broker");
    assert.equal(broker.broker, "applied");
    assert.equal(broker.local, "not-attempted");
    assert.deepEqual(h.double.deletedAccounts, [accountA.id]);

    const upstream = await h.adapter.disconnect!(h.ctx, "upstream");
    assert.equal(upstream.upstream, "unsupported");
  } finally {
    await h.close();
  }
});

test("a missing API key is reported as configuration, not as a failure to connect", async () => {
  const h = await harness();
  try {
    h.ports.configuration.set(mergeConfigurationNames.apiKey, undefined);
    const start = await h.adapter.authorize!(h.ctx, {
      ownerKind: "user",
      requestedPermissions: [],
      accountSwitch: false,
      interruption: "allowed",
    });
    assert.equal(start.kind, "configuration-required");
    if (start.kind !== "configuration-required") throw new Error("unreachable");
    assert.deepEqual(start.missing, ["MERGE_API_KEY"]);
    assert.equal(h.double.requests.length, 0);
  } finally {
    await h.close();
  }
});
