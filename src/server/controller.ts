import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CeremonyDatabase, PrivateCredentialBroker } from "./storage.js";
import {
  actionSchema,
  actionsFor,
  fieldsFor,
  manifestSchema,
  outcomeSchema,
  validateInput,
  type AuthMethod,
  type AuthOutcome,
  type CeremonySnapshot,
  type ConnectorManifest,
  type Step,
  snapshotSchema,
} from "../core/index.js";

export class CeremonyError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}
export interface AdapterUpdate {
  step: Step;
  /** Trusted prerequisite fields, independent of the final authentication method. */
  fields?: CeremonySnapshot["fields"];
  expiresAt?: number;
  authorizationUrl?: string;
  verificationUri?: string;
  userCode?: string;
  outcome?: AuthOutcome;
  message?: string;
  prerequisites?: CeremonySnapshot["prerequisites"];
}
export interface AuthAdapter {
  initial?(): AdapterUpdate;
  retry?(): Promise<AdapterUpdate>;
  requestHuman?(): Promise<AdapterUpdate>;
  begin(): Promise<AdapterUpdate>;
  submit(
    values: Record<string, string>,
    claiming: boolean,
  ): Promise<AdapterUpdate>;
  callback(url: URL): Promise<AdapterUpdate>;
  poll(): Promise<AdapterUpdate | undefined>;
  cancel(): void;
}
export interface AdapterContext {
  instanceId: string;
  owner: string;
  method: AuthMethod;
}
export interface ConnectorRegistration {
  manifest: ConnectorManifest;
  createAdapter(context: AdapterContext): AuthAdapter;
  /** Only adapters with protected, persisted protocol state can opt in. */
  recoverable?: boolean;
  resume?(owner: string, methodId: string): string | undefined;
}
interface Instance {
  owner: string;
  snapshot: CeremonySnapshot;
  adapter: AuthAdapter;
  busy: boolean;
  lastRead: number;
}
export interface InstanceStore {
  get(id: string): Instance | undefined;
  set(id: string, instance: Instance): void;
  delete(id: string): void;
  values(): Iterable<Instance>;
}

