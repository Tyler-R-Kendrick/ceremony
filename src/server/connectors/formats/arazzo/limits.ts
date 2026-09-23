import { RECIPE_LIMITS } from "../../../../core/recipe-contracts.js";

/*
 * Pinned Arazzo versions and the bounds every reader, compiler and evaluator
 * in this directory obeys. A document is data written by a third party: the
 * bounds are what keep a hostile document from costing more than a bounded
 * amount of memory and time, and the version table is what keeps a newer
 * document from being silently read with older semantics.
 */

export const ARAZZO_VERSIONS = ["1.0.1", "1.1.0"] as const;
export type ArazzoVersion = (typeof ARAZZO_VERSIONS)[number];

export const ARAZZO_PROFILES: Record<ArazzoVersion, string> = {
  "1.0.1": "arazzo-1.0.1",
  "1.1.0": "arazzo-1.1.0",
};
export const ARAZZO_EXECUTABLE_PROFILE = "arazzo-executable/1" as const;
export const ARAZZO_IMPORTER = Object.freeze({
  id: "connectors.formats.arazzo",
  version: "1.0.0",
});
export const ARAZZO_SOURCES: Record<ArazzoVersion, string> = {
  "1.0.1": "https://spec.openapis.org/arazzo/v1.0.1.html",
  "1.1.0": "https://spec.openapis.org/arazzo/v1.1.0.html",
};
export const ARAZZO_MEDIA_TYPE = "application/vnd.oai.workflows+json";

export function isArazzoVersion(value: unknown): value is ArazzoVersion {
  return (
    typeof value === "string" &&
    (ARAZZO_VERSIONS as readonly string[]).includes(value)
  );
}

/** True when `field` (introduced in `since`) exists in `version`. */
export function versionIncludes(
  version: ArazzoVersion,
  since: ArazzoVersion,
): boolean {
  return ARAZZO_VERSIONS.indexOf(version) >= ARAZZO_VERSIONS.indexOf(since);
}

export const ARAZZO_LIMITS = Object.freeze({
  /** Total JSON nodes (objects, arrays and primitives) in one document. */
  nodes: 1_000_000,
  /** Nesting depth of the JSON value. */
  depth: 64,
  /** Length of any single string in the document. */
  string: 65_536,
  sourceDescriptions: 32,
  workflows: 128,
  steps: 256,
  parameters: 64,
  criteria: 32,
  actions: 16,
  outputs: 64,
  components: 256,
  dependsOn: 64,
  replacements: 64,
  identifier: 200,
  text: 4096,
  url: 2048,
  expression: 1024,
  condition: 2048,
  extensions: 64,
  /** Executable profile: leaves of one compiled recipe. */
  executableSteps: RECIPE_LIMITS.leaves,
  retryLimit: 5,
  retryAfterSeconds: 300,
  timeoutMs: 600_000,
  evaluator: Object.freeze({
    tokens: 256,
    depth: 16,
    pointerSegments: 16,
    literal: 512,
    embedded: 16,
  }),
});
