import { parseAllDocuments, visit } from "yaml";
import { z } from "zod";
import {
  measureJsonValue,
  type JsonValueLimits,
} from "../../../../core/connectors/json-bounds.js";
import type { CompatibilityIssue } from "../../adapter-types.js";

/*
 * Reader for the Docker MCP catalog file format ("version: 2"), the document
 * that `docker mcp catalog import|show|export` and the MCP Gateway consume.
 * The format has no published JSON schema; the field set below was taken from
 * the Docker documentation and from the served official catalog on
 * 2026-09-18 (sources are listed in docs/.../ledger/CATALOGS.json):
 *
 *   version, name, displayName, registry:
 *     <server-id>:
 *       description, title, type (server | remote | poci), dateAdded, image,
 *       ref, readme, toolsUrl, source, upstream, icon, tools[{name, ...}],
 *       prompts, resources, secrets[{name, env, example, description,
 *       required}], env[{name, value}], command[], volumes[], allowHosts[],
 *       disableNetwork, longLived, user, config[{name, description, type,
 *       properties, required, ...}], metadata{pulls, stars, githubStars,
 *       category, tags, license, owner}, oauth{providers[{provider, secret,
 *       env}]}, remote{url, transport_type, headers{}}
 *
 * Everything read here is inert description. Nothing is installed, pulled,
 * mounted or executed by reading a catalog; the reader only decides what the
 * document says and what it must never be allowed to say (credential values,
 * loader-hijacking environment names, forged identifiers).
 */

export const DOCKER_CATALOG_LIMITS = Object.freeze({
  bytes: 8 * 1024 * 1024,
  servers: 512,
  aliases: 32,
  nodes: 400_000,
  depth: 24,
  stringLength: 16_384,
  tools: 512,
  secrets: 64,
  env: 128,
  command: 128,
  volumes: 32,
  allowHosts: 64,
  configs: 32,
  headers: 32,
  providers: 16,
  tags: 64,
});
export type DockerCatalogLimits = {
  readonly [K in keyof typeof DOCKER_CATALOG_LIMITS]: number;
};

export const DOCKER_CATALOG_FORMAT = "docker-mcp-catalog" as const;
export const DOCKER_CATALOG_FORMAT_VERSION = "2" as const;
export const DOCKER_CATALOG_READER_VERSION = "1.0.0" as const;

export const dockerServerTypes = ["server", "remote", "poci"] as const;
export type DockerServerType = (typeof dockerServerTypes)[number];

export type DockerImageReference = {
  /** The reference exactly as written, bounded and control-free. */
  raw: string;
  registry?: string;
  repository: string;
  tag?: string;
  /** `sha256:<64 hex>`; the only form that pins bytes. */
  digest?: string;
};

export type DockerCatalogTool = {
  name: string;
  description?: string;
  /** Inert JSON-Schema-like parameters (poci tools); bounded, never evaluated. */
  parameters?: unknown;
  container?: { image?: DockerImageReference; command: string[] };
};

export type DockerCatalogSecret = {
  name: string;
  env: string;
  example?: string;
  description?: string;
  required?: boolean;
};

export type DockerCatalogServer = {
  id: string;
  type: DockerServerType;
  title?: string;
  description?: string;
  dateAdded?: string;
  image?: DockerImageReference;
  ref?: string;
  readme?: string;
  toolsUrl?: string;
  source?: string;
  upstream?: string;
  icon?: string;
  tools: DockerCatalogTool[];
  prompts?: number;
  resources?: unknown;
  secrets: DockerCatalogSecret[];
  env: Array<{ name: string; value: string }>;
  command: string[];
  volumes: string[];
  allowHosts: string[];
  disableNetwork?: boolean;
  longLived?: boolean;
  user?: string;
  config: Array<{ name: string; description?: string; schema: unknown }>;
  metadata?: {
    pulls?: number;
    stars?: number;
    githubStars?: number;
    category?: string;
    tags?: string[];
    license?: string;
    owner?: string;
  };
  oauth?: {
    providers: Array<{ provider: string; secret: string; env: string }>;
  };
  remote?: {
    url: string;
    transportType?: string;
    headers: Record<string, string>;
  };
  /** Names of keys this reader does not model; values are not carried. */
  unknownKeys: string[];
  /** JSON pointers (relative to the entry) whose values were removed for safety. */
  redactions: string[];
  issues: CompatibilityIssue[];
};

export type DockerMcpCatalog = {
  version?: string;
  name: string;
  displayName?: string;
  servers: DockerCatalogServer[];
};

export type DockerCatalogReadResult = {
  catalog?: DockerMcpCatalog;
  issues: CompatibilityIssue[];
};

const controlOrBidi = /\p{Cc}|[‪-‮⁦-⁩]/u;
const controlOrBidiAll = /\p{Cc}|[‪-‮⁦-⁩]/gu;
const reservedKeys = new Set(["__proto__", "prototype", "constructor"]);
const traversal = /(^|[\\/])\.\.?([\\/]|$)/;

export const dockerServerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const dockerSecretNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const dockerToolNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const headerNamePattern = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const allowHostPattern =
  /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*(?::\d{1,5})?$/;
const configPropertyPattern = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const providerPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Environment names that change how a process loads code or finds programs.
 * A catalog entry that sets one of these is asking the runner to alter its
 * own loader; nothing in an MCP server description needs that.
 */
