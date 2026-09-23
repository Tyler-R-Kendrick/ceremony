import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { format } from "prettier";
import { z } from "zod";
import { requiredWorkItems } from "./connector-evidence.js";
import {
  computeSupportLabel,
  evidenceLevelSchema,
  legacyCheckTarget,
  liveEvidenceLevels,
  supportEvidenceProblems,
  supportEvidenceSchema,
  supportLabelRules,
  supportLabels,
  type SupportEvidence,
  type SupportLabelResult,
} from "../src/core/connectors/index.js";
import {
  attendedCertificationSchema,
  certificationEvidence,
  certificationProblems,
  certificationTranscriptSchema,
  certifiersSchema,
  digestOf,
  type Certifiers,
} from "../src/server/connectors/certification.js";

/*
 * Generates the public connector support matrix, the human-readable source
 * lock and the joined evidence report.
 *
 * Nothing here is written by hand into a table. Per-dimension support comes
 * from the registered adapters themselves: each adapter module is imported,
 * its factory is constructed with no host configuration, and its own
 * `capabilities(present)` rows are read. Evidence levels, test files and
 * limitations come from the swarm ledgers. Pinned sources come from
 * source-lock.json. An adapter that cannot be constructed without host
 * dependencies is reported as not introspectable rather than guessed at, and
 * a ledger source id with no lock record is reported as a coverage gap rather
 * than dropped.
 *
 * `--check` regenerates in memory and fails on drift, so the published matrix
 * cannot quietly disagree with the code. It performs no network access and
 * runs no tests; test results are read from the evidence report that
 * `npm run evidence:connectors` writes.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const evidenceDirectory = join(
  root,
  "docs/implementation-evidence/connector-interoperability",
);
const ledgerDirectory = join(evidenceDirectory, "ledger");
const sourceLockPath = join(evidenceDirectory, "source-lock.json");
const reportPath = join(evidenceDirectory, "report.json");
const recordedEvidencePath = join(
  root,
  "src/server/connectors/recorded-evidence.ts",
);
const certificationsDirectory = join(evidenceDirectory, "certifications");
const certifiersPath = join(evidenceDirectory, "certifiers.json");

/** The twelve reported dimensions, in the order `supportDimensions` declares them. */
export const dimensions = [
  "discover",
  "import",
  "configure",
  "authorize",
  "verify",
  "invoke",
  "events",
  "reconnect",
  "disconnect",
  "revoke",
  "export",
  "delegate",
] as const;
export type Dimension = (typeof dimensions)[number];

/** The lifecycle column is these three dimensions together; it is not itself a contract dimension. */
export const lifecycleDimensions: Dimension[] = [
  "reconnect",
  "disconnect",
  "revoke",
];

const sourceLockSchema = z.object({
  lockVersion: z.number(),
  pinnedAt: z.string(),
  about: z.string(),
  /** Ledgers whose every cited source profile identifier has a record here. */
  coversLedgers: z.array(z.string()).default([]),
  coversNote: z.string().default(""),
  rules: z.array(z.string()),
  records: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      title: z.string(),
      url: z.string(),
      retrievedAt: z.string(),
      upstreamVersion: z.string(),
      revision: z.string(),
      digest: z.string().nullable(),
      digestNote: z.string().optional(),
      licence: z.object({
        spdx: z.string().nullable().optional(),
        status: z.string().optional(),
        statement: z.string(),
        evidence: z.string(),
      }),
      reuse: z.string(),
      dependents: z.object({
        adapters: z.array(z.string()),
        profiles: z.array(z.string()),
        modules: z.array(z.string()),
      }),
      recordedBy: z.array(z.string()),
      notes: z.string(),
    }),
  ),
});
export type SourceLock = z.infer<typeof sourceLockSchema>;

const ledgerItemSchema = z.object({
  id: z.string(),
  status: z.enum(["implemented", "partial", "unmet"]),
  files: z.array(z.string()).default([]),
  tests: z.array(z.string()).default([]),
  acceptanceIds: z.array(z.string()).default([]),
  evidenceLevel: z.string(),
  sourceProfileIds: z.array(z.string()).default([]),
  limitations: z.array(z.string()).default([]),
  notes: z.string().default(""),
});
const ledgerSchema = z.object({
  swarm: z.string(),
  /**
   * The UTC day this ledger's work items were recorded. It dates their
   * evidence levels for the support-label staleness rule; a ledger without
   * one still joins its requirements, but its items earn no label.
   */
  recordedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  workItems: z.array(ledgerItemSchema).default([]),
  /**
   * Dated support-evidence entries. Each is validated by
   * `supportEvidenceSchema` in `collectSupportEvidence` rather than here, so
   * one malformed entry is named exactly instead of discarding the whole
   * ledger. (Not `evidence`: a swarm already uses that key for prose.)
   */
  supportEvidence: z.array(z.unknown()).default([]),
  unmet: z.array(z.unknown()).default([]),
  /*
   * A sentence or a structured record, as in scripts/connector-evidence.ts.
   * This schema used to accept strings only, so the two ledgers that recorded
   * their effects structurally (AUTOMATION and BINDINGS) failed the shape,
   * were dropped whole, and every adapter they delivered read `not-recorded`
   * in the matrix.
   */
  externalEffectsPerformed: z
    .array(z.union([z.string(), z.record(z.string(), z.unknown())]))
    .default([]),
  securityFindings: z.array(z.unknown()).default([]),
});
export type Ledger = z.infer<typeof ledgerSchema>;

export function loadSourceLock(): SourceLock {
  return sourceLockSchema.parse(
    JSON.parse(readFileSync(sourceLockPath, "utf8")),
  );
}

export function loadLedgers(directory = ledgerDirectory): {
  ledgers: Ledger[];
  problems: string[];
} {
  const ledgers: Ledger[] = [];
  const problems: string[] = [];
  if (!existsSync(directory)) return { ledgers, problems };
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw: unknown = JSON.parse(
        readFileSync(join(directory, name), "utf8"),
      );
      const parsed = ledgerSchema.safeParse(raw);
      if (!parsed.success) {
        // Name the first issues. "Does not match" alone let two ledgers fail
        // on one field unnoticed while their adapters read `not-recorded`.
        problems.push(
          `ledger/${name}: does not match the ledger shape (${parsed.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")})`,
        );
        continue;
      }
      // A ledger with no `workItems` array cannot be joined to the charter's
      // required items at all, so its requirements read as undelivered. That
      // is reported rather than silently treated as an empty delivery.
      if (
        !Array.isArray((raw as Record<string, unknown>)["workItems"]) &&
        parsed.data.workItems.length === 0
      )
        problems.push(
          `ledger/${name}: no \`workItems\` array, so its requirements cannot be joined and are reported as having no ledger entry`,
        );
      ledgers.push(parsed.data);
    } catch {
      problems.push(`ledger/${name}: unreadable JSON`);
    }
  }
  return { ledgers, problems };
}

/** One attended certification record as found on disk, before verification. */
export type CertificationFile = {
  /** The record's file name, for naming it in a refusal. */
  source: string;
  record: unknown;
  /** The value-free transcript shipped beside it, when there is one. */
  transcript?: unknown;
};

/**
 * Reads attended certification records (`certifications/<id>.json`, each with
 * its value-free `<id>.transcript.json`) and the reviewed certifier list.
 * Nothing here trusts a record: `collectSupportEvidence` verifies each one,
 * and an unreadable file or list is a refusal, not an omission.
 */
