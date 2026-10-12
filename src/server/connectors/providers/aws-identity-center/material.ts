import type { AdapterCallContext } from "../../adapter.js";
import { connectionCredentialScope } from "../../auth/connector-oauth.js";
import { ConnectorError } from "../../errors.js";
import type { CredentialMaterial, CredentialScope } from "../../ports.js";
const MAX_ACCESS_TOKEN_LIFETIME_MS = 30 * 86_400_000;

/*
 * What custody holds for one connection, as a single record.
 *
 * One record, not several, on purpose: the command layer revokes only the
 * connection's `credentialRef` when a person disconnects, so everything this
 * adapter keeps (the client registration, the IAM Identity Center tokens and
 * the role credentials) must live behind that one reference or a local
 * disconnect would leave a refresh token behind.
 *
 * The custody port refuses `use` on a record past its expiry, and a record's
 * expiry is whatever the newest layer needs: the role credentials once a role
 * is bound, the access token before that. The sign-in tokens are therefore
 * read through `refresh`, whose callback sees the material of an expired
 * record, and a role credential past its expiry is renewed there with a new
 * GetRoleCredentials call before anything uses it.
 *
 * The account id and role name are deliberately not in the record. They are
 * not secrets, a caller is told them, and custody refuses a `use` callback
 * whose result contains any value the record holds: an operation that lists
 * the bound account's roles would be refused for naming its own account. They
 * live in the connection's state, which holds no credential.
 */

export type Phase = "registered" | "signed-in" | "role-bound";

export type RoleMaterial = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
};

export type SessionMaterial = {
  phase: Phase;
  clientId: string;
  clientSecret: string;
  /** Epoch milliseconds. */
  clientSecretExpiresAt: number;
  accessToken?: string;
  accessTokenExpiresAt?: number;
  refreshToken?: string;
  role?: RoleMaterial;
};

function malformed(): ConnectorError {
  return new ConnectorError("conflict", {
    detail: "aws-identity-center.credential.malformed",
  });
}

function integer(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw malformed();
  return parsed;
}

export function parseMaterial(raw: CredentialMaterial): SessionMaterial {
  const phase = raw["phase"];
  const clientId = raw["client_id"];
  const clientSecret = raw["client_secret"];
  const clientSecretExpiresAt = integer(raw["client_secret_expires_at"]);
  if (
    (phase !== "registered" &&
      phase !== "signed-in" &&
      phase !== "role-bound") ||
    !clientId ||
    !clientSecret ||
    clientSecretExpiresAt === undefined
  )
    throw malformed();
  const material: SessionMaterial = {
    phase,
    clientId,
    clientSecret,
    clientSecretExpiresAt,
  };
  const accessToken = raw["sso_access_token"];
  if (accessToken) {
    const expires = integer(raw["sso_access_token_expires_at"]);
    if (expires === undefined) throw malformed();
    material.accessToken = accessToken;
    material.accessTokenExpiresAt = expires;
  }
  if (raw["sso_refresh_token"])
    material.refreshToken = raw["sso_refresh_token"];
  if (phase === "registered" && accessToken) throw malformed();
  if (phase !== "registered" && !accessToken) throw malformed();
  if (phase === "role-bound") {
    const keyId = raw["access_key_id"];
    const secret = raw["secret_access_key"];
    const session = raw["session_token"];
    const expires = integer(raw["role_expires_at"]);
    if (!keyId || !secret || !session || expires === undefined)
      throw malformed();
    material.role = {
      accessKeyId: keyId,
      secretAccessKey: secret,
      sessionToken: session,
      expiresAt: expires,
    };
  }
  return material;
}

export function serializeMaterial(
  material: SessionMaterial,
): CredentialMaterial {
  const out: Record<string, string> = {
    phase: material.phase,
    client_id: material.clientId,
    client_secret: material.clientSecret,
    client_secret_expires_at: String(material.clientSecretExpiresAt),
  };
  if (material.accessToken !== undefined) {
    out["sso_access_token"] = material.accessToken;
    out["sso_access_token_expires_at"] = String(material.accessTokenExpiresAt);
  }
  if (material.refreshToken !== undefined)
    out["sso_refresh_token"] = material.refreshToken;
  if (material.role) {
    out["access_key_id"] = material.role.accessKeyId;
    out["secret_access_key"] = material.role.secretAccessKey;
    out["session_token"] = material.role.sessionToken;
    out["role_expires_at"] = String(material.role.expiresAt);
  }
  return out;
}

