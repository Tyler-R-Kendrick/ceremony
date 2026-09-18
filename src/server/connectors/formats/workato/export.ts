import type {
  CompatibilityIssue,
  NormalizedDefinition,
} from "../../../../core/connectors/index.js";
import { makeIssue, pointer, token } from "../automation/common.js";
import type { AutomationExportResult } from "../automation/definition.js";
import {
  WORKATO_LAMBDA_MARKER,
  WORKATO_MEDIA_TYPE,
  WORKATO_PROFILES,
} from "./profile.js";

/*
 * Writes an imported Workato connector back out as a
 * `workato-static-profile/1` document.
 *
 * Workato publishes no non-Ruby serialization of a connector, so there is no
 * vendor format to write. This export writes the profile this repository
 * defines: every literal that was imported, and, where the connector had a
 * lambda, the `{"$lambda": true}` marker. It is a description, not a
 * connector: nothing in it can be pasted into Workato and run, and the losses
 * say so.
 */

export const WORKATO_EXPORT_EXTENSION_KEYS = [
  "collection",
  "subtitle",
  "input_fields",
  "output_fields",
  "config_fields",
  "bodies",
  "deliveryStyle",
] as const;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/**
 * Exports a Workato description as a `workato-static-profile/1` document. A
 * description from another ecosystem is refused rather than translated.
 */
export function exportWorkatoStatic(
  definition: NormalizedDefinition,
): AutomationExportResult {
  const losses: CompatibilityIssue[] = [];
  if (definition.identity.ecosystem !== "workato") {
    const loss = makeIssue({
      code: "export.workato.wrong-ecosystem",
      category: "structure",
      pointer: "#",
      dimension: "export",
      severity: "blocking",
      disposition: "unsupported",
      executionImpact: "blocks-definition",
      message:
        "This description did not come from Workato, and this exporter does not translate between ecosystems.",
    });
    return {
      mediaType: WORKATO_MEDIA_TYPE,
      bytes: new TextEncoder().encode("{}"),
      document: {},
      losses: [loss],
    };
  }

  const extensions = definition.nativeExtensions;
  const document: Record<string, unknown> = {
    profile: WORKATO_PROFILES.export,
  };
  const title = text(extensions["title"]);
  if (title !== undefined) document["title"] = title;

  const connection: Record<string, unknown> = {};
  if (Array.isArray(extensions["connectionFields"]))
    connection["fields"] = extensions["connectionFields"];
  const authorization = record(extensions["authorization"]);
  if (authorization) {
    const body: Record<string, unknown> = {};
    for (const key of [
      "type",
      "authorization_url",
      "token_url",
      "scopes",
      "apply",
      "pkce",
      "oauth2",
      "options",
    ] as const) {
      const value = authorization[key];
      if (value !== undefined) body[key] = value;
    }
    if (authorization["hasRefresh"] === true)
      body["refresh"] = WORKATO_LAMBDA_MARKER;
    connection["authorization"] = body;
  }
  const baseUri = text(extensions["baseUri"]);
  if (baseUri !== undefined) connection["base_uri"] = baseUri;
  if (Object.keys(connection).length) document["connection"] = connection;
  if (extensions["hasTest"] === true) document["test"] = WORKATO_LAMBDA_MARKER;
  if (extensions["hasWebhookKeys"] === true)
    document["webhook_keys"] = WORKATO_LAMBDA_MARKER;

  const actions: Record<string, unknown> = {};
  const triggers: Record<string, unknown> = {};
  for (const capability of definition.capabilities) {
    const capabilityExtensions = capability.nativeExtensions ?? {};
    const collection = text(capabilityExtensions["collection"]);
    if (collection !== "actions" && collection !== "triggers") continue;
    const entry: Record<string, unknown> = {};
    if (capability.label !== undefined) entry["title"] = capability.label;
    const subtitle = text(capabilityExtensions["subtitle"]);
    if (subtitle !== undefined) entry["subtitle"] = subtitle;
    if (capability.summary !== undefined)
      entry["description"] = capability.summary;
    for (const key of ["config_fields", "input_fields", "output_fields"] as const) {
      const value = capabilityExtensions[key];
      if (Array.isArray(value)) entry[key] = value;
      else if (key !== "config_fields")
        losses.push(
          makeIssue({
            code: "export.workato.fields-not-imported",
            category: "schema",
            pointer: pointer(collection, capability.nativeId, key),
            dimension: "export",
            severity: "warning",
            disposition: "adapted",
            message: `"${token(capability.nativeId)}" builds its "${token(key)}" in a Ruby lambda, so the export carries no field list for it.`,
          }),
        );
    }
    const bodies = record(capabilityExtensions["bodies"]);
    for (const [key, value] of Object.entries(bodies ?? {})) {
      const body = record(value);
      if (body?.["code"] === "lambda") {
        entry[key] = WORKATO_LAMBDA_MARKER;
        losses.push(
          makeIssue({
            code: "export.workato.lambda-marker",
            category: "executable-code",
            pointer: pointer(collection, capability.nativeId, key),
            dimension: "export",
            severity: "warning",
            disposition: "adapted",
            message: `"${token(capability.nativeId)}" implements "${token(key)}" as a Ruby lambda, which this export replaces with a marker.`,
            remediation:
              "Recreate the implementation in the target platform, or bind the operation to an approved host runtime.",
          }),
        );
        continue;
      }
      if (value !== null && value !== undefined) entry[key] = value;
    }
    if (collection === "actions") actions[capability.nativeId] = entry;
    else triggers[capability.nativeId] = entry;
  }
  if (Object.keys(actions).length) document["actions"] = actions;
  if (Object.keys(triggers).length) document["triggers"] = triggers;

  const objectDefinitions = record(extensions["objectDefinitions"]);
  if (objectDefinitions)
    document["object_definitions"] = Object.fromEntries(
      Object.entries(objectDefinitions).map(([name, fields]) => [
        name,
        { fields },
      ]),
    );

  if (definition.authentication.some((profile) => profile.kind === "unsupported"))
    losses.push(
      makeIssue({
        code: "export.workato.authorization-not-imported",
        category: "security",
        pointer: pointer("connection", "authorization"),
        dimension: "export",
        severity: "blocking",
        disposition: "unsupported",
        executionImpact: "blocks-authorization",
        message:
          "The connector acquires or applies its credential in Ruby that was never imported, so the export cannot describe how it authenticates.",
        remediation:
          "Declare the authentication method explicitly in the static profile before exporting it as executable.",
      }),
    );

  losses.push(
    makeIssue({
      code: "export.workato.not-a-connector",
      category: "executable-code",
      pointer: "#",
      dimension: "export",
      severity: "warning",
      disposition: "adapted",
      message: `This is a ${WORKATO_PROFILES.export} document, not Ruby: every lambda is a marker and no part of it can run on Workato.`,
      remediation:
        "Use it for review, comparison and re-import; write the Ruby implementation on the target platform.",
    }),
  );

  const serialized = JSON.stringify(document);
  return {
    mediaType: WORKATO_MEDIA_TYPE,
    bytes: new TextEncoder().encode(serialized),
    document,
    losses,
  };
}
