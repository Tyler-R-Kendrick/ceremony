import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject,
} from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Signed agent identity, as `draft-meunier-webbotauth-httpsig-protocol-02`
 * describes it.
 *
 * An agent signs its own requests with an Ed25519 key and publishes the public
 * half at a well-known directory; the origin fetches that directory and checks
 * the signature before deciding whether it is talking to a bot it knows. This
 * is not an authentication method in the sense the rest of the catalog uses —
 * it says nothing about which user is present — so it is modelled as a gate in
 * front of an ordinary ceremony rather than as a flow of its own.
 *
 * One signature covers `@authority` only. The draft requires at least one of
 * `@authority` or `@target-uri`, and covering the authority means a single
 * signature stays valid for every request to that host until it expires, which
 * is what lets a browser carry it as an ordinary header for a whole ceremony.
 */

const base64url = (value: Buffer) => value.toString("base64url");

export type SignatureKey = {
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** RFC 7638 JWK thumbprint, which is the `keyid` the draft requires. */
  keyId: string;
  jwk: { kty: "OKP"; crv: "Ed25519"; x: string };
};

export function createSignatureKey(): SignatureKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const exported = publicKey.export({ format: "jwk" }) as { x: string };
  const jwk = { kty: "OKP", crv: "Ed25519", x: exported.x } as const;
  // The thumbprint is taken over the required members in lexicographic order
  // with no whitespace, which for an OKP key is crv, kty, x.
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return {
    privateKey,
    publicKey,
    keyId: base64url(createHash("sha256").update(canonical).digest()),
    jwk,
  };
}

export type SignatureOptions = {
  /** Seconds until the signature expires. The draft recommends at most 24h. */
  lifetimeSeconds?: number;
  /** Seconds to shift `created`, to produce one that has already lapsed. */
  ageSeconds?: number;
  /** Overrides the `web-bot-auth` tag, to produce one an origin discards. */
  tag?: string;
  /** Sign with a key the directory does not publish. */
  signWith?: KeyObject;
};

/**
 * The signature base of RFC 9421: one line per covered component, then the
 * signature parameters, with no trailing newline.
 */
function signatureBase(authority: string, params: string): string {
  return `"@authority": ${authority}\n"@signature-params": ${params}`;
}

/**
 * Headers an agent adds to every request to `authority`, proving which bot it
 * is. `directory` is where the origin will look for the public key.
 */
export function signRequestHeaders(
  key: SignatureKey,
  authority: string,
  directory: string,
  options: SignatureOptions = {},
): Record<string, string> {
  const now = Math.floor(Date.now() / 1000) - (options.ageSeconds ?? 0);
  const created = now;
  const expires = created + (options.lifetimeSeconds ?? 300);
  const params =
    `("@authority");created=${created};expires=${expires};` +
    `keyid="${key.keyId}";alg="ed25519";tag="${options.tag ?? "web-bot-auth"}"`;
  const signature = signBytes(
    null,
    Buffer.from(signatureBase(authority, params), "utf8"),
    options.signWith ?? key.privateKey,
  );
  return {
    "signature-input": `sig=${params}`,
    signature: `sig=:${signature.toString("base64")}:`,
    "signature-agent": `sig="${directory}";type=directory`,
  };
}

export type SignatureVerdict =
  | { ok: true; keyId: string }
  | {
      ok: false;
      why:
        | "absent"
        | "malformed"
        | "untagged"
        | "expired"
        | "unknown-key"
        | "bad-signature"
        | "no-directory";
    };

/** Parse `sig=(...);a=b;c="d"` into its covered components and parameters. */
function parseSignatureInput(
  header: string,
):
  | { components: string[]; params: Record<string, string>; raw: string }
  | undefined {
  const match = /^[^=]+=(\(([^)]*)\)(.*))$/.exec(header.trim());
  if (!match) return undefined;
  const components = (match[2] ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((entry) => entry.replace(/^"|"$/g, ""));
  const params: Record<string, string> = {};
  for (const part of (match[3] ?? "").split(";")) {
    const pair = /^([a-z]+)=(.*)$/.exec(part.trim());
    if (pair?.[1] && pair[2] !== undefined)
      params[pair[1]] = pair[2].replace(/^"|"$/g, "");
  }
  return { components, params, raw: match[1] ?? "" };
}

