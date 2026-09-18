import { timingSafeEqual } from "node:crypto";
import {
  connectorHandoffSummarySchema,
  presentationUrlSchema,
  type ConnectorHandoffSummary,
  type HumanPresentation,
} from "../../../core/connectors/index.js";
import type { AdapterCallContext, HandoffProposal } from "../adapter.js";
import { ConnectorError } from "../errors.js";
import type { HandoffRecord } from "../ports.js";
import { sha256Hex } from "./wire.js";

/*
 * The private handoff contract. A handoff carries the one thing a person must
 * do elsewhere: open a provider page, approve a device code, complete a
 * connect widget, fill a private collector. The material that makes it work
 * (the authorization URL with its state, the PKCE verifier, the widget token,
 * the device code) is protected transient state in `HandoffIssue.private`.
 * The summary that leaves the server never contains it; the initiating human
 * receives only a presentation (URL or user code) through
 * `humanHandoffPresentation`; and nothing a browser window says about itself
 * (a postMessage, a close event, a Done button) completes anything. Completion
 * is a server act that rereads authoritative state.
 */

const intentPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){0,11}$/;
const MAX_PRIVATE_KEYS = 32;
const MAX_PRIVATE_VALUE = 16_384;

export type HandoffTarget = { connectionRef: string; bindingRef: string };

function checkProposal(
  proposal: HandoffProposal,
  now: number,
): asserts proposal is HandoffProposal {
  if (!Number.isFinite(proposal.expiresAt) || proposal.expiresAt <= now)
    throw new ConnectorError("invalid-request", {
      detail: "oauth.handoff.expiry",
    });
  if (!intentPattern.test(proposal.intent))
    throw new ConnectorError("invalid-request", {
      detail: "oauth.handoff.intent",
    });
  if (
    proposal.correlationKey !== undefined &&
    (proposal.correlationKey.length === 0 ||
      proposal.correlationKey.length > 512)
  )
    throw new ConnectorError("invalid-request", {
      detail: "oauth.handoff.correlation",
    });
  const entries = Object.entries(proposal.private);
  if (entries.length > MAX_PRIVATE_KEYS)
    throw new ConnectorError("invalid-request", {
      detail: "oauth.handoff.private-size",
    });
  for (const [key, value] of entries)
    if (
      !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) ||
      typeof value !== "string" ||
      value.length > MAX_PRIVATE_VALUE
    )
      throw new ConnectorError("invalid-request", {
        detail: "oauth.handoff.private-shape",
      });
}

/**
 * Persists a proposed handoff for the calling actor and connection. The port
 * assigns the reference; the summary is re-validated against the strict public
 * schema so a port that ever leaked private material into it would fail here
 * rather than downstream.
 */
export async function issueHandoff(
  ctx: AdapterCallContext,
  proposal: HandoffProposal,
  target?: HandoffTarget,
): Promise<{ handoffRef: string; summary: ConnectorHandoffSummary }> {
  const connectionRef = target?.connectionRef ?? ctx.connection?.connectionRef;
  const bindingRef = target?.bindingRef ?? ctx.binding.bindingRef;
  if (!connectionRef)
    throw new ConnectorError("invalid-request", {
      detail: "oauth.handoff.connection-required",
    });
  checkProposal(proposal, ctx.environment.now());
  const issued = await ctx.environment.handoffs.issue({
    kind: proposal.kind,
    presentation: proposal.presentation,
    expiresAt: proposal.expiresAt,
    intent: proposal.intent,
    ...(proposal.correlationKey !== undefined
      ? { correlationKey: proposal.correlationKey }
      : {}),
    private: { ...proposal.private },
    actor: ctx.actor,
    connectionRef,
    bindingRef,
    generation: ctx.generation,
  });
  return {
    handoffRef: issued.handoffRef,
    summary: connectorHandoffSummarySchema.parse(issued.summary),
  };
}

