import { randomBytes } from "node:crypto";
import type {
  BlockedReason,
  CeremonyGoal,
} from "../../../src/core/browser-contracts.js";
import {
  createSecrets,
  type CeremonyResult,
  type CeremonyRunOptions,
  type CeremonySecrets,
} from "../../../src/server/browser-driver.js";
import {
  startAuthProvider,
  type ProviderBehavior,
  type ProviderDouble,
} from "./server.js";

/**
 * The auth scenario catalog.
 *
 * Each entry is a contract, not a script: it states the provider situation, the
 * preconditions that must hold before the ceremony starts, the roles the caller
 * must be able to supply, and the single outcome the driver is required to
 * reach. The same catalog is executed against a parsed document over real HTTP
 * and against a real browser, so a scenario describes the ceremony rather than
 * either runner.
 *
 * Families reference `docs/auth-catalog.md`. A scenario proves behaviour
 * against this double only; none of them certifies a real provider.
 */

export type ScenarioPrecondition =
  | "account-exists"
  | "account-verified"
  | "account-absent"
  | "address-unused"
  | "disposable-addresses"
  | "mailbox-readable"
  | "registered-client";

export type ScenarioExpectation =
  | { status: "completed"; callback?: boolean }
  | { status: "blocked"; reason: BlockedReason }
  | { status: "stalled" }
  | { status: "exhausted" }
  | { status: "unverified" };

export type ScenarioContext = {
  provider: ProviderDouble;
  /** An origin deliberately outside the ceremony's allowlist. */
  untrusted?: {
    origin: string;
    submissions(): readonly Record<string, string>[];
  };
  identity: {
    email: string;
    username: string;
    password: string;
    /** A fresh address each call, standing in for a disposable mailbox. */
    freshEmail(): string;
  };
};

/**
 * Values a scenario produces while it runs and checks afterwards: the PKCE
 * verifier it generated, the state it sent, and the address a disposable source
 * ended up using. Holding them per plan keeps scenarios independent.
 */
export type ScenarioState = {
  verifier?: string;
  state?: string;
  address?: string;
};

/** Everything `runCeremony` needs, minus the page, which the runner supplies. */
export type ScenarioPlan = Omit<CeremonyRunOptions, "page" | "interpreter"> & {
  entryUrl: string;
  goal: CeremonyGoal;
  state?: ScenarioState;
};

export type AuthScenario = {
  id: string;
  title: string;
  /** Interaction family from the auth catalog. */
  family: string;
  goal: CeremonyGoal;
  preconditions: readonly ScenarioPrecondition[];
  /** Roles the caller must be able to supply for this ceremony to be possible. */
  provides: readonly string[];
  behavior: (context: { untrustedOrigin?: string }) => ProviderBehavior;
  /** Whether the scenario needs the untrusted origin started. */
  needsUntrustedOrigin?: boolean;
  plan: (context: ScenarioContext) => ScenarioPlan;
  expect: ScenarioExpectation;
  /**
   * Provider-side facts that must hold after the attempt. This is where a
   * scenario proves the ceremony really happened rather than merely returned.
   */
  confirm?: (
    context: ScenarioContext,
    result: CeremonyResult,
    state: ScenarioState,
  ) => Promise<void>;
};

export function createIdentity(seed = randomBytes(4).toString("hex")) {
  let issued = 0;
  return {
    email: `owner-${seed}@ceremony.invalid`,
    username: `owner-${seed}`,
    password: `pw-${randomBytes(9).toString("base64url")}`,
    freshEmail: () => `fresh-${seed}-${issued++}@ceremony.invalid`,
  };
}

function signInSecrets(identity: ScenarioContext["identity"]) {
  return createSecrets({
    username: identity.username,
    email: identity.email,
    password: identity.password,
  });
}

/**
 * Registration roles. The confirmation code is fetched from the mailbox for
 * whichever address was actually submitted, so a scenario that switches address
 * mid-attempt still reads the right message.
 */
function registrationSecrets(
  identity: ScenarioContext["identity"],
  provider: ProviderDouble,
  address: string | (() => Promise<string>),
  state: ScenarioState,
) {
  if (typeof address === "string") state.address = address;
  return createSecrets({
    email: address,
    password: identity.password,
    "password-confirm": identity.password,
    "display-name": "Casey Rivers",
    "birth-date": "1990-04-12",
    "verification-code": async () =>
      (await provider.mailbox.waitFor(state.address ?? identity.email))?.code ??
      "",
  });
}

const existing = (identity: ScenarioContext["identity"], verified = true) => [
  {
    email: identity.email,
    username: identity.username,
    password: identity.password,
    verified,
  },
];

