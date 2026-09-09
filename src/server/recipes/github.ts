import { createHash, randomBytes } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { request } from "@octokit/request";
import { z } from "zod";
import {
  PersistenceConflict,
  type AsyncCeremonyStore,
  type RecordKey,
} from "../persistence/index.js";
import type { GitHubAppConfiguration } from "../github.js";
import {
  OperationRegistry,
  type OperationContext,
  type OperationResult,
  type VocabularyEntry,
} from "./registry.js";

const appSchema = z.object({
  id: z.number().int().positive(),
  slug: z.string().regex(/^[a-zA-Z0-9-]+$/),
  pem: z.string().min(1).max(30000),
  owner: z.object({ login: z.string().min(1).max(100) }),
});
type App = z.infer<typeof appSchema>;
type State = {
  scope: string;
  phase:
    | "registration"
    | "converting"
    | "app-ready"
    | "installation"
    | "installed"
    | "complete"
    | "cancelled"
    | "uncertain";
  nonce: string;
  expires: number;
  app?: App;
  installation?: number;
  sharedSetup?: string;
  subscribers?: string[];
  handoffIssued?: boolean;
  restartable?: boolean;
};
type Artifact = {
  scope: string;
  kind: "app" | "installation" | "connection";
  expires: number;
  app: App;
  installation?: number;
  token?: string;
};
const slot = (contract: string) => ({ contract, required: true });
export const githubVocabulary = new Map<string, VocabularyEntry>(
  ["app", "installation", "connection"].map((kind) => [
    `github.${kind}`,
    {
      schema: z.string().regex(/^github-[a-f0-9]{64}$/),
      classification: "artifact",
      provider: "github",
      profile: "github-app",
    },
  ]),
);
export type AsyncGitHubOptions = {
  origin: string;
  environment: string;
  configurationVersion: string;
  expectedAccount?: string;
  app?: GitHubAppConfiguration;
  fetch?: typeof fetch;
  /** Must recheck live host/delegation policy, including cancellation, at each consequential boundary. */
  authorize(context: OperationContext): Promise<void>;
};

