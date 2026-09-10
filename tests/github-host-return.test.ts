import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { createGitHubRuntime } from "../src/server/github-runtime.js";
import { teachingGitHubFixture } from "./fixtures/teaching-github.js";
import { githubConnectionRecipe } from "../src/server/teaching-runtime.js";

test("trusted host return path rejects unsafe targets and survives both verified GitHub callbacks", async (t) => {
  const fixture = await teachingGitHubFixture(4491, {
    returnPath: "/workspace/connections",
  });
  t.after(() => fixture.close());
  const options = {
    store: fixture.store,
    origin: fixture.origin,
    environment: "test",
    configurationVersion: "v1",
    identity: { authenticate: async () => null },
    authorize: async () => false,
  };
  for (const returnPath of [
    "https://foreign.example/path",
    "//foreign.example",
    "/\\foreign.example",
    "relative",
    "/path?target=other",
    "/path#fragment",
    `/${"x".repeat(512)}`,
  ]) {
    assert.throws(
      () => createGitHubRuntime({ ...options, returnPath }),
      /Invalid host return path/,
    );
  }
  assert.doesNotThrow(() =>
    createGitHubRuntime({ ...options, returnPath: `/${"x".repeat(511)}` }),
  );
  const cookie = fixture.sessionCookie("embedded-host-owner");
  const request = (path: string, body?: unknown) =>
    fetch(`${fixture.origin}/api/v1/teaching${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin: fixture.origin,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const started = await request("/runs", { connectorId: "github" });
  assert.equal(started.status, 200);
  const run = await started.json();
  const id = encodeURIComponent(run.id);
  await request(`/runs/${run.id}/advance`, {
    revision: run.revision,
    nodeId: run.nodes[0].id,
    commandId: "host-return-prepare",
  });
  const human = await request(`/github/${run.id}/human`);
  assert.equal(human.status, 200);
  const { document } = parseHTML(await human.text());
  const registration = new URL(
    document.querySelector("form")!.getAttribute("action")!,
  );
  const manifest = JSON.parse(
    document.querySelector('input[name="manifest"]')!.getAttribute("value")!,
  );
  assert.equal(
    manifest.setup_url,
    `${fixture.origin}/api/v1/teaching/github/installation-return`,
    "GitHub must receive a stable installation return URL, not an OAuth callback",
  );
  const appReturn = await request(
    `/github/${id}/callback?state=${registration.searchParams.get("state")}&code=host-return-code&returnPath=https://foreign.example`,
  );
  assert.equal(appReturn.status, 303);
  const expected = new URL("/workspace/connections", fixture.origin);
  expected.searchParams.set("teachingRun", run.id);
  assert.equal(appReturn.headers.get("location"), expected.href);
  const install = await request(`/github/${run.id}/human`);
  assert.equal(install.status, 303);
  const installUrl = new URL(install.headers.get("location")!);
  const returnPath = new URL(manifest.setup_url).pathname.replace(
    "/api/v1/teaching",
    "",
  );
  const state = installUrl.searchParams.get("state");
  assert.equal(
    (
      await request(
        `${returnPath}?state=${state}&state=${state}&installation_id=7`,
      )
    ).status,
    403,
  );
  assert.equal(
    (await request(`${returnPath}?state=invalid&installation_id=7`)).status,
    403,
  );
  const foreign = await fetch(
    `${manifest.setup_url}?state=${state}&installation_id=7`,
    {
      headers: { cookie: fixture.sessionCookie("wrong-subject") },
      redirect: "manual",
    },
  );
  assert.equal(foreign.status, 403);
  assert.equal(fixture.effects.tokens, 0);
  const verified = await request(
    `${new URL(manifest.setup_url).pathname.replace("/api/v1/teaching", "")}?state=${installUrl.searchParams.get("state")}&installation_id=7&returnPath=//foreign.example`,
  );
  assert.equal(verified.status, 303);
  assert.equal(verified.headers.get("location"), expected.href);
  assert.equal(
    (await (await request(`/runs/${run.id}`)).json()).status,
    "complete",
  );
  assert.equal(fixture.effects.conversions, 1);
  assert.equal(fixture.effects.tokens, 1);
  assert.equal(
    (await request(`${returnPath}?state=${state}&installation_id=7`)).status,
    403,
    "consumed return cannot be replayed",
  );

  // A setup URL belongs to the app, not its original authoring run. Reusing that
  // app after access expires must route back to the new authorized parent.
  const actor = await fixture.runtime.identity.authenticate(
    new Request(fixture.origin, { headers: { cookie } }),
  );
  assert.ok(actor);
  await fixture.store.transaction(async (tx) => {
    for (const artifact of await tx.list<{ kind: string; expires: number }>(
      actor.tenantId,
      "artifact",
    )) {
      if (["installation", "connection"].includes(artifact.value.kind))
        await tx.put(
          { tenant: actor.tenantId, kind: "artifact", id: artifact.id },
          { ...artifact.value, expires: 0 },
          artifact.revision,
        );
    }
  });
  let next = await fixture.runtime.executeRecipe(
    actor,
    githubConnectionRecipe,
    {},
    "github",
  );
  for (const nodeId of ["app", "installation"]) {
    const response = await request(`/runs/${next.id}/advance`, {
      revision: next.revision,
      nodeId,
      commandId: `new-parent:${nodeId}`,
    });
    assert.equal(response.status, 200);
    next = await (await request(`/runs/${next.id}`)).json();
  }
  const nextHandoff = await request(`/github/${next.id}/human`);
  assert.equal(nextHandoff.status, 303);
  const nextState = new URL(
    nextHandoff.headers.get("location")!,
  ).searchParams.get("state");
  const nextReturn = await request(
    `${returnPath}?state=${nextState}&installation_id=7`,
  );
  assert.equal(nextReturn.status, 303);
  assert.equal(
    new URL(nextReturn.headers.get("location")!).searchParams.get(
      "teachingRun",
    ),
    next.id,
  );
  assert.equal(
    (await (await request(`/runs/${next.id}`)).json()).status,
    "complete",
  );
  assert.equal(fixture.effects.conversions, 1);
  assert.equal(fixture.effects.tokens, 2);
});
