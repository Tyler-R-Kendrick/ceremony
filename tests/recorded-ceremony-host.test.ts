import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { createGitHubRuntime } from "../src/server/github-runtime.js";
import { teachingHttp } from "../src/server/teaching-http.js";
import { createCeremonyMcpHandler } from "../src/server/mcp.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import { createFixtureVerifier } from "../src/server/browser-verification.js";
import type { CeremonyInterpreter } from "../src/server/browser-interpreter.js";
import { totpCode, totpSeedSpellings } from "../src/server/totp.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import {
  startAuthProvider,
  type ProviderDouble,
} from "./doubles/auth-provider/server.js";
import { createScriptedInterpreter } from "./doubles/scripted-interpreter.js";

/**
 * An agent records a login on a service the code has never seen, a person
 * publishes it, and the next login replays it in a real browser with no
 * model — through the reference host, over the transports a client uses.
 *
 * The provider is the self-hosted double in its identifier-first shape with a
 * seed-derived authenticator code, regenerated from a seed nothing here
 * hard-codes. The scripted interpreter is the host's "model": it is the only
 * thing that reads the pages, and it is counted, so "the replay made no model
 * calls" is an assertion rather than a description.
 *
 * Every credential is a canary. Every tool result and route response in this
 * file is collected and searched for them at the end.
 */

const USERNAME = "canary-host-7d21";
const EMAIL = "canary.host.7d21@example.test";
const PASSWORD = "Canary-Host-Pw-93be40!";
/** Synthetic enrolment secret. Nothing else in the repository produces it. */
const SEED = "MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U";
const refs = {
  username: randomUUID(),
  password: randomUUID(),
  "totp-seed": randomUUID(),
};

const origin = "https://app.example";
const endpoint = `${origin}/mcp`;
const actor = (
  name: string,
  capabilities: ActorContext["capabilities"],
  actorKind: ActorContext["actorKind"] = "human",
): ActorContext => ({
  tenantId: "recording-tenant",
  subjectId: `subject-${name}`,
  sessionId: `client-${name}`,
  actorKind,
  capabilities,
});
/** The person's agent: it may log in and save drafts, and nothing more. */
const agent = actor("agent", ["executor", "author"]);
const executorOnly = actor("executor", ["executor"]);
const reviewer = actor("reviewer", ["reviewer"]);
const publisher = actor("publisher", ["publisher"]);
/** Holds the capabilities, but is not a person. */
const botReviewer = actor("bot", ["reviewer", "publisher"], "agent");
const actors = new Map(
  [agent, executorOnly, reviewer, publisher, botReviewer].map((a) => [
    a.sessionId,
    a,
  ]),
);

let double: ProviderDouble;
before(async () => {
  double = await startAuthProvider({
    seed: 2718,
    identifierFirst: true,
    requireMfa: true,
    totpSeed: SEED,
    accounts: [{ email: EMAIL, username: USERNAME, password: PASSWORD }],
  });
});
after(async () => {
  await double.close();
});

/** Everything a client was handed in this file, for the canary sweep. */
const surfaces: string[] = [];

