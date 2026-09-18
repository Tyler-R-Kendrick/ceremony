import type {
  AuthenticationProfile,
  CompatibilityIssue,
  NormalizedDefinition,
} from "../../../../core/connectors/index.js";
import type { BoundOperation, RuntimeBinding } from "../../binding.js";
import { IssueCollector, safeText, token } from "./issues.js";
import { planSettingsOf, type OperationPlan } from "./plan.js";
import type { CompiledSchema } from "./schema.js";

/*
 * Export emits a description of what was approved, as OpenAPI 3.1. It is a
 * publication boundary, so it is built by construction, not by copying: no
 * private destination, no configuration value, no credential, no source
 * example, no persistence reference. When a binding is supplied only its
 * operations are emitted, because those are the only ones a reader may assume
 * this deployment will execute. Everything the export cannot carry is reported
 * as a loss, and security-critical losses are blocking.
 */

export const EXPORT_VERSION = "3.1.1";

export interface ExportOptions {
  /** When present, only this binding's operations are exported. */
  binding?: RuntimeBinding;
  includeNativeExtensions?: boolean;
  title?: string;
  version?: string;
}

export interface OpenApiExport {
  document: Record<string, unknown>;
  losses: CompatibilityIssue[];
}

function schemaToJson(
  schema: CompiledSchema,
  definitions: Record<string, CompiledSchema>,
  names: Map<string, string>,
  depth = 0,
): unknown {
  if (depth > 32) return true;
  if (schema.kind === "any") return true;
  if (schema.kind === "never") return false;
  if (schema.kind === "ref") {
    const name = names.get(schema.name);
    return name ? { $ref: `#/components/schemas/${name}` } : true;
  }
  const out: Record<string, unknown> = {};
  if (schema.types?.length)
    out.type = schema.types.length === 1 ? schema.types[0] : [...schema.types];
  if (schema.enum) out.enum = schema.enum;
  if (schema.const !== undefined) out.const = schema.const;
  if (schema.format) out.format = schema.format;
  for (const key of [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "minProperties",
    "maxProperties",
  ] as const)
    if (schema[key] !== undefined) out[key] = schema[key];
  if (schema.uniqueItems) out.uniqueItems = true;
  if (schema.items)
    out.items = schemaToJson(schema.items, definitions, names, depth + 1);
  if (schema.properties) {
    const properties: Record<string, unknown> = {};
    for (const [name, property] of Object.entries(schema.properties))
      properties[name] = schemaToJson(property, definitions, names, depth + 1);
    out.properties = properties;
  }
  if (schema.required?.length) out.required = [...schema.required];
  if (typeof schema.additionalProperties === "boolean")
    out.additionalProperties = schema.additionalProperties;
  else if (schema.additionalProperties)
    out.additionalProperties = schemaToJson(
      schema.additionalProperties,
      definitions,
      names,
      depth + 1,
    );
  if (schema.title) out.title = schema.title;
  if (schema.description) out.description = schema.description;
  if (schema.deprecated) out.deprecated = true;
  if (schema.readOnly) out.readOnly = true;
  if (schema.writeOnly) out.writeOnly = true;
  return out;
}

/** A component name for a compiled definition key; stable, collision-free, never a path. */
function componentNames(plans: OperationPlan[]): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  let counter = 0;
  for (const plan of plans)
    for (const key of Object.keys(plan.definitions)) {
      if (names.has(key)) continue;
      const tail = key.split("/").pop() ?? "Schema";
      let candidate = tail.replace(/[^A-Za-z0-9_.-]/g, "") || "Schema";
      if (!/^[A-Za-z_]/.test(candidate)) candidate = `Schema${candidate}`;
      while (used.has(candidate)) candidate = `${tail}_${++counter}`;
      used.add(candidate);
      names.set(key, candidate);
    }
  return names;
}

