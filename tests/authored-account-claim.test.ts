import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import type { ActorContext } from "../src/core/operation-contracts.js";
import { createGitHubRuntime } from "../src/server/github-runtime.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import {
  accountMatchesIntent,
  authoredAccountKey,
  authoredAccountIntentKey,
  saveAuthoredAccount,
  saveAuthoredAccountIntent,
} from "../src/server/authored-operations.js";
import { authoredAccountClaim } from "../src/server/authored-account.js";
import type { RunRecord } from "../src/server/commands.js";
import { teachingHttp } from "../src/server/teaching-http.js";

const owner: ActorContext = {
  tenantId: "claim-tenant",
  subjectId: "claim-owner",
  sessionId: "claim-session",
  actorKind: "human",
  capabilities: ["executor"],
};
const generated = {
  username: "new-account",
  email: "selected@example.test",
  password: "synthetic-<password>&\"'",
};

async function fixture(connector = "novel") {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  const origin = "https://ceremony.example";
  const identifier =
    connector === "github" ? generated.username : generated.email;
  let registrations = 0;
  const decisions: string[] = [];
  let principal: ActorContext | null = owner;
  let allowed = true;
  let onAuthorize: ((run: RunRecord) => Promise<void>) | undefined;
  const runtime = createGitHubRuntime({
    store,
    origin,
    environment: "test",
    configurationVersion: "v1",
    identity: { authenticate: async () => principal },
    authorize: async (_actor, run, operation) => {
      decisions.push(operation);
      await onAuthorize?.(run);
      return allowed;
    },
    ...(connector === "github"
      ? {
          inbox: {
            provision: async () => generated.email,
            latest: async () => undefined,
          },
        }
      : {}),
    browser: {
      complete: async (input) => {
        registrations++;
        assert.equal(input.generateAccount, true);
        assert.equal(input.preferredUsername, identifier);
        await input.vault!.stage!(generated);
        await input.vault!.put(generated);
        return { status: "credentials", accountStored: true };
      },
    },
  });
  await store.transaction((tx) =>
    tx.put(
      {
        tenant: owner.tenantId,
        kind: "artifact",
        id: `installed-connector:${connector}`,
      },
      {
        author: owner.subjectId,
        session: owner.sessionId,
        manifest: { name: "Novel", methods: [] },
        definition: {},
        discovery: {
          origin: "https://novel.example",
          documents: [],
          methods: [],
          grantTypes: [],
          searchUsed: false,
        },
      },
      null,
    ),
  );
  const run = await runtime.commands.createRun(
    owner,
    {
      provider: connector,
      profile: connector === "github" ? "github-app" : "authored",
      target: connector === "github" ? generated.username : connector,
      origin,
      environment: "test",
      configurationVersion: "v1",
    },
    [
      {
        id: "account",
        operationId: "authored.register-account",
        operationVersion: "1.0.0",
        dependsOn: [],
        bindings: {},
      },
    ],
    {},
  );
  await saveAuthoredAccountIntent(store, owner, run.id, {
    identifier,
    status: "available",
  });
  await runtime.commands.advance(
    owner,
    run.id,
    "account",
    run.revision,
    "register",
  );
  const path = `/api/v1/teaching/${connector}/${encodeURIComponent(run.id)}/account`;
  const request = (init?: RequestInit, route = path) =>
    teachingHttp(new Request(`${origin}${route}`, init), runtime);
  return {
    store,
    runtime,
    run,
    origin,
    path,
    request,
    decisions,
    direct: async (actor = owner, method = "POST") => {
      const record = await store.transaction((tx) =>
        tx.get<RunRecord>({ tenant: owner.tenantId, kind: "run", id: run.id }),
      );
      assert.ok(record);
      return authoredAccountClaim(
        store,
        {
          ...record.value,
          actor,
          runId: run.id,
          nodeId: "account",
          commandId: "claim",
          effectId: "claim",
          signal: new AbortController().signal,
        },
        record,
        new Request(`${origin}${path}`, {
          method,
          headers: {
            origin,
            "content-type": "application/x-www-form-urlencoded",
          },
          ...(["GET", "HEAD"].includes(method)
            ? {}
            : { body: "action=reveal" }),
        }),
        origin,
      );
    },
    registrations: () => registrations,
    authenticate: (actor: ActorContext | null) => {
      principal = actor;
    },
    authorize: (value: boolean) => {
      allowed = value;
    },
    duringAuthorization: (fn: (run: RunRecord) => Promise<void>) => {
      onAuthorize = fn;
    },
  };
}

