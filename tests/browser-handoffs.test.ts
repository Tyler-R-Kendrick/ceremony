import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  browserHandoffRoute,
  createBrowserHandoffs,
  type BrowserHandoffSummary,
} from "../src/server/browser-handoffs.js";
import {
  createSecrets,
  runCeremony,
  type CeremonyPage,
  type HumanParticipationRequest,
} from "../src/server/browser-driver.js";
import { createHostBrowserLogin } from "../src/server/browser-login-host.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import type { PageSnapshot } from "../src/core/browser-contracts.js";
import type { ActorContext } from "../src/core/operation-contracts.js";

/**
 * Durable hand-offs. "Two processes" here are two `createBrowserHandoffs`
 * instances over one store - separate generations with nothing in memory in
 * common, which is exactly what two server processes share.
 */

const contract = {
  surface: "provider-browser",
  recipient: "initiating-subject",
  delegation: "a2h-authorize",
  resume: "verify",
} as const;
const owner: ActorContext = {
  tenantId: "tenant-a",
  subjectId: "person-a",
  sessionId: "session-a",
  actorKind: "human",
  capabilities: ["executor"],
};
const colleague: ActorContext = { ...owner, subjectId: "person-b" };
const otherTenant: ActorContext = { ...owner, tenantId: "tenant-b" };
const request: HumanParticipationRequest = {
  reason: "human-challenge",
  surface: "provider-browser",
  recipient: "initiating-subject",
  path: "https://provider.example/challenge",
  attempt: 1,
};

function store(path = ":memory:") {
  return new SQLiteCeremonyStore(path, {
    current: "k",
    keys: { k: randomBytes(32) },
  });
}

