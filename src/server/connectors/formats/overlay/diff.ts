import {
  canonicalConnectorJson,
  type CompatibilityIssue,
} from "../../../../core/connectors/index.js";
import { IssueCollector, token } from "../openapi/issues.js";
import { entriesOf, isRecord } from "../openapi/refs.js";

/*
 * A structural diff that answers one question: may an approval granted against
 * the document before the transformation still be used after it?
 *
 * Anything that changes where a request goes, who issues the credential, what
 * the credential is allowed to do, where a value is carried, or which
 * requirements an operation enforces is a security change. Security changes
 * invalidate the approval. Everything else (summaries, descriptions, tags,
 * examples) is reported but leaves the approval intact, because re-reviewing a
 * typo fix trains operators to approve without reading.
 */

export interface OverlayChange {
  path: string;
  kind:
    | "server-added"
    | "server-removed"
    | "server-changed"
    | "operation-added"
    | "operation-removed"
    | "security-requirement-changed"
    | "security-scheme-added"
    | "security-scheme-changed"
    | "issuer-changed"
    | "scope-widened"
    | "scope-narrowed"
    | "parameter-location-changed"
    | "parameter-added"
    | "parameter-removed"
    | "request-body-changed"
    | "annotation-changed";
  category: CompatibilityIssue["category"];
  security: boolean;
  detail: string;
}

export interface OverlayDiff {
  changes: OverlayChange[];
  /** True when any security-category change was found. */
  securityAffected: boolean;
  /** False when the approval granted against `before` may not be reused. */
  approvalReusable: boolean;
  issues: CompatibilityIssue[];
}

const METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
  "query",
]);

const at = (path: string, key: string | number): string =>
  typeof key === "number" ? `${path}[${key}]` : `${path}/${key}`;

function serverUrls(document: unknown, path: string): Map<string, string> {
  const found = new Map<string, string>();
  if (!isRecord(document)) return found;
  const collect = (value: unknown, where: string) => {
    if (!Array.isArray(value)) return;
    value.forEach((server, index) => {
      if (isRecord(server) && typeof server.url === "string")
        found.set(`${where}[${index}]`, server.url);
    });
  };
  collect(document.servers, `${path}/servers`);
  // Swagger 2.0 spells its single server across three fields.
  if (
    typeof document.host === "string" ||
    typeof document.basePath === "string"
  ) {
    const schemes = Array.isArray(document.schemes)
      ? document.schemes.filter(
          (item): item is string => typeof item === "string",
        )
      : [""];
    for (const scheme of schemes)
      found.set(
        `${path}/host:${scheme}`,
        `${scheme ? `${scheme}://` : ""}${typeof document.host === "string" ? document.host : ""}${typeof document.basePath === "string" ? document.basePath : ""}`,
      );
  }
  if (isRecord(document.paths))
    for (const [route, item] of entriesOf(document.paths)) {
      if (!isRecord(item)) continue;
      collect(item.servers, `${path}/paths/${route}/servers`);
      for (const [method, operation] of entriesOf(item))
        if (METHODS.has(method) && isRecord(operation))
          collect(
            operation.servers,
            `${path}/paths/${route}/${method}/servers`,
          );
    }
  return found;
}

interface OperationView {
  security?: unknown;
  parameters: Map<string, { in: string; required: boolean }>;
  requestBody?: string;
}