test("generated account credentials are claimable only through an explicit private human POST", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const before = await f.runtime.commands.snapshot(owner, f.run.id);
  assert.equal(before.status, "complete");
  const ordinary = await f.request(
    undefined,
    `/api/v1/teaching/runs/${f.run.id}`,
  );
  assert.equal(ordinary.status, 200);
  assert.equal((await ordinary.text()).includes(generated.password), false);
  const page = await f.request();
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("referrer-policy"), "same-origin");
  const landing = await page.text();
  assert.equal(landing.includes(generated.password), false);
  assert.match(landing, /Show saved account credentials/);
  const shown = await f.request({
    method: "POST",
    headers: {
      origin: f.origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "action=reveal",
  });
  assert.equal(shown.status, 200);
  assert.equal(f.decisions.at(-1), "novel.claim-account");
  assert.equal(shown.headers.get("cache-control"), "no-store");
  assert.equal(shown.headers.get("referrer-policy"), "no-referrer");
  assert.equal(shown.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(shown.headers.get("x-content-type-options"), "nosniff");
  assert.match(
    shown.headers.get("content-security-policy") ?? "",
    /frame-ancestors 'none'/,
  );
  const { document } = parseHTML(await shown.text());
  const destination = new URL(
    document.querySelector("a")!.getAttribute("href")!,
  );
  assert.equal(destination.searchParams.get("connector"), "novel");
  assert.equal(destination.searchParams.get("teachingRun"), f.run.id);
  assert.equal(
    document.querySelector<HTMLInputElement>('input[name="password"]')?.value,
    generated.password,
  );
  assert.equal(document.querySelectorAll("script").length, 0);
  assert.equal(
    document.querySelector<HTMLInputElement>('input[name="username"]')?.value,
    generated.username,
  );
  assert.equal(
    document.querySelector<HTMLInputElement>('input[name="email"]')?.value,
    generated.email,
  );
  assert.equal(
    (await (await f.request()).text()).includes(generated.password),
    false,
  );
  assert.deepEqual(await f.runtime.commands.snapshot(owner, f.run.id), before);
  assert.equal(f.registrations(), 1);
  assert.equal(
    (await f.request(undefined, f.path.replace(/\/account$/, "/human"))).status,
    403,
  );
});

