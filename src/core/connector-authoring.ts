import { z } from "zod";
import {
  connectorManifestV1Schema,
  defaultTemplate,
  type AuthMethod,
  type ConnectorManifest,
  type FlowKind,
  templateSchema,
} from "./schema.js";

const identifier = z.string().regex(/^[a-z0-9-]{1,64}$/);
const operation = z.string().regex(/^[A-Za-z][A-Za-z0-9._/-]{0,119}$/);
/** Authoring envelope, not an execution engine or publication grant. */
export const connectorProjectSchema = z
  .strictObject({
    format: z.literal("ceremony-connector"),
    version: z.literal(1),
    manifest: connectorManifestV1Schema,
    templates: z.array(templateSchema).max(12).default([]),
    workflows: z
      .array(
        z.strictObject({
          document: identifier,
          arazzo: z.literal("1.0.1"),
          info: z.strictObject({
            title: z.string().min(1).max(100),
            version: z.literal("1.0.0"),
          }),
          sourceDescriptions: z
            .array(
              z.strictObject({
                name: z.literal("provider"),
                url: z
                  .string()
                  .max(500)
                  .url()
                  .refine((value) => {
                    if (!URL.canParse(value)) return false;
                    const url = new URL(value);
                    return (
                      url.protocol === "https:" &&
                      !url.username &&
                      !url.password &&
                      !url.search &&
                      !url.hash
                    );
                  }, "Use a public HTTPS OpenAPI document URL without credentials or query parameters"),
                type: z.literal("openapi"),
              }),
            )
            .length(1),
          workflows: z
            .array(
              z.strictObject({
                workflowId: identifier,
                summary: z.string().min(1).max(500),
                steps: z
                  .array(
                    z.strictObject({
                      stepId: identifier,
                      description: z.string().min(1).max(500),
                      operationId: operation,
                    }),
                  )
                  .min(1)
                  .max(32),
              }),
            )
            .min(1)
            .max(12),
        }),
      )
      .min(1)
      .max(12),
  })
  .superRefine(validateReferences);
function validateReferences(
  project: {
    manifest: {
      methods: Array<{
        kind: string;
        templateId: string;
        contract: {
          workflows: Array<{
            document: string;
            version: string;
            workflowId: string;
          }>;
        };
      }>;
    };
    templates: Array<{ id: string; kind: string }>;
    workflows: Array<{
      document: string;
      info: { version: string };
      workflows: Array<{
        workflowId: string;
        steps: Array<{ stepId: string }>;
      }>;
    }>;
  },
  ctx: z.RefinementCtx,
) {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  const documents = new Set<string>();
  let count = 0;
  for (const doc of project.workflows) {
    if (documents.has(doc.document)) fail("Duplicate workflow document");
    documents.add(doc.document);
    if (
      new Set(doc.workflows.map((w) => w.workflowId)).size !==
      doc.workflows.length
    )
      fail("Duplicate workflow ID");
    for (const workflow of doc.workflows) {
      count += workflow.steps.length;
      if (
        new Set(workflow.steps.map((s) => s.stepId)).size !==
        workflow.steps.length
      )
        fail("Duplicate step ID");
    }
  }
  if (count > 32) fail("A connector project supports at most 32 steps");
  const referenced = new Set<string>();
  const presentationKinds = new Map<string, string>();
  for (const method of project.manifest.methods) {
    const kind = presentationKinds.get(method.templateId);
    if (kind !== undefined && kind !== method.kind)
      fail("Presentation ID cannot be shared across authentication families");
    presentationKinds.set(method.templateId, method.kind);
    if (method.contract.workflows.length !== 1)
      fail("Studio methods require exactly one editable workflow");
    for (const ref of method.contract.workflows) {
      const doc = project.workflows.find((d) => d.document === ref.document);
      const workflow = doc?.workflows.find(
        (w) => w.workflowId === ref.workflowId,
      );
      if (!workflow || doc?.info.version !== ref.version)
        fail("Method references an unavailable workflow version");
      referenced.add(`${ref.document}:${ref.workflowId}`);
    }
  }
  for (const doc of project.workflows)
    for (const workflow of doc.workflows)
      if (!referenced.has(`${doc.document}:${workflow.workflowId}`))
        fail("Workflow is not attached to an authentication method");
  if (
    new Set(project.templates.map((t) => t.id)).size !==
    project.templates.length
  )
    ctx.addIssue({ code: "custom", message: "Duplicate presentation ID" });
  for (const template of project.templates)
    if (
      !project.manifest.methods.some(
        (method) =>
          method.kind === template.kind && method.templateId === template.id,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Presentation is not attached to a method",
      });
}
export type ConnectorProject = z.infer<typeof connectorProjectSchema>;

