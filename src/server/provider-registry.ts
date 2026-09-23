import type { ActorContext } from "../core/operation-contracts.js";
import type { RecipeDefinition } from "../core/recipe-contracts.js";
import type { RunContext, RunRecord } from "./commands.js";
import type { OperationRegistry, VocabularyEntry } from "./recipes/registry.js";

/*
 * The built-in providers a runtime offers, keyed by connector id.
 *
 * Every question the runtime used to answer with a chain of provider-name
 * ternaries -- which vocabulary to load, which operations to register, which
 * connection recipe to run, what configuration version a run must still match,
 * what context a new run starts in -- is answered here by looking the provider
 * up instead. Adding a provider is then one entry, not an edit to five
 * branches that each have to stay in the same order.
 *
 * The lookup is also the fail-closed rule: a run whose provider has no entry
 * has no current configuration to match, so it is never authorized. A
 * provider a host did not configure is simply absent, which is the same
 * answer the old branches gave for it, and a provider name nobody registered
 * cannot fall through to someone else's configuration.
 *
 * Authored connectors are not entries. They are tenant data installed at
 * runtime, not host code, and the runtime handles their profile separately.
 */

export interface ProviderConnection {
  definition: RecipeDefinition;
  outputContract: string;
  revalidateOperation: string;
}

export interface ProviderEntry {
  /** Connector id; also the `provider` of every run this entry starts. */
  readonly id: string;
  /** Operation vocabulary; loaded before any handler is registered. */
  readonly vocabulary: ReadonlyMap<string, VocabularyEntry>;
  /** Registers this provider's operation handlers. */
  register(registry: OperationRegistry): void;
  /** The connection recipe `connect` runs for this provider. */
  readonly connection: ProviderConnection;
  /**
   * The configuration version the actor's current, trusted configuration
   * yields. A run stays authorized only while the version it recorded equals
   * this, so rotating configuration fences every run started under the old one.
   */
  configurationVersion(actor: ActorContext): Promise<string | undefined>;
  /** The authorization context a new run for this provider starts in. */
  context(actor: ActorContext): Promise<RunContext>;
  /**
   * Provider-specific admission beyond the version check, e.g. a target the
   * host still allows. Not consulted for a continuation, which only resumes.
   */
  admits?(actor: ActorContext, run: RunRecord): Promise<boolean>;
  /**
   * An installed authored connector with this same id takes precedence.
   * Preserves the historical order: a host-registered provider normally wins,
   * but the reference GitHub connection yields to an authored install.
   */
  readonly yieldsToAuthored?: boolean;
}

export class ProviderRegistry {
  private readonly entries = new Map<string, ProviderEntry>();

  constructor(entries: Iterable<ProviderEntry>) {
    for (const entry of entries) {
      // A duplicate is a composition mistake, never a silent replacement:
      // the second entry would inherit runs authorized against the first.
      if (this.entries.has(entry.id))
        throw new Error(`Duplicate provider ${entry.id}`);
      this.entries.set(entry.id, entry);
    }
  }

  get(id: string): ProviderEntry | undefined {
    return this.entries.get(id);
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  /** Every entry's vocabulary, for constructing the operation registry. */
  vocabulary(): Array<[string, VocabularyEntry]> {
    return [...this.entries.values()].flatMap((entry) => [...entry.vocabulary]);
  }

  register(registry: OperationRegistry): void {
    for (const entry of this.entries.values()) entry.register(registry);
  }

  /** The connection registrations, in entry order, for the teaching runtime. */
  connections(): Map<string, ProviderConnection> {
    return new Map(
      [...this.entries.values()].map((entry) => [entry.id, entry.connection]),
    );
  }

  /**
   * The context a new run for `connectorId` starts in, or undefined when this
   * registry does not decide it (an authored install, or nothing registered).
   */
  async context(
    actor: ActorContext,
    connectorId: string,
    authored: boolean,
  ): Promise<RunContext | undefined> {
    const entry = this.entries.get(connectorId);
    if (!entry || (authored && entry.yieldsToAuthored)) return undefined;
    return entry.context(actor);
  }

  /**
   * Whether a run still matches its provider's current configuration and
   * admission rules. `authoredVersion` is the version an authored run was
   * recorded under; authored runs have no entry by design.
   */
  async authorizes(
    actor: ActorContext,
    run: RunRecord,
    operationId: string,
    authoredVersion: string,
  ): Promise<boolean> {
    const entry =
      run.profile === "authored" ? undefined : this.entries.get(run.provider);
    if (operationId !== "continuation" && entry?.admits)
      if (!(await entry.admits(actor, run))) return false;
    const expected =
      run.profile === "authored"
        ? authoredVersion
        : await entry?.configurationVersion(actor);
    return (
      operationId === "continuation" ||
      (expected !== undefined && expected === run.configurationVersion)
    );
  }
}
