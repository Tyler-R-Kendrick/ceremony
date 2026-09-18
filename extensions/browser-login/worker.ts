import { z } from "zod";
import {
  admittedOrigin,
  observationSchema,
  validateMapping,
  mappingSchema,
  matchTemplate,
} from "../../src/browser-login/templates.js";
import { selectInitialStep } from "../../src/browser-login/flows.js";
import {
  classifyHandoff,
  createHandoffWaits,
  handoffEventSchema,
  handoffReplyMessageSchema,
  mintHandoffRef,
  type HandoffPort,
  type HandoffReason,
  type HandoffResolution,
} from "../../src/browser-login/handoffs.js";
import { createPlatform } from "./platform.js";

// Chromium and Gecko disagree about dialect and about document binding, and
// about nothing else this worker does. The seam keeps one copy of every check.
const platform = createPlatform();
/** True where the engine will name and target a document for us. */
const binds = platform.capabilities.documentIdMessaging;
/**
 * Where the engine binds delivery to a document id, use it. Where it does not,
 * address the frame and let the message carry the document's own reference, so
 * a navigated-away document still cannot answer for the one that was observed.
 */
function delivery(documentId: string, frameId?: number) {
  if (binds)
    return frameId === undefined ? { documentId } : { documentId, frameId };
  return { frameId: frameId ?? 0 };
}
function bound(documentId: string, message: Record<string, unknown>) {
  return binds ? message : { ...message, document: documentId };
}

const request = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("inspect"),
    tabId: z.number().int().nonnegative(),
    origin: z.string(),
  }),
  z.strictObject({
    type: z.literal("submit"),
    runId: z.string().uuid(),
    mapping: mappingSchema,
    username: z.string().max(1024),
    password: z.string().max(4096),
  }),
  z.strictObject({
    type: z.literal("multi-inspect"),
    tabId: z.number().int().nonnegative(),
    origin: z.string(),
    frameId: z.number().int().nonnegative(),
    frameOrigin: z.string(),
    popupTabId: z.number().int().nonnegative().optional(),
    popupUrl: z.string().url().optional(),
    profile: z.enum(["manual", "owned-fixture-login"]),
    expectedAccount: z.string().max(256),
  }),
  z.strictObject({
    type: z.literal("multi-observe"),
    runId: z.string().uuid(),
  }),
  z.strictObject({
    type: z.literal("multi-submit"),
    runId: z.string().uuid(),
    approve: z.boolean(),
    username: z.string().max(1024).optional(),
    password: z.string().max(4096).optional(),
  }),
  z.strictObject({ type: z.literal("cancel"), runId: z.string().uuid() }),
]);
type Run = {
  tabId: number;
  origin: string;
  documentId: string;
  page: z.infer<typeof observationSchema>;
  expires: number;
  dispatched: boolean;
};
const active = new Set<string>();
async function open() {
  await platform.tabs.create({ url: platform.runtime.getURL("ui.html") });
}
platform.action.onClicked(() => {
  void open();
});
/**
 * The app bridge is a build-time fact, not a capability to sniff: Chromium
 * admits the page through `externally_connectable`, Gecko ignores that key
 * entirely and the only supported channel is a content script the manifest
 * admits on the app origins. Each path answers only in the mode its own
 * artifact was built for, so a message arriving by the other route is refused
 * rather than quietly accepted.
 */
type BridgeConfig = {
  appOrigins: string[];
  appBridge: "externally-connectable" | "content-relay";
};
async function bridgeConfig(): Promise<BridgeConfig> {
  return (await (
    await fetch(platform.runtime.getURL("config.json"))
  ).json()) as BridgeConfig;
}
const appRequest = z.strictObject({
  type: z.enum(["ceremony.ping", "ceremony.open"]),
  protocol: z.literal(1),
});
/**
 * One admission test for both bridges. The origin is the one the browser
 * attests for the sender, never one the message claims, and it is compared for
 * equality against the exact configured origins — scheme, host and port.
 */
