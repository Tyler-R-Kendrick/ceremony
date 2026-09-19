import type { ConfigurationRequirement } from "../../adapter.js";
import { ConnectorError } from "../../errors.js";

/*
 * Shared constants of the Airbyte adapter. Two very different documents meet
 * here and are deliberately kept apart everywhere else in this directory:
 *
 * - the Airbyte *protocol* (`protocol.ts`): the JSON messages a connector
 *   emits (SPEC, CATALOG, CONNECTION_STATUS, RECORD, STATE, TRACE, LOG) and the
 *   catalog documents built from them;
 * - the Airbyte *API* (`api.ts`): the REST surface of a deployed platform
 *   (sources, connections, streams, jobs) used to delegate work to it.
 *
 * A stream name in a catalog and a `streamName` in an API response describe
 * the same thing, but they arrive through different contracts with different
 * spellings, and the adapter never lets one masquerade as the other.
 */

export const airbyteConfigurationNames = {
  /** Base URL of the deployment's public API, e.g. https://api.airbyte.com/v1 or https://host/api/public/v1. */
  apiUrl: "AIRBYTE_API_URL",
  /** Bearer access token for that API (an application access token or a long-lived deployment token). */
  apiKey: "AIRBYTE_API_KEY",
  /** Optional application credentials; when both are present the adapter mints and rotates short-lived tokens itself. */
  clientId: "AIRBYTE_CLIENT_ID",
  clientSecret: "AIRBYTE_CLIENT_SECRET",
} as const;

export const airbyteDestinationIds = { api: "api" } as const;

/** Target kinds a connection may be permitted to touch; ids are the native UUIDs. */
export const airbyteTargetKinds = {
  connection: "airbyte-connection",
  source: "airbyte-source",
} as const;

export const airbyteAuthenticationProfileId = "airbyte-api";

export const airbyteConfigurationRequirements: readonly ConfigurationRequirement[] =
  [
    {
      name: airbyteConfigurationNames.apiUrl,
      source: "host",
      classification: "public",
      required: true,
      description:
        "Public API base URL of an existing Airbyte deployment; its exact origin must match the approved `api` destination.",
    },
    {
      name: airbyteConfigurationNames.apiKey,
      source: "host",
      classification: "secret",
      required: true,
      description: "Bearer access token accepted by that deployment's API.",
    },
    {
      name: airbyteConfigurationNames.clientId,
      source: "host",
      classification: "secret",
      required: false,
      description:
        "Application client id; with the client secret, the adapter obtains short-lived access tokens from POST /applications/token.",
    },
    {
      name: airbyteConfigurationNames.clientSecret,
      source: "host",
      classification: "secret",
      required: false,
      description: "Application client secret paired with the client id.",
    },
  ];

const reservedKeys = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Walks a parsed JSON value and refuses reserved object keys, foreign
 * prototypes, excessive depth and excessive size before anything reads it.
 * The detail code is the whole public story; the value is never echoed.
 */
export function assertPlainJson(
  value: unknown,
  detail: string,
  limits: { depth?: number; nodes?: number } = {},
): void {
  const maxDepth = limits.depth ?? 64;
  const maxNodes = limits.nodes ?? 250_000;
  let nodes = 0;
  const visit = (node: unknown, depth: number): void => {
    if (++nodes > maxNodes || depth > maxDepth)
      throw new ConnectorError("invalid-request", { detail });
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (node && typeof node === "object") {
      const prototype = Object.getPrototypeOf(node);
      if (prototype !== Object.prototype && prototype !== null)
        throw new ConnectorError("invalid-request", { detail });
      for (const key of Object.keys(node)) {
        if (reservedKeys.has(key))
          throw new ConnectorError("invalid-request", { detail });
        visit((node as Record<string, unknown>)[key], depth + 1);
      }
    }
  };
  visit(value, 0);
}

/** Bounded JSON parsing for uploads and upstream bodies; a parse failure never echoes the text. */
export function parseBoundedJson(
  text: string,
  detail: string,
  maxBytes: number,
): unknown {
  if (new TextEncoder().encode(text).byteLength > maxBytes)
    throw new ConnectorError("invalid-request", { detail });
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ConnectorError("invalid-request", { detail });
  }
  assertPlainJson(value, detail);
  return value;
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>))
      deepFreeze(item);
  }
  return value;
}