// Drafts use the same representation with blank form fields permitted. They are
// never accepted by the completed-definition validator or the execution runtime.
const manifestShape = connectorManifestV1Schema.shape;
const methodShape = manifestShape.methods.element.shape;
const contractShape = methodShape.contract.shape;
const documentShape = connectorProjectSchema.shape.workflows.element.shape;
const workflowShape = documentShape.workflows.element.shape;
const stepShape = workflowShape.steps.element.shape;
export const connectorProjectDraftSchema = z
  .strictObject({
    ...connectorProjectSchema.shape,
    manifest: z.strictObject({
      ...manifestShape,
      id: z.string().max(64),
      name: z.string().max(100),
      methods: z
        .array(
          z.strictObject({
            ...methodShape,
            label: z.string().max(100),
            contract: z.strictObject({
              ...contractShape,
              completion: z.strictObject({
                ...contractShape.completion.shape,
                verifier: z.string().max(120),
              }),
              configuration: z
                .array(
                  z.strictObject({
                    ...contractShape.configuration.element.shape,
                    name: z.string().max(96),
                  }),
                )
                .max(24),
              prerequisites: z
                .array(
                  z.strictObject({
                    ...contractShape.prerequisites.element.shape,
                    id: z.string().max(120),
                  }),
                )
                .max(12),
              workflows: contractShape.workflows.length(1),
            }),
          }),
        )
        .max(12),
    }),
    workflows: z
      .array(
        z.strictObject({
          ...documentShape,
          sourceDescriptions: z
            .array(
              z.strictObject({
                ...documentShape.sourceDescriptions.element.shape,
                url: z.union([
                  documentShape.sourceDescriptions.element.shape.url,
                  z.literal(""),
                ]),
              }),
            )
            .length(1),
          workflows: z
            .array(
              z.strictObject({
                ...workflowShape,
                steps: z
                  .array(
                    z.strictObject({
                      ...stepShape,
                      description: z.string().max(500),
                      operationId: z.union([operation, z.literal("")]),
                    }),
                  )
                  .min(1)
                  .max(32),
              }),
            )
            .max(12),
        }),
      )
      .min(1)
      .max(12),
  })
  .superRefine(validateReferences);

export function parseConnectorDraft(text: string) {
  if (new TextEncoder().encode(text).byteLength > 256 * 1024)
    throw new Error("Project exceeds 256 KiB");
  return connectorProjectDraftSchema.parse(JSON.parse(text));
}

export function parseConnectorProject(text: string): ConnectorProject {
  if (new TextEncoder().encode(text).byteLength > 256 * 1024)
    throw new Error("Project exceeds 256 KiB");
  return connectorProjectSchema.parse(JSON.parse(text));
}

/** Conservative initial fields, not inferred provider capabilities. Author reviews every method. */
export function newAuthoredMethod(kind: FlowKind, id: string): AuthMethod {
  const privateInput = ["api-key", "basic", "form"].includes(kind);
  const fields: AuthMethod["fields"] =
    kind === "api-key"
      ? [
          {
            name: "token",
            label: "API key",
            type: "password",
            required: true,
            classification: "secret",
          },
        ]
      : kind === "basic" || kind === "form"
        ? [
            {
              name: "username",
              label: "Username",
              type: "text",
              required: true,
              classification: "personal",
            },
            {
              name: "password",
              label: "Password",
              type: "password",
              required: true,
              classification: "secret",
            },
          ]
        : [];
  return {
    id,
    kind,
    label: kind,
    fields,
    scopes: [],
    templateId: kind,
    contract: {
      profile: id,
      surfaces: ["browser"],
      configuration: [],
      configurationGroups: [],
      prerequisites: [],
      handoff: {
        surface: privateInput ? "private-collector" : "provider-browser",
        recipient: "initiating-subject",
        delegation: "a2h-authorize",
        resume: "verify",
      },
      completion: {
        verifier: "",
        ownership: [
          kind === "authmd-anonymous" ? "anonymous" : "authenticated",
        ],
      },
      workflows: [{ document: "ceremonies", version: "1.0.0", workflowId: id }],
    },
  };
}

export function newConnectorProject(): Omit<ConnectorProject, "manifest"> & {
  manifest: ConnectorManifest;
} {
  return {
    format: "ceremony-connector" as const,
    version: 1 as const,
    templates: [],
    manifest: {
      schemaVersion: 1 as const,
      support: "live-adapter" as const,
      id: "",
      name: "",
      description: "",
      methods: [] as AuthMethod[],
    },
    workflows: [
      {
        document: "ceremonies",
        arazzo: "1.0.1" as const,
        info: { title: "Connector ceremonies", version: "1.0.0" as const },
        sourceDescriptions: [
          { name: "provider" as const, url: "", type: "openapi" as const },
        ],
        workflows: [] as ConnectorProject["workflows"][number]["workflows"],
      },
    ],
  };
}

/** Portable files only. The host must register handlers and verifiers separately. */
export function exportConnectorFiles(project: ConnectorProject) {
  const parsed = connectorProjectSchema.parse(project);
  return {
    manifest: parsed.manifest,
    workflows: parsed.workflows.map(({ document, ...definition }) => ({
      name: `${document}.arazzo.json`,
      definition,
    })),
    templates: parsed.manifest.methods
      .filter(
        (method, index, methods) =>
          methods.findIndex((m) => m.templateId === method.templateId) ===
          index,
      )
      .map(
        (method) =>
          parsed.templates.find(
            (template) => template.id === method.templateId,
          ) ?? {
            ...defaultTemplate(method.kind),
            id: method.templateId,
          },
      ),
  };
}
