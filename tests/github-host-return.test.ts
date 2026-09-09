import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { createGitHubRuntime } from "../src/server/github-runtime.js";
import { teachingGitHubFixture } from "./fixtures/teaching-github.js";

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
  const verified = await request(
    `/github/${id}/callback?state=${installUrl.searchParams.get("state")}&installation_id=7&returnPath=//foreign.example`,
  );
  assert.equal(verified.status, 303);
  assert.equal(verified.headers.get("location"), expected.href);
  assert.equal(
    (await (await request(`/runs/${run.id}`)).json()).status,
    "complete",
  );
  assert.equal(fixture.effects.conversions, 1);
  assert.equal(fixture.effects.tokens, 1);
});
