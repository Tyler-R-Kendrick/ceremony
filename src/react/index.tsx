"use client";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  browserModelContext,
  createCeremonyClient,
  defaultTemplate,
  type CeremonyClient,
  type CeremonyClientOptions,
  type CeremonyCommand,
  type CeremonyTemplate,
} from "../core/index.js";
import { BoundCeremony, validateTemplate } from "./templates.js";
export * from "./templates.js";
export * from "./webmcp.js";
export { createHttpTransport } from "../core/index.js";

/** Use the exact same client with host-owned React components instead of OpenUI. */
export function useCeremony(client: CeremonyClient) {
  const state = useSyncExternalStore(
    client.subscribe,
    client.getState,
    client.getServerState,
  );
  useEffect(() => {
    void client.initialize().catch(() => {});
  }, [client]);
  return {
    ...state,
    client,
    execute: client.execute,
    manifest: client.manifest,
  };
}
export interface CeremonyProps extends CeremonyClientOptions {
  templates?: CeremonyTemplate[];
  webmcp?: false | { prefix?: string };
  className?: string;
  style?: CSSProperties;
  id?: string;
  "aria-label"?: string;
  dir?: "ltr" | "rtl" | "auto";
  /** Disable when the host owns focus (for example, a dialog or a multi-step wizard). */
  autoFocus?: boolean;
  /** Replace the view with your UI library; execution and WebMCP remain connected. */
  children?: (ceremony: ReturnType<typeof useCeremony>) => ReactNode;
}
export function Ceremony(props: CeremonyProps) {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const callbacks = useRef(props);
  callbacks.current = props;
  const [client] = useState(() =>
    createCeremonyClient({
      manifest: props.manifest,
      ...(props.transport ? { transport: props.transport } : {}),
      ...(props.context ? { context: props.context } : {}),
      ...(props.selection ? { selection: props.selection } : {}),
      ...(props.delegation ? { delegation: props.delegation } : {}),
      ...(props.resumeId ? { resumeId: props.resumeId } : {}),
      onInstance: (id) => {
        if (mounted.current) callbacks.current.onInstance?.(id);
      },
      onComplete: (outcome) => callbacks.current.onComplete?.(outcome),
      onCancel: () => callbacks.current.onCancel?.(),
      onActionSuccess: (event) => callbacks.current.onActionSuccess?.(event),
      onActionFailure: (event) => callbacks.current.onActionFailure?.(event),
      ...(props.navigate
        ? {
            navigate: (url: string, target: "same-tab" | "new-tab") =>
              callbacks.current.navigate?.(url, target),
          }
        : {}),
    }),
  );
  const model = useCeremony(client);
  useEffect(() => {
    const context = browserModelContext();
    if (props.webmcp === false || !context) return;
    return client.attachWebMCP(context, props.webmcp?.prefix);
  }, [client, props.webmcp === false, props.webmcp && props.webmcp.prefix]);
  if (props.children) return props.children(model);
  return (
    <CeremonyView
      model={model}
      {...(props.templates ? { templates: props.templates } : {})}
      {...(props.className ? { className: props.className } : {})}
      {...(props.style ? { style: props.style } : {})}
      {...(props.id ? { id: props.id } : {})}
      {...(props["aria-label"] ? { "aria-label": props["aria-label"] } : {})}
      {...(props.dir ? { dir: props.dir } : {})}
      autoFocus={props.autoFocus ?? true}
    />
  );
}
/** A replaceable view: multiple views can share one host-owned client. */
export function CeremonyView({
  model,
  templates = [],
  autoFocus = true,
  ...rootProps
}: {
  model: ReturnType<typeof useCeremony>;
  templates?: CeremonyTemplate[];
  autoFocus?: boolean;
  className?: string;
  style?: CSSProperties;
  id?: string;
  "aria-label"?: string;
  dir?: "ltr" | "rtl" | "auto";
}) {
  const { snapshot, busy, error, manifest } = model;
  const id = useId();
  const region = useRef<HTMLDivElement>(null);
  const [selectedMethod, setSelectedMethod] = useState(
    manifest.methods[0]?.id ?? "",
  );
  const methodId = snapshot?.method.id ?? selectedMethod;
  const dispatch = (command: CeremonyCommand) => {
    void model.execute(command).catch(() => {});
  };
  useEffect(() => {
    if (snapshot && autoFocus) region.current?.focus({ preventScroll: true });
  }, [snapshot?.id, snapshot?.step, snapshot?.outcome?.ownership, autoFocus]);
  const template = useMemo(() => {
    if (!snapshot) return undefined;
    const candidate =
      templates.find(
        (template) => template.id === snapshot.method.templateId,
      ) ?? defaultTemplate(snapshot.method.kind);
    const checked = validateTemplate(candidate);
    return checked.template?.kind === snapshot.method.kind
      ? checked.template
      : undefined;
  }, [templates, snapshot?.method.templateId, snapshot?.method.kind]);
  return (
    <div
      {...rootProps}
      className={`ceremony ${rootProps.className ?? ""}`.trim()}
      data-ceremony=""
      data-step={snapshot?.step ?? "select"}
      ref={region}
      tabIndex={-1}
      role="region"
      aria-label={
        rootProps["aria-label"] ?? `${manifest.name} connection ceremony`
      }
      aria-busy={busy}
    >
      {!snapshot && !busy && (
        <>
          <h2>Choose how to connect</h2>
          <p className="supporting">
            Select an available method to review its next step.
          </p>
        </>
      )}
      {manifest.methods.length > 1 && (
        <div className="method-picker" data-ceremony-part="method-picker">
          <label htmlFor={`${id}-method`}>Authentication method</label>
          <div>
            <select
              id={`${id}-method`}
              value={methodId}
              disabled={busy}
              onChange={(event) => {
                setSelectedMethod(event.target.value);
                dispatch({ action: "start", methodId: event.target.value });
              }}
            >
              {manifest.methods.map((method) => (
                <option value={method.id} key={method.id}>
                  {method.label}
                </option>
              ))}
            </select>
            {!snapshot && (
              <button
                type="button"
                disabled={busy}
                onClick={() => dispatch({ action: "start", methodId })}
              >
                Select method
              </button>
            )}
          </div>
        </div>
      )}
      {error && (
        <div data-ceremony-part="error">
          <p className="notice" role="alert" id={`${id}-error`}>
            {error}
          </p>
          {snapshot && (
            <button
              type="button"
              disabled={busy}
              onClick={() => dispatch({ action: "read" })}
            >
              Refresh status
            </button>
          )}
        </div>
      )}
      {snapshot?.prerequisites && (
        <ol
          data-ceremony-part="prerequisites"
          aria-label="Connection prerequisites"
        >
          {snapshot.prerequisites.map((node) => (
            <li
              key={node.id}
              data-status={node.status}
              aria-current={
                node.status === "awaiting-human" || node.status === "ready"
                  ? "step"
                  : undefined
              }
            >
              <span>{node.label}</span>
              {" — "}
              <span>
                {node.status === "succeeded"
                  ? "Verified"
                  : node.status === "awaiting-human"
                    ? "Needs your approval"
                    : node.status === "blocked"
                      ? "Blocked"
                      : node.status === "ready"
                        ? "Ready"
                        : node.status === "verifying"
                          ? "Verifying"
                          : "Needs attention"}
              </span>
            </li>
          ))}
        </ol>
      )}
      {snapshot && template && (
        <BoundCeremony
          snapshot={snapshot}
          template={template}
          busy={busy}
          act={(action, values) => dispatch({ action, values: values ?? {} })}
          navigate={() => dispatch({ action: "navigate" })}
          {...(error ? { errorId: `${id}-error` } : {})}
        />
      )}
      {snapshot && !template && (
        <p role="alert">
          This ceremony template is invalid or incompatible. Contact the
          connector author.
        </p>
      )}
    </div>
  );
}
