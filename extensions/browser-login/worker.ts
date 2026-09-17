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
  offerHandoff,
  type HandoffPort,
  type HandoffReason,
  type HandoffResolution,
} from "../../src/browser-login/handoffs.js";

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
  await chrome.tabs.create({ url: chrome.runtime.getURL("ui.html") });
}
chrome.action.onClicked.addListener(() => {
  void open();
});
chrome.runtime.onMessageExternal.addListener((message, sender, reply) => {
  void (async () => {
    const config = (await (
      await fetch(chrome.runtime.getURL("config.json"))
    ).json()) as { appOrigins: string[] };
    if (!sender.url || !config.appOrigins.includes(new URL(sender.url).origin))
      return reply({ error: "unapproved-origin" });
    const parsed = z
      .strictObject({
        type: z.enum(["ceremony.ping", "ceremony.open"]),
        protocol: z.literal(1),
      })
      .safeParse(message);
    if (!parsed.success) return reply({ error: "unsupported-request" });
    if (parsed.data.type === "ceremony.open") await open();
    reply({ protocol: 1, version: chrome.runtime.getManifest().version });
  })().catch(() => reply({ error: "unavailable" }));
  return true;
});
const handoffPorts = new Set<HandoffPort>();
const handoffResolvers = new Map<string, (value: HandoffResolution) => void>();
chrome.runtime.onConnectExternal.addListener((port) => {
  void (async () => {
    const config = (await (
      await fetch(chrome.runtime.getURL("config.json"))
    ).json()) as { appOrigins: string[] };
    const origin = port.sender?.url && new URL(port.sender.url).origin;
    if (
      !origin ||
      !config.appOrigins.includes(origin) ||
      port.name !== "ceremony.handoffs"
    )
      return port.disconnect();
    handoffPorts.add(port);
    port.onMessage.addListener((raw) => {
      const parsed = z
        .strictObject({
          type: z.literal("ceremony.resolve-handoff"),
          runId: z.string().uuid(),
          resolution: z.enum(["completed", "declined", "unavailable"]),
        })
        .safeParse(raw);
      if (!parsed.success) return;
      handoffResolvers.get(parsed.data.runId)?.(parsed.data.resolution);
    });
    port.onDisconnect.addListener(() => {
      handoffPorts.delete(port);
    });
  })().catch(() => port.disconnect());
});
chrome.runtime.onMessage.addListener((raw, sender, reply) => {
  if (
    sender.id !== chrome.runtime.id ||
    sender.url !== chrome.runtime.getURL("ui.html")
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
    const tab = await chrome.tabs.get(input.tabId);
    if (
      !tab.url ||
      new URL(tab.url).origin !== origin ||
      !(await chrome.permissions.contains({ origins: [`${origin}/*`] }))
    )
      throw new Error("permission");
    const injected = await chrome.scripting.executeScript({
      target: { tabId: input.tabId },
      files: ["content.js"],
    });
    const documentId = injected[0]?.documentId;
    if (!documentId) throw new Error("document");
    const page = observationSchema.parse(
      await chrome.tabs.sendMessage(
        input.tabId,
        { type: "observe" },
        { documentId },
      ),
    );
    if (page.origin !== origin) throw new Error("origin");
    const runId = crypto.randomUUID();
    const run: Run = {
      tabId: input.tabId,
      origin,
      documentId,
      page,
      expires: Date.now() + 120_000,
      dispatched: false,
    };
    await chrome.storage.session.set({ [runId]: run });
    return { runId, page, expires: run.expires };
  }
  if (input.type === "cancel") {
    cancelled.add(input.runId);
    await chrome.storage.session.remove(input.runId);
    return { status: "cancelled" };
  }
  if (input.type === "multi-inspect") return inspectMulti(input);
  if (input.type === "multi-observe" || input.type === "multi-submit")
    return advanceMulti(input);
  if (active.has(input.runId)) throw new Error("busy");
  active.add(input.runId);
  try {
    const stored = (await chrome.storage.session.get(input.runId))[
      input.runId
    ] as Run | undefined;
    if (!stored || stored.dispatched || stored.expires <= Date.now())
      throw new Error("expired");
    const tab = await chrome.tabs.get(stored.tabId);
    if (!tab.url || new URL(tab.url).origin !== stored.origin)
      throw new Error("changed");
    const step = validateMapping(stored.page, input.mapping);
    if (!step) throw new Error("mapping");
    // Reserve before dispatch. Interrupted submissions are never replayed.
    await chrome.storage.session.set({
      [input.runId]: { ...stored, dispatched: true },
    });
    try {
      return await chrome.tabs.sendMessage(
        stored.tabId,
        {
          type: "apply",
          step,
          username: input.username,
          password: input.password,
        },
        { documentId: stored.documentId },
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
  const original = await chrome.tabs.get(run.originalTabId);
  const tab = await chrome.tabs.get(run.tabId);
  if (
    !original.url ||
    new URL(original.url).origin !== run.originalOrigin ||
    !tab.url ||
    new URL(tab.url).origin !== run.topOrigin ||
    (run.tabId !== run.originalTabId && tab.openerTabId !== run.originalTabId)
  )
    throw new Error("origin or opener changed");
  for (const origin of new Set([run.topOrigin, run.origin]))
    if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] })))
      throw new Error("permission");
}
async function observeMulti(run: MultiRun) {
  await checkTarget(run);
  const injected = await chrome.scripting.executeScript({
    target: { tabId: run.tabId, frameIds: [run.frameId] },
    files: ["content.js"],
  });
  const documentId = injected[0]?.documentId;
  if (!documentId || injected.length !== 1) throw new Error("document");
  const page = observationSchema.parse(
    await chrome.tabs.sendMessage(
      run.tabId,
      { type: "observe" },
      { documentId, frameId: run.frameId },
    ),
  );
  if (page.origin !== run.origin) throw new Error("frame origin");
  return { documentId, page };
}
async function checkpoint(id: string, run: MultiRun) {
  if (cancelled.has(id)) throw new Error("cancelled");
  await chrome.storage.session.set({ [id]: run });
  if (cancelled.has(id)) {
    await chrome.storage.session.remove(id);
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
  const event = {
    kind: "handoff" as const,
    runId: id,
    reason,
    origin: run.origin,
    attempt: run.handoffs,
  };
  await checkpoint(id, run);
  const resolution = await offerHandoff(event, {
    onHandoff(published) {
      for (const port of handoffPorts)
        port.postMessage({ type: "ceremony.handoff", event: published });
    },
    resolveHandoff: handoffPorts.size
      ? (published) =>
          new Promise((resolve) => {
            const finish = (value: HandoffResolution) => {
              clearTimeout(timer);
              if (handoffResolvers.get(published.runId) === finish)
                handoffResolvers.delete(published.runId);
              resolve(value);
            };
            const timer = setTimeout(
              () => finish("unavailable"),
              Math.max(0, run.expires - Date.now()),
            );
            handoffResolvers.set(published.runId, finish);
          })
      : undefined,
  });
  if (cancelled.has(id)) throw new Error("cancelled");
  if (resolution === "completed") {
    run.resume = true;
    if (run.next === "password") run.next = "verification";
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
    const popup = await chrome.tabs.get(input.popupTabId);
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
    const run = (await chrome.storage.session.get(id))[id] as
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
      const classified = classifyHandoff(run.page);
      if (classified) return offerRunHandoff(id, run, classified);
      if (run.next === "verification") {
        let verified = false;
        if (
          run.profile === "owned-fixture-login" &&
          new URL(run.origin).hostname === "127.0.0.1"
        ) {
          const result = await chrome.tabs.sendMessage(
            run.tabId,
            {
              type: "verify-fixture",
              origin: run.origin,
              expectedAccount: run.expectedAccount,
            },
            { documentId: run.documentId, frameId: run.frameId },
          );
          verified = (result as { verified?: boolean })?.verified === true;
        }
        run.phase = "done";
        await checkpoint(id, run);
        return {
          status: verified ? "verified-fixture" : "submitted-unverified",
        };
      }
      const step = matchTemplate(run.page);
      if (!step?.mapping.password || step.mapping.identifier)
        return offerRunHandoff(
          id,
          run,
          classifyHandoff(run.page) ?? "unsupported-page",
        );
      run.phase = "ready";
      await checkpoint(id, run);
      return { status: "ready", needs: "password" };
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
      (run.next === "password" &&
        (!step.mapping.password || step.mapping.identifier))
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
      const result = (await chrome.tabs.sendMessage(
        run.tabId,
        {
          type: "apply",
          step,
          ...(step.mapping.identifier ? { username: input.username } : {}),
          ...(step.mapping.password ? { password: input.password } : {}),
        },
        { documentId: run.documentId, frameId: run.frameId },
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