export function loadCertifications(
  directory = certificationsDirectory,
  certifiersFile = certifiersPath,
): { files: CertificationFile[]; certifiers: Certifiers; problems: string[] } {
  const problems: string[] = [];
  let certifiers: Certifiers = { certifiers: [] };
  if (existsSync(certifiersFile)) {
    const parsed = certifiersSchema.safeParse(
      (() => {
        try {
          return JSON.parse(readFileSync(certifiersFile, "utf8"));
        } catch {
          return undefined;
        }
      })(),
    );
    if (parsed.success) certifiers = parsed.data;
    else problems.push("certifiers.json: does not match the certifier list");
  }
  const files: CertificationFile[] = [];
  if (!existsSync(directory)) return { files, certifiers, problems };
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith(".json") || name.endsWith(".transcript.json")) continue;
    const read = (file: string) => {
      try {
        return JSON.parse(readFileSync(join(directory, file), "utf8"));
      } catch {
        return undefined;
      }
    };
    const record: unknown = read(name);
    if (record === undefined) {
      problems.push(`certifications/${name}: unreadable JSON`);
      continue;
    }
    const transcriptName = name.replace(/\.json$/, ".transcript.json");
    files.push({
      source: `certifications/${name}`,
      record,
      ...(existsSync(join(directory, transcriptName))
        ? { transcript: read(transcriptName) }
        : {}),
    });
  }
  return { files, certifiers, problems };
}

export type CapabilityRow = {
  dimension: string;
  implementation: string;
  configuration?: string;
  evidence?: string;
  limitations?: string[];
  profile?: string;
};

export type AdapterFacts = {
  id: string;
  factory: string;
  module: string;
  ecosystem: string;
  adapterVersion: string;
  runtime: string;
  service: string;
  displayName: string;
  support: string;
  /** "definition" for a generic adapter whose evidence speaks for one definition at a time. */
  evidenceScope: string;
  custody: string[];
  profiles: string[];
  configuration: Array<{
    name: string;
    required: boolean;
    classification: string;
  }>;
  rows: Record<string, CapabilityRow>;
};

export type AdapterProblem = {
  module: string;
  factory: string;
  reason: string;
};

/**
 * Where an adapter factory module may live. `children` scans one level of
 * subdirectories for an `index.ts`; `self` takes the directory's own barrel.
 * Adding a directory here is the only way a new adapter enters this document.
 */
const adapterRoots: Array<{ base: string; mode: "children" | "self" }> = [
  { base: "src/server/connectors/providers", mode: "children" },
  { base: "src/server/connectors/registries", mode: "children" },
  { base: "src/server/connectors/formats", mode: "children" },
  { base: "src/server/connectors/mcp", mode: "self" },
];

function adapterModules(): string[] {
  const modules: string[] = [];
  for (const { base, mode } of adapterRoots) {
    const directory = join(root, base);
    if (!existsSync(directory)) continue;
    if (mode === "self") {
      const index = join(directory, "index.ts");
      if (existsSync(index)) modules.push(relative(root, index));
      continue;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const index = join(directory, entry.name, "index.ts");
      if (existsSync(index)) modules.push(relative(root, index));
    }
  }
  return modules.sort();
}

function isAdapterShaped(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["id"] === "string" &&
    typeof candidate["ecosystem"] === "string" &&
    typeof candidate["capabilities"] === "function"
  );
}

/**
 * Constructs every exported adapter factory with no host configuration and
 * reads the adapter's own capability rows. Construction failures are reported,
 * never inferred around: a factory that needs injected host ports simply has
 * no machine-readable row here.
 */
export async function readAdapters(): Promise<{
  adapters: AdapterFacts[];
  problems: AdapterProblem[];
}> {
  const adapters: AdapterFacts[] = [];
  const problems: AdapterProblem[] = [];
  for (const module of adapterModules()) {
    let loaded: Record<string, unknown>;
    try {
      loaded = (await import(pathToFileURL(join(root, module)).href)) as Record<
        string,
        unknown
      >;
    } catch (error) {
      problems.push({
        module,
        factory: "(module)",
        reason: `import failed: ${(error as Error).message.split("\n")[0]}`,
      });
      continue;
    }
    const factories = Object.keys(loaded)
      .filter((name) => /^create.*(Adapter|Profile)$/.test(name))
      .sort();
    if (factories.length === 0)
      problems.push({
        module,
        factory: "(none)",
        reason:
          "importer-only module: it exports readers and compilers, not a runtime adapter factory",
      });
    for (const factory of factories) {
      const build = loaded[factory];
      if (typeof build !== "function") continue;
      let adapter: unknown;
      try {
        adapter = (build as (options: unknown) => unknown)({});
      } catch (error) {
        problems.push({
          module,
          factory,
          reason: `requires host dependencies: ${(error as Error).message.split("\n")[0]}`,
        });
        continue;
      }
      if (!isAdapterShaped(adapter)) {
        problems.push({
          module,
          factory,
          reason: "constructed value is not adapter-shaped",
        });
        continue;
      }
      const shaped = adapter as Record<string, unknown> & {
        capabilities: (present: ReadonlySet<string>) => CapabilityRow[];
      };
      let rows: CapabilityRow[] = [];
      try {
        rows = shaped.capabilities(new Set<string>());
      } catch (error) {
        problems.push({
          module,
          factory,
          reason: `capabilities() failed with no configuration: ${(error as Error).message.split("\n")[0]}`,
        });
        continue;
      }
      const configuration = Array.isArray(shaped["configuration"])
        ? (shaped["configuration"] as Array<Record<string, unknown>>).map(
            (item) => ({
              name: String(item["name"] ?? ""),
              required: Boolean(item["required"]),
              classification: String(item["classification"] ?? "unknown"),
            }),
          )
        : [];
      adapters.push({
        id: String(shaped["id"]),
        factory,
        module,
        ecosystem: String(shaped["ecosystem"] ?? ""),
        adapterVersion: String(shaped["adapterVersion"] ?? ""),
        runtime: String(shaped["runtime"] ?? ""),
        service: String(shaped["service"] ?? ""),
        displayName: String(shaped["displayName"] ?? ""),
        support: String(shaped["support"] ?? ""),
        evidenceScope: String(shaped["evidenceScope"] ?? "adapter"),
        custody: Array.isArray(shaped["custody"])
          ? (shaped["custody"] as string[]).map(String)
          : [],
        profiles: Array.isArray(shaped["profiles"])
          ? (shaped["profiles"] as string[]).map(String)
          : [],
        configuration,
        rows: Object.fromEntries(rows.map((row) => [row.dimension, row])),
      });
    }
  }
  adapters.sort((a, b) => a.id.localeCompare(b.id));
  return { adapters, problems };
}

/** `implemented (fixture)` style cell text; a dimension with no row is unreported, not supported. */
function cell(row: CapabilityRow | undefined): string {
  if (!row) return "not reported";
  const implementation = row.implementation;
  if (implementation === "unsupported") return "unsupported";
  const parts = [implementation];
  if (row.configuration && row.configuration !== "not-applicable")
    parts.push(row.configuration);
  if (row.evidence && row.evidence !== "not-tested") parts.push(row.evidence);
  return parts.join(" / ");
}

function lifecycleCell(adapter: AdapterFacts): string {
  return lifecycleDimensions
    .map((dimension) => {
      const row = adapter.rows[dimension];
      const state = !row
        ? "not reported"
        : row.implementation === "unsupported"
          ? "unsupported"
          : row.implementation;
      return `${dimension}: ${state}`;
    })
    .join("; ");
}

function requiredConfiguration(adapter: AdapterFacts): string {
  const required = adapter.configuration.filter((item) => item.required);
  if (required.length === 0) return "none";
  return required
    .map((item) => `\`${item.name}\` (${item.classification})`)
    .join(", ");
}

