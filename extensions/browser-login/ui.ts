import { createPlatform } from "./platform.js";
import {
  admittedOrigin,
  matchTemplate,
  mappingSchema,
  observationSchema,
  validateMapping,
  type Observation,
  type Step,
} from "../../src/browser-login/templates.js";

// The trusted page talks to its own worker through the same seam the worker
// uses, so one dialect difference cannot make the UI and the worker disagree.
const platform = createPlatform();
const status = document.querySelector("#status") as HTMLParagraphElement;
const review = document.querySelector("#review") as HTMLElement;
const mapping = document.querySelector("#mapping") as HTMLPreElement;
let runId: string | undefined;
let page: Observation | undefined;
let step: Step | undefined;
let modelWorker: Worker | undefined;
let modelTimer: ReturnType<typeof setTimeout> | undefined;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let expires = 0;
let epoch = 0;
let multi = false;
let credentials: { username: string; password: string } | undefined;
const value = (id: string) =>
  (document.querySelector(`#${id}`) as HTMLInputElement | null)?.value.trim() ??
  "";
const infer = document.querySelector("#infer") as HTMLButtonElement;
async function message(payload: unknown, timeout = 8000): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      platform.runtime.sendMessage(payload),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Extension did not reply; check the target tab before retrying.",
              ),
            ),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function stopModel() {
  clearTimeout(modelTimer);
  modelTimer = undefined;
  modelWorker?.terminate();
  modelWorker = undefined;
  infer.disabled = false;
}
function resetRun() {
  credentials = undefined;
  multi = false;
  (document.querySelector("#inspect") as HTMLButtonElement).disabled = false;
  stopModel();
  clearTimeout(expiryTimer);
  expiryTimer = undefined;
  expires = 0;
  runId = undefined;
  page = undefined;
  step = undefined;
  clearSecrets();
  review.hidden = true;
  mapping.textContent = "";
  infer.hidden = true;
}
function requireFreshObservation() {
  if (!page || !runId) return false;
  if (expires > Date.now()) return true;
  epoch++;
  resetRun();
  status.textContent =
    "Inspection expired. Inspect again before proposing or approving a mapping.";
  return false;
}
function showMapping() {
  review.hidden = !step;
  if (step && page)
    mapping.textContent = JSON.stringify(
      {
        destination: step.recipient,
        fields: Object.entries(step.mapping).map(([role, ref]) => ({
          role,
          label: page!.controls.find((control) => control.ref === ref)?.label,
        })),
      },
      null,
      2,
    );
}
function clearSecrets() {
  (document.querySelector("#username") as HTMLInputElement).value = "";
  (document.querySelector("#password") as HTMLInputElement).value = "";
}
document.querySelector("#inspect")!.addEventListener("click", async () => {
  const target = (
    document.querySelector("#target") as HTMLInputElement
  ).value.trim();
  const current = ++epoch;
  const oldRun = runId;
  resetRun();
  if (oldRun) void message({ type: "cancel", runId: oldRun }).catch(() => {});
  multi = !!(document.querySelector("#multistep") as HTMLInputElement | null)
    ?.checked;
  status.textContent = "Checking…";
  try {
    const origin = admittedOrigin(target);
    const frameId = Number(value("frame-id") || "0");
    const popupUrl = value("popup-url");
    if (!multi && (frameId !== 0 || popupUrl || value("frame-origin")))
      throw new Error("Opt in to multi-step mode for frame or popup driving.");
    const topOrigin = popupUrl ? admittedOrigin(popupUrl) : origin;
    const frameOrigin =
      value("frame-origin") || (frameId === 0 ? topOrigin : "");
    if (
      multi &&
      (!Number.isSafeInteger(frameId) ||
        frameId < 0 ||
        !frameOrigin ||
        admittedOrigin(frameOrigin) !== frameOrigin)
    )
      throw new Error("Enter a frame ID and exact approved frame origin.");
    const origins = [
      ...new Set([origin, ...(multi ? [topOrigin, frameOrigin] : [])]),
    ];
    if (
      !(await platform.permissions.request({
        origins: origins.map((item) => `${item}/*`),
      }))
    )
      throw new Error("Site permission was not granted.");
    const tabs = (await platform.tabs.query({})).filter(
      (candidate) => candidate.url === new URL(target).href,
    );
    const tab = tabs.length === 1 ? tabs[0] : undefined;
    if (tab?.id === undefined)
      throw new Error(
        "Open exactly one tab at this login URL first; duplicate tabs are ambiguous.",
      );
    const popups = popupUrl
      ? (await platform.tabs.query({})).filter(
          (candidate) => candidate.url === new URL(popupUrl).href,
        )
      : [];
    if (popupUrl && (popups.length !== 1 || popups[0]?.id === undefined))
      throw new Error("Open exactly one popup at the selected URL.");
    if (current !== epoch) return;
    const result = (await message(
      multi
        ? {
            type: "multi-inspect",
            tabId: tab.id,
            origin,
            frameId,
            frameOrigin,
            ...(popupUrl
              ? { popupTabId: popups[0]!.id, popupUrl: new URL(popupUrl).href }
              : {}),
            profile: value("profile"),
            expectedAccount: value("expected-account"),
          }
        : {
            type: "inspect",
            tabId: tab.id,
            origin,
          },
    )) as {
      runId?: string;
      page?: typeof page;
      expires?: number;
      error?: string;
    };
    if (current !== epoch) return;
    if (result.error) throw new Error(result.error);
    runId = result.runId;
    page = observationSchema.parse(result.page);
    expires =
      typeof result.expires === "number" && Number.isFinite(result.expires)
        ? result.expires
        : 0;
    if (!requireFreshObservation()) return;
    expiryTimer = setTimeout(() => {
      if (current === epoch) requireFreshObservation();
    }, expires - Date.now());
    if (page.challenge)
      throw new Error(
        "A human challenge is present. Complete it yourself; this run stops.",
      );
    step = matchTemplate(page);
    showMapping();
    status.textContent = step
      ? "Review the mapping, then approve one submission."
      : "No unambiguous template match. Optional local AI can propose a mapping for your review.";
    infer.hidden = !!step;
  } catch (error) {
    if (current !== epoch) return;
    resetRun();
    status.textContent =
      error instanceof Error ? error.message : "Inspection failed.";
  }
});
document.querySelector("#approve")!.addEventListener("click", async () => {
  if (!requireFreshObservation() || !runId || !page || !step) return;
  try {
    const username = (document.querySelector("#username") as HTMLInputElement)
      .value;
    const password = (document.querySelector("#password") as HTMLInputElement)
      .value;
    if (
      (step.mapping.identifier && !username) ||
      (step.mapping.password && !password)
    )
      throw new Error("Enter the credentials required by the mapping.");
    if (multi) {
      if (!password)
        throw new Error("Enter the password for the approved login sequence.");
      const current = epoch;
      const approvedRun = runId;
      credentials = { username, password };
      clearSecrets();
      step = undefined;
      review.hidden = true;
      infer.hidden = true;
      (document.querySelector("#inspect") as HTMLButtonElement).disabled = true;
      status.textContent = "Running approved login sequence…";
      const remaining = () => Math.max(1000, expires - Date.now());
      try {
        let result = (await message(
          {
            type: "multi-submit",
            runId: approvedRun,
            approve: true,
            ...(page.controls.some((c) => c.kind === "password")
              ? { password }
              : {}),
            username,
          },
          remaining(),
        )) as { status?: string; error?: string; reason?: string };
        while (current === epoch && credentials && Date.now() < expires) {
          if (result.error) throw new Error(result.error);
          if (result.status === "waiting") {
            await new Promise((resolve) => setTimeout(resolve, 250));
            if (current !== epoch || !credentials) return;
            result = (await message(
              { type: "multi-observe", runId: approvedRun },
              remaining(),
            )) as typeof result;
            continue;
          }
          if (result.status === "ready") {
            if (current !== epoch || !credentials) return;
            result = (await message(
              {
                type: "multi-submit",
                runId: approvedRun,
                approve: false,
                username: credentials.username,
                password: credentials.password,
              },
              remaining(),
            )) as typeof result;
            continue;
          }
          const text =
            result.status === "verified-fixture"
              ? "Verified fixture account."
              : result.status === "submitted-unverified"
                ? "Submitted. Verify the account yourself; authentication is unverified."
                : result.status === "handoff"
                  ? result.reason === "passkey-required"
                    ? "Passkey required. The owning app can resolve this handoff; automation stopped."
                    : result.reason === "human-challenge"
                      ? "Human challenge required. Automation stopped."
                      : result.reason === "native-dialog"
                        ? "A browser dialog requires you. Automation stopped."
                        : "Human participation required. Automation stopped."
                  : "Submission refused. Check the target page.";
          resetRun();
          status.textContent = text;
          return;
        }
        if (current === epoch) {
          resetRun();
          status.textContent =
            "Run timed out. Check the page; no submission will be replayed.";
          await message({ type: "cancel", runId: approvedRun });
        }
      } catch (error) {
        if (current !== epoch) return;
        resetRun();
        status.textContent = `Run refused or uncertain: ${error instanceof Error ? error.message : "check the page"}`;
        await message({ type: "cancel", runId: approvedRun }).catch(() => {});
      }
      return;
    }
    const pending = message({
      type: "submit",
      runId,
      mapping: step.mapping,
      username,
      password,
    });
    clearSecrets();
    clearTimeout(expiryTimer);
    expiryTimer = undefined;
    step = undefined;
    review.hidden = true;
    infer.hidden = true;
    const result = (await pending) as { status?: string; error?: string };
    if (result.error) throw new Error(result.error);
    status.textContent =
      result.status === "submitted-unverified"
        ? "Submitted. Verify the page yourself; this tool did not verify the account."
        : result.status === "indeterminate"
          ? "Submission state uncertain; check the page. Do not resubmit without checking."
          : "Submission refused. The page changed or did not match. Nothing was submitted.";
    review.hidden = true;
  } catch (error) {
    status.textContent =
      error instanceof Error ? error.message : "Submission failed.";
  }
});
document.querySelector("#cancel")!.addEventListener("click", async () => {
  const current = ++epoch;
  const cancelledRun = runId;
  resetRun();
  status.textContent =
    "Stopped. Cancellation does not undo any submission already sent.";
  try {
    if (cancelledRun) await message({ type: "cancel", runId: cancelledRun });
  } catch {
    if (current === epoch)
      status.textContent =
        "Stopped locally. Cancellation could not be confirmed; check the target tab before inspecting again.";
  }
});
infer.addEventListener("click", () => {
  if (!requireFreshObservation() || !page || !runId || modelWorker) return;
  const current = epoch;
  infer.disabled = true;
  status.textContent =
    "Loading free local model; first download may take several minutes…";
  const worker = new Worker(platform.runtime.getURL("inference.worker.js"), {
    type: "module",
  });
  modelWorker = worker;
  modelTimer = setTimeout(
    () => finish("Local model timed out. No submission occurred."),
    180_000,
  );
  function isCurrent() {
    return current === epoch && modelWorker === worker;
  }
  function finish(text: string) {
    if (!isCurrent() || !requireFreshObservation()) return;
    stopModel();
    status.textContent = text;
  }
  worker.onerror = () => {
    if (isCurrent()) finish("Local model unavailable. No submission occurred.");
  };
  worker.onmessage = ({ data }: MessageEvent<{ step?: Step }>) => {
    if (!isCurrent() || !requireFreshObservation() || !page) return;
    const parsed = mappingSchema.safeParse(data.step?.mapping);
    step = parsed.success ? validateMapping(page, parsed.data) : undefined;
    finish(
      step
        ? "Review the proposed mapping before approving."
        : "No valid mapping found. Complete login yourself.",
    );
    showMapping();
  };
  worker.postMessage(page);
});
addEventListener("pagehide", () => {
  epoch++;
  resetRun();
});
