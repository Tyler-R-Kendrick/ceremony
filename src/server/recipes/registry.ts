import { z } from "zod";
import {
  operationContractSchema,
  type ActorContext,
  type FieldClassification,
  type OperationContract,
} from "../../core/operation-contracts.js";
import type { PublicBindingPolicy } from "../../core/projections.js";
import type { diagnosticCodeSchema } from "../../core/teaching-contracts.js";
import type { Fence } from "../persistence/index.js";

export type OperationContext = {
  actor: ActorContext;
  runId: string;
  nodeId: string;
  commandId: string;
  effectId: string;
  provider?: string;
  target: string;
  configurationVersion: string;
  origin: string;
  environment: string;
  signal: AbortSignal;
  /** Server-issued execution lease; absent during pure verification and human collection. Never a tool argument. */
  fence?: Fence;
};
/**
 * Public facts about the exchange a handler performed, reported by the
 * handler itself so a recipe's success criteria can read `$statusCode`,
 * `$url`, `$method` and `$response.header.<name>`. The handler decides what
 * is public: it reports only headers it knows carry no secret, and a URL
 * without credentials or tokens. The command service evaluates criteria
 * against these and then discards them; they are never stored, returned or
 * recorded.
 */
export type OperationResponseFacts = {
  statusCode?: number;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
};
export type OperationResult = {
  state: "complete" | "awaiting-human" | "verifying" | "uncertain" | "failed";
  outputs: Record<string, unknown>;
  diagnosticCode?: z.infer<typeof diagnosticCodeSchema>;
  response?: OperationResponseFacts;
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
  /**
   * The host's evidence that running the handler again after a completed or
   * failed attempt cannot duplicate an external effect. A recipe may declare
   * a retry only for an operation that carries it. Absent means no retry.
   */
  replay?: "read-only" | "upstream-idempotency-key" | "reconciliation";
};
export type VocabularyEntry = {
  schema: z.ZodType;
  classification: FieldClassification;
  provider?: string;
  profile?: string;
  /**
   * A value of this contract may flow from a step run under one connector's
   * authorization context into a step run under another's (an OAuth client
   * handle minted at one provider and used at a second, for instance).
   * Everything else stays inside the context that produced it.
   */
  crossProvider?: boolean;
};

/**
 * Provider and profile of a provider-neutral ("common") operation, and of the
 * vocabulary it may read and write. Only `registerNeutral` can register an
 * operation under it.
 */
export const NEUTRAL_PROVIDER = "common";

/** Registry construction is a trusted host operation, never an authoring API. */
export class OperationRegistry {
  private readonly operations = new Map<string, RegisteredOperation>();
  private readonly neutral = new Set<string>();
  readonly vocabulary: ReadonlyMap<string, VocabularyEntry>;
  constructor(vocabulary: ReadonlyMap<string, VocabularyEntry> = new Map()) {
    this.vocabulary = new Map(vocabulary);
  }
  register(operation: RegisteredOperation): void {
    this.add(operation, false);
  }
  /**
   * Register a step that any provider's run may include (an agent inbox, for
   * instance). A run otherwise admits only its own provider/profile, so a
   * recipe cannot smuggle one provider's effect into another's authorization
   * context. A neutral step keeps that property by construction: every slot it
   * reads or writes is neutral vocabulary, so it can neither consume nor mint a
   * provider artifact; its outputs are opaque handles to server-side state
   * owned by the same run.
   */
  registerNeutral(operation: RegisteredOperation): void {
    this.add(operation, true);
  }
  private add(operation: RegisteredOperation, neutral: boolean): void {
    const contract = operationContractSchema.parse(operation.contract);
    const key = `${contract.id}@${contract.version}`;
    if (this.operations.has(key))
      throw new Error("Operation version already registered");
    // Either both fields name the neutral provider, through registerNeutral, or neither does.
    const declared = [contract.provider, contract.profile].filter(
      (value) => value === NEUTRAL_PROVIDER,
    ).length;
    if (declared !== (neutral ? 2 : 0))
      throw new Error("Provider-neutral operations require registerNeutral");
    for (const slot of [
      ...Object.values(contract.inputs),
      ...Object.values(contract.outputs),
    ]) {
      const entry = this.vocabulary.get(slot.contract);
      if (!entry) throw new Error("Unknown registered input contract");
      if (
        neutral &&
        (entry.provider !== NEUTRAL_PROVIDER ||
          entry.profile !== NEUTRAL_PROVIDER)
      )
        throw new Error("Provider-neutral operations use neutral vocabulary");
    }
    this.operations.set(key, { ...operation, contract });
    if (neutral) this.neutral.add(key);
  }
  /** True only for an operation registered through `registerNeutral`. */
  isNeutral(id: string, version: string): boolean {
    return this.neutral.has(`${id}@${version}`);
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
