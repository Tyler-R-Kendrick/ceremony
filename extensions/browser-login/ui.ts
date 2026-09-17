import {
  admittedOrigin,
  matchTemplate,
  mappingSchema,
  observationSchema,
  validateMapping,
  type Observation,
  type Step,
} from "../../src/browser-login/templates.js";
const status = document.querySelector("#status") as HTMLParagraphElement;
const review = document.querySelector("#review") as HTMLElement;
const mapping = document.querySelector("#mapping") as HTMLPreElement;
let runId: string | undefined;
let page: Observation | undefined;
let step: Step | undefined;
let modelWorker: Worker | undefined;
let epoch = 0;
const infer = document.querySelector("#infer") as HTMLButtonElement;
async function message(payload: unknown): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      chrome.runtime.sendMessage(payload),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Extension did not reply; check the target tab before retrying.",
              ),
            ),
          8000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
  modelWorker?.terminate();
  clearSecrets();
  step = undefined;
  review.hidden = true;
  infer.hidden = true;
  status.textContent = "Checking…";
  try {
    const origin = admittedOrigin(target);
    if (!(await chrome.permissions.request({ origins: [`${origin}/*`] })))
      throw new Error("Site permission was not granted.");
    const tabs = (await chrome.tabs.query({})).filter(
      (candidate) => candidate.url === new URL(target).href,
    );
    const tab = tabs.length === 1 ? tabs[0] : undefined;
    if (tab?.id === undefined)
      throw new Error(
        "Open exactly one tab at this login URL first; duplicate tabs are ambiguous.",
      );
    const result = (await message({
      type: "inspect",
      tabId: tab.id,
      origin,
    })) as { runId?: string; page?: typeof page; error?: string };
    if (result.error) throw new Error(result.error);
    if (current !== epoch) return;
    runId = result.runId;
    page = observationSchema.parse(result.page);
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
    status.textContent =
      error instanceof Error ? error.message : "Inspection failed.";
    review.hidden = true;
  }
});
document.querySelector("#approve")!.addEventListener("click", async () => {
  if (!runId || !page || !step) return;
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
    const pending = message({
      type: "submit",
      runId,
      mapping: step.mapping,
      username,
      password,
    });
    clearSecrets();
    step = undefined;
    review.hidden = true;
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
  epoch++;
  modelWorker?.terminate();
  clearSecrets();
  step = undefined;
  infer.hidden = true;
  if (runId) await message({ type: "cancel", runId });
  runId = undefined;
  page = undefined;
  review.hidden = true;
  status.textContent =
    "Stopped. Cancellation does not undo any submission already sent.";
});
infer.addEventListener("click", () => {
  if (!page || !runId) return;
  const current = epoch;
  infer.disabled = true;
  status.textContent =
    "Loading free local model; first download may take several minutes…";
  const worker = new Worker(chrome.runtime.getURL("inference.worker.js"), {
    type: "module",
  });
  modelWorker = worker;
  const timer = setTimeout(
    () => finish("Local model timed out. No submission occurred."),
    180_000,
  );
  function finish(text: string) {
    clearTimeout(timer);
    worker.terminate();
    infer.disabled = false;
    status.textContent = text;
  }
  worker.onerror = () =>
    finish("Local model unavailable. No submission occurred.");
  worker.onmessage = ({ data }: MessageEvent<{ step?: Step }>) => {
    if (current !== epoch || !page) {
      finish("Mapping discarded after selection changed.");
      return;
    }
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
  modelWorker?.terminate();
  clearSecrets();
});
