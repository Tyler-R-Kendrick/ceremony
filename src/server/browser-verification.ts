import {
  loginEvidenceSchema,
  mintReference,
  type LoginEvidence,
  type LoginEvidenceKind,
} from "../core/browser-session-contracts.js";

/**
 * Proving *which account* is logged in, inside *which browser*.
 *
 * A page saying "Signed in as Ada" is a string the page chose to render. So is
 * a logout link, an avatar, and a `data-authenticated` attribute. None of them
 * requires a session to exist, and a provider page under attacker influence —
 * or simply a stale cached render — will show all of them happily. They are
 * useful as a *trigger* to go and check, and useless as the check itself.
 *
 * What is not forgeable is a request that leaves the browser context carrying
 * that context's own cookies and comes back from the provider's origin. That is
 * what a verifier here does. It runs through the exact selected context, so the
 * answer describes that browser and no other, and a different context — even
 * one on the same machine, logged into the same site — cannot satisfy it.
 */

/**
 * A request issued *by the browser context*, not by the server process.
 *
 * Playwright's per-context request API shares the context's cookie jar, which
 * is the entire point: a `fetch` from Node would prove only that the server can
 * reach the provider, which is not the question being asked.
 */
export interface ContextRequestLike {
  get(
    url: string,
    options?: { failOnStatusCode?: boolean; timeout?: number },
  ): Promise<{
    status(): number;
    text(): Promise<string>;
  }>;
}

export type VerificationTarget = {
  /** Issues requests inside the selected browser context. */
  request: ContextRequestLike;
  /** Identity of the browser this context belongs to. */
  browserGeneration: string;
  browserSessionRef: string;
  effectivePlanDigest: string;
};

export type VerificationOutcome =
  | { verified: true; accountRef: string; expiresAt?: string }
  | {
      verified: false;
      reason: "no-session" | "account-mismatch" | "unreachable";
      accountRef?: string;
    };

/**
 * A registered verifier for one origin.
 *
 * A verifier is code that was reviewed and registered by the host. It is never
 * a URL, a regular expression, a selector or a snippet supplied by a model or a
 * caller — those would let whatever chose them decide what "logged in" means.
 */
export type SessionVerifier = {
  verifierRef: string;
  /** A parser change is a new version; evidence records which one ran. */
  verifierVersion: string;
  /** What kind of evidence a success from this verifier constitutes. */
  evidenceKind: Extract<
    LoginEvidenceKind,
    "fixture-verified" | "provider-verified"
  >;
  /** Exact origin this verifier is registered for. No suffix matching. */
  origin: string;
  verify(
    target: VerificationTarget,
    expected: { accountRef?: string | undefined },
  ): Promise<VerificationOutcome>;
};

export class NoVerifier extends Error {
  constructor(readonly origin: string) {
    super(`No registered session verifier for ${origin}`);
    this.name = "NoVerifier";
  }
}

/**
 * The fixture verifier for an owned test provider.
 *
 * It asks the fixture's own identity endpoint, through the browser's cookie
 * jar, who the browser is. The fixture answers 401 without a genuine session
 * cookie, so a page that merely *renders* a signed-in banner cannot produce a
 * success here — which is exactly the case the forged-marker test stages.
 *
 * Its evidence is labelled `fixture-verified` and stays labelled that way in
 * every consumer. It is not, and cannot become, evidence about a live provider.
 */
