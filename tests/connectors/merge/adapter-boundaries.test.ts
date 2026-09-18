import assert from "node:assert/strict";
import test from "node:test";
import {
  runtimeBindingSchema,
  type RuntimeBinding,
} from "../../../src/server/connectors/binding.js";
import {
  ConnectorError,
  type ConnectorErrorCode,
} from "../../../src/server/connectors/errors.js";
import type {
  AdapterCallContext,
  ConnectionRecord,
} from "../../../src/server/connectors/index.js";
import {
  createMergeAdapter,
  mergeConfigurationNames,
} from "../../../src/server/connectors/providers/merge/index.js";
import {
  startHttpFixture,
  type FixtureReply,
  type RecordedRequest,
} from "../doubles/http-fixture.js";
import { startMergeApiDouble } from "../doubles/merge-api.js";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import {
  accountA,
  ACCOUNT_A_TOKEN,
  ACCOUNT_A_PUBLIC,
} from "../fixtures/merge/accounts.js";

/*
 * What the Merge adapter refuses, and whether it refuses for the right reason.
 *
 * `adapter.test.ts` covers the documented happy paths and the headline
 * AC-EXT-15 cases. This file is about the edges an external credential broker
 * lives on: a destination policy never approved, a configured region Merge does
 * not document, a route or category the binding never named, a credential of
 * the wrong shape, an upstream that answers with something malformed or
 * hostile, and effects whose outcome must be reported as uncertain rather than
 * guessed. Every assertion below is about the *reason* for the refusal, because
 * a refusal with the wrong code sends the host to fix the wrong thing: a
 * rotated key for a policy problem, a retry for a permanent rejection.
 *
 * Two upstreams appear here. `startMergeApiDouble` is the documented Merge API,
 * used whenever the point is what a well-behaved Merge would do. `rogueMerge`
 * is a bare loopback fixture that answers however a test needs — a
 * misbehaving, out-of-date or compromised upstream — while still enforcing the
 * one documented rule that every call carries the API key, so a reply that came
 * back still proves the adapter authenticated.
 */

const API_KEY = "merge-api-key";
const EU_REGION_ORIGIN = "https://api-eu.merge.dev";

type Upstream = Awaited<ReturnType<typeof startHttpFixture>>;

async function rogueMerge(
  reply: (
    request: RecordedRequest,
  ) => FixtureReply | Promise<FixtureReply | undefined> | undefined,
): Promise<Upstream> {
  return startHttpFixture((request) => {
    if (request.headers.authorization !== `Bearer ${API_KEY}`)
      return { status: 401, body: { error: "unauthorized" } };
    return reply(request);
  });
}

const endUserMapping = {
  [fixtureActor.subjectId]: {
    originId: accountA.endUserOriginId,
    organization: "Acme",
    email: "ops@acme.test",
  },
};

function settingsFor(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    "merge.categories": ["hris"],
    "merge.endUsers": endUserMapping,
    "merge.reads": {
      "op:employees.list": {
        category: "hris",
        model: "employees",
        fields: ["id", "first_name", "work_email"],
      },
      "op:employees.write": {
        category: "hris",
        model: "employees",
        fields: ["id"],
      },
    },
    "merge.passthrough": {
      "op:passthrough.timeoff": {
        category: "hris",
        path: "/v1/time_off_policies",
        method: "GET",
      },
      "op:passthrough.absence": {
        category: "hris",
        path: "/v1/absences",
        method: "POST",
        requestFormat: "JSON",
      },
    },
    ...overrides,
  };
}

function bindingFor(options: {
  origin: string;
  network?: "public" | "loopback-fixture";
  destinationId?: string;
  destinations?: RuntimeBinding["destinations"];
  settings?: Record<string, unknown>;
}): RuntimeBinding {
  const destinationId = options.destinationId ?? "api";
  return runtimeBindingSchema.parse({
    bindingRef: "binding:merge:1",
    definitionRef: "def:merge:1",
    revision: 1,
    adapterId: "merge",
    adapterVersion: "2026.09.18",
    runtime: "hosted-server",
    custody: "external-credential-broker",
    authorityInstance: options.origin,
    status: "approved",
    approvedAt: "2026-09-18T00:00:00.000Z",
    policyRevision: "policy-1",
    tenantId: fixtureActor.tenantId,
    destinations: options.destinations ?? [
      {
        id: destinationId,
        origin: options.origin,
        network: options.network ?? "loopback-fixture",
      },
    ],
    operations: [
      {
        operationRef: "op:employees.list",
        nativeId: "hris.employees.list",
        destinationId,
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
        /** Approved, but the host never gave it a read route. */
        operationRef: "op:locations.list",
        nativeId: "hris.locations.list",
        destinationId,
        transport: {
          kind: "http",
          method: "GET",
          pathTemplate: "/hris/v1/locations",
        },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
      {
        /** A write the host classified as such; the read path must not run it. */
        operationRef: "op:employees.write",
        nativeId: "hris.employees.create",
        destinationId,
        transport: {
          kind: "http",
          method: "POST",
          pathTemplate: "/hris/v1/employees",
        },
        effect: "write",
        outputClassification: "personal",
        cost: "metered",
        consent: "confirm",
        replay: "none",
        targetParameters: [],
      },
      {
        operationRef: "op:passthrough.timeoff",
        nativeId: "hris.passthrough.time-off-policies",
        destinationId,
        transport: { kind: "delegated", route: "GET /v1/time_off_policies" },
        effect: "read",
        outputClassification: "personal",
        cost: "metered",
        consent: "confirm",
        replay: "read-only",
        targetParameters: [],
      },
      {
        operationRef: "op:passthrough.absence",
        nativeId: "hris.passthrough.absences",
        destinationId,
        transport: { kind: "delegated", route: "POST /v1/absences" },
        effect: "write",
        outputClassification: "personal",
        cost: "metered",
        consent: "confirm",
        replay: "none",
        targetParameters: [],
      },
    ],
    configuration: [mergeConfigurationNames.apiKey],
    permittedTargets: [{ kind: "merge-linked-account", id: accountA.id }],
    reviewedDigest: "d".repeat(64),
    settings: options.settings ?? settingsFor(),
  });
}

async function harness(options: {
  upstream: Upstream;
  /** Overrides the destination origin, for network-policy tests. */
  origin?: string;
  network?: "public" | "loopback-fixture";
  destinationId?: string;
  destinations?: RuntimeBinding["destinations"];
  settings?: Record<string, unknown>;
  /** null leaves MERGE_API_KEY unset. */
  apiKey?: string | null;
  apiOrigin?: string;
  /** Exact credential material to put in custody, if any. */
  material?: Record<string, string>;
  linkedAccountId?: string;
  withConnection?: boolean;
}) {
  const ports = memoryPorts({ now: () => 1_770_000_000_000 });
  if (options.apiKey !== null)
    ports.configuration.set(
      mergeConfigurationNames.apiKey,
      options.apiKey ?? API_KEY,
    );
  if (options.apiOrigin !== undefined)
    ports.configuration.set(
      mergeConfigurationNames.apiOrigin,
      options.apiOrigin,
    );
  const binding = bindingFor({
    origin: options.origin ?? options.upstream.origin,
    ...(options.network ? { network: options.network } : {}),
    ...(options.destinationId ? { destinationId: options.destinationId } : {}),
    ...(options.destinations ? { destinations: options.destinations } : {}),
    ...(options.settings ? { settings: options.settings } : {}),
  });
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
  if (options.material)
    record.credentialRef = await ports.credentials.store(
      {
        tenantId: record.tenantId,
        ownerKind: record.ownerKind,
        ownerId: record.ownerId,
        connectionRef: record.connectionRef,
        bindingRef: record.bindingRef,
        custody: "external-credential-broker",
      },
      options.material,
    );
  await ports.connections.create(record);
  const controller = new AbortController();
  const ctx: AdapterCallContext = {
    actor: fixtureActor,
    binding,
    ...(options.withConnection === false ? {} : { connection: record }),
    generation: 1,
    signal: controller.signal,
    environment: ports.environment({ fetch: globalThis.fetch }),
  };
  return {
    ports,
    binding,
    ctx,
    controller,
    upstream: options.upstream,
    adapter: createMergeAdapter(),
    async close() {
      controller.abort();
      await options.upstream.close();
    },
  };
}

const rejects = (detail: string) => (error: unknown) =>
  error instanceof ConnectorError && error.detail === detail;

const linkedAccount = (overrides: Record<string, unknown>) => ({
  next: null,
  previous: null,
  results: [overrides],
});

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open: () => open() };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition never became true");
}