function limitationsFor(adapter: AdapterFacts): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const dimension of dimensions) {
    const row = adapter.rows[dimension];
    for (const limitation of row?.limitations ?? []) {
      const text = `${dimension}: ${limitation}`;
      if (seen.has(text)) continue;
      seen.add(text);
      output.push(text);
    }
  }
  return output;
}

export type EvidenceIndex = {
  /** adapter id or module prefix -> ledger work items whose files touch it */
  byModule: Map<
    string,
    Array<{ swarm: string; item: z.infer<typeof ledgerItemSchema> }>
  >;
};

function indexLedgers(ledgers: Ledger[]): EvidenceIndex {
  const byModule = new Map<
    string,
    Array<{ swarm: string; item: z.infer<typeof ledgerItemSchema> }>
  >();
  for (const ledger of ledgers)
    for (const item of ledger.workItems)
      for (const file of item.files) {
        const directory = file.split("/").slice(0, -1).join("/");
        const list = byModule.get(directory) ?? [];
        list.push({ swarm: ledger.swarm, item });
        byModule.set(directory, list);
      }
  return { byModule };
}

/** Ledger evidence for the directory an adapter module lives in. */
function evidenceFor(
  adapter: AdapterFacts,
  index: EvidenceIndex,
): { level: string; tests: string[]; swarms: string[] } {
  const directory = adapter.module.split("/").slice(0, -1).join("/");
  const matches = index.byModule.get(directory) ?? [];
  const order = [
    "not-tested",
    "unit",
    "protocol-fixture",
    "local-integration",
    "browser-integration",
    "live-authorized",
    "deployed-authorized",
  ];
  let level = "not-recorded";
  const tests = new Set<string>();
  const swarms = new Set<string>();
  for (const match of matches) {
    swarms.add(match.swarm);
    for (const test of match.item.tests) tests.add(test);
    const current = order.indexOf(level);
    const candidate = order.indexOf(match.item.evidenceLevel);
    if (candidate > current) level = match.item.evidenceLevel;
  }
  return {
    level,
    tests: [...tests].sort(),
    swarms: [...swarms].sort(),
  };
}

export type SupportEvidenceCollection = {
  /** Every admissible entry, explicit and derived, sorted. */
  entries: SupportEvidence[];
  /** The ledger each entry came from, keyed like `entryKey`. */
  sources: Map<string, string>;
  /** Entries refused: malformed, future-dated, unknown adapter or missing check file. Any one fails generation. */
  refused: string[];
  /** Ledgers whose work items earn no label, and why. Reported, not fatal. */
  notes: string[];
  /** The newest day any entry was recorded: the day the published labels are evaluated as of. */
  asOf?: string;
};

const entryKey = (entry: SupportEvidence) =>
  `${entry.adapterId}\u0000${entry.check}\u0000${entry.target}\u0000${entry.recordedAt}`;

/**
 * Turns the ledgers into support-evidence entries.
 *
 * Explicit entries (a ledger's `supportEvidence` array) are validated by the core
 * schema and refused, by name, when malformed, dated after `today`, naming an
 * adapter this generator cannot construct, or citing a repository path that
 * does not exist: a label may only rest on a check a reader can open.
 *
 * Work items recorded before entries existed are still evidence, dated by
 * their ledger's `recordedAt`. Each becomes one entry per adapter it joins
 * (by module directory, exactly as the evidence column joins them), with
 * check `ledger:<SWARM>/<ID>` and the weakest target its level could mean
 * (`legacyCheckTarget`), which is never above an in-process fixture. A
 * legacy live level is refused: a live claim needs an explicit entry that
 * names its check, its day and, if attended, who attended it. A ledger with
 * no `recordedAt` earns nothing, and says so.
 *
 * The published labels are then evaluated as of the newest recorded day,
 * not the wall clock, so `--check` cannot drift on a calendar tick; the
 * runtime evaluates the same entries against its own clock.
 */
export function collectSupportEvidence(
  ledgers: Ledger[],
  adapters: AdapterFacts[],
  options: {
    today: number;
    exists?: (path: string) => boolean;
    /** Attended certification records; see `loadCertifications`. */
    certifications?: readonly CertificationFile[];
    /** The reviewed certifier list those records are verified against. */
    certifiers?: Certifiers;
  },
): SupportEvidenceCollection {
  const exists =
    options.exists ?? ((path: string) => existsSync(join(root, path)));
  const known = new Set(adapters.map((adapter) => adapter.id));
  const byDirectory = new Map<string, string[]>();
  for (const adapter of adapters) {
    const directory = adapter.module.split("/").slice(0, -1).join("/");
    byDirectory.set(directory, [
      ...(byDirectory.get(directory) ?? []),
      adapter.id,
    ]);
  }
  const entries = new Map<string, SupportEvidence>();
  const sources = new Map<string, string>();
  const refused: string[] = [];
  const notes: string[] = [];
  const admit = (entry: SupportEvidence, swarm: string) => {
    entries.set(entryKey(entry), entry);
    sources.set(entryKey(entry), swarm);
  };
  for (const ledger of ledgers) {
    const problems = supportEvidenceProblems(ledger.supportEvidence, {
      asOf: options.today,
    });
    for (const problem of problems)
      refused.push(`ledger ${ledger.swarm}: ${problem}`);
    ledger.supportEvidence.forEach((raw, index) => {
      const parsed = supportEvidenceSchema.safeParse(raw);
      if (!parsed.success) return;
      if (problems.some((problem) => problem.startsWith(`evidence[${index}]`)))
        return;
      const entry = parsed.data;
      if (!known.has(entry.adapterId)) {
        refused.push(
          `ledger ${ledger.swarm}: evidence[${index}]: no constructible adapter is named ${entry.adapterId}`,
        );
        return;
      }
      if (!entry.check.includes(":") && !exists(entry.check)) {
        refused.push(
          `ledger ${ledger.swarm}: evidence[${index}]: ${entry.check} does not exist`,
        );
        return;
      }
      // An attendee's name in a ledger is a claim anybody can type; only a
      // signed record the certifier list vouches for is an attendance.
      if (entry.target === "attended-live") {
        refused.push(
          `ledger ${ledger.swarm}: evidence[${index}]: an attended certification enters only as a signed record under certifications/`,
        );
        return;
      }
      admit(entry, ledger.swarm);
    });

    if (!ledger.recordedAt) {
      if (ledger.workItems.length > 0)
        notes.push(
          `ledger ${ledger.swarm} has no \`recordedAt\`, so its work items earn no support label`,
        );
      continue;
    }
    for (const item of ledger.workItems) {
      const level = evidenceLevelSchema.safeParse(item.evidenceLevel);
      if (
        level.success &&
        (liveEvidenceLevels as readonly string[]).includes(level.data)
      ) {
        refused.push(
          `ledger ${ledger.swarm}: ${item.id}: legacy level ${level.data} is refused; a live level needs an explicit, dated, attributed entry`,
        );
        continue;
      }
      const target = level.success ? legacyCheckTarget(level.data) : undefined;
      if (!target) continue;
      const joined = new Set<string>();
      for (const file of item.files)
        for (const adapterId of byDirectory.get(
          file.split("/").slice(0, -1).join("/"),
        ) ?? [])
          joined.add(adapterId);
      for (const adapterId of [...joined].sort()) {
        const candidate = {
          adapterId,
          check: `ledger:${ledger.swarm}/${item.id}`,
          target,
          recordedAt: ledger.recordedAt,
        };
        const problems = supportEvidenceProblems([candidate], {
          asOf: options.today,
        });
        if (problems.length > 0) {
          refused.push(
            `ledger ${ledger.swarm}: ${item.id}: ${problems.join("; ")}`,
          );
          continue;
        }
        admit(supportEvidenceSchema.parse(candidate), ledger.swarm);
      }
    }
  }
  const scopes = new Map(
    adapters.map((adapter) => [adapter.id, adapter.evidenceScope]),
  );
  for (const file of options.certifications ?? []) {
    const problems = certificationProblems(
      file.record,
      options.certifiers ?? { certifiers: [] },
      { asOf: options.today },
    );
    const record = attendedCertificationSchema.safeParse(file.record);
    if (record.success) {
      if (!known.has(record.data.adapterId))
        problems.push(
          `no constructible adapter is named ${record.data.adapterId}`,
        );
      // A generic adapter's certification is about the definition it ran;
      // without one it would describe a code path, which no person attends.
      if (
        scopes.get(record.data.adapterId) === "definition" &&
        !record.data.definition
      )
        problems.push("a generic adapter's certification names its definition");
      const transcript = certificationTranscriptSchema.safeParse(
        file.transcript,
      );
      if (!transcript.success)
        problems.push("its value-free transcript is missing or malformed");
      else if (digestOf(transcript.data) !== record.data.transcript.digest)
        problems.push("its transcript does not match the signed digest");
    }
    if (problems.length > 0 || !record.success) {
      refused.push(`${file.source}: ${problems.join("; ")}`);
      continue;
    }
    admit(certificationEvidence(record.data), file.source);
  }
  const sorted = [...entries.values()].sort((a, b) =>
    entryKey(a).localeCompare(entryKey(b)),
  );
  const asOf = sorted.reduce<string | undefined>(
    (latest, entry) =>
      !latest || entry.recordedAt > latest ? entry.recordedAt : latest,
    undefined,
  );
  return {
    entries: sorted,
    sources,
    refused,
    notes,
    ...(asOf ? { asOf } : {}),
  };
}

