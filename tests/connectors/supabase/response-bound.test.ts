import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_RESPONSE_BYTES } from "../../../src/server/connectors/auth/index.js";
import type {
  AdapterCallContext,
  AuthorizationIntent,
  CompletionResult,
  HandoffProposal,
} from "../../../src/server/connectors/adapter.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { createSupabaseManagementAdapter } from "../../../src/server/connectors/providers/supabase/index.js";
import { fixtureActor } from "../doubles/ports.js";
import {
  managementOrganization,
  managementProject,
  startSupabaseManagementDouble,
} from "../doubles/supabase-management.js";
import {
  CALLBACK_PATH,
  HOST_ORIGIN,
  ORGANIZATION_SLUG,
  PROJECT_REF,
  managementBinding,
  supabaseHarness,
  type SupabaseHarness,
} from "../fixtures/supabase/harness.js";

/*
 * Supabase's Management OAuth token requests leave through their own fetch
 * (the destination is pinned), so the ceiling on an OAuth answer has to be
 * applied there too: a token endpoint that streams without end must not decide
 * how much the host reads, and what was sent and not understood is unknown, not
 * refused.
 */

const CLIENT_ID = "66666666-6666-4666-8666-666666666666";
const CLIENT_SECRET = "sb_secret_live_fixture_9f4d3a206b2e4a7e8c91";
const CONFIGURATION = {
  SUPABASE_OAUTH_CLIENT_ID: CLIENT_ID,
  SUPABASE_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
};
const REDIRECT_URI = `${HOST_ORIGIN}${CALLBACK_PATH}`;
const adapter = createSupabaseManagementAdapter();
const CHUNK = 64 * 1024;
const ENDLESS = 64 * 1024 * 1024;

const intent: AuthorizationIntent = {
  ownerKind: "user",
  requestedPermissions: [],
  accountSwitch: false,
  interruption: "allowed",
};

/** The real fetch, except that the token endpoint streams `ENDLESS` bytes once told to. */
function streamingTokenEndpoint(real: typeof fetch) {
  const state = { endless: false, pulled: 0 };
  const wrapped: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (!state.endless || url.pathname !== "/v1/oauth/token")
      return real(input, init);
    const chunk = new Uint8Array(CHUNK).fill(0x20);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (state.pulled >= ENDLESS) return controller.close();
        state.pulled += CHUNK;
        controller.enqueue(chunk);
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { state, fetch: wrapped };
}

async function issue(h: SupabaseHarness, proposal: HandoffProposal) {
  return h.ports.handoffs.issue({
    ...proposal,
    actor: fixtureActor,
    connectionRef: h.connection.connectionRef,
    bindingRef: h.ctx.binding.bindingRef,
    generation: h.ctx.generation,
  });
}

async function connect(h: SupabaseHarness): Promise<{
  result: CompletionResult;
  ctx: AdapterCallContext;
}> {
  const start = await adapter.authorize(h.ctx, {
    ...intent,
    target: { kind: "supabase-project", id: PROJECT_REF },
  });
  assert.equal(start.kind, "handoff");
  const proposal = (start as { handoff: HandoffProposal }).handoff;
  await issue(h, proposal);
  const redirect = await fetch(proposal.private.url!, { redirect: "manual" });
  await redirect.body?.cancel();
  const result = await adapter.complete(h.ctx, {
    kind: "redirect",
    url: new URL(redirect.headers.get("location")!),
  });
  return {
    result,
    ctx: h.with({
      ...(result.credentialRef ? { credentialRef: result.credentialRef } : {}),
      ...(result.target ? { target: result.target } : {}),
      externalIds: result.externalIds ?? {},
      state: result.adapterState ?? {},
      lifecycle: "active",
    }),
  };
}

async function setup(t: import("node:test").TestContext) {
  const double = await startSupabaseManagementDouble({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUris: [REDIRECT_URI],
    projects: [managementProject(PROJECT_REF, ORGANIZATION_SLUG)],
    organizations: [managementOrganization(ORGANIZATION_SLUG)],
  });
  t.after(() => double.close());
  const stream = streamingTokenEndpoint(fetch);
  let clock = Date.now();
  const h = await supabaseHarness({
    binding: managementBinding({ origin: double.origin }),
    fetch: stream.fetch,
    configuration: CONFIGURATION,
    now: () => clock,
  });
  t.after(() => h.close());
  return { double, stream, h, advance: (ms: number) => (clock += ms) };
}

test("an endless token answer to the authorization-code exchange is cut off, unknown, and stores nothing", async (t) => {
  const { stream, h } = await setup(t);
  stream.state.endless = true;

  const { result } = await connect(h);

  assert.equal(result.state, "indeterminate");
  assert.equal(result.code, "supabase.oauth.exchange-indeterminate");
  assert.equal(result.credentialRef, undefined);
  assert.deepEqual(h.ports.inspect.credentialRefs(), []);
  assert.ok(
    stream.state.pulled <= 2 * MAX_RESPONSE_BYTES,
    `read ${stream.state.pulled} bytes of a token answer; the ceiling is ${MAX_RESPONSE_BYTES}`,
  );
  assert.ok(stream.state.pulled > 0, "the endless answer was in fact served");
});

test("an endless token answer to a refresh is cut off, the refresh is journaled as unknown, and the connection is not told to reconnect", async (t) => {
  const { stream, h, advance } = await setup(t);
  const connected = await connect(h);
  assert.equal(connected.result.state, "complete");
  const credentialRef = connected.result.credentialRef!;
  const before = h.ports.inspect.credentialMaterial(credentialRef)!;

  stream.state.endless = true;
  advance(86_400_000 - 30_000);
  const failure = await adapter
    .invoke(connected.ctx, {
      operationRef: "operation:v1-get-project",
      input: { ref: PROJECT_REF },
      commandId: "command-endless",
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );

  assert.ok(failure instanceof ConnectorError, String(failure));
  assert.equal(failure.code, "upstream-unavailable");
  assert.equal(failure.detail, "supabase.oauth.refresh-unavailable");
  assert.ok(
    stream.state.pulled <= 2 * MAX_RESPONSE_BYTES,
    `read ${stream.state.pulled} bytes of a token answer; the ceiling is ${MAX_RESPONSE_BYTES}`,
  );
  assert.ok(stream.state.pulled > 0, "the endless answer was in fact served");
  const refresh = h.ports.inspect
    .effects()
    .find(
      (effect) =>
        effect.intent.operation === "supabase.management.oauth.refresh",
    );
  assert.equal(refresh?.outcome?.status, "indeterminate");
  assert.equal(
    h.ports.inspect.credentialMaterial(credentialRef)?.refresh_token,
    before.refresh_token,
    "nothing in custody was replaced by a half-read answer",
  );
});
