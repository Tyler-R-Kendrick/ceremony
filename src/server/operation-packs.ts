import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ActorContext } from "../core/operation-contracts.js";
import {
  OPERATION_PACK_LIMITS,
  isLoopbackPackDestination,
  operationPackEnvelopeSchema,
  operationPackSigningPayload,
  packOperationId,
  type OperationPackManifest,
  type PackOperation,
} from "../core/operation-packs.js";
import type { diagnosticCodeSchema } from "../core/teaching-contracts.js";
import type { PublicBindingPolicy } from "../core/projections.js";
import type { AsyncCeremonyStore } from "./persistence/index.js";
import { publicAuthFetch } from "./public-auth-fetch.js";
import { readOAuthClient } from "./recipes/common.js";
import {
  NEUTRAL_PROVIDER,
  OperationRegistry,
  type OperationContext,
  type OperationResponseFacts,
  type OperationResult,
  type RegisteredOperation,
  type VocabularyEntry,
} from "./recipes/registry.js";
import { runInSandbox, type SandboxReply } from "./operation-pack-sandbox.js";

/*
 * Loading and running operation packs (see docs/operation-packs.md).
 *
 * Before creating its runtime the host awaits `prepareOperationPacks`, which
 * reads each pack in the configured directory, verifies the publisher's
 * Ed25519 signature over the manifest and the bundle digest the manifest
 * carries, and evaluates the bundle once in the sandbox to check that it
 * defines every operation the manifest declares. `registerOperationPacks`
 * then checks every operation against the host's own vocabulary and
 * registers it as `pack:<id>/<name>`; it accepts only a prepared set, so no
 * pack reaches a registry unchecked. A pack that fails any check registers
 * nothing and is reported with a fixed reason. Nothing is fetched: a pack is
 * whatever bytes the host put in the directory.
 *
 * At run time a pack operation is an ordinary registered operation, so the
 * command service admits, authorizes and records it exactly as it does a
 * built-in. Only the handler differs: it runs in the sandbox, sees the
 * operation's public inputs and nothing else, and reaches the network only
 * through `ceremony.fetch`, which this module serves. That capability sends
 * only to origins the signed manifest declares, through the host's egress
 * transport, with only GET and HEAD for a read, and injects declared
 * credentials into the outgoing request so their values never enter the
 * sandbox.
 */

export type TrustedPackPublisher = {
  keyId: string;
  /** Ed25519 public key, as PEM (SPKI) text or a KeyObject. */
  publicKey: string | KeyObject;
  /** ISO 8601 instants bounding when packs signed by this key load and run. */
  notBefore?: string;
  notAfter?: string;
  /** Pack ids this key may publish. Absent means any. */
  packs?: readonly string[];
};

/** What the host's secret resolver is asked for; it answers with the value or nothing. */
export type PackSecretRequest = {
  actor: ActorContext;
  runId: string;
  pack: string;
  operationId: string;
  name: string;
};

export interface OperationPackOptions {
  /** Directory holding one subdirectory per pack: `pack.json` and `handler.js`. */
  directory: string;
  /** The only keys whose packs load. */
  publishers: readonly TrustedPackPublisher[];
  /** Key ids withdrawn after issue; their packs never load or run. */
  revokedKeys?: readonly string[];
  /** Egress transport. Defaults to the server's public-only, no-redirect fetch. */
  fetch?: typeof fetch;
  /** Admit `http://` loopback destinations, for local fixtures only. */
  loopbackFixtures?: boolean;
  /** Host veto over a declared destination, consulted at load. */
  allowDestination?(pack: string, origin: string): boolean;
  /** Resolves `host` credentials; without it an operation that declares one does not load. */
  secrets?(request: PackSecretRequest): Promise<string | undefined>;
  /** Resolves `oauth-client` credentials; without it an operation that declares one does not load. */
  store?: AsyncCeremonyStore;
  now?: () => number;
}

export type OperationPackRefusalReason =
  | "invalid-layout"
  | "invalid-manifest"
  | "unknown-publisher"
  | "publisher-revoked"
  | "publisher-expired"
  | "publisher-not-yet-valid"
  | "publisher-not-allowed"
  | "bad-signature"
  | "bundle-digest-mismatch"
  | "unknown-vocabulary"
  | "provider-mismatch"
  | "forbidden-classification"
  | "destination-refused"
  | "credential-unavailable"
  | "duplicate-operation"
  | "missing-export";