/** The published label for one adapter, evaluated as of the collection's day. */
export function labelFor(
  adapter: AdapterFacts,
  collection: SupportEvidenceCollection,
): SupportLabelResult {
  const configured = adapter.configuration.every((item) => !item.required);
  return computeSupportLabel(adapter.id, collection.entries, {
    asOf: collection.asOf ? Date.parse(`${collection.asOf}T00:00:00.000Z`) : 0,
    configured,
    // Adapter-wide: the row describes the code path, never one definition.
    definitionScoped: adapter.evidenceScope === "definition",
  });
}

function labelBasis(result: SupportLabelResult): string {
  if (!result.basis) return "no fresh entry";
  const check = result.basis.check.includes(":")
    ? result.basis.check
    : `\`${result.basis.check}\``;
  return `${check} (${result.basis.target}, ${result.basis.recordedAt})`;
}

/**
 * The runtime copy of the collected entries. It is generated rather than
 * read from docs/ at run time because a packaged deployment has no docs/,
 * and generated rather than hand-kept so it cannot disagree with the ledgers:
 * `--check` compares it like any other output.
 */
export function renderRecordedEvidence(
  collection: SupportEvidenceCollection,
): string {
  return [
    "/*",
    " * Generated by scripts/connector-support-matrix.ts from the dated evidence in",
    " * docs/implementation-evidence/connector-interoperability/ledger. Do not edit:",
    " * add a dated entry to a ledger and regenerate. `npm run docs:connectors:check`",
    " * fails when this file drifts from the ledgers. An entry is live only when it",
    " * came from a signed attended certification the generator verified; a",
    " * deployment adds its own live or attended entries through",
    " * `ConnectorRuntimeOptions.support.evidence`.",
    " */",
    'import type { SupportEvidence } from "../../core/connectors/index.js";',
    "",
    "/** The newest day any entry below was recorded. */",
    `export const recordedEvidenceAsOf = ${JSON.stringify(collection.asOf ?? "")};`,
    "",
    `export const recordedSupportEvidence: readonly SupportEvidence[] = ${JSON.stringify(collection.entries)};`,
    "",
  ].join("\n");
}