export const unsafeEnvironmentNames: ReadonlySet<string> = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "LD_DEBUG_OUTPUT",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  "PERL5OPT",
  "PERL5LIB",
  "RUBYOPT",
  "RUBYLIB",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "BASH_ENV",
  "ENV",
  "PROMPT_COMMAND",
  "SHELLOPTS",
  "PS4",
  "GIT_SSH_COMMAND",
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "GCONV_PATH",
  "IFS",
]);

const credentialLikeName =
  /(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTH)/i;
const sensitiveHeaderName =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|apikey)$|(token|secret|key|password|credential)/i;
const liveCredentialShape =
  /^(ghp_|gho_|ghu_|ghs_|github_pat_|sk-|sk_live_|sk_test_|rk_live_|xox[abprs]-|AKIA[0-9A-Z]{12,}|glpat-|npm_|pypi-|AIza[0-9A-Za-z_-]{20,}|ya29\.|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.)/;
const templateValue = /^\s*(\{\{[^{}]*\}\}|\$\{[A-Za-z_][A-Za-z0-9_]*\})\s*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function escapePointerSegment(segment: string): string {
  return segment
    .replace(controlOrBidiAll, "")
    .replace(/~/g, "~0")
    .replace(/\//g, "~1")
    .slice(0, 200);
}

/** Display-safe text: controls and bidi overrides blanked, whitespace collapsed, bounded. */
export function displayText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(controlOrBidiAll, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return text.length ? text : undefined;
}

/** Looks like a placeholder or a real credential? Placeholders stay, live shapes are redacted. */
export function looksLikeLiveCredential(value: string): boolean {
  return liveCredentialShape.test(value.trim());
}

export function isTemplateValue(value: string): boolean {
  return templateValue.test(value);
}

/**
 * Parses an OCI image reference in the grammar Docker accepts:
 * `[registry[:port]/]repository[:tag][@sha256:digest]`, repository paths
 * lowercase. Anything else (whitespace, shell characters, uppercase paths,
 * unknown digest algorithms) is refused rather than normalized.
 */
export function parseImageReference(
  value: unknown,
): DockerImageReference | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 512)
    return undefined;
  if (controlOrBidi.test(value) || /\s/.test(value)) return undefined;
  const match =
    /^(?:(?<registry>(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?::\d{1,5})?|localhost(?::\d{1,5})?)\/)?(?<repository>[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*)(?::(?<tag>[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))?(?:@(?<digest>sha256:[a-f0-9]{64}))?$/.exec(
      value,
    );
  if (!match?.groups) return undefined;
  const { registry, repository, tag, digest } = match.groups;
  if (!repository) return undefined;
  return {
    raw: value,
    ...(registry ? { registry } : {}),
    repository,
    ...(tag ? { tag } : {}),
    ...(digest ? { digest } : {}),
  };
}

function declaredUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 2048)
    return undefined;
  if (controlOrBidi.test(value) || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username || url.password || url.hash) return undefined;
  return url.href;
}

function isLoopback(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

type IssueInput = Omit<CompatibilityIssue, "sourcePointer"> & {
  sourcePointer: string;
};

function issue(input: IssueInput): CompatibilityIssue {
  return {
    code: input.code,
    category: input.category,
    sourcePointer: input.sourcePointer.slice(0, 1024),
    dimension: input.dimension,
    disposition: input.disposition,
    severity: input.severity,
    executionImpact: input.executionImpact,
    message: input.message,
    ...(input.remediation ? { remediation: input.remediation } : {}),
    ...(input.normalizedPointer
      ? { normalizedPointer: input.normalizedPointer }
      : {}),
  };
}

function blocking(
  code: string,
  category: CompatibilityIssue["category"],
  pointer: string,
  message: string,
  impact: CompatibilityIssue["executionImpact"] = "blocks-definition",
  dimension: CompatibilityIssue["dimension"] = "import",
): CompatibilityIssue {
  return issue({
    code,
    category,
    sourcePointer: pointer,
    dimension,
    disposition: "rejected",
    severity: "blocking",
    executionImpact: impact,
    message,
  });
}

function warning(
  code: string,
  category: CompatibilityIssue["category"],
  pointer: string,
  message: string,
  dimension: CompatibilityIssue["dimension"] = "import",
  disposition: CompatibilityIssue["disposition"] = "adapted",
): CompatibilityIssue {
  return issue({
    code,
    category,
    sourcePointer: pointer,
    dimension,
    disposition,
    severity: "warning",
    executionImpact: "none",
    message,
  });
}

function info(
  code: string,
  category: CompatibilityIssue["category"],
  pointer: string,
  message: string,
  dimension: CompatibilityIssue["dimension"] = "import",
): CompatibilityIssue {
  return issue({
    code,
    category,
    sourcePointer: pointer,
    dimension,
    disposition: "adapted",
    severity: "info",
    executionImpact: "none",
    message,
  });
}

const boundedInertLimits = (
  depth: number,
  nodes: number,
  bytes: number,
): JsonValueLimits => ({ depth, nodes, bytes, stringLength: 8192 });

/** A bounded, reserved-key-free copy of inert JSON, or undefined when out of bounds. */
function inertJson(
  value: unknown,
  limits: JsonValueLimits,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true, value: undefined };
  const measured = measureJsonValue(value, limits);
  if (!measured.ok) return { ok: false, reason: measured.reason };
  return { ok: true, value: structuredClone(value) };
}