function securitySchemeFor(
  profile: AuthenticationProfile,
): Record<string, unknown> | undefined {
  switch (profile.kind) {
    case "api-key":
      return {
        type: "apiKey",
        in: profile.placement,
        name: profile.parameterName,
      };
    case "http-basic":
      return { type: "http", scheme: "basic" };
    case "http-bearer":
      return {
        type: "http",
        scheme: "bearer",
        ...(profile.format ? { bearerFormat: profile.format } : {}),
      };
    case "openid-connect":
      return {
        type: "openIdConnect",
        openIdConnectUrl: `${profile.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
      };
    case "mutual-tls":
      return { type: "mutualTLS" };
    case "oauth-authorization-code":
      return {
        type: "oauth2",
        flows: {
          authorizationCode: {
            ...(profile.authorizationEndpoint
              ? { authorizationUrl: profile.authorizationEndpoint }
              : {}),
            ...(profile.tokenEndpoint ? { tokenUrl: profile.tokenEndpoint } : {}),
            scopes: Object.fromEntries(profile.scopes.map((scope) => [scope, ""])),
          },
        },
      };
    case "oauth-client-credentials":
      return {
        type: "oauth2",
        flows: {
          clientCredentials: {
            ...(profile.tokenEndpoint ? { tokenUrl: profile.tokenEndpoint } : {}),
            scopes: Object.fromEntries(profile.scopes.map((scope) => [scope, ""])),
          },
        },
      };
    default:
      return undefined;
  }
}

/**
 * Emits an OpenAPI 3.1 description of the approved surface. With a binding,
 * only bound operations are emitted and the server is a placeholder, because
 * the approved destination is deployment-private.
 */
export function exportOpenApi(
  definition: NormalizedDefinition,
  options: ExportOptions = {},
): OpenApiExport {
  const losses = new IssueCollector(512);
  const binding = options.binding;
  const settings = binding ? planSettingsOf(binding) : undefined;
  const bound: BoundOperation[] = binding ? binding.operations : [];
  const plans: OperationPlan[] = [];
  const planFor = new Map<string, OperationPlan>();
  for (const operation of bound) {
    const plan = settings?.plans[operation.operationRef];
    if (plan) {
      plans.push(plan);
      planFor.set(operation.operationRef, plan);
    }
  }
  const names = componentNames(plans);

  const capabilityById = new Map(
    definition.capabilities.map((capability) => [capability.nativeId, capability]),
  );
  const profileById = new Map(
    definition.authentication.map((profile) => [profile.id, profile]),
  );

  const paths: Record<string, Record<string, unknown>> = {};
  const usedSchemes = new Map<string, Record<string, unknown>>();
  const schemeNameFor = new Map<string, string>();

  const emit = (operation: BoundOperation, plan: OperationPlan) => {
    const capability = capabilityById.get(operation.nativeId);
    const item = (paths[plan.pathTemplate] ??= {});
    const method = plan.method.toLowerCase();
    const parameters = plan.parameters.map((parameter) => ({
      name: parameter.name,
      in: parameter.in,
      required: parameter.required,
      style: parameter.style,
      explode: parameter.explode,
      ...(parameter.allowReserved ? { allowReserved: true } : {}),
      schema: schemaToJson(parameter.schema, plan.definitions, names),
    }));
    const security = plan.security.profiles.length
      ? [
          Object.fromEntries(
            plan.security.profiles.map((entry) => {
              const profile = profileById.get(entry.profileId);
              const scheme = profile ? securitySchemeFor(profile) : undefined;
              if (profile && scheme) {
                const name = entry.scheme;
                usedSchemes.set(name, scheme);
                schemeNameFor.set(entry.profileId, name);
                return [name, [...entry.scopes]];
              }
              losses.add({
                code: "security.profile-not-exportable",
                category: "security",
                pointer: `#/operations/${token(operation.nativeId, 64)}`,
                dimension: "export",
                severity: "blocking",
                disposition: "unsupported",
                message:
                  "An operation is bound to an authentication profile that has no OpenAPI security scheme spelling; the exported description would understate what the operation requires.",
              });
              return [entry.scheme, [...entry.scopes]];
            }),
          ),
        ]
      : [{}];
    const responses: Record<string, unknown> = {};
    for (const response of plan.responses)
      responses[response.status] = {
        description: "",
        ...(response.json
          ? { content: { "application/json": { schema: true } } }
          : {}),
      };
    if (Object.keys(responses).length === 0)
      responses.default = { description: "" };
    item[method] = {
      operationId: operation.nativeId,
      ...(operation.description ? { summary: operation.description } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(plan.requestBody
        ? {
            requestBody: {
              required: plan.requestBody.required,
              content: {
                "application/json": {
                  schema: schemaToJson(
                    plan.requestBody.schema,
                    plan.definitions,
                    names,
                  ),
                },
              },
            },
          }
        : {}),
      responses,
      security,
      // Effect and consent are host policy, not source facts; they travel as
      // clearly-namespaced annotations so no reader mistakes them for OAS.
      "x-ceremony-effect": operation.effect,
      "x-ceremony-consent": operation.consent,
      "x-ceremony-replay": operation.replay,
      ...(options.includeNativeExtensions && capability?.nativeExtensions
        ? capability.nativeExtensions
        : {}),
    };
  };

  if (binding) {
    for (const operation of bound) {
      const plan = planFor.get(operation.operationRef);
      if (!plan) {
        losses.add({
          code: "structure.operation-plan-missing",
          category: "structure",
          pointer: `#/operations/${token(operation.nativeId, 64)}`,
          dimension: "export",
          severity: "warning",
          disposition: "adapted",
          message:
            "A bound operation carries no serialization plan and is omitted from the exported description.",
        });
        continue;
      }
      if (operation.transport.kind !== "http") continue;
      emit(operation, plan);
    }
    const exported = new Set(bound.map((operation) => operation.nativeId));
    const omitted = definition.capabilities.filter(
      (capability) => !exported.has(capability.nativeId),
    );
    if (omitted.length)
      losses.add({
        code: "policy.unapproved-operations-omitted",
        category: "policy",
        pointer: "#/capabilities",
        dimension: "export",
        severity: "info",
        disposition: "adapted",
        message: `The description carries ${omitted.length} operation(s) that this binding did not approve; they are deliberately absent from the export.`,
      });
  } else {
    // Without a binding there is no approved executable surface to describe.
    losses.add({
      code: "policy.no-binding-no-operations",
      category: "policy",
      pointer: "#",
      dimension: "export",
      severity: "info",
      disposition: "adapted",
      message:
        "No runtime binding was supplied, so the export describes the authentication surface only; operations are not published as executable.",
    });
    for (const profile of definition.authentication) {
      const scheme = securitySchemeFor(profile);
      if (scheme) {
        usedSchemes.set(profile.id, scheme);
        schemeNameFor.set(profile.id, profile.id);
      }
    }
  }

  for (const profile of definition.authentication)
    if (profile.kind === "unsupported")
      losses.add({
        code: "security.unsupported-profile-not-exported",
        category: "security",
        pointer: "#/authentication",
        dimension: "export",
        severity: "blocking",
        disposition: "unsupported",
        message:
          "The description preserves an authentication scheme this runtime cannot execute; it is not published as a usable security scheme, and operations that require it stay blocked.",
      });

  const schemas: Record<string, unknown> = {};
  for (const plan of plans)
    for (const [key, schema] of Object.entries(plan.definitions)) {
      const name = names.get(key);
      if (name && !Object.hasOwn(schemas, name))
        schemas[name] = schemaToJson(schema, plan.definitions, names);
    }

  if (definition.events.length)
    losses.add({
      code: "structure.events-not-exported",
      category: "structure",
      pointer: "#/events",
      dimension: "export",
      severity: "warning",
      disposition: "adapted",
      message:
        "Webhook and callback descriptions are not republished; their delivery verification is not part of this approved surface.",
    });

  const document: Record<string, unknown> = {
    openapi: EXPORT_VERSION,
    info: {
      title: safeText(options.title ?? definition.display.name, 200),
      version: safeText(options.version ?? definition.identity.nativeVersion, 128),
      ...(definition.display.description
        ? { description: safeText(definition.display.description, 500) }
        : {}),
    },
    // The approved destination is deployment-private: a relative server says
    // "wherever this deployment points it", which is exactly what is true.
    servers: [{ url: "/" }],
    paths,
    ...(usedSchemes.size || Object.keys(schemas).length
      ? {
          components: {
            ...(usedSchemes.size
              ? { securitySchemes: Object.fromEntries(usedSchemes) }
              : {}),
            ...(Object.keys(schemas).length ? { schemas } : {}),
          },
        }
      : {}),
    ...(options.includeNativeExtensions &&
    Object.keys(definition.nativeExtensions).length
      ? definition.nativeExtensions
      : {}),
  };
  if (definition.declaredServers.length)
    losses.add({
      code: "network.declared-servers-not-exported",
      category: "network",
      pointer: "#/declaredServers",
      dimension: "export",
      severity: "info",
      disposition: "adapted",
      message:
        "Declared server URLs are not republished; the export names a relative server so it cannot advertise a private destination.",
    });
  return { document, losses: losses.issues };
}
