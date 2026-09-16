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
    ...(["challenge", "verify"] as const).map((action) => ({
      workflowId: `mfa-${action}`,
      summary: `${action} an enrolled authenticator challenge.`,
      steps: [
        {
          stepId: action,
          description: `Execute the registered MFA ${action} SDK operation`,
          operationPath: `{$sourceDescriptions.auth.url}#/paths/~1factors~1{factorId}~1${action}/post`,
        },
      ],
    })),
  ],
};
async function sdkStep<T>(
  workflow:
    "sign-up" | "sign-in" | "verify-user" | "mfa-challenge" | "mfa-verify",
  operation: () => Promise<T>,
): Promise<T> {
  const path = {
    "sign-up": "~1signup/post",
    "sign-in": "~1token/post",
    "verify-user": "~1user/get",
    "mfa-challenge": "~1factors~1{factorId}~1challenge/post",
    "mfa-verify": "~1factors~1{factorId}~1verify/post",
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
const challengeSchema = z.strictObject({
  id: z.uuid(),
  factorId: z.uuid(),
  userId: z.string().min(1).max(128),
  expiresAt: z.number().int().positive(),
});
/** Private server record, not a tool argument or proof of authorization. */
export type SupabasePrivateChallenge = z.infer<typeof challengeSchema>;
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
  const createSdk = (accessToken?: string) =>
    createClient(
      new URL(parsed.data.projectUrl).origin,
      parsed.data.publishableKey,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        global: {
          ...(accessToken
            ? { headers: { Authorization: `Bearer ${accessToken}` } }
            : {}),
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
  const client = createSdk();
  const session = (value: unknown): SupabasePrivateSession => {
    const parsed = sessionSchema.safeParse(value);
    if (!parsed.success || parsed.data.expires_at * 1000 <= now())
      throw new SupabaseAuthFailure("verification-rejected");
    return parsed.data;
  };
  const verifiedUser = async (candidate: SupabasePrivateSession) =>
    sdkStep("verify-user", async () => {
      const { data, error } = await client.auth.getUser(candidate.access_token);
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
      return {
        user: data.user,
        claims,
        expiresAt: Math.min(candidate.expires_at, claims.exp) * 1000,
      };
    });
  const enrolledTotp = async (
    candidate: SupabasePrivateSession,
    factorId: string,
  ) => {
    const { user } = await verifiedUser(candidate);
    if (
      !user.factors?.some(
        (factor) =>
          factor.id === factorId &&
          factor.factor_type === "totp" &&
          factor.status === "verified",
      )
    )
      throw new SupabaseAuthFailure("verification-rejected");
  };
  return {
    /** Private native collector only. Labels are supplied by the host UI, not arbitrary provider profile fields. */
    async totpFactors(value: SupabasePrivateSession): Promise<string[]> {
      try {
        const { user } = await verifiedUser(session(value));
        return (user.factors ?? [])
          .filter(
            (factor) =>
              factor.factor_type === "totp" &&
              factor.status === "verified" &&
              z.uuid().safeParse(factor.id).success,
          )
          .map((factor) => factor.id);
      } catch {
        throw new SupabaseAuthFailure("verification-rejected");
      }
    },
    /** Caller must persist effect intent before requesting a challenge; no enrollment or automatic retries. */
    async challengeTotp(
      value: SupabasePrivateSession,
      factorId: string,
    ): Promise<SupabasePrivateChallenge> {
      if (!z.uuid().safeParse(factorId).success)
        throw new SupabaseAuthFailure("invalid-input");
      const candidate = session(value);
      try {
        await enrolledTotp(candidate, factorId);
        return await sdkStep("mfa-challenge", async () => {
          const { data, error } = await createSdk(
            candidate.access_token,
          ).auth.mfa.challenge({ factorId });
          options.signal.throwIfAborted();
          if (error && isAuthRetryableFetchError(error))
            throw new SupabaseAuthFailure("provider-unavailable");
          if (error || data?.type !== "totp")
            throw new SupabaseAuthFailure("verification-rejected");
          const parsed = challengeSchema.safeParse({
            id: data.id,
            factorId,
            userId: candidate.user.id,
            expiresAt: data.expires_at * 1000,
          });
          if (!parsed.success || parsed.data.expiresAt <= now())
            throw new SupabaseAuthFailure("verification-rejected");
          return parsed.data;
        });
      } catch (error) {
        if (error instanceof SupabaseAuthFailure) throw error;
        throw new SupabaseAuthFailure("provider-unavailable");
      }
    },
    /** Only a broker-bound human code may reach this server-only method. Returned access is freshly verified at aal2. */
    async verifyTotp(
      value: SupabasePrivateSession,
      challenge: SupabasePrivateChallenge,
      code: string,
    ): Promise<SupabasePrivateSession> {
      const parsed = challengeSchema.safeParse(challenge);
      if (!parsed.success || typeof code !== "string" || !/^\d{6}$/.test(code))
        throw new SupabaseAuthFailure("invalid-input");
      const candidate = session(value);
      if (
        parsed.data.userId !== candidate.user.id ||
        parsed.data.expiresAt <= now()
      )
        throw new SupabaseAuthFailure("verification-rejected");
      try {
        await enrolledTotp(candidate, parsed.data.factorId);
        if (parsed.data.expiresAt <= now())
          throw new SupabaseAuthFailure("verification-rejected");
        return await sdkStep("mfa-verify", async () => {
          const { data, error } = await createSdk(
            candidate.access_token,
          ).auth.mfa.verify({
            factorId: parsed.data.factorId,
            challengeId: parsed.data.id,
            code,
          });
          options.signal.throwIfAborted();
          if (error && isAuthRetryableFetchError(error))
            throw new SupabaseAuthFailure("provider-unavailable");
          if (error || !data || data.user?.id !== candidate.user.id)
            throw new SupabaseAuthFailure("verification-rejected");
          const result = session({
            ...data,
            expires_at: Math.floor(now() / 1000) + data.expires_in,
          });
          const verified = await verifiedUser(result);
          if (verified.claims.aal !== "aal2")
            throw new SupabaseAuthFailure("verification-rejected");
          return result;
        });
      } catch (error) {
        if (error instanceof SupabaseAuthFailure) throw error;
        throw new SupabaseAuthFailure("provider-unavailable");
      }
    },
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
        const { user, claims, expiresAt } = await verifiedUser(candidate);
        if (requiredAssurance === "aal2" && claims.aal !== "aal2")
          return { state: "mfa-required" as const };
        return {
          state: "verified" as const,
          userId: user.id,
          assurance: claims.aal as "aal1" | "aal2",
          expiresAt,
        };
      } catch (error) {
        if (error instanceof SupabaseAuthFailure) throw error;
        throw new SupabaseAuthFailure("verification-rejected");
      }
    },
  };
}
