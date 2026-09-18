import {
  isReservedObjectKey,
  measureJsonValue,
  type CompatibilityIssue,
} from "../../../../core/connectors/index.js";
import { IssueList, pointer, safeText, token } from "./issues.js";

/*
 * The companion files of a Power Platform custom connector, as the `paconn`
 * CLI lays them out (Microsoft Learn, "Create a custom connector with the
 * CLI", ms.date 2025-05-28): `apiProperties.json` holds connection
 * parameters, brand colour, capabilities, policy-template instances and the
 * script operation list; `settings.json` is the CLI's argument store
 * (connectorId, environment, file names). Field shapes for connection
 * parameters follow the certification page (ms.date 2026-02-20) and the
 * open-source connector corpus (microsoft/PowerPlatformConnectors, `dev`,
 * retrieved 2026-09-18): `connectionParameterSets.values[].{name,
 * uiDefinition, metadata, parameters}`, `type: "oauthSetting"` /
 * `"oAuthSetting"` (both spellings occur) with `oAuthSettings`, and
 * `type: "gatewaySetting"` with `gatewaySettings`.
 *
 * Nothing here is executable. Policy parameter *values* are not kept: a
 * `setheader` policy can carry a credential, and a policy is never run here
 * anyway, so names and types are the useful residue.
 */

export const API_PROPERTIES_LIMITS = Object.freeze({
  document: { depth: 32, nodes: 20_000, bytes: 1024 * 1024, stringLength: 16_384 },
  parameters: 64,
  sets: 16,
  policies: 64,
  policyParameters: 32,
  scriptOperations: 1024,
  capabilities: 16,
  allowedValues: 64,
  scopes: 64,
});

export interface ConnectionParameterUi {
  displayName?: string;
  description?: string;
  tooltip?: string;
  required: boolean;
  /** `constraints.hidden`, when a connector hides a parameter from the connection dialog. */
  hidden: boolean;
  clearText?: boolean;
  tabIndex?: number;
  capability: string[];
  allowedValues: Array<{ text?: string; value: string }>;
}

export type ConnectionParameter = {
  name: string;
  pointer: string;
  ui: ConnectionParameterUi;
  extensions: Record<string, unknown>;
} & (
  | { kind: "string"; allowedValues: string[] }
  | { kind: "securestring" }
  | {
      kind: "oauthSetting";
      identityProvider: string;
      /** Deployment configuration, never part of a definition or an export. */
      clientId?: string;
      scopes: string[];
      redirectMode?: string;
      /** `customParameters` values, keyed by lower-cased name (authorizationurl, tokenurl, refreshurl, loginuri, tenantid, resourceuri ...). */
      customParameters: Record<string, string>;
    }
  | { kind: "gatewaySetting"; dataSourceType?: string }
  | { kind: "unknown"; nativeType: string }
);

export interface ConnectionParameterSet {
  name: string;
  displayName?: string;
  description?: string;
  allowSharing?: boolean;
  parameters: ConnectionParameter[];
  pointer: string;
}

export interface PolicyTemplateInstance {
  templateId: string;
  title?: string;
  /** Parameter names and the JSON type of their value; values themselves are not preserved. */
  parameters: Array<{ name: string; valueType: string }>;
  /** `x-ms-apimTemplate-operationName` when the instance is scoped; undefined means every operation. */
  operationNames?: string[];
  pointer: string;
}

export interface ApiProperties {
  connectionParameters: ConnectionParameter[];
  connectionParameterSets?: {
    displayName?: string;
    description?: string;
    values: ConnectionParameterSet[];
  };
  policyTemplateInstances: PolicyTemplateInstance[];
  /** Undefined when absent; an empty list means every operation runs through the script. */
  scriptOperations?: string[];
  capabilities: string[];
  iconBrandColor?: string;
  publisher?: string;
  stackOwner?: string;
  extensions: Record<string, unknown>;
}

export interface ConnectorSettings {
  connectorId?: string;
  environment?: string;
  apiProperties?: string;
  apiDefinition?: string;
  icon?: string;
  script?: string;
  powerAppsApiVersion?: string;
  powerAppsUrl?: string;
}

export type ApiPropertiesResult =
  | { ok: true; properties: ApiProperties; issues: CompatibilityIssue[] }
  | { ok: false; issues: CompatibilityIssue[] };

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const NAME = /^[^\p{Cc}]{1,120}$/u;
const flag = (value: unknown) => value === true || value === "true";
const text = (value: unknown, max: number) =>
  typeof value === "string" ? safeText(value, max) : "";