export function renderSupportMatrix(input: {
  adapters: AdapterFacts[];
  adapterProblems: AdapterProblem[];
  ledgers: Ledger[];
  lock: SourceLock;
  evidence: SupportEvidenceCollection;
}): string {
  const index = indexLedgers(input.ledgers);
  const labels = new Map(
    input.adapters.map((adapter) => [
      adapter.id,
      labelFor(adapter, input.evidence),
    ]),
  );
  const label = (adapter: AdapterFacts) => labels.get(adapter.id)!;
  const expired = input.adapters.flatMap((adapter) =>
    label(adapter).expired.map((entry) => ({ adapter, entry })),
  );
  const columns: Array<{ heading: string; dimension?: Dimension }> = [
    { heading: "Import", dimension: "import" },
    { heading: "Configure", dimension: "configure" },
    { heading: "Authorize", dimension: "authorize" },
    { heading: "Verify", dimension: "verify" },
    { heading: "Invoke", dimension: "invoke" },
    { heading: "Events", dimension: "events" },
    { heading: "Export", dimension: "export" },
  ];
  const lines: string[] = [
    "# Connector support matrix",
    "",
    "Status: **generated**. Do not edit this file. It is produced by `node --import tsx scripts/connector-support-matrix.ts` from three sources: the registered adapters themselves (each factory is constructed with no host configuration and its own `capabilities(present)` rows are read), the swarm ledgers under [`ledger/`](../implementation-evidence/connector-interoperability/ledger), and the [source lock](../implementation-evidence/connector-interoperability/source-lock.json).",
    "",
    "Read it with three rules in mind.",
    "",
    "- **A dimension is not a boolean.** `implemented` means code exists and is exercised. `requires-configuration` means implemented but not usable in a deployment that lacks the named configuration. `unsupported` is a reported negative capability, and the limitation column says why.",
    "- **Evidence is not certification.** Every level below is `unit`, `protocol-fixture` or `local-integration`. No live vendor credential exists in this environment, so no row anywhere claims live or vendor-certified behaviour. A loopback double proving wire correctness is not a provider's endorsement.",
    "- **Rows are measured with no configuration present.** `capabilities(new Set())` is what a fresh deployment sees. A dimension shown as `requires-configuration` becomes usable once the named configuration is supplied and the host approves a binding, not before.",
    "",
    `Generated from ${input.adapters.length} constructible adapter${input.adapters.length === 1 ? "" : "s"} and ${input.ledgers.length} ledger${input.ledgers.length === 1 ? "" : "s"}.`,
    "",
    "## Support labels",
    "",
    `A support label is computed from dated evidence entries, never from the adapter family (\`computeSupportLabel\` in \`src/core/connectors/support-labels.ts\`). The label is the strongest one any fresh, admissible entry earns. An entry older than its window has expired and earns nothing. Live and certified entries count only where the configuration they were measured with is present. The labels below are evaluated as of ${input.evidence.asOf ?? "no recorded day"}, the newest day any entry was recorded; a running deployment evaluates the same entries against its own clock, so they can only lapse there, never strengthen.`,
    "",
    "| Label | Earned by at least one entry against | Fresh for | Needs configuration |",
    "| --- | --- | --- | --- |",
    "| `unverified` | nothing: no fresh entry | — | — |",
    ...supportLabels.flatMap((name) =>
      name === "unverified"
        ? []
        : [
            `| \`${name}\` | \`${supportLabelRules[name].target}\` or stronger | ${supportLabelRules[name].freshForDays} days | ${supportLabelRules[name].needsConfiguration ? "yes" : "no"} |`,
          ],
    ),
    "",
    "Work items recorded before entries were dated carry only an evidence level, which names no check and no target. Each counts at most as an in-process fixture, dated by its ledger's `recordedAt`, and a legacy live level is refused. Raising an adapter above `fixture` therefore takes an explicit entry naming its target and the test that ran.",
    "",
    `An \`attended-live\` entry enters only from a signed record under \`certifications/\`, verified against the reviewed \`certifiers.json\` (see [attended certification](../certification.md)); an attended entry typed into a ledger is refused, and so is a rehearsal against local doubles. ${
      input.evidence.entries.some(
        (entry) =>
          entry.target === "attended-live" || entry.target === "recorded-live",
      )
        ? "Live entries are listed in the label basis below."
        : "No entry anywhere is live, so no label here is `live` or `certified`."
    }`,
    "",
    "A generic adapter (`evidenceScope: definition`: the OpenAPI, provider-catalog, remote MCP and Microsoft custom-connector adapters) runs whatever description, server or connector a person imported, so its row describes the code path only: it counts entries that name no definition and never reads `live` or `certified`. The production gate and provider-backed promotion evaluate it per definition, from entries that name that definition, so an imported description nobody exercised is `unverified` there whatever this row says.",
    "",
    ...(expired.length > 0
      ? [
          `Expired entries (${expired.length}), kept visible rather than dropped:`,
          "",
          ...expired.map(
            ({ adapter, entry }) =>
              `- \`${adapter.id}\`: ${entry.check} (${entry.target}, ${entry.recordedAt})`,
          ),
          "",
        ]
      : ["No recorded entry has expired.", ""]),
    ...(input.evidence.notes.length > 0
      ? [...input.evidence.notes.map((note) => `- ${note}`), ""]
      : []),
    "## Support by dimension",
    "",
    "`Support` is what the adapter declares about how it runs; `Label` is what the recorded evidence earns.",
    "",
    `| Adapter | Service | Runtime | Support | Label | Custody | ${columns.map((column) => column.heading).join(" | ")} |`,
    `| --- | --- | --- | --- | --- | --- | ${columns.map(() => "---").join(" | ")} |`,
  ];
  for (const adapter of input.adapters)
    lines.push(
      `| \`${adapter.id}\` | ${adapter.service} | ${adapter.runtime} | ${adapter.support} | ${label(adapter).label}${adapter.evidenceScope === "definition" ? " (code path)" : ""} | ${adapter.custody.join(", ")} | ${columns
        .map((column) => cell(adapter.rows[column.dimension as string]))
        .join(" | ")} |`,
    );
  lines.push(
    "",
    "## Discovery, delegation and lifecycle",
    "",
    "Lifecycle is not one dimension. Local disconnect, broker deletion and upstream revocation are separate effects with separate policy, and an adapter may implement one and not another. This column reports all three.",
    "",
    "| Adapter | Discover | Delegate | Lifecycle (reconnect / disconnect / revoke) |",
    "| --- | --- | --- | --- |",
  );
  for (const adapter of input.adapters)
    lines.push(
      `| \`${adapter.id}\` | ${cell(adapter.rows["discover"])} | ${cell(adapter.rows["delegate"])} | ${lifecycleCell(adapter)} |`,
    );
  lines.push(
    "",
    "## Required configuration and recorded evidence",
    "",
    "A `provider-backed` adapter missing required configuration is shown in the directory as `unconfigured`: implemented, not usable here. The evidence column is the strongest level any ledger recorded for the adapter's own module directory. The label basis is the entry that earned the label.",
    "",
    "| Adapter | Adapter version | Required configuration | Evidence | Label basis | Recorded by | Protocol profiles |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const adapter of input.adapters) {
    const evidence = evidenceFor(adapter, index);
    const swarms = new Set(evidence.swarms);
    for (const entry of input.evidence.entries)
      if (entry.adapterId === adapter.id) {
        const swarm = input.evidence.sources.get(entryKey(entry));
        if (swarm) swarms.add(swarm);
      }
    lines.push(
      `| \`${adapter.id}\` | ${adapter.adapterVersion || "unversioned"} | ${requiredConfiguration(adapter)} | ${evidence.level} | ${labelBasis(label(adapter))} | ${[...swarms].sort().join(", ") || "no ledger entry"} | ${adapter.profiles.map((profile) => `\`${profile}\``).join(", ") || "none declared"} |`,
    );
  }
  lines.push("", "## Native limitations, as each adapter reports them", "");
  for (const adapter of input.adapters) {
    const limitations = limitationsFor(adapter);
    lines.push(`### \`${adapter.id}\` — ${adapter.displayName}`, "");
    lines.push(`Module: \`${adapter.module}\` (\`${adapter.factory}\`).`, "");
    if (limitations.length === 0)
      lines.push("No limitation is attached to any capability row.", "");
    else {
      for (const limitation of limitations) lines.push(`- ${limitation}`);
      lines.push("");
    }
  }
  const importerOnly = input.adapterProblems.filter((problem) =>
    problem.reason.startsWith("importer-only"),
  );
  const notIntrospectable = input.adapterProblems.filter(
    (problem) => !problem.reason.startsWith("importer-only"),
  );
  if (importerOnly.length > 0) {
    lines.push(
      "## Format modules with no runtime adapter",
      "",
      "These modules read, validate and compile a document family. They deliberately expose no runtime adapter: an imported description is not an approved runtime binding, and execution for these families happens through another adapter (an approved HTTP binding, a compiled recipe, or a host-provided remote operation). They have no row in the tables above because they have no dimensions of their own to report.",
      "",
      "| Module |",
      "| --- |",
    );
    for (const problem of importerOnly) lines.push(`| \`${problem.module}\` |`);
    lines.push("");
  }
  if (notIntrospectable.length > 0) {
    lines.push(
      "## Adapters that are not machine-readable here",
      "",
      "These modules export an adapter factory that could not be constructed with no host configuration, so this document reports no dimensions for them rather than guessing. That is a gap in this generator, not a statement that the adapter is unimplemented: check the ledgers and the module.",
      "",
      "| Module | Factory | Reason |",
      "| --- | --- | --- |",
    );
    for (const problem of notIntrospectable)
      lines.push(
        `| \`${problem.module}\` | \`${problem.factory}\` | ${problem.reason} |`,
      );
    lines.push("");
  }
  lines.push(
    "## Pinned sources behind these claims",
    "",
    `Every wire fact above traces to a document recorded in the [source lock](../implementation-evidence/connector-interoperability/source-lock.json), pinned ${input.lock.pinnedAt}. The human-readable view is [source-lock.md](../implementation-evidence/connector-interoperability/source-lock.md).`,
    "",
  );
  return lines.join("\n") + "\n";
}