/** A hosted connect link plus its widget/session token, both private (Nango, Pipedream, Composio, WorkOS). */
export function connectWidgetHandoff(input: {
  connectLink: string;
  token: string;
  expiresAt: number;
  intent?: string;
  presentation?: "popup" | "in-app" | "same-window";
  correlationKey?: string;
  extra?: Record<string, string>;
}): HandoffProposal {
  return {
    kind: "connect-widget",
    presentation: input.presentation ?? "popup",
    expiresAt: input.expiresAt,
    intent: input.intent ?? "connector.connect-widget",
    ...(input.correlationKey !== undefined
      ? { correlationKey: input.correlationKey }
      : {}),
    private: {
      ...input.extra,
      connectLink: input.connectLink,
      token: input.token,
    },
  };
}

/** A native private collector (MCP Apps `ceremony_collect_private`); the collector reference stays private. */
export function privateCollectorHandoff(input: {
  collectorRef: string;
  expiresAt: number;
  intent?: string;
  collectorUrl?: string;
  extra?: Record<string, string>;
}): HandoffProposal {
  return {
    kind: "private-collector",
    presentation: "in-app",
    expiresAt: input.expiresAt,
    intent: input.intent ?? "connector.private-collector",
    private: {
      ...input.extra,
      collectorRef: input.collectorRef,
      ...(input.collectorUrl !== undefined
        ? { collectorUrl: input.collectorUrl }
        : {}),
    },
  };
}

/** A further round of input the provider asked for mid-operation (MCP `input_required`, MFA). */
export function inputRequiredHandoff(input: {
  expiresAt: number;
  intent?: string;
  continuationToken?: string;
  fields?: readonly string[];
}): HandoffProposal {
  return {
    kind: "input-required",
    presentation: "in-app",
    expiresAt: input.expiresAt,
    intent: input.intent ?? "connector.input-required",
    private: {
      ...(input.continuationToken !== undefined
        ? { continuationToken: input.continuationToken }
        : {}),
      fields: JSON.stringify(input.fields ?? []),
    },
  };
}

function safeUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = presentationUrlSchema.safeParse(value);
  if (!parsed.success)
    throw new ConnectorError("invalid-request", {
      detail: "oauth.handoff.unsafe-url",
    });
  return parsed.data;
}

/**
 * What the initiating human may see for a pending handoff: the URL to open or
 * the code to type, and nothing else. State, verifier, device code, widget
 * token and collector reference never appear. The caller has already proven
 * this person owns the handoff (`HandoffPort.present`); a finished or expired
 * handoff presents nothing.
 */
export function humanHandoffPresentation(
  record: Pick<HandoffRecord, "kind" | "state" | "private" | "expiresAt">,
  now: number = Date.now(),
): HumanPresentation {
  if (record.state !== "issued" && record.state !== "waiting") return {};
  if (record.expiresAt <= now) return {};
  const shown: HumanPresentation = {};
  switch (record.kind) {
    case "provider-browser": {
      const url = safeUrl(record.private["authorizationUrl"]);
      if (url) shown.url = url;
      shown.instructions = "Continue with the provider to authorize access.";
      return shown;
    }
    case "connect-widget": {
      const url = safeUrl(record.private["connectLink"]);
      if (url) shown.url = url;
      shown.instructions = "Complete the connection in the provider's window.";
      return shown;
    }
    case "device-code": {
      const url = safeUrl(
        record.private["verificationUriComplete"] ??
          record.private["verificationUri"],
      );
      if (url) shown.url = url;
      const code = record.private["userCode"];
      if (code) shown.userCode = code;
      shown.instructions = "Open the link on another device and enter the code.";
      return shown;
    }
    case "private-collector": {
      const url = safeUrl(record.private["collectorUrl"]);
      if (url) shown.url = url;
      shown.instructions = "Enter the requested values in the private form.";
      return shown;
    }
    case "input-required":
      shown.instructions = "The provider needs more input to continue.";
      return shown;
  }
}

export const popupCompletionMessageType = "ceremony.connector.handoff.returned";