function readStringList(
  value: unknown,
  max: number,
  itemMax: number,
): { items: string[]; dropped: number; controls: boolean } {
  if (value === undefined || value === null)
    return { items: [], dropped: 0, controls: false };
  if (!Array.isArray(value)) return { items: [], dropped: 1, controls: false };
  const items: string[] = [];
  let dropped = 0;
  let controls = false;
  for (const item of value) {
    if (items.length >= max) {
      dropped++;
      continue;
    }
    const text =
      typeof item === "string"
        ? item
        : typeof item === "number" || typeof item === "boolean"
          ? String(item)
          : undefined;
    if (text === undefined || text.length > itemMax) {
      dropped++;
      continue;
    }
    if (controlOrBidi.test(text)) {
      controls = true;
      dropped++;
      continue;
    }
    items.push(text);
  }
  return { items, dropped, controls };
}

function scalarText(value: unknown, max: number): string | undefined {
  if (typeof value === "string")
    return value.length <= max && !controlOrBidi.test(value)
      ? value
      : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

const knownServerKeys = new Set([
  "description",
  "title",
  "type",
  "dateAdded",
  "image",
  "ref",
  "readme",
  "toolsUrl",
  "source",
  "upstream",
  "icon",
  "tools",
  "prompts",
  "resources",
  "secrets",
  "env",
  "command",
  "volumes",
  "allowHosts",
  "disableNetwork",
  "longLived",
  "user",
  "config",
  "metadata",
  "oauth",
  "remote",
]);

function readTools(
  value: unknown,
  pointer: string,
  limits: DockerCatalogLimits,
  issues: CompatibilityIssue[],
): DockerCatalogTool[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    issues.push(
      warning(
        "docker-mcp.tools.not-a-list",
        "structure",
        pointer,
        "The tools field is not a list and was ignored.",
      ),
    );
    return [];
  }
  const tools: DockerCatalogTool[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const at = `${pointer}/${index}`;
    if (tools.length >= limits.tools) {
      issues.push(
        warning(
          "docker-mcp.tools.too-many",
          "structure",
          at,
          "Tool list exceeds the reader limit; the remainder was dropped.",
        ),
      );
      return;
    }
    if (!isPlainObject(item)) {
      issues.push(
        warning(
          "docker-mcp.tool.invalid",
          "structure",
          at,
          "A tool entry is not an object and was ignored.",
        ),
      );
      return;
    }
    const name = item.name;
    if (
      typeof name !== "string" ||
      !dockerToolNamePattern.test(name) ||
      reservedKeys.has(name)
    ) {
      issues.push(
        warning(
          "docker-mcp.tool.name-invalid",
          "identity",
          `${at}/name`,
          "A tool name is missing or not a safe identifier; the tool was ignored.",
          "import",
          "rejected",
        ),
      );
      return;
    }
    if (seen.has(name)) {
      issues.push(
        warning(
          "docker-mcp.tool.duplicate",
          "identity",
          `${at}/name`,
          "A tool name appears twice; the later entry was ignored.",
        ),
      );
      return;
    }
    seen.add(name);
    const tool: DockerCatalogTool = { name };
    const description = displayText(item.description, 500);
    if (description) tool.description = description;
    if (item.parameters !== undefined) {
      const parameters = inertJson(
        item.parameters,
        boundedInertLimits(12, 512, 64 * 1024),
      );
      if (parameters.ok) tool.parameters = parameters.value;
      else
        issues.push(
          warning(
            "docker-mcp.tool.parameters-unbounded",
            "schema",
            `${at}/parameters`,
            "Tool parameters exceed the reader bounds and were dropped.",
          ),
        );
    }
    if (isPlainObject(item.container)) {
      const container: NonNullable<DockerCatalogTool["container"]> = {
        command: [],
      };
      if (item.container.image !== undefined) {
        const image = parseImageReference(item.container.image);
        if (image) container.image = image;
        else
          issues.push(
            blocking(
              "docker-mcp.image.invalid",
              "identity",
              `${at}/container/image`,
              "A tool container image reference is not a valid OCI reference.",
              "blocks-operation",
              "delegate",
            ),
          );
      }
      const command = readStringList(
        item.container.command,
        limits.command,
        512,
      );
      container.command = command.items;
      if (command.controls)
        issues.push(
          blocking(
            "docker-mcp.command.control-characters",
            "structure",
            `${at}/container/command`,
            "A container command argument contains control characters.",
            "blocks-operation",
            "delegate",
          ),
        );
      tool.container = container;
    }
    tools.push(tool);
  });
  return tools;
}