/** Single-process reference storage. Hosts own durable transaction/credential storage. */
export class CeremonyController {
  readonly registrations: Map<string, ConnectorRegistration>;
  constructor(
    registrations: ConnectorRegistration[],
    private store: InstanceStore = new Map(),
    private now = Date.now,
    private options: {
      database?: CeremonyDatabase;
      broker?: PrivateCredentialBroker;
    } = {},
  ) {
    this.registrations = new Map(
      registrations.map((registration) => {
        const manifest = manifestSchema.parse(registration.manifest);
        return [manifest.id, { ...registration, manifest }];
      }),
    );
    if (this.registrations.size !== registrations.length)
      throw new Error("Duplicate connector IDs");
    if (
      options.database &&
      registrations.some((registration) => !registration.recoverable)
    )
      throw new Error("Durable controllers require recoverable adapters");
  }
  manifests(): ConnectorManifest[] {
    return [...this.registrations.values()].map((value) =>
      structuredClone(value.manifest),
    );
  }
  start(
    owner: string,
    connectorId: string,
    methodId: string,
  ): CeremonySnapshot {
    const lease = this.options.database?.acquire(
      `start:${owner}:${connectorId}:${methodId}`,
    );
    try {
      return this.startLocked(owner, connectorId, methodId);
    } finally {
      if (lease)
        this.options.database?.release(
          `start:${owner}:${connectorId}:${methodId}`,
          lease,
        );
    }
  }
  private startLocked(
    owner: string,
    connectorId: string,
    methodId: string,
  ): CeremonySnapshot {
    this.sweep();
    const registration = this.registrations.get(connectorId);
    const method = registration?.manifest.methods.find(
      (candidate) => candidate.id === methodId,
    );
    if (!registration || !method)
      throw new CeremonyError("Unknown connector or method", 404);
    const resumeId = registration.resume?.(owner, methodId);
    if (resumeId)
      return structuredClone(this.instance(owner, resumeId).snapshot);
    if (
      [...this.store.values()].filter((instance) => instance.owner === owner)
        .length >= 100
    )
      throw new CeremonyError(
        "Too many attempts. Wait for old attempts to expire.",
        429,
      );
    const id = randomUUID();
    const step = ["basic", "api-key", "form"].includes(method.kind)
      ? "input"
      : "intro";
    const adapter = registration.createAdapter({
      instanceId: id,
      method,
      owner,
    });
    const initial = adapter.initial?.();
    const snapshot: CeremonySnapshot = {
      id,
      revision: 0,
      connectorId,
      connectorName: registration.manifest.name,
      description: registration.manifest.description,
      method: structuredClone(method),
      step,
      fields: fieldsFor(step, method),
      actions: actionsFor(step),
      expiresAt: this.now() + 600_000,
      ...initial,
    };
    snapshot.actions = actionsFor(snapshot.step);
    snapshot.fields = initial?.fields ?? fieldsFor(snapshot.step, method);
    this.store.set(id, {
      owner,
      snapshot,
      adapter,
      busy: false,
      lastRead: 0,
    });
    this.persist(this.store.get(id)!);
    return structuredClone(snapshot);
  }
  private instance(owner: string, id: string): Instance {
    if (this.options.database && !this.store.get(id)?.busy) {
      const saved = this.options.database.get(
        `instance:${id}`,
        z.object({ owner: z.string(), snapshot: snapshotSchema }),
      );
      if (saved && saved.owner === owner) {
        const registration = this.registrations.get(saved.snapshot.connectorId);
        if (!registration)
          throw new CeremonyError("Connector unavailable", 404);
        this.store.set(id, {
          ...saved,
          adapter: registration.createAdapter({
            owner,
            instanceId: id,
            method: saved.snapshot.method,
          }),
          busy: false,
          lastRead: 0,
        });
      }
    }
    const instance = this.store.get(id);
    if (!instance || instance.owner !== owner)
      throw new CeremonyError("Ceremony not found or session expired", 404);
    if (
      !["complete", "cancelled", "expired"].includes(instance.snapshot.step) &&
      instance.snapshot.expiresAt <= this.now()
    ) {
      instance.adapter.cancel();
      this.update(instance, {
        step: "expired",
        message: "The approval window expired. Start a new attempt.",
      });
    }
    return instance;
  }
  private update(instance: Instance, update: AdapterUpdate): void {
    const previous = instance.snapshot;
    if (
      Object.entries(update).every(
        ([key, value]) =>
          JSON.stringify(Reflect.get(previous, key)) === JSON.stringify(value),
      )
    )
      return;
    const outcome = update.outcome
      ? outcomeSchema.parse(update.outcome)
      : previous.outcome;
    instance.snapshot = {
      id: previous.id,
      revision: previous.revision + 1,
      connectorId: previous.connectorId,
      connectorName: previous.connectorName,
      description: previous.description,
      method: previous.method,
      step: update.step,
      expiresAt: update.expiresAt ?? previous.expiresAt,
      fields: update.fields ?? fieldsFor(update.step, previous.method),
      actions: actionsFor(update.step, outcome?.ownership === "anonymous"),
      ...(outcome ? { outcome } : {}),
      ...(update.message ? { message: update.message } : {}),
      ...(update.authorizationUrl
        ? { authorizationUrl: update.authorizationUrl }
        : {}),
      ...(update.verificationUri
        ? { verificationUri: update.verificationUri }
        : {}),
      ...(update.userCode ? { userCode: update.userCode } : {}),
      ...((update.prerequisites ?? previous.prerequisites)
        ? { prerequisites: update.prerequisites ?? previous.prerequisites }
        : {}),
    };
    if (
      instance.adapter.requestHuman &&
      ["redirect", "input"].includes(update.step)
    )
      instance.snapshot.actions.push("request-human");
    this.persist(instance);
  }
  private persist(instance: Instance): void {
    const database = this.options.database;
    if (!database) return;
    database.transaction(() => {
      database.put(`instance:${instance.snapshot.id}`, {
        owner: instance.owner,
        snapshot: instance.snapshot,
      });
      const eventId = randomUUID();
      database.put(`event:${eventId}`, {
        eventId,
        instanceId: instance.snapshot.id,
        revision: instance.snapshot.revision,
        step: instance.snapshot.step,
        occurredAt: this.now(),
        status: ["error", "expired"].includes(instance.snapshot.step)
          ? "failure"
          : "success",
      });
    });
  }
  /** Native UI endpoint only: never register this function as an agent tool. */
  collect(
    owner: string,
    id: string,
    revision: number,
    values: Record<string, string>,
  ): string {
    const instance = this.instance(owner, id);
    if (
      !this.options.broker ||
      instance.busy ||
      instance.snapshot.revision !== revision ||
      !instance.snapshot.actions.includes("submit")
    )
      throw new CeremonyError("Private collection is unavailable", 409);
    let checked: Record<string, string>;
    try {
      checked = validateInput(instance.snapshot.fields, values);
    } catch {
      throw new CeremonyError("Invalid credential fields");
    }
    return this.options.broker.collect(owner, id, revision, checked);
  }
  async read(owner: string, id: string): Promise<CeremonySnapshot> {
    const lease = this.options.database?.acquire(`instance:${id}`);
    try {
      return await this.readLocked(owner, id);
    } finally {
      if (lease) this.options.database?.release(`instance:${id}`, lease);
    }
  }
  private async readLocked(
    owner: string,
    id: string,
  ): Promise<CeremonySnapshot> {
    const instance = this.instance(owner, id);
    if (
      (instance.snapshot.step === "waiting" ||
        (this.options.database && instance.snapshot.step === "redirect")) &&
      !instance.busy &&
      this.now() - instance.lastRead >= 1000
    ) {
      instance.lastRead = this.now();
      await this.run(instance, () => instance.adapter.poll());
    }
    return structuredClone(instance.snapshot);
  }
  async act(
    owner: string,
    id: string,
    input: unknown,
  ): Promise<CeremonySnapshot> {
    const lease = this.options.database?.acquire(`instance:${id}`);
    try {
      const snapshot = await this.actLocked(owner, id, input);
      this.actionEvent(
        owner,
        id,
        input,
        snapshot.step === "error" || snapshot.step === "expired"
          ? "failure"
          : "success",
      );
      return snapshot;
    } catch (error) {
      this.actionEvent(owner, id, input, "failure");
      throw error;
    } finally {
      if (lease) this.options.database?.release(`instance:${id}`, lease);
    }
  }
  private actionEvent(
    owner: string,
    id: string,
    input: unknown,
    status: "success" | "failure",
  ): void {
    const instance = this.store.get(id);
    if (!instance || instance.owner !== owner || !this.options.database) return;
    const action = actionSchema.safeParse(input);
    const eventId = randomUUID();
    this.options.database.put(`event:${eventId}`, {
      eventId,
      instanceId: id,
      revision: instance.snapshot.revision,
      step: instance.snapshot.step,
      occurredAt: this.now(),
      status,
      action: action.success ? action.data.action : "invalid",
    });
  }
  private async actLocked(
    owner: string,
    id: string,
    input: unknown,
  ): Promise<CeremonySnapshot> {
    const parsed = actionSchema.safeParse(input);
    if (!parsed.success) throw new CeremonyError("Invalid ceremony action");
    const { action, revision, values, secretRef } = parsed.data;
    const instance = this.instance(owner, id);
    const snapshot = instance.snapshot;
    if (revision !== snapshot.revision || instance.busy)
      throw new CeremonyError(
        "This action is stale. Refresh the ceremony.",
        409,
      );
    if (!snapshot.actions.includes(action))
      throw new CeremonyError("Action is not allowed in this step", 409);
    if (action !== "submit" && Object.keys(values).length)
      throw new CeremonyError("This action does not accept fields");
    if (secretRef && (action !== "submit" || Object.keys(values).length))
      throw new CeremonyError(
        "Reference binding does not accept inline values",
      );
    switch (action) {
      case "request-human":
        if (!instance.adapter.requestHuman)
          throw new CeremonyError("Human delivery is not configured", 503);
        instance.busy = true;
        try {
          this.update(instance, await instance.adapter.requestHuman());
        } finally {
          instance.busy = false;
        }
        break;
      case "begin":
        await this.run(instance, () => instance.adapter.begin());
        break;
      case "submit": {
        let validated: Record<string, string>;
        try {
          if (
            (this.options.broker || snapshot.method.kind === "github-app") &&
            snapshot.fields.some((field) => field.type === "password") &&
            !secretRef
          )
            throw new CeremonyError(
              "Use private credential collection and submit its reference",
            );
          validated = validateInput(
            snapshot.fields,
            secretRef
              ? (this.options.broker?.consume(owner, id, revision, secretRef) ??
                  (() => {
                    throw new CeremonyError("Private collection unavailable");
                  })())
              : values,
          );
        } catch (error) {
          throw new CeremonyError(
            error instanceof Error ? error.message : "Invalid fields",
          );
        }
        await this.run(instance, () =>
          instance.adapter.submit(validated, snapshot.step === "claim"),
        );
        break;
      }
      case "claim":
        this.update(instance, {
          step: "claim",
          expiresAt: this.now() + 600_000,
        });
        break;
      case "finish":
        this.update(instance, { step: "complete" });
        break;
      case "retry": {
        if (instance.adapter.retry) {
          await this.run(instance, () => instance.adapter.retry!());
          break;
        }
        instance.adapter.cancel();
        const registration = this.registrations.get(snapshot.connectorId);
        if (!registration)
          throw new CeremonyError("Connector is unavailable", 404);
        instance.adapter = registration.createAdapter({
          instanceId: id,
          method: snapshot.method,
          owner: instance.owner,
        });
        const step = ["basic", "api-key", "form"].includes(snapshot.method.kind)
          ? "input"
          : "intro";
        this.update(instance, {
          step,
          expiresAt: this.now() + 600_000,
          ...instance.adapter.initial?.(),
        });
        break;
      }
      case "cancel":
        instance.adapter.cancel();
        this.update(instance, {
          step:
            snapshot.outcome?.ownership === "anonymous" &&
            snapshot.step !== "anonymous"
              ? "anonymous"
              : "cancelled",
        });
        break;
    }
    return structuredClone(instance.snapshot);
  }
  async callback(
    owner: string,
    id: string,
    url: URL,
  ): Promise<CeremonySnapshot> {
    const lease = this.options.database?.acquire(`instance:${id}`);
    try {
      return await this.callbackLocked(owner, id, url);
    } finally {
      if (lease) this.options.database?.release(`instance:${id}`, lease);
    }
  }
  private async callbackLocked(
    owner: string,
    id: string,
    url: URL,
  ): Promise<CeremonySnapshot> {
    const instance = this.instance(owner, id);
    if (instance.snapshot.step !== "redirect" || instance.busy)
      throw new CeremonyError("Callback is stale or already consumed", 409);
    await this.run(instance, () => instance.adapter.callback(url));
    return structuredClone(instance.snapshot);
  }
  private async run(
    instance: Instance,
    operation: () => Promise<AdapterUpdate | undefined>,
  ): Promise<void> {
    instance.busy = true;
    try {
      const update = await operation();
      // A concurrent read may have expired the instance while the provider was responding.
      if (update && instance.snapshot.step !== "expired")
        this.update(instance, update);
    } catch (error) {
      if (
        instance.snapshot.step === "waiting" &&
        !(error instanceof CeremonyError)
      ) {
        const current = instance.snapshot;
        this.update(instance, {
          step: "waiting",
          ...(current.verificationUri
            ? { verificationUri: current.verificationUri }
            : {}),
          ...(current.userCode ? { userCode: current.userCode } : {}),
          message:
            "Could not reach the provider. Checking again until this attempt expires.",
        });
      } else if (instance.snapshot.step !== "expired")
        this.update(instance, {
          step: "error",
          message:
            error instanceof CeremonyError
              ? error.message
              : "Authentication could not be completed. Please retry.",
        });
    } finally {
      instance.busy = false;
    }
  }
  sweep(): void {
    for (const instance of this.store.values()) {
      if (
        instance.snapshot.expiresAt + 3_600_000 < this.now() &&
        !instance.busy
      ) {
        instance.adapter.cancel();
        this.store.delete(instance.snapshot.id);
      }
    }
  }
}
