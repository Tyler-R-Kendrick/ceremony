import assert from "node:assert/strict";
import type { ActorContext } from "../../../src/core/operation-contracts.js";
import {
  completeOauthCallback,
  createHarness,
  FIXTURE_DOCUMENT,
  human,
  ORIGIN,
  type Harness,
} from "../commands/harness.js";

/*
 * QA scaffolding over the delivered command harness. Nothing here re-implements
 * the product: it drives the same public HTTP route table a browser reaches,
 * and every observation is read back out of the route responses, the provider
 * fixture's own records or the store. The clock and randomness reach the
 * service only through its explicit ports, so a QA test that needs determinism
 * asks for a controlled clock and a test of production defaults asks for none.
 */

export { completeOauthCallback, createHarness, human, ORIGIN };
export type { Harness };

export const SESSION = "qa-session";

export async function json(
  response: Response,
): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** A controllable clock, handed to the service through its `now` option only. */
export function fakeClock(start = Date.parse("2026-09-18T12:00:00.000Z")) {
  let value = start;
  return {
    now: () => value,
    advance(ms: number) {
      value += ms;
    },
    set(ms: number) {
      value = ms;
    },
  };
}

export type ApprovedBinding = {
  definitionRef: string;
  bindingRef: string;
  sourceRef: string;
};

/** Imports the fixture document and approves a binding through the real routes. */
export async function approveFixtureBinding(
  harness: Harness,
  options: {
    session?: string;
    actor?: ActorContext;
    operations?: unknown[];
    permittedTargets?: Array<{ kind: string; id: string }>;
    document?: string;
  } = {},
): Promise<ApprovedBinding> {
  const session = options.session ?? SESSION;
  const actor = options.actor ?? human();
  harness.register(session, actor);
  const imported = await harness.fetch("/api/v1/connectors/import", {
    body: {
      kind: "upload",
      mediaType: "application/json",
      text: options.document ?? FIXTURE_DOCUMENT(harness.provider.origin),
    },
    session,
  });
  assert.equal(imported.status, 200, await importFailure(imported));
  const result = await json(imported);
  const definitionRef = (result.definitions as string[])[0]!;
  const binding = await harness.fetch("/api/v1/connectors/bindings", {
    body: {
      definitionRef,
      adapterId: "fixture-http",
      approvals: {
        destinations: [harness.provider.origin],
        operations: options.operations ?? [
          "listItems",
          {
            nativeId: "createItem",
            consent: "confirm",
            replay: "upstream-idempotency-key",
          },
        ],
        profileId: "oauth",
        permittedTargets: options.permittedTargets ?? [
          { kind: "account", id: "acct-primary" },
        ],
      },
    },
    session,
  });
  assert.equal(binding.status, 201);
  const reference = await json(binding);
  return {
    definitionRef,
    bindingRef: reference.bindingRef as string,
    sourceRef: result.sourceRef as string,
  };
}

async function importFailure(response: Response): Promise<string> {
  try {
    return JSON.stringify(await response.clone().json());
  } catch {
    return `status ${response.status}`;
  }
}

/** The approved operation reference for a native id, read from the stored binding. */
export function operationRef(
  harness: Harness,
  bindingRef: string,
  nativeId: string,
): string {
  const binding = harness.definitions
    .bindings()
    .filter((item) => item.bindingRef === bindingRef)
    .sort((a, b) => a.revision - b.revision)
    .at(-1);
  const operation = binding?.operations.find(
    (item) => item.nativeId === nativeId,
  );
  if (!operation) throw new Error(`no approved operation ${nativeId}`);
  return operation.operationRef;
}

/** Starts a connection and returns its reference plus the private presentation URL. */
export async function startConnection(
  harness: Harness,
  bindingRef: string,
  options: {
    session?: string;
    target?: { kind: string; id: string };
    interruption?: "allowed" | "none";
    accountSwitch?: boolean;
  } = {},
): Promise<{ connectionRef: string; presentationUrl?: string; body: Record<string, unknown> }> {
  const session = options.session ?? SESSION;
  const response = await harness.fetch("/api/v1/connectors/connections", {
    body: {
      bindingRef,
      ownerKind: "user",
      intent: {
        profileId: "oauth",
        requestedPermissions: ["read", "write"],
        target: options.target ?? { kind: "account", id: "acct-primary" },
        accountSwitch: options.accountSwitch ?? false,
        interruption: options.interruption ?? "allowed",
      },
    },
    session,
  });
  const body = await json(response);
  const presentation = body.presentation as { url?: string } | undefined;
  return {
    connectionRef: body.connectionRef as string,
    ...(presentation?.url ? { presentationUrl: presentation.url } : {}),
    body,
  };
}

/** Drives the whole happy path to an active connection through the routes. */
export async function activeConnection(
  harness: Harness,
  options: { session?: string } = {},
): Promise<{ connectionRef: string; bindingRef: string; definitionRef: string }> {
  const session = options.session ?? SESSION;
  const approved = await approveFixtureBinding(harness, { session });
  const started = await startConnection(harness, approved.bindingRef, {
    session,
  });
  assert.ok(started.presentationUrl, "the human is given an authorization URL");
  const callback = await completeOauthCallback(
    harness,
    session,
    started.presentationUrl,
  );
  assert.equal(callback.status, 303);
  return { connectionRef: started.connectionRef, ...approved };
}

export function connectionPath(connectionRef: string, action = ""): string {
  return `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}${
    action ? `/${action}` : ""
  }`;
}