function readSecrets(
  value: unknown,
  pointer: string,
  limits: DockerCatalogLimits,
  issues: CompatibilityIssue[],
  redactions: string[],
): DockerCatalogSecret[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    issues.push(
      warning(
        "docker-mcp.secrets.not-a-list",
        "structure",
        pointer,
        "The secrets field is not a list and was ignored.",
      ),
    );
    return [];
  }
  const secrets: DockerCatalogSecret[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const at = `${pointer}/${index}`;
    if (secrets.length >= limits.secrets) return;
    if (!isPlainObject(item)) {
      issues.push(
        warning(
          "docker-mcp.secret.invalid",
          "structure",
          at,
          "A secret entry is not an object and was ignored.",
        ),
      );
      return;
    }
    const name = item.name;
    const env = item.env;
    if (
      typeof name !== "string" ||
      !dockerSecretNamePattern.test(name) ||
      reservedKeys.has(name) ||
      traversal.test(name)
    ) {
      issues.push(
        blocking(
          "docker-mcp.secret.name-invalid",
          "identity",
          `${at}/name`,
          "A secret name is missing or not a safe identifier.",
          "blocks-operation",
          "delegate",
        ),
      );
      return;
    }
    if (typeof env !== "string" || !environmentNamePattern.test(env)) {
      issues.push(
        blocking(
          "docker-mcp.secret.env-invalid",
          "identity",
          `${at}/env`,
          "A secret names an invalid environment variable.",
          "blocks-operation",
          "delegate",
        ),
      );
      return;
    }
    if (unsafeEnvironmentNames.has(env.toUpperCase())) {
      issues.push(
        blocking(
          "docker-mcp.env.unsafe-name",
          "policy",
          `${at}/env`,
          "A secret targets an environment variable that alters process loading; the entry cannot be run.",
          "blocks-operation",
          "delegate",
        ),
      );
      return;
    }
    if (seen.has(name)) {
      issues.push(
        warning(
          "docker-mcp.secret.duplicate",
          "identity",
          `${at}/name`,
          "A secret name appears twice; the later entry was ignored.",
        ),
      );
      return;
    }
    seen.add(name);
    if (Object.hasOwn(item, "value")) {
      // A catalog describes which secret a server needs; it never carries one.
      issues.push(
        blocking(
          "docker-mcp.secret.literal-value",
          "security",
          `${at}/value`,
          "A secret entry carries a literal value; catalogs must reference secrets by name only. The value was removed.",
          "blocks-operation",
          "delegate",
        ),
      );
      redactions.push(`${at}/value`);
    }
    const secret: DockerCatalogSecret = { name, env };
    const example = typeof item.example === "string" ? item.example : undefined;
    if (example !== undefined) {
      if (looksLikeLiveCredential(example)) {
        issues.push(
          warning(
            "docker-mcp.secret.example-looks-live",
            "policy",
            `${at}/example`,
            "A secret example has the shape of a live credential and was removed.",
          ),
        );
        redactions.push(`${at}/example`);
      } else {
        const text = displayText(example, 200);
        if (text) secret.example = text;
      }
    }
    const description = displayText(item.description, 500);
    if (description) secret.description = description;
    if (typeof item.required === "boolean") secret.required = item.required;
    secrets.push(secret);
  });
  return secrets;
}

function readEnv(
  value: unknown,
  pointer: string,
  limits: DockerCatalogLimits,
  issues: CompatibilityIssue[],
  redactions: string[],
): Array<{ name: string; value: string }> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    issues.push(
      warning(
        "docker-mcp.env.not-a-list",
        "structure",
        pointer,
        "The env field is not a list and was ignored.",
      ),
    );
    return [];
  }
  const env: Array<{ name: string; value: string }> = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const at = `${pointer}/${index}`;
    if (env.length >= limits.env) return;
    if (!isPlainObject(item) || typeof item.name !== "string") {
      issues.push(
        warning(
          "docker-mcp.env.invalid",
          "structure",
          at,
          "An env entry is not an object with a name and was ignored.",
        ),
      );
      return;
    }
    const name = item.name;
    if (!environmentNamePattern.test(name)) {
      issues.push(
        blocking(
          "docker-mcp.env.name-invalid",
          "identity",
          `${at}/name`,
          "An environment variable name is not valid.",
          "blocks-operation",
          "delegate",
        ),
      );
      return;
    }
    if (unsafeEnvironmentNames.has(name.toUpperCase())) {
      issues.push(
        blocking(
          "docker-mcp.env.unsafe-name",
          "policy",
          `${at}/name`,
          "An environment variable alters process loading or program lookup; the entry cannot be run.",
          "blocks-operation",
          "delegate",
        ),
      );
      return;
    }
    if (seen.has(name)) {
      issues.push(
        warning(
          "docker-mcp.env.duplicate",
          "identity",
          `${at}/name`,
          "An environment variable appears twice; the later entry was ignored.",
        ),
      );
      return;
    }
    seen.add(name);
    const text = scalarText(item.value, 4096);
    if (text === undefined) {
      issues.push(
        warning(
          "docker-mcp.env.value-invalid",
          "structure",
          `${at}/value`,
          "An environment value is not a bounded scalar and was ignored.",
        ),
      );
      return;
    }
    if (
      !isTemplateValue(text) &&
      text.length > 0 &&
      (credentialLikeName.test(name) || looksLikeLiveCredential(text))
    ) {
      issues.push(
        warning(
          "docker-mcp.env.literal-credential",
          "policy",
          `${at}/value`,
          "An environment variable carries a literal credential-like value; it was removed from the description.",
        ),
      );
      redactions.push(`${at}/value`);
      env.push({ name, value: "" });
      return;
    }
    env.push({ name, value: text });
  });
  return env;
}

