import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch, type Response as UndiciResponse } from "undici";
import {
  createPublicAuthLookup,
  isPublicAuthAddress,
} from "../../public-auth-fetch.js";
import { ConnectorError } from "../errors.js";

/*
 * The one fetcher every import-side network call goes through: source
 * retrieval, `$ref` resolution, discovery, dynamic schema lookups and adapter
 * destinations. It builds on `createPublicAuthLookup`, so the address check
 * runs inside socket creation on the exact answers the socket connects to,
 * and adds what a document importer needs beyond an OAuth client: manual
 * redirect handling with every hop revalidated, credential stripping,
 * administrator-approved private origins as a separate policy rather than a
 * caller flag, streaming byte ceilings and abort-signal timeouts.
 *
 * A policy is host configuration. Nothing in a document, a registry entry or
 * a caller argument can add an origin to it.
 */

export type NetworkMode = "public" | "approved-private" | "loopback-fixture";

export type NetworkPolicy = {
  mode: NetworkMode;
  /** Exact HTTPS origins an administrator approved on private networks; only meaningful in approved-private mode. */
  approvedPrivateOrigins?: readonly string[] | undefined;
  /** Exact origins beyond the initial request's origin that redirects may cross to, or that may use a nonstandard port. */
  allowedOrigins?: readonly string[] | undefined;
  maxRedirects: number;
  maxResponseBytes: number;
  timeoutMs: number;
  maxRequestBytes?: number | undefined;
  /** Compressed responses are refused unless allowed; decoded bytes then count toward the ceiling. */
  allowCompressedResponses?: boolean | undefined;
  /** DNS answers; production uses the operating system resolver, tests inject answers. */
  lookup?: ((hostname: string) => Promise<LookupAddress[]>) | undefined;
};

type ResolvedPolicy = Readonly<{
  mode: NetworkMode;
  approvedPrivateOrigins: readonly string[];
  allowedOrigins: readonly string[];
  maxRedirects: number;
  maxResponseBytes: number;
  timeoutMs: number;
  maxRequestBytes: number;
  allowCompressedResponses: boolean;
  lookup: ((hostname: string) => Promise<LookupAddress[]>) | undefined;
}>;

export const NETWORK_LIMITS = Object.freeze({
  // Canonical document locations rarely need more than one hop; three covers
  // a versioned path move behind a vanity URL without inviting loops.
  maxRedirects: 3,
  // The same ceiling as a parsed definition; a bigger body is never useful.
  maxResponseBytes: 4 * 1024 * 1024,
  timeoutMs: 10_000,
  maxRequestBytes: 1024 * 1024,
  ceilings: Object.freeze({
    maxRedirects: 10,
    maxResponseBytes: 64 * 1024 * 1024,
    timeoutMs: 120_000,
    maxRequestBytes: 16 * 1024 * 1024,
  }),
});

const modes = new Set<NetworkMode>([
  "public",
  "approved-private",
  "loopback-fixture",
]);
const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const nullBodyStatuses = new Set([204, 205, 304]);
// Hop-by-hop and framing headers the transport owns, plus Host: a caller
// cannot make one origin's request look like another's.
const transportHeaders = [
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];
const credentialHeaders = ["authorization", "cookie", "proxy-authorization"];

const privateV4 = new BlockList();
for (const [address, prefix] of [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10],
] as const)
  privateV4.addSubnet(address, prefix, "ipv4");
const loopbackV4 = new BlockList();
loopbackV4.addSubnet("127.0.0.0", 8, "ipv4");
const privateV6 = new BlockList();
privateV6.addSubnet("fc00::", 7, "ipv6");
const loopbackV6 = new BlockList();
loopbackV6.addAddress("::1", "ipv6");
const mappedV6 = new BlockList();
mappedV6.addSubnet("::ffff:0:0", 96, "ipv6");

export type AddressClass = "public" | "private" | "loopback" | "forbidden";

/**
 * Classifies one literal address. "private" is the RFC 1918, shared-address
 * (100.64/10) and unique-local (fc00::/7) space an administrator may approve;
 * everything else that is not global unicast — loopback aside — is forbidden
 * outright: link-local and the cloud metadata address, unspecified,
 * multicast, documentation and transition ranges, and IPv4-mapped IPv6, which
 * is refused as a literal even when the embedded address would be fine.
 */
