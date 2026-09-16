import { randomBytes } from "node:crypto";
import { chromium } from "playwright-core";
import { test, expect } from "../fixtures/browser-test.js";
import { oidcIdpFixture } from "../fixtures/oidc-idp.js";
import { mountTeachingHost } from "../fixtures/teaching-hosted.js";
import { SQLiteCeremonyStore } from "../../src/server/persistence/index.js";
import {
  createTeachingRuntime,
  type TeachingRuntime,
} from "../../src/server/teaching-runtime.js";
import { OperationRegistry } from "../../src/server/recipes/registry.js";
import {
  authoredVocabulary,
  registerAuthoredOperations,
  saveAuthoredAccount,
  saveAuthoredAccountIntent,
  readAccountBrowser,
  authoredOauthKey,
} from "../../src/server/authored-operations.js";
import { authoredHuman } from "../../src/server/authored-human.js";
import { createAuthorizationBrowser } from "../../src/server/browser-executor.js";
import type { ActorContext } from "../../src/core/operation-contracts.js";
import type { RunRecord } from "../../src/server/commands.js";

test("human code entry resumes real isolated OAuth through the authenticated HTTP boundary", async ({
  page,
  context,
}) => {
  const provider = await oidcIdpFixture({ seed: 82, mfa: true });
  const engine = await chromium.launch();
  const isolated = createAuthorizationBrowser({
    open: async () => ({ browser: engine, close: async () => {} }),
  });
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  let runtime: TeachingRuntime;
  const host = await mountTeachingHost(() => runtime);
  const actor: ActorContext = {
    tenantId: "tenant",
    subjectId: "owner",
    sessionId: "fixture-session",
    actorKind: "human",
    capabilities: ["executor"],
  };
  const account = {
    username: "chosen-account",
    password: "fixture-password",
    email: "fixture@example.test",
  };
  provider.accounts.set(account.email, {
    email: account.email,
    handle: account.username,
    password: account.password,
    verified: true,
  });
  // SDK HTTPS endpoints are mapped to the real local HTTP provider, as in the
  // other service fixtures. No external provider or TLS policy is changed.
  const fetcher: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.origin === "https://isolated-token.fixture")
      return fetch(`${provider.origin}${url.pathname}${url.search}`, init);
    if (url.origin === provider.origin) return fetch(input, init);
    throw new Error("Unexpected fixture origin");
  };
  const registry = new OperationRegistry(authoredVocabulary);
  registerAuthoredOperations(registry, {
    store,
    browser: isolated,
    fetch: fetcher,
  });
  const runContext = {
    provider: "novel",
    profile: "authored",
    target: "novel",
    origin: host.origin,
    environment: "test",
    configurationVersion: "v1",
  };
  const advance = async (runId: string, nodeId: string) => {
    const snapshot = await runtime.commands.snapshot(actor, runId);
    await runtime.commands.advance(
      actor,
      runId,
      nodeId,
      snapshot.revision,
      `advance:${snapshot.revision}`,
    );
  };
  runtime = createTeachingRuntime({
    store,
    registry,
    origin: host.origin,
    identity: {
      authenticate: async (request) =>
        request.headers.get("cookie")?.includes("oauth-fixture=owner")
          ? actor
          : null,
    },
    context: async () => runContext,
    authorize: async () => true,
    human: async (currentActor, runId, request) => {
      const record = await store.transaction((tx) =>
        tx.get<RunRecord>({
          tenant: currentActor.tenantId,
          kind: "run",
          id: runId,
        }),
      );
      if (!record) throw new Error("Missing fixture run");
      return authoredHuman(
        store,
        {
          ...runContext,
          actor: currentActor,
          runId,
          nodeId: "auth",
          commandId: "human",
          effectId: "human",
          signal: new AbortController().signal,
        },
        record,
        request,
        `${host.origin}/api/v1/teaching/novel/${runId}/human`,
        () => advance(runId, "auth"),
        {
          connectorId: "novel",
          name: "Novel",
          browser: isolated,
          fetch: fetcher,
        },
      );
    },
  });
  try {
    await store.transaction((tx) =>
      tx.put(
        {
          tenant: actor.tenantId,
          kind: "artifact",
          id: "installed-connector:novel",
        },
        {
          author: actor.subjectId,
          session: actor.sessionId,
          manifest: { name: "Novel", methods: [] },
          definition: {},
          discovery: {
            origin: provider.origin,
            issuer: provider.origin,
            registrationEndpoint: `${provider.origin}/dcr`,
            authorizationEndpoint: `${provider.origin}/authorize`,
            tokenEndpoint: "https://isolated-token.fixture/token",
            userinfoEndpoint: "https://isolated-token.fixture/userinfo",
            documents: [],
            methods: ["oauth-code"],
            grantTypes: [],
            searchUsed: false,
          },
        },
        null,
      ),
    );
    const run = await runtime.commands.createRun(
      actor,
      runContext,
      [
        {
          id: "app",
          operationId: "authored.prepare-app",
          operationVersion: "1.0.0",
          dependsOn: [],
          bindings: {},
        },
        {
          id: "auth",
          operationId: "authored.authorize-user",
          operationVersion: "1.0.0",
          dependsOn: ["app"],
          bindings: { app: { from: "output", node: "app", name: "app" } },
        },
      ],
      {},
    );
    await saveAuthoredAccount(store, actor, "novel", account);
    await saveAuthoredAccountIntent(store, actor, run.id, {
      identifier: account.username,
      status: "existing",
    });
    await advance(run.id, "app");
    await advance(run.id, "auth");
    expect((await readAccountBrowser(store, actor, run.id))?.pending).toBe(
      true,
    );
    expect(provider.counts).toEqual({
      authorization: 1,
      signin: 1,
      mfa: 0,
      token: 0,
    });
    const url = `${host.origin}/api/v1/teaching/novel/${run.id}/human`;
    expect((await page.request.get(url)).status()).toBe(401);
    await context.addCookies([
      {
        name: "oauth-fixture",
        value: "owner",
        url: host.origin,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url);
    await expect(
      page.getByRole("heading", { name: "Continue Novel" }),
    ).toBeVisible();
    await expect(page.locator('input[type="image"]')).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const viewport = page.getByRole("region", {
      name: "Provider browser viewport",
    });
    await viewport.evaluate((element) => {
      element.scrollLeft = 400;
    });
    expect(await viewport.evaluate((element) => element.scrollLeft)).toBe(400);
    const imageInput = page.locator('input[type="image"]');
    expect(
      await imageInput.evaluate(
        (element) => element.getBoundingClientRect().width,
      ),
    ).toBe(1280);
    const clicked = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url() === url,
    );
    const providerClick = engine
      .contexts()[0]!
      .pages()[0]!
      .evaluate(
        () =>
          new Promise<{ x: number; y: number }>((resolve) => {
            document.addEventListener(
              "click",
              (event) => resolve({ x: event.clientX, y: event.clientY }),
              { once: true },
            );
          }),
      );
    await imageInput.click({ position: { x: 500, y: 300 } });
    const clickResponse = await clicked;
    expect(clickResponse.status()).toBe(303);
    const coordinates = new URLSearchParams(
      clickResponse.request().postData()!,
    );
    // Native image-submit rounding differs by engine. The provider must receive
    // exactly the coordinates submitted by that engine, without scaling or offsets.
    expect(await providerClick).toEqual({
      x: Number(coordinates.get("x")),
      y: Number(coordinates.get("y")),
    });
    await page.getByLabel("Verification code", { exact: true }).fill("123456");
    const submitted = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url() === url,
    );
    await page
      .getByRole("button", { name: "Submit code and continue" })
      .click();
    const response = await submitted;
    expect(response.status()).toBe(303);
    await expect(
      page.getByRole("heading", { name: "Connected as chosen-account" }),
    ).toBeVisible();
    expect(provider.counts).toEqual({
      authorization: 1,
      signin: 1,
      mfa: 1,
      token: 1,
    });
    expect(
      await store.transaction((tx) => tx.get(authoredOauthKey(actor, run.id))),
    ).toBeUndefined();
    expect((await readAccountBrowser(store, actor, run.id))?.pending).toBe(
      false,
    );
    await page.reload();
    expect(provider.counts.token).toBe(1);
  } finally {
    await host.close();
    await engine.close();
    await store.close();
    await provider.close();
  }
});