export type PopupCompletionMessage = {
  /** The message event's origin, as the browser reported it. */
  origin: string;
  /** The identity the opener assigned to the window it opened. */
  sourceWindowId: string;
  /** The handoff correlation the opener issued to that window. */
  correlation: string;
  type?: string;
};

export type PopupCompletionExpectation = {
  origin: string;
  sourceWindowId: string;
  correlation: string;
};

export type PopupCompletionDecision =
  | {
      accepted: true;
      /** The only permitted follow-up: reread server state; the message itself proves nothing. */
      next: "verify";
      correlation: string;
    }
  | {
      accepted: false;
      reason: "shape" | "type" | "origin" | "window" | "correlation";
    };

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(sha256Hex(left), "hex");
  const b = Buffer.from(sha256Hex(right), "hex");
  return timingSafeEqual(a, b) && left.length === right.length;
}

/**
 * The rule for a browser message that claims a popup finished. It is accepted
 * only from the exact expected origin, the exact window the opener created and
 * with the exact correlation issued to it; and acceptance means "ask the
 * server", never "connected". A window closing or a person pressing Done is
 * not a message at all and changes nothing (AC-AUTH-14, AC-AUTH-15).
 */
export function validatePopupCompletion(
  message: unknown,
  expected: PopupCompletionExpectation,
): PopupCompletionDecision {
  if (!message || typeof message !== "object")
    return { accepted: false, reason: "shape" };
  const candidate = message as Record<string, unknown>;
  const origin = candidate["origin"];
  const sourceWindowId = candidate["sourceWindowId"];
  const correlation = candidate["correlation"];
  const type = candidate["type"];
  if (
    typeof origin !== "string" ||
    typeof sourceWindowId !== "string" ||
    typeof correlation !== "string" ||
    origin.length > 2048 ||
    sourceWindowId.length === 0 ||
    sourceWindowId.length > 200 ||
    correlation.length === 0 ||
    correlation.length > 512
  )
    return { accepted: false, reason: "shape" };
  if (type !== undefined && type !== popupCompletionMessageType)
    return { accepted: false, reason: "type" };
  if (
    origin === "null" ||
    !URL.canParse(expected.origin) ||
    new URL(expected.origin).origin !== expected.origin ||
    origin !== expected.origin
  )
    return { accepted: false, reason: "origin" };
  if (!equalSecret(sourceWindowId, expected.sourceWindowId))
    return { accepted: false, reason: "window" };
  if (!equalSecret(correlation, expected.correlation))
    return { accepted: false, reason: "correlation" };
  return { accepted: true, next: "verify", correlation: expected.correlation };
}

/**
 * Shared fence for any completion of a handoff: it must belong to the calling
 * tenant, binding and connection, still be open, not be expired, and carry the
 * current generation. A callback for an older generation (after cancel,
 * unlink or reconnect) is refused rather than allowed to revive the
 * connection (AC-AUTH-07).
 */
export function assertHandoffCurrent(
  ctx: AdapterCallContext,
  handoff: HandoffRecord,
): "open" | "expired" {
  if (
    handoff.tenantId !== ctx.actor.tenantId ||
    handoff.bindingRef !== ctx.binding.bindingRef ||
    (ctx.connection !== undefined &&
      handoff.connectionRef !== ctx.connection.connectionRef)
  )
    throw new ConnectorError("denied", {
      detail: "oauth.handoff.foreign",
    });
  if (handoff.generation !== ctx.generation)
    throw new ConnectorError("conflict", {
      detail: "oauth.handoff.stale-generation",
    });
  if (handoff.state === "cancelled" || handoff.state === "superseded")
    throw new ConnectorError("cancelled", {
      detail: "oauth.handoff.cancelled",
    });
  if (handoff.state !== "issued" && handoff.state !== "waiting")
    throw new ConnectorError("conflict", {
      detail: "oauth.handoff.already-completed",
    });
  if (handoff.expiresAt <= ctx.environment.now()) return "expired";
  return "open";
}