/** Fixed wording per reason: a refusal never quotes the pack's own text. */
export const operationPackRefusals: Record<OperationPackRefusalReason, string> =
  {
    "invalid-layout":
      "The entry is not a directory holding a regular pack.json and handler.js within the size limits.",
    "invalid-manifest":
      "pack.json is not a valid operation pack envelope, or the signature names a different key than the manifest.",
    "unknown-publisher":
      "The manifest's publisher key is not in the host's trusted publishers.",
    "publisher-revoked": "The publisher key is revoked.",
    "publisher-expired": "The publisher key's validity has ended.",
    "publisher-not-yet-valid": "The publisher key is not valid yet.",
    "publisher-not-allowed":
      "The publisher key is not trusted for this pack id.",
    "bad-signature":
      "The signature does not verify over the manifest under the publisher key.",
    "bundle-digest-mismatch":
      "handler.js does not match the size and SHA-256 the signed manifest names.",
    "unknown-vocabulary":
      "An operation reads or writes a contract the host's vocabulary does not have.",
    "provider-mismatch":
      "An operation uses vocabulary that belongs to a different provider than its scope.",
    "forbidden-classification":
      "An operation reads a non-public value other than a credential handle, or writes a non-public value.",
    "destination-refused":
      "The host does not admit a destination the operation declares.",
    "credential-unavailable":
      "An operation declares a credential this host has no resolver for, or names an input of the wrong contract.",
    "duplicate-operation":
      "An operation id and version is already registered, or the pack was already loaded.",
    "missing-export":
      "handler.js does not evaluate in the sandbox, or does not define run (and verify, where declared) for every operation the manifest declares.",
  };

export type OperationPackRefusal = {
  /** The directory entry's name. */
  entry: string;
  reason: OperationPackRefusalReason;
  message: string;
};
export type OperationPackReport = {
  loaded: Array<{
    pack: string;
    version: string;
    publisher: string;
    operations: Array<{ id: string; version: string }>;
  }>;
  refused: OperationPackRefusal[];
};

class Refusal extends Error {
  constructor(readonly reason: OperationPackRefusalReason) {
    super(reason);
  }
}

type Publisher = {
  keyId: string;
  key: KeyObject;
  notBefore?: number;
  notAfter?: number;
  packs?: ReadonlySet<string>;
};
function trustedPublishers(
  publishers: readonly TrustedPackPublisher[],
): Map<string, Publisher> {
  const trusted = new Map<string, Publisher>();
  for (const publisher of publishers) {
    // Host configuration, not pack data: a malformed entry stops startup.
    const key =
      typeof publisher.publicKey === "string"
        ? createPublicKey(publisher.publicKey)
        : publisher.publicKey;
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519")
      throw new Error(`Publisher ${publisher.keyId} is not an Ed25519 key`);
    if (trusted.has(publisher.keyId))
      throw new Error(`Publisher ${publisher.keyId} is listed twice`);
    const instant = (value: string | undefined) => {
      if (value === undefined) return undefined;
      const parsed = Date.parse(value);
      if (Number.isNaN(parsed))
        throw new Error(`Publisher ${publisher.keyId} has an invalid date`);
      return parsed;
    };
    const notBefore = instant(publisher.notBefore);
    const notAfter = instant(publisher.notAfter);
    trusted.set(publisher.keyId, {
      keyId: publisher.keyId,
      key,
      ...(notBefore !== undefined ? { notBefore } : {}),
      ...(notAfter !== undefined ? { notAfter } : {}),
      ...(publisher.packs ? { packs: new Set(publisher.packs) } : {}),
    });
  }
  return trusted;
}

/** Whether a key may vouch for anything at this instant, or why not. */
function keyStanding(
  publisher: Publisher,
  revoked: ReadonlySet<string>,
  now: number,
): OperationPackRefusalReason | undefined {
  if (revoked.has(publisher.keyId)) return "publisher-revoked";
  if (publisher.notBefore !== undefined && now < publisher.notBefore)
    return "publisher-not-yet-valid";
  if (publisher.notAfter !== undefined && now >= publisher.notAfter)
    return "publisher-expired";
  return undefined;
}

/** What decides a key's standing at a given moment. */
type Trust = { revoked: ReadonlySet<string>; now: () => number };
/** The key's validity window and the revocation list, now. */
async function currentStanding(
  publisher: Publisher,
  trust: Trust,
): Promise<OperationPackRefusalReason | undefined> {
  return keyStanding(publisher, trust.revoked, trust.now());
}

