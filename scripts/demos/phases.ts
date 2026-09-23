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
  if (pathname === "/mfa") return "second-factor";
  if (pathname.startsWith("/confirm")) return "verify-email";
  if (pathname === "/signin")
    return role === "totp-code" ? "second-factor" : "sign-in";
  if (pathname === signupPath) {
    // The confirmation form is served from the sign-up URL itself, so the
    // path alone cannot tell the two apart; asking for the emailed code can.
    if (role === "verification-code") return "verify-email";
    return previous === "verify-email" && action !== "fill"
      ? "verify-email"
      : "register";
  }
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
