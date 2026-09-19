import { z } from "zod";

/**
 * Whether this host wants somebody signed in before a connection starts.
 *
 * A hosted deployment with teaching enabled asks for an account. The component
 * that asks is mounted at the drawer's last step, which is the wrong place: a
 * person can fill in Configure and Customize, reach Complete, be told to sign
 * in, and lose the draft to a provider round trip that returns to the bare
 * origin. The requirement is not per-connector, so it can be answered on the
 * directory instead — before anything has been drafted.
 */

/** The unauthenticated shape; the endpoint answers it without a session. */
const capabilitiesSchema = z.object({
  available: z.boolean(),
  authenticated: z.boolean(),
});

const loginSchema = z.strictObject({ authorizationUrl: z.url() });

export type HostedIdentity =
  "unknown" | "not-required" | "required" | "signed-in";

/**
 * Ask the teaching host whether it has anybody signed in.
 *
 * Returns "not-required" when the host publishes no teaching at all, which is
 * every local and test-harness run — nothing should appear on the directory
 * for a workspace that never asks.
 */
export async function hostedIdentity(
  base = "/api/v1/teaching",
  signal?: AbortSignal,
): Promise<HostedIdentity> {
  try {
    const response = await fetch(`${base.replace(/\/$/, "")}/capabilities`, {
      cache: "no-store",
      credentials: "same-origin",
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return "not-required";
    const value = capabilitiesSchema.parse(await response.json());
    if (!value.available) return "not-required";
    return value.authenticated ? "signed-in" : "required";
  } catch {
    // A host without teaching, or one that cannot answer, is not a host that
    // is about to demand an account. Saying nothing is the honest default.
    return "not-required";
  }
}

/**
 * Start the host's sign-in.
 *
 * The same call the teaching component makes on its own, hoisted so the
 * directory and the drawer cannot drift apart. The provider round trip returns
 * to the host's configured path with no query of its own, which is the
 * directory — so asking here means the person lands back where they were
 * rather than outside a drawer they had already filled in.
 */
export async function beginSignIn(): Promise<void> {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok)
    throw new Error(
      "Sign-in is unavailable. Contact this host’s administrator.",
    );
  location.assign(loginSchema.parse(await response.json()).authorizationUrl);
}
