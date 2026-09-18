import { createHash, createHmac } from "node:crypto";
import { ConnectorError } from "../../errors.js";

/*
 * AWS Signature Version 4, written from the normative description in
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html
 * (retrieved 2026-09-18) and
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-signing-elements.html
 * (retrieved 2026-09-18).
 *
 * Only the header-based SigV4 flavour is implemented, because that is the only
 * one this adapter needs: a management read signed with the deployment's own
 * AWS credentials, and — when a gateway uses IAM inbound authorization — a
 * gateway invocation signed with the *separate* caller credentials. The two
 * never share a key: `signRequest` takes the credentials it is given and this
 * module has no ambient credential chain, no environment lookup and no
 * instance-metadata fallback. That absence is deliberate: a broad default
 * chain would quietly sign a request with whatever identity the host process
 * happens to have, which is exactly the confusion the binding is meant to
 * prevent.
 *
 * Unverified: the AWS documentation consulted here does not state whether the
 * canonical URI is encoded once or twice for this service. Every path segment
 * this module signs is an AgentCore identifier restricted to `[0-9a-zA-Z-]`
 * (gateway `([0-9a-z][-]?){1,100}-[0-9a-z]{10}`, target `[0-9a-zA-Z]{10}`),
 * for which single and double encoding are identical, and `signRequest`
 * refuses any other character rather than guessing.
 */

export const AWS_SIGV4_ALGORITHM = "AWS4-HMAC-SHA256";
/** `Hex(SHA256Hash(""))`, quoted in the canonical-headers example of the signing documentation. */
export const EMPTY_PAYLOAD_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  /** Temporary credentials only; signed as `x-amz-security-token`. */
  sessionToken?: string;
  /** Epoch milliseconds at which temporary credentials stop being valid, when the host knows it. */
  expiresAt?: number;
};

export type SigV4Request = {
  method: "GET" | "HEAD" | "POST";
  url: URL;
  /** Headers to sign besides `host` and `x-amz-date`; names are lowercased. */
  headers?: Record<string, string>;
  /** Exact request body bytes as text; "" for a body-less request. */
  payload?: string;
};

export type SigV4Context = {
  region: string;
  service: string;
  credentials: AwsCredentials;
  /** Epoch milliseconds; the signature is bound to this instant. */
  now: number;
};

export type SignedRequest = {
  headers: Record<string, string>;
  /** Exposed for tests and diagnostics; contains no key material. */
  canonicalRequest: string;
  stringToSign: string;
  credentialScope: string;
  signature: string;
  amzDate: string;
};

const accessKeyPattern = /^[A-Z0-9]{16,128}$/;
const regionPattern = /^[a-z0-9-]{1,32}$/;
const servicePattern = /^[a-z0-9-]{1,64}$/;
/** Characters AgentCore identifiers use; anything else is refused rather than encoded ambiguously. */
const signablePathSegment = /^[0-9A-Za-z-]*$/;

function invalid(detail: string): ConnectorError {
  return new ConnectorError("invalid-request", { detail });
}

/**
 * `UriEncode()` as the signing documentation defines it: every byte is encoded
 * except `A-Z a-z 0-9 - . _ ~`, space becomes `%20`, and hexadecimal digits are
 * uppercase. The platform's `encodeURIComponent` leaves `!'()*` alone, so they
 * are encoded here explicitly.
 */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** `YYYYMMDDTHHMMSSZ` in UTC, without milliseconds. */