const optional = (value: unknown, max: number) => {
  const cleaned = text(value, max);
  return cleaned.length ? cleaned : undefined;
};
const stringList = (value: unknown, max: number): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .slice(0, max)
        .map((item) => safeText(item, 200))
        .filter((item) => item.length)
    : [];

function readUi(value: unknown): ConnectionParameterUi {
  const ui = isObject(value) ? value : {};
  const constraints = isObject(ui.constraints) ? ui.constraints : {};
  const allowedValues = Array.isArray(constraints.allowedValues)
    ? constraints.allowedValues
        .slice(0, API_PROPERTIES_LIMITS.allowedValues)
        .flatMap((item) =>
          isObject(item) && typeof item.value === "string"
            ? [
                {
                  ...(typeof item.text === "string"
                    ? { text: safeText(item.text, 120) }
                    : {}),
                  value: safeText(item.value, 120),
                },
              ]
            : [],
        )
    : [];
  const displayName = optional(ui.displayName, 120);
  const description = optional(ui.description, 500);
  const tooltip = optional(ui.tooltip, 500);
  return {
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
    ...(tooltip ? { tooltip } : {}),
    required: flag(constraints.required),
    hidden: flag(constraints.hidden),
    ...(typeof constraints.clearText === "boolean" ||
    constraints.clearText === "true" ||
    constraints.clearText === "false"
      ? { clearText: flag(constraints.clearText) }
      : {}),
    ...(typeof constraints.tabIndex === "number" &&
    Number.isInteger(constraints.tabIndex)
      ? { tabIndex: constraints.tabIndex }
      : {}),
    capability: stringList(constraints.capability, 8),
    allowedValues,
  };
}

/** Vendor extensions of one node, bounded; reused for apiProperties nodes. */
function extensionsOf(node: JsonObject): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, value] of Object.entries(node)) {
    if (!key.startsWith("x-") || key.length > 120 || /\p{Cc}/u.test(key))
      continue;
    if (++count > 32) break;
    const measured = measureJsonValue(value, {
      depth: 16,
      nodes: 512,
      bytes: 16 * 1024,
      stringLength: 4096,
    });
    out[key] = measured.ok ? value : { $truncated: measured.reason };
  }
  return out;
}

function readParameter(
  name: string,
  raw: unknown,
  at: string,
  issues: IssueList,
): ConnectionParameter | undefined {
  if (!isObject(raw) || isReservedObjectKey(name) || !NAME.test(name)) {
    issues.push({
      code: "structure.connection-parameter-invalid",
      category: "structure",
      pointer: at,
      dimension: "configure",
      severity: "warning",
      disposition: "adapted",
      message: "A connection parameter needs a valid name and an object value.",
    });
    return undefined;
  }
  const nativeType = text(raw.type, 40);
  const base = {
    name,
    pointer: at,
    ui: readUi(raw.uiDefinition),
    extensions: extensionsOf(raw),
  };
  switch (nativeType.toLowerCase()) {
    case "string":
      return {
        ...base,
        kind: "string",
        allowedValues: Array.isArray(raw.allowedValues)
          ? raw.allowedValues
              .slice(0, API_PROPERTIES_LIMITS.allowedValues)
              .flatMap((item) =>
                isObject(item) && typeof item.value === "string"
                  ? [safeText(item.value, 120)]
                  : [],
              )
          : [],
      };
    case "securestring":
      return { ...base, kind: "securestring" };
    case "oauthsetting": {
      const settings = isObject(raw.oAuthSettings)
        ? raw.oAuthSettings
        : isObject(raw.oauthSettings)
          ? raw.oauthSettings
          : {};
      const customParameters: Record<string, string> = {};
      if (isObject(settings.customParameters))
        for (const [key, value] of Object.entries(
          settings.customParameters,
        ).slice(0, 32)) {
          const lower = key.toLowerCase();
          if (isReservedObjectKey(lower) || !NAME.test(lower)) continue;
          const inner = isObject(value) ? value.value : value;
          if (typeof inner === "string") customParameters[lower] = inner.slice(0, 2048);
          else if (typeof inner === "boolean" || typeof inner === "number")
            customParameters[lower] = String(inner);
        }
      const clientId = optional(settings.clientId, 512);
      const redirectMode = optional(settings.redirectMode, 64);
      return {
        ...base,
        kind: "oauthSetting",
        identityProvider: text(settings.identityProvider, 64) || "unknown",
        ...(clientId ? { clientId } : {}),
        scopes: stringList(settings.scopes, API_PROPERTIES_LIMITS.scopes),
        ...(redirectMode ? { redirectMode } : {}),
        customParameters,
      };
    }
    case "gatewaysetting": {
      const settings = isObject(raw.gatewaySettings) ? raw.gatewaySettings : {};
      const dataSourceType = optional(settings.dataSourceType, 64);
      return {
        ...base,
        kind: "gatewaySetting",
        ...(dataSourceType ? { dataSourceType } : {}),
      };
    }
    default:
      issues.push({
        code: "structure.connection-parameter-type-unknown",
        category: "structure",
        pointer: at,
        dimension: "configure",
        severity: "warning",
        disposition: "native-extension",
        message: `Connection parameter ${token(name)} has an undocumented type ${token(nativeType || "(none)")}; it is preserved but not mapped to an authentication profile.`,
      });
      return { ...base, kind: "unknown", nativeType: nativeType || "unknown" };
  }
}

