import { randomBytes } from "node:crypto";
import { CompactSign, compactVerify, type CryptoKey } from "jose";
import { z } from "zod";
import { CeremonyDatabase } from "./storage.js";
import { CeremonyError } from "./controller.js";
import {
  authorizedEffectSchema,
  effectAuthorizationDigest,
} from "./authorization.js";

/** Trusted host configuration, never model-authored copy or an authorization grant. */
export const a2hCeremonySchema = z.strictObject({
  connectorId: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  connectorName: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[^<>\u0000-\u001f\u007f]+$/),
  purpose: z.enum([
    "account-registration",
    "app-registration",
    "credential-collection",
    "provider-authorization",
  ]),
  effect: authorizedEffectSchema,
});
export type A2HCeremony = z.infer<typeof a2hCeremonySchema>;

function ceremonyParams(ceremony: A2HCeremony): Record<string, Json> {
  return {
    purpose: ceremony.purpose,
    connector_id: ceremony.connectorId,
    connector_name: ceremony.connectorName,
    effect_digest: effectAuthorizationDigest(ceremony.effect),
  };
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** RFC 8785 for I-JSON values. Reject unsupported/non-finite values rather than coerce them. */
export function canonicalJson(value: Json): string {
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("Non-finite JSON value");
  if (typeof value === "string" && !value.isWellFormed())
    throw new Error("Invalid Unicode");
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${canonicalJson(key)}:${canonicalJson(value[key]!)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function uuid7(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6]! & 15) | 112;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const recordSchema = z.object({
  owner: z.string(),
  instanceId: z.string(),
  principalId: z.string(),
  expiresAt: z.number(),
  message: z.record(z.string(), z.json()),
  state: z.enum(["pending", "waiting", "answered", "denied", "cancelled"]),
});
export interface A2HOptions {
  gatewayOrigin: string;
  agentId: string;
  keyId: string;
  privateKey: CryptoKey;
  /** Pin the gateway verification key out of band; discovery cannot replace trust. */
  gatewayKey: CryptoKey;
  apiKey: string;
  /** Resolve from authenticated host identity, never model-provided contact information. */
  recipient(owner: string): {
    principalId: string;
    type: "email" | "sms";
    address: string;
  };
  fetch?: typeof fetch;
}
/** Agent2Human 1.0 AUTHORIZE transport. Approval is evidence to verify, never a connection grant. */
export class Agent2Human {
  private readonly origin: string;
  private readonly fetcher: typeof fetch;
  constructor(
    private readonly db: CeremonyDatabase,
    private readonly options: A2HOptions,
  ) {
    const origin = new URL(options.gatewayOrigin);
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      throw new Error("A trusted HTTPS A2H gateway origin is required");
    this.origin = origin.origin;
    this.fetcher = options.fetch ?? fetch;
  }
  private async request(path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetcher(`${this.origin}${path}`, {
      method: body ? "POST" : "GET",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "x-a2h-api-key": this.options.apiKey,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw new CeremonyError(
        "Human request delivery failed. Continue in your browser or retry delivery.",
        502,
      );
    return response.json();
  }
  private async signed(
    payload: Record<string, Json>,
  ): Promise<Record<string, Json>> {
    const jws = await new CompactSign(
      new TextEncoder().encode(canonicalJson(payload)),
    )
      .setProtectedHeader({ alg: "EdDSA", kid: this.options.keyId })
      .sign(this.options.privateKey);
    const [header, , signature] = jws.split(".");
    return { ...payload, signature: `${header}..${signature}` };
  }
  async authorize(
    owner: string,
    instanceId: string,
    humanUrl: string,
    ceremony?: A2HCeremony,
  ): Promise<string> {
    const bound =
      ceremony === undefined ? undefined : a2hCeremonySchema.parse(ceremony);
    if (
      bound &&
      (bound.effect.runId !== instanceId || bound.effect.subjectId !== owner)
    )
      throw new CeremonyError("Human request context changed", 409);
    const url = new URL(humanUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "A2H requires an authenticated, non-secret HTTPS human route",
      );
    const params = bound
      ? ceremonyParams(bound)
      : { purpose: "github-app-installation" };
    const render = bound
      ? {
          title: `${bound.connectorName} needs your participation`,
          body: `Review the ${bound.purpose.replaceAll("-", " ")} step for ${bound.connectorName} in your authenticated ceremony: ${url.href}. Approval here does not replace provider consent or access verification. Enter credentials only in the private collector, never in your reply.`,
        }
      : {
          title: "GitHub access needs your approval",
          body: `Review the requested GitHub app and repository access in your authenticated ceremony: ${url.href}. Approval here does not replace GitHub consent.`,
        };
    // Older binaries cannot consume a generic request as an unbound GitHub approval.
    const key = `${bound ? "a2h-ceremony" : "a2h"}:${instanceId}`;
    const lease = this.db.acquire(key);
    try {
      let record = this.db.get(key, recordSchema);
      if (record && record.owner !== owner)
        throw new CeremonyError("Human request not found", 404);
      const recipient = this.options.recipient(owner);
      if (
        !(
          recipient.type === "email"
            ? /^mailto:[^\s]+@[^\s]+$/
            : /^tel:\+[0-9]{6,15}$/
        ).test(recipient.address) ||
        !recipient.principalId ||
        recipient.principalId.includes("@")
      )
        throw new Error("Invalid authenticated human recipient");
      const expectedChannel = {
        type: recipient.type,
        address: recipient.address,
        render,
      };
      if (record) {
        const channel = z
          .object({
            type: z.string(),
            address: z.string(),
            render: z.record(z.string(), z.json()),
          })
          .safeParse(record.message.channel);
        if (
          record.principalId !== recipient.principalId ||
          record.message.agent_id !== this.options.agentId ||
          canonicalJson(record.message.params ?? null) !==
            canonicalJson(params) ||
          !channel.success ||
          canonicalJson(channel.data) !== canonicalJson(expectedChannel)
        )
          throw new CeremonyError("Human request context changed", 409);
      }
      if (record?.state === "waiting" && record.expiresAt > Date.now())
        return String(record.message.interaction_id);
      if (record && record.state !== "pending")
        throw new CeremonyError(
          "The human request is no longer pending. Do not repeatedly prompt a declined or expired request.",
          409,
        );
      const discovery = z
        .object({
          a2h_supported: z.array(z.string()),
          channels: z.array(z.string()),
          max_ttl_sec: z.number().int().positive(),
          auth: z.object({ methods: z.array(z.string()) }),
        })
        .parse(await this.request("/.well-known/a2h"));
      if (
        !discovery.a2h_supported.includes("1.0") ||
        !discovery.channels.includes(recipient.type) ||
        !discovery.auth.methods.includes("api_key")
      )
        throw new CeremonyError(
          "A2H gateway does not support the required version, channel and authentication",
          503,
        );
      if (!record) {
        const ttl = Math.min(600, discovery.max_ttl_sec);
        const expiresAt = Date.now() + ttl * 1000;
        record = {
          owner,
          instanceId,
          principalId: recipient.principalId,
          expiresAt,
          state: "pending",
          message: await this.signed({
            a2h_version: "1.0",
            a2h_min_version: "1.0",
            interaction_id: uuid7(),
            message_id: uuid7(),
            type: "AUTHORIZE",
            agent_id: this.options.agentId,
            principal_id: recipient.principalId,
            created_at: new Date().toISOString(),
            ttl_sec: ttl,
            channel: {
              ...expectedChannel,
              nonce: randomBytes(24).toString("base64url"),
              expires_at: new Date(expiresAt).toISOString(),
            },
            params,
          }),
        };
        this.db.put(key, record); // Same signed message_id is retried after uncertain delivery.
      }
      if (record.expiresAt <= Date.now())
        throw new CeremonyError("Human request expired", 409);
      const acknowledgement = z
        .object({ interaction_id: z.string() })
        .parse(await this.request("/v1/intent", record.message));
      if (acknowledgement.interaction_id !== record.message.interaction_id)
        throw new CeremonyError("A2H acknowledgement correlation failed", 502);
      record.state = "waiting";
      this.db.put(key, record);
      return acknowledgement.interaction_id;
    } finally {
      this.db.release(key, lease);
    }
  }
  async receive(
    instanceId: string,
    input: unknown,
    ceremony?: A2HCeremony,
  ): Promise<"verify" | "deny"> {
    const bound =
      ceremony === undefined ? undefined : a2hCeremonySchema.parse(ceremony);
    if (bound && bound.effect.runId !== instanceId)
      throw new CeremonyError("Human request context changed", 409);
    const response = z
      .object({
        type: z.literal("RESPONSE"),
        message_id: z.string(),
        interaction_id: z.string(),
        responds_to: z.string(),
        principal_id: z.string(),
        decision: z.enum(["APPROVE", "DECLINE"]),
        decided_at: z.iso.datetime(),
        evidence: z.object({ factor: z.string().min(1) }).passthrough(),
        signature: z.string().max(8000),
      })
      .passthrough()
      .parse(input);
    const { signature, ...body } = response;
    const payload = canonicalJson(z.record(z.string(), z.json()).parse(body));
    const [header, detached, signed, extra] = signature.split(".");
    if (!header || detached !== "" || !signed || extra !== undefined)
      throw new CeremonyError("Invalid A2H signature", 403);
    await compactVerify(
      `${header}.${Buffer.from(payload).toString("base64url")}.${signed}`,
      this.options.gatewayKey,
      { algorithms: ["EdDSA"] },
    );
    return this.db.transaction(() => {
      const key = `${bound ? "a2h-ceremony" : "a2h"}:${instanceId}`;
      const record = this.db.get(key, recordSchema);
      if (record) {
        const recipient = this.options.recipient(record.owner);
        const channel = z
          .object({ type: z.string(), address: z.string() })
          .safeParse(record.message.channel);
        if (
          recipient.principalId !== record.principalId ||
          record.message.agent_id !== this.options.agentId ||
          !channel.success ||
          channel.data.type !== recipient.type ||
          channel.data.address !== recipient.address
        )
          throw new CeremonyError("Human request context changed", 409);
      }
      if (
        bound &&
        record &&
        (record.owner !== bound.effect.subjectId ||
          canonicalJson(record.message.params ?? null) !==
            canonicalJson(ceremonyParams(bound)))
      )
        throw new CeremonyError("Human request context changed", 409);
      if (
        !record ||
        record.state !== "waiting" ||
        record.expiresAt <= Date.now() ||
        response.principal_id !== record.principalId ||
        response.interaction_id !== record.message.interaction_id ||
        response.responds_to !== record.message.message_id ||
        Date.parse(response.decided_at) > Date.now() + 30_000 ||
        Date.parse(response.decided_at) <
          Date.parse(String(record.message.created_at)) ||
        this.db.get(`a2h-response:${response.message_id}`, z.boolean())
      )
        throw new CeremonyError("Stale or mismatched A2H response", 409);
      record.state = response.decision === "APPROVE" ? "answered" : "denied";
      this.db.put(key, record);
      this.db.put(`a2h-response:${response.message_id}`, true);
      return response.decision === "APPROVE" ? "verify" : "deny";
    });
  }
}