export function classifyAddress(address: string): AddressClass {
  const family = isIP(address);
  if (family === 4) {
    if (loopbackV4.check(address, "ipv4")) return "loopback";
    if (privateV4.check(address, "ipv4")) return "private";
    return isPublicAuthAddress(address) ? "public" : "forbidden";
  }
  if (family === 6) {
    if (mappedV6.check(address, "ipv6")) return "forbidden";
    if (loopbackV6.check(address, "ipv6")) return "loopback";
    if (privateV6.check(address, "ipv6")) return "private";
    return isPublicAuthAddress(address) ? "public" : "forbidden";
  }
  return "forbidden";
}

const policyInvalid = () =>
  new ConnectorError("invalid-request", { detail: "network.policy-invalid" });

function exactOrigin(value: unknown): URL {
  if (typeof value !== "string" || !URL.canParse(value)) throw policyInvalid();
  const url = new URL(value);
  if (url.origin !== value || url.origin === "null") throw policyInvalid();
  return url;
}

function boundedInteger(value: unknown, fallback: number, ceiling: number) {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > ceiling
  )
    throw policyInvalid();
  return value;
}

/** Fills defaults and refuses a policy that is unbounded, contradictory or names an origin it cannot mean. */
export function networkPolicy(input: NetworkPolicy): ResolvedPolicy {
  if (!input || typeof input !== "object" || !modes.has(input.mode))
    throw policyInvalid();
  const approvedPrivateOrigins = [...(input.approvedPrivateOrigins ?? [])];
  const allowedOrigins = [...(input.allowedOrigins ?? [])];
  if (approvedPrivateOrigins.length && input.mode !== "approved-private")
    throw policyInvalid();
  for (const origin of approvedPrivateOrigins) {
    const url = exactOrigin(origin);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const literal = isIP(host) ? classifyAddress(host) : undefined;
    if (
      url.protocol !== "https:" ||
      (literal !== undefined && literal !== "private" && literal !== "public")
    )
      throw policyInvalid();
  }
  for (const origin of allowedOrigins) {
    const url = exactOrigin(origin);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const loopback =
      host === "localhost" ||
      (isIP(host) !== 0 && classifyAddress(host) === "loopback");
    if (
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
          input.mode === "loopback-fixture" &&
          loopback)
      )
    )
      throw policyInvalid();
  }
  const timeoutMs = boundedInteger(
    input.timeoutMs,
    NETWORK_LIMITS.timeoutMs,
    NETWORK_LIMITS.ceilings.timeoutMs,
  );
  const maxResponseBytes = boundedInteger(
    input.maxResponseBytes,
    NETWORK_LIMITS.maxResponseBytes,
    NETWORK_LIMITS.ceilings.maxResponseBytes,
  );
  if (timeoutMs < 1 || maxResponseBytes < 1) throw policyInvalid();
  if (input.lookup !== undefined && typeof input.lookup !== "function")
    throw policyInvalid();
  return Object.freeze({
    mode: input.mode,
    approvedPrivateOrigins: Object.freeze(approvedPrivateOrigins),
    allowedOrigins: Object.freeze(allowedOrigins),
    maxRedirects: boundedInteger(
      input.maxRedirects,
      NETWORK_LIMITS.maxRedirects,
      NETWORK_LIMITS.ceilings.maxRedirects,
    ),
    maxResponseBytes,
    timeoutMs,
    maxRequestBytes: boundedInteger(
      input.maxRequestBytes,
      NETWORK_LIMITS.maxRequestBytes,
      NETWORK_LIMITS.ceilings.maxRequestBytes,
    ),
    allowCompressedResponses: input.allowCompressedResponses === true,
    lookup: input.lookup,
  });
}

export type TargetContext = {
  /** Origin of the first request when evaluating a redirect hop. */
  initialOrigin?: string | undefined;
  /** 0 for the initial request, 1 for the first redirect hop, and so on. */
  hop?: number | undefined;
};

export type TargetDecision =
  | { allowed: true; url: URL; origin: string; network: NetworkMode }
  | { allowed: false; detail: string };

/**
 * The pure policy check applied to the initial URL and to every redirect
 * target before any socket exists: parseability, userinfo, scheme, literal
 * address class, loopback confinement, port, origin approval and redirect
 * crossing. Hostnames are checked again at connection time by the lookup.
 */