export function amzDateTime(epochMs: number): string {
  return `${new Date(epochMs).toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
}

export function hashHex(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** `SigningKey = HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), service), "aws4_request")`. */
export function signingKey(
  secretAccessKey: string,
  date: string,
  region: string,
  service: string,
): Buffer {
  const dateKey = hmac(`AWS4${secretAccessKey}`, date);
  const dateRegionKey = hmac(dateKey, region);
  const dateRegionServiceKey = hmac(dateRegionKey, service);
  return hmac(dateRegionServiceKey, "aws4_request");
}

/** The canonical URI: each already-decoded segment encoded once, with the leading `/` kept. */
export function canonicalUri(pathname: string): string {
  const segments = pathname.split("/");
  return segments
    .map((segment, index) => {
      if (index === 0) return "";
      const decoded = decodeURIComponent(segment);
      if (!signablePathSegment.test(decoded))
        throw invalid("sigv4.path.unsignable");
      return uriEncode(decoded);
    })
    .join("/");
}

/** Query parameters sorted by encoded name, then encoded value; repeated names keep their order. */
export function canonicalQueryString(url: URL): string {
  const pairs: Array<[string, string]> = [];
  for (const [name, value] of url.searchParams)
    pairs.push([uriEncode(name), uriEncode(value)]);
  pairs.sort(([aName, aValue], [bName, bValue]) =>
    aName === bName
      ? aValue < bValue
        ? -1
        : aValue > bValue
          ? 1
          : 0
      : aName < bName
        ? -1
        : 1,
  );
  return pairs.map(([name, value]) => `${name}=${value}`).join("&");
}

function normalizeHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * Signs one request and returns the headers to send. Nothing here reads the
 * environment: the caller passes the credentials that its binding selected, so
 * a management read and a gateway invocation cannot end up on the same key by
 * accident.
 */
export function signRequest(
  request: SigV4Request,
  context: SigV4Context,
): SignedRequest {
  const { credentials } = context;
  if (!accessKeyPattern.test(credentials.accessKeyId))
    throw invalid("sigv4.access-key.invalid");
  if (
    credentials.secretAccessKey.length < 1 ||
    credentials.secretAccessKey.length > 256
  )
    throw invalid("sigv4.secret.invalid");
  if (
    credentials.sessionToken !== undefined &&
    (credentials.sessionToken.length < 1 ||
      credentials.sessionToken.length > 8192 ||
      /[^\p{Cc}]*\p{Cc}/u.test(credentials.sessionToken))
  )
    throw invalid("sigv4.session-token.invalid");
  if (
    credentials.expiresAt !== undefined &&
    credentials.expiresAt <= context.now
  )
    throw new ConnectorError("expired", { detail: "sigv4.credentials.expired" });
  if (!regionPattern.test(context.region)) throw invalid("sigv4.region.invalid");
  if (!servicePattern.test(context.service))
    throw invalid("sigv4.service.invalid");

  const amzDate = amzDateTime(context.now);
  const date = amzDate.slice(0, 8);
  const payload = request.payload ?? "";
  const payloadHash = payload === "" ? EMPTY_PAYLOAD_SHA256 : hashHex(payload);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    const lower = name.toLowerCase();
    if (lower === "authorization" || lower === "host")
      throw invalid("sigv4.header.reserved");
    headers[lower] = normalizeHeaderValue(value);
  }
  headers["host"] = request.url.host;
  headers["x-amz-date"] = amzDate;
  if (credentials.sessionToken !== undefined)
    headers["x-amz-security-token"] = credentials.sessionToken;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${headers[name]}\n`)
    .join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    request.method,
    canonicalUri(request.url.pathname),
    canonicalQueryString(request.url),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${date}/${context.region}/${context.service}/aws4_request`;
  const stringToSign = [
    AWS_SIGV4_ALGORITHM,
    amzDate,
    credentialScope,
    hashHex(canonicalRequest),
  ].join("\n");
  const signature = createHmac(
    "sha256",
    signingKey(
      credentials.secretAccessKey,
      date,
      context.region,
      context.service,
    ),
  )
    .update(stringToSign, "utf8")
    .digest("hex");

  return {
    headers: {
      ...headers,
      authorization: `${AWS_SIGV4_ALGORITHM} Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    canonicalRequest,
    stringToSign,
    credentialScope,
    signature,
    amzDate,
  };
}