async function answerApp(
  origin: string | undefined,
  message: unknown,
  admitted: string[],
) {
  if (!origin || !admitted.includes(origin))
    return { error: "unapproved-origin" };
  const parsed = appRequest.safeParse(message);
  if (!parsed.success) return { error: "unsupported-request" };
  if (parsed.data.type === "ceremony.open") await open();
  return { protocol: 1, version: platform.runtime.getManifestVersion() };
}
platform.runtime.onMessageExternal((message, sender, reply) => {
  void (async () => {
    const config = await bridgeConfig();
    if (config.appBridge !== "externally-connectable")
      return reply({ error: "unavailable" });
    reply(
      await answerApp(
        sender.url ? new URL(sender.url).origin : undefined,
        message,
        config.appOrigins,
      ),
    );
  })().catch(() => reply({ error: "unavailable" }));
  return true;
});
const handoffPorts = new Set<HandoffPort>();
const handoffWaits = createHandoffWaits();
function admitHandoffPort(port: HandoffPort) {
  handoffPorts.add(port);
  port.onMessage.addListener((raw) => {
    const parsed = handoffReplyMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    // An approved origin earns a channel, not a vote: the registry accepts the
    // answer only from a port this exact attempt was handed to.
    handoffWaits.reply(port, parsed.data);
  });
  port.onDisconnect.addListener(() => {
    handoffPorts.delete(port);
    handoffWaits.dropPort(port);
  });
}
platform.runtime.onConnectExternal((port) => {
  void (async () => {
    const config = await bridgeConfig();
    const origin = port.sender?.url && new URL(port.sender.url).origin;
    if (
      config.appBridge !== "externally-connectable" ||
      !origin ||
      !config.appOrigins.includes(origin) ||
      port.name !== "ceremony.handoffs"
    )
      return port.disconnect();
    admitHandoffPort(port);
  })().catch(() => port.disconnect());
});
// Gecko's relay reaches the worker as an ordinary internal connection. It is
// held to the same two facts as the external port: our own extension is the
// sender, and the page it runs in is one of the exact admitted app origins.
platform.runtime.onConnect((port) => {
  void (async () => {
    const config = await bridgeConfig();
    const origin = port.sender?.url && new URL(port.sender.url).origin;
    if (
      config.appBridge !== "content-relay" ||
      port.sender?.id !== platform.runtime.id ||
      !origin ||
      !config.appOrigins.includes(origin) ||
      port.name !== "ceremony.handoffs"
    )
      return port.disconnect();
    admitHandoffPort(port);
  })().catch(() => port.disconnect());
});
const relayedApp = z.strictObject({
  type: z.literal("ceremony.relay"),
  request: z.unknown(),
});
platform.runtime.onMessage((raw, sender, reply) => {
  const relayed = relayedApp.safeParse(raw);
  if (!relayed.success || sender.id !== platform.runtime.id) return;
  void (async () => {
    const config = await bridgeConfig();
    if (config.appBridge !== "content-relay")
      return reply({ error: "unavailable" });
    reply(
      await answerApp(
        sender.url ? new URL(sender.url).origin : undefined,
        relayed.data.request,
        config.appOrigins,
      ),
    );
  })().catch(() => reply({ error: "unavailable" }));
  return true;
});
platform.runtime.onMessage((raw, sender, reply) => {
  if (
    sender.id !== platform.runtime.id ||
    sender.url !== platform.runtime.getURL("ui.html")
  )
    return;
  void handle(raw)
    .then(reply)
    .catch(() =>
      reply({
        error:
          "Operation refused or uncertain; inspect the tab before continuing.",
      }),
    );
  return true;
});
async function handle(raw: unknown) {
  const input = request.parse(raw);
  if (input.type === "inspect") {
    const origin = admittedOrigin(input.origin);
    const tab = await platform.tabs.get(input.tabId);
    if (
      !tab.url ||
      new URL(tab.url).origin !== origin ||
      !(await platform.permissions.contains({ origins: [`${origin}/*`] }))
    )
      throw new Error("permission");
    const injected = await platform.scripting.executeScript({
      target: { tabId: input.tabId },
      files: ["content.js"],
    });
    const native = injected[0]?.documentId;
    if (binds ? !native : !injected.length) throw new Error("document");
    const page = observationSchema.parse(
      await platform.tabs.sendMessage(
        input.tabId,
        { type: "observe" },
        native ? { documentId: native } : { frameId: 0 },
      ),
    );
    if (page.origin !== origin) throw new Error("origin");
    // Where the engine will not name the document, the document names itself:
    // the reference the isolated world minted for it is the run's binding.
    const documentId = native ?? page.document;
    const runId = crypto.randomUUID();
    const run: Run = {
      tabId: input.tabId,
      origin,
      documentId,
      page,
      expires: Date.now() + 120_000,
      dispatched: false,
    };
    await platform.sessionStorage.set({ [runId]: run });
    return { runId, page, expires: run.expires };
  }
  if (input.type === "cancel") {
    cancelled.add(input.runId);
    handoffWaits.abandonRun(input.runId, "unavailable");
    await platform.sessionStorage.remove(input.runId);
    return { status: "cancelled" };
  }
  if (input.type === "multi-inspect") return inspectMulti(input);
  if (input.type === "multi-observe" || input.type === "multi-submit")
    return advanceMulti(input);
  if (active.has(input.runId)) throw new Error("busy");
  active.add(input.runId);
  try {
    const stored = (await platform.sessionStorage.get(input.runId))[
      input.runId
    ] as Run | undefined;
    if (!stored || stored.dispatched || stored.expires <= Date.now())
      throw new Error("expired");
    const tab = await platform.tabs.get(stored.tabId);
    if (!tab.url || new URL(tab.url).origin !== stored.origin)
      throw new Error("changed");
    const step = validateMapping(stored.page, input.mapping);
    if (!step) throw new Error("mapping");
    // Reserve before dispatch. Interrupted submissions are never replayed.
    await platform.sessionStorage.set({
      [input.runId]: { ...stored, dispatched: true },
    });
    try {
      return await platform.tabs.sendMessage(
        stored.tabId,
        bound(stored.documentId, {
          type: "apply",
          step,
          username: input.username,
          password: input.password,
        }),
        delivery(stored.documentId),
      );
    } catch {
      return { status: "indeterminate" };
    }
  } finally {
    active.delete(input.runId);
  }
}

