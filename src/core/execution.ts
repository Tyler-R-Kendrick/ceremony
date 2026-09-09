import type { ActionName, CeremonySnapshot, Step } from "./index.js";

export type CeremonyOperation =
  ActionName | "start" | "read" | "navigate" | "request-input";
export type ExecutionSource = "ui" | "webmcp" | "system";
/** Deliberately excludes input values, URLs, provider messages and connection handles. */
export interface ActionEvent {
  executionId: string;
  action: CeremonyOperation;
  source: ExecutionSource;
  connectorId: string;
  methodId?: string;
  instanceId?: string;
  revision?: number;
  step?: Step;
  startedAt: number;
  finishedAt: number;
}
export interface ActionFailureEvent extends ActionEvent {
  reason: "execution_failed" | "ceremony_failed" | "expired";
}
export interface ActionHooks {
  onActionSuccess?: ((event: ActionEvent) => void | Promise<void>) | undefined;
  onActionFailure?:
    ((event: ActionFailureEvent) => void | Promise<void>) | undefined;
}

/** Hooks are best-effort notifications, not transactional work or authorization. */
export async function executeCeremonyAction(
  context: Pick<
    ActionEvent,
    "action" | "source" | "connectorId" | "methodId" | "instanceId"
  >,
  execute: () => Promise<CeremonySnapshot | undefined>,
  hooks: ActionHooks = {},
): Promise<CeremonySnapshot | undefined> {
  const executionId = globalThis.crypto.randomUUID();
  const startedAt = Date.now();
  const notify = (
    snapshot?: CeremonySnapshot,
    reason?: ActionFailureEvent["reason"],
  ) => {
    const event: ActionEvent = {
      action: context.action,
      source: context.source,
      connectorId: context.connectorId,
      ...(context.methodId ? { methodId: context.methodId } : {}),
      ...(context.instanceId ? { instanceId: context.instanceId } : {}),
      executionId,
      startedAt,
      finishedAt: Date.now(),
      ...(snapshot
        ? {
            methodId: snapshot.method.id,
            instanceId: snapshot.id,
            revision: snapshot.revision,
            step: snapshot.step,
          }
        : {}),
    };
    // A rejected observer must never turn completed authentication into a failed action.
    try {
      const pending = reason
        ? hooks.onActionFailure?.({ ...event, reason })
        : hooks.onActionSuccess?.(event);
      void Promise.resolve(pending).catch(() => {});
    } catch {
      /* Observers cannot change the execution result. */
    }
  };
  let snapshot: CeremonySnapshot | undefined;
  try {
    snapshot = await execute();
  } catch (error) {
    notify(undefined, "execution_failed");
    throw error;
  }
  notify(
    snapshot,
    snapshot?.step === "error"
      ? "ceremony_failed"
      : snapshot?.step === "expired"
        ? "expired"
        : undefined,
  );
  return snapshot;
}
