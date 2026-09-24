import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { teachingGitHubFixture } from "./fixtures/teaching-github.js";
import { supabaseConnectionRecipe } from "../src/server/recipes/supabase.js";

for (const assurance of ["aal1", "aal2"] as const)
  test(`Supabase mounted ${assurance} collector enforces boundaries and completes confirmed access`, async (t) => {
    const f = await teachingGitHubFixture(4427, { supabase: assurance });
    t.after(() => f.close());
    const cookie = f.sessionCookie("owner"),
      other = f.sessionCookie("other");
    const send = (
      path: string,
      values?: unknown,
      identity = cookie,
      origin = f.origin,
    ) =>
      fetch(`${f.origin}${path}`, {
        headers: {
          cookie: identity,
          origin,
          ...(values === undefined
            ? { accept: "application/json" }
            : { "content-type": "application/json" }),
        },
        ...(values === undefined
          ? {}
          : { method: "POST", body: JSON.stringify(values) }),
      });
    const response = await send("/api/v1/teaching/runs", {
      connectorId: "supabase",
    });
    assert.equal(response.status, 200);
    const run = (await response.json()) as { id: string };
    const path = `/api/v1/teaching/supabase/${encodeURIComponent(run.id)}/human`;
    const actor = await f.runtime.identity.authenticate(
      new Request(`${f.origin}${path}`, { headers: { cookie } }),
    );
    assert.ok(actor);
    // Custom hosts also call the runtime directly, without teachingHttp's method guard.
    for (const method of ["PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
      await assert.rejects(
        () =>
          f.runtime.human!(
            actor,
            run.id,
            new Request(`${f.origin}${path}`, { method }),
          ),
        { code: "denied" },
      );
    const admission = await send(path);
    assert.equal(admission.status, 200);
    assert.equal(admission.headers.get("cache-control"), "no-store");
    const ticket = ((await admission.json()) as { ticket: string }).ticket;
    const project = {
      projectUrl: "https://synthetic.supabase.co",
      publishableKey: "sb_publishable_synthetic",
    };
    const ticketKey = {
      tenant: "teaching-fixture",
      kind: "handoff" as const,
      id: `supabase-collector:${ticket}`,
    };
    // Exercise persisted binding tampering, not merely a guessed nonexistent ID.
    const original = await f.store.transaction((tx) =>
      tx.get<Record<string, unknown>>(ticketKey),
    );
    assert.ok(original);
    for (const change of [
      { expires: 0 },
      { subject: "other" },
      { session: "another-session" },
      { runId: "another-run" },
      { nodeId: "session" },
      { revision: -1 },
    ]) {
      await f.store.transaction(async (tx) => {
        const current = await tx.get(ticketKey);
        await tx.put(
          ticketKey,
          { ...original.value, ...change },
          current!.revision,
        );
      });
      assert.equal((await send(path, { ticket, values: project })).status, 403);
    }
    await f.store.transaction(async (tx) => {
      const current = await tx.get(ticketKey);
      await tx.put(ticketKey, original.value, current!.revision);
    });
    for (const [body, identity, origin] of [
      [{ ticket, values: project }, other, f.origin],
      [{ ticket, values: project }, cookie, "https://foreign.example"],
      [{ ticket: randomUUID(), values: project }, cookie, f.origin],
      [
        { ticket, values: { factorId: randomUUID(), code: "123456" } },
        cookie,
        f.origin,
      ],
      [{ ticket, values: { ...project, source: "ui" } }, cookie, f.origin],
    ] as const)
      assert.ok(
        [400, 403].includes((await send(path, body, identity, origin)).status),
      );
    assert.equal((await send(path, undefined, other)).status, 403);
    assert.equal((await send(path.replace("supabase", "stripe"))).status, 403);
    assert.equal(
      f.effects.supabaseReads +
        f.effects.supabaseSignups +
        f.effects.supabaseSignins,
      0,
    );
    const html = async () => {
      const response = await fetch(`${f.origin}${path}`, {
        headers: { cookie, accept: "text/html" },
      });
      assert.equal(response.status, 200);
      assert.ok(
        response.headers
          .get("content-security-policy")
          ?.includes("default-src 'none'"),
      );
      return response.text();
    };
    assert.equal((await html()).includes("Set up your Supabase project"), true);
    assert.equal((await send(path, { ticket, values: project })).status, 200);
    assert.equal((await send(path, { ticket, values: project })).status, 403);
    const next = await send(path);
    assert.equal(((await next.json()) as { mode: string }).mode, "credentials");
    assert.equal(
      f.effects.supabaseReads +
        f.effects.supabaseSignups +
        f.effects.supabaseSignins,
      0,
    );
    const submit = async (values: unknown) => {
      const fresh = await send(path);
      assert.equal(fresh.status, 200);
      const input = (await fresh.json()) as { ticket: string };
      const result = await send(path, { ticket: input.ticket, values });
      assert.equal(result.status, 200);
    };
    assert.equal((await html()).includes("Account action"), true);
    await submit({
      action: "sign-up",
      email: "project-user@example.com",
      password: "synthetic-project-password",
    });
    assert.equal((await html()).includes("Confirm your email"), true);
    await submit({ confirmed: true });
    assert.equal(
      (await html()).includes("Email confirmation has not been verified yet"),
      true,
    );
    await fetch(f.supabaseConfirmationUrl);
    await submit({ confirmed: true });
    if (assurance === "aal2") {
      assert.equal(
        (await html()).includes("Verify with your authenticator"),
        true,
      );
      await submit({ factorId: f.supabaseFactorId, code: "654321" });
      assert.equal((await html()).includes("Enter a fresh code"), true);
      assert.equal(f.effects.supabaseMfaAttempts, 1);
      const state = await send(
        `/api/v1/teaching/runs/${encodeURIComponent(run.id)}`,
      );
      const snapshot = (await state.json()) as { revision: number };
      const advanced = await send(
        `/api/v1/teaching/runs/${encodeURIComponent(run.id)}/advance`,
        {
          nodeId: "access",
          revision: snapshot.revision,
          commandId: `check:${randomUUID()}`,
        },
      );
      assert.equal(advanced.status, 200);
      assert.equal(f.effects.supabaseMfaAttempts, 1);
      await submit({ factorId: f.supabaseFactorId, code: "123456" });
    }
    const complete = await send(
      `/api/v1/teaching/runs/${encodeURIComponent(run.id)}`,
    );
    assert.equal(
      ((await complete.json()) as { status: string }).status,
      "complete",
    );
    assert.equal(f.effects.supabaseSignups, 1);
    assert.equal(f.effects.supabaseMfa, assurance === "aal2" ? 1 : 0);
    assert.equal((await send(path)).status, 403);
  });

test("a person completes Supabase steps waiting inside a GitHub run on Supabase's own page", async (t) => {
  const f = await teachingGitHubFixture(4429, { supabase: "aal1" });
  t.after(() => f.close());
  const cookie = f.sessionCookie("owner"),
    other = f.sessionCookie("other");
  const actor = await f.runtime.identity.authenticate(
    new Request(f.origin, { headers: { cookie } }),
  );
  assert.ok(actor);
  const supabase = {
    connectorId: "supabase",
    provider: "supabase",
    profile: "supabase-password",
    target: "self",
    origin: f.origin,
    environment: "local-e2e",
    configurationVersion: "fixture-v1",
  };
  const run = await f.runtime.commands.createRun(
    actor,
    {
      provider: "github",
      profile: "github-app",
      target: "fixture-owner",
      origin: f.origin,
      environment: "local-e2e",
      configurationVersion: "fixture-v1",
    },
    supabaseConnectionRecipe.invocations.map((node) => {
      assert.equal(node.use.kind, "operation");
      return {
        id: node.id,
        operationId: node.use.id,
        operationVersion: node.use.version,
        dependsOn: node.dependsOn,
        bindings: node.bindings,
        context: supabase,
      };
    }),
    {},
  );
  const send = (path: string, values?: unknown, identity = cookie) =>
    fetch(`${f.origin}${path}`, {
      headers: {
        cookie: identity,
        origin: f.origin,
        ...(values === undefined
          ? { accept: "application/json" }
          : { "content-type": "application/json" }),
      },
      ...(values === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(values) }),
    });
  const path = `/api/v1/teaching/supabase/${encodeURIComponent(run.id)}/human`;
  // Nothing waits on a person until the step has run.
  assert.equal((await send(path)).status, 403);
  const started = await f.runtime.commands.advance(
    actor,
    run.id,
    "project",
    run.revision,
    `step:${randomUUID()}`,
  );
  assert.equal(started.state, "awaiting-human");
  // The run's own provider and a provider with no waiting step both refuse.
  for (const guessed of ["stripe", "jira"])
    assert.equal(
      (await send(path.replace("/supabase/", `/${guessed}/`))).status,
      403,
    );
  assert.equal((await send(path, undefined, other)).status, 403);
  const submit = async (values: unknown) => {
    const fresh = await send(path);
    assert.equal(fresh.status, 200);
    const input = (await fresh.json()) as { ticket: string; mode: string };
    const result = await send(path, { ticket: input.ticket, values });
    assert.equal(result.status, 200);
    return input.mode;
  };
  assert.equal(
    await submit({
      projectUrl: "https://synthetic.supabase.co",
      publishableKey: "sb_publishable_synthetic",
    }),
    "project",
  );
  assert.equal(
    await submit({
      action: "sign-up",
      email: "project-user@example.com",
      password: "synthetic-project-password",
    }),
    "credentials",
  );
  await fetch(f.supabaseConfirmationUrl);
  assert.equal(await submit({ confirmed: true }), "confirmation");
  const complete = await f.runtime.commands.snapshot(actor, run.id);
  assert.equal(complete.status, "complete");
  assert.ok(complete.nodes.every((node) => node.provider === "supabase"));
  assert.equal(f.effects.supabaseSignups, 1);
  assert.equal((await send(path)).status, 403);
});
