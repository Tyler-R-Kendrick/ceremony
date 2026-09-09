import { z } from "zod";
import {
  operationContractSchema,
  type ActorContext,
  type FieldClassification,
  type OperationContract,
} from "../../core/operation-contracts.js";
import type { PublicBindingPolicy } from "../../core/projections.js";
import type { diagnosticCodeSchema } from "../../core/teaching-contracts.js";

export type OperationContext = {
  actor: ActorContext;
  runId: string;
  nodeId: string;
  commandId: string;
  effectId: string;
  target: string;
  configurationVersion: string;
  origin: string;
  environment: string;
  signal: AbortSignal;
};
export type OperationResult = {
  state: "complete" | "awaiting-human" | "verifying" | "uncertain" | "failed";
  outputs: Record<string, unknown>;
  diagnosticCode?: z.infer<typeof diagnosticCodeSchema>;
};
export type RegisteredOperation = {
  contract: OperationContract;
  inputSchema: z.ZodType<Record<string, unknown>>;
  outputSchema: z.ZodType<Record<string, unknown>>;
  classifications: PublicBindingPolicy;
  handler(
    context: OperationContext,
    inputs: Record<string, unknown>,
  ): Promise<OperationResult>;
  verify?(context: OperationContext, result: OperationResult): Promise<boolean>;
  fixtures: readonly string[];
};
export type VocabularyEntry = {
  schema: z.ZodType;
  classification: FieldClassification;
  provider?: string;
  profile?: string;
};

/** Registry construction is a trusted host operation, never an authoring API. */
export class OperationRegistry {
  private readonly operations = new Map<string, RegisteredOperation>();
  readonly vocabulary: ReadonlyMap<string, VocabularyEntry>;
  constructor(vocabulary: ReadonlyMap<string, VocabularyEntry> = new Map()) {
    this.vocabulary = new Map(vocabulary);
  }
  register(operation: RegisteredOperation): void {
    const contract = operationContractSchema.parse(operation.contract);
    const key = `${contract.id}@${contract.version}`;
    if (this.operations.has(key))
      throw new Error("Operation version already registered");
    for (const slot of [
      ...Object.values(contract.inputs),
      ...Object.values(contract.outputs),
    ]) {
      if (!this.vocabulary.has(slot.contract))
        throw new Error("Unknown registered input contract");
    }
    this.operations.set(key, { ...operation, contract });
  }
  get(id: string, version: string): RegisteredOperation | undefined {
    return this.operations.get(`${id}@${version}`);
  }
  require(id: string, version: string): RegisteredOperation {
    const operation = this.get(id, version);
    if (!operation) throw new Error("Unsupported operation version");
    return operation;
  }
  catalog(): OperationContract[] {
    return Array.from(this.operations.values(), ({ contract }) =>
      operationContractSchema.parse(contract),
    );
  }
}