function operations(document: unknown): Map<string, OperationView> {
  const found = new Map<string, OperationView>();
  if (!isRecord(document) || !isRecord(document.paths)) return found;
  for (const [route, item] of entriesOf(document.paths)) {
    if (!isRecord(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const [method, operation] of entriesOf(item)) {
      if (!METHODS.has(method) || !isRecord(operation)) continue;
      const parameters = new Map<string, { in: string; required: boolean }>();
      for (const raw of [
        ...shared,
        ...(Array.isArray(operation.parameters) ? operation.parameters : []),
      ])
        if (
          isRecord(raw) &&
          typeof raw.name === "string" &&
          typeof raw.in === "string"
        )
          parameters.set(raw.name, {
            in: raw.in,
            required: raw.required === true,
          });
      found.set(`${method.toUpperCase()} ${route}`, {
        ...(Object.hasOwn(operation, "security")
          ? { security: operation.security }
          : {}),
        parameters,
        ...(operation.requestBody === undefined
          ? {}
          : { requestBody: canonicalConnectorJson(operation.requestBody) }),
      });
    }
  }
  return found;
}

function schemes(document: unknown): Map<string, Record<string, unknown>> {
  const found = new Map<string, Record<string, unknown>>();
  if (!isRecord(document)) return found;
  const container = isRecord(document.components)
    ? document.components.securitySchemes
    : document.securityDefinitions;
  if (!isRecord(container)) return found;
  for (const [name, value] of entriesOf(container))
    if (isRecord(value)) found.set(name, value);
  return found;
}

/** Every scope a scheme's flows mention, so widening is visible wherever it happens. */
function schemeScopes(scheme: Record<string, unknown>): Set<string> {
  const scopes = new Set<string>();
  const add = (value: unknown) => {
    if (isRecord(value))
      for (const [name] of entriesOf(value)) scopes.add(name);
  };
  add(scheme.scopes);
  if (isRecord(scheme.flows))
    for (const [, flow] of entriesOf(scheme.flows))
      if (isRecord(flow)) add(flow.scopes);
  return scopes;
}

function schemeIssuer(scheme: Record<string, unknown>): string[] {
  const urls: string[] = [];
  for (const key of ["openIdConnectUrl", "oauth2MetadataUrl"] as const)
    if (typeof scheme[key] === "string") urls.push(`${key}=${scheme[key]}`);
  if (isRecord(scheme.flows))
    for (const [name, flow] of entriesOf(scheme.flows))
      if (isRecord(flow))
        for (const key of [
          "authorizationUrl",
          "tokenUrl",
          "refreshUrl",
          "deviceAuthorizationUrl",
        ] as const)
          if (typeof flow[key] === "string")
            urls.push(`${name}.${key}=${flow[key]}`);
  for (const key of ["authorizationUrl", "tokenUrl"] as const)
    if (typeof scheme[key] === "string") urls.push(`${key}=${scheme[key]}`);
  return urls.sort();
}

/** Requirement alternatives as comparable text: scheme names with their scopes. */
function requirementText(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!isRecord(item)) return "?";
    if (entriesOf(item).length === 0) return "{} (anonymous)";
    return entriesOf(item)
      .map(([name, scopes]) => {
        const list = Array.isArray(scopes)
          ? scopes.filter((scope): scope is string => typeof scope === "string")
          : [];
        return `${name}[${[...list].sort().join(" ")}]`;
      })
      .sort()
      .join(" AND ");
  });
}

/**
 * Compares two documents and reports what changed, with security changes
 * separated from cosmetic ones.
 */