/** Wait until `owner` has a hand-off pending, as the human route would see it. */
async function waiting(
  handoffs: ReturnType<typeof createBrowserHandoffs>,
  actor = owner,
): Promise<BrowserHandoffSummary> {
  for (let tries = 0; tries < 200; tries++) {
    const [first] = await handoffs.pending(actor);
    if (first) return first;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("No hand-off became pending");
}

for (const answer of ["completed", "declined"] as const)
  test(`a hand-off started in one process is answered from another (${answer})`, async (t) => {
    const shared = store();
    t.after(() => shared.close());
    const holding = createBrowserHandoffs({ store: shared, pollMs: 5 });
    const serving = createBrowserHandoffs({ store: shared, pollMs: 5 });
    assert.notEqual(holding.generation, serving.generation);
    const notified: BrowserHandoffSummary[] = [];
    const outcome = holding
      .participation(owner, {
        contract,
        onRequested: (summary) => notified.push(summary),
      })
      .request(request);
    const pending = await waiting(serving);
    assert.deepEqual(notified, [pending]);
    assert.equal(pending.status, "pending");
    assert.equal(pending.path, "https://provider.example/challenge");
    assert.equal(pending.liveView, false);
    assert.deepEqual(await serving.resolve(owner, pending.handoffRef, answer), {
      status: "delivered",
    });
    assert.equal(await outcome, answer);
    assert.equal(
      (await serving.read(owner, pending.handoffRef))?.status,
      answer,
    );
    assert.deepEqual(await serving.pending(owner), []);
    // The same answer twice is not a second resume.
    assert.deepEqual(await serving.resolve(owner, pending.handoffRef, answer), {
      status: "refused",
      reason: "cancelled",
    });
  });

test("a hand-off belongs to its subject and tenant", async (t) => {
  const shared = store();
  t.after(() => shared.close());
  const handoffs = createBrowserHandoffs({ store: shared, pollMs: 5 });
  const outcome = handoffs.participation(owner, { contract }).request(request);
  const pending = await waiting(handoffs);
  assert.deepEqual(await handoffs.pending(colleague), []);
  assert.deepEqual(await handoffs.pending(otherTenant), []);
  assert.equal(await handoffs.read(colleague, pending.handoffRef), undefined);
  assert.equal(await handoffs.read(otherTenant, pending.handoffRef), undefined);
  for (const stranger of [colleague, otherTenant])
    assert.deepEqual(
      await handoffs.resolve(stranger, pending.handoffRef, "completed"),
      { status: "refused", reason: "not-authorized" },
    );
  assert.deepEqual(
    await handoffs.resolve(owner, "not-a-reference", "completed"),
    { status: "refused", reason: "not-authorized" },
  );
  await handoffs.resolve(owner, pending.handoffRef, "declined");
  assert.equal(await outcome, "declined");
});

test("an unanswered hand-off expires on both sides", async (t) => {
  const shared = store();
  t.after(() => shared.close());
  const handoffs = createBrowserHandoffs({
    store: shared,
    pollMs: 5,
    ttlMs: 60,
  });
  const outcome = handoffs.participation(owner, { contract }).request(request);
  const pending = await waiting(handoffs);
  // The waiter stops at the deadline and says nobody could be reached.
  assert.equal(await outcome, "unavailable");
  assert.equal(
    (await handoffs.read(owner, pending.handoffRef))?.status,
    "expired",
  );
  assert.deepEqual(
    await handoffs.resolve(owner, pending.handoffRef, "completed"),
    { status: "refused", reason: "expired" },
  );
});

test("an answer after the holding process is gone fails by name instead of resuming nothing", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ceremony-handoffs-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const keys = { current: "k", keys: { k: randomBytes(32) } };
  const before = new SQLiteCeremonyStore(join(directory, "store.db"), keys);
  let clock = 1_000_000;
  // The process that held the browser: it writes the hand-off, then stops -
  // its next poll never comes, as though it had been killed.
  const crashed = createBrowserHandoffs({
    store: before,
    now: () => clock,
    sleep: () => new Promise(() => {}),
  });
  void crashed
    .participation(owner, {
      contract,
      liveView: async () => "https://viewer.example/live/tab",
    })
    .request(request);
  const [pending] = await (async () => {
    for (;;) {
      const found = await crashed.pending(owner);
      if (found.length) return found;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
  assert.ok(pending);
  assert.equal(pending.liveView, true);
  await before.close();
  // A new process, on the same database, after the heartbeat has gone quiet.
  const after = new SQLiteCeremonyStore(join(directory, "store.db"), keys);
  t.after(() => after.close());
  clock += 60_000;
  const restarted = createBrowserHandoffs({ store: after, now: () => clock });
  assert.equal(
    (await restarted.read(owner, pending.handoffRef))?.status,
    "lost",
  );
  assert.equal(
    await restarted.controlUrl(owner, pending.handoffRef),
    undefined,
  );
  assert.deepEqual(
    await restarted.resolve(owner, pending.handoffRef, "completed"),
    { status: "refused", reason: "generation-mismatch" },
  );
  assert.equal(
    (await restarted.read(owner, pending.handoffRef))?.status,
    "lost",
  );
  assert.deepEqual(await restarted.pending(owner), []);
});

test("a live view is kept encrypted and handed only to the owner while the hand-off waits", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ceremony-handoffs-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const shared = store(join(directory, "store.db"));
  t.after(() => shared.close());
  const handoffs = createBrowserHandoffs({ store: shared, pollMs: 5 });
  const notified: BrowserHandoffSummary[] = [];
  const outcome = handoffs
    .participation(owner, {
      contract,
      liveView: async () => "https://viewer.example/live/secret-tab",
      onRequested: (summary) => notified.push(summary),
    })
    .request(request);
  const pending = await waiting(handoffs);
  assert.equal(pending.liveView, true);
  assert.equal(JSON.stringify(notified).includes("secret-tab"), false);
  assert.equal(JSON.stringify(pending).includes("secret-tab"), false);
  assert.equal(
    await handoffs.controlUrl(owner, pending.handoffRef),
    "https://viewer.example/live/secret-tab",
  );
  assert.equal(
    await handoffs.controlUrl(colleague, pending.handoffRef),
    undefined,
  );
  for (const file of readdirSync(directory))
    assert.equal(
      readFileSync(join(directory, file)).includes("secret-tab"),
      false,
      file,
    );
  await handoffs.resolve(owner, pending.handoffRef, "completed");
  assert.equal(await outcome, "completed");
  assert.equal(await handoffs.controlUrl(owner, pending.handoffRef), undefined);
});

test("a live view that is not https is not kept", async (t) => {
  const shared = store();
  t.after(() => shared.close());
  const handoffs = createBrowserHandoffs({ store: shared, pollMs: 5 });
  const outcome = handoffs
    .participation(owner, {
      contract,
      liveView: async () => "http://viewer.example/live/tab",
    })
    .request(request);
  const pending = await waiting(handoffs);
  assert.equal(pending.liveView, false);
  await handoffs.resolve(owner, pending.handoffRef, "completed");
  assert.equal(await outcome, "completed");
});

test("the human route shows, hands over and resolves a hand-off, same-origin only", async (t) => {
  const shared = store();
  t.after(() => shared.close());
  const holding = createBrowserHandoffs({ store: shared, pollMs: 5 });
  const serving = createBrowserHandoffs({ store: shared, pollMs: 5 });
  const outcome = holding
    .participation(owner, {
      contract,
      liveView: async () => "https://viewer.example/live/tab",
    })
    .request(request);
  const pending = await waiting(serving);
  const base = "https://app.example/human/browser";
  const shown = await browserHandoffRoute(
    serving,
    owner,
    new Request(`${base}?handoff=${pending.handoffRef}`),
  );
  assert.equal(shown.status, 200);
  assert.equal(shown.headers.get("cache-control"), "no-store");
  const html = await shown.text();
  assert.match(html, /A sign-in needs you/);
  assert.match(html, /live-view=1/);
  assert.equal(html.includes("viewer.example"), false);
  const live = await browserHandoffRoute(
    serving,
    owner,
    new Request(`${base}?handoff=${pending.handoffRef}&live-view=1`),
  );
  assert.equal(live.status, 303);
  assert.equal(live.headers.get("location"), "https://viewer.example/live/tab");
  assert.equal(
    (
      await browserHandoffRoute(
        serving,
        colleague,
        new Request(`${base}?handoff=${pending.handoffRef}&live-view=1`),
      )
    ).status,
    410,
  );
  const post = (headers: Record<string, string>) =>
    new Request(base, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams({
        handoff: pending.handoffRef,
        answer: "completed",
      }),
    });
  await assert.rejects(
    browserHandoffRoute(
      serving,
      owner,
      post({ origin: "https://elsewhere.example" }),
    ),
  );
  const answered = await browserHandoffRoute(
    serving,
    owner,
    post({ origin: "https://app.example" }),
  );
  assert.equal(answered.status, 303);
  assert.equal(await outcome, "completed");
  const again = await browserHandoffRoute(
    serving,
    owner,
    post({ origin: "https://app.example" }),
  );
  assert.equal(again.status, 409);
  const done = await browserHandoffRoute(
    serving,
    owner,
    new Request(`${base}?handoff=${pending.handoffRef}`),
  );
  assert.match(await done.text(), /continuing/);
  assert.equal(
    (
      await browserHandoffRoute(
        serving,
        owner,
        new Request(`${base}?handoff=bhof_${"0".repeat(32)}`),
      )
    ).status,
    404,
  );
});

test("the human route names a lost browser when a person answers after a restart", async (t) => {
  const shared = store();
  t.after(() => shared.close());
  let clock = 5_000_000;
  const crashed = createBrowserHandoffs({
    store: shared,
    now: () => clock,
    sleep: () => new Promise(() => {}),
  });
  void crashed.participation(owner, { contract }).request(request);
  const pending = await waiting(crashed);
  clock += 60_000;
  const restarted = createBrowserHandoffs({ store: shared, now: () => clock });
  const response = await browserHandoffRoute(
    restarted,
    owner,
    new Request("https://app.example/human/browser", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-origin",
      },
      body: new URLSearchParams({
        handoff: pending.handoffRef,
        answer: "completed",
      }),
    }),
  );
  assert.equal(response.status, 409);
  const html = await response.text();
  assert.match(html, /generation-mismatch/);
  assert.match(html, /no longer running/);
});

