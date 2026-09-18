import { z } from "zod";

/*
 * The Kamelet document as the Apache Camel Kamelet catalog publishes it.
 *
 * Source of truth: the released catalog tag `v4.22.0` of
 * https://github.com/apache/camel-kamelets (the same version each document
 * repeats in its `camel.apache.org/catalog.version` annotation), read on
 * 2026-09-18. The catalog's own documentation pages are versioned per release
 * (`/camel-kamelets/4.22.x/`); an unversioned "next" page is not a stable
 * contract and is never what this importer claims to implement.
 *
 * A Kamelet is a *template*: a route fragment plus a JSON-Schema description
 * of the parameters that fill it. It is not an API description and it carries
 * no endpoint Ceremony may contact. Importing one therefore produces a
 * description and, at most, a descriptor a separately configured Camel runner
 * could execute. Nothing here starts a JVM, resolves a Maven dependency or
 * evaluates a template expression.
 */

/** The catalog release these schemas were read from. */
export const KAMELET_CATALOG_VERSION = "4.22.0";
/** Exact upstream revision the shapes below were verified against. */
export const KAMELET_CATALOG_SOURCE = Object.freeze({
  repository: "https://github.com/apache/camel-kamelets",
  tag: "v4.22.0",
  documentation: "https://camel.apache.org/camel-kamelets/4.22.x/",
  retrievedAt: "2026-09-18",
});
export const KAMELET_API_VERSION = "camel.apache.org/v1";
export const KAMELET_KIND = "Kamelet";
export const KAMELET_PROFILE = "camel-kamelet-v1";
export const KAMELET_ADAPTER_VERSION = "1.0.0";
export const KAMELET_ECOSYSTEM = "camel-kamelet";
export const KAMELET_IMPORTER_ID = "camel-kamelet-importer";

/** Label carrying the Kamelet's role in a route. */
export const KAMELET_TYPE_LABEL = "camel.apache.org/kamelet.type";
export const KAMELET_VERIFIED_LABEL = "camel.apache.org/kamelet.verified";
export const KAMELET_ANNOTATIONS = Object.freeze({
  supportLevel: "camel.apache.org/kamelet.support.level",
  catalogVersion: "camel.apache.org/catalog.version",
  icon: "camel.apache.org/kamelet.icon",
  provider: "camel.apache.org/provider",
  group: "camel.apache.org/kamelet.group",
  namespace: "camel.apache.org/kamelet.namespace",
});

/**
 * The two markers the catalog uses for a property that carries a credential,
 * documented in the catalog's security model page for 4.22.x. Either one is
 * enough to classify the property secret; a property that carries a credential
 * without them is a catalog defect, not a public value, so a name-shaped
 * fallback is applied as well and recorded as a heuristic.
 */
export const KAMELET_CREDENTIAL_DESCRIPTOR = "urn:camel:group:credentials";
export const KAMELET_PASSWORD_FORMAT = "password";
/** OpenShift/OLM descriptor the catalog also uses on password fields. */
export const KAMELET_PASSWORD_DESCRIPTOR =
  "urn:alm:descriptor:com.tectonic.ui:password";

export const kameletTypes = ["source", "sink", "action"] as const;
export const kameletTypeSchema = z.enum(kameletTypes);
export type KameletType = z.infer<typeof kameletTypeSchema>;

const noControl = /^[^\p{Cc}]*$/u;
const boundedText = z.string().max(20_000).regex(noControl);
/** Kubernetes object names: DNS-1123 subdomains, which is what the catalog uses. */
export const kameletNameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/);
/** A JSON-Schema property name inside `spec.definition.properties`. */
export const kameletPropertyNameSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/);

const annotationKeySchema = z.string().min(1).max(253).regex(noControl);

/**
 * One parameter of a Kamelet. The catalog writes ordinary JSON Schema here, so
 * unknown keywords are kept rather than refused: they are inert description.
 */
export const kameletPropertySchema = z.looseObject({
  title: boundedText.optional(),
  description: boundedText.optional(),
  type: z
    .enum(["string", "integer", "number", "boolean", "object", "array"])
    .optional(),
  format: z.string().max(64).regex(noControl).optional(),
  default: z.unknown().optional(),
  example: z.unknown().optional(),
  enum: z.array(z.unknown()).max(512).optional(),
  "x-descriptors": z.array(z.string().max(200).regex(noControl)).max(16).optional(),
});
export type KameletPropertyDocument = z.infer<typeof kameletPropertySchema>;