function readRegularFile(path: string, limit: number): Buffer {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > limit) throw new Refusal("invalid-layout");
  const bytes = readFileSync(path);
  if (bytes.byteLength > limit) throw new Refusal("invalid-layout");
  return bytes;
}

const isNeutralEntry = (entry: VocabularyEntry) =>
  entry.provider === NEUTRAL_PROVIDER && entry.profile === NEUTRAL_PROVIDER;

/**
 * The host-vocabulary checks a pack operation meets on top of the registry's
 * own. A pack gets values in and out only through vocabulary the host
 * already defines, and only public ones: an artifact handle is accepted
 * solely as the input of a declared `oauth-client` credential, which the host
 * resolves and the handler never sees.
 */
function checkOperation(
  operation: PackOperation,
  vocabulary: ReadonlyMap<string, VocabularyEntry>,
  options: OperationPackOptions,
  pack: string,
) {
  const credentialInputs = new Set<string>();
  for (const credential of Object.values(operation.credentials)) {
    if (credential.source === "oauth-client") {
      if (
        !options.store ||
        operation.inputs[credential.input]?.contract !== "common.oauth-client"
      )
        throw new Refusal("credential-unavailable");
      credentialInputs.add(credential.input);
    } else if (!options.secrets) throw new Refusal("credential-unavailable");
  }
  const slots = [
    ...Object.entries(operation.inputs).map(
      ([name, slot]) => [name, slot, "input"] as const,
    ),
    ...Object.entries(operation.outputs).map(
      ([name, slot]) => [name, slot, "output"] as const,
    ),
  ];
  for (const [name, slot, direction] of slots) {
    const entry = vocabulary.get(slot.contract);
    if (!entry) throw new Refusal("unknown-vocabulary");
    if (operation.scope.kind === "neutral") {
      if (!isNeutralEntry(entry)) throw new Refusal("provider-mismatch");
    } else if (
      entry.provider !== undefined &&
      !(isNeutralEntry(entry) && entry.crossProvider) &&
      (entry.provider !== operation.scope.provider ||
        (entry.profile ?? operation.scope.profile) !== operation.scope.profile)
    )
      throw new Refusal("provider-mismatch");
    const credentialHandle =
      direction === "input" && credentialInputs.has(name);
    if (entry.classification !== "public" && !credentialHandle)
      throw new Refusal("forbidden-classification");
  }
  for (const origin of operation.destinations)
    if (
      (isLoopbackPackDestination(origin) && !options.loopbackFixtures) ||
      options.allowDestination?.(pack, origin) === false
    )
      throw new Refusal("destination-refused");
}

const requestSchema = z.strictObject({
  url: z.string().max(2048),
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  headers: z
    .record(
      z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/),
      z
        .string()
        .max(8192)
        .regex(/^[^\r\n\0]*$/),
    )
    .refine((headers) => Object.keys(headers).length <= 32)
    .optional(),
  body: z.string().max(OPERATION_PACK_LIMITS.requestBodyBytes).optional(),
  credential: z.string().max(96).optional(),
});
/** Headers a handler never sets itself: transport framing, cookies and authorization. */
const reservedHeaders = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
]);
const handlerResultSchema = z.union([
  z.strictObject({ outputs: z.record(z.string(), z.unknown()) }),
  z.strictObject({
    failed: z.enum([
      "denied",
      "conflict",
      "unavailable",
      "invalid-input",
      "expired",
    ]),
  }),
]);
type DiagnosticCode = z.infer<typeof diagnosticCodeSchema>;

/** Form-encoding for HTTP Basic client authentication (RFC 6749 section 2.3.1). */
const formEncode = (value: string) =>
  new URLSearchParams({ v: value }).toString().slice(2);

async function readCapped(
  response: Response,
  limit: number,
): Promise<string | undefined> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

type LoadedPack = {
  /** The directory entry it was read from. */
  entry: string;
  manifest: OperationPackManifest;
  source: string;
  publisher: Publisher;
};
/** What every invocation of a prepared set shares. */
type Runtime = { trust: Trust };

/**
 * One invocation of one entry. Holds what the host learns while the handler
 * runs: whether a request with a possible effect left, whether the handler
 * broke a rule, the last exchange's public facts, and every secret value it
 * injected, so each can be scrubbed from what the handler reads back.
 */