function readConfig(
  value: unknown,
  pointer: string,
  limits: DockerCatalogLimits,
  issues: CompatibilityIssue[],
): DockerCatalogServer["config"] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  if (!Array.isArray(value))
    issues.push(
      info(
        "docker-mcp.config.single-object",
        "structure",
        pointer,
        "The config field is a single object; it was read as a one-item list.",
      ),
    );
  const config: DockerCatalogServer["config"] = [];
  list.forEach((item, index) => {
    const at = `${pointer}/${index}`;
    if (config.length >= limits.configs) return;
    if (!isPlainObject(item)) {
      issues.push(
        warning(
          "docker-mcp.config.invalid",
          "structure",
          at,
          "A config entry is not an object and was ignored.",
        ),
      );
      return;
    }
    const { name, description, ...schema } = item;
    if (
      typeof name !== "string" ||
      !configPropertyPattern.test(name) ||
      reservedKeys.has(name)
    ) {
      issues.push(
        warning(
          "docker-mcp.config.name-invalid",
          "identity",
          `${at}/name`,
          "A config entry has no safe name and was ignored.",
          "import",
          "rejected",
        ),
      );
      return;
    }
    if (isPlainObject(schema.properties)) {
      for (const key of Object.keys(schema.properties))
        if (!configPropertyPattern.test(key) || reservedKeys.has(key)) {
          issues.push(
            warning(
              "docker-mcp.config.property-invalid",
              "schema",
              `${at}/properties/${escapePointerSegment(key)}`,
              "A config property name is not a safe identifier and was dropped.",
              "import",
              "rejected",
            ),
          );
          delete (schema.properties as Record<string, unknown>)[key];
        }
    }
    const bounded = inertJson(schema, boundedInertLimits(10, 1024, 64 * 1024));
    if (!bounded.ok) {
      issues.push(
        warning(
          "docker-mcp.config.schema-unbounded",
          "schema",
          at,
          "A config schema exceeds the reader bounds and was dropped.",
        ),
      );
      return;
    }
    const entry: DockerCatalogServer["config"][number] = {
      name,
      schema: bounded.value,
    };
    const text = displayText(description, 500);
    if (text) entry.description = text;
    config.push(entry);
  });
  return config;
}

function readMetadata(
  value: unknown,
  pointer: string,
  limits: DockerCatalogLimits,
  issues: CompatibilityIssue[],
): DockerCatalogServer["metadata"] {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) {
    issues.push(
      warning(
        "docker-mcp.metadata.invalid",
        "structure",
        pointer,
        "The metadata field is not an object and was ignored.",
      ),
    );
    return undefined;
  }
  const metadata: NonNullable<DockerCatalogServer["metadata"]> = {};
  const pulls = nonNegativeInteger(value.pulls);
  if (pulls !== undefined) metadata.pulls = pulls;
  const stars = nonNegativeInteger(value.stars);
  if (stars !== undefined) metadata.stars = stars;
  const githubStars = nonNegativeInteger(value.githubStars);
  if (githubStars !== undefined) metadata.githubStars = githubStars;
  const category = displayText(value.category, 120);
  if (category) metadata.category = category;
  const license = displayText(value.license, 200);
  if (license) metadata.license = license;
  const owner = displayText(value.owner, 200);
  if (owner) metadata.owner = owner;
  const tags = readStringList(value.tags, limits.tags, 64);
  if (tags.items.length)
    metadata.tags = tags.items
      .map((tag) => displayText(tag, 64) ?? "")
      .filter(Boolean);
  return metadata;
}

function readOauth(
  value: unknown,
  pointer: string,
  limits: DockerCatalogLimits,
  issues: CompatibilityIssue[],
): DockerCatalogServer["oauth"] {
  if (value === undefined || value === null) return undefined;
  const providers = Array.isArray(value)
    ? value
    : isPlainObject(value) && Array.isArray(value.providers)
      ? value.providers
      : undefined;
  if (!providers) {
    issues.push(
      warning(
        "docker-mcp.oauth.invalid",
        "structure",
        pointer,
        "The oauth field is neither a providers object nor a list and was ignored.",
      ),
    );
    return undefined;
  }
  const read: NonNullable<DockerCatalogServer["oauth"]>["providers"] = [];
  providers.forEach((item, index) => {
    if (read.length >= limits.providers) return;
    const at = `${pointer}/providers/${index}`;
    if (
      !isPlainObject(item) ||
      typeof item.provider !== "string" ||
      !providerPattern.test(item.provider) ||
      typeof item.secret !== "string" ||
      !dockerSecretNamePattern.test(item.secret) ||
      typeof item.env !== "string" ||
      !environmentNamePattern.test(item.env) ||
      unsafeEnvironmentNames.has(item.env.toUpperCase())
    ) {
      issues.push(
        warning(
          "docker-mcp.oauth.provider-invalid",
          "identity",
          at,
          "An oauth provider entry is incomplete or unsafe and was ignored.",
          "import",
          "rejected",
        ),
      );
      return;
    }
    read.push({ provider: item.provider, secret: item.secret, env: item.env });
  });
  return { providers: read };
}