// Session checkpoints contain no credentials; UI approval is the only authority.
const cancelled = new Set<string>();
type MultiRun = {
  mode: "multi";
  originalTabId: number;
  originalOrigin: string;
  tabId: number;
  topOrigin: string;
  frameId: number;
  origin: string;
  profile: "manual" | "owned-fixture-login";
  expectedAccount: string;
  expires: number;
  approved: boolean;
  submissions: number;
  usedDocuments: string[];
  handoffs: number;
  resume: boolean;
  next: "initial" | "password" | "verification";
  documentId: string;
  page: z.infer<typeof observationSchema>;
  phase: "ready" | "waiting" | "done";
};
type Input = z.infer<typeof request>;
async function checkTarget(run: MultiRun) {
  const original = await platform.tabs.get(run.originalTabId);
  const tab = await platform.tabs.get(run.tabId);
  if (
    !original.url ||
    new URL(original.url).origin !== run.originalOrigin ||
    !tab.url ||
    new URL(tab.url).origin !== run.topOrigin ||
    (run.tabId !== run.originalTabId && tab.openerTabId !== run.originalTabId)
  )
    throw new Error("origin or opener changed");
  for (const origin of new Set([run.topOrigin, run.origin]))
    if (!(await platform.permissions.contains({ origins: [`${origin}/*`] })))
      throw new Error("permission");
}
async function observeMulti(run: MultiRun) {
  await checkTarget(run);
  const injected = await platform.scripting.executeScript({
    target: { tabId: run.tabId, frameIds: [run.frameId] },
    files: ["content.js"],
  });
  const native = injected[0]?.documentId;
  if ((binds && !native) || injected.length !== 1) throw new Error("document");
  const page = observationSchema.parse(
    await platform.tabs.sendMessage(
      run.tabId,
      { type: "observe" },
      native
        ? { documentId: native, frameId: run.frameId }
        : { frameId: run.frameId },
    ),
  );
  if (page.origin !== run.origin) throw new Error("frame origin");
  // Same binding either way: the engine's document id where there is one, and
  // otherwise the reference this very document minted in the isolated world.
  return { documentId: native ?? page.document, page };
}
async function checkpoint(id: string, run: MultiRun) {
  if (cancelled.has(id)) throw new Error("cancelled");
  await platform.sessionStorage.set({ [id]: run });
  if (cancelled.has(id)) {
    await platform.sessionStorage.remove(id);
    throw new Error("cancelled");
  }
}

