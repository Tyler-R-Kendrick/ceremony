/*
 * Pinned facts about the n8n node formats this reader accepts.
 *
 * Retrieved 2026-09-18. The documented entry point named in the charter,
 * https://docs.n8n.io/integrations/creating-nodes/overview/ , returns 404;
 * the same material now lives under `/connect/create-nodes/`, and these are
 * the pages actually read (each is the site's own Markdown rendering):
 *   /connect/create-nodes/plan-your-node/choose-a-node-building-style.md
 *   /connect/create-nodes/build-your-node/reference/base-files/structure.md
 *   /connect/create-nodes/build-your-node/reference/base-files/standard-parameters.md
 *   /connect/create-nodes/build-your-node/reference/base-files/declarative-style-parameters.md
 *   /connect/create-nodes/build-your-node/reference/base-files/programmatic-style-parameters.md
 *   /connect/create-nodes/build-your-node/reference/credentials-files.md
 *   /connect/create-nodes/build-your-node/reference/versioning.md
 *   /connect/create-nodes/build-your-node/reference/node-ui-elements.md
 *   /connect/create-nodes/build-your-node/tutorial-build-a-declarative-style-node.md
 *
 * Verified there and used here: `INodeTypeDescription` standard parameters
 * (`displayName`, `name`, `icon`, `group`, `description`, `defaults`,
 * `inputs`, `outputs`, `credentials` with `name`/`required`,
 * `requestDefaults` with `baseURL`/`headers`/`url`, `properties`);
 * declarative parameters (`routing` inside an operation `options` entry and
 * inside a field, `methods.loadOptions`, `version` as a number or an array,
 * `features`); programmatic parameters (`defaultVersion`, `methods`) and the
 * `execute()` method; that a trigger node must be programmatic; that an
 * expression is a string beginning with `=` and containing `{{ }}`;
 * credentials files (`name`, `displayName`, `documentationUrl`,
 * `properties`, `authenticate` of type `generic` with `body`/`header`/`qs`/
 * `auth` properties, `test.request` with `baseURL`/`url`); and the package
 * manifest's `n8n` block (`n8nNodesApiVersion`, `credentials`, `nodes`).
 *
 * Unverified: nothing. Where a construct is code — an `execute` method, a
 * `loadOptions` query, an expression — this reader records it and stops.
 */

export const N8N_ECOSYSTEM = "n8n" as const;

export const N8N_IMPORTER = Object.freeze({
  id: "connectors.formats.n8n",
  version: "1.0.0",
});

export const N8N_PROFILES = Object.freeze({
  /** An exported `INodeTypeDescription` as JSON (the preferred input). */
  json: "n8n-node-description/1",
  /** A bounded static extraction from node source text. */
  source: "n8n-node-source-static/1",
  /** The export profile this module writes. */
  export: "n8n-static-node/1",
});

export const N8N_SOURCES = Object.freeze({
  charterUrl: "https://docs.n8n.io/integrations/creating-nodes/overview/",
  charterUrlStatus: "404 on 2026-09-18; superseded by /connect/create-nodes/",
  overview: "https://docs.n8n.io/connect/create-nodes/overview.md",
  standardParameters:
    "https://docs.n8n.io/connect/create-nodes/build-your-node/reference/base-files/standard-parameters.md",
  declarativeParameters:
    "https://docs.n8n.io/connect/create-nodes/build-your-node/reference/base-files/declarative-style-parameters.md",
  credentials:
    "https://docs.n8n.io/connect/create-nodes/build-your-node/reference/credentials-files.md",
  retrievedAt: "2026-09-18",
});

export const N8N_MEDIA_TYPE = "application/json";

export const N8N_LIMITS = Object.freeze({
  properties: 512,
  options: 256,
  fields: 256,
  credentials: 16,
  versions: 64,
  servers: 32,
  issues: 4096,
});

/** A node parameter value that begins with `=` is an n8n expression, never a literal. */
export const N8N_EXPRESSION_PREFIX = "=";
/** The substitution syntax inside an expression; present for completeness, never evaluated. */
export const N8N_EXPRESSION_BODY = /\{\{[\s\S]*?\}\}/;

/** Methods whose presence makes a node programmatic: code this runtime will not run. */
export const N8N_PROGRAMMATIC_METHODS = [
  "execute",
  "webhook",
  "poll",
  "trigger",
] as const;

export function isN8nExpression(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(N8N_EXPRESSION_PREFIX);
}