export function evaluateNetworkTarget(
  target: string | URL,
  input: NetworkPolicy,
  context: TargetContext = {},
): TargetDecision {
  const policy = networkPolicy(input);
  const deny = (detail: string): TargetDecision => ({ allowed: false, detail });
  const text = typeof target === "string" ? target : target.href;
  if (typeof text !== "string" || !URL.canParse(text))
    return deny("network.url-invalid");
  const url = new URL(text);
  if (url.username || url.password) return deny("network.userinfo-forbidden");
  const origin = url.origin;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || origin === "null") return deny("network.url-invalid");
  const literal = isIP(host) ? classifyAddress(host) : undefined;
  const approved = policy.approvedPrivateOrigins.includes(origin);
  const listed = policy.allowedOrigins.includes(origin);
  const hop = context.hop ?? 0;
  if (
    hop > 0 &&
    context.initialOrigin !== undefined &&
    origin !== context.initialOrigin &&
    !listed
  )
    return deny("network.redirect-cross-origin");
  if (policy.mode === "loopback-fixture") {
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return deny("network.scheme-forbidden");
    if (!(host === "localhost" || literal === "loopback"))
      return deny("network.loopback-fixture-only");
    return { allowed: true, url, origin, network: "loopback-fixture" };
  }
  if (url.protocol !== "https:") return deny("network.scheme-forbidden");
  if (literal === "private") {
    if (!(policy.mode === "approved-private" && approved))
      return deny("network.private-origin-not-approved");
  } else if (literal !== undefined && literal !== "public")
    return deny("network.address-forbidden");
  else if (
    literal === undefined &&
    (loopbackHosts.has(host) || host.endsWith(".localhost"))
  )
    return deny("network.address-forbidden");
  if (url.port !== "" && !approved && !listed)
    return deny("network.port-forbidden");
  return {
    allowed: true,
    url,
    origin,
    network: approved ? "approved-private" : "public",
  };
}

export const NETWORK_POLICY_ERROR_CODE = "ERR_CEREMONY_NETWORK_POLICY";

/** The lookup's refusal, tagged so a transport failure can be told apart from a policy denial. */
class NetworkPolicyDenied extends Error {
  readonly code = NETWORK_POLICY_ERROR_CODE;
  constructor(readonly detail: string) {
    super("Destination refused by network policy");
    this.name = "NetworkPolicyDenied";
  }
}

const defaultResolve = (hostname: string) =>
  dnsLookup(hostname, { all: true, verbatim: true });

function tagLookup(inner: LookupFunction, detail: string): LookupFunction {
  return (hostname, options, callback) =>
    inner(hostname, options, (error, address, family) => {
      if (error) callback(new NetworkPolicyDenied(detail), "");
      else callback(null, address, family);
    });
}

/**
 * Connection-time lookup for administrator-approved private origins. Answers
 * may be public or private; loopback, link-local, metadata, mapped and every
 * other special address stays refused, and a mixed answer set is refused as
 * a whole. Like the public lookup, the vetted answers go straight to the
 * socket, so there is no second resolution to rebind.
 */
function approvedPrivateLookup(
  resolve: (hostname: string) => Promise<LookupAddress[]>,
): LookupFunction {
  return (hostname, options, callback) => {
    void resolve(hostname).then(
      (answers) => {
        if (
          !answers.length ||
          answers.some((answer) => {
            const kind = classifyAddress(answer.address);
            return kind !== "public" && kind !== "private";
          })
        )
          return callback(
            new NetworkPolicyDenied("network.dns-forbidden-address"),
            "",
          );
        const candidates = answers.filter(
          (answer) => !options.family || answer.family === options.family,
        );
        const first = candidates[0];
        if (!first)
          return callback(
            new NetworkPolicyDenied("network.dns-forbidden-address"),
            "",
          );
        if (options.all) callback(null, candidates);
        else callback(null, first.address, first.family);
      },
      () => callback(new NetworkPolicyDenied("network.dns-failed"), ""),
    );
  };
}

export type ApprovedFetch = typeof fetch & {
  readonly approved: true;
  readonly policy: ResolvedPolicy;
  /** Closes pooled connections; tests call it so fixtures shut down promptly. */
  close(): Promise<void>;
};

export function isApprovedFetch(value: unknown): value is ApprovedFetch {
  return (
    typeof value === "function" &&
    (value as { approved?: unknown }).approved === true &&
    typeof (value as { close?: unknown }).close === "function"
  );
}

type PreparedRequest = {
  url: URL;
  method: string;
  headers: Headers;
  body: Uint8Array | string | null;
  signal: AbortSignal | undefined;
  redirect: RequestRedirect;
};

function isRequestLike(value: unknown): value is Request {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Request).url === "string" &&
    typeof (value as Request).arrayBuffer === "function"
  );
}

