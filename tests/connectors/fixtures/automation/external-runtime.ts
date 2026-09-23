import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import type { ConnectionRecord } from "../../../../src/server/connectors/ports.js";
import {
  runtimeBindingSchema,
  type RuntimeBinding,
} from "../../../../src/server/connectors/binding.js";
import {
  EXTERNAL_RUNTIME_PROTOCOL,
  SIGNATURE_HEADER,
  SIGNATURE_KEY_ID_HEADER,
  SIGNATURE_TIMESTAMP_HEADER,
  SIGNING_KEY_ID_FIELD,
  SIGNING_SECRET_FIELD,
  verifyExternalRuntimeSignature,
} from "../../../../src/server/connectors/formats/automation/external-runtime.js";
import { memoryPorts, fixtureActor } from "../../doubles/ports.js";

/*
 * An isolated runtime that stands in for whatever actually executes an
 * imported automation operation. It listens on loopback, verifies the request
 * signature with the same helper the adapter uses, and answers the documented
 * reply contract. It never loads a Zapier app, an n8n node or a Workato
 * connector: it is a stub for a service that would, and the point of the test
 * is that Ceremony talks to it correctly, not that it runs anything.
 */

export const RUNTIME_SECRET = "fixture-external-runtime-secret-é-01";
export const RUNTIME_KEY_ID = "fixture-key-1";
export const RUNTIME_PATH = "/runtime/v1/invoke";

export type RuntimeCall = {
  body: unknown;
  signatureValid: boolean;
  keyId: string | undefined;
  headers: Record<string, string>;
};

export type RuntimeReply =
  { kind: "reply"; status?: number; body: unknown } | { kind: "drop" };

export type RuntimeBehaviour = (
  call: RuntimeCall,
  index: number,
) => RuntimeReply | Promise<RuntimeReply>;

/** Starts the fixture runtime; `calls` records exactly what it received. */
export async function startExternalRuntime(
  options: {
    behaviour?: RuntimeBehaviour;
    secret?: string;
    toleranceMs?: number;
    now?: () => number;
  } = {},
) {
  const calls: RuntimeCall[] = [];
  const secret = options.secret ?? RUNTIME_SECRET;
  const now = options.now ?? Date.now;
  const behaviour: RuntimeBehaviour =
    options.behaviour ??
    (() => ({
      kind: "reply",
      body: {
        protocol: EXTERNAL_RUNTIME_PROTOCOL,
        status: "completed",
        output: { id: "inv_101", status: "draft", total_cents: 4200 },
      },
    }));

  const server = createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf8");
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers))
        if (typeof value === "string") headers[name] = value;
      const timestamp = Number(headers[SIGNATURE_TIMESTAMP_HEADER]);
      const signature = headers[SIGNATURE_HEADER] ?? "";
      const call: RuntimeCall = {
        body: (() => {
          try {
            return JSON.parse(raw) as unknown;
          } catch {
            return undefined;
          }
        })(),
        signatureValid: verifyExternalRuntimeSignature({
          secret,
          timestamp,
          body: raw,
          signature,
          now: now(),
          toleranceMs: options.toleranceMs ?? 300_000,
        }),
        keyId: headers[SIGNATURE_KEY_ID_HEADER],
        headers,
      };
      const index = calls.length;
      calls.push(call);
      if (request.url !== RUNTIME_PATH) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      if (!call.signatureValid) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "bad_signature" }));
        return;
      }
      const decided = await behaviour(call, index);
      if (decided.kind === "drop") {
        request.socket.destroy();
        return;
      }
      response.writeHead(decided.status ?? 200, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify(decided.body));
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    calls,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export const AT = "2026-09-18T00:00:00.000Z";

/** A runtime binding whose single operation is delegated to the fixture runtime. */
export function delegatedBinding(input: {
  origin: string;
  operationRef: string;
  nativeId: string;
  effect: "read" | "write" | "unknown";
  replay?: "read-only" | "upstream-idempotency-key" | "reconciliation" | "none";
  consent?: "none" | "confirm";
  outputClassification?: "public" | "personal" | "secret";
  bindingRef?: string;
  definitionRef?: string;
  adapterId?: string;
}): RuntimeBinding {
  return runtimeBindingSchema.parse({
    bindingRef: input.bindingRef ?? "binding:automation",
    definitionRef: input.definitionRef ?? "definition:automation",
    revision: 1,
    adapterId: input.adapterId ?? "external-runtime",
    adapterVersion: "1.0.0",
    runtime: "hosted-server",
    custody: "external-execution-broker",
    authorityInstance: "https://runtime.example",
    status: "approved",
    approvedAt: AT,
    policyRevision: "policy:1",
    tenantId: fixtureActor.tenantId,
    destinations: [
      { id: "runtime", origin: input.origin, network: "loopback-fixture" },
    ],
    operations: [
      {
        operationRef: input.operationRef,
        nativeId: input.nativeId,
        destinationId: "runtime",
        transport: { kind: "delegated", route: input.nativeId },
        effect: input.effect,
        outputClassification: input.outputClassification ?? "personal",
        cost: "unknown",
        consent:
          input.consent ?? (input.effect === "write" ? "confirm" : "none"),
        replay:
          input.replay ?? (input.effect === "read" ? "read-only" : "none"),
        targetParameters: [],
      },
    ],
    configuration: [],
    permittedTargets: [],
    reviewedDigest: "a".repeat(64),
    settings: {},
  });
}

/** A connection that owns the signing secret, stored through credential custody. */
export async function connectionWithSecret(
  ports: ReturnType<typeof memoryPorts>,
  input: {
    binding: RuntimeBinding;
    ecosystem: string;
    service: string;
    authorityInstance?: string;
    externalIds?: Record<string, string>;
    secret?: string;
  },
): Promise<ConnectionRecord> {
  const connectionRef = `connection:${randomUUID()}`;
  const credentialRef = await ports.credentials.store(
    {
      tenantId: fixtureActor.tenantId,
      ownerKind: "user",
      ownerId: fixtureActor.subjectId,
      connectionRef,
      bindingRef: input.binding.bindingRef,
      custody: "external-execution-broker",
    },
    {
      [SIGNING_SECRET_FIELD]: input.secret ?? RUNTIME_SECRET,
      [SIGNING_KEY_ID_FIELD]: RUNTIME_KEY_ID,
    },
  );
  return {
    connectionRef,
    bindingRef: input.binding.bindingRef,
    definitionRef: input.binding.definitionRef,
    ecosystem: input.ecosystem,
    service: input.service,
    displayName: input.service,
    ownerKind: "user",
    custody: "external-execution-broker",
    runtime: "hosted-server",
    lifecycle: "active",
    generation: 0,
    revision: 1,
    createdAt: AT,
    updatedAt: AT,
    tenantId: fixtureActor.tenantId,
    ownerId: fixtureActor.subjectId,
    authorityInstance: input.authorityInstance ?? "https://runtime.example",
    bindingRevision: 1,
    policyRevision: "policy:1",
    configurationRevision: "cfg:1",
    credentialRef,
    externalIds: input.externalIds ?? {},
    evidenceRefs: [],
    state: {},
  };
}
