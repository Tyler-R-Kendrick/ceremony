import { z } from "zod";
import {
  nativeVersionSchema,
  sha256HexSchema,
} from "../../../../core/connectors/identity.js";
import {
  identifierSchema,
  operationIdSchema,
  semanticVersionSchema,
} from "../../../../core/operation-contracts.js";
import { parseRuntimeExpression } from "./expressions.js";
import type { PreservedSourceDescription } from "./model.js";
import { parseSourcePath } from "./read.js";

/*
 * The host's answer to "which registered operation does this Arazzo
 * reference mean". An imported description never registers an operation; the
 * host pins, per source description name, exactly one document identity (its
 * reviewed bytes or its exact URL), the document version it reviewed, and the
 * registered operation id@version each operationId or operationPath maps to.
 * Resolution is exact: two documents offering the same operationId are an
 * error the step must resolve by naming its source, never a first match.
 */

const sourceName = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const arazzoIdentifier = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);

export const catalogOperationSchema = z
  .strictObject({
    operationId: z.string().min(1).max(512).optional(),
    /** JSON pointer fragment of the operation inside the document, e.g. "#/paths/~1pets/get". */
    operationPath: z
      .string()
      .min(3)
      .max(1024)
      .regex(/^#\/[^\p{Cc}]*$/u)
      .optional(),
    operation: z.strictObject({
      id: operationIdSchema,
      version: semanticVersionSchema,
    }),
    /** "<in>:<name>" or "<name>" of an Arazzo parameter to a registered input name. */
    parameters: z
      .record(z.string().min(1).max(220), identifierSchema)
      .optional(),
    /** Top-level payload property (or "*" for the whole payload) to a registered input name. */
    requestBody: z
      .record(z.string().min(1).max(200), identifierSchema)
      .optional(),
    /** Exact step-output extraction expression to a registered output name. */
    outputs: z.record(z.string().min(1).max(1024), identifierSchema).optional(),
    /** Replay evidence the host holds for this operation; "none" forbids retries. */
    replay: z
      .enum(["read-only", "upstream-idempotency-key", "reconciliation", "none"])
      .default("none"),
  })
  .refine(
    (entry) =>
      (entry.operationId === undefined) !== (entry.operationPath === undefined),
    "Bind exactly one of operationId or operationPath",
  );
export type CatalogOperation = z.infer<typeof catalogOperationSchema>;

export const catalogDocumentIdentitySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("url"),
    /** Compared for exact string equality with the declared source description URL. */
    url: z.string().min(1).max(2048),
  }),
  z.strictObject({
    kind: z.literal("digest"),
    /** SHA-256 of the exact reviewed document bytes. */
    sha256: sha256HexSchema,
    url: z.string().min(1).max(2048).optional(),
  }),
]);
export type CatalogDocumentIdentity = z.infer<
  typeof catalogDocumentIdentitySchema
>;

export const catalogDocumentSchema = z
  .strictObject({
    sourceDescriptionName: sourceName,
    identity: catalogDocumentIdentitySchema,
    /** The source document's own version (OpenAPI info.version) the host reviewed. */
    version: nativeVersionSchema,
    operations: z.array(catalogOperationSchema).max(4096),
  })
  .superRefine((document, ctx) => {
    const keys = new Set<string>();
    for (const operation of document.operations) {
      const key =
        operation.operationId !== undefined
          ? `id:${operation.operationId}`
          : `path:${operation.operationPath}`;
      if (keys.has(key))
        ctx.addIssue({
          code: "custom",
          message: "Duplicate operation binding",
        });
      keys.add(key);
    }
  });
export type CatalogDocument = z.infer<typeof catalogDocumentSchema>;

export const catalogWorkflowSchema = z.strictObject({
  /** Arazzo source description holding the workflow; absent for the compiled document itself. */
  sourceDescriptionName: sourceName.optional(),
  /** For local workflows: the canonical digest of the exact document this binding was reviewed against. */
  documentDigest: sha256HexSchema.optional(),
  workflowId: arazzoIdentifier,
  recipe: z.strictObject({
    id: identifierSchema,
    version: semanticVersionSchema,
    digest: sha256HexSchema,
  }),
  /** Child recipe input name to registered contract; verified again by recipe validation. */
  inputs: z.record(identifierSchema, identifierSchema).default({}),
  /** Child recipe output name to registered contract. */
  outputs: z.record(identifierSchema, identifierSchema).default({}),
});
export type CatalogWorkflow = z.infer<typeof catalogWorkflowSchema>;