async function normalizeBody(
  body: BodyInit | null | undefined,
  headers: Headers,
  policy: ResolvedPolicy,
): Promise<Uint8Array | string | null> {
  const bound = (size: number) => {
    if (size > policy.maxRequestBytes)
      throw new ConnectorError("invalid-request", {
        detail: "network.request-too-large",
      });
  };
  if (body === undefined || body === null) return null;
  if (typeof body === "string") {
    bound(Buffer.byteLength(body));
    return body;
  }
  if (body instanceof URLSearchParams) {
    const text = body.toString();
    bound(Buffer.byteLength(text));
    if (!headers.has("content-type"))
      headers.set(
        "content-type",
        "application/x-www-form-urlencoded;charset=UTF-8",
      );
    return text;
  }
  if (body instanceof ArrayBuffer) {
    bound(body.byteLength);
    return new Uint8Array(body.slice(0));
  }
  if (ArrayBuffer.isView(body)) {
    bound(body.byteLength);
    return new Uint8Array(
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    );
  }
  if (body instanceof Blob) {
    bound(body.size);
    if (body.type && !headers.has("content-type"))
      headers.set("content-type", body.type);
    return new Uint8Array(await body.arrayBuffer());
  }
  // Streams and multipart bodies are neither bounded up front nor replayable
  // across a validated redirect.
  throw new ConnectorError("invalid-request", {
    detail: "network.request-body-unsupported",
  });
}

async function prepareRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  policy: ResolvedPolicy,
): Promise<PreparedRequest> {
  let url: string;
  let method = "GET";
  let headers = new Headers();
  let body: BodyInit | null | undefined;
  let signal: AbortSignal | undefined;
  let redirect: RequestRedirect = "follow";
  if (typeof input === "string") url = input;
  else if (input instanceof URL) url = input.href;
  else if (isRequestLike(input)) {
    url = input.url;
    method = input.method;
    headers = new Headers(input.headers);
    signal = input.signal;
    redirect = input.redirect;
    if (input.body) body = await input.arrayBuffer();
  } else
    throw new ConnectorError("invalid-request", {
      detail: "network.request-invalid",
    });
  if (init) {
    if (init.method !== undefined) method = init.method;
    if (init.headers !== undefined) headers = new Headers(init.headers);
    if (init.body !== undefined) body = init.body;
    if (init.signal) signal = init.signal;
    if (init.redirect !== undefined) redirect = init.redirect;
  }
  method = method.toUpperCase();
  if (!/^[A-Z]{3,10}$/.test(method))
    throw new ConnectorError("invalid-request", {
      detail: "network.method-invalid",
    });
  if (!URL.canParse(url))
    throw new ConnectorError("network-policy", {
      detail: "network.url-invalid",
    });
  const bytes = await normalizeBody(body, headers, policy);
  for (const name of transportHeaders) headers.delete(name);
  headers.delete("accept-encoding");
  if (!policy.allowCompressedResponses)
    headers.set("accept-encoding", "identity");
  return { url: new URL(url), method, headers, body: bytes, signal, redirect };
}

function mapTransportError(
  error: unknown,
  signal: AbortSignal,
  timeout: AbortSignal,
): ConnectorError {
  if (error instanceof ConnectorError) return error;
  if (timeout.aborted)
    return new ConnectorError("upstream-unavailable", {
      detail: "network.timeout",
    });
  if (signal.aborted) return new ConnectorError("cancelled");
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  if (
    cause &&
    typeof cause === "object" &&
    (cause as { code?: unknown }).code === NETWORK_POLICY_ERROR_CODE
  )
    return new ConnectorError("network-policy", {
      detail: String((cause as { detail?: unknown }).detail ?? "network.denied"),
    });
  return new ConnectorError("upstream-unavailable", {
    detail: "network.connection-failed",
  });
}

const discard = (response: UndiciResponse) =>
  response.body?.cancel().catch(() => undefined) ?? Promise.resolve();

/**
 * Buffers a response under the byte ceiling while it streams. Content-Length
 * is only ever used to refuse early, never to trust; the count is of decoded
 * bytes as the transport hands them over, so a compressed body that inflates
 * past the ceiling is cut off at the ceiling.
 */