/**
 * Verify a request's signature the way an origin would: read the agent's
 * directory, find the key the signature names, and check it over the base the
 * signature says it covers. Every refusal names its own reason, because "403"
 * on its own tells an agent nothing about what to fix.
 */
export async function verifyRequestSignature(
  headers: Record<string, string | string[] | undefined>,
  authority: string,
  options: { fetchDirectory?: typeof fetch } = {},
): Promise<SignatureVerdict> {
  const single = (name: string) => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const input = single("signature-input");
  const signature = single("signature");
  const agent = single("signature-agent");
  if (!input || !signature) return { ok: false, why: "absent" };
  const parsed = parseSignatureInput(input);
  if (!parsed) return { ok: false, why: "malformed" };
  // A signature that is not tagged for this purpose is not for us to act on.
  if (parsed.params["tag"] !== "web-bot-auth")
    return { ok: false, why: "untagged" };
  const created = Number(parsed.params["created"]);
  const expires = Number(parsed.params["expires"]);
  if (!Number.isFinite(created) || !Number.isFinite(expires))
    return { ok: false, why: "malformed" };
  // At least one of these must be covered, or the signature says nothing about
  // where the request was going.
  if (!parsed.components.some((name) => name === "@authority"))
    return { ok: false, why: "malformed" };
  const now = Math.floor(Date.now() / 1000);
  if (now >= expires || created > now + 5) return { ok: false, why: "expired" };
  const directory = /"([^"]+)"/.exec(agent ?? "")?.[1];
  if (!directory) return { ok: false, why: "no-directory" };

  const get = options.fetchDirectory ?? fetch;
  let keys: { x?: string; kty?: string; crv?: string }[];
  try {
    const response = await get(
      `${directory}/.well-known/http-message-signatures-directory`,
      { redirect: "error" },
    );
    // The draft is explicit: anything but 200 is a discovery failure, and a
    // verifier must not follow redirects to find one.
    if (response.status !== 200) return { ok: false, why: "no-directory" };
    keys = ((await response.json()) as { keys?: unknown[] }).keys as never[];
  } catch {
    return { ok: false, why: "no-directory" };
  }
  if (!Array.isArray(keys)) return { ok: false, why: "no-directory" };

  const keyId = parsed.params["keyid"] ?? "";
  const published = keys.find((jwk) => {
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x) return false;
    const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
    return base64url(createHash("sha256").update(canonical).digest()) === keyId;
  });
  if (!published) return { ok: false, why: "unknown-key" };

  const raw = /:([^:]*):/.exec(signature)?.[1];
  if (!raw) return { ok: false, why: "malformed" };
  const verified = verifyBytes(
    null,
    Buffer.from(signatureBase(authority, parsed.raw), "utf8"),
    createPublicKey({ key: published as never, format: "jwk" }),
    Buffer.from(raw, "base64"),
  );
  return verified ? { ok: true, keyId } : { ok: false, why: "bad-signature" };
}

/**
 * The agent's published key directory. A real one belongs to whoever operates
 * the bot, not to the site being visited, so it is a separate origin here too.
 */
export async function startSignatureDirectory(
  keys: readonly SignatureKey[],
  options: { status?: number } = {},
): Promise<{ origin: string; reads(): number; close(): Promise<void> }> {
  let reads = 0;
  const server: Server = createServer((request, response) => {
    if (
      request.url !== "/.well-known/http-message-signatures-directory" ||
      request.method !== "GET"
    ) {
      response.writeHead(404).end();
      return;
    }
    reads += 1;
    response.writeHead(options.status ?? 200, {
      "content-type": "application/http-message-signatures-directory+json",
    });
    response.end(JSON.stringify({ keys: keys.map((key) => key.jwk) }));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  let shut = false;
  return {
    origin: `http://127.0.0.1:${port}`,
    reads: () => reads,
    close: async () => {
      if (shut) return;
      shut = true;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** Present only so a caller can sign with a key the directory never lists. */
export function unpublishedKey(): KeyObject {
  return generateKeyPairSync("ed25519").privateKey;
}