function readParameters(
  value: unknown,
  at: string,
  issues: IssueList,
): ConnectionParameter[] {
  if (!isObject(value)) return [];
  const entries = Object.entries(value);
  if (entries.length > API_PROPERTIES_LIMITS.parameters)
    issues.push({
      code: "structure.connection-parameter-count",
      category: "structure",
      pointer: at,
      dimension: "configure",
      severity: "warning",
      disposition: "adapted",
      message: `Only the first ${API_PROPERTIES_LIMITS.parameters} connection parameters are read.`,
    });
  return entries
    .slice(0, API_PROPERTIES_LIMITS.parameters)
    .flatMap(([name, raw]) => {
      const parameter = readParameter(name, raw, `${at}/${escape(name)}`, issues);
      return parameter ? [parameter] : [];
    });
}

const escape = (segment: string) =>
  segment.replaceAll("~", "~0").replaceAll("/", "~1");

export function readApiProperties(document: unknown): ApiPropertiesResult {
  const issues = new IssueList();
  const measured = measureJsonValue(document, API_PROPERTIES_LIMITS.document);
  if (!measured.ok) {
    issues.push({
      code: "structure.api-properties-bounds",
      category: "structure",
      pointer: "#",
      dimension: "configure",
      severity: "blocking",
      disposition: "rejected",
      executionImpact: "blocks-definition",
      message: `apiProperties.json exceeds import bounds (${measured.reason}).`,
    });
    return { ok: false, issues: issues.toArray() };
  }
  if (!isObject(document) || !isObject(document.properties)) {
    issues.push({
      code: "structure.api-properties-shape",
      category: "structure",
      pointer: "#/properties",
      dimension: "configure",
      severity: "blocking",
      disposition: "rejected",
      executionImpact: "blocks-definition",
      message: 'apiProperties.json must be an object with a "properties" object.',
    });
    return { ok: false, issues: issues.toArray() };
  }
  const properties = document.properties;
  const connectionParameters = readParameters(
    properties.connectionParameters,
    "#/properties/connectionParameters",
    issues,
  );
  let connectionParameterSets: ApiProperties["connectionParameterSets"];
  if (isObject(properties.connectionParameterSets)) {
    const sets = properties.connectionParameterSets;
    const ui = isObject(sets.uiDefinition) ? sets.uiDefinition : {};
    const values = Array.isArray(sets.values) ? sets.values : [];
    if (values.length > API_PROPERTIES_LIMITS.sets)
      issues.push({
        code: "structure.connection-parameter-set-count",
        category: "structure",
        pointer: "#/properties/connectionParameterSets/values",
        dimension: "configure",
        severity: "warning",
        disposition: "adapted",
        message: `Only the first ${API_PROPERTIES_LIMITS.sets} connection parameter sets are read.`,
      });
    const seen = new Set<string>();
    const displayName = optional(ui.displayName, 120);
    const description = optional(ui.description, 500);
    connectionParameterSets = {
      ...(displayName ? { displayName } : {}),
      ...(description ? { description } : {}),
      values: values.slice(0, API_PROPERTIES_LIMITS.sets).flatMap((raw, index) => {
        const at = `#/properties/connectionParameterSets/values/${index}`;
        const name = isObject(raw) ? text(raw.name, 120) : "";
        if (!isObject(raw) || !name || seen.has(name)) {
          issues.push({
            code: "structure.connection-parameter-set-invalid",
            category: "structure",
            pointer: at,
            dimension: "configure",
            severity: "warning",
            disposition: "adapted",
            message: "A connection parameter set needs a unique name.",
          });
          return [];
        }
        seen.add(name);
        const setUi = isObject(raw.uiDefinition) ? raw.uiDefinition : {};
        const metadata = isObject(raw.metadata) ? raw.metadata : {};
        const setDisplayName = optional(setUi.displayName, 120);
        const setDescription = optional(setUi.description, 500);
        return [
          {
            name,
            ...(setDisplayName ? { displayName: setDisplayName } : {}),
            ...(setDescription ? { description: setDescription } : {}),
            ...(typeof metadata.allowSharing === "boolean"
              ? { allowSharing: metadata.allowSharing }
              : {}),
            parameters: readParameters(raw.parameters, `${at}/parameters`, issues),
            pointer: at,
          },
        ];
      }),
    };
  }
  const policyTemplateInstances: PolicyTemplateInstance[] = [];
  if (Array.isArray(properties.policyTemplateInstances)) {
    if (properties.policyTemplateInstances.length > API_PROPERTIES_LIMITS.policies)
      issues.push({
        code: "structure.policy-count",
        category: "policy",
        pointer: "#/properties/policyTemplateInstances",
        dimension: "invoke",
        severity: "warning",
        disposition: "adapted",
        message: `Only the first ${API_PROPERTIES_LIMITS.policies} policy template instances are read.`,
      });
    properties.policyTemplateInstances
      .slice(0, API_PROPERTIES_LIMITS.policies)
      .forEach((raw, index) => {
        const at = `#/properties/policyTemplateInstances/${index}`;
        if (!isObject(raw)) return;
        const templateId = text(raw.templateId, 64) || "unknown";
        const parameters = isObject(raw.parameters) ? raw.parameters : {};
        const operationNamesRaw = parameters["x-ms-apimTemplate-operationName"];
        const operationNames =
          typeof operationNamesRaw === "string"
            ? [safeText(operationNamesRaw, 200)]
            : Array.isArray(operationNamesRaw)
              ? stringList(operationNamesRaw, 256)
              : undefined;
        const title = optional(raw.title, 200);
        policyTemplateInstances.push({
          templateId,
          ...(title ? { title } : {}),
          parameters: Object.entries(parameters)
            .slice(0, API_PROPERTIES_LIMITS.policyParameters)
            .filter(([name]) => name !== "x-ms-apimTemplate-operationName")
            .map(([name, value]) => ({
              name: safeText(name, 120),
              valueType: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
            })),
          ...(operationNames ? { operationNames } : {}),
          pointer: at,
        });
      });
  }
  const iconBrandColor = optional(properties.iconBrandColor, 16);
  const publisher = optional(properties.publisher, 200);
  const stackOwner = optional(properties.stackOwner, 200);
  const result: ApiProperties = {
    connectionParameters,
    ...(connectionParameterSets ? { connectionParameterSets } : {}),
    policyTemplateInstances,
    ...(Array.isArray(properties.scriptOperations)
      ? {
          scriptOperations: stringList(
            properties.scriptOperations,
            API_PROPERTIES_LIMITS.scriptOperations,
          ),
        }
      : {}),
    capabilities: stringList(properties.capabilities, API_PROPERTIES_LIMITS.capabilities),
    ...(iconBrandColor && /^#[0-9a-fA-F]{3,8}$/.test(iconBrandColor)
      ? { iconBrandColor }
      : {}),
    ...(publisher ? { publisher } : {}),
    ...(stackOwner ? { stackOwner } : {}),
    extensions: extensionsOf(properties),
  };
  return { ok: true, properties: result, issues: issues.toArray() };
}

/** `settings.json` as the CLI writes it; every field is optional text. */
export function readConnectorSettings(document: unknown): ConnectorSettings {
  if (!isObject(document)) return {};
  const measured = measureJsonValue(document, {
    depth: 4,
    nodes: 64,
    bytes: 16 * 1024,
    stringLength: 2048,
  });
  if (!measured.ok) return {};
  const settings: ConnectorSettings = {};
  const connectorId = optional(document.connectorId, 200);
  if (connectorId) settings.connectorId = connectorId;
  const environment = optional(document.environment, 200);
  if (environment) settings.environment = environment;
  for (const key of ["apiProperties", "apiDefinition", "icon", "script"] as const) {
    const value = optional(document[key], 260);
    if (value) settings[key] = value;
  }
  const apiVersion = optional(document.powerAppsApiVersion, 32);
  if (apiVersion) settings.powerAppsApiVersion = apiVersion;
  const url = optional(document.powerAppsUrl, 2048);
  if (url && URL.canParse(url)) settings.powerAppsUrl = url;
  return settings;
}

export { pointer as apiPropertiesPointer };