function readRemote(
  value: unknown,
  pointer: string,
  limits: DockerCatalogLimits,
  secrets: DockerCatalogSecret[],
  issues: CompatibilityIssue[],
  redactions: string[],
): DockerCatalogServer["remote"] {
  if (!isPlainObject(value)) {
    issues.push(
      blocking(
        "docker-mcp.remote.missing",
        "structure",
        pointer,
        "A remote server entry has no remote object.",
        "blocks-operation",
        "invoke",
      ),
    );
    return undefined;
  }
  const url = declaredUrl(value.url);
  if (!url) {
    issues.push(
      blocking(
        "docker-mcp.remote.url-invalid",
        "network",
        `${pointer}/url`,
        "The remote URL is missing, malformed, or carries credentials or a fragment.",
        "blocks-operation",
        "invoke",
      ),
    );
    return undefined;
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && !isLoopback(parsed)) {
    issues.push(
      blocking(
        "docker-mcp.remote.url-insecure",
        "network",
        `${pointer}/url`,
        "The remote URL is plain HTTP on a non-loopback host.",
        "blocks-operation",
        "invoke",
      ),
    );
    return undefined;
  }
  const remote: NonNullable<DockerCatalogServer["remote"]> = {
    url,
    headers: {},
  };
  const transport = displayText(value.transport_type, 64);
  if (transport) {
    remote.transportType = transport;
    if (transport !== "streamable-http" && transport !== "sse")
      issues.push(
        warning(
          "docker-mcp.remote.transport-unknown",
          "structure",
          `${pointer}/transport_type`,
          "The remote transport type is not one this reader knows; it is preserved as declared.",
        ),
      );
  }
  if (value.headers !== undefined && value.headers !== null) {
    if (!isPlainObject(value.headers)) {
      issues.push(
        warning(
          "docker-mcp.remote.headers-invalid",
          "structure",
          `${pointer}/headers`,
          "Remote headers are not an object and were ignored.",
        ),
      );
    } else {
      const secretEnvs = new Set(secrets.map((secret) => secret.env));
      let count = 0;
      for (const [name, raw] of Object.entries(value.headers)) {
        const at = `${pointer}/headers/${escapePointerSegment(name)}`;
        if (++count > limits.headers) break;
        if (!headerNamePattern.test(name)) {
          issues.push(
            warning(
              "docker-mcp.remote.header-name-invalid",
              "structure",
              at,
              "A remote header name is not a valid token and was dropped.",
              "import",
              "rejected",
            ),
          );
          continue;
        }
        const text = scalarText(raw, 512);
        if (text === undefined) {
          issues.push(
            warning(
              "docker-mcp.remote.header-value-invalid",
              "structure",
              at,
              "A remote header value is not a bounded scalar and was dropped.",
            ),
          );
          continue;
        }
        if (isTemplateValue(text)) {
          const variable = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(text)?.[1];
          if (variable && !secretEnvs.has(variable))
            issues.push(
              warning(
                "docker-mcp.remote.header-unbound-variable",
                "structure",
                at,
                "A remote header references a variable no declared secret provides.",
              ),
            );
          remote.headers[name] = text;
          continue;
        }
        if (sensitiveHeaderName.test(name) || looksLikeLiveCredential(text)) {
          issues.push(
            blocking(
              "docker-mcp.remote.header-literal-credential",
              "security",
              at,
              "A remote header carries a literal credential; catalogs must reference secrets by variable. The value was removed.",
              "blocks-operation",
              "invoke",
            ),
          );
          redactions.push(at);
          continue;
        }
        remote.headers[name] = text;
      }
    }
  }
  return remote;
}

