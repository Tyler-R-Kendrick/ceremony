import type {
  CompatibilityIssue,
  NativeCapability,
  NormalizedDefinition,
} from "../../../../core/connectors/index.js";
import { makeIssue, pointer, token } from "../automation/common.js";
import type { AutomationExportResult } from "../automation/definition.js";
import {
  ZAPIER_FUNC_PLACEHOLDER,
  ZAPIER_MEDIA_TYPE,
  ZAPIER_PROFILES,
} from "./profile.js";

/*
 * Writes the literal metadata of an imported Zapier app back out in the
 * vendor's own shape.
 *
 * The result is a `zapier-static-app/1` document: a Zapier app definition
 * that carries every literal this reader imported, and, where the original
 * had code, the platform's own function marker rather than the code. It is
 * therefore not a runnable Zapier integration and `zapier validate` would
 * reject it — that is a loss, it is reported as one, and nothing here
 * pretends otherwise. What it does guarantee is that reading it back yields
 * the same description over the supported subset.
 */

/** Native extension keys this export carries; the round trip is defined over them. */
export const ZAPIER_EXPORT_EXTENSION_KEYS = [
  "collection",
  "noun",
  "hidden",
  "type",
  "inputFields",
  "outputFields",
  "sample",
  "resourceKey",
  "resourceMethod",
  "resourceNoun",
  "searchKey",
  "createKey",
  "updateKey",
  "performIsLiteralRequest",
  "perform",
  "performList",
  "performSubscribe",
  "performUnsubscribe",
  "performGet",
  "performResume",
  "performBuffer",
] as const;

const PERFORM_KEYS = [
  "perform",
  "performList",
  "performSubscribe",
  "performUnsubscribe",
  "performGet",
  "performResume",
  "performBuffer",
] as const;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

function operationBody(
  capability: NativeCapability,
  losses: CompatibilityIssue[],
): Record<string, unknown> {
  const extensions = capability.nativeExtensions ?? {};
  const operation: Record<string, unknown> = {};
  const type = text(extensions["type"]);
  if (type !== undefined) operation["type"] = type;
  for (const key of PERFORM_KEYS) {
    const value = record(extensions[key]);
    if (!value) continue;
    const url = text(value["url"]);
    if (url !== undefined) {
      const method = text(value["method"]);
      operation[key] = method === undefined ? { url } : { method, url };
      continue;
    }
    operation[key] = ZAPIER_FUNC_PLACEHOLDER;
    losses.push(
      makeIssue({
        code: "export.zapier.function-placeholder",
        category: "executable-code",
        pointer: pointer("capabilities", capability.nativeId, key),
        dimension: "export",
        severity: "warning",
        disposition: "adapted",
        message: `"${token(capability.nativeId)}" implements "${token(key)}" in code, which this export replaces with the platform's function marker.`,
        remediation:
          "Recreate the implementation in the target platform, or bind the operation to an approved host runtime.",
      }),
    );
  }
  if (Array.isArray(extensions["inputFields"]))
    operation["inputFields"] = extensions["inputFields"];
  if (Array.isArray(extensions["outputFields"]))
    operation["outputFields"] = extensions["outputFields"];
  const sample = record(extensions["sample"]);
  if (sample) operation["sample"] = sample;
  return operation;
}

function displayBody(capability: NativeCapability): Record<string, unknown> {
  const extensions = capability.nativeExtensions ?? {};
  const display: Record<string, unknown> = {};
  if (capability.label !== undefined) display["label"] = capability.label;
  if (capability.summary !== undefined) display["description"] = capability.summary;
  if (extensions["hidden"] === true) display["hidden"] = true;
  return display;
}

/**
 * Exports a Zapier description as a `zapier-static-app/1` document. Only a
 * description imported from this ecosystem is exportable: a definition from
 * another ecosystem is refused rather than translated, because a translation
 * this module cannot test is a claim it cannot make.
 */
