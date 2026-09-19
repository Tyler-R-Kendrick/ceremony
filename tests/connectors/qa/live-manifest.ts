/*
 * QA-06. The opt-in authorized-live and deployed smoke-test manifests.
 *
 * Nothing here can produce evidence on its own. Each entry declares exactly
 * which environment variables must be present, which account and resource the
 * check is scoped to, the one approved non-destructive operation it may
 * perform, how its transcript is redacted and what it must clean up. The
 * evaluator is fail-closed: if any prerequisite or the explicit consent token
 * is absent, the entry's outcome is `blocked` and the result names every
 * missing prerequisite. There is no path from a fixture to a live label.
 */

export type SmokeKind = "live-authorized" | "deployed";

export type SmokeEntry = {
  /** Stable id used in the evidence record and in ledgers. */
  id: string;
  kind: SmokeKind;
  ecosystem: string;
  /** Work items and oracles this check would upgrade if it ever ran. */
  acceptanceIds: readonly string[];
  /** Every environment variable that must be present, by exact name. */
  requires: readonly string[];
  /**
   * The authorized account this check may touch, named so an operator can
   * confirm the scope before granting consent. Never inferred at run time.
   */
  accountScope: string;
  /** The single resource the operation may name. */
  resourceScope: string;
  /** The one approved operation: read-only, no upstream state change. */
  operation: {
    description: string;
    method: "GET" | "POST";
    path: string;
    effect: "read";
  };
  /** Names whose values must be removed from any recorded transcript. */
  redact: readonly string[];
  /** What the check creates and must remove; empty when it creates nothing. */
  cleanup: readonly string[];
};

/**
 * The consent token an operator sets deliberately. A credential being present
 * in the environment is not consent to use it, so this is required in
 * addition to every provider prerequisite.
 */
export const CONSENT_VARIABLE = "CEREMONY_CONNECTOR_LIVE_CONSENT";

/** The exact value the consent variable must carry; a truthy string is not enough. */
export const CONSENT_VALUE = "i-authorize-live-connector-smoke-tests";

export const liveSmokeManifest: readonly SmokeEntry[] = Object.freeze([
  {
    id: "live.nango.integrations.list",
    kind: "live-authorized",
    ecosystem: "nango",
    acceptanceIds: ["AC-NG-01", "AC-NG-08"],
    requires: [
      "CEREMONY_LIVE_NANGO_SECRET_KEY",
      "CEREMONY_LIVE_NANGO_ENVIRONMENT",
      "CEREMONY_LIVE_NANGO_INTEGRATION",
    ],
    accountScope:
      "the Nango environment named by CEREMONY_LIVE_NANGO_ENVIRONMENT, owned by the operator granting consent",
    resourceScope:
      "the single integration named by CEREMONY_LIVE_NANGO_INTEGRATION",
    operation: {
      description:
        "List the environment's integrations and confirm the named one exists.",
      method: "GET",
      path: "/integrations",
      effect: "read",
    },
    redact: [
      "CEREMONY_LIVE_NANGO_SECRET_KEY",
      "authorization",
      "connect_link",
      "token",
    ],
    cleanup: [],
  },
  {
    id: "live.supabase.management.projects.list",
    kind: "live-authorized",
    ecosystem: "supabase",
    acceptanceIds: ["AC-SB-02", "AC-SB-03"],
    requires: [
      "CEREMONY_LIVE_SUPABASE_MANAGEMENT_TOKEN",
      "CEREMONY_LIVE_SUPABASE_ORGANIZATION",
      "CEREMONY_LIVE_SUPABASE_PROJECT_REF",
    ],
    accountScope:
      "the Supabase organization named by CEREMONY_LIVE_SUPABASE_ORGANIZATION",
    resourceScope:
      "the single project named by CEREMONY_LIVE_SUPABASE_PROJECT_REF",
    operation: {
      description:
        "Read the project list and confirm the named project is visible to the management principal.",
      method: "GET",
      path: "/v1/projects",
      effect: "read",
    },
    redact: [
      "CEREMONY_LIVE_SUPABASE_MANAGEMENT_TOKEN",
      "authorization",
      "access_token",
      "refresh_token",
      "db_pass",
    ],
    cleanup: [],
  },
  {
    id: "live.vercel.connect.connectors.list",
    kind: "live-authorized",
    ecosystem: "vercel",
    acceptanceIds: ["AC-VC-01"],
    requires: [
      "CEREMONY_LIVE_VERCEL_TOKEN",
      "CEREMONY_LIVE_VERCEL_TEAM_ID",
      "CEREMONY_LIVE_VERCEL_PROJECT_ID",
    ],
    accountScope: "the Vercel team named by CEREMONY_LIVE_VERCEL_TEAM_ID",
    resourceScope:
      "the single project named by CEREMONY_LIVE_VERCEL_PROJECT_ID",
    operation: {
      description:
        "Enumerate the team's Connect connectors; no lifecycle or mutation endpoint is in scope.",
      method: "GET",
      path: "/v2/connect/connectors",
      effect: "read",
    },
    redact: ["CEREMONY_LIVE_VERCEL_TOKEN", "authorization", "token"],
    cleanup: [],
  },
  {
    id: "live.mcp-registry.servers.list",
    kind: "live-authorized",
    ecosystem: "mcp-registry",
    acceptanceIds: ["AC-MCP-07"],
    requires: ["CEREMONY_LIVE_MCP_REGISTRY_BASE_URL"],
    accountScope: "anonymous read of a public registry; no account is used",
    resourceScope:
      "the first page of the registry named by CEREMONY_LIVE_MCP_REGISTRY_BASE_URL",
    operation: {
      description: "Read one page of the public server list.",
      method: "GET",
      path: "/v0.1/servers",
      effect: "read",
    },
    redact: ["authorization"],
    cleanup: [],
  },
  {
    id: "deployed.hosted.connector-catalog",
    kind: "deployed",
    ecosystem: "ceremony",
    acceptanceIds: ["AC-PKG-03", "AC-UX-01"],
    requires: [
      "CEREMONY_DEPLOYED_BASE_URL",
      "CEREMONY_DEPLOYED_SESSION_COOKIE",
    ],
    accountScope:
      "the host session named by CEREMONY_DEPLOYED_SESSION_COOKIE on the deployment at CEREMONY_DEPLOYED_BASE_URL",
    resourceScope: "the authenticated connector directory of that deployment",
    operation: {
      description:
        "Read the connector catalog route and confirm it answers with no-store and no live-evidence claims.",
      method: "GET",
      path: "/api/v1/connectors/catalog",
      effect: "read",
    },
    redact: ["CEREMONY_DEPLOYED_SESSION_COOKIE", "cookie", "set-cookie"],
    cleanup: [],
  },
]);

