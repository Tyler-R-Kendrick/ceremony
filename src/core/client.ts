import { z } from "zod";
import {
  entryContextSchema,
  resolveCeremonyMethod,
  type EntryContext,
} from "./resolution.js";
import {
  manifestSchema,
  snapshotSchema,
  validateInput,
  type AuthOutcome,
  type CeremonySnapshot,
  type CeremonyTransport,
  type ConnectorManifest,
} from "./schema.js";
import {
  executeCeremonyAction,
  type ActionHooks,
  type ExecutionSource,
} from "./execution.js";
import {
  commandSchema,
  registerCeremonyTools,
  type CeremonyCommand,
  type CeremonyModelContext,
} from "./webmcp.js";

export function createHttpTransport(
  base = "/api/ceremonies",
): CeremonyTransport {
  async function request(
    path: string,
    body?: unknown,
  ): Promise<CeremonySnapshot> {
    const response = await fetch(`${base}${path}`, {
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      ...(body === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(
        typeof result.error === "string" ? result.error : "Request failed",
      );
    return snapshotSchema.parse(result);
  }
  return {
    connect: (connectorId, context) => request("", { connectorId, context }),
    privateInputUrl: (id) =>
      new URL(
        `${base}/${encodeURIComponent(id)}/collector`,
        globalThis.location.href,
      ).href,
    start: (connectorId, methodId) => request("", { connectorId, methodId }),
    read: (id) => request(`/${encodeURIComponent(id)}`),
    act: (id, action) => request(`/${encodeURIComponent(id)}/actions`, action),
    collect: async (id, revision, values) => {
      const response = await fetch(
        `${base}/${encodeURIComponent(id)}/collect`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision, values }),
        },
      );
      if (!response.ok) throw new Error("Private credential collection failed");
      return z.object({ secretRef: z.uuid() }).parse(await response.json())
        .secretRef;
    },
  };
}
export interface CeremonyClientOptions extends ActionHooks {
  manifest: ConnectorManifest;
  transport?: CeremonyTransport;
  context?: EntryContext;
  /** Automatic by default; manual is useful for a method gallery or authoring tools. */
  selection?: "automatic" | "manual";
  /** Opt-in host authorization to request an available agent/human handoff automatically. */
  delegation?: "agent" | "human";
  resumeId?: string;
  onInstance?(id: string): void;
  onComplete?(outcome: AuthOutcome): void;
  onCancel?(): void;
  /** Host navigation receives only a validated server-owned destination. */
  navigate?(url: string, target: "same-tab" | "new-tab"): void | Promise<void>;
}
export interface CeremonyClientState {
  readonly snapshot: CeremonySnapshot | undefined;
  readonly busy: boolean;
  readonly refreshing: boolean;
  readonly error: string;
}
function browserNavigate(url: string, target: "same-tab" | "new-tab") {
  if (typeof window === "undefined")
    throw new Error("Supply a navigation handler outside the browser.");
  if (target === "same-tab") window.location.assign(url);
  else {
    const popup = window.open("about:blank", "_blank");
    if (!popup) throw new Error("Allow popups to open the approval page.");
    popup.opener = null;
    popup.location.replace(url);
  }
}
/** Framework-neutral external store. Constructing it does not perform I/O. */
export function createCeremonyClient(options: CeremonyClientOptions) {
  const manifest = manifestSchema.parse(options.manifest);
  const transport = options.transport ?? createHttpTransport();
  const context = entryContextSchema.parse({
    surface: typeof window === "undefined" ? "headless" : "browser",
    ...options.context,
  });
  let state: CeremonyClientState = {
    snapshot: undefined,
    busy: false,
    refreshing: false,
    error: "",
  };
  const initial = state;
  const listeners = new Set<() => void>();
  const registrations = new Set<AbortController>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingRead: Promise<void> | undefined;
  let locked = false;
  let initialized = false;
  let disposed = false;
  let notified = "";
  let privateInputPending = false;
  const observe = (callback: () => void) => {
    try {
      callback();
    } catch {
      /* Host observers cannot roll back authentication. */
    }
  };
  function schedule() {
    clearTimeout(timer);
    if (
      !disposed &&
      listeners.size &&
      (privateInputPending ||
        state.snapshot?.step === "waiting" ||
        (state.snapshot?.step === "redirect" &&
          state.snapshot.prerequisites)) &&
      !locked
    )
      timer = setTimeout(() => {
        void execute({ action: "read" }, "system").catch(() => {});
      }, 1200);
  }
  function publish(patch: Partial<CeremonyClientState>) {
    state = { ...state, ...patch };
    if (!disposed) for (const listener of listeners) observe(listener);
    schedule();
  }
  function accept(input: CeremonySnapshot) {
    const snapshot = snapshotSchema.parse(input);
    if (!snapshot.actions.includes("submit")) privateInputPending = false;
    if (snapshot.connectorId !== manifest.id)
      throw new Error("This attempt belongs to a different connector.");
    if (
      !context.requiredScopes.every((scope) =>
        (snapshot.outcome?.scopes ?? snapshot.method.scopes).includes(scope),
      )
    )
      throw new Error("This attempt does not satisfy the requested access.");
    publish({ snapshot });
    const key = `${snapshot.id}:${snapshot.step}:${snapshot.outcome?.ownership ?? ""}`;
    if (!disposed && key !== notified) {
      if (snapshot.step === "complete" && snapshot.outcome) {
        notified = key;
        observe(() => options.onComplete?.(snapshot.outcome!));
      } else if (snapshot.step === "cancelled") {
        notified = key;
        observe(() => options.onCancel?.());
      }
    }
    return snapshot;
  }
  async function execute(
    command: CeremonyCommand,
    source: ExecutionSource = "ui",
    signal?: AbortSignal,
  ): Promise<CeremonySnapshot | undefined> {
    const before = state.snapshot;
    return executeCeremonyAction(
      {
        action: command.action,
        source,
        connectorId: manifest.id,
        ...(before
          ? { instanceId: before.id, methodId: before.method.id }
          : {}),
        ...(command.action === "start" && command.methodId
          ? { methodId: command.methodId }
          : {}),
      },
      async () => {
        const parsed = commandSchema.parse(command);
        if (parsed.action !== "read") await pendingRead;
        signal?.throwIfAborted();
        if (disposed)
          throw new Error("This ceremony client has been disposed.");
        if (locked) throw new Error("A ceremony action is already running.");
        locked = true;
        const prior = state.snapshot;
        const readDone =
          parsed.action === "read" ? Promise.withResolvers<void>() : undefined;
        if (readDone) pendingRead = readDone.promise;
        publish({ busy: !readDone, refreshing: !!readDone, error: "" });
        try {
          let next: CeremonySnapshot;
          if (parsed.action === "start") {
            if (
              parsed.methodId &&
              !manifest.methods.some((method) => method.id === parsed.methodId)
            )
              throw new Error("Unknown authentication method.");
            if (parsed.methodId && prior?.actions.includes("cancel")) {
              const cancelled = await executeCeremonyAction(
                {
                  action: "cancel",
                  source,
                  connectorId: manifest.id,
                  instanceId: prior.id,
                  methodId: prior.method.id,
                },
                () =>
                  transport.act(prior.id, {
                    action: "cancel",
                    revision: prior.revision,
                    values: {},
                  }),
                options,
              );
              signal?.throwIfAborted();
              if (disposed)
                throw new Error("This ceremony client has been disposed.");
              if (cancelled) accept(cancelled);
            }
            signal?.throwIfAborted();
            if (disposed)
              throw new Error("This ceremony client has been disposed.");
            next = parsed.methodId
              ? await transport.start(manifest.id, parsed.methodId)
              : transport.connect
                ? await transport.connect(manifest.id, context)
                : await transport.start(
                    manifest.id,
                    resolveCeremonyMethod(manifest, context).id,
                  );
            signal?.throwIfAborted();
            if (disposed)
              throw new Error("This ceremony client has been disposed.");
            next = accept(next);
            if (!disposed) observe(() => options.onInstance?.(next.id));
            // Only protocol preparation is automatic, not provisioning anonymous resources.
            if (
              !parsed.methodId &&
              next.actions.includes("begin") &&
              ["oauth-code", "device"].includes(next.method.kind)
            ) {
              const prepared = await executeCeremonyAction(
                {
                  action: "begin",
                  source,
                  connectorId: manifest.id,
                  instanceId: next.id,
                  methodId: next.method.id,
                },
                () =>
                  transport.act(next.id, {
                    action: "begin",
                    revision: next.revision,
                    values: {},
                  }),
                options,
              );
              if (prepared) next = prepared;
            }
            signal?.throwIfAborted();
            if (disposed)
              throw new Error("This ceremony client has been disposed.");
            if (
              !parsed.methodId &&
              options.delegation === "agent" &&
              next.actions.includes("request-human")
            ) {
              accept(next);
              try {
                const delegated = await executeCeremonyAction(
                  {
                    action: "request-human",
                    source,
                    connectorId: manifest.id,
                    instanceId: next.id,
                    methodId: next.method.id,
                  },
                  () =>
                    transport.act(next.id, {
                      action: "request-human",
                      revision: next.revision,
                      values: {},
                    }),
                  options,
                );
                if (delegated) next = delegated;
              } catch {
                publish({
                  error:
                    "Delegation is unavailable. Continue using the provider link or private collector.",
                });
              }
            }
          } else if (parsed.action === "read") {
            const id = prior?.id ?? options.resumeId;
            if (!id) return undefined;
            next = await transport.read(id);
          } else {
            if (!prior)
              throw new Error("Select an authentication method first.");
            if (parsed.action === "request-input") {
              if (
                !prior.fields.length ||
                !prior.actions.includes("submit") ||
                !transport.privateInputUrl
              )
                throw new Error(
                  "Use the host's private credential collector. Never enter secrets in chat.",
                );
              await (options.navigate ?? browserNavigate)(
                transport.privateInputUrl(prior.id),
                "new-tab",
              );
              privateInputPending = true;
              return prior;
            }
            if (parsed.action === "navigate") {
              if (prior.expiresAt <= Date.now())
                throw new Error("This attempt has expired.");
              const url =
                prior.step === "redirect"
                  ? prior.authorizationUrl
                  : prior.step === "waiting"
                    ? prior.verificationUri
                    : undefined;
              if (!url)
                throw new Error("Provider navigation is not available.");
              await (options.navigate ?? browserNavigate)(
                url,
                prior.step === "redirect" && !prior.prerequisites
                  ? "same-tab"
                  : "new-tab",
              );
              return prior;
            }
            if (!prior.actions.includes(parsed.action))
              throw new Error("Action is not available in the current state.");
            if (
              source === "webmcp" &&
              prior.fields.some(
                (field) =>
                  field.type === "password" &&
                  Object.hasOwn(parsed.values ?? {}, field.name),
              )
            )
              throw new Error(
                "Use private credential collection, not tool arguments.",
              );
            let secretRef = parsed.secretRef;
            let values = secretRef
              ? {}
              : validateInput(
                  parsed.action === "submit" ? prior.fields : [],
                  parsed.values ?? {},
                );
            if (
              parsed.action === "submit" &&
              !secretRef &&
              prior.fields.some((field) => field.type === "password") &&
              transport.collect
            ) {
              secretRef = await transport.collect(
                prior.id,
                prior.revision,
                values,
              );
              values = {};
            }
            signal?.throwIfAborted();
            if (disposed)
              throw new Error("This ceremony client has been disposed.");
            next = await transport.act(prior.id, {
              action: parsed.action,
              revision: prior.revision,
              values,
              ...(secretRef ? { secretRef } : {}),
            });
          }
          signal?.throwIfAborted();
          if (disposed)
            throw new Error("This ceremony client has been disposed.");
          const accepted = accept(next);
          return accepted;
        } catch (cause) {
          publish({
            error:
              cause instanceof Error
                ? cause.message
                : "Action failed. Try again.",
          });
          if (
            prior &&
            parsed.action !== "read" &&
            !disposed &&
            !signal?.aborted
          ) {
            try {
              const recovered = await transport.read(prior.id);
              signal?.throwIfAborted();
              if (!disposed) accept(recovered);
            } catch {
              /* Keep the last valid screen. */
            }
          }
          throw cause;
        } finally {
          locked = false;
          if (readDone) {
            pendingRead = undefined;
            readDone.resolve();
          }
          publish({ busy: false, refreshing: false });
        }
      },
      options,
    );
  }
  return {
    manifest,
    getState: () => state,
    getServerState: () => initial,
    subscribe(listener: () => void) {
      if (disposed) throw new Error("This ceremony client has been disposed.");
      listeners.add(listener);
      schedule();
      return () => {
        listeners.delete(listener);
        schedule();
      };
    },
    execute,
    async initialize() {
      if (initialized) return;
      initialized = true;
      if (options.resumeId) await execute({ action: "read" }, "system");
      else if (options.selection !== "manual")
        await execute({ action: "start" }, "system");
      else if (manifest.methods.length === 1)
        await execute(
          { action: "start", methodId: manifest.methods[0]!.id },
          "system",
        );
    },
    /** Unregisters only this registration; no global context replacement. */
    attachWebMCP(
      context: CeremonyModelContext,
      prefix = `ceremony_${manifest.id}`,
    ) {
      if (disposed) throw new Error("This ceremony client has been disposed.");
      const lifetime = new AbortController();
      registrations.add(lifetime);
      void registerCeremonyTools(
        context,
        prefix,
        manifest,
        (command, signal) => execute(command, "webmcp", signal),
        lifetime.signal,
      ).catch(() => {
        if (!lifetime.signal.aborted) {
          lifetime.abort();
          registrations.delete(lifetime);
          publish({
            error:
              "WebMCP registration failed. You can still use the ceremony controls.",
          });
        }
      });
      return () => {
        lifetime.abort();
        registrations.delete(lifetime);
      };
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      listeners.clear();
      for (const registration of registrations) registration.abort();
      registrations.clear();
    },
  };
}
export type CeremonyClient = ReturnType<typeof createCeremonyClient>;
