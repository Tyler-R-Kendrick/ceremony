import type { RecordKey } from "../../persistence/index.js";
import { paddedRevision, sha256Hex } from "./common.js";

/*
 * Every key the state layer uses, in one place. Ids are digests of references
 * or UUID-derived references; native identifiers (broker connection ids,
 * project refs, account logins) are digested here and stored, with their
 * exact spelling, inside the encrypted value they index.
 */

export const connectionKey = (tenant: string, connectionRef: string): RecordKey => ({
  tenant,
  kind: "connector-connection",
  id: `connection:${sha256Hex(connectionRef)}`,
});

export const externalIdKey = (
  tenant: string,
  authorityInstance: string,
  name: string,
  value: string,
): RecordKey => ({
  tenant,
  kind: "connector-connection-index",
  id: `external:${sha256Hex(authorityInstance, name, value)}`,
});

export const sharedIdPrefix = (
  authorityInstance: string,
  name: string,
  value: string,
): string => `shared:${sha256Hex(authorityInstance, name, value)}:`;

export const sharedIdKey = (
  tenant: string,
  authorityInstance: string,
  name: string,
  value: string,
  connectionRef: string,
): RecordKey => ({
  tenant,
  kind: "connector-connection-index",
  id: `${sharedIdPrefix(authorityInstance, name, value)}${sha256Hex(connectionRef)}`,
});

export const credentialKey = (tenant: string, ref: string): RecordKey => ({
  tenant,
  kind: "connector-credential",
  id: ref,
});

export const handoffKey = (tenant: string, handoffRef: string): RecordKey => ({
  tenant,
  kind: "connector-handoff",
  id: handoffRef,
});

export const correlationKey = (
  tenant: string,
  correlation: string,
): RecordKey => ({
  tenant,
  kind: "connector-handoff",
  id: `correlation:${sha256Hex(correlation)}`,
});

export const handoffPointerPrefix = (connectionRef: string): string =>
  `connection:${sha256Hex(connectionRef)}:`;

export const handoffPointerKey = (
  tenant: string,
  connectionRef: string,
  handoffRef: string,
): RecordKey => ({
  tenant,
  kind: "connector-handoff",
  id: `${handoffPointerPrefix(connectionRef)}${sha256Hex(handoffRef)}`,
});

export const effectKey = (tenant: string, effectRef: string): RecordKey => ({
  tenant,
  kind: "connector-effect",
  id: effectRef,
});

export const intentKey = (
  tenant: string,
  operation: string,
  digest: string,
): RecordKey => ({
  tenant,
  kind: "connector-effect",
  id: `intent:${sha256Hex(operation, digest)}`,
});

export const evidencePrefix = (connectionRef: string): string =>
  `evidence:${sha256Hex(connectionRef)}:`;

export const evidenceKey = (
  tenant: string,
  connectionRef: string,
  evidenceRef: string,
): RecordKey => ({
  tenant,
  kind: "connector-evidence",
  id: `${evidencePrefix(connectionRef)}${sha256Hex(evidenceRef)}`,
});

export const artifactKey = (tenant: string, digest: string): RecordKey => ({
  tenant,
  kind: "connector-artifact",
  id: `artifact:${digest}`,
});

export const sourceKey = (tenant: string, sourceRef: string): RecordKey => ({
  tenant,
  kind: "connector-source",
  id: `source:${sha256Hex(sourceRef)}`,
});

export const definitionKey = (
  tenant: string,
  definitionRef: string,
): RecordKey => ({
  tenant,
  kind: "connector-definition",
  id: `definition:${sha256Hex(definitionRef)}`,
});

export const bindingKey = (
  tenant: string,
  bindingRef: string,
  revision: number,
): RecordKey => ({
  tenant,
  kind: "connector-binding",
  id: `binding:${sha256Hex(bindingRef)}:${paddedRevision(revision)}`,
});

export const bindingHeadKey = (tenant: string, bindingRef: string): RecordKey => ({
  tenant,
  kind: "connector-binding",
  id: `head:${sha256Hex(bindingRef)}`,
});

export const budgetKey = (
  tenant: string,
  authorityInstance: string,
): RecordKey => ({
  tenant,
  kind: "connector-budget",
  id: `authority:${sha256Hex(authorityInstance)}`,
});

export const supportKey = (
  tenant: string,
  adapterId: string,
  adapterVersion: string,
): RecordKey => ({
  tenant,
  kind: "connector-support",
  id: `adapter:${sha256Hex(adapterId, adapterVersion)}`,
});