export const authScenarios: readonly AuthScenario[] = [
  {
    id: "sign-in",
    title: "an existing verified account signs in",
    family: "Forms/session auth",
    goal: "sign-in",
    preconditions: ["account-exists", "account-verified"],
    provides: ["username", "password"],
    behavior: () => ({ seed: 11 }),
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}/signin`,
      goal: "sign-in",
      secrets: signInSecrets(identity),
      allowedOrigins: [provider.origin],
      protectedValues: [identity.password],
      verify: () => provider.verifyAccess(identity.email),
    }),
    expect: { status: "completed" },
  },
  {
    id: "sign-in-rejected",
    title: "a wrong password is reported, never retried forever",
    family: "Forms/session auth",
    goal: "sign-in",
    preconditions: ["account-exists", "account-verified"],
    provides: ["username", "password"],
    behavior: () => ({ seed: 12 }),
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}/signin`,
      goal: "sign-in",
      secrets: createSecrets({
        username: identity.username,
        password: "not-the-password",
      }),
      allowedOrigins: [provider.origin],
      verify: () => provider.verifyAccess(identity.email),
    }),
    expect: { status: "blocked", reason: "credentials-rejected" },
    confirm: async ({ provider, identity }) => {
      if (await provider.verifyAccess(identity.email))
        throw new Error("A rejected sign-in must not leave a session");
    },
  },
  {
    id: "sign-in-after-provider-fault",
    title: "a transient provider failure is retried, then succeeds",
    family: "Forms/session auth",
    goal: "sign-in",
    preconditions: ["account-exists", "account-verified"],
    provides: ["username", "password"],
    behavior: () => ({ seed: 13, faultySignIns: 1 }),
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}/signin`,
      goal: "sign-in",
      secrets: signInSecrets(identity),
      allowedOrigins: [provider.origin],
      protectedValues: [identity.password],
      verify: () => provider.verifyAccess(identity.email),
    }),
    expect: { status: "completed" },
  },
  {
    id: "sign-in-unverified-account",
    title: "an unverified account confirms by emailed code, then signs in",
    family: "OTP / magic link / MFA",
    goal: "sign-in",
    preconditions: ["account-exists", "mailbox-readable"],
    provides: ["username", "password", "verification-code"],
    behavior: () => ({ seed: 14 }),
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}/signin`,
      goal: "sign-in",
      secrets: createSecrets({
        username: identity.username,
        password: identity.password,
        "verification-code": async () =>
          (await provider.mailbox.waitFor(identity.email))?.code ?? "",
      }),
      allowedOrigins: [provider.origin],
      protectedValues: [identity.password],
      verify: () => provider.verifyAccess(identity.email),
    }),
    expect: { status: "completed" },
  },
  {
    id: "sign-in-human-challenge",
    title: "a human challenge stops the attempt instead of guessing",
    family: "Forms/session auth",
    goal: "sign-in",
    preconditions: ["account-exists"],
    provides: ["username", "password"],
    behavior: () => ({ seed: 15, challengeAt: "sign-in" }),
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}/signin`,
      goal: "sign-in",
      secrets: signInSecrets(identity),
      allowedOrigins: [provider.origin],
      protectedValues: [identity.password],
      verify: () => provider.verifyAccess(identity.email),
    }),
    expect: { status: "blocked", reason: "human-challenge" },
  },
  {
    id: "sign-in-form-targets-another-origin",
    title: "a sign-in form aimed at a third party never receives the password",
    family: "Forms/session auth",
    goal: "sign-in",
    preconditions: ["account-exists"],
    provides: ["username", "password"],
    needsUntrustedOrigin: true,
    behavior: ({ untrustedOrigin }) => ({
      seed: 16,
      ...(untrustedOrigin ? { hijackSignInTo: `${untrustedOrigin}/` } : {}),
    }),
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}/signin`,
      goal: "sign-in",
      secrets: signInSecrets(identity),
      allowedOrigins: [provider.origin],
      protectedValues: [identity.password],
      verify: () => provider.verifyAccess(identity.email),
    }),
    expect: { status: "blocked", reason: "untrusted-origin" },
    confirm: async ({ untrusted, identity }) => {
      const captured = untrusted?.submissions() ?? [];
      if (
        captured.some((entry) =>
          Object.values(entry).includes(identity.password),
        )
      )
        throw new Error("The password reached an origin outside the ceremony");
    },
  },
  {
    id: "registration-with-emailed-code",
    title: "a new account is created and confirmed by emailed code",
    family: "Forms/session auth",
    goal: "registration",
    preconditions: ["account-absent", "address-unused", "mailbox-readable"],
    provides: ["email", "password", "password-confirm", "verification-code"],
    behavior: () => ({ seed: 21, verification: "code" }),
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}${provider.signupPath}`,
      goal: "registration",
      secrets: registrationSecrets(identity, provider, identity.email, {}),
      allowedOrigins: [provider.origin],
      protectedValues: [identity.password],
      verify: () => provider.verifyAccess(identity.email),
    }),
    expect: { status: "completed" },
    confirm: async ({ provider, identity }) => {
      const account = provider.account(identity.email);
      if (!account?.verified)
        throw new Error("Registration must leave a verified account");
    },
  },
  {
    id: "registration-with-confirmation-link",
    title: "a confirmation link delivered out of band completes registration",
    family: "OTP / magic link / MFA",
    goal: "registration",
    preconditions: ["account-absent", "address-unused", "mailbox-readable"],
    provides: ["email", "password", "password-confirm"],
    behavior: () => ({ seed: 22, verification: "link" }),
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}${provider.signupPath}`,
      goal: "registration",
      secrets: createSecrets({
        email: identity.email,
        password: identity.password,
        "password-confirm": identity.password,
        "display-name": "Casey Rivers",
        "birth-date": "1990-04-12",
      }),
      allowedOrigins: [provider.origin],
      protectedValues: [identity.password],
      confirmationLink: async () =>
        (await provider.mailbox.waitFor(identity.email, 200))?.link,
      verify: () => provider.verifyAccess(identity.email),
    }),
    expect: { status: "completed" },
  },
  {
    id: "registration-requiring-terms",
    title: "a required terms checkbox is accepted before the account is made",
    family: "Forms/session auth",
    goal: "registration",
    preconditions: ["account-absent", "address-unused", "mailbox-readable"],
    provides: ["email", "password", "password-confirm", "verification-code"],
    behavior: () => ({ seed: 23, requireTerms: true }),
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}${provider.signupPath}`,
      goal: "registration",
      secrets: registrationSecrets(identity, provider, identity.email, {}),
      allowedOrigins: [provider.origin],
      protectedValues: [identity.password],
      verify: () => provider.verifyAccess(identity.email),
    }),
    expect: { status: "completed" },
  },
  {
    id: "registration-address-already-in-use",
    title: "a taken address is reported rather than retried into a wall",
    family: "Forms/session auth",
    goal: "registration",
    preconditions: ["account-exists"],
    provides: ["email", "password", "password-confirm"],
    behavior: () => ({ seed: 24 }),
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}${provider.signupPath}`,
      goal: "registration",
      secrets: createSecrets({
        email: identity.email,
        password: identity.password,
        "password-confirm": identity.password,
        "display-name": "Casey Rivers",
        "birth-date": "1990-04-12",
      }),
      allowedOrigins: [provider.origin],
      protectedValues: [identity.password],
      verify: () => provider.verifyAccess(identity.email),
    }),
    expect: { status: "blocked", reason: "account-exists" },
  },
  {
    id: "registration-recovers-with-fresh-address",
    title: "a taken address is replaced from a disposable source",
    family: "Forms/session auth",
    goal: "registration",
    preconditions: [
      "account-exists",
      "disposable-addresses",
      "mailbox-readable",
    ],
    provides: [
      "email",
      "alternate-email",
      "password",
      "password-confirm",
      "verification-code",
    ],
    behavior: () => ({ seed: 25 }),
    plan: ({ provider, identity }) => {
      // The first address on offer is the one already registered; only the
      // declared alternate source can supply an unused one, so the recovery
      // has to be a real one rather than a lucky first guess.
      const state: ScenarioState = { address: identity.email };
      return {
        entryUrl: `${provider.origin}${provider.signupPath}`,
        goal: "registration",
        secrets: withAlternateAddress(
          registrationSecrets(identity, provider, identity.email, state),
          async () => {
            state.address = identity.freshEmail();
            return state.address;
          },
        ),
        allowedOrigins: [provider.origin],
        protectedValues: [identity.password],
        state,
        verify: async () =>
          state.address !== undefined &&
          state.address !== identity.email &&
          provider.verifyAccess(state.address),
      };
    },
    expect: { status: "completed" },
    confirm: async ({ provider, identity }, _result, state) => {
      if (provider.accounts().length !== 2)
        throw new Error("Recovery must create exactly one additional account");
      if (state.address === undefined || state.address === identity.email)
        throw new Error("The replacement address must differ");
      if (!provider.account(state.address)?.verified)
        throw new Error("The replacement account must be verified");
    },
  },
  {
    id: "registration-started-from-sign-in",
    title: "registration is reached from a sign-in page that offers it",
    family: "Forms/session auth",
    goal: "registration",
    preconditions: ["account-absent", "address-unused", "mailbox-readable"],
    provides: ["email", "password", "password-confirm", "verification-code"],
    behavior: () => ({ seed: 26 }),
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}/signin`,
      goal: "registration",
      secrets: registrationSecrets(identity, provider, identity.email, {}),
      allowedOrigins: [provider.origin],
      protectedValues: [identity.password],
      verify: () => provider.verifyAccess(identity.email),
    }),
    expect: { status: "completed" },
  },
  {
    id: "registration-human-challenge",
    title: "a challenge on the signup page stops registration",
    family: "Forms/session auth",
    goal: "registration",
    preconditions: ["account-absent"],
    provides: ["email", "password", "password-confirm"],
    behavior: () => ({ seed: 27, challengeAt: "sign-up" }),
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}${provider.signupPath}`,
      goal: "registration",
      secrets: createSecrets({
        email: identity.email,
        password: identity.password,
        "password-confirm": identity.password,
      }),
      allowedOrigins: [provider.origin],
      protectedValues: [identity.password],
    }),
    expect: { status: "blocked", reason: "human-challenge" },
  },
  {
    id: "sign-in-with-second-factor",
    title: "a one-time code completes a two-factor sign-in",
    family: "OTP / magic link / MFA",
    goal: "sign-in",
    preconditions: ["account-exists", "account-verified"],
    provides: ["username", "password", "totp-code"],
    behavior: () => ({ seed: 31, requireMfa: true }),
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}/signin`,
      goal: "sign-in",
      secrets: createSecrets({
        username: identity.username,
        password: identity.password,
        "totp-code": async () =>
          provider.account(identity.email)?.totp ?? "000000",
      }),
      allowedOrigins: [provider.origin],
      protectedValues: [identity.password],
      verify: () => provider.verifyAccess(identity.email),
    }),
    expect: { status: "completed" },
  },
  {
    id: "authorization-code-with-consent",
    title: "sign-in and consent produce a redeemable authorization code",
    family: "OAuth authorization code + PKCE",
    goal: "authorize",
    preconditions: ["account-exists", "account-verified", "registered-client"],
    provides: ["username", "password"],
    behavior: () => ({ seed: 41 }),
    plan: ({ provider, identity }) => {
      const request = provider.authorization();
      return {
        entryUrl: request.url,
        goal: "authorize",
        secrets: signInSecrets(identity),
        allowedOrigins: [provider.origin],
        redirectUri: provider.redirectUri,
        protectedValues: [identity.password],
        state: { verifier: request.verifier, state: request.state },
      };
    },
    expect: { status: "completed", callback: true },
    confirm: async ({ provider }, result, state) => {
      if (result.status !== "completed" || !result.callback)
        throw new Error("An authorization ceremony must return a code");
      if (result.callback.state !== state.state)
        throw new Error("The returned state must match the request");
      const redeemed = await provider.exchange(
        result.callback.code,
        state.verifier ?? "",
      );
      if (redeemed.status !== 200 || !redeemed.body["access_token"])
        throw new Error("The code must redeem with the original PKCE verifier");
      const replay = await provider.exchange(
        result.callback.code,
        state.verifier ?? "",
      );
      if (replay.status === 200)
        throw new Error("An authorization code must not redeem twice");
    },
  },
  {
    id: "authorization-code-denied",
    title: "a refused consent is reported as a denial, not a failure to try",
    family: "OAuth authorization code + PKCE",
    goal: "authorize",
    preconditions: ["account-exists", "account-verified", "registered-client"],
    provides: ["username", "password"],
    behavior: () => ({ seed: 42, denyConsent: true }),
    plan: ({ provider, identity }) => {
      const request = provider.authorization();
      return {
        entryUrl: request.url,
        goal: "authorize",
        secrets: signInSecrets(identity),
        allowedOrigins: [provider.origin],
        redirectUri: provider.redirectUri,
        protectedValues: [identity.password],
        state: { verifier: request.verifier, state: request.state },
      };
    },
    expect: { status: "blocked", reason: "consent-denied" },
  },
  {
    id: "authorization-requires-registration-first",
    title: "authorization runs its prerequisite registration before consent",
    family: "OAuth authorization code + PKCE",
    goal: "registration",
    preconditions: [
      "account-absent",
      "address-unused",
      "mailbox-readable",
      "registered-client",
    ],
    provides: ["email", "password", "password-confirm", "verification-code"],
    behavior: () => ({ seed: 43 }),
    plan: ({ provider, identity }) => {
      const request = provider.authorization();
      const state: ScenarioState = {
        verifier: request.verifier,
        state: request.state,
      };
      return {
        entryUrl: request.url,
        // The account does not exist yet, so the ceremony is a registration
        // that happens to end at a consent screen.
        goal: "registration",
        secrets: registrationSecrets(identity, provider, identity.email, state),
        allowedOrigins: [provider.origin],
        redirectUri: provider.redirectUri,
        protectedValues: [identity.password],
        maxSteps: 30,
        state,
      };
    },
    expect: { status: "completed", callback: true },
    confirm: async ({ provider, identity }, result, state) => {
      if (!provider.account(identity.email)?.verified)
        throw new Error("The prerequisite registration must have completed");
      if (result.status !== "completed" || !result.callback)
        throw new Error("Consent must still produce a code");
      const redeemed = await provider.exchange(
        result.callback.code,
        state.verifier ?? "",
      );
      if (redeemed.status !== 200)
        throw new Error("The code must redeem after a prerequisite ceremony");
    },
  },
  {
    id: "device-approval",
    title: "a device code entered by a signed-in user is approved",
    family: "OAuth device authorization",
    goal: "sign-in",
    preconditions: ["account-exists", "account-verified"],
    provides: ["username", "password", "user-code"],
    behavior: () => ({ seed: 51 }),
    plan: ({ provider, identity }) => {
      const userCode = provider.issueDeviceCode();
      return {
        entryUrl: provider.deviceUrl(userCode),
        goal: "sign-in",
        secrets: createSecrets({
          username: identity.username,
          password: identity.password,
          "user-code": userCode,
        }),
        allowedOrigins: [provider.origin],
        protectedValues: [identity.password],
        verify: () => provider.verifyAccess(identity.email),
      };
    },
    expect: { status: "completed" },
  },
  {
    id: "page-without-any-ceremony",
    title: "a page offering nothing to do is reported, not waited on",
    family: "Forms/session auth",
    goal: "sign-in",
    preconditions: ["account-exists"],
    provides: ["username", "password"],
    behavior: () => ({ seed: 61 }),
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}/nowhere`,
      goal: "sign-in",
      secrets: signInSecrets(identity),
      allowedOrigins: [provider.origin],
      protectedValues: [identity.password],
    }),
    expect: { status: "blocked", reason: "unsupported-page" },
  },
  {
    id: "inert-sign-in-control",
    title: "a control that changes nothing stops the attempt",
    family: "Forms/session auth",
    goal: "sign-in",
    preconditions: ["account-exists"],
    provides: ["username", "password"],
    behavior: () => ({ seed: 62, inertSignIn: true }),
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}/signin`,
      goal: "sign-in",
      secrets: signInSecrets(identity),
      allowedOrigins: [provider.origin],
      protectedValues: [identity.password],
    }),
    expect: { status: "stalled" },
  },
  {
    id: "sign-in-that-never-accepts",
    title: "a form that silently redisplays itself ends within its budget",
    family: "Forms/session auth",
    goal: "sign-in",
    preconditions: ["account-exists"],
    provides: ["username", "password"],
    behavior: () => ({ seed: 63, neverAccept: true }),
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}/signin`,
      goal: "sign-in",
      secrets: signInSecrets(identity),
      allowedOrigins: [provider.origin],
      protectedValues: [identity.password],
      maxSteps: 9,
    }),
    expect: { status: "exhausted" },
  },
];

/** Declare that this caller really can obtain a different, unused address. */
function withAlternateAddress(
  secrets: CeremonySecrets,
  next: () => Promise<string>,
): CeremonySecrets {
  return {
    roles: [...secrets.roles, "alternate-email"],
    resolve: async (role) =>
      role === "alternate-email" ? next() : secrets.resolve(role),
  };
}

/**
 * Start the provider a scenario describes, seeding the accounts its
 * preconditions require. Returns the started double and its context.
 */
export async function startScenario(
  scenario: AuthScenario,
  identity: ScenarioContext["identity"],
  untrusted?: ScenarioContext["untrusted"],
  /** Override the catalog seed to exercise a page shape it never fixed. */
  seed?: number,
): Promise<ScenarioContext> {
  const seededAccounts = scenario.preconditions.includes("account-exists")
    ? existing(identity, scenario.preconditions.includes("account-verified"))
    : [];
  const declared = scenario.behavior(
    untrusted ? { untrustedOrigin: untrusted.origin } : {},
  );
  const provider = await startAuthProvider({
    ...declared,
    ...(seed === undefined ? {} : { seed }),
    accounts: seededAccounts,
  });
  return untrusted ? { provider, identity, untrusted } : { provider, identity };
}
