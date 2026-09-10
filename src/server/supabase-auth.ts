import { createClient, isAuthRetryableFetchError } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { z } from "zod";
import { runArazzo, type ArazzoDocument } from "./arazzo.js";

export const supabaseAuthWorkflows: ArazzoDocument = {
  arazzo: "1.0.1",
  info: { title: "Supabase account and session operations", version: "1.0.0" },
  sourceDescriptions: [
    {
      name: "auth",
      type: "openapi",
      url: "https://raw.githubusercontent.com/supabase/auth/master/openapi.yaml",
    },
  ],
  workflows: [
    {
      workflowId: "sign-up",
      summary: "Register a project user; confirmation may still be required.",
      steps: [
        {
          stepId: "register",
          description:
            "Create a project user with explicit human authorization",
          operationPath: "{$sourceDescriptions.auth.url}#/paths/~1signup/post",
        },
      ],
    },
    {
      workflowId: "sign-in",
      summary: "Sign in an existing or confirmed project user.",
      steps: [
        {
          stepId: "authenticate",
          description: "Obtain a project session with the Supabase SDK",
          operationPath: "{$sourceDescriptions.auth.url}#/paths/~1token/post",
        },
      ],
    },
    {
      workflowId: "verify-user",
      summary: "Verify issued access before completing a connection.",
      steps: [
        {
          stepId: "verify",
          description: "Verify current session identity with the Auth server",
          operationPath: "{$sourceDescriptions.auth.url}#/paths/~1user/get",
        },
      ],
    },
  ],
};
async function sdkStep<T>(
  workflow: "sign-up" | "sign-in" | "verify-user",
  operation: () => Promise<T>,
): Promise<T> {
  const path = {
    "sign-up": "~1signup/post",
    "sign-in": "~1token/post",
    "verify-user": "~1user/get",
  }[workflow];
  let result: { value: T } | undefined;
  await runArazzo(
    supabaseAuthWorkflows,
    workflow,
    new Map([
      [
        `{$sourceDescriptions.auth.url}#/paths/${path}`,
        async () => {
          result = { value: await operation() };
        },
      ],
    ]),
  );
  if (!result) throw new SupabaseAuthFailure("provider-unavailable");
  return result.value;
}

const projectSchema = z.strictObject({
  projectUrl: z
    .string()
    .max(2048)
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        /^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) &&
        !url.port &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash
      );
    }),
  publishableKey: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => {
      if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(value)) return true;
      try {
        return decodeJwt(value).role === "anon";
      } catch {
        return false;
      }
    }),
});
export type SupabaseProject = z.infer<typeof projectSchema>;
const sessionSchema = z.object({
  access_token: z.string().min(1).max(16384),
  refresh_token: z.string().min(1).max(4096),
  expires_at: z.number().int().positive(),
  user: z.object({ id: z.string().min(1).max(128) }),
});
export type SupabasePrivateSession = z.infer<typeof sessionSchema>;
export class SupabaseAuthFailure extends Error {
  constructor(
    readonly code:
      | "invalid-input"
      | "confirmation-required"
      | "verification-rejected"
      | "provider-unavailable",
  ) {
    super(code);
  }
}

/** Server-only SDK boundary. Callers own durable intent, authorization and private material retention. */
export function supabaseAuth(
  project: SupabaseProject,
  options: { fetch?: typeof fetch; signal: AbortSignal; now?: () => number },
) {
  const parsed = projectSchema.safeParse(project);
  if (!parsed.success) throw new SupabaseAuthFailure("invalid-input");
  const now = options.now ?? Date.now;
  const transport = options.fetch ?? fetch;
  const client = createClient(
    new URL(parsed.data.projectUrl).origin,
    parsed.data.publishableKey,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        fetch: (url, init) => {
          options.signal.throwIfAborted();
          return transport(url, {
            ...init,
            redirect: "error",
            signal: AbortSignal.any([
              options.signal,
              AbortSignal.timeout(15000),
            ]),
          });
        },
      },
    },
  );
  const session = (value: unknown): SupabasePrivateSession => {
    const parsed = sessionSchema.safeParse(value);
    if (!parsed.success || parsed.data.expires_at * 1000 <= now())
      throw new SupabaseAuthFailure("verification-rejected");
    return parsed.data;
  };
  return {
    /** Explicit signup only. A missing session proves neither creation nor ownership. Never retry signup to recover a lost response. */
    async authenticate(input: {
      action: "sign-in" | "sign-up";
      email: string;
      password: string;
    }): Promise<
      | { state: "confirmation-required" }
      | { state: "session"; session: SupabasePrivateSession }
    > {
      const parsed = z
        .strictObject({
          action: z.enum(["sign-in", "sign-up"]),
          email: z.email().max(254),
          password: z.string().min(1).max(1024),
        })
        .safeParse(input);
      if (!parsed.success) throw new SupabaseAuthFailure("invalid-input");
      try {
        const credentials = {
          email: parsed.data.email,
          password: parsed.data.password,
        };
        return await sdkStep(parsed.data.action, async () => {
          const result =
            parsed.data.action === "sign-up"
              ? await client.auth.signUp(credentials)
              : await client.auth.signInWithPassword(credentials);
          options.signal.throwIfAborted();
          if (result.error) {
            if (isAuthRetryableFetchError(result.error))
              throw new SupabaseAuthFailure("provider-unavailable");
            if (result.error.code === "email_not_confirmed")
              throw new SupabaseAuthFailure("confirmation-required");
            throw new SupabaseAuthFailure("verification-rejected");
          }
          if (parsed.data.action === "sign-up" && !result.data.session)
            return { state: "confirmation-required" as const };
          return {
            state: "session" as const,
            session: session(result.data.session),
          };
        });
      } catch (error) {
        if (error instanceof SupabaseAuthFailure) throw error;
        throw new SupabaseAuthFailure("provider-unavailable");
      }
    },
    /** The provider verifies the token; decoding is only used after that check to inspect its assurance claim. */
    async verify(
      value: SupabasePrivateSession,
      requiredAssurance: "aal1" | "aal2" = "aal1",
    ) {
      if (requiredAssurance !== "aal1" && requiredAssurance !== "aal2")
        throw new SupabaseAuthFailure("invalid-input");
      const candidate = session(value);
      try {
        return await sdkStep("verify-user", async () => {
          const { data, error } = await client.auth.getUser(
            candidate.access_token,
          );
          options.signal.throwIfAborted();
          if (
            error ||
            data.user?.id !== candidate.user.id ||
            candidate.expires_at * 1000 <= now()
          )
            throw new SupabaseAuthFailure("verification-rejected");
          const claims = decodeJwt(candidate.access_token);
          if (
            claims.sub !== data.user.id ||
            typeof claims.exp !== "number" ||
            claims.exp * 1000 <= now() ||
            (claims.aal !== "aal1" && claims.aal !== "aal2")
          )
            throw new SupabaseAuthFailure("verification-rejected");
          if (requiredAssurance === "aal2" && claims.aal !== "aal2")
            return { state: "mfa-required" as const };
          return {
            state: "verified" as const,
            userId: data.user.id,
            assurance: claims.aal as "aal1" | "aal2",
            expiresAt: Math.min(candidate.expires_at, claims.exp) * 1000,
          };
        });
      } catch (error) {
        if (error instanceof SupabaseAuthFailure) throw error;
        throw new SupabaseAuthFailure("verification-rejected");
      }
    },
  };
}
