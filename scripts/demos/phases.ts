import type { Phase } from "./captions.js";

/**
 * Which step of a ceremony the viewer is looking at, from what the driver was
 * about to do and where.
 *
 * Driven by events, never by elapsed time: a phase changes because the page or
 * the proposed action changed, so a slow provider or a fast machine shows the
 * same sequence. The paths are the self-hosted test provider's own
 * (`tests/doubles/auth-provider`), whose sign-up path is randomized per seed
 * and therefore passed in rather than assumed.
 */
export type PhaseObservation = {
  /** Pathname only; the driver's snapshot path is origin plus pathname. */
  pathname: string;
  action: string;
  role?: string | undefined;
};

export function providerPhase(
  previous: Phase | undefined,
  observed: PhaseObservation,
  signupPath: string,
): Phase | undefined {
  const { pathname, action, role } = observed;
  if (pathname === "/authorize") return "consent";
  // A code field says which step this is wherever the provider serves it:
  // confirmation and two-factor forms are often answered from the URL of
  // the form that led to them, so the path alone cannot tell.
  if (role === "verification-code") return "verify-email";
  if (role === "totp-code") return "second-factor";
  // Submitting the code keeps the step it was entered in.
  if (
    (previous === "verify-email" || previous === "second-factor") &&
    action !== "fill"
  )
    return previous;
  if (pathname === "/mfa") return "second-factor";
  if (pathname.startsWith("/confirm")) return "verify-email";
  if (pathname === "/signin" || pathname.startsWith("/signin/"))
    return "sign-in";
  if (pathname === signupPath) return "register";
  return previous;
}

/** Pathname of a snapshot path, which is already origin plus pathname. */
export function pathnameOf(path: string): string {
  try {
    return new URL(path).pathname;
  } catch {
    return "";
  }
}
