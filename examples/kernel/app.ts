/**
 * The page: whatever interface the ceremony is waiting on, drawn by the UI
 * SDK primitive and placed by the layout program whose rules were proved. The
 * page knows nothing about GitHub and holds no secret; it shows a request and
 * sends back which action was chosen.
 */
import { createParts, wrappedButton, wrappedChild } from "@ui-sdk/web";
import type { InterfaceRequest } from "../../src/kernel/run.js";
import { measure, sheetLayout } from "../../src/kernel/interface/sheet.js";
import { ceremonyStep, type StepAnswer } from "./step.js";

createParts(ceremonyStep, {
  root: { tag: "ceremony-step", api: ["answer", "setField", "isAnswered"] },
  field: { tag: "ceremony-step-field", target: wrappedChild("input") },
  action: { tag: "ceremony-step-action", target: wrappedButton },
});

type Status =
  | { readonly status: "awaiting"; readonly request: InterfaceRequest }
  | { readonly status: "success"; readonly leftBehind: readonly string[] }
  | {
      readonly status: "failed";
      readonly ending: string;
      readonly leftBehind: readonly string[];
    };

const stage = document.querySelector<HTMLElement>("#stage") as HTMLElement;
let scale = 1;
let current: Status | null = null;

async function post(path: string, body: unknown): Promise<Status> {
  document.body.dataset.phase = "working";
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Status;
}

function place(
  el: HTMLElement,
  name: string,
  box: { x: number; y: number; width: number; height: number },
): void {
  el.dataset.box = name;
  el.dataset.model = [box.x, box.y, box.width, box.height].join(",");
  Object.assign(el.style, {
    position: "absolute",
    left: `${box.x}px`,
    top: `${box.y}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
  });
}

function draw(): void {
  const status = current;
  if (status === null) return;
  stage.replaceChildren();
  stage.style.setProperty("--scale", String(scale));
  if (status.status !== "awaiting") {
    document.body.dataset.phase = "ended";
    document.body.dataset.ending =
      status.status === "success" ? "success" : status.ending;
    document.body.dataset.operator = "";
    const ended = document.createElement("p");
    ended.id = "ending";
    ended.textContent =
      status.status === "success" ? "Connected." : `Stopped: ${status.ending}.`;
    stage.style.height = "auto";
    stage.append(ended);
    if (status.leftBehind.length > 0) {
      const note = document.createElement("p");
      note.id = "left-behind";
      note.textContent = `May have left something behind: ${status.leftBehind.join(", ")}.`;
      stage.append(note);
    }
    return;
  }

  const { request } = status;
  const spec = request.interface;
  const layout = sheetLayout(spec);
  const drawn = measure(layout, { width: stage.clientWidth, scale });
  document.body.dataset.phase = "awaiting";
  document.body.dataset.operator = request.operator;
  document.body.dataset.ending = "";
  stage.style.height = `${drawn.height}px`;

  const root = document.createElement("ceremony-step");
  root.dataset.request = request.requestId;
  root.addEventListener("answer", (event) => {
    const answer = (event as CustomEvent<{ value: StepAnswer }>).detail.value;
    void post("/api/advance", {
      requestId: request.requestId,
      action: answer.action,
      fields: answer.fields,
    }).then(show);
  });

  const title = document.createElement("h1");
  title.textContent = spec.title;
  place(title, "title", drawn.boxes.title as never);
  root.append(title);
  if (spec.body.length > 0) {
    const body = document.createElement("p");
    body.textContent = spec.body;
    place(body, "body", drawn.boxes.body as never);
    root.append(body);
  }
  for (const field of spec.fields ?? []) {
    const part = document.createElement("ceremony-step-field");
    part.setAttribute("name", field.name);
    const label = document.createElement("label");
    label.textContent = field.label;
    const input = document.createElement("input");
    input.type = field.kind === "secret" ? "password" : "text";
    input.autocomplete = "off";
    input.setAttribute("aria-label", field.label);
    label.append(input);
    part.append(label);
    place(
      part,
      `field:${field.name}`,
      drawn.boxes[`field:${field.name}`] as never,
    );
    root.append(part);
  }
  for (const action of spec.actions) {
    const part = document.createElement("ceremony-step-action");
    part.setAttribute("value", action.id);
    const button = document.createElement("button");
    button.textContent = action.label;
    button.dataset.emphasis = action.emphasis;
    part.append(button);
    place(
      part,
      `action:${action.id}`,
      drawn.boxes[`action:${action.id}`] as never,
    );
    root.append(part);
  }
  stage.append(root);
}

function show(status: Status): void {
  current = status;
  draw();
}

new ResizeObserver(() => draw()).observe(stage);

for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-world]",
)) {
  button.addEventListener("click", () => {
    void post("/api/world", { event: button.dataset.world }).then(show);
  });
}
document.querySelector("#scale")?.addEventListener("click", () => {
  scale = scale === 1 ? 1.5 : scale === 1.5 ? 2 : 1;
  document.body.dataset.scale = String(scale);
  draw();
});

void post("/api/advance", {}).then(show);