/** A sign-up page with a required choice only a person makes. */
function choicePage(): CeremonyPage & {
  chosen: () => string | undefined;
  clicks: number[];
} {
  let chosen: string | undefined;
  const clicks: number[] = [];
  const snapshot = (): PageSnapshot => ({
    path: "https://provider.example/signup",
    title: "Create your account",
    headings: ["Create your account"],
    alerts: [],
    challenge: false,
    passkey: false,
    elements: [
      {
        index: 0,
        kind: "select",
        label: "Country or region",
        options: ["Select a country", "Canada", "Japan"],
        required: true,
        filled: chosen !== undefined,
      },
      { index: 1, kind: "button", text: "Create account" },
    ],
  });
  return {
    chosen: () => chosen,
    clicks,
    url: async () => "https://provider.example/signup",
    goto: async () => {},
    snapshot: async () => snapshot(),
    fill: async () => {},
    click: async (element) => {
      clicks.push(element.index);
    },
    check: async () => {},
    settle: async () => {},
    select: async (_element, option) => {
      chosen = option;
    },
  };
}

test("the login driver resumes the same browser when a person answers through another process", async (t) => {
  const shared = store();
  t.after(() => shared.close());
  const holding = createBrowserHandoffs({ store: shared, pollMs: 5 });
  const serving = createBrowserHandoffs({ store: shared, pollMs: 5 });
  const page = choicePage();
  const { createHeuristicInterpreter } =
    await import("../src/server/browser-interpreter.js");
  const run = runCeremony({
    page,
    goal: "registration",
    allowedOrigins: ["https://provider.example"],
    secrets: createSecrets({}),
    interpreter: createHeuristicInterpreter(),
    human: holding.participation(owner, { contract }),
    maxSteps: 4,
  });
  const pending = await waiting(serving);
  assert.equal(pending.reason, "choice");
  // The person makes the choice in the provider's page, then says so.
  await page.select!(
    { index: 0, kind: "select", label: "Country or region" },
    "Japan",
  );
  await serving.resolve(owner, pending.handoffRef, "completed");
  const result = await run;
  assert.equal(result.handoffs, 1);
  assert.equal(page.chosen(), "Japan");
  assert.ok(page.clicks.includes(1), "the form is then submitted");
});

