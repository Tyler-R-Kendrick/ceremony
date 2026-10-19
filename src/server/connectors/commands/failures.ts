import { z } from "zod";
import type { ActorContext } from "../../../core/operation-contracts.js";
import { AuthorizationError, type Capability } from "../../identity.js";
import { PersistenceConflict } from "../../persistence/index.js";
import { ConnectorError } from "../errors.js";

/*
 * How failures cross the command layer's boundary: a port's failure in the
 * connector vocabulary, an adapter's as a code and never as text, and the
 * capability check that lets an administrator through.
 */

export function requireAny(
  actor: ActorContext,
  capabilities: Capability[],
): void {
  if (
    !actor.capabilities.includes("admin") &&
    !capabilities.some((capability) => actor.capabilities.includes(capability))
  )
    throw new AuthorizationError("denied");
}

/** Port failures in the connector vocabulary; ownership failures leak no existence. */
export async function port<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ConnectorError || error instanceof AuthorizationError)
      throw error;
    if (error instanceof PersistenceConflict)
      throw new ConnectorError("conflict", { cause: error });
    if (error instanceof Error) {
      if (/conflict|stale|already/i.test(error.message))
        throw new ConnectorError("conflict", { cause: error });
      if (/denied|unknown|not found/i.test(error.message))
        throw new ConnectorError("not-found", { cause: error });
    }
    throw error;
  }
}

/** Adapter failures never reach a caller as text; only a code does. */
export async function adapterCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    if (error instanceof z.ZodError)
      throw new ConnectorError("invalid-request", {
        detail: "adapter.input",
        cause: error,
      });
    if (error instanceof DOMException && error.name === "AbortError")
      throw new ConnectorError("upstream-unavailable", {
        detail: "adapter.timeout",
        cause: error,
      });
    throw new ConnectorError("upstream-unavailable", {
      detail: "adapter.failure",
      cause: error,
    });
  }
}