/** Source profile identifiers a ledger cites with no record in the lock. */
export function citationGaps(
  lock: SourceLock,
  ledgers: Ledger[],
): Array<{ swarm: string; id: string; covered: boolean }> {
  const known = new Set(lock.records.map((record) => record.id));
  const covered = new Set(lock.coversLedgers);
  const gaps: Array<{ swarm: string; id: string; covered: boolean }> = [];
  const seen = new Set<string>();
  for (const ledger of ledgers)
    for (const item of ledger.workItems)
      for (const id of item.sourceProfileIds) {
        if (known.has(id)) continue;
        const key = `${ledger.swarm}:${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        gaps.push({
          swarm: ledger.swarm,
          id,
          covered: covered.has(ledger.swarm),
        });
      }
  return gaps.sort((a, b) =>
    `${a.swarm}:${a.id}`.localeCompare(`${b.swarm}:${b.id}`),
  );
}

export function renderSourceLock(lock: SourceLock, ledgers: Ledger[]): string {
  const cited = new Set<string>();
  for (const ledger of ledgers)
    for (const item of ledger.workItems)
      for (const id of item.sourceProfileIds) cited.add(id);
  const known = new Set(lock.records.map((record) => record.id));
  const gaps = citationGaps(lock, ledgers);
  const missing = [...new Set(gaps.map((gap) => gap.id))].sort();
  const unused = [...known].filter((id) => !cited.has(id)).sort();
  const lines: string[] = [
    "# Connector source lock",
    "",
    "Status: **generated** from [`source-lock.json`](source-lock.json). Do not edit this file; edit the JSON and regenerate with `node --import tsx scripts/connector-support-matrix.ts`.",
    "",
    lock.about,
    "",
    "## Rules this lock enforces on itself",
    "",
    ...lock.rules.map((rule) => `- ${rule}`),
    "",
    "## Coverage",
    "",
    `- Records: ${lock.records.length}, pinned ${lock.pinnedAt}.`,
    `- Ledgers this lock claims to cover completely: ${lock.coversLedgers.length ? lock.coversLedgers.join(", ") : "none declared"}.`,
    `- Source profile identifiers cited by the ledgers on disk: ${cited.size}.`,
    `- Cited identifiers with no lock record: ${missing.length}${missing.length ? ` (${missing.map((id) => `\`${id}\``).join(", ")})` : ""}.`,
    `- Of those, from a ledger this lock claims to cover: ${gaps.filter((gap) => gap.covered).length}.`,
    `- Lock records no ledger currently cites: ${unused.length}${unused.length ? ` (${unused.map((id) => `\`${id}\``).join(", ")})` : ""}.`,
    "",
    "A cited identifier with no record is a real gap: it means an adapter depends on a document this lock has not pinned. It is reported here rather than hidden. A gap from a ledger inside the covered set is a defect in this lock; a gap from a ledger delivered after the lock was pinned is work the integrator must finish.",
    "",
    ...(lock.coversNote ? [lock.coversNote, ""] : []),
    ...(gaps.length
      ? [
          "| Ledger | Cited identifier | Inside the covered set |",
          "| --- | --- | --- |",
          ...gaps.map(
            (gap) =>
              `| ${gap.swarm} | \`${gap.id}\` | ${gap.covered ? "yes — defect in this lock" : "no — pinned after this lock"} |`,
          ),
          "",
        ]
      : []),
    "## Records",
    "",
  ];
  for (const record of lock.records) {
    lines.push(`### \`${record.id}\` — ${record.title}`, "");
    lines.push(
      `- Kind: ${record.kind}`,
      `- URL: ${record.url.startsWith("http") ? `<${record.url}>` : `\`${record.url}\``}`,
      `- Retrieved at: ${record.retrievedAt}`,
      `- Upstream version: ${record.upstreamVersion}`,
      `- Revision: ${record.revision}`,
      `- Digest: ${record.digest ? `\`${record.digest}\`` : `none captured${record.digestNote ? ` — ${record.digestNote}` : ""}`}`,
      `- Licence: ${record.licence.spdx ? `${record.licence.spdx}. ` : record.licence.status ? `${record.licence.status}. ` : ""}${record.licence.statement} (Established: ${record.licence.evidence}.)`,
      `- Reuse: ${record.reuse}`,
      `- Dependent adapters: ${record.dependents.adapters.length ? record.dependents.adapters.map((item) => `\`${item}\``).join(", ") : "none yet"}`,
      `- Dependent profile identifiers: ${record.dependents.profiles.map((item) => `\`${item}\``).join(", ")}`,
      `- Modules: ${record.dependents.modules.map((item) => `\`${item}\``).join(", ")}`,
      `- Recorded by: ${record.recordedBy.join(", ")}`,
    );
    if (record.notes) lines.push(`- Notes: ${record.notes}`);
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

type Report = {
  generatedAt?: string;
  git?: { testedCommit?: string; lockfileDigest?: string };
  environment?: Record<string, unknown>;
  suites?: Array<{
    file: string;
    passed: number;
    failed: number;
    skipped: number;
  }>;
  requirements?: Array<{
    id: string;
    swarm: string;
    implementationStatus: string;
    files: string[];
    acceptanceIds: string[];
    limitations: string[];
    checks: Array<{
      testId: string;
      command: string;
      result: string;
      evidenceLevel: string;
      reason?: string;
    }>;
  }>;
  unmetRequirements?: Array<{ id: string; swarm: string; reason: string }>;
  securityFindings?: unknown[];
  externalEffectsPerformed?: string[];
};

function loadReport(): Report | null {
  if (!existsSync(reportPath)) return null;
  try {
    return JSON.parse(readFileSync(reportPath, "utf8")) as Report;
  } catch {
    return null;
  }
}

/** One required work item, joined to the ledger that delivered it (or to nothing). */
type Joined = {
  id: string;
  swarm: string;
  status: "implemented" | "partial" | "unmet" | "not-delivered";
  files: string[];
  tests: string[];
  acceptanceIds: string[];
  evidenceLevel: string;
  sourceProfileIds: string[];
  limitations: string[];
};

/**
 * Joins every required work item in the charter to the ledger entry that
 * claims it. An item nobody delivered is reported `not-delivered`, not
 * omitted: that is the whole point of listing requirements rather than
 * listing what happened to be done.
 */
export function joinRequirements(ledgers: Ledger[]): Joined[] {
  const delivered = new Map<
    string,
    { swarm: string; item: z.infer<typeof ledgerItemSchema> }
  >();
  for (const ledger of ledgers)
    for (const item of ledger.workItems)
      delivered.set(item.id, { swarm: ledger.swarm, item });
  const joined: Joined[] = [];
  for (const [swarm, ids] of Object.entries(requiredWorkItems))
    for (const id of ids) {
      const match = delivered.get(id);
      if (!match) {
        joined.push({
          id,
          swarm,
          status: "not-delivered",
          files: [],
          tests: [],
          acceptanceIds: [],
          evidenceLevel: "not-tested",
          sourceProfileIds: [],
          limitations: ["No ledger entry was produced for this work item."],
        });
        continue;
      }
      joined.push({
        id,
        swarm,
        status: match.item.status,
        files: match.item.files,
        tests: match.item.tests,
        acceptanceIds: match.item.acceptanceIds,
        evidenceLevel: match.item.evidenceLevel,
        sourceProfileIds: match.item.sourceProfileIds,
        limitations: match.item.limitations,
      });
    }
  return joined;
}

export function renderEvidenceReport(input: {
  lock: SourceLock;
  ledgers: Ledger[];
  ledgerProblems: string[];
  adapters: AdapterFacts[];
  adapterProblems: AdapterProblem[];
  report: Report | null;
}): string {
  const report = input.report;
  const suites = new Map(
    (report?.suites ?? []).map((suite) => [suite.file, suite]),
  );
  const joined = joinRequirements(input.ledgers);
  const notDelivered = joined.filter((item) => item.status === "not-delivered");
  const partial = joined.filter(
    (item) => item.status === "partial" || item.status === "unmet",
  );
  /*
   * A live prerequisite, not any limitation that happens to say "credential".
   * A statement qualifies when it names live or deployed evidence as blocked
   * or unavailable, or when it says outright that no authorized account,
   * credential or deployment exists. Every other native limitation belongs in
   * the limitations section, not here.
   */
  const blockedPattern =
    /\b(live|deployed)[ -]\w*\s*(evidence|account|proof)?[^.]{0,60}\b(blocked|unavailable|not available)\b|\bblocked\b[^.]{0,40}\b(live|deployed|credential|account|deployment)\b|\bno authorized\b|\bnot live\b/i;
  const blocked = joined.flatMap((item) =>
    item.limitations
      .filter(
        (limitation) =>
          blockedPattern.test(limitation) && item.status !== "not-delivered",
      )
      .map((limitation) => ({ id: item.id, swarm: item.swarm, limitation })),
  );
  const security = input.ledgers.flatMap((ledger) =>
    ledger.securityFindings.map((finding) => ({
      swarm: ledger.swarm,
      finding,
    })),
  );
  const effects = input.ledgers.flatMap((ledger) =>
    ledger.externalEffectsPerformed.map(
      (effect) =>
        `${ledger.swarm}: ${typeof effect === "string" ? effect : JSON.stringify(effect)}`,
    ),
  );
  const recordedTests = joined.flatMap((item) =>
    item.tests.map((file) => ({
      item: item.id,
      file,
      suite: suites.get(file),
    })),
  );
  const withResults = recordedTests.filter((entry) => entry.suite);
  /*
   * Why a ledger-named file has no result, said accurately.
   *
   * The blanket answer used to be "this run is older than the ledgers, re-run
   * the compiler". For most of these that is false and the advice cannot work:
   * a Playwright specification belongs to another runner, and a harness, a
   * protocol double and a fixture document are not tests at all. Telling a
   * reader to re-run something that will never change the row is the same
   * cry-wolf failure this report was already fixed for once, so each absence
   * is now named for what it is, and only a node test genuinely missing from
   * the run asks for a refresh.
   */
  const absenceKind = (file: string): string =>
    file.endsWith(".spec.ts")
      ? "browser specification, run by `npm run test:e2e` under three engines rather than by the node runner"
      : /\.(json|ya?ml)$/.test(file)
        ? "fixture document, read by a test rather than run as one"
        : file.endsWith(".test.ts")
          ? "node test outside the compiler's scope; a refresh would record it"
          : "support module: a harness or protocol double a test imports, not a test";
  const absent = [
    ...new Set(
      recordedTests.filter((entry) => !entry.suite).map((entry) => entry.file),
    ),
  ];
  const refreshable = absent.filter((file) =>
    absenceKind(file).startsWith("node test outside"),
  );
  const lines: string[] = [
    "# Connector interoperability: implementation evidence report",
    "",
    "Status: **generated**. Do not edit this file. `node --import tsx scripts/connector-support-matrix.ts` writes it from the swarm ledgers, the charter's required work items, the source lock, the registered adapters and whatever machine-readable run `npm run evidence:connectors` last recorded.",
    "",
    "It complements [README.md](README.md) and [report.json](report.json), which `scripts/connector-evidence.ts` produces from a JUnit-recorded run. Requirement status here is read from the ledgers **at generation time**, so it does not go stale when a ledger lands after the last recorded test run; test results still come only from that recorded run, and the section below says when it was taken.",
    "",
    "## The honest summary first",
    "",
    "- **No live or vendor-certified evidence exists anywhere in this work.** There are no authorized vendor credentials in this environment. Every adapter's evidence is `unit`, `protocol-fixture` or `local-integration` against loopback doubles written from published documentation. A double that enforces a documented contract is good evidence of wire correctness and no evidence at all about a real account.",
    "- **Forwarded-delivery verification for Vercel Connect triggers is deliberately incomplete.** Vercel's documentation states that Connect signs the request it forwards and publishes a per-connector signing key, but does not publish the outbound header name or algorithm. `verifyForwardedDelivery` therefore takes the forwarder's verifier as an injected dependency, and the verifier used in tests is a stand-in — not a claim about Vercel's wire format.",
    "- **One provider's webhook verification uses a separate signing key.** Nango's `X-Nango-Hmac-Sha256` is an HMAC-SHA256 over the raw body keyed with the environment **webhook signing key**, which is a different secret from the Environment API key; the legacy plain-digest `X-Nango-Signature` is documented as not to be used and is ignored even when it is correct.",
    "- **Several providers document no pagination for particular list endpoints.** Nango's `GET /integrations` and Supabase's `GET /v1/organizations` and `GET /v1/projects` are the recorded cases. Those adapters window one bounded response and report the absence as a discover issue rather than inventing page parameters.",
    '- **The MCP registry adapter reports `provider-backed`, not `catalog-only`.** It genuinely implements discovery, import and export against a registry. The catalog-only boundary is reported per dimension instead: every execution dimension is `unsupported` with the limitation "execution requires an MCP binding".',
    "",
    "## Requirement coverage",
    "",
    `- Required work items in the charter: ${joined.length}.`,
    `- Delivered with a ledger entry: ${joined.length - notDelivered.length}.`,
    `- Implemented: ${joined.filter((item) => item.status === "implemented").length}. Partial or unmet: ${partial.length}. No ledger entry at all: ${notDelivered.length}.`,
    `- Ledgers read: ${input.ledgers.length} (${input.ledgers.map((ledger) => ledger.swarm).join(", ")}).`,
    "",
  ];
  if (report)
    lines.push(
      "## Recorded test run",
      "",
      `- Recorded: ${report.generatedAt ?? "unknown"}`,
      `- Tested commit: \`${report.git?.testedCommit ?? "unknown"}\``,
      `- Environment: ${JSON.stringify(report.environment ?? {})}`,
      `- Test files in that run: ${suites.size}; passed ${[...suites.values()].reduce((sum, suite) => sum + suite.passed, 0)}, failed ${[...suites.values()].reduce((sum, suite) => sum + suite.failed, 0)}, skipped ${[...suites.values()].reduce((sum, suite) => sum + suite.skipped, 0)}`,
      `- Ledger-named test files covered by that run: ${withResults.length} of ${recordedTests.length}.`,
      "",
      absent.length === 0
        ? "Every test file a ledger names has a result in that run."
        : [
            `**${absent.length} of the paths a ledger names have no result in that run**, so their rows below read \`not in the recorded run\`. An absence is not a failure and is not reported as one. Each one, and why:`,
            "",
            ...absent
              .slice()
              .sort()
              .map((file) => `- \`${file}\` — ${absenceKind(file)}`),
            "",
            refreshable.length > 0
              ? `Only the ${refreshable.length === 1 ? "one node test" : `${refreshable.length} node tests`} above would change: re-run \`npm run evidence:connectors\`, then regenerate this document. The rest cannot be recorded by that command however often it is run, and asking for a refresh would be advice that never works.`
              : "None of them would change on a refresh: no node test a ledger names is missing from the run. Re-running the compiler would report exactly this again.",
          ].join("\n"),
      "",
    );
  else
    lines.push(
      "## Recorded test run",
      "",
      "No `report.json` was found. Run `npm run evidence:connectors` to record one; this document then joins it. Until then every test row reads `not in the recorded run`, and that absence is the finding.",
      "",
    );
  lines.push(
    "## Requirements with no ledger entry",
    "",
    "Named directly. These are required work items nobody delivered. They are listed here rather than folded into a claim that every swarm completed.",
    "",
  );
  if (notDelivered.length === 0)
    lines.push("- Every required work item has a ledger entry.", "");
  else {
    lines.push("| Item | Swarm |", "| --- | --- |");
    for (const item of notDelivered)
      lines.push(`| ${item.id} | ${item.swarm} |`);
    lines.push("");
  }
  lines.push("## Partial and unmet requirements", "");
  if (partial.length === 0) lines.push("- None recorded.", "");
  else {
    lines.push("| Item | Swarm | Status | Why |", "| --- | --- | --- | --- |");
    for (const item of partial)
      lines.push(
        `| ${item.id} | ${item.swarm} | ${item.status} | ${(item.limitations.join("; ") || "see the ledger").replace(/\|/g, "/").slice(0, 400)} |`,
      );
    lines.push("");
  }
  lines.push(
    "## Blocked live prerequisites",
    "",
    "Each of these stays `blocked` and fails closed. None is relabelled as a fixture pass, and `verify:live` and `verify:release` will keep reporting them until the exact prerequisite exists.",
    "",
  );
  if (blocked.length === 0) lines.push("- None recorded.", "");
  else {
    for (const item of blocked)
      lines.push(`- **${item.id}** (${item.swarm}): ${item.limitation}`);
    lines.push("");
  }
  lines.push(
    "## Requirements, files, tests, results and pinned sources",
    "",
    "One entry per required work item, joined to the ledger that delivered it. A result is `pass`, `fail` or `not in the recorded run`, taken from the recorded JUnit counts and never from a ledger's own claim.",
    "",
  );
  for (const item of joined) {
    if (item.status === "not-delivered") {
      lines.push(
        `### ${item.id} (${item.swarm}) — no ledger entry`,
        "",
        "Nobody delivered this required work item.",
        "",
      );
      continue;
    }
    lines.push(
      `### ${item.id} (${item.swarm}) — ${item.status}, ${item.evidenceLevel}`,
      "",
      `- Files: ${item.files.length ? item.files.map((file) => `\`${file}\``).join(", ") : "none recorded"}`,
      `- Acceptance: ${item.acceptanceIds.join(", ") || "none named"}`,
      `- Pinned sources: ${item.sourceProfileIds.map((id) => `\`${id}\``).join(", ") || "none named"}`,
    );
    if (item.tests.length === 0) lines.push("- Tests: none named");
    else {
      lines.push("- Tests:");
      for (const file of item.tests) {
        const suite = suites.get(file);
        const outcome = !suite
          ? "not in the recorded run"
          : suite.failed > 0
            ? `fail ${suite.failed}, pass ${suite.passed}`
            : suite.passed > 0
              ? `pass ${suite.passed}`
              : "no cases";
        lines.push(`  - \`node --import tsx --test ${file}\` — ${outcome}`);
      }
    }
    lines.push("");
  }
  lines.push(
    "",
    "The command that produces every result above is one recorded run over every discovered connector test file:",
    "",
    "```sh",
    'export NODE_OPTIONS="--max-old-space-size=8192"',
    "npm run evidence:connectors",
    "```",
    "",
    "A single file can be re-run on its own with `node --import tsx --test <file>`.",
    "",
    "## Native limitations reported by the delivered work",
    "",
    "Every limitation any ledger recorded, kept verbatim. These are the boundaries an integrator inherits.",
    "",
  );
  for (const item of joined) {
    if (item.status === "not-delivered" || item.limitations.length === 0)
      continue;
    lines.push(`- **${item.id}** (${item.swarm})`);
    for (const limitation of item.limitations) lines.push(`  - ${limitation}`);
  }
  lines.push("", "## Security findings recorded by the swarms", "");
  if (security.length === 0)
    lines.push(
      "- No swarm recorded a `securityFindings` entry in its ledger. That is the absence of a recorded finding, not a clean-security claim: the security review is its own required work item, and its status is in the tables above.",
      "",
    );
  else {
    for (const item of security)
      lines.push(`- ${item.swarm}: ${JSON.stringify(item.finding)}`);
    lines.push("");
  }
  lines.push("## External effects performed", "");
  if (effects.length === 0)
    lines.push(
      "- None recorded. No account was created, no integration installed, no package published, no production service deployed, no upstream grant revoked and no paid resource created.",
      "",
    );
  else {
    for (const effect of effects) lines.push(`- ${effect}`);
    lines.push("");
  }
  lines.push(
    "## Pinned sources",
    "",
    `The [source lock](source-lock.md) pins ${input.lock.records.length} records as of ${input.lock.pinnedAt}, each with its URL, retrieval time, upstream version, licence position and the adapters and profile identifiers that depend on it. It also reports its own coverage gaps. Read it before trusting any wire fact in this repository.`,
    "",
    "## Adapter inventory read for this report",
    "",
    `${input.adapters.length} adapter factories construct with no host configuration and report their own capability rows; ${input.adapterProblems.length} module${input.adapterProblems.length === 1 ? "" : "s"} could not be introspected or export no adapter, and each is named in the [support matrix](../../specifications/connector-support-matrix.md).`,
    "",
  );
  if (input.ledgerProblems.length > 0) {
    lines.push("## Ledger problems", "");
    for (const problem of input.ledgerProblems) lines.push(`- ${problem}`);
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

export type Generated = { path: string; content: string };

/*
 * Written through Prettier with the repository's own configuration, for the
 * same reason scripts/specifications.ts does it: `npm run format:check`
 * covers docs/, so an unformatted generated document would fail formatting
 * and then be reformatted in place, which would make `--check` report drift
 * against a file nobody edited.
 */
async function markdown(content: string, filepath: string): Promise<string> {
  return await format(content, { parser: "markdown", filepath });
}

export async function generate(): Promise<Generated[]> {
  const lock = loadSourceLock();
  const { ledgers, problems: ledgerProblems } = loadLedgers();
  const { adapters, problems: adapterProblems } = await readAdapters();
  const certifications = loadCertifications();
  if (certifications.problems.length > 0)
    throw new Error(
      `attended certifications unreadable:\n${certifications.problems.map((line) => `  - ${line}`).join("\n")}`,
    );
  const evidence = collectSupportEvidence(ledgers, adapters, {
    today: Date.now(),
    certifications: certifications.files,
    certifiers: certifications.certifiers,
  });
  // A refused entry is not reported and published around: a label must not
  // be computed while any evidence behind the ledgers is malformed or dated
  // in the future, so both generation and `--check` stop here.
  if (evidence.refused.length > 0)
    throw new Error(
      `support evidence refused:\n${evidence.refused.map((line) => `  - ${line}`).join("\n")}`,
    );
  const matrixPath = join(
    root,
    "docs/specifications/connector-support-matrix.md",
  );
  const lockPath = join(evidenceDirectory, "source-lock.md");
  const reportDocumentPath = join(evidenceDirectory, "evidence-report.md");
  return [
    {
      path: matrixPath,
      content: await markdown(
        renderSupportMatrix({
          adapters,
          adapterProblems,
          ledgers,
          lock,
          evidence,
        }),
        matrixPath,
      ),
    },
    {
      path: recordedEvidencePath,
      content: await format(renderRecordedEvidence(evidence), {
        parser: "typescript",
        filepath: recordedEvidencePath,
      }),
    },
    {
      path: lockPath,
      content: await markdown(renderSourceLock(lock, ledgers), lockPath),
    },
    {
      path: reportDocumentPath,
      content: await markdown(
        renderEvidenceReport({
          lock,
          ledgers,
          ledgerProblems,
          adapters,
          adapterProblems,
          report: loadReport(),
        }),
        reportDocumentPath,
      ),
    },
  ];
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const check = process.argv.includes("--check");
  const generated = await generate();
  let drifted = 0;
  for (const file of generated) {
    const name = relative(root, file.path);
    if (check) {
      const current = existsSync(file.path)
        ? readFileSync(file.path, "utf8")
        : "";
      if (current !== file.content) {
        drifted += 1;
        console.error(`drift: ${name} does not match the generated content`);
      }
    } else {
      writeFileSync(file.path, file.content);
      console.log(`wrote ${name} (${file.content.length} bytes)`);
    }
  }
  if (check) {
    if (drifted > 0) {
      console.error(
        `${drifted} generated document(s) are out of date; run: node --import tsx scripts/connector-support-matrix.ts`,
      );
      process.exitCode = 1;
    } else console.log("generated connector documents are up to date");
  }
}