export function exportZapierStatic(
  definition: NormalizedDefinition,
): AutomationExportResult {
  const losses: CompatibilityIssue[] = [];
  if (definition.identity.ecosystem !== "zapier") {
    const loss = makeIssue({
      code: "export.zapier.wrong-ecosystem",
      category: "structure",
      pointer: "#",
      dimension: "export",
      severity: "blocking",
      disposition: "unsupported",
      executionImpact: "blocks-definition",
      message:
        "This description did not come from Zapier, and this exporter does not translate between ecosystems.",
    });
    return {
      mediaType: ZAPIER_MEDIA_TYPE,
      bytes: new TextEncoder().encode("{}"),
      document: {},
      losses: [loss],
    };
  }

  const extensions = definition.nativeExtensions;
  const document: Record<string, unknown> = {};
  const appVersion = text(extensions["appVersion"]);
  if (appVersion !== undefined) document["version"] = appVersion;
  else
    losses.push(
      makeIssue({
        code: "export.zapier.version-unknown",
        category: "version",
        pointer: pointer("version"),
        dimension: "export",
        severity: "warning",
        disposition: "adapted",
        message:
          "The imported description carries no literal app version, so the export omits one.",
      }),
    );
  const platformVersion = text(extensions["platformVersion"]);
  if (platformVersion !== undefined)
    document["platformVersion"] = platformVersion;
  const requestTemplate = record(extensions["requestTemplate"]);
  if (requestTemplate) document["requestTemplate"] = requestTemplate;

  const authentication = record(extensions["authentication"]);
  if (authentication) {
    const body: Record<string, unknown> = {};
    const type = text(authentication["type"]);
    if (type !== undefined) body["type"] = type;
    if (authentication["hasTest"] === true)
      body["test"] = ZAPIER_FUNC_PLACEHOLDER;
    if (Array.isArray(authentication["fields"]))
      body["fields"] = authentication["fields"];
    const oauth2 = record(authentication["oauth2Config"]);
    if (oauth2) {
      const config: Record<string, unknown> = {};
      const authorizeUrl = text(oauth2["authorizeUrl"]);
      const getAccessToken = text(oauth2["getAccessToken"]);
      if (authorizeUrl !== undefined)
        config["authorizeUrl"] = { method: "GET", url: authorizeUrl };
      if (getAccessToken !== undefined)
        config["getAccessToken"] = { url: getAccessToken };
      const scope = text(oauth2["scope"]);
      if (scope !== undefined) config["scope"] = scope;
      if (typeof oauth2["enablePkce"] === "boolean")
        config["enablePkce"] = oauth2["enablePkce"];
      if (oauth2["hasRefresh"] === true)
        config["refreshAccessToken"] = ZAPIER_FUNC_PLACEHOLDER;
      body["oauth2Config"] = config;
    }
    document["authentication"] = body;
  }

  if (
    definition.authentication.some((profile) => profile.kind === "unsupported")
  )
    losses.push(
      makeIssue({
        code: "export.zapier.authentication-not-imported",
        category: "security",
        pointer: pointer("authentication"),
        dimension: "export",
        severity: "blocking",
        disposition: "unsupported",
        executionImpact: "blocks-authorization",
        message:
          "The app applies its credential through code that was never imported, so the export cannot describe how this connector authenticates.",
        remediation:
          "Describe the authentication method explicitly before exporting, or export only for review.",
      }),
    );

  const collections = new Map<string, Record<string, unknown>>();
  const resources: Record<string, Record<string, unknown>> = {};
  for (const capability of definition.capabilities) {
    const capabilityExtensions = capability.nativeExtensions ?? {};
    const collection = text(capabilityExtensions["collection"]);
    if (collection === undefined) continue;
    if (collection === "resources") {
      const resourceKey = text(capabilityExtensions["resourceKey"]);
      const method = text(capabilityExtensions["resourceMethod"]);
      if (resourceKey === undefined || method === undefined) continue;
      const resource = (resources[resourceKey] ??= {
        key: resourceKey,
        noun: text(capabilityExtensions["resourceNoun"]) ?? resourceKey,
      });
      resource[method] = {
        display: displayBody(capability),
        operation: operationBody(capability, losses),
      };
      continue;
    }
    const bucket = collections.get(collection) ?? {};
    collections.set(collection, bucket);
    if (collection === "searchOrCreates" || collection === "searchAndCreates") {
      const pair: Record<string, unknown> = {
        key: capability.nativeId,
        display: displayBody(capability),
      };
      for (const [extensionKey, documentKey] of [
        ["searchKey", "search"],
        ["createKey", "create"],
        ["updateKey", "update"],
      ] as const) {
        const value = text(capabilityExtensions[extensionKey]);
        if (value !== undefined) pair[documentKey] = value;
      }
      bucket[capability.nativeId] = pair;
      continue;
    }
    const entry: Record<string, unknown> = {
      key: capability.nativeId,
      display: displayBody(capability),
      operation: operationBody(capability, losses),
    };
    const noun = text(capabilityExtensions["noun"]);
    if (noun !== undefined) entry["noun"] = noun;
    bucket[capability.nativeId] = entry;
  }
  for (const [name, bucket] of collections)
    if (Object.keys(bucket).length) document[name] = bucket;
  if (Object.keys(resources).length) document["resources"] = resources;

  losses.push(
    makeIssue({
      code: "export.zapier.not-runnable",
      category: "executable-code",
      pointer: "#",
      dimension: "export",
      severity: "warning",
      disposition: "adapted",
      message: `This is a ${ZAPIER_PROFILES.export} document: literal metadata only. It is not a runnable integration and the platform's validator would reject it.`,
      remediation:
        "Use it for review, comparison and re-import; recreate implementations on the target platform.",
    }),
  );

  const serialized = JSON.stringify(document);
  return {
    mediaType: ZAPIER_MEDIA_TYPE,
    bytes: new TextEncoder().encode(serialized),
    document,
    losses,
  };
}
