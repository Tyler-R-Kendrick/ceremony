import { z } from "zod";
import {
  admittedOrigin,
  observationSchema,
  validateMapping,
  mappingSchema,
} from "../../src/browser-login/templates.js";

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
    return { runId, page };
  }
  if (active.has(input.runId)) throw new Error("busy");
  if (input.type === "cancel") {
    await chrome.storage.session.remove(input.runId);
    return { status: "cancelled" };
  }
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
