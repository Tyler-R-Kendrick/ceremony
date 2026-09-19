import { z } from "zod";
import { AuthorizationError } from "../identity.js";
import { PersistenceConflict } from "../persistence/index.js";

/**
 * Failure codes shared by every connector adapter and command. A code is the
 * whole public story of a failure: provider bodies, exception messages and
 * stack traces stay inside trusted server code, because upstream responses can
 * carry credentials, personal data or attacker-written descriptions.
 */
export const connectorErrorCodes = [
  "unauthenticated",
  "denied",
  "invalid-request",
  "not-found",
  "conflict",
  "configuration-required",
  "human-required",
  "unsupported",
  "network-policy",
  "upstream-unavailable",
  "upstream-rejected",
  "indeterminate",
  "rate-limited",
  "expired",
  "cancelled",
] as const;
export type ConnectorErrorCode = (typeof connectorErrorCodes)[number];

const statuses: Record<ConnectorErrorCode, number> = {
  unauthenticated: 401,
  denied: 403,
  "invalid-request": 400,
  "not-found": 404,
  conflict: 409,
  "configuration-required": 409,
  "human-required": 409,
  unsupported: 501,
  "network-policy": 403,
  "upstream-unavailable": 503,
  "upstream-rejected": 502,
  indeterminate: 409,
  "rate-limited": 429,
  expired: 410,
  cancelled: 409,
};

const messages: Record<ConnectorErrorCode, string> = {
  unauthenticated: "Sign in to the application first.",
  denied: "This action is not permitted for the current session.",
  "invalid-request": "The request is not valid for this connector.",
  "not-found": "The requested connector record was not found.",
  conflict: "The record changed. Read it again before retrying.",
  "configuration-required":
    "Required configuration is missing. Complete setup before connecting.",
  "human-required": "A person must complete this step.",
  unsupported: "This capability is not supported by the selected connector.",
  "network-policy": "The destination is not permitted by network policy.",
  "upstream-unavailable": "The provider could not be reached. Try again later.",
  "upstream-rejected": "The provider rejected this request.",
  indeterminate:
    "The outcome of an external effect is uncertain and needs reconciliation.",
  "rate-limited": "Too many attempts. Wait before retrying.",
  expired: "This attempt has expired. Start again.",
  cancelled: "This attempt was cancelled.",
};

export class ConnectorError extends Error {
  readonly status: number;
  /** A bounded, non-secret refinement such as "openapi.security.unsupported-scheme". */
  readonly detail: string | undefined;
  constructor(
    readonly code: ConnectorErrorCode,
    options: { detail?: string; cause?: unknown } = {},
  ) {
    super(messages[code], options.cause ? { cause: options.cause } : {});
    this.name = "ConnectorError";
    this.status = statuses[code];
    this.detail = options.detail
      ? z
          .string()
          .max(120)
          .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){0,11}$/)
          .parse(options.detail)
      : undefined;
  }
}

/** Public explanation of any failure; never the upstream text. */
export function explainConnectorError(error: unknown): {
  code: ConnectorErrorCode;
  status: number;
  message: string;
  detail?: string;
} {
  if (error instanceof ConnectorError)
    return {
      code: error.code,
      status: error.status,
      message: error.message,
      ...(error.detail ? { detail: error.detail } : {}),
    };
  if (error instanceof AuthorizationError) {
    const code = (
      {
        unauthenticated: "unauthenticated",
        denied: "denied",
        invalid_request: "invalid-request",
        rate_limited: "rate-limited",
      } as const
    )[error.code];
    return { code, status: statuses[code], message: messages[code] };
  }
  if (error instanceof PersistenceConflict)
    return { code: "conflict", status: 409, message: messages.conflict };
  if (error instanceof z.ZodError)
    return {
      code: "invalid-request",
      status: 400,
      message: messages["invalid-request"],
    };
  if (error instanceof DOMException && error.name === "AbortError")
    return { code: "cancelled", status: 409, message: messages.cancelled };
  return {
    code: "upstream-unavailable",
    status: 503,
    message: messages["upstream-unavailable"],
  };
}