export type SmokeOutcome =
  | {
      id: string;
      kind: SmokeKind;
      outcome: "blocked";
      /** Exact prerequisite names that were absent, in manifest order. */
      missing: string[];
      /** Machine-readable reason code. */
      reason: "missing-consent" | "missing-credentials";
      evidenceLevel: "not-tested";
    }
  | {
      id: string;
      kind: SmokeKind;
      outcome: "ready";
      missing: [];
      reason: "prerequisites-satisfied";
      evidenceLevel: "not-tested";
    };

export type SmokeReport = {
  schemaVersion: 1;
  evaluatedAt: string;
  entries: SmokeOutcome[];
  blocked: number;
  ready: number;
};

/** Reads an environment without ever printing or returning a value. */
function present(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): boolean {
  const value = environment[name];
  return typeof value === "string" && value.length > 0;
}

/**
 * Fail-closed evaluation. Consent is checked first and reported as its own
 * reason so an operator can tell "no credentials" from "credentials but no
 * authorization"; in both cases the outcome is `blocked` and nothing runs.
 */
export function evaluateLiveSmoke(
  environment: Readonly<Record<string, string | undefined>>,
  at: () => number = Date.now,
): SmokeReport {
  const consented = environment[CONSENT_VARIABLE] === CONSENT_VALUE;
  const entries = liveSmokeManifest.map((entry): SmokeOutcome => {
    const missing = entry.requires.filter(
      (name) => !present(environment, name),
    );
    if (!consented)
      return {
        id: entry.id,
        kind: entry.kind,
        outcome: "blocked",
        missing: [CONSENT_VARIABLE, ...missing],
        reason: "missing-consent",
        evidenceLevel: "not-tested",
      };
    if (missing.length > 0)
      return {
        id: entry.id,
        kind: entry.kind,
        outcome: "blocked",
        missing,
        reason: "missing-credentials",
        evidenceLevel: "not-tested",
      };
    return {
      id: entry.id,
      kind: entry.kind,
      outcome: "ready",
      missing: [],
      reason: "prerequisites-satisfied",
      evidenceLevel: "not-tested",
    };
  });
  return {
    schemaVersion: 1,
    evaluatedAt: new Date(at()).toISOString(),
    entries,
    blocked: entries.filter((entry) => entry.outcome === "blocked").length,
    ready: entries.filter((entry) => entry.outcome === "ready").length,
  };
}

/**
 * Replaces every configured secret value, and every bearer credential, with a
 * fixed marker. Applied to any transcript before it is written anywhere.
 */
export const REDACTED = "[redacted]";

export function redactTranscript(
  transcript: string,
  entry: SmokeEntry,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  let out = transcript;
  for (const name of entry.redact) {
    const value = environment[name];
    if (typeof value === "string" && value.length > 0)
      out = out.split(value).join(REDACTED);
    // Header-shaped occurrences are redacted by name as well as by value.
    out = out.replace(
      new RegExp(`("?${escapeRegExp(name)}"?\\s*[:=]\\s*)("?)[^"\\s,}]+`, "gi"),
      `$1$2${REDACTED}`,
    );
  }
  return out.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, `Bearer ${REDACTED}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class LiveSmokeBlocked extends Error {
  constructor(readonly outcome: Extract<SmokeOutcome, { outcome: "blocked" }>) {
    super(
      `Live smoke check ${outcome.id} is blocked: ${outcome.reason} (${outcome.missing.join(", ")})`,
    );
    this.name = "LiveSmokeBlocked";
  }
}

/**
 * The only entry point that may perform a live call. It refuses before any
 * network access when the entry is blocked, and it never substitutes a
 * fixture: a caller that wants fixture evidence must ask the fixture suites
 * for it, which record `protocol-fixture` and nothing stronger.
 */
export async function runLiveSmoke(
  entry: SmokeEntry,
  environment: Readonly<Record<string, string | undefined>>,
  perform: (entry: SmokeEntry) => Promise<{ transcript: string }>,
): Promise<{
  id: string;
  evidenceLevel: SmokeKind;
  transcript: string;
  cleanup: readonly string[];
}> {
  const report = evaluateLiveSmoke(environment);
  const outcome = report.entries.find((item) => item.id === entry.id);
  if (!outcome) throw new Error(`Unknown live smoke entry ${entry.id}`);
  if (outcome.outcome === "blocked") throw new LiveSmokeBlocked(outcome);
  const { transcript } = await perform(entry);
  return {
    id: entry.id,
    evidenceLevel: entry.kind,
    transcript: redactTranscript(transcript, entry, environment),
    cleanup: entry.cleanup,
  };
}
