import type { ActorContext } from "../../../src/core/operation-contracts.js";
import { runtimeBindingSchema } from "../../../src/server/connectors/binding.js";
import type { RuntimeBinding } from "../../../src/server/connectors/binding.js";
import type {
  AdapterCallContext,
  ConnectionRecord,
} from "../../../src/server/connectors/index.js";
import {
  AUTH0_EXCHANGE_ACTION,
  AUTH0_INVENTORY_ACTION,
  auth0Profiles,
  type Auth0SubjectTokenType,
  type HeldToken,
  type HostIdentityTokenPort,
  type HostSubjectToken,
} from "../../../src/server/connectors/providers/auth0/index.js";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import { AT, HEX } from "../fixtures/builders.js";

/*
 * Scaffolding for the Auth0 Token Vault adapter tests: a binding pinned to the
 * fixture tenant, a host identity port that hands out tokens through a
 * use-callback, and a call context over the in-memory ports.
 */

export const CLIENT_ID = "client_auth0_fixture";
export const CLIENT_SECRET = "secret_auth0_fixture";
export const CONNECTION = "google-oauth2";
export const SUBJECT = "auth0|user-primary";
export const OTHER_SUBJECT = "auth0|user-secondary";
export const API_AUDIENCE = "https://my-api.example.com";

/** Records every lookup, so a test can prove the adapter asked the host. */
export function identityPort(input: {
  subject?: HostSubjectToken;
  myAccount?: HeldToken;
}): HostIdentityTokenPort & { calls: string[] } {
  const calls: string[] = [];
  const port: HostIdentityTokenPort & { calls: string[] } = {
    calls,
    async subjectToken(lookup) {
      calls.push(`subject:${lookup.ownerKind}:${lookup.ownerId}`);
      return input.subject;
    },
    async myAccountToken(lookup) {
      calls.push(`my-account:${lookup.ownerKind}:${lookup.ownerId}`);
      return input.myAccount;
    },
  };
  return port;
}

/** A held token whose value is only reachable inside `use`. */
export function heldToken(value: string, expiresAt?: number): HeldToken {
  return {
    async use(work) {
      return work(value);
    },
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

export function subjectToken(input: {
  value: string;
  tokenType: Auth0SubjectTokenType;
  subject: string;
  audience?: string;
  expiresAt?: number;
}): HostSubjectToken {
  return {
    ...heldToken(input.value, input.expiresAt),
    tokenType: input.tokenType,
    subject: input.subject,
    ...(input.audience === undefined ? {} : { audience: input.audience }),
  };
}

export function tokenVaultBinding(
  origin: string,
  overrides: Partial<RuntimeBinding> = {},
): RuntimeBinding {
  return runtimeBindingSchema.parse({
    bindingRef: "binding:auth0-token-vault",
    definitionRef: "definition:auth0-token-vault",
    revision: 4,
    adapterId: "auth0-token-vault",
    adapterVersion: "2026.09.18",
    runtime: "hosted-server",
    custody: "external-credential-broker",
    authorityInstance: `${origin}/`,
    status: "approved",
    approvedAt: AT,
    policyRevision: "policy:auth0:1",
    tenantId: fixtureActor.tenantId,
    profileId: auth0Profiles.tokenVault,
    destinations: [{ id: "tenant", origin, network: "loopback-fixture" }],
    operations: [
      {
        operationRef: "operation:auth0.exchange",
        nativeId: "token-vault.exchange",
        destinationId: "tenant",
        transport: { kind: "broker-action", action: AUTH0_EXCHANGE_ACTION },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
      {
        operationRef: "operation:auth0.accounts",
        nativeId: "token-vault.accounts",
        destinationId: "tenant",
        transport: { kind: "broker-action", action: AUTH0_INVENTORY_ACTION },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
    ],
    configuration: ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET"],
    permittedTargets: [],
    reviewedDigest: HEX,
    settings: {
      connection: CONNECTION,
      connectScopes: ["openid", "profile", "offline_access"],
    },
    ...overrides,
  });
}

export function connectionRecord(
  binding: RuntimeBinding,
  overrides: Partial<ConnectionRecord> = {},
): ConnectionRecord {
  return {
    connectionRef: "connection:auth0-1",
    bindingRef: binding.bindingRef,
    definitionRef: binding.definitionRef,
    ecosystem: "auth0",
    service: "auth0-token-vault",
    displayName: "Auth0 Token Vault (Google)",
    ownerKind: "user",
    custody: binding.custody,
    runtime: "hosted-server",
    lifecycle: "active",
    generation: 1,
    revision: 1,
    createdAt: AT,
    updatedAt: AT,
    tenantId: binding.tenantId,
    ownerId: fixtureActor.subjectId,
    authorityInstance: binding.authorityInstance,
    bindingRevision: binding.revision,
    policyRevision: binding.policyRevision,
    configurationRevision: "cfg:1",
    externalIds: {},
    evidenceRefs: [],
    state: {},
    ...overrides,
  };
}

export function harness(input: {
  binding: RuntimeBinding;
  domain: string;
  configuration?: Record<string, string | undefined>;
  now?: () => number;
}) {
  const ports = memoryPorts(input.now ? { now: input.now } : {});
  const configuration = input.configuration ?? {
    AUTH0_DOMAIN: input.domain,
    AUTH0_CLIENT_ID: CLIENT_ID,
    AUTH0_CLIENT_SECRET: CLIENT_SECRET,
  };
  for (const [name, value] of Object.entries(configuration))
    ports.configuration.set(name, value);
  return {
    ports,
    context(
      overrides: {
        binding?: RuntimeBinding;
        connection?: ConnectionRecord;
        actor?: ActorContext;
        generation?: number;
        handoff?: AdapterCallContext["handoff"];
      } = {},
    ): AdapterCallContext {
      return {
        actor: overrides.actor ?? fixtureActor,
        binding: overrides.binding ?? input.binding,
        ...(overrides.connection ? { connection: overrides.connection } : {}),
        ...(overrides.handoff ? { handoff: overrides.handoff } : {}),
        generation:
          overrides.generation ?? overrides.connection?.generation ?? 1,
        signal: AbortSignal.timeout(60_000),
        environment: ports.environment({ fetch: globalThis.fetch }),
      };
    },
  };
}