/** The expiry custody enforces: the role's once one is bound, else the newest layer's. */
export function custodyExpiry(material: SessionMaterial): number {
  return (
    material.role?.expiresAt ??
    material.accessTokenExpiresAt ??
    material.clientSecretExpiresAt
  );
}

export function sessionScope(ctx: AdapterCallContext): CredentialScope {
  return connectionCredentialScope(ctx);
}

/**
 * Runs `work` with the parsed material of a record that is still usable.
 * The result must not contain material; custody refuses it if it does.
 */
export function withSession<T>(
  ctx: AdapterCallContext,
  ref: string,
  work: (material: SessionMaterial) => Promise<T>,
): Promise<T> {
  return ctx.environment.credentials.use(sessionScope(ctx), ref, (raw) =>
    work(parseMaterial(raw)),
  );
}

/**
 * What a rotation's work throws when it already holds material that must be
 * written although the rest of the work failed. A refresh token is single use:
 * once CreateToken has answered a refresh, the answer holds the only token
 * that works, so a failure after it (the portal throttling, a timeout) must
 * not drop it. The rotation writes `material`, then throws `failure`.
 */
export class KeptWithFailure extends Error {
  constructor(
    readonly material: SessionMaterial,
    readonly failure: unknown,
  ) {
    super("the rotation kept its material and failed");
    this.name = "KeptWithFailure";
  }
}

/**
 * Computes the next material from the current under custody's single-flight
 * rotation. The callback sees the record even when it has expired. It returns
 * the next material, and the record's expiry is derived from it so a caller
 * cannot forget to move it. Work that fails by throwing {@link KeptWithFailure}
 * has its material written first and its failure rethrown afterwards.
 */
export async function rotateSession(
  ctx: AdapterCallContext,
  ref: string,
  work: (current: SessionMaterial) => Promise<SessionMaterial>,
): Promise<{ ref: string; expiresAt: number }> {
  const kept: { failure?: unknown; failed: boolean } = { failed: false };
  const result = await ctx.environment.credentials.refresh(
    sessionScope(ctx),
    ref,
    async (raw) => {
      let next: SessionMaterial;
      try {
        next = await work(parseMaterial(raw));
      } catch (error) {
        if (!(error instanceof KeptWithFailure)) throw error;
        kept.failed = true;
        kept.failure = error.failure;
        next = error.material;
      }
      return {
        material: serializeMaterial(next),
        expiresAt: custodyExpiry(next),
      };
    },
  );
  if (kept.failed) throw kept.failure;
  return { ref: result.ref, expiresAt: result.expiresAt ?? 0 };
}

type TokenReply = {
  accessToken: string;
  tokenType?: string | undefined;
  expiresIn: number;
  refreshToken?: string | undefined;
};

/** The material after the person approved: tokens added, the registration kept for refresh. */
export function signedIn(
  current: SessionMaterial,
  tokens: TokenReply,
  now: number,
): SessionMaterial {
  if (
    tokens.tokenType !== undefined &&
    tokens.tokenType.toLowerCase() !== "bearer"
  )
    throw new ConnectorError("upstream-rejected", {
      detail: "aws-identity-center.token.type",
    });
  const lifetime = Math.min(
    Math.max(1, tokens.expiresIn) * 1000,
    MAX_ACCESS_TOKEN_LIFETIME_MS,
  );
  const next: SessionMaterial = {
    ...current,
    phase: current.phase === "role-bound" ? "role-bound" : "signed-in",
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: now + lifetime,
  };
  const refreshToken = tokens.refreshToken ?? current.refreshToken;
  if (refreshToken !== undefined) next.refreshToken = refreshToken;
  return next;
}
