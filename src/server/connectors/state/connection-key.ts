import { canonicalJson, compact, sha256Hex } from "./common.js";
import type { ConnectionRecord } from "../ports.js";

/*
 * The digest that names what a connection is a connection to (the charter
 * §6.4 tuple): two records with the same digest speak for the same account,
 * through the same binding, under the same policy and configuration.
 */

/** The charter §6.4 tuple; unknown parts are omitted, never guessed. */
export type ConnectionKeyParts = {
  tenantId: string;
  ownerKind: string;
  ownerId: string;
  sessionId?: string;
  authorityInstance: string;
  upstreamAccount?: Record<string, string>;
  clientRegistration?: string;
  authenticationProfile?: string;
  target?: { kind: string; id: string };
  bindingRef: string;
  bindingRevision: number;
  policyRevision: string;
  configurationRevision: string;
};

export function connectionKeyDigest(parts: ConnectionKeyParts): string {
  return sha256Hex(JSON.parse(canonicalJson(compact(parts))));
}

export function keyDigestOf(record: ConnectionRecord): string {
  return connectionKeyDigest(
    compact({
      tenantId: record.tenantId,
      ownerKind: record.ownerKind,
      ownerId: record.ownerId,
      sessionId: record.sessionId,
      authorityInstance: record.authorityInstance,
      upstreamAccount: record.externalIds,
      authenticationProfile:
        typeof record.state.authenticationProfile === "string"
          ? record.state.authenticationProfile
          : undefined,
      clientRegistration:
        typeof record.state.clientRegistration === "string"
          ? record.state.clientRegistration
          : undefined,
      target: record.target,
      bindingRef: record.bindingRef,
      bindingRevision: record.bindingRevision,
      policyRevision: record.policyRevision,
      configurationRevision: record.configurationRevision,
    }),
  );
}