const readInvocation = { operationRef: "op:employees.list", input: {} };

/* ------------------------------------------------------------------ *
 * Destination and network policy
 * ------------------------------------------------------------------ */

test("a binding that approved no Merge API destination is refused instead of defaulted", async () => {
  // Invariant: the adapter reaches only a destination the host approved under
  // the id it expects. If it fell back to Merge's documented origin whenever
  // the binding named something else, a review that deliberately approved no
  // Merge destination would be silently overridden by a constant in the code.
  const upstream = await rogueMerge(() => ({ body: linkedAccount({}) }));
  const h = await harness({ upstream, destinationId: "backup" });
  try {
    await assert.rejects(
      () => h.adapter.discover!(h.ctx, {}),
      rejects("merge.destination.unapproved"),
    );
    assert.equal(
      h.upstream.requests.length,
      0,
      "nothing was sent while the destination was unresolved",
    );
  } finally {
    await h.close();
  }
});

test("a destination whose origin is not the configured Merge region is refused by network policy", async () => {
  // Invariant: the approved destination and the configured region must be the
  // same host. A binding approved against one region must not be used to talk
  // to another: the account tokens and API key are region-scoped, and a
  // mismatch means the review and the call disagree about where data goes.
  const upstream = await rogueMerge(() => ({ body: linkedAccount({}) }));
  const h = await harness({
    upstream,
    origin: EU_REGION_ORIGIN,
    network: "public",
  });
  try {
    const error = await h.adapter.discover!(h.ctx, {})
      .then(() => undefined)
      .catch((cause: unknown) => cause);
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, "network-policy");
    assert.equal(error.detail, "merge.origin.mismatch");
    assert.equal(h.upstream.requests.length, 0);
  } finally {
    await h.close();
  }
});

test("a configured region Merge does not document is refused even when the destination agrees with it", async () => {
  // Invariant: agreement between configuration and the binding is not enough;
  // the origin must be one Merge actually documents. Otherwise a single edited
  // configuration value plus a matching approval would be sufficient to point
  // every call at a look-alike host, with no mismatch to notice.
  const upstream = await rogueMerge(() => ({ body: linkedAccount({}) }));
  const h = await harness({
    upstream,
    origin: "https://api.merge.dev.attacker.example",
    network: "public",
    apiOrigin: "https://api.merge.dev.attacker.example",
  });
  try {
    const error = await h.adapter.discover!(h.ctx, {})
      .then(() => undefined)
      .catch((cause: unknown) => cause);
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, "invalid-request");
    assert.equal(error.detail, "merge.origin.unknown");
    assert.equal(h.upstream.requests.length, 0);
  } finally {
    await h.close();
  }
});