/** Registered children use the same official manifest, app JWT and installation APIs as the legacy adapter. */
export class AsyncGitHubChildren {
  constructor(
    private readonly store: AsyncCeremonyStore,
    private readonly options: AsyncGitHubOptions,
  ) {
    const url = new URL(options.origin);
    if (
      url.origin !== options.origin ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
      (options.expectedAccount !== undefined &&
        !/^[a-zA-Z0-9-]{1,100}$/.test(options.expectedAccount))
    )
      throw new Error("Invalid trusted GitHub configuration");
    if (options.app) appSchema.parse(options.app);
  }
  private scope(context: OperationContext): string {
    if (
      context.origin !== this.options.origin ||
      context.environment !== this.options.environment ||
      context.configurationVersion !== this.options.configurationVersion ||
      !/^[a-zA-Z0-9-]{1,100}$/.test(context.target) ||
      (this.options.expectedAccount !== undefined &&
        context.target.toLowerCase() !==
          this.options.expectedAccount.toLowerCase())
    )
      throw new Error("GitHub context unavailable");
    return createHash("sha256")
      .update(
        JSON.stringify([
          context.actor.tenantId,
          context.actor.subjectId,
          "github",
          "github-app",
          context.origin,
          context.environment,
          context.configurationVersion,
          context.target.toLowerCase(),
          "contents:read",
          this.options.app?.id ?? null,
        ]),
      )
      .digest("hex");
  }
  private key(context: OperationContext): RecordKey {
    return {
      tenant: context.actor.tenantId,
      kind: "handoff",
      id: `github:${context.runId}`,
    };
  }
  private setupKey(context: OperationContext): RecordKey {
    return {
      tenant: context.actor.tenantId,
      kind: "handoff",
      id: `github-setup:${this.scope(context)}`,
    };
  }
  private artifactKey(
    context: OperationContext,
    kind: Artifact["kind"],
  ): RecordKey {
    return {
      tenant: context.actor.tenantId,
      kind: "artifact",
      id: `github-${createHash("sha256")
        .update(`${this.scope(context)}:${kind}`)
        .digest("hex")}`,
    };
  }
  private async read(context: OperationContext) {
    await this.options.authorize(context);
    const record = await this.store.transaction(async (tx) => {
      const local = await tx.get<State>(this.key(context));
      if (local?.value.sharedSetup && local.value.phase !== "cancelled") {
        const shared = await tx.get<State>(this.setupKey(context));
        if (!shared?.value.subscribers?.includes(context.runId))
          throw new Error("GitHub subscription unavailable");
        return shared;
      }
      return local;
    });
    if (!record || record.value.scope !== this.scope(context))
      throw new Error("GitHub handoff unavailable");
    return record;
  }
  private async api(
    context: OperationContext,
    path: string,
    token?: string,
    body?: unknown,
  ): Promise<unknown> {
    await this.options.authorize(context);
    try {
      return (
        await request(`https://api.github.com${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          ...(body === undefined ? {} : { data: body }),
          request: {
            fetch: this.options.fetch ?? fetch,
            redirect: "error",
            signal: AbortSignal.any([
              context.signal,
              AbortSignal.timeout(15000),
            ]),
          },
        })
      ).data;
    } catch {
      throw new Error("GitHub verification unavailable");
    }
  }
  private async jwt(app: App) {
    return (
      await createAppAuth({ appId: String(app.id), privateKey: app.pem })({
        type: "app",
      })
    ).token;
  }
  private async verifyApp(context: OperationContext, app: App) {
    const checked = z
      .object({
        id: z.number(),
        slug: z.string(),
        owner: z.object({ login: z.string() }),
        permissions: z.record(z.string(), z.string()),
      })
      .parse(await this.api(context, "/app", await this.jwt(app)));
    if (
      checked.id !== app.id ||
      checked.slug !== app.slug ||
      checked.owner.login.toLowerCase() !== app.owner.login.toLowerCase() ||
      checked.owner.login.toLowerCase() !== context.target.toLowerCase() ||
      !["read", "write"].includes(checked.permissions.contents ?? "")
    )
      throw new Error("GitHub app verification rejected");
  }
  private async artifact(
    context: OperationContext,
    kind: Artifact["kind"],
    supplied?: unknown,
  ): Promise<Artifact | undefined> {
    const key = this.artifactKey(context, kind);
    if (supplied !== undefined && supplied !== key.id)
      throw new Error("GitHub artifact unavailable");
    return this.store.transaction(async (tx) => {
      const record = await tx.get<Artifact>(key);
      return record &&
        record.value.scope === this.scope(context) &&
        record.value.kind === kind &&
        record.value.expires > (await tx.now())
        ? record.value
        : undefined;
    });
  }
  private async saveArtifact(context: OperationContext, value: Artifact) {
    await this.options.authorize(context);
    const key = this.artifactKey(context, value.kind);
    await this.store.transaction(async (tx) => {
      const state = await tx.get<State>(this.key(context));
      if (state?.value.phase === "cancelled")
        throw new Error("GitHub run cancelled");
      const old = await tx.get(key);
      await tx.put(key, value, old?.revision ?? null);
    });
    return key.id;
  }
  private result(kind: Artifact["kind"], id: string): OperationResult {
    return { state: "complete", outputs: { [kind]: id } };
  }
  register(registry: OperationRegistry) {
    const operations = [
      {
        id: "prepare-app",
        kind: "app" as const,
        input: undefined,
        handler: (context: OperationContext) => this.prepare(context),
      },
      {
        id: "authorize-installation",
        kind: "installation" as const,
        input: "app" as const,
        handler: (context: OperationContext, inputs: Record<string, unknown>) =>
          this.install(context, inputs.app),
      },
      {
        id: "verify-access",
        kind: "connection" as const,
        input: "installation" as const,
        handler: (context: OperationContext, inputs: Record<string, unknown>) =>
          this.verifyAccess(context, inputs.installation),
      },
    ];
    for (const operation of operations)
      registry.register({
        contract: {
          id: `github.${operation.id}`,
          version: "1.0.0",
          provider: "github",
          profile: "github-app",
          inputs: operation.input
            ? { [operation.input]: slot(`github.${operation.input}`) }
            : {},
          outputs: { [operation.kind]: slot(`github.${operation.kind}`) },
          effects: [`github.${operation.id}`],
          verifier: `github.verify-${operation.kind}`,
          humanFallback: "github.own-browser",
        },
        inputSchema: z
          .object(operation.input ? { [operation.input]: z.string() } : {})
          .strict(),
        outputSchema: z.object({ [operation.kind]: z.string() }).strict(),
        classifications: {},
        fixtures: ["tests/github-children.test.ts"],
        handler: operation.handler,
        verify: async (context, result) => {
          if (result.state !== "complete") return false;
          const artifact = await this.artifact(
            context,
            operation.kind,
            result.outputs[operation.kind],
          );
          if (!artifact) return false;
          await this.verifyApp(context, artifact.app);
          if (artifact.installation)
            await this.checkInstallation(
              context,
              artifact.app,
              artifact.installation,
            );
          if (operation.kind === "connection") {
            if (!artifact.token) return false;
            z.object({
              total_count: z.number().int().nonnegative(),
              repositories: z.array(z.object({ id: z.number() })),
            }).parse(
              await this.api(
                context,
                "/installation/repositories?per_page=1",
                artifact.token,
              ),
            );
          }
          return true;
        },
      });
  }
  async prepare(
    context: OperationContext,
    admissionAttempt = 0,
  ): Promise<OperationResult> {
    await this.options.authorize(context);
    let app = (await this.artifact(context, "app"))?.app ?? this.options.app;
    const previous = await this.store.transaction(async (tx) => {
      const local = await tx.get<State>(this.key(context));
      return local?.value.sharedSetup && local.value.phase !== "cancelled"
        ? await tx.get<State>(this.setupKey(context))
        : local;
    });
    if (previous && previous.value.scope !== this.scope(context))
      throw new Error("GitHub context changed");
    if (previous?.value.phase === "cancelled")
      throw new Error("GitHub run cancelled");
    app ??= previous?.value.app;
    if (app) {
      await this.verifyApp(context, app);
      const id = await this.saveArtifact(context, {
        scope: this.scope(context),
        kind: "app",
        app,
        expires: Date.now() + 3600000,
      });
      return this.result("app", id);
    }
    if (previous)
      return {
        state: ["converting", "uncertain"].includes(previous.value.phase)
          ? "uncertain"
          : "awaiting-human",
        outputs: {},
      };
    try {
      await this.store.transaction(async (tx) => {
        const existingLocal = await tx.get<State>(this.key(context));
        if (existingLocal?.value.phase === "cancelled")
          throw new Error("GitHub run cancelled");
        const setupKey = this.setupKey(context);
        const existing = await tx.get<State>(setupKey);
        if (
          existing?.value.phase === "cancelled" &&
          !existing.value.restartable
        )
          throw new Error("GitHub setup requires reconciliation");
        const subscribers = Array.from(
          new Set([...(existing?.value.subscribers ?? []), context.runId]),
        );
        if (subscribers.length > 32)
          throw new Error("GitHub setup subscriber limit");
        const shared: State = (existing?.value.phase !== "cancelled"
          ? existing?.value
          : undefined) ?? {
          scope: this.scope(context),
          phase: "registration",
          nonce: randomBytes(32).toString("base64url"),
          expires: (await tx.now()) + 3600000,
        };
        await tx.put(
          setupKey,
          { ...shared, subscribers },
          existing?.revision ?? null,
        );
        await tx.put(
          this.key(context),
          {
            ...shared,
            sharedSetup: setupKey.id,
          },
          existingLocal?.revision ?? null,
        );
      });
    } catch (error) {
      if (error instanceof PersistenceConflict && admissionAttempt < 2)
        return this.prepare(context, admissionAttempt + 1);
      throw error;
    }
    return { state: "awaiting-human", outputs: {} };
  }
  async install(
    context: OperationContext,
    appRef: unknown,
  ): Promise<OperationResult> {
    await this.options.authorize(context);
    const app = await this.artifact(context, "app", appRef);
    if (!app) throw new Error("Verified app prerequisite unavailable");
    await this.verifyApp(context, app.app);
    const installed = await this.artifact(context, "installation");
    if (installed)
      return this.result(
        "installation",
        this.artifactKey(context, "installation").id,
      );
    await this.store.transaction(async (tx) => {
      const previous = await tx.get<State>(this.key(context));
      if (
        previous?.value.scope !== undefined &&
        previous.value.scope !== this.scope(context)
      )
        throw new Error("GitHub context changed");
      if (previous?.value.phase === "cancelled")
        throw new Error("GitHub run cancelled");
      if (
        previous?.value.phase === "installation" &&
        previous.value.expires > (await tx.now())
      )
        return;
      await tx.put(
        this.key(context),
        {
          scope: this.scope(context),
          phase: "installation",
          app: app.app,
          nonce: randomBytes(32).toString("base64url"),
          expires: (await tx.now()) + 3600000,
        },
        previous?.revision ?? null,
      );
    });
    return { state: "awaiting-human", outputs: {} };
  }
  /** Only the authenticated human route may render this projection; never serialize it into model/tool state. */
  async human(context: OperationContext) {
    const { value: state } = await this.read(context);
    if (state.expires <= Date.now()) throw new Error("GitHub handoff expired");
    const callback = `${this.options.origin}/api/v1/teaching/github/${encodeURIComponent(context.runId)}/callback`;
    if (state.phase === "registration") {
      await this.store.transaction(async (tx) => {
        const local = await tx.get<State>(this.key(context));
        if (local?.value.phase === "cancelled")
          throw new Error("GitHub run cancelled");
        const key = local?.value.sharedSetup
          ? this.setupKey(context)
          : this.key(context);
        const current = await tx.get<State>(key);
        if (
          !current ||
          current.value.phase !== "registration" ||
          current.value.nonce !== state.nonce
        )
          throw new Error("GitHub handoff unavailable");
        await tx.put(
          key,
          { ...current.value, handoffIssued: true },
          current.revision,
        );
      });
      return {
        method: "POST" as const,
        url: `https://github.com/settings/apps/new?state=${encodeURIComponent(state.nonce)}`,
        manifest: {
          name: "Ceremony connection",
          url: this.options.origin,
          redirect_url: callback,
          callback_urls: [callback],
          public: false,
          hook_attributes: { url: this.options.origin, active: false },
          default_permissions: { contents: "read" },
          default_events: [],
        },
      };
    }
    if (state.phase === "installation" && state.app)
      return {
        method: "GET" as const,
        url: `https://github.com/apps/${state.app.slug}/installations/new?state=${encodeURIComponent(state.nonce)}`,
      };
    throw new Error("GitHub human action unavailable");
  }
  /** Server-only callback routing: a cancelled parent grants nothing; a surviving subscriber is authorized afresh. */
  async activeSetupSubscriber(
    context: OperationContext,
    url: URL,
  ): Promise<string> {
    const setupKey = this.setupKey(context);
    const candidates = await this.store.transaction(async (tx) => {
      const local = await tx.get<State>(this.key(context));
      const shared = await tx.get<State>(setupKey);
      if (
        local?.value.sharedSetup !== setupKey.id ||
        local.value.scope !== this.scope(context) ||
        !shared ||
        shared.value.phase !== "registration" ||
        shared.value.expires <= (await tx.now()) ||
        shared.value.nonce !== url.searchParams.get("state") ||
        url.origin !== this.options.origin ||
        url.pathname !==
          `/api/v1/teaching/github/${encodeURIComponent(context.runId)}/callback`
      )
        throw new Error("GitHub callback unavailable");
      return shared.value.subscribers ?? [];
    });
    for (const runId of candidates) {
      const next = { ...context, runId };
      try {
        await this.options.authorize(next);
        const local = await this.store.transaction((tx) =>
          tx.get<State>(this.key(next)),
        );
        if (
          local?.value.phase !== "cancelled" &&
          local?.value.sharedSetup === setupKey.id
        )
          return runId;
      } catch {
        /* A revoked subscriber cannot inherit the callback. */
      }
    }
    throw new Error("GitHub callback unavailable");
  }
  async callback(context: OperationContext, url: URL): Promise<void> {
    const record = await this.read(context);
    const state = record.value;
    if (
      url.origin !== this.options.origin ||
      url.pathname !==
        `/api/v1/teaching/github/${encodeURIComponent(context.runId)}/callback` ||
      url.searchParams.get("state") !== state.nonce ||
      state.expires <= Date.now()
    )
      throw new Error("GitHub callback unavailable");
    if (state.phase === "registration") {
      const local = await this.store.transaction((tx) =>
        tx.get<State>(this.key(context)),
      );
      const callbackKey = local?.value.sharedSetup
        ? this.setupKey(context)
        : this.key(context);
      const code = z
        .string()
        .regex(/^[a-zA-Z0-9_-]{1,200}$/)
        .parse(url.searchParams.get("code"));
      const admitted = await this.store.transaction(async (tx) => {
        const fence = await tx.claim(
          callbackKey,
          `callback-${randomBytes(16).toString("hex")}`,
          60000,
        );
        const revision = await tx.put(
          callbackKey,
          { ...state, phase: "converting", nonce: "consumed" },
          record.revision,
        );
        return { fence, revision };
      });
      try {
        const app = appSchema.parse(
          await this.api(
            context,
            `/app-manifests/${code}/conversions`,
            undefined,
            {},
          ),
        );
        // Retain the one-shot conversion result before another external request.
        await this.store.transaction(async (tx) => {
          await tx.assertFence(admitted.fence);
          const current = (await tx.get<State>(callbackKey))!;
          return tx.put(
            callbackKey,
            { ...current.value, phase: "converting", nonce: "consumed", app },
            current.revision,
          );
        });
        await this.verifyApp(context, app);
        await this.options.authorize(context);
        await this.store.transaction(async (tx) => {
          await tx.assertFence(admitted.fence);
          const current = (await tx.get<State>(callbackKey))!;
          await tx.put(
            callbackKey,
            { ...current.value, phase: "app-ready", nonce: "consumed", app },
            current.revision,
          );
        });
      } catch {
        await this.store.transaction(async (tx) => {
          try {
            await tx.assertFence(admitted.fence);
          } catch {
            return;
          }
          const current = await tx.get<State>(callbackKey);
          if (current && current.value.phase !== "cancelled")
            await tx.put(
              callbackKey,
              { ...current.value, phase: "uncertain", nonce: "consumed" },
              current.revision,
            );
        });
        throw new Error("GitHub registration requires reconciliation");
      }
      return;
    }
    if (state.phase !== "installation" || !state.app)
      throw new Error("GitHub callback already consumed");
    const installation = z.coerce
      .number()
      .int()
      .positive()
      .parse(url.searchParams.get("installation_id"));
    await this.checkInstallation(context, state.app, installation);
    await this.options.authorize(context);
    await this.store.transaction((tx) =>
      tx.put(
        this.key(context),
        { ...state, phase: "installed", nonce: "consumed", installation },
        record.revision,
      ),
    );
    await this.saveArtifact(context, {
      scope: this.scope(context),
      kind: "installation",
      app: state.app,
      installation,
      expires: Date.now() + 3600000,
    });
  }
  /** Input is accepted only from a purpose-bound private collector, never from an agent tool. */
  async recover(context: OperationContext, input: unknown): Promise<void> {
    const record = await this.read(context);
    const local = await this.store.transaction((tx) =>
      tx.get<State>(this.key(context)),
    );
    const recoveryKey = local?.value.sharedSetup
      ? this.setupKey(context)
      : this.key(context);
    if (!["uncertain", "converting"].includes(record.value.phase))
      throw new Error("GitHub recovery unavailable");
    const values = z
      .object({
        appId: z.number().int().positive(),
        pem: z.string().min(1).max(30000),
      })
      .strict()
      .parse(input);
    const pending = {
      id: values.appId,
      pem: values.pem,
      slug: "pending",
      owner: { login: "pending" },
    };
    const identity = z
      .object({
        id: z.number().int().positive(),
        slug: z.string(),
        owner: z.object({ login: z.string() }),
      })
      .parse(await this.api(context, "/app", await this.jwt(pending)));
    const app = appSchema.parse({ ...identity, pem: values.pem });
    if (app.id !== values.appId) throw new Error("GitHub recovery rejected");
    await this.verifyApp(context, app);
    await this.options.authorize(context);
    await this.store.transaction(async (tx) => {
      await tx.cancel(recoveryKey);
      await tx.put(
        recoveryKey,
        { ...record.value, app, phase: "app-ready", nonce: "consumed" },
        record.revision,
      );
    });
  }

  /** Local cancellation fences callbacks; it does not revoke an upstream GitHub grant. */
  async cancel(context: OperationContext): Promise<void> {
    const scope = this.scope(context);
    await this.store.transaction(async (tx) => {
      const record = await tx.get<State>(this.key(context));
      if (record && record.value.scope !== scope)
        throw new Error("GitHub handoff unavailable");
      await tx.cancel(this.key(context));
      if (record?.value.sharedSetup) {
        const sharedKey = this.setupKey(context);
        const shared = await tx.get<State>(sharedKey);
        if (shared) {
          const subscribers = (shared.value.subscribers ?? []).filter(
            (id) => id !== context.runId,
          );
          if (!subscribers.length) await tx.cancel(sharedKey);
          await tx.put(
            sharedKey,
            {
              ...shared.value,
              subscribers,
              ...(!subscribers.length
                ? {
                    phase: "cancelled",
                    nonce: "cancelled",
                    restartable:
                      shared.value.phase === "registration" &&
                      !shared.value.handoffIssued,
                  }
                : {}),
            },
            shared.revision,
          );
        }
      }
      await tx.put(
        this.key(context),
        {
          ...(record?.value ?? { scope, expires: await tx.now() }),
          phase: "cancelled",
          nonce: "cancelled",
        },
        record?.revision ?? null,
      );
    });
  }
  private async checkInstallation(
    context: OperationContext,
    app: App,
    installation: number,
  ) {
    await this.verifyApp(context, app);
    const checked = z
      .object({
        id: z.number(),
        app_id: z.number(),
        account: z.object({ login: z.string() }),
        suspended_at: z.string().nullable(),
        permissions: z.record(z.string(), z.string()),
      })
      .parse(
        await this.api(
          context,
          `/app/installations/${installation}`,
          await this.jwt(app),
        ),
      );
    if (
      checked.id !== installation ||
      checked.app_id !== app.id ||
      checked.account.login.toLowerCase() !== context.target.toLowerCase() ||
      checked.suspended_at ||
      !["read", "write"].includes(checked.permissions.contents ?? "") ||
      Object.keys(checked.permissions).some(
        (key) => !["contents", "metadata"].includes(key),
      )
    )
      throw new Error("GitHub installation rejected");
  }
  async verifyAccess(
    context: OperationContext,
    installationRef: unknown,
  ): Promise<OperationResult> {
    await this.options.authorize(context);
    const installed = await this.artifact(
      context,
      "installation",
      installationRef,
    );
    if (!installed?.installation)
      throw new Error("Verified installation prerequisite unavailable");
    await this.checkInstallation(
      context,
      installed.app,
      installed.installation,
    );
    const existing = await this.artifact(context, "connection");
    if (existing?.token)
      return this.result(
        "connection",
        this.artifactKey(context, "connection").id,
      );
    const token = z
      .object({
        token: z.string().min(1),
        expires_at: z.iso.datetime(),
        permissions: z.object({ contents: z.literal("read") }),
      })
      .parse(
        await this.api(
          context,
          `/app/installations/${installed.installation}/access_tokens`,
          await this.jwt(installed.app),
          { permissions: { contents: "read" } },
        ),
      );
    z.object({
      total_count: z.number().int().nonnegative(),
      repositories: z.array(z.object({ id: z.number() })),
    }).parse(
      await this.api(
        context,
        "/installation/repositories?per_page=1",
        token.token,
      ),
    );
    if (Date.parse(token.expires_at) <= Date.now())
      throw new Error("GitHub access expired");
    const id = await this.saveArtifact(context, {
      ...installed,
      kind: "connection",
      token: token.token,
      expires: Date.parse(token.expires_at),
    });
    return this.result("connection", id);
  }
}
