import { randomBytes } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { createPrivateKey } from "node:crypto";
import { z } from "zod";
import { manifestSchema, type CeremonySnapshot } from "../core/index.js";
import {
  CeremonyError,
  type AdapterContext,
  type AdapterUpdate,
  type AuthAdapter,
} from "./controller.js";
import { CeremonyDatabase } from "./storage.js";

export const githubAppManifest = manifestSchema.parse({
  id: "github",
  name: "GitHub",
  description:
    "Register or reuse a GitHub App, approve its installation, then verify repository access.",
  methods: [
    {
      id: "github-app",
      label: "GitHub App · installation access",
      kind: "github-app",
      fields: [],
      scopes: ["contents:read"],
      templateId: "github-app",
    },
  ],
});
const appSchema = z.object({
  id: z.number().int().positive(),
  slug: z.string().regex(/^[a-zA-Z0-9-]+$/),
  pem: z.string().max(30_000),
  owner: z.object({ login: z.string() }),
});
export type GitHubAppConfiguration = z.infer<typeof appSchema>;
const stateSchema = z.object({
  owner: z.string(),
  phase: z.enum([
    "prepare",
    "register",
    "converting",
    "install",
    "verify",
    "complete",
    "cancelled",
    "uncertain",
  ]),
  nonce: z.string(),
  expiresAt: z.number(),
  app: appSchema.optional(),
  installationId: z.number().int().positive().optional(),
  connectionRef: z.string().optional(),
});
type GitHubState = z.infer<typeof stateSchema>;
export interface GitHubOptions {
  origin: string;
  /** Shared host configuration is server-only and never accepted as tool arguments. */
  app?: GitHubAppConfiguration;
  resolveApp?(owner: string): GitHubAppConfiguration | undefined;
  expectedAccount?: string;
  fetch?: typeof fetch;
  cancelHuman?(instanceId: string): void;
  requestHuman?(request: {
    owner: string;
    instanceId: string;
    url: string;
  }): Promise<void>;
}
/** Fixed registration scenario. No page content, screenshots or scripts enter model context. */
export const githubRegistrationScenario = {
  id: "github-app-registration.v1",
  allowedOrigins: ["https://github.com"],
  effects: ["Create a GitHub App with read-only repository contents access"],
  capture: "none",
  humanFallback: "provider-approval",
  verifier: "github-manifest-conversion-and-app-signature",
} as const;

