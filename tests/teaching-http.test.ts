import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { teachingGitHubFixture } from "./fixtures/teaching-github.js";

async function fixture(port: number, lost = false) {
  const f = await teachingGitHubFixture(port, { loseConversionResponse: lost });
  const cookie = f.sessionCookie("http-author");
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
  const registration = async (runId: string) => {
    const response = await request(`/github/${runId}/human`);
    assert.equal(response.status, 200);
    const { document } = parseHTML(await response.text());
    const action = new URL(
      document.querySelector("form")!.getAttribute("action")!,
    );
    const manifest = JSON.parse(
      document.querySelector("input")!.getAttribute("value")!,
    );
    assert.equal(manifest.url, f.origin);
    return `/github/${encodeURIComponent(runId)}/callback?state=${action.searchParams.get("state")}&code=fixture-${runId.replaceAll(":", "-")}`;
  };
  return { ...f, request, registration, cookie };
}
test("AC-02 AC-11 AC-14 mounted teaching HTTP uses verified GitHub children", async (t) => {
  const f = await fixture(4470);
  t.after(() => f.close());
  const run = await (
    await f.request("/runs", { connectorId: "github", teach: true })
  ).json();
  assert.equal(run.nodes[0].state, "awaiting-human");
  assert.equal((await f.request(await f.registration(run.id))).status, 303);
  const handoff = await f.request(`/github/${run.id}/human`);
  assert.equal(handoff.status, 303);
  const url = new URL(handoff.headers.get("location")!);
  assert.equal(
    (
      await f.request(
        `/github/${encodeURIComponent(run.id)}/callback?state=${url.searchParams.get("state")}&installation_id=7`,
      )
    ).status,
    303,
  );
  const completed = await (await f.request(`/runs/${run.id}`)).json();
  assert.equal(completed.status, "complete");
  assert.equal(f.effects.conversions, 1);
  assert.equal(f.effects.tokens, 1);
  const before = { ...f.effects };
  assert.equal((await f.request(`/runs/${run.id}`)).status, 200);
  assert.deepEqual(f.effects, before);
  assert.equal(
    (await (await f.request("/runs", { connectorId: "github" })).json()).id,
    run.id,
  );
  assert.equal(f.effects.conversions, 1);
  assert.equal(f.effects.tokens, 1);
  const { demonstration } = await (
    await f.request(`/runs/${run.id}/demonstration`)
  ).json();
  assert.equal(
    demonstration.events.filter(
      (e: { verification: string }) => e.verification === "accepted",
    ).length,
    3,
  );
  const stopped = await (
    await f.request(`/demonstrations/${demonstration.id}`, {
      revision: demonstration.revision,
      consent: "stopped",
    })
  ).json();
  assert.equal(stopped.consent, "stopped");
  assert.equal(
    (await f.request("/drafts/import", { published: true, definition: {} }))
      .status,
    400,
  );
  assert.equal(
    (await f.request("/runs", { connectorId: "invented" })).status,
    400,
  );
  const other = f.sessionCookie("foreign");
  assert.equal(
    (await f.request(`/runs/${run.id}`, undefined, other)).status,
    403,
  );
  assert.equal(
    (await f.request(`/github/${run.id}/human`, undefined, other)).status,
    403,
  );
});

test("AC-20 AC-30 mounted private recovery binds recipient, revision, expiry and exact fields", async (t) => {
  const f = await fixture(4472, true);
  t.after(() => f.close());
  const run = await (
    await f.request("/runs", { connectorId: "github", teach: true })
  ).json();
  const callback = await f.registration(run.id);
  assert.equal((await f.request(callback)).status, 409);
  assert.equal(f.effects.conversions, 1);
  const path = `/github/${run.id}/recovery`;
  const collector = await f.request(path);
  assert.equal(collector.status, 200);
  assert.equal(collector.headers.get("cache-control"), "no-store");
  const ticket = /ticket:"([a-f0-9-]+)"/.exec(await collector.text())![1]!;
  const values = {
    ticket,
    appId: String(f.privateRecovery.appId),
    pem: f.privateRecovery.pem,
  };
  assert.equal(
    (await f.request(path, { ...values, owner: "forged" })).status,
    400,
  );
  assert.equal(
    (await f.request(path, values, f.sessionCookie("foreign"))).status,
    403,
  );
  assert.equal(
    (await f.request(path, values, f.sessionCookie("http-author"))).status,
    403,
  );
  assert.equal(
    (
      await f.request(path, {
        ...values,
        ticket: "00000000-0000-4000-8000-000000000000",
      })
    ).status,
    403,
  );
  const expired = await f.request(path);
  const oldTicket = /ticket:"([a-f0-9-]+)"/.exec(await expired.text())![1]!;
  await f.store.transaction(async (tx) => {
    const key = {
      tenant: "teaching-fixture",
      kind: "handoff" as const,
      id: `recovery:${oldTicket}`,
    };
    const row = await tx.get<Record<string, unknown>>(key);
    await tx.put(key, { ...row!.value, expires: 0 }, row!.revision);
  });
  assert.equal(
    (await f.request(path, { ...values, ticket: oldTicket })).status,
    403,
  );
  assert.equal((await f.request(path, values)).status, 200);
  assert.equal((await f.request(path, values)).status, 403);
  const safe = await f.store.transaction(async (tx) => ({
    events: await tx.list("teaching-fixture", "event"),
    audit: await tx.list("teaching-fixture", "audit"),
    collection: await tx.list("teaching-fixture", "collection"),
  }));
  assert.equal(JSON.stringify(safe).includes(f.privateRecovery.pem), false);
  assert.equal(safe.collection.length, 0);
  const current = await (await f.request(`/runs/${run.id}`)).json();
  assert.equal(current.nodes[0].verified, true);
  assert.equal(
    (await f.request(`/runs/${run.id}/cancel`, { revision: current.revision }))
      .status,
    200,
  );
  assert.equal((await f.request(path)).status, 403);
  assert.equal((await f.request(callback)).status, 403);
});