async function boundedResponse(
  response: UndiciResponse,
  url: URL,
  method: string,
  policy: ResolvedPolicy,
  signal: AbortSignal,
  timeout: AbortSignal,
): Promise<Response> {
  const tooLarge = () =>
    new ConnectorError("network-policy", {
      detail: "network.response-too-large",
    });
  const encoding = (response.headers.get("content-encoding") ?? "")
    .trim()
    .toLowerCase();
  if (encoding && encoding !== "identity" && !policy.allowCompressedResponses) {
    await discard(response);
    throw new ConnectorError("network-policy", {
      detail: "network.compressed-response-refused",
    });
  }
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    /^\d+$/.test(declared) &&
    Number(declared) > policy.maxResponseBytes
  ) {
    await discard(response);
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > policy.maxResponseBytes) {
          await reader.cancel().catch(() => undefined);
          throw tooLarge();
        }
        chunks.push(value);
      }
    } catch (error) {
      throw mapTransportError(error, signal, timeout);
    }
  }
  const headers = new Headers();
  for (const [name, value] of response.headers) headers.append(name, value);
  // The body below is decoded and complete; framing headers would lie.
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  const body = Buffer.concat(chunks);
  const result = new Response(
    nullBodyStatuses.has(response.status) || method === "HEAD"
      ? null
      : new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    {
      status: response.status,
      statusText: response.statusText,
      headers,
    },
  );
  Object.defineProperty(result, "url", { value: url.href, configurable: true });
  return result;
}

/**
 * Builds the approved fetcher for one policy. Each network class gets its own
 * dispatcher, so an approved private origin's lookup never serves a public
 * hostname and connections are pooled per exact origin only.
 */
export function createApprovedFetch(input: NetworkPolicy): ApprovedFetch {
  const policy = networkPolicy(input);
  const resolve = policy.lookup ?? defaultResolve;
  const agents = new Map<NetworkMode, Agent>();
  const agentFor = (network: NetworkMode): Agent => {
    const existing = agents.get(network);
    if (existing) return existing;
    const lookup =
      network === "approved-private"
        ? approvedPrivateLookup(resolve)
        : tagLookup(
            createPublicAuthLookup({
              lookup: resolve,
              allowLoopbackHttp: network === "loopback-fixture",
            }),
            "network.dns-forbidden-address",
          );
    const agent = new Agent({
      connect: { lookup, timeout: policy.timeoutMs },
      keepAliveTimeout: 4_000,
    });
    agents.set(network, agent);
    return agent;
  };

  const run = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = await prepareRequest(input, init, policy);
    const timeout = AbortSignal.timeout(policy.timeoutMs);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeout])
      : timeout;
    const initialOrigin = request.url.origin;
    let url = request.url;
    let method = request.method;
    let body = request.body;
    const headers = request.headers;
    for (let hop = 0; ; hop++) {
      const decision = evaluateNetworkTarget(url, policy, {
        initialOrigin,
        hop,
      });
      if (!decision.allowed)
        throw new ConnectorError("network-policy", { detail: decision.detail });
      let response: UndiciResponse;
      try {
        response = await undiciFetch(decision.url.href, {
          method,
          headers: [...headers],
          ...(body === null ? {} : { body }),
          signal,
          redirect: "manual",
          dispatcher: agentFor(decision.network),
        });
      } catch (error) {
        throw mapTransportError(error, signal, timeout);
      }
      const location = response.headers.get("location");
      if (!redirectStatuses.has(response.status) || location === null)
        return boundedResponse(
          response,
          decision.url,
          method,
          policy,
          signal,
          timeout,
        );
      await discard(response);
      if (request.redirect === "manual") {
        const headersOnly = new Headers();
        for (const [name, value] of response.headers)
          headersOnly.append(name, value);
        const manual = new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers: headersOnly,
        });
        Object.defineProperty(manual, "url", {
          value: decision.url.href,
          configurable: true,
        });
        return manual;
      }
      if (request.redirect === "error")
        throw new ConnectorError("network-policy", {
          detail: "network.redirect-refused",
        });
      if (hop >= policy.maxRedirects)
        throw new ConnectorError("network-policy", {
          detail: "network.redirect-limit",
        });
      if (!URL.canParse(location, decision.url.href))
        throw new ConnectorError("network-policy", {
          detail: "network.redirect-invalid",
        });
      const next = new URL(location, decision.url.href);
      // The responder chose the next destination, not the caller: credentials
      // never travel across any redirect, same-origin included.
      for (const name of credentialHeaders) headers.delete(name);
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) &&
          method === "POST")
      ) {
        if (method !== "HEAD") method = "GET";
        body = null;
        headers.delete("content-type");
      }
      url = next;
    }
  };

  const approvedFetch = run as ApprovedFetch;
  Object.defineProperties(approvedFetch, {
    approved: { value: true, enumerable: true },
    policy: { value: policy, enumerable: true },
    close: {
      value: async () => {
        const open = [...agents.values()];
        agents.clear();
        await Promise.all(open.map((agent) => agent.close()));
      },
    },
  });
  return approvedFetch;
}
