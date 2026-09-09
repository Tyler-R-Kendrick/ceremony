import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  manifestSchema,
  outcomeSchema,
  snapshotSchema,
} from "../core/index.js";
import {
  CeremonyError,
  type AdapterUpdate,
  type ConnectorRegistration,
} from "./controller.js";
import { CeremonyDatabase } from "./storage.js";
import { CeremonyEnvironment } from "./environment.js";
import {
  runArazzo,
  validateConnectorWorkflows,
  type ArazzoDocument,
  type WorkflowStepEvent,
} from "./arazzo.js";

export const serviceManifests = [
  manifestSchema.parse({
    schemaVersion: 1,
    support: "live-adapter",
    id: "stripe",
    name: "Stripe",
    description: "Verify API access without creating a payment.",
    methods: [
      {
        id: "api-key",
        label: "API key",
        kind: "api-key",
        templateId: "api-key",
        scopes: [],
        contract: {
          profile: "stripe-api-key",
          surfaces: ["browser", "headless"],
          configuration: [
            {
              name: "STRIPE_SECRET_KEY",
              source: "session-environment",
              classification: "secret",
              required: false,
            },
          ],
          prerequisites: [],
          configurationGroups: [],
          handoff: {
            surface: "private-collector",
            recipient: "initiating-subject",
            delegation: "a2h-authorize",
            resume: "verify",
          },
          completion: {
            verifier: "stripe.balance-read",
            ownership: ["authenticated"],
          },
          workflows: [
            {
              document: "stripe",
              version: "1.0.0",
              workflowId: "verify-access",
            },
          ],
        },
        fields: [
          {
            name: "token",
            label: "Stripe secret key",
            type: "password",
            required: true,
            classification: "secret",
          },
        ],
      },
    ],
  }),
  manifestSchema.parse({
    schemaVersion: 1,
    support: "live-adapter",
    id: "supabase",
    name: "Supabase",
    description:
      "Sign in to your Supabase project, with missing project setup included.",
    methods: [
      {
        id: "form",
        label: "Email & password",
        kind: "form",
        templateId: "form",
        scopes: [],
        contract: {
          profile: "supabase-password",
          surfaces: ["browser", "headless"],
          configuration: [
            {
              name: "SUPABASE_URL",
              source: "session-environment",
              classification: "public",
              required: true,
            },
            {
              name: "SUPABASE_PUBLISHABLE_KEY",
              source: "session-environment",
              classification: "public",
              required: false,
            },
            {
              name: "SUPABASE_ANON_KEY",
              source: "session-environment",
              classification: "public",
              required: false,
            },
          ],
          prerequisites: [
            {
              id: "project-configuration",
              kind: "configuration",
              reuse: "verified-context",
              handoff: {
                surface: "private-collector",
                recipient: "authorized-owner",
                delegation: "a2h-authorize",
                resume: "verify",
              },
            },
          ],
          configurationGroups: [
            {
              id: "project-key",
              rule: "at-least-one",
              names: ["SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"],
            },
          ],
          handoff: {
            surface: "private-collector",
            recipient: "initiating-subject",
            delegation: "a2h-authorize",
            resume: "verify",
          },
          completion: {
            verifier: "supabase.auth-session",
            ownership: ["authenticated"],
          },
          workflows: [
            { document: "supabase", version: "1.0.0", workflowId: "sign-in" },
          ],
        },
        fields: [
          {
            name: "email",
            label: "Email",
            type: "email",
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
        ],
      },
    ],
  }),
];

export const serviceWorkflows: Record<string, ArazzoDocument> = {
  stripe: {
    arazzo: "1.0.1",
    info: { title: "Stripe API access", version: "1.0.0" },
    sourceDescriptions: [
      {
        name: "stripe",
        type: "openapi",
        url: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
      },
    ],
    workflows: [
      {
        workflowId: "verify-access",
        summary:
          "Read balance to verify key permissions; never create payments.",
        steps: [
          {
            stepId: "verify",
            description: "Verify read access with the Stripe SDK",
            operationId: "GetBalance",
          },
        ],
      },
    ],
  },
  supabase: {
    arazzo: "1.0.1",
    info: { title: "Supabase project sign-in", version: "1.0.0" },
    sourceDescriptions: [
      {
        name: "auth",
        type: "openapi",
        url: "https://raw.githubusercontent.com/supabase/auth/master/openapi.yaml",
      },
    ],
    workflows: [
      {
        workflowId: "sign-in",
        summary: "Sign in an existing project user with the Supabase SDK.",
        steps: [
          {
            stepId: "authenticate",
            description: "Exchange email and password for a project session",
            operationPath: "{$sourceDescriptions.auth.url}#/paths/~1token/post",
          },
        ],
      },
    ],
  },
};

/** Real SDK consumers. Only the trusted host can replace the HTTP transport. */
export function serviceRegistrations(
  db: CeremonyDatabase,
  environment: CeremonyEnvironment,
  options: {
    fetch?: typeof fetch;
    onStep?: (event: WorkflowStepEvent) => void | Promise<void>;
  } = {},
): ConnectorRegistration[] {
  for (const manifest of serviceManifests)
    validateConnectorWorkflows(
      manifest,
      new Map(Object.entries(serviceWorkflows)),
    );
  const request: typeof fetch = (input, init) =>
    (options.fetch ?? fetch)(input, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  return serviceManifests.map((manifest) => ({
    manifest,
    recoverable: true,
    resume(owner) {
      return db
        .keys("instance:")
        .map((key) =>
          db.get(
            key,
            z.object({ owner: z.string(), snapshot: snapshotSchema }),
          ),
        )
        .filter(
          (record) =>
            record?.owner === owner &&
            record.snapshot.connectorId === manifest.id &&
            record.snapshot.expiresAt > Date.now() &&
            !["cancelled", "expired", "error"].includes(record.snapshot.step),
        )
        .sort(
          (a, b) =>
            Number(b!.snapshot.step === "complete") -
            Number(a!.snapshot.step === "complete"),
        )[0]?.snapshot.id;
    },
    createAdapter({ owner, instanceId, method }) {
      const resultKey = `service-result:${owner}:${instanceId}`;
      const configured = () => environment.read(owner);
      const initial = (all = false): AdapterUpdate => {
        const saved = db.get(
          resultKey,
          z.object({ outcome: outcomeSchema, expiresAt: z.number() }),
        );
        if (saved && saved.expiresAt > Date.now())
          return { step: "complete", ...saved };
        const env = all ? {} : configured();
        const fields =
          manifest.id === "stripe"
            ? method.fields.filter(() => !env.STRIPE_SECRET_KEY)
            : [
                ...(!env.SUPABASE_URL
                  ? [
                      {
                        name: "projectUrl",
                        label: "Supabase project URL",
                        type: "text" as const,
                        required: true,
                      },
                    ]
                  : []),
                ...(!(env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY)
                  ? [
                      {
                        name: "publishableKey",
                        label: "Supabase publishable key",
                        type: "password" as const,
                        required: true,
                      },
                    ]
                  : []),
                ...method.fields,
              ];
        return {
          step: fields.length ? "input" : "intro",
          fields,
          message:
            manifest.id === "stripe"
              ? "Use a restricted key with Balance read permission. Existing session keys are reused. No payments will be made."
              : "Project settings are reused from your session. Supply only what’s missing, then sign in as an existing project user—not a dashboard account.",
        };
      };
      const authenticate = async (
        values: Record<string, string>,
      ): Promise<AdapterUpdate> => {
        const env = configured();
        let secret: Record<string, unknown> = {};
        let expiresAt = Date.now() + 3_600_000;
        try {
          if (manifest.id === "stripe") {
            const token = values.token ?? env.STRIPE_SECRET_KEY;
            if (!token || !/^(sk|rk)_(test|live)_/.test(token))
              throw new Error("Invalid key");
            const stripe = new Stripe(token, {
              maxNetworkRetries: 0,
              timeout: 15_000,
              httpClient: Stripe.createFetchHttpClient(request),
            });
            await runArazzo(
              serviceWorkflows.stripe!,
              "verify-access",
              new Map([
                [
                  "GetBalance",
                  async () => {
                    const balance = await stripe.balance.retrieve();
                    if (balance.object !== "balance")
                      throw new Error("Invalid balance response");
                  },
                ],
              ]),
              options.onStep,
            );
            secret = { token };
          } else {
            const projectUrl = new URL(
              values.projectUrl ?? env.SUPABASE_URL ?? "",
            );
            if (
              projectUrl.protocol !== "https:" ||
              !/^[a-z0-9-]+\.supabase\.co$/.test(projectUrl.hostname) ||
              projectUrl.port ||
              projectUrl.username ||
              projectUrl.password ||
              projectUrl.pathname !== "/" ||
              projectUrl.search ||
              projectUrl.hash
            )
              throw new Error("Invalid project origin");
            const publishableKey =
              values.publishableKey ??
              env.SUPABASE_PUBLISHABLE_KEY ??
              env.SUPABASE_ANON_KEY;
            if (!publishableKey || !values.email || !values.password)
              throw new Error("Missing sign-in fields");
            const supabase = createClient(projectUrl.origin, publishableKey, {
              auth: {
                persistSession: false,
                autoRefreshToken: false,
                detectSessionInUrl: false,
              },
              global: { fetch: request },
            });
            await runArazzo(
              serviceWorkflows.supabase!,
              "sign-in",
              new Map([
                [
                  "{$sourceDescriptions.auth.url}#/paths/~1token/post",
                  async () => {
                    const { data, error } =
                      await supabase.auth.signInWithPassword({
                        email: values.email!,
                        password: values.password!,
                      });
                    if (error) throw error;
                    const session = z
                      .object({
                        access_token: z.string().min(1),
                        refresh_token: z.string().min(1),
                        expires_at: z.number().positive(),
                      })
                      .parse(data.session);
                    expiresAt = session.expires_at * 1000;
                    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
                      throw new Error("Expired session");
                    secret = {
                      projectUrl: projectUrl.origin,
                      access_token: session.access_token,
                      refresh_token: session.refresh_token,
                    };
                  },
                ],
              ]),
              options.onStep,
            );
            // Keep reusable project configuration, never the user's password.
            environment.update(owner, {
              revision: environment.describe(owner).revision,
              values: {
                SUPABASE_URL: projectUrl.origin,
                SUPABASE_PUBLISHABLE_KEY: publishableKey,
              },
            });
          }
        } catch {
          throw new CeremonyError(
            manifest.id === "stripe"
              ? "Stripe could not verify this key. Retry with a valid secret or restricted key that has Balance read permission."
              : "Supabase could not sign you in. Retry with your project’s https://<project>.supabase.co URL, publishable key and user credentials.",
          );
        }
        const outcome = {
          connectionRef: randomUUID(),
          ownership: "authenticated" as const,
          scopes: [],
        };
        db.transaction(() => {
          db.put(`connection:${outcome.connectionRef}`, {
            owner,
            connectorId: manifest.id,
            secret,
            expiresAt,
          });
          db.put(resultKey, { outcome, expiresAt });
        });
        return { step: "complete", outcome, expiresAt };
      };
      return {
        initial,
        retry: async () => initial(true),
        begin: () => authenticate({}),
        submit: (values) => authenticate(values),
        async callback() {
          throw new CeremonyError("This ceremony does not use a callback");
        },
        async poll() {
          return undefined;
        },
        cancel() {},
      };
    },
  }));
}