class Invocation {
  private requests = 0;
  dispatched = false;
  violation = false;
  facts: OperationResponseFacts | undefined;
  private readonly injected = new Set<string>();
  constructor(
    private readonly pack: LoadedPack,
    private readonly operation: PackOperation,
    private readonly id: string,
    private readonly readOnly: boolean,
    private readonly context: OperationContext,
    /** Host-side inputs, including credential handles the sandbox never gets. */
    private readonly inputs: Record<string, unknown>,
    private readonly options: OperationPackOptions,
    private readonly signal: AbortSignal,
  ) {}
  private deny(): SandboxReply {
    this.violation = true;
    return { ok: false, code: "denied" };
  }
  private redact(text: string): string {
    let result = text;
    for (const secret of this.injected)
      result = result.split(secret).join("[redacted]");
    return result;
  }
  private remember(...values: string[]) {
    for (const value of values)
      if (value.length) {
        this.injected.add(value);
        this.injected.add(encodeURIComponent(value));
        this.injected.add(formEncode(value));
      }
  }
  private async credential(
    name: string,
  ): Promise<{ header: string; value: string } | undefined> {
    const declared = Object.hasOwn(this.operation.credentials, name)
      ? this.operation.credentials[name]
      : undefined;
    if (!declared) return undefined;
    if (declared.source === "oauth-client") {
      const client = this.options.store
        ? await readOAuthClient(
            this.options.store,
            this.context,
            this.inputs[declared.input],
          )
        : undefined;
      if (!client?.clientSecret) return undefined;
      const token = Buffer.from(
        `${formEncode(client.clientId)}:${formEncode(client.clientSecret)}`,
      ).toString("base64");
      this.remember(client.clientSecret, token);
      return { header: "authorization", value: `Basic ${token}` };
    }
    const value = await this.options.secrets?.({
      actor: this.context.actor,
      runId: this.context.runId,
      pack: this.pack.manifest.id,
      operationId: this.id,
      name: declared.name,
    });
    if (!value || value.length > 8192 || /[\r\n\0]/.test(value))
      return undefined;
    this.remember(value);
    return declared.placement.kind === "bearer"
      ? { header: "authorization", value: `Bearer ${value}` }
      : { header: declared.placement.name.toLowerCase(), value };
  }
  async request(text: string): Promise<SandboxReply> {
    if (++this.requests > OPERATION_PACK_LIMITS.requests)
      return { ok: false, code: "limit" };
    let request: z.infer<typeof requestSchema>;
    try {
      request = requestSchema.parse(JSON.parse(text));
    } catch {
      return { ok: false, code: "invalid-request" };
    }
    if (!URL.canParse(request.url))
      return { ok: false, code: "invalid-request" };
    const url = new URL(request.url);
    // The destination rule and the read rule are the manifest's promises;
    // breaking either is a violation that fails the whole step.
    if (
      url.username ||
      url.password ||
      !this.operation.destinations.includes(url.origin)
    )
      return this.deny();
    const method = request.method ?? "GET";
    const safe = method === "GET" || method === "HEAD";
    if (!safe && this.readOnly) return this.deny();
    if (safe && request.body !== undefined)
      return { ok: false, code: "invalid-request" };
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      if (reservedHeaders.has(name.toLowerCase()))
        return { ok: false, code: "invalid-request" };
      headers.set(name, value);
    }
    if (request.credential !== undefined) {
      const credential = await this.credential(request.credential);
      if (!credential) return { ok: false, code: "unavailable" };
      headers.set(credential.header, credential.value);
    }
    if (!safe) this.dispatched = true;
    try {
      const response = await (this.options.fetch ?? publicAuthFetch)(url.href, {
        method,
        headers,
        ...(request.body !== undefined ? { body: request.body } : {}),
        redirect: "error",
        signal: this.signal,
      });
      this.facts = {
        statusCode: response.status,
        method,
        url: `${url.origin}${url.pathname}`,
      };
      const body = await readCapped(
        response,
        OPERATION_PACK_LIMITS.responseBytes,
      );
      if (body === undefined) return { ok: false, code: "too-large" };
      const contentType = response.headers.get("content-type");
      return {
        ok: true,
        text: JSON.stringify({
          status: response.status,
          headers: contentType
            ? { "content-type": this.redact(contentType) }
            : {},
          body: this.redact(body),
        }),
      };
    } catch {
      return { ok: false, code: "unavailable" };
    }
  }
}