async function offerRunHandoff(
  id: string,
  run: MultiRun,
  reason: HandoffReason,
) {
  if (run.handoffs >= 2) {
    run.phase = "done";
    await checkpoint(id, run);
    return { status: "handoff" as const, reason, resolution: "unavailable" };
  }
  run.handoffs++;
  // Each ask gets its own identity, so a second attempt is a different thing to
  // answer than the first rather than a reuse of the run's address.
  const handoffRef = mintHandoffRef();
  const event = handoffEventSchema.parse({
    kind: "handoff",
    handoffRef,
    runId: id,
    reason,
    origin: run.origin,
    attempt: run.handoffs,
  });
  await checkpoint(id, run);
  let resolution: HandoffResolution = "unavailable";
  if (handoffPorts.size > 0) {
    try {
      resolution = await new Promise<HandoffResolution>((resolve) => {
        // Scoped to this attempt: an earlier attempt's expiry is not a verdict
        // on a later one.
        const timer = setTimeout(
          () => handoffWaits.settle(handoffRef, "unavailable"),
          Math.max(0, run.expires - Date.now()),
        );
        handoffWaits.open({
          handoffRef,
          runId: id,
          resolvers: handoffPorts,
          finish: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
        });
        for (const port of handoffPorts)
          port.postMessage({ type: "ceremony.handoff", event });
      });
    } catch (error) {
      handoffWaits.settle(handoffRef, "unavailable");
      throw error;
    }
  }
  if (cancelled.has(id)) throw new Error("cancelled");
  if (resolution === "completed") {
    run.resume = true;
    run.phase = "waiting";
    await checkpoint(id, run);
    return { status: "waiting" as const };
  }
  run.phase = "done";
  await checkpoint(id, run);
  return {
    status: "handoff" as const,
    reason,
    resolution: resolution === "declined" ? "declined" : "unavailable",
  };
}
async function inspectMulti(input: Extract<Input, { type: "multi-inspect" }>) {
  const originalOrigin = admittedOrigin(input.origin);
  if (input.origin !== originalOrigin) throw new Error("exact origin required");
  let tabId = input.tabId;
  let topOrigin = originalOrigin;
  if (input.popupTabId !== undefined || input.popupUrl !== undefined) {
    if (input.popupTabId === undefined || !input.popupUrl)
      throw new Error("popup");
    const popup = await platform.tabs.get(input.popupTabId);
    if (
      popup.openerTabId !== input.tabId ||
      popup.url !== input.popupUrl ||
      input.popupTabId === input.tabId
    )
      throw new Error("popup opener");
    tabId = input.popupTabId;
    topOrigin = admittedOrigin(input.popupUrl);
  }
  const origin = admittedOrigin(input.frameOrigin);
  if (
    origin !== input.frameOrigin ||
    (input.frameId === 0 && origin !== topOrigin)
  )
    throw new Error("exact frame origin required");
  const run: MultiRun = {
    mode: "multi",
    originalTabId: input.tabId,
    originalOrigin,
    tabId,
    topOrigin,
    frameId: input.frameId,
    origin,
    profile: input.profile,
    expectedAccount: input.expectedAccount,
    expires: Date.now() + 120_000,
    approved: false,
    submissions: 0,
    usedDocuments: [],
    handoffs: 0,
    resume: false,
    next: "initial",
    documentId: "",
    page: undefined as unknown as MultiRun["page"],
    phase: "ready",
  };
  Object.assign(run, await observeMulti(run));
  const step =
    input.profile === "owned-fixture-login"
      ? selectInitialStep(input.profile, origin, run.page)?.step
      : matchTemplate(run.page);
  if (
    !step?.mapping.identifier ||
    (input.profile === "owned-fixture-login" && !input.expectedAccount)
  )
    throw new Error("initial mapping or expected account");
  const runId = crypto.randomUUID();
  await checkpoint(runId, run);
  return { runId, page: run.page, expires: run.expires };
}

