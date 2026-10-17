import type { HumanPresentation } from "../../../core/connectors/index.js";
import type { AuthorizationIntent } from "../adapter.js";
import { DROPPED_CREDENTIALS_STATE } from "../dropped-credentials.js";
import { ConnectorError } from "../errors.js";
import type { ConnectionRecord } from "../ports.js";
import { intentInputSchema, type IntentInput } from "./inputs.js";

/*
 * Reading and writing the parts of a connection record the command layer
 * decides about: which handoff it is waiting on, whether it is closed, the
 * intent it was started with, what a person may be shown of a handoff, and the
 * bounded adapter state.
 */

const dottedCode = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){0,11}$/;
export const code = (value: string | undefined, fallback: string) =>
  value && value.length <= 120 && dottedCode.test(value) ? value : fallback;
/**
 * The handoff this connection is actually waiting on. A handoff issued for an
 * earlier generation was superseded when the generation advanced, so it is
 * neither pending nor projected — it cannot be completed, presented or
 * cancelled as if it still belonged here.
 */
export const pending = (record: ConnectionRecord) =>
  record.handoff &&
  record.handoff.generation === record.generation &&
  (record.handoff.state === "issued" || record.handoff.state === "waiting")
    ? record.handoff
    : undefined;
export const currentHandoff = (record: ConnectionRecord) =>
  record.handoff && record.handoff.generation === record.generation
    ? record.handoff
    : undefined;
export const closed = (record: ConnectionRecord) =>
  record.lifecycle === "locally-disconnected" ||
  record.lifecycle === "upstream-revoked";
export const deleted = (record: ConnectionRecord) =>
  record.state.deleted === true;

export function presentationOf(
  material: Readonly<Record<string, string>>,
): HumanPresentation | undefined {
  const shown: HumanPresentation = {};
  // The OAuth grants in `connectors/auth` keep the page to open under their
  // own names (an authorization URL, a device verification URI); those are
  // the same one thing a person may see, never the state or codes beside them.
  const url =
    material.url ??
    material.authorizationUrl ??
    material.verificationUriComplete ??
    material.verificationUri;
  if (url !== undefined) shown.url = url;
  if (material.userCode !== undefined) shown.userCode = material.userCode;
  if (material.instructions !== undefined)
    shown.instructions = material.instructions;
  return Object.keys(shown).length ? shown : undefined;
}

export function intentOf(record: ConnectionRecord): IntentInput {
  const parsed = intentInputSchema.safeParse(record.state.intent);
  return parsed.success
    ? parsed.data
    : {
        requestedPermissions: [],
        accountSwitch: false,
        interruption: "allowed",
      };
}

export function toAdapterIntent(
  intent: IntentInput,
  ownerKind: ConnectionRecord["ownerKind"],
  profileId: string | undefined,
): AuthorizationIntent {
  return {
    ...(profileId ? { profileId } : {}),
    ownerKind,
    requestedPermissions: [...intent.requestedPermissions],
    ...(intent.target ? { target: intent.target } : {}),
    accountSwitch: intent.accountSwitch,
    interruption: intent.interruption,
  };
}

export function boundedState(
  current: Record<string, unknown>,
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(extra ?? {}))
    if (
      /^[^\p{Cc}]{1,120}$/u.test(key) &&
      ![
        "__proto__",
        "prototype",
        "constructor",
        "intent",
        "deleted",
        DROPPED_CREDENTIALS_STATE,
      ].includes(key)
    )
      merged[key] = value;
  if (
    Object.keys(merged).length > 64 ||
    Buffer.byteLength(JSON.stringify(merged)) > 65536
  )
    throw new ConnectorError("invalid-request", { detail: "state.bounds" });
  return merged;
}
