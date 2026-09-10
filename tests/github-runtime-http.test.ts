import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { teachingGitHubFixture } from "./fixtures/teaching-github.js";
import { githubConnectionRecipe } from "../src/server/teaching-runtime.js";
import { createGitHubRuntime } from "../src/server/github-runtime.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import { randomBytes } from "node:crypto";
import type { ActorContext } from "../src/core/operation-contracts.js";

test("AC-32: mounted callback resumes authorized surviving parent after original cancellation", async (t) => {
  const f = await teachingGitHubFixture(4498);
  t.after(() => f.close());
  const cookie = f.sessionCookie("shared-author");
  const request = (path: string, body?: unknown, session = cookie) =>
    fetch(`${f.origin}/api/v1/teaching${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie: session,
        origin: f.origin,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
    });
  const actor = await f.runtime.identity.authenticate(
    new Request(f.origin, { headers: { cookie } }),
  );
  assert.ok(actor);
  // Independently authorized parent invocations use the actual production deterministic executor.
  const first = await f.runtime.executeRecipe(
    actor,
    githubConnectionRecipe,
    {},
    "github",
  );
  const second = await f.runtime.executeRecipe(
    actor,
    { ...githubConnectionRecipe, id: "second-parent" },
    {},
    "github",
  );
  for (const run of [first, second]) {
    const response = await request(`/runs/${run.id}/advance`, {
      nodeId: "app",
      revision: run.revision,
      commandId: `prepare:${run.id}`,
    });
    assert.equal(response.status, 200);
  }
  const human = await request(`/github/${first.id}/human`);
  assert.equal(human.status, 200);
  const { document } = parseHTML(await human.text());
  const state = new URL(
    document.querySelector("form")!.getAttribute("action")!,
  ).searchParams.get("state");
  const callback = `/github/${encodeURIComponent(first.id)}/callback?state=${state}&code=shared-callback`;
  const before = await (await request(`/runs/${first.id}`)).json();
  assert.equal(
    (await request(`/runs/${first.id}/cancel`, { revision: before.revision }))
      .status,
    200,
  );
  const foreign = f.sessionCookie("foreign");
  assert.equal((await request(callback, undefined, foreign)).status, 403);
  assert.equal(f.effects.conversions, 0);
  const returned = await request(callback);
  assert.equal(returned.status, 303);
  assert.equal(
    new URL(returned.headers.get("location")!).searchParams.get("teachingRun"),
    second.id,
  );
  assert.equal(f.effects.conversions, 1);
  assert.equal(
    (await (await request(`/runs/${first.id}`)).json()).status,
    "cancelled",
  );
  const survivor = await (await request(`/runs/${second.id}`)).json();
  assert.equal(survivor.nodes[0].state, "complete");
  assert.equal(survivor.nodes[1].state, "awaiting-human");
  assert.notEqual((await request(callback)).status, 303);
  assert.equal(f.effects.conversions, 1);
});

test("AC-18 AC-36: GitHub runtime target selection and dynamic configuration fail closed across waits", async () => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  const actor: ActorContext = {
    tenantId: "tenant",
    subjectId: "subject",
    sessionId: "session",
    actorKind: "human",
    capabilities: ["executor"],
  };
  let version = "v1",
    allowed = true;
  const runtime = createGitHubRuntime({
    store,
    identity: { authenticate: async () => actor },
    origin: "http://127.0.0.1:4173",
    environment: "test",
    configurationVersion: "v1",
    configuration: async () => ({ configurationVersion: version }),
    allowTarget: async (_, target) => target === "allowed",
    authorize: async () => allowed,
  });
  try {
    await assert.rejects(runtime.connect(actor, "github"), /account-required/);
    for (const target of ["invalid target", "forbidden"])
      await assert.rejects(runtime.selectTarget!(actor, target), /denied/);
    await runtime.selectTarget!(actor, "allowed");
    await runtime.selectTarget!(actor, "allowed");
    const run = await runtime.connect(actor, "github");
    await assert.rejects(runtime.cancel!(actor, run.id), /denied/);
    await assert.rejects(
      runtime.cancel!({ ...actor, subjectId: "foreign" }, run.id),
      /denied/,
    );
    await assert.rejects(runtime.cancel!(actor, "missing"), /denied/);
    const human = new Request(
      `http://127.0.0.1:4173/api/v1/teaching/github/${run.id}/human`,
    );
    await assert.rejects(
      runtime.human!({ ...actor, actorKind: "agent" }, run.id, human),
      /denied/,
    );
    allowed = false;
    await assert.rejects(runtime.human!(actor, run.id, human), /denied/);
    allowed = true;
    version = "v2";
    await assert.rejects(runtime.human!(actor, run.id, human), /denied/);
    await runtime.commands.cancel(actor, run.id, run.revision);
    await runtime.cancel!(actor, run.id);
    assert.equal(
      (await runtime.commands.snapshot(actor, run.id)).status,
      "cancelled",
    );
  } finally {
    await store.close();
  }
});