function packOperation(
  pack: LoadedPack,
  operation: PackOperation,
  vocabulary: ReadonlyMap<string, VocabularyEntry>,
  options: OperationPackOptions,
  runtime: Runtime,
): RegisteredOperation {
  const id = packOperationId(pack.manifest.id, operation.name);
  const [provider, profile] =
    operation.scope.kind === "neutral"
      ? [NEUTRAL_PROVIDER, NEUTRAL_PROVIDER]
      : [operation.scope.provider, operation.scope.profile];
  const shape = (
    slots: PackOperation["inputs"],
  ): z.ZodType<Record<string, unknown>> =>
    z.strictObject(
      Object.fromEntries(
        Object.entries(slots).map(([name, slot]) => {
          const schema = vocabulary.get(slot.contract)!.schema;
          return [name, slot.required ? schema : schema.optional()];
        }),
      ),
    ) as z.ZodType<Record<string, unknown>>;
  const classifications: PublicBindingPolicy = Object.fromEntries(
    Object.entries(operation.inputs).map(([name, slot]) => {
      const entry = vocabulary.get(slot.contract)!;
      return [
        name,
        { classification: entry.classification, schema: entry.schema },
      ];
    }),
  );
  const outputSchema = shape(operation.outputs);
  const limits = {
    timeoutMs:
      operation.limits?.timeoutMs ?? OPERATION_PACK_LIMITS.timeoutMs.default,
    memoryMb:
      operation.limits?.memoryMb ?? OPERATION_PACK_LIMITS.memoryMb.default,
    outputBytes:
      operation.limits?.outputBytes ??
      OPERATION_PACK_LIMITS.outputBytes.default,
  };
  const publicInputs = (inputs: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(inputs).filter(
        ([name]) => classifications[name]?.classification === "public",
      ),
    );
  /** Run one entry; the key's standing is checked again at every call. */
  async function invoke(
    entry: "run" | "verify",
    context: OperationContext,
    inputs: Record<string, unknown>,
    argument: unknown,
  ) {
    if (await currentStanding(pack.publisher, runtime.trust)) return undefined;
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    const invocation = new Invocation(
      pack,
      operation,
      id,
      entry === "verify" || operation.effect === "read",
      context,
      inputs,
      options,
      signal,
    );
    try {
      const outcome = await runInSandbox({
        source: pack.source,
        entry,
        operation: operation.name,
        input: JSON.stringify(argument),
        ...limits,
        signal,
        request: (text) => invocation.request(text),
      });
      return { outcome, invocation };
    } finally {
      controller.abort();
    }
  }
  return {
    contract: {
      id,
      version: operation.version,
      provider,
      profile,
      inputs: operation.inputs,
      outputs: operation.outputs,
      effects: [id],
      verifier: id,
      humanFallback: "pack.none",
    },
    inputSchema: shape(operation.inputs),
    outputSchema,
    classifications,
    fixtures: operation.fixtures,
    ...(operation.replay ? { replay: operation.replay } : {}),
    handler: async (context, inputs): Promise<OperationResult> => {
      const ran = await invoke("run", context, inputs, publicInputs(inputs));
      if (!ran)
        return { state: "failed", outputs: {}, diagnosticCode: "denied" };
      const { outcome, invocation } = ran;
      // A request with a possible effect may have landed whatever happened
      // next; that is uncertainty for reconciliation, never a clean failure.
      const fail = (code: DiagnosticCode): OperationResult =>
        invocation.dispatched
          ? { state: "uncertain", outputs: {}, diagnosticCode: "uncertain" }
          : { state: "failed", outputs: {}, diagnosticCode: code };
      if (invocation.violation) return fail("denied");
      if (outcome.kind === "error")
        return fail(outcome.reason === "aborted" ? "cancelled" : "unavailable");
      let parsed: z.infer<typeof handlerResultSchema>;
      try {
        parsed = handlerResultSchema.parse(JSON.parse(outcome.text));
      } catch {
        return fail("unavailable");
      }
      if ("failed" in parsed)
        return { state: "failed", outputs: {}, diagnosticCode: parsed.failed };
      const outputs = outputSchema.safeParse(parsed.outputs);
      if (!outputs.success) return fail("unavailable");
      return {
        state: "complete",
        outputs: outputs.data,
        ...(invocation.facts ? { response: invocation.facts } : {}),
      };
    },
    ...(operation.verify
      ? {
          verify: async (
            context: OperationContext,
            result: OperationResult,
          ) => {
            if (result.state !== "complete") return false;
            const ran = await invoke("verify", context, {}, result.outputs);
            return Boolean(
              ran &&
              !ran.invocation.violation &&
              ran.outcome.kind === "done" &&
              ran.outcome.text === "true",
            );
          },
        }
      : {}),
  };
}