function readServer(
  id: string,
  value: unknown,
  pointer: string,
  limits: DockerCatalogLimits,
): DockerCatalogServer | { dropped: CompatibilityIssue[] } {
  const issues: CompatibilityIssue[] = [];
  const redactions: string[] = [];
  if (!isPlainObject(value))
    return {
      dropped: [
        blocking(
          "docker-mcp.server.invalid",
          "structure",
          pointer,
          "A registry entry is not an object.",
        ),
      ],
    };
  const type = value.type;
  if (
    typeof type !== "string" ||
    !(dockerServerTypes as readonly string[]).includes(type)
  )
    return {
      dropped: [
        blocking(
          "docker-mcp.server.type-unknown",
          "structure",
          `${pointer}/type`,
          "A registry entry has no known type (server, remote or poci).",
        ),
      ],
    };
  const server: DockerCatalogServer = {
    id,
    type: type as DockerServerType,
    tools: [],
    secrets: [],
    env: [],
    command: [],
    volumes: [],
    allowHosts: [],
    config: [],
    unknownKeys: [],
    redactions,
    issues,
  };
  const title = displayText(value.title, 200);
  if (title) server.title = title;
  const description = displayText(value.description, 500);
  if (description) server.description = description;
  if (value.dateAdded !== undefined) {
    const date =
      typeof value.dateAdded === "string" &&
      z.iso.datetime({ offset: true }).safeParse(value.dateAdded).success
        ? value.dateAdded
        : undefined;
    if (date) server.dateAdded = date;
    else
      issues.push(
        warning(
          "docker-mcp.server.date-invalid",
          "structure",
          `${pointer}/dateAdded`,
          "dateAdded is not an RFC 3339 timestamp and was ignored.",
        ),
      );
  }
  if (value.image !== undefined && value.image !== "") {
    const image = parseImageReference(value.image);
    if (image) {
      server.image = image;
      if (!image.digest)
        issues.push(
          info(
            "docker-mcp.image.unpinned",
            "version",
            `${pointer}/image`,
            "The image reference is not digest-pinned; a runner cannot prove which bytes it would run.",
            "delegate",
          ),
        );
    } else
      return {
        dropped: [
          blocking(
            "docker-mcp.image.invalid",
            "identity",
            `${pointer}/image`,
            "The image reference is not a valid OCI reference.",
          ),
        ],
      };
  } else if (server.type === "server")
    return {
      dropped: [
        blocking(
          "docker-mcp.image.missing",
          "identity",
          `${pointer}/image`,
          "A containerized server entry has no image.",
        ),
      ],
    };
  const ref =
    typeof value.ref === "string" ? displayText(value.ref, 512) : undefined;
  if (ref) server.ref = ref;
  for (const key of [
    "readme",
    "toolsUrl",
    "source",
    "upstream",
    "icon",
  ] as const) {
    const raw = value[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const url = declaredUrl(raw);
    if (url) server[key] = url;
    else
      issues.push(
        warning(
          "docker-mcp.link.invalid",
          "structure",
          `${pointer}/${key}`,
          `The ${key} link is not a plain http(s) URL and was dropped.`,
        ),
      );
  }
  server.tools = readTools(value.tools, `${pointer}/tools`, limits, issues);
  const prompts = nonNegativeInteger(value.prompts);
  if (prompts !== undefined) server.prompts = prompts;
  if (value.resources !== undefined) {
    const resources = inertJson(
      value.resources,
      boundedInertLimits(6, 64, 8192),
    );
    if (resources.ok) server.resources = resources.value;
  }
  server.secrets = readSecrets(
    value.secrets,
    `${pointer}/secrets`,
    limits,
    issues,
    redactions,
  );
  server.env = readEnv(value.env, `${pointer}/env`, limits, issues, redactions);
  const command = readStringList(value.command, limits.command, 512);
  server.command = command.items;
  if (command.controls)
    issues.push(
      blocking(
        "docker-mcp.command.control-characters",
        "structure",
        `${pointer}/command`,
        "A command argument contains control characters.",
        "blocks-operation",
        "delegate",
      ),
    );
  const volumes = readStringList(value.volumes, limits.volumes, 512);
  server.volumes = volumes.items;
  for (const [index, volume] of volumes.items.entries())
    if (
      !isTemplateValue(volume) &&
      (/^([A-Za-z]:\\|\/|~)/.test(volume) || traversal.test(volume))
    )
      issues.push(
        warning(
          "docker-mcp.volume.host-path",
          "policy",
          `${pointer}/volumes/${index}`,
          "A volume names a host path; a trusted local runner must review it before mounting anything.",
          "delegate",
          "requires-configuration",
        ),
      );
  const allowHosts = readStringList(value.allowHosts, limits.allowHosts, 300);
  for (const [index, host] of allowHosts.items.entries())
    if (allowHostPattern.test(host)) server.allowHosts.push(host);
    else
      issues.push(
        warning(
          "docker-mcp.allow-host.invalid",
          "network",
          `${pointer}/allowHosts/${index}`,
          "An allowHosts entry is not a host[:port] and was dropped.",
        ),
      );
  if (typeof value.disableNetwork === "boolean")
    server.disableNetwork = value.disableNetwork;
  if (typeof value.longLived === "boolean") server.longLived = value.longLived;
  const user = displayText(value.user, 128);
  if (user) server.user = user;
  server.config = readConfig(value.config, `${pointer}/config`, limits, issues);
  const metadata = readMetadata(
    value.metadata,
    `${pointer}/metadata`,
    limits,
    issues,
  );
  if (metadata) server.metadata = metadata;
  const oauth = readOauth(value.oauth, `${pointer}/oauth`, limits, issues);
  if (oauth) server.oauth = oauth;
  if (server.type === "remote" || value.remote !== undefined) {
    const remote = readRemote(
      value.remote,
      `${pointer}/remote`,
      limits,
      server.secrets,
      issues,
      redactions,
    );
    if (remote) server.remote = remote;
  }
  for (const key of Object.keys(value))
    if (!knownServerKeys.has(key) && server.unknownKeys.length < 32)
      server.unknownKeys.push(key.replace(controlOrBidiAll, "").slice(0, 64));
  if (server.unknownKeys.length)
    issues.push(
      info(
        "docker-mcp.server.unknown-keys",
        "structure",
        pointer,
        `${server.unknownKeys.length} field(s) unknown to this reader were noted by name and not carried.`,
      ),
    );
  return server;
}

/**
 * Reads one catalog document. YAML is parsed with the core schema only
 * (no custom tags, no merge keys), duplicate keys are errors, alias count is
 * bounded before expansion, and the resulting value is measured for depth,
 * node count and reserved keys before any field is interpreted. A document
 * that fails any of these produces sanitized blocking issues and no catalog.
 */
export function readDockerMcpCatalog(
  text: string,
  options: { limits?: Partial<DockerCatalogLimits> } = {},
): DockerCatalogReadResult {
  const limits: DockerCatalogLimits = {
    ...DOCKER_CATALOG_LIMITS,
    ...options.limits,
  };
  const issues: CompatibilityIssue[] = [];
  if (typeof text !== "string")
    return {
      issues: [
        blocking(
          "docker-mcp.catalog.not-text",
          "structure",
          "",
          "The catalog is not text.",
        ),
      ],
    };
  if (new TextEncoder().encode(text).byteLength > limits.bytes)
    return {
      issues: [
        blocking(
          "docker-mcp.catalog.too-large",
          "structure",
          "",
          "The catalog exceeds the import size limit.",
        ),
      ],
    };
  let documents;
  try {
    documents = parseAllDocuments(text, {
      uniqueKeys: true,
      schema: "core",
      version: "1.2",
      logLevel: "silent",
      strict: true,
    });
  } catch {
    return {
      issues: [
        blocking(
          "docker-mcp.catalog.yaml-invalid",
          "structure",
          "",
          "The catalog is not well-formed YAML.",
        ),
      ],
    };
  }
  if (documents.length !== 1)
    return {
      issues: [
        blocking(
          "docker-mcp.catalog.document-count",
          "structure",
          "",
          "A catalog file must contain exactly one YAML document.",
        ),
      ],
    };
  const document = documents[0]!;
  if (document.errors.length)
    return {
      issues: [
        blocking(
          "docker-mcp.catalog.yaml-invalid",
          "structure",
          "",
          document.errors.some((error) => error.code === "DUPLICATE_KEY")
            ? "The catalog contains duplicate keys."
            : "The catalog is not well-formed YAML.",
        ),
      ],
    };
  if (document.warnings.length)
    return {
      issues: [
        blocking(
          "docker-mcp.catalog.yaml-unsupported-tag",
          "structure",
          "",
          "The catalog uses YAML tags or features outside the core schema.",
        ),
      ],
    };
  let aliases = 0;
  visit(document, {
    Alias: () => {
      aliases++;
      return aliases > limits.aliases ? visit.BREAK : undefined;
    },
  });
  if (aliases > limits.aliases)
    return {
      issues: [
        blocking(
          "docker-mcp.catalog.yaml-aliases",
          "structure",
          "",
          "The catalog uses more YAML aliases than the reader permits.",
        ),
      ],
    };
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: limits.aliases });
  } catch {
    return {
      issues: [
        blocking(
          "docker-mcp.catalog.yaml-expansion",
          "structure",
          "",
          "The catalog could not be expanded within the reader bounds.",
        ),
      ],
    };
  }
  const measured = measureJsonValue(value, {
    depth: limits.depth,
    nodes: limits.nodes,
    bytes: limits.bytes * 2,
    stringLength: limits.stringLength,
  });
  if (!measured.ok)
    return {
      issues: [
        blocking(
          measured.reason === "reserved-key"
            ? "docker-mcp.catalog.reserved-key"
            : "docker-mcp.catalog.bounds",
          "structure",
          "",
          measured.reason === "reserved-key"
            ? "The catalog uses a reserved object key."
            : `The catalog exceeds reader bounds (${measured.reason}).`,
        ),
      ],
    };
  if (!isPlainObject(value))
    return {
      issues: [
        blocking(
          "docker-mcp.catalog.not-an-object",
          "structure",
          "",
          "The catalog root is not a mapping.",
        ),
      ],
    };
  const name = typeof value.name === "string" ? value.name : undefined;
  if (!name || !dockerServerIdPattern.test(name) || reservedKeys.has(name))
    return {
      issues: [
        blocking(
          "docker-mcp.catalog.name-invalid",
          "identity",
          "/name",
          "The catalog has no safe name.",
        ),
      ],
    };
  if (!isPlainObject(value.registry))
    return {
      issues: [
        blocking(
          "docker-mcp.catalog.registry-missing",
          "structure",
          "/registry",
          "The catalog has no registry mapping.",
        ),
      ],
    };
  const catalog: DockerMcpCatalog = { name, servers: [] };
  const displayName = displayText(value.displayName, 200);
  if (displayName) catalog.displayName = displayName;
  const version =
    typeof value.version === "number" || typeof value.version === "string"
      ? String(value.version).slice(0, 32)
      : undefined;
  if (version) catalog.version = version;
  if (version !== DOCKER_CATALOG_FORMAT_VERSION)
    issues.push(
      info(
        "docker-mcp.catalog.version-unrecognized",
        "version",
        "/version",
        "The catalog does not declare the version 2 format this reader was written against; fields are read on a best-effort basis.",
      ),
    );
  const entries = Object.entries(value.registry);
  if (entries.length > limits.servers)
    return {
      issues: [
        blocking(
          "docker-mcp.catalog.too-many-servers",
          "structure",
          "/registry",
          "The catalog lists more servers than the reader permits.",
        ),
      ],
    };
  for (const [id, entry] of entries) {
    const pointer = `/registry/${escapePointerSegment(id)}`;
    if (
      !dockerServerIdPattern.test(id) ||
      reservedKeys.has(id) ||
      traversal.test(id)
    ) {
      issues.push(
        blocking(
          "docker-mcp.server.id-invalid",
          "identity",
          pointer,
          "A server id is not a safe identifier; the entry was not imported.",
        ),
      );
      continue;
    }
    const server = readServer(id, entry, pointer, limits);
    if ("dropped" in server) {
      issues.push(...server.dropped);
      continue;
    }
    issues.push(...server.issues);
    catalog.servers.push(server);
  }
  return { catalog, issues };
}

/** True when an entry carries a blocking issue that stops a runner from executing it. */
export function serverExecutionBlocked(server: DockerCatalogServer): boolean {
  return server.issues.some(
    (item) =>
      item.severity === "blocking" &&
      (item.executionImpact === "blocks-operation" ||
        item.executionImpact === "blocks-definition"),
  );
}
