import { z } from "zod";
import { manifestSchema, type ConnectorManifest } from "../core/schema.js";

const name = z.string().regex(/^[A-Za-z0-9_-]+$/);
/** Deliberately bounded Arazzo 1.0.1 profile: sequential trusted operations.
 * Unsupported control flow fails validation; no eval, source fetching or implicit retries.
 */
export const arazzoSchema = z
  .object({
    arazzo: z.literal("1.0.1"),
    info: z.object({ title: z.string(), version: z.string() }).strict(),
    sourceDescriptions: z
      .array(
        z
          .object({ name, url: z.string(), type: z.literal("openapi") })
          .strict(),
      )
      .length(1),
    workflows: z
      .array(
        z
          .object({
            workflowId: name,
            summary: z.string(),
            steps: z
              .array(
                z
                  .object({
                    stepId: name,
                    description: z.string(),
                    operationId: z.string().min(1).optional(),
                    operationPath: z
                      .string()
                      .regex(
                        /^\{\$sourceDescriptions\.[A-Za-z0-9_-]+\.url\}#\/paths\/.+\/(get|post|put|patch|delete|head|options)$/,
                      )
                      .optional(),
                  })
                  .strict()
                  .refine(
                    (step) => !!step.operationId !== !!step.operationPath,
                    "Specify exactly one operationId or operationPath",
                  ),
              )
              .min(1)
              .max(32),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const unique = (values: string[]) => new Set(values).size === values.length;
    if (
      !unique(doc.workflows.map((w) => w.workflowId)) ||
      doc.workflows.some((w) => !unique(w.steps.map((s) => s.stepId)))
    )
      ctx.addIssue({
        code: "custom",
        message: "Workflow and step IDs must be unique",
      });
  });
export type ArazzoDocument = z.infer<typeof arazzoSchema>;

/** Validate the host's pinned catalog before mounting a connector; never fetch a source URL. */
export function validateConnectorWorkflows(
  manifest: ConnectorManifest,
  documents: ReadonlyMap<string, ArazzoDocument>,
): void {
  for (const method of manifestSchema.parse(manifest).methods) {
    for (const reference of method.contract?.workflows ?? []) {
      const document = arazzoSchema.parse(documents.get(reference.document));
      if (
        document.info.version !== reference.version ||
        !document.workflows.some(
          (workflow) => workflow.workflowId === reference.workflowId,
        )
      )
        throw new Error(
          "Connector workflow reference is unavailable or incompatible",
        );
    }
  }
}
export interface WorkflowStepEvent {
  workflowId: string;
  stepId: string;
  operationId?: string;
  operationPath?: string;
  status: "success" | "failure";
}

/** Bind operations in trusted host code. Authentication and input validation belong
 * to those SDK-backed handlers, never to imported documents or model-generated code.
 * Handler results remain private to the caller; observer events contain identifiers only.
 */
export async function runArazzo(
  document: ArazzoDocument,
  workflowId: string,
  operations: ReadonlyMap<string, () => Promise<unknown>>,
  onStep?: (event: WorkflowStepEvent) => void | Promise<void>,
): Promise<void> {
  const workflow = arazzoSchema
    .parse(document)
    .workflows.find((w) => w.workflowId === workflowId);
  if (!workflow) throw new Error("Unknown Arazzo workflow");
  // Preflight every binding before allowing an external side effect.
  for (const step of workflow.steps) {
    const operation = step.operationId ?? step.operationPath!;
    if (typeof operations.get(operation) !== "function")
      throw new Error(`Unbound workflow operation: ${operation}`);
  }
  for (const step of workflow.steps) {
    const notify = (status: WorkflowStepEvent["status"]) => {
      try {
        const pending = onStep?.({
          workflowId,
          stepId: step.stepId,
          ...(step.operationId
            ? { operationId: step.operationId }
            : { operationPath: step.operationPath! }),
          status,
        });
        void Promise.resolve(pending).catch(() => {});
      } catch {
        /* Observers cannot repeat or roll back provider side effects. */
      }
    };
    try {
      await operations.get(step.operationId ?? step.operationPath!)!();
      notify("success");
    } catch (error) {
      notify("failure");
      throw error;
    }
  }
}