export function diffOverlay(before: unknown, after: unknown): OverlayDiff {
  const changes: OverlayChange[] = [];
  const issues = new IssueCollector(256);
  const record = (change: OverlayChange) => {
    changes.push(change);
    issues.add({
      code: `${change.category}.${change.kind}`,
      category: change.category,
      pointer: change.path,
      dimension: change.security ? "invoke" : "import",
      severity: change.security ? "blocking" : "info",
      disposition: change.security ? "rejected" : "adapted",
      ...(change.security
        ? { executionImpact: "blocks-operation" as const }
        : {}),
      message: change.detail,
    });
  };

  const beforeServers = new Set(serverUrls(before, "#").values());
  const afterServersByPath = serverUrls(after, "#");
  const afterServers = new Set(afterServersByPath.values());
  for (const [path, url] of afterServersByPath)
    if (!beforeServers.has(url))
      record({
        path,
        kind: "server-added",
        category: "security",
        security: true,
        detail:
          "The transformation introduces a server the approved document did not declare; an overlay cannot authorize a new destination, so the approval no longer covers this document.",
      });
  for (const [path, url] of serverUrls(before, "#"))
    if (!afterServers.has(url))
      record({
        path,
        kind: "server-removed",
        category: "network",
        security: false,
        detail:
          "The transformation removes a declared server; operations pinned to it lose their declared destination.",
      });

  const beforeOperations = operations(before);
  const afterOperations = operations(after);
  for (const [key, view] of afterOperations) {
    const previous = beforeOperations.get(key);
    if (!previous) {
      record({
        path: `#/paths/${token(key, 160)}`,
        kind: "operation-added",
        category: "security",
        security: true,
        detail:
          "The transformation introduces an operation the approved document did not describe; an overlay cannot approve an endpoint.",
      });
      continue;
    }
    const beforeRequirements = requirementText(previous.security);
    const afterRequirements = requirementText(view.security);
    if (
      canonicalConnectorJson(beforeRequirements) !==
      canonicalConnectorJson(afterRequirements)
    )
      record({
        path: `#/paths/${token(key, 160)}/security`,
        kind: "security-requirement-changed",
        category: "security",
        security: true,
        detail:
          "The transformation changes which security requirements an operation enforces; the approval was granted against the previous requirements.",
      });
    for (const [name, parameter] of view.parameters) {
      const previousParameter = previous.parameters.get(name);
      if (!previousParameter) {
        record({
          path: `#/paths/${token(key, 160)}/parameters/${token(name, 64)}`,
          kind: "parameter-added",
          category:
            parameter.in === "query" || parameter.in === "header"
              ? "security"
              : "structure",
          security: parameter.in === "query" || parameter.in === "header",
          detail:
            "The transformation adds a parameter the approved document did not describe; a value the approval never reviewed would be carried on the request.",
        });
        continue;
      }
      if (previousParameter.in !== parameter.in)
        record({
          path: `#/paths/${token(key, 160)}/parameters/${token(name, 64)}`,
          kind: "parameter-location-changed",
          category: "security",
          security: true,
          detail: `The transformation moves a parameter from ${token(previousParameter.in, 16)} to ${token(parameter.in, 16)}; a value reviewed for one location would be carried in another.`,
        });
    }
    for (const [name] of previous.parameters)
      if (!view.parameters.has(name))
        record({
          path: `#/paths/${token(key, 160)}/parameters/${token(name, 64)}`,
          kind: "parameter-removed",
          category: "structure",
          security: false,
          detail:
            "The transformation removes a parameter the approved document described.",
        });
    if (previous.requestBody !== view.requestBody)
      record({
        path: `#/paths/${token(key, 160)}/requestBody`,
        kind: "request-body-changed",
        category: "schema",
        security: false,
        detail:
          "The transformation changes the request body description; the compiled schema must be rebuilt before it is used.",
      });
  }
  for (const [key] of beforeOperations)
    if (!afterOperations.has(key))
      record({
        path: `#/paths/${token(key, 160)}`,
        kind: "operation-removed",
        category: "structure",
        security: false,
        detail:
          "The transformation removes an operation the approved document described.",
      });

  const beforeSchemes = schemes(before);
  const afterSchemes = schemes(after);
  for (const [name, scheme] of afterSchemes) {
    const previous = beforeSchemes.get(name);
    if (!previous) {
      record({
        path: at("#/components/securitySchemes", name),
        kind: "security-scheme-added",
        category: "security",
        security: true,
        detail:
          "The transformation introduces a security scheme the approved document did not declare.",
      });
      continue;
    }
    if (
      previous.type !== scheme.type ||
      previous.in !== scheme.in ||
      previous.name !== scheme.name
    )
      record({
        path: at("#/components/securitySchemes", name),
        kind: "security-scheme-changed",
        category: "security",
        security: true,
        detail:
          "The transformation changes a security scheme's type or where its credential is carried; the approval was granted against the previous placement.",
      });
    const beforeIssuer = schemeIssuer(previous);
    const afterIssuer = schemeIssuer(scheme);
    if (
      canonicalConnectorJson(beforeIssuer) !==
      canonicalConnectorJson(afterIssuer)
    )
      record({
        path: at("#/components/securitySchemes", name),
        kind: "issuer-changed",
        category: "security",
        security: true,
        detail:
          "The transformation changes an authorization endpoint, token endpoint or discovery URL; the credential would be obtained from a different issuer than the one reviewed.",
      });
    const beforeScopes = schemeScopes(previous);
    const afterScopes = schemeScopes(scheme);
    const added = [...afterScopes].filter((scope) => !beforeScopes.has(scope));
    const removed = [...beforeScopes].filter(
      (scope) => !afterScopes.has(scope),
    );
    if (added.length)
      record({
        path: at("#/components/securitySchemes", name),
        kind: "scope-widened",
        category: "security",
        security: true,
        detail: `The transformation declares ${added.length} scope(s) the approved document did not; an overlay cannot expand grant authority.`,
      });
    if (removed.length)
      record({
        path: at("#/components/securitySchemes", name),
        kind: "scope-narrowed",
        category: "security",
        security: false,
        detail: `The transformation removes ${removed.length} declared scope(s); requests that relied on them may be refused upstream.`,
      });
  }
  for (const [name] of beforeSchemes)
    if (!afterSchemes.has(name))
      record({
        path: at("#/components/securitySchemes", name),
        kind: "security-scheme-changed",
        category: "security",
        security: true,
        detail:
          "The transformation removes a security scheme the approved document declared; operations that referenced it can no longer be satisfied as reviewed.",
      });

  const beforeRoot = requirementText(
    isRecord(before) ? before.security : undefined,
  );
  const afterRoot = requirementText(
    isRecord(after) ? after.security : undefined,
  );
  if (canonicalConnectorJson(beforeRoot) !== canonicalConnectorJson(afterRoot))
    record({
      path: "#/security",
      kind: "security-requirement-changed",
      category: "security",
      security: true,
      detail:
        "The transformation changes the document's default security requirements, which every operation without its own requirements inherits.",
    });

  const securityAffected = changes.some((change) => change.security);
  return {
    changes,
    securityAffected,
    approvalReusable: !securityAffected,
    issues: issues.issues,
  };
}