function host() {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "rec",
    keys: { rec: randomBytes(32) },
  });
  const model = { calls: 0 };
  const scripted = createScriptedInterpreter();
  const counted: CeremonyInterpreter = async (input) => {
    model.calls++;
    return scripted(input);
  };
  const runtime = createGitHubRuntime({
    store,
    identity: {
      authenticate: async (request) =>
        actors.get(request.headers.get("x-client") ?? "") ?? null,
    },
    origin,
    environment: "test",
    configurationVersion: "v1",
    authorize: async () => true,
    browserLogin: {
      credentials: {
        resolve: async (_actor, _plan, role) =>
          ({
            username: USERNAME,
            password: PASSWORD,
            "totp-seed": SEED,
          })[role as "username" | "password" | "totp-seed"],
      },
      knownConnectors: () => new Set(["fixture-idp"]),
      verifiers: [createFixtureVerifier({ origin: double.origin })],
      modelInterpreter: () => counted,
    },
  });
  const mcp = createCeremonyMcpHandler(runtime, {
    resourceUrl: endpoint,
    issuer: "https://issuer.example",
    authenticate: (token) => actors.get(token) ?? null,
  });
  const rpc = async (client: ActorContext, body: unknown) => {
    const response = await mcp.fetch(
      new Request(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${client.sessionId}`,
        },
        body: JSON.stringify(body),
      }),
    );
    const text = await response!.text();
    surfaces.push(text);
    const line = text.split("\n").find((entry) => entry.startsWith("data:"));
    return JSON.parse(line ? line.slice(5) : text) as {
      result?: {
        isError?: boolean;
        content?: { type: string; text: string }[];
        tools?: { name: string }[];
      };
    };
  };
  const tool = async (client: ActorContext, name: string, args: unknown) => {
    await rpc(client, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    const payload = await rpc(client, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const text = payload.result?.content?.[0]?.text ?? "";
    return {
      isError: payload.result?.isError === true,
      text,
      value: (payload.result?.isError === true
        ? undefined
        : JSON.parse(text)) as any,
    };
  };
  const toolNames = async (client: ActorContext) =>
    (
      await rpc(client, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
        params: {},
      })
    ).result?.tools?.map((entry) => entry.name) ?? [];
  const http = async (client: ActorContext, path: string, body?: unknown) => {
    const response = await teachingHttp(
      new Request(`${origin}/api/v1/teaching${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "x-client": client.sessionId,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      runtime,
    );
    const text = await response.text();
    surfaces.push(text);
    return { status: response.status, body: JSON.parse(text) as any };
  };
  return { store, model, tool, toolNames, http };
}

const draft = (
  reasoning: "deterministic" | "host-model",
  recording?: unknown,
) => ({
  engine: "chromium",
  ownership: "managed",
  entryUrl: `${double.origin}/signin`,
  navigationOrigins: [double.origin],
  credentialRecipients: {
    username: [double.origin],
    password: [double.origin],
    "totp-code": [double.origin],
  },
  account: { kind: "expect", accountRef: USERNAME },
  // The session ends with the call. What is asserted is how it got there.
  continuation: "dispose",
  trustMode: "constrained-auth",
  interactionRounds: 0,
  requireVerification: true,
  verifierOrigin: double.origin,
  credentialRefs: refs,
  sessionTtlMs: 600_000,
  reasoning,
  ...(recording ? { recording } : {}),
});

describe("RECORDED-HOST: record, publish by a person, replay with no model", () => {
  let h: ReturnType<typeof host>;
  before(() => {
    h = host();
  });
  after(async () => {
    await h.store.close();
  });
  let draftId = "";
  let revision = 0;
  let digest = "";
  let reference: { id: string; version: string; digest: string };

  test("the recording tools are offered to an author and to nobody else", async () => {
    const offered = await h.toolNames(agent);
    assert.ok(offered.includes("browser_record_login"), offered.join(","));
    assert.ok(offered.includes("ceremony_recording_read"));
    // No tool reviews or publishes a recording, for anyone.
    assert.ok(!offered.some((name) => /recording_(review|publish)/.test(name)));
    const executorTools = await h.toolNames(executorOnly);
    assert.ok(executorTools.includes("browser_login"));
    assert.ok(!executorTools.includes("browser_record_login"));
    assert.ok(!executorTools.includes("ceremony_recording_read"));
  });

  test("an agent records a login it has never seen, and it is saved as a draft", async () => {
    const recorded = await h.tool(agent, "browser_record_login", {
      connectorId: "fixture-idp",
      draft: draft("host-model"),
      recording: { id: "fixture-idp-sign-in", title: "Fixture IdP sign-in" },
    });
    assert.equal(recorded.isError, false, recorded.text);
    assert.equal(recorded.value.login.status, "verified", recorded.text);
    assert.ok(h.model.calls > 0, "the model read the pages while recording");
    const saved = recorded.value.draft;
    assert.match(saved.draftId, /^recorded-ceremony:/);
    assert.equal(saved.recording.id, "fixture-idp-sign-in");
    assert.equal(saved.recording.recordedWith, "host-model");
    assert.equal(saved.outcome, "verified");
    assert.deepEqual(saved.recording.roles.slice().sort(), [
      "password",
      "totp-code",
      "username",
    ]);
    draftId = saved.draftId;
    revision = saved.revision;
    digest = saved.digest;

    const read = await h.tool(agent, "ceremony_recording_read", { draftId });
    assert.equal(read.isError, false, read.text);
    assert.equal(read.value.digest, digest);
    assert.ok(Object.keys(read.value.plan.data).length === 3);
  });

  test("the agent that recorded it cannot review or publish it", async () => {
    const path = `/recorded-ceremonies/drafts/${encodeURIComponent(draftId)}`;
    assert.equal(
      (await h.http(agent, `${path}/review`, { revision, digest })).status,
      403,
    );
    assert.equal(
      (await h.http(agent, `${path}/publish`, { revision, digest })).status,
      403,
    );
    // Holding the capabilities is not enough without being a person.
    assert.equal(
      (await h.http(botReviewer, `${path}/review`, { revision, digest }))
        .status,
      403,
    );
    // And a draft is not replayable: nothing has been published under it.
    const early = await h.tool(executorOnly, "browser_login", {
      connectorId: "fixture-idp",
      draft: draft("deterministic", {
        id: "fixture-idp-sign-in",
        version: "1.0.1",
        digest,
      }),
    });
    assert.equal(early.isError, true);
    assert.match(early.text, /recording-unavailable/);
  });

  test("a person reviews, a person publishes, and only a current review counts", async () => {
    const path = `/recorded-ceremonies/drafts/${encodeURIComponent(draftId)}`;
    const shown = await h.http(reviewer, path);
    assert.equal(shown.status, 200, JSON.stringify(shown.body));
    assert.equal(shown.body.digest, digest);
    const unreviewed = await h.http(publisher, `${path}/publish`, {
      revision,
      digest,
    });
    assert.equal(unreviewed.status, 400);
    const reviewed = await h.http(reviewer, `${path}/review`, {
      revision,
      digest,
    });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
    const published = await h.http(publisher, `${path}/publish`, {
      revision,
      digest,
    });
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.deepEqual(published.body, {
      id: "fixture-idp-sign-in",
      version: "1.0.1",
      digest,
    });
    reference = published.body;
  });

  test("the next login replays the published recording and makes no model call", async () => {
    const before = h.model.calls;
    // The plan says a model may decide; the recording means none has to.
    const login = await h.tool(executorOnly, "browser_login", {
      connectorId: "fixture-idp",
      draft: draft("host-model", reference),
    });
    assert.equal(login.isError, false, login.text);
    assert.equal(login.value.status, "verified", login.text);
    assert.equal(h.model.calls, before, "the replay consulted the model");
    // And a plan with no model at all replays it just the same.
    const deterministic = await h.tool(executorOnly, "browser_login", {
      connectorId: "fixture-idp",
      draft: draft("deterministic", reference),
    });
    assert.equal(deterministic.value.status, "verified", deterministic.text);
    assert.equal(h.model.calls, before);
  });

  test("a published version is pinned by digest", async () => {
    const wrong = await h.tool(executorOnly, "browser_login", {
      connectorId: "fixture-idp",
      draft: draft("deterministic", {
        ...reference,
        digest: "A".repeat(43),
      }),
    });
    assert.equal(wrong.isError, true);
    assert.match(wrong.text, /recording-unavailable/);
  });

  test("when the provider redeploys, the replay stops by name and a repair is only a draft", async () => {
    double.restyle(31337);
    const before = h.model.calls;
    const drifted = await h.tool(executorOnly, "browser_login", {
      connectorId: "fixture-idp",
      draft: draft("host-model", reference),
    });
    assert.equal(drifted.isError, false, drifted.text);
    assert.deepEqual(drifted.value, {
      status: "blocked",
      runRef: drifted.value.runRef,
      reason: "recording-drift",
    });
    assert.equal(h.model.calls, before, "browser_login never repairs");

    // Re-recording from the published version: the model is consulted only
    // for what drifted, and what worked becomes a new draft of the same id.
    const repaired = await h.tool(agent, "browser_record_login", {
      connectorId: "fixture-idp",
      draft: draft("host-model"),
      recording: { id: "fixture-idp-sign-in", title: "Fixture IdP sign-in" },
      basedOn: reference,
    });
    assert.equal(repaired.isError, false, repaired.text);
    assert.equal(repaired.value.login.status, "verified", repaired.text);
    assert.equal(repaired.value.drift.kind, "element-missing");
    assert.equal(repaired.value.drift.step, "step-1");
    assert.ok(repaired.value.interpreterCalls > 0);
    assert.equal(h.model.calls - before, repaired.value.interpreterCalls);
    assert.equal(repaired.value.draft.recording.recordedWith, "repair");
    assert.deepEqual(repaired.value.draft.recording.basedOn, reference);
    assert.notEqual(repaired.value.draft.draftId, draftId);

    // Still only a draft: the published version is what logins replay, and
    // it still drifts.
    const still = await h.tool(executorOnly, "browser_login", {
      connectorId: "fixture-idp",
      draft: draft("deterministic", reference),
    });
    assert.equal(still.value.reason, "recording-drift");
  });

  test("no protected value reached any tool result or route response", () => {
    const text = surfaces.join("\n").toLowerCase();
    const now = Date.now();
    const codes = [-120_000, -90_000, -60_000, -30_000, 0, 30_000].map((skew) =>
      totpCode(SEED, now + skew),
    );
    for (const canary of [
      USERNAME,
      EMAIL,
      PASSWORD,
      ...totpSeedSpellings(SEED),
      ...codes,
    ])
      assert.ok(
        !text.includes(canary.toLowerCase()),
        "a protected value reached a client",
      );
  });
});

describe("RECORDED-HOST: a recording name the format cannot hold", () => {
  test("is refused before the login runs, so a login is never lost to it", async () => {
    const h = host();
    after(() => h.store.close());
    for (const recording of [
      { id: "fixture-idp-sign-in", title: "Acme login for ops@acme.example" },
      { id: "fixture-idp-sign-in", title: "Acme login " },
      { id: "fixture-idp-sign-in", title: "Acme tenant 12345678" },
      { id: "constructor", title: "Fixture IdP sign-in" },
    ]) {
      const recorded = await h.tool(agent, "browser_record_login", {
        connectorId: "fixture-idp",
        draft: draft("host-model"),
        recording,
      });
      assert.equal(recorded.isError, true, recorded.text);
    }
    assert.equal(h.model.calls, 0, "no login was started");
  });
});