export const kameletDefinitionSchema = z.looseObject({
  title: boundedText.optional(),
  description: boundedText.optional(),
  type: z.literal("object").optional(),
  required: z.array(kameletPropertyNameSchema).max(256).optional(),
  properties: z.record(kameletPropertyNameSchema, kameletPropertySchema).optional(),
});

/**
 * `spec.template` is the Camel route fragment. It is read for exactly two
 * facts — the endpoint scheme of `from.uri` (a source) or of the terminal
 * `to.uri` (a sink/action) — and is otherwise preserved verbatim as inert
 * data. No expression, no `{{placeholder}}` and no URI is resolved.
 */
export const kameletTemplateSchema = z.looseObject({
  from: z
    .looseObject({ uri: z.string().max(2048).regex(noControl).optional() })
    .optional(),
});

export const kameletDocumentSchema = z.looseObject({
  apiVersion: z.string().max(120).regex(noControl),
  kind: z.string().max(120).regex(noControl),
  metadata: z.looseObject({
    name: kameletNameSchema,
    annotations: z
      .record(annotationKeySchema, z.string().max(200_000).regex(noControl))
      .optional(),
    labels: z
      .record(annotationKeySchema, z.string().max(1024).regex(noControl))
      .optional(),
  }),
  spec: z.looseObject({
    definition: kameletDefinitionSchema.optional(),
    dependencies: z.array(z.string().max(256).regex(noControl)).max(256).optional(),
    template: kameletTemplateSchema.optional(),
    dataTypes: z.unknown().optional(),
  }),
});
export type KameletDocument = z.infer<typeof kameletDocumentSchema>;

/** How a property's secrecy was decided; a heuristic is reported, never hidden. */
export const kameletSecrecySources = [
  "credentials-descriptor",
  "password-descriptor",
  "password-format",
  "name-heuristic",
  "not-secret",
] as const;
export type KameletSecrecySource = (typeof kameletSecrecySources)[number];

/** The imported, classified view of one Kamelet parameter. */
export type KameletProperty = {
  name: string;
  title?: string;
  description?: string;
  type?: string;
  required: boolean;
  classification: "public" | "personal" | "secret";
  secrecySource: KameletSecrecySource;
  hasDefault: boolean;
  /** Non-secret default, preserved for review; a secret property never carries one out of import. */
  default?: unknown;
  enumValues?: readonly unknown[];
};

const credentialNamePattern =
  /(password|passphrase|secret|token|credential|privatekey|private_key|apikey|api_key|accesskey|access_key)/i;

/**
 * Classifies one property. The catalog's own markers are authoritative; the
 * name heuristic only ever *raises* a property to secret, is reported as a
 * heuristic, and can never lower a marked property to public.
 */
export function classifyKameletProperty(
  name: string,
  property: KameletPropertyDocument,
): { classification: KameletProperty["classification"]; source: KameletSecrecySource } {
  const descriptors = property["x-descriptors"] ?? [];
  if (descriptors.includes(KAMELET_CREDENTIAL_DESCRIPTOR))
    return { classification: "secret", source: "credentials-descriptor" };
  if (descriptors.includes(KAMELET_PASSWORD_DESCRIPTOR))
    return { classification: "secret", source: "password-descriptor" };
  if (property.format === KAMELET_PASSWORD_FORMAT)
    return { classification: "secret", source: "password-format" };
  if (credentialNamePattern.test(name))
    return { classification: "secret", source: "name-heuristic" };
  return { classification: "public", source: "not-secret" };
}

/** `camel.apache.org/kamelet.type` is the only place the role is stated. */
export function kameletTypeOf(document: KameletDocument): KameletType | undefined {
  const raw = document.metadata.labels?.[KAMELET_TYPE_LABEL];
  const parsed = kameletTypeSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The Camel component scheme a template names, e.g. `aws2-s3` in
 * `aws2-s3:{{bucketNameOrArn}}`. Only the scheme is taken; the remainder can
 * contain placeholders and is never parsed as a URL.
 */
export function templateScheme(uri: string | undefined): string | undefined {
  if (typeof uri !== "string") return undefined;
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]{0,63}):/.exec(uri.trim());
  return match?.[1];
}