const refusal = (entry: string, error: unknown): OperationPackRefusal => {
  const reason = error instanceof Refusal ? error.reason : "invalid-layout";
  return { entry, reason, message: operationPackRefusals[reason] };
};

/** Evaluate the bundle once and read which entries each operation defines. */
async function checkExports(manifest: OperationPackManifest, source: string) {
  const outcome = await runInSandbox({
    source,
    entry: "exports",
    operation: "",
    input: "null",
    timeoutMs: OPERATION_PACK_LIMITS.timeoutMs.default,
    memoryMb: Math.max(
      OPERATION_PACK_LIMITS.memoryMb.default,
      ...manifest.operations.map(
        (operation) => operation.limits?.memoryMb ?? 0,
      ),
    ),
    outputBytes: OPERATION_PACK_LIMITS.outputBytes.max,
    signal: new AbortController().signal,
    request: async () => ({ ok: false, code: "denied" }),
  });
  const exported = z
    .record(
      z.string(),
      z.strictObject({ run: z.boolean(), verify: z.boolean() }),
    )
    .safeParse(outcome.kind === "done" ? JSON.parse(outcome.text) : undefined);
  if (
    !exported.success ||
    manifest.operations.some((operation) => {
      const found = Object.hasOwn(exported.data, operation.name)
        ? exported.data[operation.name]
        : undefined;
      return !found?.run || (operation.verify && !found.verify);
    })
  )
    throw new Refusal("missing-export");
}

type Prepared = {
  packs: readonly LoadedPack[];
  refused: readonly OperationPackRefusal[];
  options: OperationPackOptions;
  runtime: Runtime;
};
const prepared = new WeakMap<PreparedOperationPacks, Prepared>();

/**
 * Packs whose signature, digest and exports have been checked, ready to
 * register. Only `prepareOperationPacks` makes one, and
 * `registerOperationPacks` accepts nothing else.
 */
export class PreparedOperationPacks {
  private constructor(
    /** Packs refused before registration. */
    readonly refused: readonly OperationPackRefusal[],
  ) {}
  /** @internal */
  static create(value: Prepared): PreparedOperationPacks {
    const packs = new PreparedOperationPacks(value.refused);
    prepared.set(packs, value);
    return packs;
  }
  /** The packs that passed, by pack id. */
  get ready(): string[] {
    return prepared.get(this)!.packs.map((pack) => pack.manifest.id);
  }
}

/**
 * Read and verify every pack in `options.directory`: the layout, the
 * publisher's key and its standing, the signature, the bundle digest, and
 * that the bundle defines every declared operation. Nothing is registered.
 * Host misconfiguration (an unreadable directory, a trusted key that is not
 * Ed25519) throws instead of refusing.
 */