test("AC-14 AC-20: configured app and trusted continuation remain server-owned with model explicitly disabled", async () => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "key",
    keys: { key: randomBytes(32) },
  });
  const actor: ActorContext = {
    tenantId: "tenant",
    subjectId: "subject",
    sessionId: "session",
    actorKind: "human",
    capabilities: ["executor"],
  };
  let deliveries = 0;
  const runtime = createGitHubRuntime({
    store,
    identity: { authenticate: async () => actor },
    origin: "http://127.0.0.1:4173",
    environment: "test",
    configurationVersion: "configured",
    expectedAccount: "allowed",
    modelConfiguration: {},
    github: {
      app: {
        id: 42,
        slug: "fixture",
        owner: { login: "allowed" },
        pem: "synthetic-private-pem",
      },
    },
    continuation: {
      id: "registered-task",
      handler: async () => {
        deliveries++;
      },
    },
    authorize: async () => true,
  });
  try {
    const run = await runtime.connect(actor, "github");
    assert.equal(JSON.stringify(run).includes("synthetic-private-pem"), false);
    assert.equal(deliveries, 0);
    const raw = await store.transaction((tx) =>
      tx.get<{ continuation?: string }>({
        tenant: "tenant",
        kind: "run",
        id: run.id,
      }),
    );
    assert.equal(raw?.value.continuation, "registered-task");
    await runtime.commands.cancel(actor, run.id, run.revision);
    await runtime.cancel!(actor, run.id);
    assert.equal(deliveries, 0);
  } finally {
    await store.close();
  }
});

test("expired issued setup requires a ticket-bound human restart; no registration effect is replayed automatically", async (t) => {
  const f = await teachingGitHubFixture(4497);
  t.after(() => f.close());
  const cookie = f.sessionCookie("restart-owner");
  const request = (path: string, body?: unknown, selectedCookie = cookie) =>
    fetch(`${f.origin}/api/v1/teaching${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "manual",
      headers: {
        cookie: selectedCookie,
        origin: f.origin,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const run = await (await request("/runs", { connectorId: "github" })).json();
  await request(`/runs/${run.id}/advance`, {
    nodeId: "app",
    revision: run.revision,
    commandId: "prepare-restart",
  });
  const original = await request(`/github/${run.id}/human`);
  const { document } = parseHTML(await original.text());
  const originalState = new URL(
    document.querySelector("form")!.getAttribute("action")!,
  ).searchParams.get("state");
  await f.store.transaction(async (tx) => {
    for (const row of await tx.list<{ phase?: string; expires?: number }>(
      "teaching-fixture",
      "handoff",
    ))
      if (row.value.phase === "registration")
        await tx.put(
          { tenant: "teaching-fixture", kind: "handoff", id: row.id },
          { ...row.value, expires: 0 },
          row.revision,
        );
  });
  const expired = await request(`/github/${run.id}/human`);
  assert.equal(expired.status, 409);
  assert.match(await expired.text(), /Return to connection/);
  assert.equal(
    (await (await request(`/runs/${run.id}`)).json()).nodes[0].state,
    "uncertain",
  );
  const recovery = await request(`/github/${run.id}/recovery`);
  const html = await recovery.text();
  assert.match(html, /Start a new registration/);
  const ticket = /ticket:"([a-f0-9-]{36})"/.exec(html)?.[1];
  assert.ok(ticket);
  assert.equal(
    (await request(`/github/${run.id}/recovery`, { ticket, restart: false }))
      .status,
    400,
  );
  assert.equal(
    (
      await request(
        `/github/${run.id}/recovery`,
        { ticket, restart: true },
        f.sessionCookie("foreign"),
      )
    ).status,
    403,
  );
  const restarted = await request(`/github/${run.id}/recovery`, {
    ticket,
    restart: true,
  });
  assert.equal(restarted.status, 200);
  assert.equal(f.effects.conversions, 0);
  assert.equal(
    (await (await request(`/runs/${run.id}`)).json()).nodes[0].state,
    "awaiting-human",
  );
  assert.equal(
    (await request(`/github/${run.id}/recovery`, { ticket, restart: true }))
      .status,
    403,
  );
  const next = parseHTML(
    await (await request(`/github/${run.id}/human`)).text(),
  );
  assert.notEqual(
    new URL(
      next.document.querySelector("form")!.getAttribute("action")!,
    ).searchParams.get("state"),
    originalState,
  );
  assert.equal(
    (
      await request(
        `/github/${run.id}/callback?state=${originalState}&code=obsolete`,
      )
    ).status,
    409,
  );
  assert.equal(f.effects.conversions, 0);
});