export class GitHubAppCeremonies {
  private readonly origin: string;
  private readonly fetcher: typeof fetch;
  constructor(
    private readonly db: CeremonyDatabase,
    private readonly options: GitHubOptions,
  ) {
    const url = new URL(options.origin);
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost"].includes(url.hostname)
        ))
    )
      throw new Error(
        "A trusted HTTPS callback origin (or local development origin) is required",
      );
    if (options.app && !options.expectedAccount)
      throw new Error(
        "Shared GitHub Apps require an expected installation account",
      );
    this.origin = url.origin;
    this.fetcher = options.fetch ?? fetch;
  }
  private key(id: string) {
    return `github:${id}`;
  }
  private state(id: string): GitHubState {
    const state = this.db.get(this.key(id), stateSchema);
    if (!state) throw new CeremonyError("GitHub ceremony not found", 404);
    return state;
  }
  private save(id: string, state: GitHubState) {
    this.db.put(this.key(id), state);
  }
  resume(owner: string): string | undefined {
    for (const key of this.db.keys("github:")) {
      const state = this.db.get(key, stateSchema)!;
      if (
        state.owner === owner &&
        (["converting", "verify", "uncertain"].includes(state.phase) ||
          (state.phase !== "cancelled" && state.expiresAt > Date.now()))
      )
        return key.slice("github:".length);
    }
    return undefined;
  }
  callbackOwner(id: string, nonce: string): string {
    const state = this.state(id);
    if (
      !nonce ||
      nonce !== state.nonce ||
      state.expiresAt <= Date.now() ||
      !["register", "install"].includes(state.phase)
    )
      throw new CeremonyError(
        "This GitHub return link is invalid or expired",
        409,
      );
    return state.owner;
  }
  /** Only serve inside an authenticated human route, never as a model tool result. */
  destination(owner: string, id: string) {
    const state = this.state(id);
    if (state.owner !== owner || state.expiresAt <= Date.now())
      throw new CeremonyError("Handoff unavailable", 404);
    if (state.phase === "register") {
      return {
        kind: "manifest" as const,
        url: `https://github.com/settings/apps/new?state=${state.nonce}`,
        manifest: {
          name: `Ceremony repositories ${id.slice(0, 8)}`,
          url: this.origin,
          redirect_url: `${this.origin}/api/live/github/${id}/callback`,
          setup_url: `${this.origin}/api/live/github/${id}/callback`,
          public: false,
          // GitHub requires a URL even for an explicitly inactive webhook.
          hook_attributes: { url: this.origin, active: false },
          default_permissions: { contents: "read" },
          default_events: [],
        },
      };
    }
    if (state.phase === "install" && state.app)
      return {
        kind: "installation" as const,
        url: `https://github.com/apps/${state.app.slug}/installations/new?state=${state.nonce}`,
      };
    throw new CeremonyError("No human action is pending", 409);
  }
  private async api(
    path: string,
    authorization?: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.fetcher(`https://api.github.com${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "ceremony-auth",
        ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok)
      throw new CeremonyError(
        "GitHub could not verify this step. Check account permissions and retry.",
        502,
      );
    return response.json();
  }
  private async jwt(app: GitHubAppConfiguration): Promise<string> {
    // GitHub returns PKCS#1 PEM; normalize using Node instead of copying key material to a UI.
    const pem = createPrivateKey(app.pem)
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(String(app.id))
      .setIssuedAt(Math.floor(Date.now() / 1000) - 60)
      .setExpirationTime("5m")
      .sign(await importPKCS8(pem, "RS256"));
  }
  private async verifyApp(app: GitHubAppConfiguration): Promise<void> {
    const checked = z
      .object({
        id: z.number(),
        slug: z.string(),
        owner: z.object({ login: z.string() }),
        permissions: z.record(z.string(), z.string()),
      })
      .parse(await this.api("/app", await this.jwt(app)));
    if (
      checked.id !== app.id ||
      checked.slug !== app.slug ||
      checked.owner.login.toLowerCase() !== app.owner.login.toLowerCase() ||
      !["read", "write"].includes(checked.permissions.contents ?? "")
    )
      throw new CeremonyError(
        "GitHub App identity or required permissions do not match",
        409,
      );
  }
  private project(id: string, state: GitHubState): AdapterUpdate {
    const configured = !!state.app;
    const complete = state.phase === "complete";
    const prerequisites: NonNullable<CeremonySnapshot["prerequisites"]> = [
      {
        id: "registration",
        label: "Prepare GitHub App",
        status: configured
          ? "succeeded"
          : state.phase === "prepare"
            ? "ready"
            : state.phase === "register"
              ? "awaiting-human"
              : "failed",
      },
      {
        id: "installation",
        label: "Approve repository access",
        status: complete
          ? "succeeded"
          : state.phase === "install"
            ? "awaiting-human"
            : "blocked",
      },
      {
        id: "signing",
        label: "Verify installation access",
        status: complete ? "succeeded" : "blocked",
      },
    ];
    if (complete && state.connectionRef)
      return {
        step: "complete",
        prerequisites,
        expiresAt: state.expiresAt,
        outcome: {
          connectionRef: state.connectionRef,
          ownership: "authenticated",
          scopes: ["contents:read"],
        },
      };
    if (["uncertain", "converting", "verify"].includes(state.phase))
      return {
        step: "input",
        fields: [
          {
            name: "appId",
            label: "Existing GitHub App ID",
            type: "text",
            required: true,
          },
          {
            name: "privateKey",
            label: "GitHub App private key (PEM)",
            type: "password",
            required: true,
          },
        ],
        prerequisites,
        message:
          "Registration or verification was interrupted. Do not create another app. An owner can recover the existing app using its ID and a private key from GitHub App settings. These values go directly to the private collector.",
        expiresAt: state.expiresAt,
      };
    if (state.phase === "cancelled")
      return { step: "cancelled", prerequisites };
    if (state.phase === "prepare")
      return {
        step: "intro",
        prerequisites,
        message:
          "We’ll reuse your app if configured. Otherwise, an owner approves its creation on GitHub. Credentials stay on the server.",
      };
    return {
      step: "redirect",
      prerequisites,
      expiresAt: state.expiresAt,
      authorizationUrl: `${this.origin}/api/live/github/${id}/human`,
      message: configured
        ? "Your app is ready. Choose the account and repositories it may access on GitHub."
        : "GitHub needs an app first. Review its creation, then approve repository access in the same guided session.",
    };
  }
  createAdapter(context: AdapterContext): AuthAdapter {
    const { instanceId: id, owner } = context;
    let state = this.db.get(this.key(id), stateSchema);
    if (state && state.owner !== owner)
      throw new CeremonyError("GitHub ceremony not found", 404);
    if (!state || state.phase === "prepare") {
      const app =
        state?.app ??
        this.options.resolveApp?.(owner) ??
        this.options.app ??
        this.db.get(`github-app:${owner}:${this.origin}`, appSchema);
      state = {
        owner,
        phase: app ? "install" : "register",
        ...(app ? { app } : {}),
        nonce: randomBytes(32).toString("base64url"),
        expiresAt: Date.now() + 3_600_000,
      };
      this.save(id, state);
    }
    if (state.owner !== owner)
      throw new CeremonyError("GitHub ceremony not found", 404);
    const current = () => this.state(id);
    return {
      ...(this.options.requestHuman
        ? {
            requestHuman: async () => {
              const state = current();
              if (
                ![
                  "register",
                  "install",
                  "uncertain",
                  "converting",
                  "verify",
                ].includes(state.phase)
              )
                throw new CeremonyError("No human step is pending", 409);
              await this.options.requestHuman!({
                owner,
                instanceId: id,
                url: ["register", "install"].includes(state.phase)
                  ? `${this.origin}/api/live/github/${id}/human`
                  : `${this.origin}/api/live/ceremonies/${id}/collector`,
              });
              return {
                ...this.project(id, state),
                message:
                  "Human assistance requested. This ceremony remains blocked until GitHub verifies the result. You can also continue in your own browser.",
              };
            },
          }
        : {}),
      initial: () => this.project(id, current()),
      retry: async () => {
        const state = current();
        if (!["converting", "uncertain", "verify"].includes(state.phase))
          state.phase = state.app ? "install" : "register";
        state.nonce = randomBytes(32).toString("base64url");
        state.expiresAt = Date.now() + 3_600_000;
        this.save(id, state);
        return { ...this.project(id, state), expiresAt: state.expiresAt };
      },
      begin: async () => {
        const next = current();
        if (["converting", "uncertain", "verify"].includes(next.phase))
          throw new CeremonyError(
            "Reconcile the previous provider operation before retrying",
            409,
          );
        if (next.phase === "complete") return this.project(id, next);
        const app =
          next.app ??
          this.options.resolveApp?.(owner) ??
          this.options.app ??
          this.db.get(`github-app:${owner}:${this.origin}`, appSchema);
        if (app) {
          await this.verifyApp(app);
          next.app = app;
        }
        next.phase = app ? "install" : "register";
        next.nonce = randomBytes(32).toString("base64url");
        next.expiresAt = Date.now() + 3_600_000;
        this.save(id, next);
        return this.project(id, next);
      },
      submit: async (values) => {
        const state = current();
        if (!["uncertain", "converting", "verify"].includes(state.phase))
          throw new CeremonyError("App recovery is not pending", 409);
        const input = z
          .object({
            appId: z.coerce.number().int().positive(),
            privateKey: z.string().min(1).max(4096),
          })
          .strict()
          .parse(values);
        // Native masked single-line inputs strip line breaks when PEM is pasted.
        const pem = input.privateKey
          .replace(/(-----BEGIN (?:RSA )?PRIVATE KEY-----)\s*/, "$1\n")
          .replace(/\s*(-----END (?:RSA )?PRIVATE KEY-----)/, "\n$1");
        const app = z
          .object({
            id: z.number().int().positive(),
            slug: z.string().regex(/^[a-zA-Z0-9-]+$/),
            owner: z.object({ login: z.string() }),
            permissions: z.record(z.string(), z.string()),
          })
          .parse(
            await this.api(
              "/app",
              await this.jwt({
                id: input.appId,
                pem,
                slug: "pending",
                owner: { login: "pending" },
              }),
            ),
          );
        if (
          app.id !== input.appId ||
          !["read", "write"].includes(app.permissions.contents ?? "") ||
          (this.options.expectedAccount &&
            app.owner.login.toLowerCase() !==
              this.options.expectedAccount.toLowerCase())
        )
          throw new CeremonyError(
            "Recovered app identity or permissions do not match",
            409,
          );
        state.app = { id: app.id, slug: app.slug, owner: app.owner, pem };
        state.phase = "install";
        state.nonce = randomBytes(32).toString("base64url");
        state.expiresAt = Date.now() + 3_600_000;
        this.db.transaction(() => {
          this.db.put(`github-app:${owner}:${this.origin}`, state.app);
          this.save(id, state);
        });
        return this.project(id, state);
      },
      callback: async (url) => {
        const next = current();
        this.callbackOwner(id, url.searchParams.get("state") ?? "");
        if (
          url.origin !== this.origin ||
          url.pathname !== `/api/live/github/${id}/callback`
        )
          throw new CeremonyError("Wrong callback destination", 400);
        if (next.phase === "register") {
          const code = z
            .string()
            .regex(/^[a-zA-Z0-9_-]{1,200}$/)
            .parse(url.searchParams.get("code"));
          next.phase = "converting";
          this.save(id, next); // Never blindly repeat this one-shot external operation after a crash.
          try {
            const app = appSchema.parse(
              await this.api(
                `/app-manifests/${code}/conversions`,
                undefined,
                {},
              ),
            );
            next.app = app;
            this.save(id, next); // Recover private credentials even if the following verification fails.
            await this.verifyApp(app);
            if (
              this.options.expectedAccount &&
              app.owner.login.toLowerCase() !==
                this.options.expectedAccount.toLowerCase()
            )
              throw new CeremonyError(
                "App was created under the wrong owner",
                409,
              );
            this.db.put(`github-app:${owner}:${this.origin}`, app);
            next.phase = "install";
            next.nonce = randomBytes(32).toString("base64url");
            this.save(id, next);
            return this.project(id, next);
          } catch {
            next.phase = "uncertain";
            this.save(id, next);
            return this.project(id, next);
          }
        }
        if (!next.app)
          throw new CeremonyError(
            "App registration is required before signing",
            409,
          );
        await this.verifyApp(next.app);
        const installationId = z.coerce
          .number()
          .int()
          .positive()
          .parse(url.searchParams.get("installation_id"));
        const jwt = await this.jwt(next.app);
        const installation = z
          .object({
            id: z.number(),
            app_id: z.number(),
            account: z.object({ login: z.string() }),
            suspended_at: z.string().nullable(),
          })
          .parse(await this.api(`/app/installations/${installationId}`, jwt));
        const expected = this.options.expectedAccount ?? next.app.owner.login;
        if (
          installation.id !== installationId ||
          installation.app_id !== next.app.id ||
          installation.account.login.toLowerCase() !== expected.toLowerCase() ||
          installation.suspended_at
        )
          throw new CeremonyError(
            "Installation does not match the expected GitHub account and app",
            409,
          );
        next.phase = "verify";
        next.installationId = installationId;
        this.save(id, next);
        try {
          const token = z
            .object({
              token: z.string().min(1),
              expires_at: z.iso.datetime(),
              permissions: z.object({ contents: z.literal("read") }),
            })
            .parse(
              await this.api(
                `/app/installations/${installationId}/access_tokens`,
                jwt,
                { permissions: { contents: "read" } },
              ),
            );
          z.object({
            total_count: z.number().int().nonnegative(),
            repositories: z.array(z.object({ id: z.number() })),
          }).parse(
            await this.api(
              "/installation/repositories?per_page=1",
              token.token,
            ),
          );
          next.connectionRef = randomBytes(24).toString("base64url");
          next.expiresAt = Date.parse(token.expires_at);
          if (next.expiresAt <= Date.now())
            throw new Error("Expired provider token");
          this.db.transaction(() => {
            this.db.put(`connection:${next.connectionRef}`, {
              owner,
              provider: "github",
              appId: next.app!.id,
              installationId,
              account: expected,
              token: token.token,
              expiresAt: next.expiresAt,
            });
            next.phase = "complete";
            this.save(id, next);
          });
          return this.project(id, next);
        } catch {
          next.phase = "uncertain";
          this.save(id, next);
          return this.project(id, next);
        }
      },
      poll: async () => this.project(id, current()),
      cancel: () => {
        this.options.cancelHuman?.(id);
        const next = current();
        // Preserve uncertain effects: cancelling is not permission to create another app.
        if (
          !["converting", "verify", "uncertain", "complete"].includes(
            next.phase,
          )
        ) {
          next.phase = "cancelled";
          this.save(id, next);
        }
      },
    };
  }
}