test("a host that asks for durable hand-offs gets them, and only then", () => {
  const options = {
    store: store(),
    credentials: { resolve: async () => undefined },
    knownConnectors: () => new Set<string>(),
  };
  const durable = createHostBrowserLogin({
    ...options,
    handoffs: { contract },
  });
  assert.ok(durable.handoffs);
  assert.equal(createHostBrowserLogin(options).handoffs, undefined);
});

test("an answer given moments after the holding process stopped is refused, never reported as continuing", async (t) => {
  const shared = store();
  t.after(() => shared.close());
  // Stopped well inside its heartbeat window: nothing about the record looks
  // stale yet, so only the missing acknowledgement can tell.
  const crashed = createBrowserHandoffs({
    store: shared,
    sleep: () => new Promise(() => {}),
  });
  void crashed.participation(owner, { contract }).request(request);
  const pending = await waiting(crashed);
  const serving = createBrowserHandoffs({
    store: shared,
    pollMs: 5,
    acknowledgeWithinMs: 60,
  });
  assert.deepEqual(
    await serving.resolve(owner, pending.handoffRef, "completed"),
    { status: "refused", reason: "generation-mismatch" },
  );
  assert.equal((await serving.read(owner, pending.handoffRef))?.status, "lost");
  const shown = await browserHandoffRoute(
    serving,
    owner,
    new Request(
      `https://app.example/human/browser?handoff=${pending.handoffRef}`,
    ),
  );
  const html = await shown.text();
  assert.doesNotMatch(html, /continuing/);
  assert.match(html, /no longer running/);
});

test("an answer is not recorded for a hand-off that lapses between the read and the write", async (t) => {
  const shared = store();
  t.after(() => shared.close());
  const holding = createBrowserHandoffs({ store: shared, pollMs: 5 });
  const outcome = holding.participation(owner, { contract }).request(request);
  const pending = await waiting(holding);
  const expiresAt = Date.parse(pending.expiresAt);
  // The route's first look finds it pending; by its write it has expired.
  let looks = 0;
  const lapsing = createBrowserHandoffs({
    store: shared,
    // Not stale: the holder is alive; only the deadline passes.
    staleAfterMs: 3_600_000,
    now: () => (looks++ < 2 ? expiresAt - 1 : expiresAt + 1),
  });
  assert.deepEqual(
    await lapsing.resolve(owner, pending.handoffRef, "completed"),
    { status: "refused", reason: "expired" },
  );
  assert.notEqual(
    (await holding.read(owner, pending.handoffRef))?.status,
    "completed",
  );
  await holding.resolve(owner, pending.handoffRef, "declined");
  assert.equal(await outcome, "declined");
});

test("an answer that lands just as the holder gives up on the hand-off is honoured, not dropped", async (t) => {
  const shared = store();
  t.after(() => shared.close());
  let transactions = 0;
  let answer: (() => Promise<void>) | undefined;
  // The holder's own view of the store, with a hook to land the person's
  // answer between its last read and its expiry write.
  const racing = {
    transaction: async <T>(
      work: Parameters<typeof shared.transaction<T>>[0],
    ): Promise<T> => {
      if (++transactions === 3) await answer?.();
      return shared.transaction(work);
    },
    close: () => shared.close(),
  };
  let calls = 0;
  const start = Date.now();
  const holding = createBrowserHandoffs({
    store: racing,
    pollMs: 1,
    ttlMs: 1_000,
    // Created at `start`; every later look is past the deadline.
    now: () => (calls++ === 0 ? start : start + 5_000),
  });
  const outcome = holding.participation(owner, { contract }).request(request);
  answer = async () => {
    const [row] = await shared.transaction((tx) =>
      tx.list<Record<string, unknown>>(owner.tenantId, "handoff"),
    );
    assert.ok(row);
    await shared.transaction((tx) =>
      tx.put(
        { tenant: owner.tenantId, kind: "handoff", id: row.id },
        { ...row.value, status: "completed" },
        row.revision,
      ),
    );
  };
  assert.equal(await outcome, "completed");
  const [row] = await shared.transaction((tx) =>
    tx.list<{ status: string; acknowledged?: boolean }>(
      owner.tenantId,
      "handoff",
    ),
  );
  assert.equal(row?.value.status, "completed");
  assert.equal(row?.value.acknowledged, true);
});
