import type {
  CompatibilityIssue,
  NormalizedDefinition,
} from "../../../../core/connectors/index.js";
import { makeIssue, pointer } from "../automation/common.js";
import type { AutomationExportResult } from "../automation/definition.js";
import { N8N_MEDIA_TYPE, N8N_PROFILES } from "./profile.js";

/*
 * Writes the literal metadata of an imported n8n node back out as an
 * `INodeTypeDescription`.
 *
 * A declarative node is almost entirely data, so almost all of it survives:
 * the description, the credential references, the request defaults and the
 * whole `properties` array, expressions included — preserved as the inert
 * text they always were. What cannot survive is code: a programmatic node's
 * `execute` method, a `loadOptions` query, a `preSend`/`postReceive` hook.
 * Those are reported as losses, and a node that needed them is reported as
 * not runnable from this document.
 */

export const N8N_EXPORT_EXTENSION_KEYS = [
  "operation",
  "resource",
  "action",
  "routing",
  "implementation",
  "parameters",
] as const;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/**
 * Exports an n8n description as an `n8n-static-node/1` document. A
 * description from another ecosystem is refused rather than translated.
 */
export function exportN8nStatic(
  definition: NormalizedDefinition,
): AutomationExportResult {
  const losses: CompatibilityIssue[] = [];
  if (definition.identity.ecosystem !== "n8n") {
    const loss = makeIssue({
      code: "export.n8n.wrong-ecosystem",
      category: "structure",
      pointer: "#",
      dimension: "export",
      severity: "blocking",
      disposition: "unsupported",
      executionImpact: "blocks-definition",
      message:
        "This description did not come from n8n, and this exporter does not translate between ecosystems.",
    });
    return {
      mediaType: N8N_MEDIA_TYPE,
      bytes: new TextEncoder().encode("{}"),
      document: {},
      losses: [loss],
    };
  }

  const extensions = definition.nativeExtensions;
  const document: Record<string, unknown> = {
    displayName: definition.display.name,
    name: definition.identity.nativeId,
    description: definition.display.description,
  };
  const versions = extensions["nodeVersions"];
  if (Array.isArray(versions) && versions.length)
    document["version"] = versions.length === 1 ? versions[0] : versions;
  else
    losses.push(
      makeIssue({
        code: "export.n8n.version-unknown",
        category: "version",
        pointer: pointer("version"),
        dimension: "export",
        severity: "warning",
        disposition: "adapted",
        message:
          "The imported description carries no literal node version, so the export omits one and a workflow cannot pin to it.",
      }),
    );
  if (typeof extensions["defaultVersion"] === "number")
    document["defaultVersion"] = extensions["defaultVersion"];
  const group = extensions["group"];
  if (Array.isArray(group)) document["group"] = group;
  const subtitle = text(extensions["subtitle"]);
  if (subtitle !== undefined) document["subtitle"] = subtitle;
  if (typeof extensions["usableAsTool"] === "boolean")
    document["usableAsTool"] = extensions["usableAsTool"];

  const credentials = extensions["credentials"];
  if (Array.isArray(credentials) && credentials.length)
    document["credentials"] = credentials.map((entry) => {
      const item = record(entry);
      return {
        name: text(item?.["name"]) ?? "",
        required: item?.["required"] === true,
      };
    });

  const requestDefaults = record(extensions["requestDefaults"]);
  if (requestDefaults && text(requestDefaults["baseURL"]) !== undefined)
    document["requestDefaults"] = { baseURL: requestDefaults["baseURL"] };

  const properties = extensions["properties"];
  if (Array.isArray(properties)) document["properties"] = properties;
  else
    losses.push(
      makeIssue({
        code: "export.n8n.properties-not-imported",
        category: "structure",
        pointer: pointer("properties"),
        dimension: "export",
        severity: "blocking",
        disposition: "unsupported",
        executionImpact: "blocks-definition",
        message:
          "The node's properties were produced by code and were never imported, so this export describes no operations.",
      }),
    );

  if (extensions["implementation"] === "programmatic") {
    const methods = extensions["programmaticMethods"];
    losses.push(
      makeIssue({
        code: "export.n8n.programmatic-node",
        category: "executable-code",
        pointer: pointer("class"),
        dimension: "export",
        severity: "blocking",
        disposition: "unsupported",
        executionImpact: "blocks-operation",
        message: `The node implements its behaviour in code${
          Array.isArray(methods) && methods.length
            ? ` (${methods.filter((item) => typeof item === "string").join(", ")})`
            : ""
        }; this export carries the description only, and the node cannot run from it.`,
        remediation:
          "Ship the node package itself to a host that runs n8n nodes, or bind the operation to an approved external runtime.",
      }),
    );
  }

  const credentialType = record(extensions["credentialType"]);
  if (credentialType)
    losses.push(
      makeIssue({
        code: "export.n8n.credential-separate",
        category: "security",
        pointer: pointer("credentials"),
        dimension: "export",
        severity: "info",
        disposition: "adapted",
        message:
          "A node description references a credential type but does not contain it; the credential travels as its own document.",
      }),
    );

  losses.push(
    makeIssue({
      code: "export.n8n.not-runnable",
      category: "executable-code",
      pointer: "#",
      dimension: "export",
      severity: "warning",
      disposition: "adapted",
      message: `This is a ${N8N_PROFILES.export} document: the node description without its package, icon or code.`,
      remediation:
        "Use it for review, comparison and re-import; install the node package where the node must run.",
    }),
  );

  const serialized = JSON.stringify(document);
  return {
    mediaType: N8N_MEDIA_TYPE,
    bytes: new TextEncoder().encode(serialized),
    document,
    losses,
  };
}