export async function prepareOperationPacks(
  options: OperationPackOptions,
): Promise<PreparedOperationPacks> {
  const publishers = trustedPublishers(options.publishers);
  const trust: Trust = {
    revoked: new Set(options.revokedKeys ?? []),
    now: options.now ?? Date.now,
  };
  const packs: LoadedPack[] = [];
  const refused: OperationPackRefusal[] = [];
  const seen = new Set<string>();
  const entries = readdirSync(options.directory, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    try {
      if (!entry.isDirectory()) throw new Refusal("invalid-layout");
      const root = join(options.directory, entry.name);
      let envelope;
      try {
        envelope = operationPackEnvelopeSchema.parse(
          JSON.parse(
            readRegularFile(
              join(root, "pack.json"),
              OPERATION_PACK_LIMITS.manifestBytes,
            ).toString("utf8"),
          ),
        );
      } catch (error) {
        if (error instanceof Refusal) throw error;
        throw new Refusal("invalid-manifest");
      }
      const { manifest, signature } = envelope;
      if (signature.keyId !== manifest.publisher)
        throw new Refusal("invalid-manifest");
      const publisher = publishers.get(manifest.publisher);
      if (!publisher) throw new Refusal("unknown-publisher");
      const standing = await currentStanding(publisher, trust);
      if (standing) throw new Refusal(standing);
      if (
        !verifySignature(
          null,
          operationPackSigningPayload(manifest),
          publisher.key,
          Buffer.from(signature.value, "base64"),
        )
      )
        throw new Refusal("bad-signature");
      if (publisher.packs && !publisher.packs.has(manifest.id))
        throw new Refusal("publisher-not-allowed");
      let bundle: Buffer;
      try {
        bundle = readRegularFile(
          join(root, "handler.js"),
          OPERATION_PACK_LIMITS.bundleBytes,
        );
      } catch {
        throw new Refusal("bundle-digest-mismatch");
      }
      if (
        bundle.byteLength !== manifest.bundle.bytes ||
        createHash("sha256").update(bundle).digest("hex") !==
          manifest.bundle.sha256
      )
        throw new Refusal("bundle-digest-mismatch");
      if (seen.has(manifest.id)) throw new Refusal("duplicate-operation");
      const source = bundle.toString("utf8");
      await checkExports(manifest, source);
      seen.add(manifest.id);
      packs.push({ entry: entry.name, manifest, source, publisher });
    } catch (error) {
      refused.push(refusal(entry.name, error));
    }
  }
  return PreparedOperationPacks.create({
    packs,
    refused,
    options,
    runtime: { trust },
  });
}

/**
 * Register prepared packs into `registry`, after checking each operation
 * against the registry's vocabulary and the host's destination and
 * credential policy. All or nothing per pack. The report lists what loaded
 * and every refusal, from preparation or from here, in directory order.
 */
export function registerOperationPacks(
  registry: OperationRegistry,
  packs: PreparedOperationPacks,
  overrides: { store?: AsyncCeremonyStore } = {},
): OperationPackReport {
  const state = prepared.get(packs);
  // Only a set prepareOperationPacks checked can register.
  if (!state) throw new Error("Operation packs must be prepared first");
  const options: OperationPackOptions = {
    ...state.options,
    ...(overrides.store ? { store: overrides.store } : {}),
  };
  const report: OperationPackReport = {
    loaded: [],
    refused: [...state.refused],
  };
  for (const pack of state.packs) {
    const { manifest, publisher } = pack;
    try {
      for (const operation of manifest.operations)
        checkOperation(operation, registry.vocabulary, options, manifest.id);
      const registrations = manifest.operations.map((operation) => ({
        operation: packOperation(
          pack,
          operation,
          registry.vocabulary,
          options,
          state.runtime,
        ),
        provenance: {
          kind: "pack" as const,
          pack: manifest.id,
          packVersion: manifest.version,
          publisher: publisher.keyId,
          effect: operation.effect,
          destinations: operation.destinations,
        },
      }));
      // All or nothing: every operation must register in a scratch registry
      // over the same vocabulary, and none may already exist, before any
      // reaches the live one.
      const scratch = new OperationRegistry(registry.vocabulary);
      try {
        for (const { operation, provenance } of registrations)
          scratch.registerPack(operation, provenance);
      } catch {
        throw new Refusal("provider-mismatch");
      }
      if (
        registrations.some(({ operation }) =>
          registry.get(operation.contract.id, operation.contract.version),
        )
      )
        throw new Refusal("duplicate-operation");
      for (const { operation, provenance } of registrations)
        registry.registerPack(operation, provenance);
      report.loaded.push({
        pack: manifest.id,
        version: manifest.version,
        publisher: publisher.keyId,
        operations: registrations.map(({ operation }) => ({
          id: operation.contract.id,
          version: operation.contract.version,
        })),
      });
    } catch (error) {
      report.refused.push(refusal(pack.entry, error));
    }
  }
  report.refused.sort((a, b) => (a.entry < b.entry ? -1 : 1));
  return report;
}

/** Prepare and register in one step, for hosts that build their own registry. */
export async function loadOperationPacks(
  registry: OperationRegistry,
  options: OperationPackOptions,
): Promise<OperationPackReport> {
  return registerOperationPacks(registry, await prepareOperationPacks(options));
}

/** Thrown by a host that requires every configured pack to load. */
export class OperationPackRefused extends Error {
  constructor(readonly refusals: readonly OperationPackRefusal[]) {
    super(
      `Operation packs refused: ${refusals
        .map((refusal) => `${refusal.entry} (${refusal.reason})`)
        .join(", ")}`,
    );
  }
}
