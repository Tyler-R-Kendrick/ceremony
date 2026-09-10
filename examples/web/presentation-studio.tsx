import { useState } from "react";
import {
  actionsFor,
  defaultTemplate,
  fieldsFor,
  steps,
  flowKinds,
  type CeremonySnapshot,
  type CeremonyTemplate,
  type ConnectorManifest,
  type FlowKind,
  type Step,
} from "../../src/core/index.js";
import {
  authoringPrompt,
  BoundCeremony,
  validateTemplate,
} from "../../src/react/index.js";
function download(name: string, value: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
function preview(
  manifest: ConnectorManifest,
  kind: FlowKind,
  step: Step,
): CeremonySnapshot {
  const method = manifest.methods.find((value) => value.kind === kind);
  if (!method) throw new Error("No preview method");
  return {
    id: "preview",
    revision: 0,
    connectorId: manifest.id,
    connectorName: manifest.name,
    description: manifest.description,
    method,
    step,
    fields: fieldsFor(step, method),
    actions: actionsFor(step, kind === "authmd-anonymous"),
    expiresAt: 2_000_000_000_000,
    authorizationUrl: "#preview-only",
    verificationUri: "#preview-only",
    userCode: "482913",
    ...(["anonymous", "complete"].includes(step)
      ? {
          outcome: {
            connectionRef: "preview-only",
            ownership:
              step === "anonymous"
                ? ("anonymous" as const)
                : kind === "authmd-anonymous"
                  ? ("claimed" as const)
                  : ("authenticated" as const),
            scopes: method.scopes,
          },
        }
      : {}),
    ...(["error", "expired"].includes(step)
      ? { message: "Example: the provider did not approve this attempt." }
      : {}),
  };
}
export function PresentationStudio({
  manifest,
  generationAvailable,
  apply,
  templates,
}: {
  manifest: ConnectorManifest;
  generationAvailable: boolean;
  apply(template: CeremonyTemplate): void;
  templates: CeremonyTemplate[];
}) {
  const [kind, setKind] = useState<FlowKind>(manifest.methods[0]!.kind);
  const [source, setSource] = useState(
    JSON.stringify(
      templates.find((t) => t.kind === manifest.methods[0]!.kind) ??
        defaultTemplate(manifest.methods[0]!.kind),
      null,
      2,
    ),
  );
  const [step, setStep] = useState<Step>("intro");
  const [instruction, setInstruction] = useState(
    "Calm, concise copy with a clear next action.",
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    parsed = null;
  }
  const checked = validateTemplate(parsed);
  const valid =
    checked.template?.kind === kind && checked.template.id === kind
      ? checked.template
      : undefined;
  const generate = async () => {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          connectorName: manifest.name,
          instruction,
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          typeof result.error === "string" ? result.error : "Generation failed",
        );
      const generated = validateTemplate(result);
      if (!generated.template) throw new Error(generated.errors.join("; "));
      setSource(JSON.stringify(generated.template, null, 2));
      setMessage(
        "Generated and validated. Review the preview, then export or use it.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Generation failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <h2>Presentation templates</h2>
          <p>
            Customize copy and layout. This isolated preview does not execute
            authentication.
          </p>
        </div>
        <span className="pill">Authoring studio</span>
      </div>
      <div className="studio-grid">
        <section className="editor-card">
          <div className="card-top">
            <h2>Template</h2>
            <span className={`validation ${valid ? "valid" : "invalid"}`}>
              {valid ? "✓ Validated" : "Needs attention"}
            </span>
          </div>
          <label htmlFor="flow-kind">Auth family</label>
          <select
            id="flow-kind"
            value={kind}
            onChange={(event) => {
              const next = flowKinds.find(
                (value) => value === event.target.value,
              );
              if (next) {
                setKind(next);
                setSource(
                  JSON.stringify(
                    templates.find((t) => t.kind === next) ??
                      defaultTemplate(next),
                    null,
                    2,
                  ),
                );
                setMessage("");
              }
            }}
          >
            {[...new Set(manifest.methods.map((method) => method.kind))].map(
              (flow) => (
                <option key={flow}>{flow}</option>
              ),
            )}
          </select>
          <label htmlFor="instruction">Presentation direction</label>
          <textarea
            id="instruction"
            value={instruction}
            maxLength={2000}
            rows={2}
            onChange={(event) => setInstruction(event.target.value)}
          />
          <div className="toolbar">
            <button
              className="primary"
              disabled={!generationAvailable || busy}
              onClick={() => void generate()}
            >
              {busy ? "Generating…" : "Generate template"}
            </button>
            <button
              onClick={() =>
                download(
                  "ceremony-prompt.txt",
                  `${authoringPrompt()}\nGenerate kind: ${kind}, id: ${kind}`,
                  "text/plain",
                )
              }
            >
              Export prompt
            </button>
          </div>
          {!generationAvailable && (
            <p className="muted small">
              Generation is not configured. Edit a template here, or export the
              prompt and import model output.
            </p>
          )}
          <label htmlFor="template-source">
            Template source · JSON / OpenUI
          </label>
          <textarea
            id="template-source"
            className="code-editor"
            spellCheck={false}
            value={source}
            maxLength={220000}
            onChange={(event) => setSource(event.target.value)}
          />
          {!valid && (
            <div className="diagnostics" role="alert">
              {checked.errors.length ? (
                checked.errors
                  .slice(0, 5)
                  .map((error) => <p key={error}>{error}</p>)
              ) : (
                <p>Template ID and kind must match the selected auth family.</p>
              )}
            </div>
          )}
          <div className="toolbar">
            <label className="button import-button">
              Import
              <input
                type="file"
                accept="application/json,.json"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    if (file.size > 220000)
                      setMessage("Template file is too large.");
                    else void file.text().then(setSource);
                  }
                  event.target.value = "";
                }}
              />
            </label>
            <button
              disabled={!valid}
              onClick={() =>
                valid &&
                download(
                  `${valid.id}.ceremony.json`,
                  JSON.stringify(valid, null, 2),
                )
              }
            >
              Export template
            </button>
            <button
              className="primary"
              disabled={!valid}
              onClick={() => {
                if (valid) {
                  apply(valid);
                  setMessage(
                    "Presentation saved to this connector project. Connect is unchanged.",
                  );
                }
              }}
            >
              Save presentation to project
            </button>
          </div>
          <p role="status" className="small">
            {message}
          </p>
        </section>
        <section className="preview-column">
          <div className="card-top">
            <h2>Presentation preview</h2>
            <span className="pill">Isolated sample data</span>
          </div>
          <label htmlFor="preview-state">Ceremony state</label>
          <select
            id="preview-state"
            value={step}
            onChange={(event) => {
              const next = steps.find((value) => value === event.target.value);
              if (next) setStep(next);
            }}
          >
            {steps.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <div
            className="preview-card"
            onClickCapture={(event) => {
              if (
                event.target instanceof Element &&
                event.target.closest("a,button")
              )
                event.preventDefault();
            }}
          >
            {valid ? (
              <BoundCeremony
                snapshot={preview(manifest, kind, step)}
                template={valid}
                busy={false}
                act={() => {}}
              />
            ) : (
              <div className="empty-preview">
                <p>Fix the template to see its preview.</p>
              </div>
            )}
          </div>
          <p className="muted small">
            Preview actions never contact a provider. Runtime values stay
            outside the template.
          </p>
        </section>
      </div>
    </>
  );
}