export function createFixtureVerifier(options: {
  origin: string;
  /** Path of the identity endpoint. Registered, never caller-supplied. */
  path?: string;
}): SessionVerifier {
  const path = options.path ?? "/api/whoami";
  return {
    verifierRef: `fixture:${options.origin}`,
    verifierVersion: "1.0.0",
    evidenceKind: "fixture-verified",
    origin: options.origin,
    async verify(target, expected) {
      let body: string;
      let status: number;
      try {
        const response = await target.request.get(`${options.origin}${path}`, {
          failOnStatusCode: false,
          timeout: 10_000,
        });
        status = response.status();
        body = await response.text();
      } catch {
        return { verified: false, reason: "unreachable" };
      }
      if (status === 401 || status === 403)
        return { verified: false, reason: "no-session" };
      let account: unknown;
      try {
        account = (JSON.parse(body) as { account?: unknown }).account;
      } catch {
        return { verified: false, reason: "unreachable" };
      }
      if (typeof account !== "string" || account.length === 0)
        return { verified: false, reason: "no-session" };
      // An account was found but it is not the one the plan named. This is a
      // mismatch to report, never a licence to log that account out or to
      // switch to another one.
      if (expected.accountRef !== undefined && expected.accountRef !== account)
        return {
          verified: false,
          reason: "account-mismatch",
          accountRef: account,
        };
      return { verified: true, accountRef: account };
    },
  };
}

/**
 * Verifiers by exact origin.
 *
 * Exact, because a suffix test would let `evil-provider.example` be verified by
 * `provider.example`'s verifier, and a caller who can nominate the origin could
 * then choose which verifier judges it.
 */
export function createVerifierRegistry(
  verifiers: readonly SessionVerifier[] = [],
) {
  const byOrigin = new Map<string, SessionVerifier>();
  for (const verifier of verifiers) byOrigin.set(verifier.origin, verifier);
  return {
    register(verifier: SessionVerifier) {
      byOrigin.set(verifier.origin, verifier);
    },
    /**
     * A provider with no registered verifier stops at the honest evidence
     * class. It does not fall back to reading the page, because there is no
     * page reading that would answer the question.
     */
    require(origin: string): SessionVerifier {
      const verifier = byOrigin.get(origin);
      if (!verifier) throw new NoVerifier(origin);
      return verifier;
    },
    find(origin: string): SessionVerifier | undefined {
      return byOrigin.get(origin);
    },
    origins(): readonly string[] {
      return [...byOrigin.keys()];
    },
  };
}

export type VerifierRegistry = ReturnType<typeof createVerifierRegistry>;

/**
 * Turn a successful verification into evidence.
 *
 * Evidence names the verifier, its version, the browser generation and the plan
 * digest. Each of those is something that can change underneath a stored
 * result, and every one of them invalidates it when it does: that is what stops
 * yesterday's success from authorizing today's session.
 */
export function mintLoginEvidence(input: {
  kind: LoginEvidenceKind;
  verifier: Pick<SessionVerifier, "verifierRef" | "verifierVersion">;
  browserSessionRef: string;
  browserGeneration: string;
  accountRef: string;
  effectivePlanDigest: string;
  now: Date;
  freshnessMs?: number;
}): { evidenceRef: string; evidence: LoginEvidence } {
  const evidence = loginEvidenceSchema.parse({
    kind: input.kind,
    verifierRef: input.verifier.verifierRef,
    verifierVersion: input.verifier.verifierVersion,
    browserSessionRef: input.browserSessionRef,
    browserGeneration: input.browserGeneration,
    accountRef: input.accountRef,
    verifiedAt: input.now.toISOString(),
    ...(input.freshnessMs !== undefined
      ? {
          expiresAt: new Date(
            input.now.getTime() + input.freshnessMs,
          ).toISOString(),
        }
      : {}),
    effectivePlanDigest: input.effectivePlanDigest,
  } satisfies LoginEvidence);
  return { evidenceRef: mintReference("bevd"), evidence };
}

/**
 * Evidence for a person's report that they finished.
 *
 * It is recorded because it is worth recording — it explains why an attempt
 * stopped asking — and it is a distinct kind because it proves nothing about
 * which account the browser now holds. No consumer may treat it as
 * verification, which is enforced by keeping `human-attested` out of the set
 * that grants a verified status.
 */
export function mintAttestation(input: {
  browserSessionRef: string;
  browserGeneration: string;
  accountRef: string;
  effectivePlanDigest: string;
  now: Date;
}): { evidenceRef: string; evidence: LoginEvidence } {
  return mintLoginEvidence({
    kind: "human-attested",
    verifier: { verifierRef: "human", verifierVersion: "1.0.0" },
    ...input,
  });
}
