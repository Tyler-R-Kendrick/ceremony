import { ConnectorError } from "../../errors.js";
import type { AdapterCallContext, InvokeResult } from "../../adapter.js";
import type { DockerRunDescriptor } from "./export.js";

/*
 * The seam for optional local execution.
 *
 * Ceremony never installs Docker, never pulls an image and never spawns a
 * process. A deployment that has its own trusted local runner may supply one
 * through this port; every other deployment keeps the default, which reports
 * exactly why execution is unavailable and refuses to run. The port is the
 * only place a descriptor could ever become a process, and the default
 * implementation of that port does nothing at all.
 */

export type HostRunnerAvailability = { available: boolean; reason?: string };

export interface HostRunnerPort {
  available(): Promise<HostRunnerAvailability>;
  run(
    descriptor: DockerRunDescriptor,
    ctx: AdapterCallContext,
    request?: { operationRef: string; input: unknown; commandId: string },
  ): Promise<InvokeResult>;
}

export const NO_RUNNER_CONFIGURED =
  "No trusted local runner is configured for this deployment: Docker MCP catalog entries are imported as descriptions only, and nothing is installed, pulled or executed.";

/**
 * The default runner: unavailable, with the exact reason, and fail-closed.
 * `run` throws rather than returning a failure result, because a caller that
 * reached it asked for an effect the deployment cannot perform at all.
 */
export function unavailableHostRunner(
  reason: string = NO_RUNNER_CONFIGURED,
): HostRunnerPort {
  const text = reason.slice(0, 500);
  return {
    async available() {
      return { available: false, reason: text };
    },
    async run() {
      throw new ConnectorError("unsupported", {
        detail: "docker.runner.unavailable",
      });
    },
  };
}