test("completed GitHub account credentials use the claim route without reopening the human auth flow", async (t) => {
  const f = await fixture("github");
  t.after(() => f.store.close());
  const post: RequestInit = {
    method: "POST",
    headers: {
      origin: f.origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "action=reveal",
  };
  assert.equal((await f.request()).status, 200);
  const response = await f.request(post);
  assert.equal(response.status, 200);
  assert.equal(f.decisions.at(-1), "github.claim-account");
  const { document } = parseHTML(await response.text());
  assert.equal(
    document.querySelector<HTMLInputElement>('input[name="password"]')?.value,
    generated.password,
  );
  assert.equal(
    (await f.request(post, f.path.replace(/\/account$/, "/human"))).status,
    405,
  );
  assert.equal(f.registrations(), 1);
});

test("credential claims reject foreign actors, sessions, policy and request boundaries without disclosure", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const post: RequestInit = {
    method: "POST",
    headers: {
      origin: f.origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "action=reveal",
  };
  for (const principal of [
    null,
    { ...owner, subjectId: "foreign" },
    { ...owner, tenantId: "foreign" },
    { ...owner, sessionId: "foreign" },
    { ...owner, actorKind: "agent" as const },
    { ...owner, capabilities: [] },
  ]) {
    f.authenticate(principal);
    for (const init of [undefined, post]) {
      const result = await f.request(init);
      assert.equal(result.status, principal ? 403 : 401);
      assert.equal((await result.text()).includes("synthetic-"), false);
    }
  }
  f.authenticate(owner);
  f.authorize(false);
  assert.equal((await f.request(post)).status, 403);
  f.authorize(true);
  for (const [headers, body, status] of [
    [
      { "content-type": "application/x-www-form-urlencoded" },
      "action=reveal",
      403,
    ],
    [
      {
        origin: "https://foreign.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      "action=reveal",
      403,
    ],
    [
      {
        origin: f.origin,
        "sec-fetch-site": "cross-site",
        "content-type": "application/x-www-form-urlencoded",
      },
      "action=reveal",
      403,
    ],
    [
      { origin: f.origin, "content-type": "application/json" },
      '{"action":"reveal"}',
      400,
    ],
    [post.headers, "action=other", 400],
    [post.headers, "action=reveal&action=reveal", 400],
    [post.headers, "action=reveal&extra=field", 400],
    [post.headers, "action=" + "x".repeat(257), 400],
  ] as const) {
    const result = await f.request({
      method: "POST",
      headers: new Headers(headers),
      body,
    });
    assert.equal(result.status, status);
    assert.equal((await result.text()).includes("synthetic-"), false);
  }
  assert.equal(
    (await f.request(post, f.path.replace("/novel/", "/other/"))).status,
    403,
  );
  assert.equal(f.registrations(), 1);
});

test("credential claims require verified current-run progress and its selected stored account", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const post: RequestInit = {
    method: "POST",
    headers: {
      origin: f.origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "action=reveal",
  };
  const key = { tenant: owner.tenantId, kind: "run" as const, id: f.run.id };
  const original = await f.store.transaction((tx) => tx.get<RunRecord>(key));
  assert.ok(original);
  for (const change of [
    { status: "cancelled" as const },
    { sessionId: "foreign" },
    { configurationVersion: "retired" },
  ]) {
    await f.store.transaction(async (tx) => {
      const current = await tx.get(key);
      await tx.put(key, { ...original.value, ...change }, current!.revision);
    });
    assert.equal((await f.request(post)).status, 403);
  }
  await f.store.transaction(async (tx) => {
    const current = await tx.get(key);
    await tx.put(key, original.value, current!.revision);
  });
  const nodeKey = {
    tenant: owner.tenantId,
    kind: "node" as const,
    id: `${f.run.id}:account`,
  };
  const node = await f.store.transaction((tx) =>
    tx.get<Record<string, unknown>>(nodeKey),
  );
  assert.ok(node);
  await f.store.transaction((tx) =>
    tx.put(nodeKey, { ...node.value, verified: false }, node.revision),
  );
  assert.equal((await f.request(post)).status, 403);
  await f.store.transaction((tx) =>
    tx.put(nodeKey, node.value, node.revision + 1),
  );
  await saveAuthoredAccount(f.store, owner, "novel", {
    ...generated,
    email: "another@example.test",
  });
  assert.equal((await f.request(post)).status, 403);
  const mismatched = await f.request(
    undefined,
    `/api/v1/teaching/runs/${f.run.id}`,
  );
  assert.equal((await mismatched.json()).account, undefined);
  await saveAuthoredAccount(f.store, owner, "novel", generated);
  const intentKey = authoredAccountIntentKey(owner, f.run.id);
  const intent = await f.store.transaction((tx) => tx.get(intentKey));
  assert.ok(intent);
  await f.store.transaction((tx) => tx.delete(intentKey, intent.revision));
  assert.equal((await f.request(post)).status, 403);
  await f.store.transaction((tx) => tx.put(intentKey, intent.value, null));
  const accountKey = authoredAccountKey(owner, "novel");
  const account = await f.store.transaction((tx) => tx.get(accountKey));
  assert.ok(account);
  await f.store.transaction((tx) => tx.delete(accountKey, account.revision));
  assert.equal((await f.request(post)).status, 403);
  assert.equal(f.registrations(), 1);
});

test("credential claims recheck the run after an asynchronous policy decision", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  f.duringAuthorization(async (run) => {
    const key = { tenant: owner.tenantId, kind: "run" as const, id: run.id };
    await f.store.transaction(async (tx) => {
      const current = await tx.get<RunRecord>(key);
      assert.ok(current);
      await tx.put(
        key,
        { ...current.value, target: "changed-during-policy" },
        current.revision,
      );
    });
  });
  const result = await f.request({
    method: "POST",
    headers: {
      origin: f.origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "action=reveal",
  });
  assert.equal(result.status, 403);
  assert.equal((await result.text()).includes("synthetic-"), false);
});

test("direct claim handlers preserve human-only methods and typed denial without relying on HTTP guards", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const agent = { ...owner, actorKind: "agent" as const };
  await assert.rejects(f.direct(agent), { code: "denied" });
  for (const method of ["PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])
    await assert.rejects(f.direct(owner, method), { code: "denied" });
  const decisions = f.decisions.length;
  await assert.rejects(
    f.runtime.human!(agent, f.run.id, new Request(`${f.origin}${f.path}`)),
    { code: "denied" },
  );
  assert.equal(f.decisions.length, decisions);
  f.authorize(false);
  await assert.rejects(
    f.runtime.human!(owner, f.run.id, new Request(`${f.origin}${f.path}`)),
    { code: "denied" },
  );
});

test("claim transaction independently rejects malformed ownership and unrelated or missing verification", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const key = { tenant: owner.tenantId, kind: "run" as const, id: f.run.id };
  const original = await f.store.transaction((tx) => tx.get<RunRecord>(key));
  assert.ok(original);
  for (const change of [
    { id: "another-id" },
    { subjectId: "foreign" },
    { sessionId: "foreign" },
    { status: "cancelled" as const },
    {
      nodes: original.value.nodes.map((node) => ({
        ...node,
        operationId: "authored.verify-access",
      })),
    },
  ]) {
    await f.store.transaction(async (tx) => {
      const current = await tx.get(key);
      await tx.put(key, { ...original.value, ...change }, current!.revision);
    });
    await assert.rejects(f.direct(), { code: "denied" });
  }
  await f.store.transaction(async (tx) => {
    const current = await tx.get(key);
    await tx.put(key, original.value, current!.revision);
  });
  const nodeKey = {
    tenant: owner.tenantId,
    kind: "node" as const,
    id: `${f.run.id}:account`,
  };
  const node = await f.store.transaction((tx) =>
    tx.get<Record<string, unknown>>(nodeKey),
  );
  assert.ok(node);
  await f.store.transaction((tx) => tx.delete(nodeKey, node.revision));
  await assert.rejects(f.direct(), { code: "denied" });
  await f.store.transaction((tx) => tx.put(nodeKey, node.value, null));
  await saveAuthoredAccountIntent(f.store, owner, f.run.id, {
    identifier: "different@example.test",
    status: "existing",
  });
  await assert.rejects(f.direct(), { code: "denied" });
});

test("claim reauthorization fails closed if the run disappears during the policy decision", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  f.duringAuthorization(async (run) => {
    const key = { tenant: owner.tenantId, kind: "run" as const, id: run.id };
    await f.store.transaction(async (tx) => {
      const record = await tx.get(key);
      assert.ok(record);
      await tx.delete(key, record.revision);
    });
  });
  await assert.rejects(
    f.runtime.human!(owner, f.run.id, new Request(`${f.origin}${f.path}`)),
    { code: "denied" },
  );
});

test("verified authorization can release the selected credentials before downstream access completes", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const key = { tenant: owner.tenantId, kind: "run" as const, id: f.run.id };
  await f.store.transaction(async (tx) => {
    const current = await tx.get<RunRecord>(key);
    assert.ok(current);
    await tx.put(
      key,
      {
        ...current.value,
        status: "active",
        nodes: [
          {
            ...current.value.nodes[0]!,
            operationId: "authored.authorize-user",
          },
          {
            ...current.value.nodes[0]!,
            id: "access",
            operationId: "authored.verify-access",
          },
        ],
      },
      current.revision,
    );
  });
  for (const identifier of ["NEW-ACCOUNT", "selected@example.test"]) {
    const username = identifier.includes("@") ? identifier : "new-account";
    await saveAuthoredAccount(f.store, owner, "novel", {
      username,
      password: generated.password,
    });
    await saveAuthoredAccountIntent(f.store, owner, f.run.id, {
      identifier,
      status: "existing",
    });
    const response = await f.direct();
    assert.equal(response.status, 200);
    const { document } = parseHTML(await response.text());
    assert.equal(
      document.querySelector<HTMLInputElement>('input[name="username"]')?.value,
      username,
    );
    assert.equal(document.querySelector('input[name="email"]'), null);
    assert.deepEqual(
      [...document.querySelector("main")!.childNodes].map(
        (node) => node.nodeName,
      ),
      ["H1", "P", "P", "P", "P"],
    );
  }
  assert.equal(
    (await f.runtime.commands.snapshot(owner, f.run.id)).status,
    "active",
  );
  assert.equal(f.registrations(), 1);
});

test("account matching preserves email exactness and handle case folding without accepting absent accounts", () => {
  for (const identifier of ["selected@example.test", "new-account"])
    assert.equal(
      accountMatchesIntent(undefined, { identifier, status: "existing" }),
      false,
    );
  assert.equal(
    accountMatchesIntent(
      { username: "foreign" },
      { identifier: "new-account", status: "existing" },
    ),
    false,
  );
  assert.equal(
    accountMatchesIntent(
      { username: "SELECTED@example.test" },
      { identifier: "selected@example.test", status: "existing" },
    ),
    false,
  );
});