async function advanceMulti(
  input: Extract<Input, { type: "multi-observe" | "multi-submit" }>,
) {
  const id = input.runId;
  if (active.has(id) || cancelled.has(id)) throw new Error("busy or cancelled");
  active.add(id);
  try {
    const run = (await platform.sessionStorage.get(id))[id] as
      MultiRun | undefined;
    if (
      !run ||
      run.mode !== "multi" ||
      run.expires <= Date.now() ||
      run.phase === "done"
    )
      throw new Error("expired");
    if (input.type === "multi-observe") {
      if (!run.approved || run.phase !== "waiting") throw new Error("phase");
      const fresh = await observeMulti(run);
      if (
        !run.resume &&
        (run.usedDocuments.includes(fresh.documentId) ||
          fresh.page.document === run.page.document)
      )
        return { status: "waiting" };
      run.resume = false;
      Object.assign(run, fresh);
      const step = matchTemplate(run.page);
      const classified = classifyHandoff(run.page);
      const verifyNow =
        run.next === "verification" ||
        (run.next === "password" && !step?.mapping.password && !classified);
      if (verifyNow) {
        let verified = false;
        if (
          run.profile === "owned-fixture-login" &&
          new URL(run.origin).hostname === "127.0.0.1"
        ) {
          const result = await platform.tabs.sendMessage(
            run.tabId,
            bound(run.documentId, {
              type: "verify-fixture",
              origin: run.origin,
              expectedAccount: run.expectedAccount,
            }),
            delivery(run.documentId, run.frameId),
          );
          verified = (result as { verified?: boolean })?.verified === true;
        }
        run.phase = "done";
        await checkpoint(id, run);
        return {
          status: verified ? "verified-fixture" : "submitted-unverified",
        };
      }
      if (classified && !step?.mapping.password)
        return offerRunHandoff(id, run, classified);
      if (step?.mapping.password) {
        run.phase = "ready";
        await checkpoint(id, run);
        return { status: "ready", needs: "password" };
      }
      return offerRunHandoff(id, run, classified ?? "unsupported-page");
    }
    if (
      run.phase !== "ready" ||
      run.submissions >= 2 ||
      run.next === "verification" ||
      run.usedDocuments.includes(run.documentId) ||
      (!run.approved && !input.approve)
    )
      throw new Error("approval or budget");
    await checkTarget(run);
    const step = matchTemplate(run.page);
    if (
      !step ||
      (run.next === "initial" && !step.mapping.identifier) ||
      (run.next === "password" && !step.mapping.password)
    )
      throw new Error("mapping");
    if (
      (step.mapping.identifier && !input.username) ||
      (step.mapping.password && !input.password)
    )
      throw new Error("credentials");
    run.approved = true;
    run.submissions++;
    run.usedDocuments.push(run.documentId);
    run.next = step.mapping.password ? "verification" : "password";
    run.phase = "waiting";
    // Reserve before any fill/submit, including an interrupted/uncertain dispatch.
    await checkpoint(id, run);
    if (cancelled.has(id)) throw new Error("cancelled");
    try {
      const result = (await platform.tabs.sendMessage(
        run.tabId,
        bound(run.documentId, {
          type: "apply",
          step,
          ...(step.mapping.identifier ? { username: input.username } : {}),
          ...(step.mapping.password ? { password: input.password } : {}),
        }),
        delivery(run.documentId, run.frameId),
      )) as { status?: string };
      if (result.status === "refused") {
        run.phase = "done";
        await checkpoint(id, run);
        return { status: "refused" };
      }
    } catch {
      // Navigation can close the reply channel. Observe only; never replay.
    }
    return { status: "waiting" };
  } finally {
    active.delete(id);
  }
}