export const operationBindingCatalogSchema = z.strictObject({
  tenantId: z.string().min(1).max(200),
  documents: z.array(catalogDocumentSchema).max(64),
  workflows: z.array(catalogWorkflowSchema).max(256).default([]),
});
export type OperationBindingCatalog = z.infer<
  typeof operationBindingCatalogSchema
>;
export type OperationBindingCatalogInput = z.input<
  typeof operationBindingCatalogSchema
>;

export type ResolvedOperationBinding = {
  sourceDescriptionName: string;
  documentIdentity: CatalogDocumentIdentity;
  declaredUrl: string;
  version: string;
  reference: { operationId: string } | { operationPath: string };
  operation: { id: string; version: string };
  entry: CatalogOperation;
};

export type OperationResolution =
  | { status: "resolved"; binding: ResolvedOperationBinding }
  | { status: "invalid-reference" }
  | { status: "unknown-source" }
  | { status: "source-mismatch" }
  | { status: "ambiguous-document" }
  | { status: "ambiguous-operation"; sources: string[] }
  | { status: "unbound" };

/**
 * Resolves a step's operation reference against the catalog. A plain
 * operationId is looked up in every non-arazzo source description; if more
 * than one bound document defines it the result is ambiguous. A
 * `$sourceDescriptions.<name>.<operationId>` expression or an operationPath
 * names the source explicitly.
 */
export function resolveOperation(
  catalog: OperationBindingCatalog,
  sources: readonly PreservedSourceDescription[],
  step: { operationId?: string; operationPath?: string },
): OperationResolution {
  let candidates: string[];
  let key: { operationId: string } | { operationPath: string };
  if (step.operationPath !== undefined) {
    const parsed = parseSourcePath(step.operationPath);
    if (!parsed) return { status: "invalid-reference" };
    candidates = [parsed.source];
    key = { operationPath: `#${parsed.pointer}` };
  } else if (step.operationId !== undefined) {
    if (step.operationId.startsWith("$")) {
      const expression = parseRuntimeExpression(step.operationId);
      if (expression?.kind !== "sourceDescriptions")
        return { status: "invalid-reference" };
      candidates = [expression.source];
      key = { operationId: expression.reference };
    } else {
      candidates = sources
        .filter((source) => source.type !== "arazzo")
        .map((source) => source.name);
      key = { operationId: step.operationId };
    }
  } else return { status: "invalid-reference" };
  const matches: ResolvedOperationBinding[] = [];
  for (const name of candidates) {
    const declared = sources.find((source) => source.name === name);
    if (!declared) return { status: "unknown-source" };
    const documents = catalog.documents.filter(
      (document) => document.sourceDescriptionName === name,
    );
    if (documents.length > 1) return { status: "ambiguous-document" };
    const document = documents[0];
    if (!document) continue;
    if (
      document.identity.url !== undefined &&
      document.identity.url !== declared.url
    )
      return { status: "source-mismatch" };
    const entry = document.operations.find((operation) =>
      "operationId" in key
        ? operation.operationId === key.operationId
        : operation.operationPath === key.operationPath,
    );
    if (!entry) continue;
    matches.push({
      sourceDescriptionName: name,
      documentIdentity: document.identity,
      declaredUrl: declared.url,
      version: document.version,
      reference: key,
      operation: entry.operation,
      entry,
    });
  }
  if (matches.length > 1)
    return {
      status: "ambiguous-operation",
      sources: matches.map((match) => match.sourceDescriptionName),
    };
  const binding = matches[0];
  return binding ? { status: "resolved", binding } : { status: "unbound" };
}

export type WorkflowResolution =
  | { status: "resolved"; binding: CatalogWorkflow }
  | { status: "unbound" }
  | { status: "ambiguous" };

/** Resolves a local workflow (pinned to this document's digest) or one in an arazzo source description. */
export function resolveWorkflow(
  catalog: OperationBindingCatalog,
  reference: { workflowId: string; sourceDescriptionName?: string },
  localDigest: string,
): WorkflowResolution {
  const matches = catalog.workflows.filter((entry) =>
    reference.sourceDescriptionName === undefined
      ? entry.sourceDescriptionName === undefined &&
        entry.workflowId === reference.workflowId &&
        (entry.documentDigest === undefined ||
          entry.documentDigest === localDigest)
      : entry.sourceDescriptionName === reference.sourceDescriptionName &&
        entry.workflowId === reference.workflowId,
  );
  if (matches.length > 1) return { status: "ambiguous" };
  const binding = matches[0];
  return binding ? { status: "resolved", binding } : { status: "unbound" };
}