test("the API key is required at the moment of the call, not only when authorizing", async () => {
  // Invariant: every path that talks to Merge checks the key itself. `authorize`
  // reports a missing key as configuration, but a read or a discovery must not
  // sail past that check and send an unauthenticated request whose 401 would be
  // reported as an upstream problem instead of as missing setup.
  const upstream = await rogueMerge(() => ({ body: linkedAccount({}) }));
  const h = await harness({ upstream, apiKey: null });
  try {
    const error = await h.adapter.discover!(h.ctx, {})
      .then(() => undefined)
      .catch((cause: unknown) => cause);
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, "configuration-required");
    assert.equal(error.detail, "merge.api-key.missing");
    assert.equal(h.upstream.requests.length, 0);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ *
 * What an upstream refusal means
 * ------------------------------------------------------------------ */

test("each upstream refusal keeps its own meaning", async () => {
  // Invariant: the status Merge returns decides the code, and the codes are not
  // interchangeable. 401 means rotate the key, 403 means the policy at Merge
  // says no, 429 means wait, 5xx means try again later, and anything else is a
  // rejection rather than an outage. Collapsing these would make every failure
  // look retryable (or none of them), which is how a permanently broken link
  // gets hammered and a transient one gets abandoned.
  const cases: Array<[number, ConnectorErrorCode, string]> = [
    [400, "invalid-request", "merge.upstream.bad-request"],
    [401, "unauthenticated", "merge.upstream.unauthenticated"],
    [403, "denied", "merge.upstream.denied"],
    [404, "not-found", "merge.upstream.not-found"],
    [409, "conflict", "merge.upstream.conflict"],
    [429, "rate-limited", "merge.upstream.rate-limited"],
    [503, "upstream-unavailable", "merge.upstream.unavailable"],
    [418, "upstream-rejected", "merge.upstream.rejected"],
  ];
  let status = 200;
  const upstream = await rogueMerge(() => ({
    status,
    body: { error: "refused" },
  }));
  const h = await harness({ upstream });
  try {
    for (const [upstreamStatus, code, detail] of cases) {
      status = upstreamStatus;
      const error = await h.adapter.discover!(h.ctx, {})
        .then(() => undefined)
        .catch((cause: unknown) => cause);
      assert.ok(error instanceof ConnectorError, `status ${upstreamStatus}`);
      assert.equal(error.code, code, `status ${upstreamStatus} code`);
      assert.equal(error.detail, detail, `status ${upstreamStatus} detail`);
      // The upstream body is never echoed; only the adapter's own detail is.
      assert.equal(error.message.includes("refused"), false);
    }
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ *
 * A malformed or hostile upstream response
 * ------------------------------------------------------------------ */

test("a response that is not JSON is rejected rather than guessed at", async () => {
  // Invariant: a 200 that is not JSON (a proxy's error page, a captive portal,
  // an HTML login form) is an upstream rejection, not an empty result set. A
  // caller must never read "no linked accounts" out of a page of HTML.
  const upstream = await rogueMerge(() => ({
    body: "<html><body>sign in to continue</body></html>",
  }));
  const h = await harness({ upstream });
  try {
    const error = await h.adapter.discover!(h.ctx, {})
      .then(() => undefined)
      .catch((cause: unknown) => cause);
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, "upstream-rejected");
    assert.equal(error.detail, "merge.response.invalid");
  } finally {
    await h.close();
  }
});

test("a response carrying a reserved object key never reaches the caller", async () => {
  // Invariant: upstream JSON is data, not structure. A body with a `__proto__`
  // key is refused outright, so no later spread, merge or projection of these
  // rows can be used to reshape objects in the server.
  const upstream = await rogueMerge(() => ({
    body: '{"next":null,"previous":null,"results":[{"id":"a","__proto__":{"polluted":true}}]}',
  }));
  const h = await harness({ upstream });
  try {
    const error = await h.adapter.discover!(h.ctx, {})
      .then(() => undefined)
      .catch((cause: unknown) => cause);
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, "invalid-request");
    assert.equal(error.detail, "merge.response.invalid");
    assert.equal(
      ({} as Record<string, unknown>).polluted,
      undefined,
      "no prototype was touched on the way to the refusal",
    );
  } finally {
    await h.close();
  }
});

test("a response nested beyond the adapter's limit is refused instead of walked", async () => {
  // Invariant: validation of an upstream body is bounded. An upstream that
  // answers with a structure nested thousands of levels deep must produce a
  // refusal, not a stack overflow inside the server process, because an
  // unhandled crash takes down work belonging to other tenants too.
  let deep: unknown = "leaf";
  for (let level = 0; level < 400; level++) deep = [deep];
  const upstream = await rogueMerge(() => ({
    body: { next: null, previous: null, results: [{ id: "a", deep }] },
  }));
  const h = await harness({ upstream });
  try {
    const error = await h.adapter.discover!(h.ctx, {})
      .then(() => undefined)
      .catch((cause: unknown) => cause);
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, "invalid-request");
    assert.equal(error.detail, "merge.response.invalid");
  } finally {
    await h.close();
  }
});

test("an oversized response is refused before it is parsed", async () => {
  // Invariant: the response size is bounded before any parsing. Without the
  // bound, a single upstream reply could decide how much memory the server
  // spends, which is a denial of service the host never approved.
  const upstream = await rogueMerge(() => ({
    body: "x".repeat(8 * 1024 * 1024 + 1),
  }));
  const h = await harness({ upstream });
  try {
    const error = await h.adapter.discover!(h.ctx, {})
      .then(() => undefined)
      .catch((cause: unknown) => cause);
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, "invalid-request");
    assert.equal(error.detail, "merge.response.too-large");
  } finally {
    await h.close();
  }
});

test("a page shaped unlike Merge's own is refused on both the discovery and the read path", async () => {
  // Invariant: a body that parses as JSON but is not the documented envelope is
  // an upstream rejection with a path-specific detail, never a partial result.
  // Reporting "0 accounts" or "0 employees" here would read as evidence that
  // the end user has none, which is a different and false statement.
  const upstream = await rogueMerge((request) => {
    if (request.url.pathname === "/api/hris/v1/linked-accounts")
      return { body: { results: "not-a-list" } };
    if (request.url.pathname === "/api/hris/v1/employees/meta/post")
      return {
        body: { request_schema: {}, status: { can_make_request: true } },
      };
    if (request.url.pathname === "/api/hris/v1/employees")
      return { body: { results: { first: { id: "emp-1" } } } };
    return undefined;
  });
  const h = await harness({
    upstream,
    material: { accountToken: ACCOUNT_A_TOKEN },
    linkedAccountId: accountA.id,
  });
  try {
    await assert.rejects(
      () => h.adapter.discover!(h.ctx, {}),
      rejects("merge.linked-accounts.invalid"),
    );
    await assert.rejects(
      () =>
        h.adapter.invoke!(h.ctx, { ...readInvocation, commandId: "cmd-shape" }),
      rejects("merge.read.invalid"),
    );
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ *
 * Reporting absence as absence
 * ------------------------------------------------------------------ */

test("discovery reports what Merge omitted as unknown and never assumes passthrough is available", async () => {
  // Invariant: a sparse linked account is described with what Merge actually
  // said. The display name falls back to the id rather than inventing a
  // provider name, an absent status is "unknown" rather than "active", and
  // `passthroughAvailable` defaults to "false" — the safe direction, since a
  // "true" here would advertise an escape hatch the account may not have.
  const upstream = await rogueMerge((request) =>
    request.url.pathname === "/api/hris/v1/linked-accounts"
      ? {
          body: {
            next: "cursor-2",
            previous: null,
            results: [{ id: "linked-account-sparse" }],
          },
        }
      : undefined,
  );
  const h = await harness({ upstream });
  try {
    const result = await h.adapter.discover!(h.ctx, {});
    const [item] = result.items;
    assert.equal(item?.identity.nativeId, "linked-account-sparse");
    assert.equal(item?.identity.nativeVersion, "unversioned");
    assert.equal(item?.displayName, "linked-account-sparse");
    assert.equal(item?.status, "unknown");
    assert.equal(item?.provenance?.status, "unknown");
    assert.equal(item?.provenance?.passthroughAvailable, "false");
    assert.equal(
      Object.hasOwn(item?.provenance ?? {}, "integrationSlug"),
      false,
      "no integration slug is invented for an account that named none",
    );
    assert.ok(item?.description.includes("unknown"));
    assert.equal(
      result.nextCursor,
      "cursor-2",
      "Merge's own cursor is passed on",
    );
  } finally {
    await h.close();
  }
});

test("verify reports a missing status as unknown rather than assuming the link is complete", async () => {
  // Invariant: `verify` states Merge's report and nothing more. An account
  // whose status Merge omitted is pending-unknown, not complete — a complete
  // verdict is what downstream code treats as a usable connection. And when
  // Merge does say COMPLETE but names no integration or account type, the
  // adapter stores no such facts instead of filling in plausible ones.
  let details: Record<string, unknown> = { id: accountA.id };
  const upstream = await rogueMerge((request) =>
    request.url.pathname === "/api/hris/v1/account-details"
      ? { body: details }
      : undefined,
  );
  const h = await harness({
    upstream,
    material: { accountToken: ACCOUNT_A_TOKEN },
    linkedAccountId: accountA.id,
  });
  try {
    const silent = await h.adapter.verify!(h.ctx);
    assert.equal(silent.state, "pending");
    assert.equal(silent.code, "merge.account.unknown");
    assert.deepEqual(silent.claims, [], "no claim is made without a status");

    details = { id: accountA.id, status: "COMPLETE" };
    const bare = await h.adapter.verify!(h.ctx);
    assert.equal(bare.state, "complete");
    assert.deepEqual(
      bare.adapterState,
      {},
      "no integration slug or account type is invented",
    );

    details = { status: "COMPLETE" };
    await assert.rejects(
      () => h.adapter.verify!(h.ctx),
      rejects("merge.account-details.invalid"),
    );
  } finally {
    await h.close();
  }
});

test("a read whose meta does not describe fields says the availability is unknown", async () => {
  // Invariant: `fieldAvailability.source` is evidence about where the field
  // list came from. When the account's own /meta is unusable the read may still
  // proceed — absent meta is not a denial — but it must be labelled "unknown"
  // rather than "meta", or a caller would believe the projected fields were
  // confirmed against this linked account when they were not.
  const upstream = await rogueMerge((request) => {
    if (request.url.pathname === "/api/hris/v1/employees/meta/post")
      return { body: { status: "not-an-object" } };
    if (request.url.pathname === "/api/hris/v1/employees")
      return {
        body: {
          next: "cursor-9",
          previous: null,
          results: [{ id: "emp-1", first_name: "Ada" }],
        },
      };
    return undefined;
  });
  const h = await harness({
    upstream,
    material: { accountToken: ACCOUNT_A_TOKEN },
    linkedAccountId: accountA.id,
  });
  try {
    const result = await h.adapter.invoke!(h.ctx, {
      ...readInvocation,
      commandId: "cmd-meta-unusable",
    });
    assert.equal(result.state, "complete");
    const output = result.output as {
      results: Array<{
        fields: Record<string, unknown>;
        unsupportedFields?: string[];
      }>;
      next?: string;
      fieldAvailability: { source: string; model: string };
    };
    assert.deepEqual(output.fieldAvailability, {
      source: "unknown",
      model: "employees",
    });
    assert.deepEqual(output.results[0]?.unsupportedFields, ["work_email"]);
    assert.equal(output.next, "cursor-9", "Merge's own cursor is passed on");
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ *
 * Only routes the binding named
 * ------------------------------------------------------------------ */

test("an operation the binding never approved cannot be invoked", async () => {
  // Invariant: the caller names an operation ref, and only a ref the host
  // approved resolves. This is the difference between a bound catalogue and an
  // open proxy.
  const upstream = await rogueMerge(() => ({ body: {} }));
  const h = await harness({
    upstream,
    material: { accountToken: ACCOUNT_A_TOKEN },
    linkedAccountId: accountA.id,
  });
  try {
    await assert.rejects(
      () =>
        h.adapter.invoke!(h.ctx, {
          operationRef: "op:payroll.list",
          input: {},
          commandId: "cmd-unapproved",
        }),
      rejects("merge.operation.unapproved"),
    );
    assert.equal(h.upstream.requests.length, 0);
  } finally {
    await h.close();
  }
});

test("approving an operation is not by itself approval of a category model to read", async () => {
  // Invariant: the operation and its route are two separate approvals. An
  // operation with no route entry, and a binding with no read routes at all,
  // both refuse — the adapter never derives a category or a model from the
  // operation's own name or path template.
  const upstream = await rogueMerge(() => ({ body: {} }));
  const h = await harness({
    upstream,
    material: { accountToken: ACCOUNT_A_TOKEN },
    linkedAccountId: accountA.id,
  });
  const noRoutes = await harness({
    upstream,
    material: { accountToken: ACCOUNT_A_TOKEN },
    linkedAccountId: accountA.id,
    settings: {
      "merge.categories": ["hris"],
      "merge.endUsers": endUserMapping,
    },
  });
  try {
    await assert.rejects(
      () =>
        h.adapter.invoke!(h.ctx, {
          operationRef: "op:locations.list",
          input: {},
          commandId: "cmd-unrouted",
        }),
      rejects("merge.route.absent"),
    );
    await assert.rejects(
      () =>
        noRoutes.adapter.invoke!(noRoutes.ctx, {
          ...readInvocation,
          commandId: "cmd-no-routes",
        }),
      rejects("merge.route.absent"),
    );
    assert.equal(h.upstream.requests.length, 0);
  } finally {
    await h.close();
  }
});

test("a route whose model or path is not a validated segment is refused, never interpolated", async () => {
  // Invariant: the category, model and passthrough path are pasted into an
  // upstream URL, so each must match its documented shape before use. A route
  // carrying traversal or a query string is a refusal, not a request — this is
  // the last line between a host settings mistake and a call outside the
  // approved surface.
  const upstream = await rogueMerge(() => ({ body: {} }));
  const h = await harness({
    upstream,
    material: { accountToken: ACCOUNT_A_TOKEN },
    linkedAccountId: accountA.id,
    settings: settingsFor({
      "merge.reads": {
        "op:employees.list": {
          category: "hris",
          model: "../../integrations/account-token",
          fields: ["id"],
        },
      },
      "merge.passthrough": {
        "op:passthrough.timeoff": {
          category: "hris",
          path: "/v1/time_off_policies?admin=1",
          method: "GET",
        },
      },
    }),
  });
  try {
    await assert.rejects(
      () =>
        h.adapter.invoke!(h.ctx, { ...readInvocation, commandId: "cmd-model" }),
      rejects("merge.route.invalid"),
    );
    await assert.rejects(
      () =>
        h.adapter.delegate!(h.ctx, {
          skill: "op:passthrough.timeoff",
          action: "start",
          commandId: "cmd-path",
          input: {},
        }),
      rejects("merge.route.invalid"),
    );
    assert.equal(h.upstream.requests.length, 0);
  } finally {
    await h.close();
  }
});

test("a write-effect operation cannot be run through the read path", async () => {
  // Invariant: the read path executes only what the host classified as a read.
  // `op:employees.write` carries consent "confirm" and replay "none"; running
  // it as a read would skip both the confirmation and the effect journal that
  // its classification exists to require.
  const upstream = await rogueMerge(() => ({ body: {} }));
  const h = await harness({
    upstream,
    material: { accountToken: ACCOUNT_A_TOKEN },
    linkedAccountId: accountA.id,
  });
  try {
    await assert.rejects(
      () =>
        h.adapter.invoke!(h.ctx, {
          operationRef: "op:employees.write",
          input: {},
          commandId: "cmd-write-as-read",
        }),
      rejects("merge.operation.not-read"),
    );
    assert.equal(h.upstream.requests.length, 0);
    assert.deepEqual(h.ports.inspect.effects(), []);
  } finally {
    await h.close();
  }
});

test("a route naming a category the binding did not approve is refused on both paths", async () => {
  // Invariant: the approved categories gate every call, and the route's own
  // category is checked against them rather than trusted. A binding approved
  // for HRIS must not become a way to read an ATS or run passthrough against
  // it, whichever code path the request came in on.
  const upstream = await rogueMerge(() => ({ body: {} }));
  const h = await harness({
    upstream,
    material: { accountToken: ACCOUNT_A_TOKEN },
    linkedAccountId: accountA.id,
    settings: settingsFor({
      "merge.reads": {
        "op:employees.list": {
          category: "ats",
          model: "candidates",
          fields: ["id"],
        },
      },
      "merge.passthrough": {
        "op:passthrough.timeoff": {
          category: "ats",
          path: "/v1/time_off_policies",
          method: "GET",
        },
      },
    }),
  });
  try {
    await assert.rejects(
      () =>
        h.adapter.invoke!(h.ctx, {
          ...readInvocation,
          commandId: "cmd-ats-read",
        }),
      rejects("merge.category.unapproved"),
    );
    await assert.rejects(
      () =>
        h.adapter.delegate!(h.ctx, {
          skill: "op:passthrough.timeoff",
          action: "start",
          commandId: "cmd-ats-passthrough",
          input: {},
        }),
      rejects("merge.category.unapproved"),
    );
    assert.equal(h.upstream.requests.length, 0);
  } finally {
    await h.close();
  }
});

test("categories the host never set is configuration, not a default category", async () => {
  // Invariant: absent settings are reported as configuration-required. Picking
  // a default category would make the adapter choose which of an end user's
  // systems to touch, which is exactly the decision the host reserved.
  const upstream = await rogueMerge(() => ({ body: {} }));
  const h = await harness({
    upstream,
    material: { accountToken: ACCOUNT_A_TOKEN },
    linkedAccountId: accountA.id,
    settings: { "merge.endUsers": endUserMapping },
  });
  try {
    const error = await h.adapter.verify!(h.ctx)
      .then(() => undefined)
      .catch((cause: unknown) => cause);
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, "configuration-required");
    assert.equal(error.detail, "merge.categories.unset");
    assert.equal(h.upstream.requests.length, 0);
  } finally {
    await h.close();
  }
});

test("an end-user mapping that is absent or malformed is configuration, and another subject's entry is never borrowed", async () => {
  // Invariant: the end user comes from the host's mapping for *this* subject.
  // A missing or malformed mapping is a setup problem; a mapping that covers
  // someone else is a denial. Falling back to the only entry present would let
  // one person open a Link session against another person's organisation.
  const upstream = await rogueMerge(() => ({ body: { link_token: "t" } }));
  const intent = {
    ownerKind: "user" as const,
    requestedPermissions: [],
    accountSwitch: false,
    interruption: "allowed" as const,
  };
  const absent = await harness({
    upstream,
    settings: { "merge.categories": ["hris"] },
  });
  const malformed = await harness({
    upstream,
    settings: {
      "merge.categories": ["hris"],
      "merge.endUsers": {
        [fixtureActor.subjectId]: { originId: "", organization: "Acme" },
      },
    },
  });
  const someoneElse = await harness({
    upstream,
    settings: {
      "merge.categories": ["hris"],
      "merge.endUsers": {
        "subject-2": {
          originId: "org-9-user-9",
          organization: "Globex",
          email: "ops@globex.test",
        },
      },
    },
  });
  try {
    for (const h of [absent, malformed]) {
      const error = await h.adapter.authorize!(h.ctx, intent)
        .then(() => undefined)
        .catch((cause: unknown) => cause);
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, "configuration-required");
      assert.equal(error.detail, "merge.end-user.unmapped");
    }
    const error = await someoneElse.adapter.authorize!(someoneElse.ctx, intent)
      .then(() => undefined)
      .catch((cause: unknown) => cause);
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, "denied");
    assert.equal(error.detail, "merge.end-user.unmapped");
    assert.equal(upstream.requests.length, 0);
  } finally {
    await absent.close();
  }
});

/* ------------------------------------------------------------------ *
 * Credential custody
 * ------------------------------------------------------------------ */

test("a credential of the wrong shape is not accepted as an account token", async () => {
  // Invariant: an end-user-scoped call happens only with a real account token.
  // A credential that holds something else (a stale refresh token, a copy of
  // the host's API key) is unauthenticated, not a licence to call Merge with
  // the API key alone — which would read a different end user's data, since
  // the account token is what selects the linked account.
  const upstream = await rogueMerge(() => ({ body: {} }));
  const h = await harness({
    upstream,
    material: { apiKey: API_KEY },
    linkedAccountId: accountA.id,
  });
  try {
    const error = await h.adapter.invoke!(h.ctx, {
      ...readInvocation,
      commandId: "cmd-wrong-material",
    })
      .then(() => undefined)
      .catch((cause: unknown) => cause);
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, "unauthenticated");
    assert.equal(error.detail, "merge.account-token.absent");
    assert.equal(h.upstream.requests.length, 0);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ *
 * Authorization and completion
 * ------------------------------------------------------------------ */

test("the Merge Link URL leaves only through the private part of the handoff", async () => {
  // Invariant: the link token and the magic Link URL are bearer material for
  // one Link session. They are handed to the initiating human through
  // `private` and must appear nowhere else in the handoff a model or a log can
  // see, or the session could be completed by whoever read them.
  const upstream = await rogueMerge(() => ({
    body: {
      link_token: "link-token-private",
      magic_link_url: "https://link.merge.dev/magic/secret-path",
    },
  }));
  const h = await harness({ upstream });
  try {
    const start = await h.adapter.authorize!(h.ctx, {
      ownerKind: "user",
      requestedPermissions: [],
      accountSwitch: false,
      interruption: "allowed",
    });
    assert.equal(start.kind, "handoff");
    if (start.kind !== "handoff") throw new Error("unreachable");
    assert.equal(
      start.handoff.private.url,
      "https://link.merge.dev/magic/secret-path",
    );
    // Everything the handoff exposes apart from `private`.
    const exposed = JSON.stringify({ ...start.handoff, private: undefined });
    assert.equal(exposed.includes("secret-path"), false);
    assert.equal(exposed.includes("link-token-private"), false);
  } finally {
    await h.close();
  }
});

test("a link-token response Merge could not have sent is refused", async () => {
  // Invariant: the handoff is built only from a response that actually carries
  // a link token. Handing a human a widget with no token would look like a
  // started Link session and fail in their browser, with nothing to explain it.
  const upstream = await rogueMerge(() => ({
    body: { integration_name: "HR" },
  }));
  const h = await harness({ upstream });
  try {
    const error = await h.adapter.authorize!(h.ctx, {
      ownerKind: "user",
      requestedPermissions: [],
      accountSwitch: false,
      interruption: "allowed",
    })
      .then(() => undefined)
      .catch((cause: unknown) => cause);
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, "upstream-rejected");
    assert.equal(error.detail, "merge.link-token.invalid");
  } finally {
    await h.close();
  }
});

test("only a host-approved integration is named to Merge, and a malformed one is dropped", async () => {
  // Invariant: restricting a Link session to one integration is a host
  // decision recorded in the binding. A string setting is forwarded verbatim;
  // anything else is left out rather than coerced, because a coerced value
  // ("[object Object]") would be a request for an integration nobody approved.
  const double = await startMergeApiDouble({ accounts: [accountA] });
  const approved = await harness({
    upstream: double,
    settings: settingsFor({ "merge.integration": "bamboohr" }),
  });
  const malformed = await harness({
    upstream: double,
    settings: settingsFor({ "merge.integration": { slug: "bamboohr" } }),
  });
  const intent = {
    ownerKind: "user" as const,
    requestedPermissions: [],
    accountSwitch: false,
    interruption: "allowed" as const,
  };
  try {
    await approved.adapter.authorize!(approved.ctx, intent);
    await malformed.adapter.authorize!(malformed.ctx, intent);
    const [first, second] = double.linkTokenRequests;
    assert.equal(first?.integration, "bamboohr");
    assert.equal(
      Object.hasOwn(second ?? {}, "integration"),
      false,
      "a non-string integration is omitted, not stringified",
    );
  } finally {
    await approved.close();
  }
});

test("a completion carrying no input stays pending instead of being treated as linked", async () => {
  // Invariant: only an explicit public token completes a Link session. A poll,
  // a redirect or an event arriving first must leave the connection pending, or
  // a connection would be reported active with no credential behind it.
  const double = await startMergeApiDouble({ accounts: [accountA] });
  const h = await harness({ upstream: double });
  try {
    const result = await h.adapter.complete!(h.ctx, { kind: "poll" });
    assert.equal(result.state, "pending");
    assert.equal(result.code, "merge.link.pending");
    assert.equal(result.credentialRef, undefined);
    assert.equal(double.requests.length, 0);
  } finally {
    await h.close();
  }
});

test("a public token that could reshape the exchange URL is refused", async () => {
  // Invariant: the public token is interpolated into the exchange path, so it
  // must not be able to leave it. Traversal, a query or a control character is
  // refused before any request, which is what stops a caller-supplied value
  // from selecting a different Merge endpoint.
  const double = await startMergeApiDouble({ accounts: [accountA] });
  const h = await harness({ upstream: double });
  try {
    for (const hostile of [
      "../integrations/create-link-token",
      "public-token-a?override=1",
      "public-token-a#fragment",
      `public-token${String.fromCharCode(1)}a`,
      "",
    ]) {
      const error = await h.adapter.complete!(h.ctx, {
        kind: "input",
        values: { publicToken: hostile },
      })
        .then(() => undefined)
        .catch((cause: unknown) => cause);
      assert.ok(error instanceof ConnectorError, JSON.stringify(hostile));
      assert.equal(error.code, "invalid-request");
      assert.equal(error.detail, "merge.public-token.invalid");
    }
    assert.equal(double.requests.length, 0);
  } finally {
    await h.close();
  }
});

test("no account token is stored without a connection to own it", async () => {
  // Invariant: custody is scoped to a connection (tenant, owner, binding). With
  // no connection there is no scope to store under, so the exchange does not
  // happen at all rather than producing material nobody owns.
  const double = await startMergeApiDouble({ accounts: [accountA] });
  const h = await harness({ upstream: double, withConnection: false });
  try {
    const error = await h.adapter.complete!(h.ctx, {
      kind: "input",
      values: { publicToken: ACCOUNT_A_PUBLIC },
    })
      .then(() => undefined)
      .catch((cause: unknown) => cause);
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, "invalid-request");
    assert.equal(error.detail, "merge.connection.absent");
    assert.deepEqual(h.ports.inspect.credentialRefs(), []);
    assert.equal(double.requests.length, 0);
  } finally {
    await h.close();
  }
});

test("a malformed exchange leaves nothing in custody and is not retried as if it were new", async () => {
  // Invariant: the public token is one-use. When the exchange comes back
  // without a token, the attempt is journaled as failed and no credential is
  // written; a repeat of the same attempt is reported indeterminate rather than
  // spending the token again and rather than claiming success.
  const upstream = await rogueMerge(() => ({
    body: { integration: { name: "HR" } },
  }));
  const h = await harness({ upstream });
  try {
    const error = await h.adapter.complete!(h.ctx, {
      kind: "input",
      values: { publicToken: ACCOUNT_A_PUBLIC },
    })
      .then(() => undefined)
      .catch((cause: unknown) => cause);
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, "upstream-rejected");
    assert.equal(error.detail, "merge.account-token.invalid");
    assert.deepEqual(h.ports.inspect.credentialRefs(), []);
    assert.equal(h.ports.inspect.effects()[0]?.outcome?.status, "failed");

    const replay = await h.adapter.complete!(h.ctx, {
      kind: "input",
      values: { publicToken: ACCOUNT_A_PUBLIC },
    });
    assert.equal(replay.state, "indeterminate");
    assert.equal(replay.code, "merge.account-token.replayed");
    assert.equal(
      h.upstream.received(
        "GET",
        `/api/integrations/account-token/${ACCOUNT_A_PUBLIC}`,
      ).length,
      1,
      "the one-use token was not spent a second time",
    );
  } finally {
    await h.close();
  }
});

test("an exchange that names no linked account claims no identity", async () => {
  // Invariant: the account token is stored because Merge returned one, but an
  // identity claim, an external id and a target are made only when Merge named
  // the linked account. Inventing any of them would put an unverified target on
  // the connection that later account-change checks would compare against.
  const upstream = await rogueMerge(() => ({
    body: { account_token: "account-token-anonymous" },
  }));
  const h = await harness({ upstream });
  try {
    const result = await h.adapter.complete!(h.ctx, {
      kind: "input",
      values: { publicToken: ACCOUNT_A_PUBLIC },
    });
    assert.equal(result.state, "complete");
    assert.deepEqual(result.claims, []);
    assert.equal(result.externalIds, undefined);
    assert.equal(result.target, undefined);
    assert.deepEqual(
      result.adapterState,
      {},
      "no integration slug is invented",
    );
    assert.ok(result.credentialRef);
    assert.deepEqual(
      h.ports.inspect.credentialMaterial(result.credentialRef!),
      {
        accountToken: "account-token-anonymous",
      },
    );
    assert.equal(
      JSON.stringify(result).includes("account-token-anonymous"),
      false,
      "the token stays in custody and out of the result",
    );
  } finally {
    await h.close();
  }
});

test("reconnect still requires the human Link step and never re-links silently", async () => {
  // Invariant: reconnecting is a new Link session a person completes, so a
  // policy that forbids interrupting them yields human-required. A silent
  // reconnect would have to reuse or replace the account token without anyone
  // agreeing to it, and the stored token must be left exactly as it was.
  const double = await startMergeApiDouble({ accounts: [accountA] });
  const h = await harness({
    upstream: double,
    material: { accountToken: ACCOUNT_A_TOKEN },
    linkedAccountId: accountA.id,
  });
  try {
    const start = await h.adapter.reconnect!(h.ctx, {
      ownerKind: "user",
      requestedPermissions: [],
      accountSwitch: false,
      interruption: "none",
    });
    assert.equal(start.kind, "human-required");
    assert.equal(double.requests.length, 0);
    assert.deepEqual(
      h.ports.inspect.credentialMaterial(h.ctx.connection!.credentialRef!),
      { accountToken: ACCOUNT_A_TOKEN },
    );
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ *
 * Pagination is asked of Merge, not faked locally
 * ------------------------------------------------------------------ */

test("cursors, page sizes and a modified-after filter are asked of Merge", async () => {
  // Invariant: paging and filtering are forwarded to Merge. If the adapter
  // ignored them it would return page one forever, and if it filtered locally
  // it would have to fetch rows the caller explicitly did not ask for — rows
  // that then exist in memory and in logs for no approved reason.
  const double = await startMergeApiDouble({ accounts: [accountA] });
  const h = await harness({
    upstream: double,
    material: { accountToken: ACCOUNT_A_TOKEN },
    linkedAccountId: accountA.id,
  });
  try {
    await h.adapter.discover!(h.ctx, { cursor: "cursor-1", limit: 1 });
    const listing = double.received("GET", "/api/hris/v1/linked-accounts")[0];
    assert.equal(listing?.url.searchParams.get("cursor"), "cursor-1");
    assert.equal(listing?.url.searchParams.get("page_size"), "1");

    const result = await h.adapter.invoke!(h.ctx, {
      operationRef: "op:employees.list",
      commandId: "cmd-paged",
      input: {
        cursor: "cursor-2",
        pageSize: 1,
        modifiedAfter: "2026-09-01T00:00:00Z",
      },
    });
    const read = double.received("GET", "/api/hris/v1/employees")[0];
    assert.equal(read?.url.searchParams.get("cursor"), "cursor-2");
    assert.equal(read?.url.searchParams.get("page_size"), "1");
    assert.equal(
      read?.url.searchParams.get("modified_after"),
      "2026-09-01T00:00:00Z",
    );
    const output = result.output as { results: unknown[] };
    assert.equal(
      output.results.length,
      1,
      "the upstream page size was honoured",
    );
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ *
 * Passthrough: the separately governed path
 * ------------------------------------------------------------------ */

test("a passthrough action other than start is not treated as a start", async () => {
  // Invariant: only "start" runs the effect. A status poll, a cancellation or a
  // follow-up input arriving at this adapter is unsupported — answering them by
  // starting the call would turn a question about an effect into another one.
  const double = await startMergeApiDouble({ accounts: [accountA] });
  const h = await harness({
    upstream: double,
    material: { accountToken: ACCOUNT_A_TOKEN },
    linkedAccountId: accountA.id,
  });
  try {
    for (const action of ["status", "cancel", "input"] as const) {
      const error = await h.adapter.delegate!(h.ctx, {
        skill: "op:passthrough.timeoff",
        action,
        commandId: `cmd-${action}`,
        input: {},
      })
        .then(() => undefined)
        .catch((cause: unknown) => cause);
      assert.ok(error instanceof ConnectorError, action);
      assert.equal(error.code, "unsupported");
      assert.equal(error.detail, "merge.passthrough.action");
    }
    assert.equal(double.passthroughRequests("hris").length, 0);
    assert.deepEqual(h.ports.inspect.effects(), [], "nothing was journaled");
  } finally {
    await h.close();
  }
});

test("an operation bound to an http transport cannot be reached through passthrough", async () => {
  // Invariant: passthrough is governed separately from normalized reads, and
  // the two catalogues do not leak into each other. An operation approved as a
  // bound HTTP read must not become an arbitrary upstream call just because a
  // passthrough route was also written for its ref.
  const double = await startMergeApiDouble({ accounts: [accountA] });
  const h = await harness({
    upstream: double,
    material: { accountToken: ACCOUNT_A_TOKEN },
    linkedAccountId: accountA.id,
    settings: settingsFor({
      "merge.passthrough": {
        "op:employees.list": {
          category: "hris",
          path: "/v1/time_off_policies",
          method: "GET",
        },
      },
    }),
  });
  try {
    await assert.rejects(
      () =>
        h.adapter.delegate!(h.ctx, {
          skill: "op:employees.list",
          action: "start",
          commandId: "cmd-transport",
          input: {},
        }),
      rejects("merge.passthrough.transport"),
    );
    assert.equal(double.passthroughRequests("hris").length, 0);
  } finally {
    await h.close();
  }
});

test("caller query values are encoded into the fixed path and cannot add parameters of their own", async () => {
  // Invariant: the path stays the one the binding fixed, and approved query
  // values are encoded rather than pasted. A value containing "&" must not
  // become a second parameter, which is how a caller would otherwise reach
  // upstream filters (or a different resource) the host never approved.
  const double = await startMergeApiDouble({ accounts: [accountA] });
  const h = await harness({
    upstream: double,
    material: { accountToken: ACCOUNT_A_TOKEN },
    linkedAccountId: accountA.id,
  });
  try {
    const result = await h.adapter.delegate!(h.ctx, {
      skill: "op:passthrough.timeoff",
      action: "start",
      commandId: "cmd-query",
      input: { query: { filter: "active&include=secrets" } },
    });
    assert.equal(result.state, "complete");
    const [call] = double.passthroughRequests("hris");
    assert.equal(
      call?.body.path,
      "/v1/time_off_policies?filter=active%26include%3Dsecrets",
    );
    const sent = new URL(`https://merge.test${String(call?.body.path)}`);
    assert.deepEqual([...sent.searchParams.keys()], ["filter"]);
    assert.equal(sent.pathname, "/v1/time_off_policies");
  } finally {
    await h.close();
  }
});

test("passthrough input outside the approved shape is refused rather than forwarded", async () => {
  // Invariant: the passthrough body is not a free-form envelope. Unknown keys
  // and non-string query values are refused, so a caller cannot smuggle fields
  // Merge would interpret (or a future Merge would start interpreting) past the
  // host's review of this route.
  const double = await startMergeApiDouble({ accounts: [accountA] });
  const h = await harness({
    upstream: double,
    material: { accountToken: ACCOUNT_A_TOKEN },
    linkedAccountId: accountA.id,
  });
  try {
    for (const hostile of [
      { request_format: "XML" },
      { query: { page: 2 } },
      { data: {}, normalized_response: true },
    ]) {
      await assert.rejects(
        () =>
          h.adapter.delegate!(h.ctx, {
            skill: "op:passthrough.timeoff",
            action: "start",
            commandId: `cmd-shape-${Object.keys(hostile)[0]}`,
            input: hostile,
          }),
        rejects("merge.passthrough.input"),
      );
    }
    assert.equal(double.passthroughRequests("hris").length, 0);
  } finally {
    await h.close();
  }
});

test("the request format Merge is given comes from the binding, not from the caller", async () => {
  // Invariant: the body a caller supplies is forwarded as data, while the
  // method, path and request format come from the approved route. That split is
  // what makes a passthrough route reviewable: the shape of the upstream call
  // is fixed even though its payload is not.
  const double = await startMergeApiDouble({
    accounts: [
      {
        ...accountA,
        passthrough: {
          ...accountA.passthrough,
          "POST /v1/absences": { status: 201, response: { id: "abs-1" } },
        },
      },
    ],
  });
  const h = await harness({
    upstream: double,
    material: { accountToken: ACCOUNT_A_TOKEN },
    linkedAccountId: accountA.id,
  });
  try {
    const result = await h.adapter.delegate!(h.ctx, {
      skill: "op:passthrough.absence",
      action: "start",
      commandId: "cmd-absence",
      input: { data: { employee: "emp-a1", days: 2 } },
    });
    assert.equal(result.state, "complete");
    assert.equal(result.effect, "write");
    const [call] = double.passthroughRequests("hris");
    assert.equal(call?.body.method, "POST");
    assert.equal(call?.body.path, "/v1/absences");
    assert.equal(call?.body.request_format, "JSON");
    assert.deepEqual(call?.body.data, { employee: "emp-a1", days: 2 });
  } finally {
    await h.close();
  }
});

test("a passthrough that failed is not retried and not reported as success", async () => {
  // Invariant: the effect journal remembers outcomes, not just attempts. A
  // repeat of a command whose effect is known to have failed is answered
  // "failed" from the journal: the upstream is not called twice, and a retry
  // never reports the earlier failure as complete.
  const double = await startMergeApiDouble({ accounts: [accountA] });
  const h = await harness({
    upstream: double,
    material: { accountToken: ACCOUNT_A_TOKEN },
    linkedAccountId: accountA.id,
  });
  const request = {
    skill: "op:passthrough.absence",
    action: "start" as const,
    commandId: "cmd-absence-missing",
    input: {},
  };
  try {
    await assert.rejects(
      () => h.adapter.delegate!(h.ctx, request),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "not-found",
    );
    assert.equal(h.ports.inspect.effects()[0]?.outcome?.status, "failed");
    assert.equal(
      h.ports.inspect.effects()[0]?.outcome?.code,
      undefined,
      "a failure with nothing to say carries no code",
    );

    const repeat = await h.adapter.delegate!(h.ctx, request);
    assert.equal(repeat.state, "failed");
    assert.equal(
      double.passthroughRequests("hris").length,
      1,
      "the effect was not attempted a second time",
    );
  } finally {
    await h.close();
  }
});

test("a concurrent duplicate passthrough command is indeterminate, never a second effect", async () => {
  // Invariant: two deliveries of one command must not produce two upstream
  // calls. While the first is still in flight its outcome is unknown, so the
  // duplicate is answered indeterminate — the honest answer, and the one that
  // sends a human to reconcile instead of retrying.
  const barrier = gate();
  const upstream = await rogueMerge(async (request) => {
    if (request.url.pathname !== "/api/hris/v1/passthrough") return undefined;
    await barrier.opened;
    return {
      body: {
        method: "GET",
        path: "/v1/time_off_policies",
        status: 200,
        response: { policies: [] },
      },
    };
  });
  const h = await harness({
    upstream,
    material: { accountToken: ACCOUNT_A_TOKEN },
    linkedAccountId: accountA.id,
  });
  const request = {
    skill: "op:passthrough.timeoff",
    action: "start" as const,
    commandId: "cmd-concurrent",
    input: {},
  };
  try {
    const first = h.adapter.delegate!(h.ctx, request);
    await until(
      () => upstream.received("POST", "/api/hris/v1/passthrough").length === 1,
    );
    const duplicate = await h.adapter.delegate!(h.ctx, request);
    assert.equal(duplicate.state, "indeterminate");
    barrier.open();
    const original = await first;
    assert.equal(original.state, "complete");
    assert.equal(duplicate.effectRef, original.effectRef);
    assert.equal(
      upstream.received("POST", "/api/hris/v1/passthrough").length,
      1,
      "the duplicate delivery caused no second upstream call",
    );
  } finally {
    await h.close();
  }
});

test("a passthrough cancelled in flight is indeterminate, because Merge may already have applied it", async () => {
  // Invariant: a cancellation that races an upstream effect does not make the
  // effect not have happened. The journal records indeterminate and the caller
  // is told so, rather than being handed a "cancelled" that would read as
  // "nothing was written upstream".
  const barrier = gate();
  const upstream = await rogueMerge(async (request) => {
    if (request.url.pathname !== "/api/hris/v1/passthrough") return undefined;
    await barrier.opened;
    return { body: { method: "POST", path: "/v1/absences", status: 201 } };
  });
  const h = await harness({
    upstream,
    material: { accountToken: ACCOUNT_A_TOKEN },
    linkedAccountId: accountA.id,
  });
  try {
    const pending = h.adapter.delegate!(h.ctx, {
      skill: "op:passthrough.absence",
      action: "start",
      commandId: "cmd-cancelled",
      input: { data: { employee: "emp-a1" } },
    });
    await until(
      () => upstream.received("POST", "/api/hris/v1/passthrough").length === 1,
    );
    h.controller.abort();
    barrier.open();
    const result = await pending;
    assert.equal(result.state, "indeterminate");
    assert.equal(result.code, "merge.passthrough.uncertain");
    assert.equal(result.output, undefined);
    assert.equal(
      h.ports.inspect.effects()[0]?.outcome?.status,
      "indeterminate",
      "an effect of unknown outcome is journaled for reconciliation",
    );
    assert.equal(
      h.ports.inspect.effects()[0]?.outcome?.code,
      "merge.passthrough.uncertain",
    );
  } finally {
    await h.close();
  }
});

test("a passthrough envelope Merge could not have sent is not handed to the caller", async () => {
  // Invariant: the passthrough response is validated even though its payload is
  // opaque. An envelope that does not match the documented shape is an upstream
  // rejection, and the effect is journaled failed rather than reported complete
  // with a body nobody can interpret.
  const upstream = await rogueMerge((request) =>
    request.url.pathname === "/api/hris/v1/passthrough"
      ? { body: { method: "GET", status: "two hundred", response: {} } }
      : undefined,
  );
  const h = await harness({
    upstream,
    material: { accountToken: ACCOUNT_A_TOKEN },
    linkedAccountId: accountA.id,
  });
  try {
    const error = await h.adapter.delegate!(h.ctx, {
      skill: "op:passthrough.timeoff",
      action: "start",
      commandId: "cmd-envelope",
      input: {},
    })
      .then(() => undefined)
      .catch((cause: unknown) => cause);
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, "upstream-rejected");
    assert.equal(error.detail, "merge.passthrough.invalid");
    assert.equal(h.ports.inspect.effects()[0]?.outcome?.status, "failed");
  } finally {
    await h.close();
  }
});

test("passthrough without a connection does not fall back to the host's API key", async () => {
  // Invariant: passthrough acts on one end user's data, so it needs that end
  // user's account token. With no connection there is no custody to draw it
  // from, and the call is refused as unauthenticated — the API key alone must
  // never be enough to reach an end user's provider. The attempt is still
  // journaled, so an unauthenticated try is visible rather than silent.
  const upstream = await rogueMerge(() => ({ body: {} }));
  const h = await harness({ upstream, withConnection: false });
  try {
    const error = await h.adapter.delegate!(h.ctx, {
      skill: "op:passthrough.timeoff",
      action: "start",
      commandId: "cmd-no-connection",
      input: {},
    })
      .then(() => undefined)
      .catch((cause: unknown) => cause);
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, "unauthenticated");
    assert.equal(error.detail, "merge.account-token.absent");
    assert.equal(upstream.requests.length, 0);
    assert.equal(h.ports.inspect.effects()[0]?.outcome?.status, "failed");
    assert.equal(
      h.ports.inspect.effects()[0]?.intent.connectionRef,
      undefined,
      "no connection is invented for the journal entry",
    );
  } finally {
    await h.close();
  }
});

test("an approved destination that cannot be reached is an outage, not a rejection", async () => {
  // Invariant: a call that never got an answer is reported as
  // upstream-unavailable, distinct from a call Merge answered with a refusal.
  // The two lead opposite ways: an outage is worth retrying, while a rejection
  // retried on a loop is how a host gets rate-limited or locked out. The
  // upstream here is shut down before the call, so nothing answered at all.
  const upstream = await rogueMerge(() => ({ body: {} }));
  await upstream.close();
  const h = await harness({ upstream });
  try {
    const error = await h.adapter.discover!(h.ctx, {})
      .then(() => undefined)
      .catch((cause: unknown) => cause);
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, "upstream-unavailable");
    assert.equal(error.detail, "merge.request.failed");
    // The transport failure itself stays inside the server.
    assert.equal(error.message.includes("127.0.0.1"), false);
  } finally {
    await h.close();
  }
});

test("a command cancelled before it starts causes no upstream effect", async () => {
  /*
   * The defect this pins: `call` registered an abort listener but never
   * checked whether the signal was already aborted. A signal that has already
   * fired never fires again, so the listener was never called, the adapter
   * built a fresh un-aborted controller, and the request went out. For a
   * passthrough that means a caller who cancelled before execution could
   * still cause an effect at the provider, which is the one thing this layer
   * exists to prevent.
   *
   * The assertion that matters is the upstream request count, not the error:
   * an adapter could report `cancelled` and still have sent the request.
   */
  const upstream = await rogueMerge(() => ({ body: linkedAccount({}) }));
  const h = await harness({ upstream });
  try {
    h.controller.abort();
    const error = await h.adapter.discover!(h.ctx, {})
      .then(() => undefined)
      .catch((cause: unknown) => cause);
    assert.ok(error instanceof ConnectorError, "a cancelled call must refuse");
    assert.equal(error.code, "cancelled");
    assert.equal(
      h.upstream.requests.length,
      0,
      "a cancelled command reached the provider",
    );
  } finally {
    await h.close();
  }
});
