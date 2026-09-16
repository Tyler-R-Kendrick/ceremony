import { randomBytes } from "node:crypto";
import type {
  BlockedReason,
  CeremonyGoal,
} from "../../../src/core/browser-contracts.js";
import type { FlowKind } from "../../../src/core/schema.js";
import {
  createSecrets,
  type CeremonyPage,
  type CeremonyResult,
  type CeremonyRunOptions,
  type CeremonySecrets,
  type HumanParticipation,
} from "../../../src/server/browser-driver.js";
import { createHumanParticipant } from "../human-participant.js";
import {
  createSignatureKey,
  signRequestHeaders,
  startSignatureDirectory,
  unpublishedKey,
  type SignatureKey,
} from "../web-bot-auth.js";
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
  | "human-available"
  | "account-exists"
  | "account-verified"
  | "account-absent"
  | "address-unused"
  | "disposable-addresses"
  | "mailbox-readable"
  | "registered-client";

/**
 * A specification that is still a draft.
 *
 * A scenario carrying this tracks behaviour that official bodies have proposed
 * but not ratified, so a reader can tell it apart from a settled flow and knows
 * which revision was read. Drafts move; the revision is what makes a later
 * mismatch visible instead of silent.
 */
export type ProposedSpec = {
  /** Internet-Draft name, without the revision suffix. */
  draft: string;
  /** The revision this scenario was written against, e.g. "02". */
  revision: string;
  title: string;
};

export type ScenarioExpectation = { handoffs?: number } & (
  | { status: "completed"; callback?: boolean }
  | { status: "blocked"; reason: BlockedReason }
  | { status: "stalled" }
  | { status: "exhausted" }
  | { status: "unverified" }
);

export type ScenarioContext = {
  provider: ProviderDouble;
  /**
   * The agent's signing identity and published key directory, when the
   * scenario needs one. Signing belongs to the client an agent runs in, not to
   * the ceremony, so the runner configures it before the first navigation and
   * the driver never sees it.
   */
  signing?: {
    key: SignatureKey;
    directory: { origin: string; reads(): number };
  };
  /** Release everything the scenario started. */
  close(): Promise<void>;
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
  nonce?: string;
  address?: string;
  client?: string;
  resource?: string;
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
  /**
   * The normative flow kind this scenario exercises. Every kind in
   * `flowKinds` must be covered; a coverage test fails when one is not.
   */
  flowKind: FlowKind;
  goal: CeremonyGoal;
  /**
   * Set when the scenario tracks an unratified draft rather than a settled
   * specification. Nothing here claims a provider implements it.
   */
  proposed?: ProposedSpec;
  preconditions: readonly ScenarioPrecondition[];
  /** Roles the caller must be able to supply for this ceremony to be possible. */
  provides: readonly string[];
  behavior: (context: { untrustedOrigin?: string }) => ProviderBehavior;
  /** Whether the scenario needs the untrusted origin started. */
  needsUntrustedOrigin?: boolean;
  /** Whether the scenario needs a signing key and a published directory. */
  needsSignatureDirectory?: boolean;
  /**
   * Headers the agent's HTTP client carries on every request, computed once
   * the provider is up because a signature covers the host it is sent to.
   */
  clientHeaders?: (context: ScenarioContext) => Record<string, string>;
  /**
   * A person who takes part when the browser cannot finish a step. Built from
   * the live page, because a handoff means acting in that same browser.
   */
  human?: (
    page: CeremonyPage,
    identity: ScenarioContext["identity"],
  ) => HumanParticipation;
  /**
   * Excluded from the browser runner, with the reason. Only for steps a real
   * browser genuinely cannot host under Playwright, never for convenience.
   */
  browserRunnerSkip?: string;
  plan: (context: ScenarioContext) => ScenarioPlan | Promise<ScenarioPlan>;
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

/** The agent these delegated-authorization scenarios act as. */
const agentId = "urn:ceremony:agent:filing-assistant";

const webBotAuth: ProposedSpec = {
  draft: "draft-meunier-webbotauth-httpsig-protocol",
  revision: "02",
  title: "HTTP Message Signatures for automated traffic",
};

const onBehalfOfUser: ProposedSpec = {
  draft: "draft-oauth-ai-agents-on-behalf-of-user",
  revision: "02",
  title: "OAuth 2.0 Extension: On-Behalf-Of User Authorization for AI Agents",
};

export const authScenarios: readonly AuthScenario[] = [
  {
    id: "sign-in",
    title: "an existing verified account signs in",
    family: "Forms/session auth",
    flowKind: "form",
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
    flowKind: "form",
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
    flowKind: "form",
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
    flowKind: "form",
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
    flowKind: "form",
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
    flowKind: "form",
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
    flowKind: "form",
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
    flowKind: "form",
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
    flowKind: "form",
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
    flowKind: "form",
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
    flowKind: "form",
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
    flowKind: "form",
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
    flowKind: "form",
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
    flowKind: "form",
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
    flowKind: "oauth-code",
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
    flowKind: "oauth-code",
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
    flowKind: "oauth-code",
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
    flowKind: "device",
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
    flowKind: "form",
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
    flowKind: "form",
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
    flowKind: "form",
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
  {
    id: "challenge-cleared-by-a-person",
    title:
      "a challenge is handed to a person, who clears it and the run resumes",
    family: "Forms/session auth",
    flowKind: "form",
    goal: "sign-in",
    preconditions: ["account-exists", "account-verified", "human-available"],
    provides: ["username", "password"],
    behavior: () => ({
      seed: 71,
      challengeAt: "sign-in",
      challengeClearable: true,
    }),
    human: (page) => createHumanParticipant(page),
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}/signin`,
      goal: "sign-in",
      secrets: signInSecrets(identity),
      allowedOrigins: [provider.origin],
      protectedValues: [identity.password],
      verify: () => provider.verifyAccess(identity.email),
    }),
    expect: { status: "completed", handoffs: 1 },
  },
  {
    id: "challenge-declined-by-a-person",
    title: "a person who refuses to take part ends the attempt as a refusal",
    family: "Forms/session auth",
    flowKind: "form",
    goal: "sign-in",
    preconditions: ["account-exists", "account-verified", "human-available"],
    provides: ["username", "password"],
    behavior: () => ({
      seed: 72,
      challengeAt: "sign-in",
      challengeClearable: true,
    }),
    human: (page) => createHumanParticipant(page, { decline: true }),
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}/signin`,
      goal: "sign-in",
      secrets: signInSecrets(identity),
      allowedOrigins: [provider.origin],
      protectedValues: [identity.password],
      verify: () => provider.verifyAccess(identity.email),
    }),
    expect: { status: "blocked", reason: "human-declined" },
    confirm: async ({ provider, identity }) => {
      if (await provider.verifyAccess(identity.email))
        throw new Error("A refusal must not leave a session");
    },
  },
  {
    id: "challenge-claimed-without-clearing-it",
    title: "a person's claim to have finished is checked, not believed",
    family: "Forms/session auth",
    flowKind: "form",
    goal: "sign-in",
    preconditions: ["account-exists", "account-verified", "human-available"],
    provides: ["username", "password"],
    // The widget is never cleared, so the page a person says they finished is
    // still the page the agent finds when it resumes.
    behavior: () => ({ seed: 73, challengeAt: "sign-in" }),
    human: (page) => createHumanParticipant(page, { claimOnly: true }),
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}/signin`,
      goal: "sign-in",
      secrets: signInSecrets(identity),
      allowedOrigins: [provider.origin],
      protectedValues: [identity.password],
      verify: () => provider.verifyAccess(identity.email),
    }),
    expect: { status: "blocked", reason: "human-challenge", handoffs: 2 },
    confirm: async ({ provider, identity }) => {
      if (await provider.verifyAccess(identity.email))
        throw new Error("An unfulfilled claim must not create access");
    },
  },
  {
    id: "passkey-handed-to-a-person",
    title: "a passkey prompt with nothing to fill is completed by a person",
    family: "Passkeys / WebAuthn",
    flowKind: "form",
    goal: "sign-in",
    preconditions: ["account-exists", "account-verified", "human-available"],
    provides: ["username", "password"],
    behavior: () => ({ seed: 74, passkeyOnly: true }),
    human: (page) => createHumanParticipant(page),
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}/signin`,
      goal: "sign-in",
      secrets: signInSecrets(identity),
      allowedOrigins: [provider.origin],
      protectedValues: [identity.password],
      verify: () => provider.verifyAccess(identity.email),
    }),
    expect: { status: "completed", handoffs: 1 },
  },
  {
    id: "passkey-required-with-nobody-to-ask",
    title: "a passkey prompt is named as the wall when no person is available",
    family: "Passkeys / WebAuthn",
    flowKind: "form",
    goal: "sign-in",
    preconditions: ["account-exists", "account-verified"],
    provides: ["username", "password"],
    behavior: () => ({ seed: 75, passkeyOnly: true }),
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}/signin`,
      goal: "sign-in",
      secrets: signInSecrets(identity),
      allowedOrigins: [provider.origin],
      protectedValues: [identity.password],
    }),
    expect: { status: "blocked", reason: "passkey-required", handoffs: 0 },
  },
  {
    id: "conditional-passkey-needs-no-person",
    title: "a passkey hint beside a password box is driven without a handoff",
    family: "Passkeys / WebAuthn",
    flowKind: "form",
    goal: "sign-in",
    preconditions: ["account-exists", "account-verified", "human-available"],
    provides: ["username", "password"],
    behavior: () => ({ seed: 76, conditionalPasskey: true }),
    human: (page) => createHumanParticipant(page),
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}/signin`,
      goal: "sign-in",
      secrets: signInSecrets(identity),
      allowedOrigins: [provider.origin],
      protectedValues: [identity.password],
      verify: () => provider.verifyAccess(identity.email),
    }),
    // Conditional UI still accepts a password. Asking a person here would be
    // an interruption the ceremony did not need.
    expect: { status: "completed", handoffs: 0 },
  },
  {
    id: "basic-dialog-answered-by-a-person",
    title: "an HTTP Basic dialog is answered by a person, not scraped",
    family: "HTTP Basic",
    flowKind: "basic",
    goal: "sign-in",
    preconditions: ["account-exists", "account-verified", "human-available"],
    provides: [],
    behavior: () => ({ seed: 77, basicRealm: "ceremony" }),
    browserRunnerSkip:
      "A browser credential dialog is chrome, not page content; Playwright answers it through context configuration rather than the page.",
    human: (page, identity) =>
      createHumanParticipant(page, {
        credentials: {
          username: identity.username,
          password: identity.password,
        },
      }),
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}/basic`,
      goal: "sign-in",
      // The agent holds nothing: the dialog is answered by the person, and the
      // browser keeps the credentials afterwards.
      secrets: createSecrets({}),
      allowedOrigins: [provider.origin],
      verify: async () =>
        provider.authenticatedBasic().includes(identity.email.toLowerCase()),
    }),
    expect: { status: "completed", handoffs: 1 },
    confirm: async ({ provider, identity }, result) => {
      if (JSON.stringify(result.transcript).includes(identity.password))
        throw new Error("The dialog password reached the transcript");
      if (!provider.authenticatedBasic().length)
        throw new Error("The resource must have authenticated the account");
    },
  },
  {
    id: "basic-dialog-with-nobody-to-ask",
    title:
      "an HTTP Basic dialog is named as the wall when no person is available",
    family: "HTTP Basic",
    flowKind: "basic",
    goal: "sign-in",
    preconditions: ["account-exists", "account-verified"],
    provides: [],
    behavior: () => ({ seed: 78, basicRealm: "ceremony" }),
    browserRunnerSkip:
      "A browser credential dialog is chrome, not page content; Playwright answers it through context configuration rather than the page.",
    plan: ({ provider }) => ({
      entryUrl: `${provider.origin}/basic`,
      goal: "sign-in",
      secrets: createSecrets({}),
      allowedOrigins: [provider.origin],
    }),
    expect: { status: "blocked", reason: "native-dialog", handoffs: 0 },
  },
  {
    id: "access-token-issued-for-private-collection",
    title: "an agent causes a token to be issued but never carries its value",
    family: "API key / personal access token",
    flowKind: "api-key",
    goal: "obtain-credential",
    preconditions: ["account-exists", "account-verified"],
    // Naming the credential is part of the ceremony: a real provider will not
    // issue one without it, and a browser refuses to submit the form.
    provides: ["username", "password", "display-name"],
    behavior: () => ({ seed: 79 }),
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}/tokens`,
      goal: "obtain-credential",
      secrets: withDisplayName(signInSecrets(identity), "Ceremony access"),
      allowedOrigins: [provider.origin],
      protectedValues: [identity.password],
      // The ceremony's outcome is that a token now exists. Its value is shown
      // on the page for a person to place in a private collector; nothing the
      // agent holds or records may contain it.
      verify: async () => provider.issuedTokens().length === 1,
    }),
    expect: { status: "completed" },
    confirm: async ({ provider }, result) => {
      const [issued] = provider.issuedTokens();
      if (!issued) throw new Error("No token was issued");
      if (JSON.stringify(result.transcript).includes(issued))
        throw new Error("The token value reached the transcript");
    },
  },
  {
    id: "anonymous-access-then-claim",
    title: "anonymous access is taken, then claimed with an emailed code",
    family: "auth.md anonymous + claim",
    flowKind: "authmd-anonymous",
    goal: "registration",
    preconditions: ["account-absent", "mailbox-readable"],
    provides: ["email", "verification-code"],
    behavior: () => ({ seed: 81 }),
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}/anonymous`,
      goal: "registration",
      secrets: createSecrets({
        email: identity.email,
        "verification-code": async () =>
          (await provider.mailbox.waitFor(identity.email))?.code ?? "",
      }),
      allowedOrigins: [provider.origin],
      maxSteps: 30,
    }),
    expect: { status: "unverified" },
    confirm: async ({ provider, identity }) => {
      // Anonymous access and the claim are tracked separately: the claim is
      // what the mailbox proves, and it is the provider that records it.
      if (!provider.mailbox.messages().some((m) => m.to === identity.email))
        throw new Error("The claim must have been sent to the given address");
      if (!provider.accounts().some((account) => account.verified))
        throw new Error("The claim must have completed at the provider");
    },
  },
  {
    id: "application-registered-and-installed",
    title: "an application is registered and then installed by its owner",
    family: "github-app",
    flowKind: "github-app",
    goal: "authorize",
    preconditions: ["account-exists", "account-verified"],
    provides: ["username", "password", "display-name"],
    behavior: () => ({ seed: 82 }),
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}/apps/new`,
      goal: "authorize",
      secrets: withDisplayName(signInSecrets(identity), "Ceremony application"),
      allowedOrigins: [provider.origin],
      protectedValues: [identity.password],
      maxSteps: 30,
      verify: async () => provider.installed().length === 1,
    }),
    expect: { status: "completed" },
    confirm: async ({ provider }) => {
      if (provider.installed().length !== 1)
        throw new Error("Exactly one installation must exist");
    },
  },
  {
    id: "openid-connect-identity",
    title: "consent returns a code that redeems an ID token bound to the nonce",
    family: "OpenID Connect",
    flowKind: "oauth-code",
    goal: "authorize",
    preconditions: ["account-exists", "account-verified", "registered-client"],
    provides: ["username", "password"],
    behavior: () => ({ seed: 83, openidConnect: true }),
    plan: ({ provider, identity }) => {
      const request = provider.authorization({ scope: "openid profile" });
      return {
        entryUrl: request.url,
        goal: "authorize",
        secrets: signInSecrets(identity),
        allowedOrigins: [provider.origin],
        redirectUri: provider.redirectUri,
        protectedValues: [identity.password],
        state: {
          verifier: request.verifier,
          state: request.state,
          nonce: request.nonce,
        },
      };
    },
    expect: { status: "completed", callback: true },
    confirm: async ({ provider, identity }, result, state) => {
      if (result.status !== "completed" || !result.callback)
        throw new Error("An identity ceremony must return a code");
      const redeemed = await provider.exchange(
        result.callback.code,
        state.verifier ?? "",
      );
      const identityToken = redeemed.body["id_token"];
      if (typeof identityToken !== "string")
        throw new Error("An OpenID ceremony must return an ID token");
      const claims = await provider.verifyIdToken(identityToken);
      if (!claims) throw new Error("The ID token must verify");
      if (claims.nonce !== state.nonce)
        throw new Error("The ID token must be bound to the request nonce");
      if (claims.sub.toLowerCase() !== identity.email.toLowerCase())
        throw new Error(
          "The ID token must identify the account that consented",
        );
    },
  },
  {
    id: "saml-post-binding",
    title: "a federated assertion is posted back and accepted",
    family: "SAML federation",
    flowKind: "form",
    goal: "sign-in",
    preconditions: ["account-exists", "account-verified"],
    provides: ["username", "password"],
    behavior: () => ({ seed: 84 }),
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}/saml/login?RelayState=r-1`,
      goal: "sign-in",
      secrets: signInSecrets(identity),
      allowedOrigins: [provider.origin],
      protectedValues: [identity.password],
      maxSteps: 30,
      verify: async () => provider.federated().length === 1,
    }),
    expect: { status: "completed" },
    confirm: async ({ provider, identity }) => {
      if (!provider.federated().includes(identity.email.toLowerCase()))
        throw new Error("The assertion must identify the signed-in account");
    },
  },
  {
    id: "mcp-authorization-with-resource-binding",
    title:
      "a dynamically registered client authorizes against a named resource",
    family: "MCP HTTP authorization",
    flowKind: "oauth-code",
    goal: "authorize",
    preconditions: ["account-exists", "account-verified", "registered-client"],
    provides: ["username", "password"],
    behavior: () => ({ seed: 86, dynamicRegistration: true }),
    plan: async ({ provider, identity }) => {
      // Discovery and registration are the client's own HTTP work, exactly as
      // an MCP client performs them before any browser step exists.
      const metadata = (await (
        await fetch(`${provider.origin}/.well-known/oauth-protected-resource`)
      ).json()) as { resource: string; authorization_servers: string[] };
      // The registration endpoint comes from discovery, never a guessed path:
      // a provider is free to serve its sign-up page at /register.
      const discovery = (await (
        await fetch(`${provider.origin}/.well-known/openid-configuration`)
      ).json()) as { registration_endpoint?: string };
      if (!discovery.registration_endpoint)
        throw new Error("The provider must advertise dynamic registration");
      const registered = (await (
        await fetch(discovery.registration_endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ redirect_uris: [provider.redirectUri] }),
        })
      ).json()) as { client_id: string };
      const request = provider.authorization({
        clientId: registered.client_id,
        resource: metadata.resource,
      });
      return {
        entryUrl: request.url,
        goal: "authorize",
        secrets: signInSecrets(identity),
        allowedOrigins: [provider.origin],
        redirectUri: provider.redirectUri,
        protectedValues: [identity.password],
        state: {
          verifier: request.verifier,
          state: request.state,
          client: request.clientId,
          resource: metadata.resource,
        },
      };
    },
    expect: { status: "completed", callback: true },
    confirm: async ({ provider }, result, state) => {
      if (result.status !== "completed" || !result.callback)
        throw new Error("MCP authorization must return a code");
      const redeemed = await provider.exchange(
        result.callback.code,
        state.verifier ?? "",
      );
      if (redeemed.body["aud"] !== state.resource)
        throw new Error("The token must be bound to the requested resource");
      if (redeemed.body["client_id"] !== state.client)
        throw new Error("The token must belong to the registered client");
    },
  },
  {
    id: "public-resource-needs-no-ceremony",
    title: "a resource that needs no authentication claims no identity",
    family: "Public / no authentication",
    flowKind: "form",
    goal: "sign-in",
    preconditions: [],
    provides: [],
    behavior: () => ({ seed: 85 }),
    plan: ({ provider }) => ({
      entryUrl: `${provider.origin}/public`,
      goal: "sign-in",
      secrets: createSecrets({}),
      allowedOrigins: [provider.origin],
      // Nothing was authenticated, so nothing may be claimed. Reaching a public
      // page is not access, and the run must not pretend otherwise.
      verify: async () => false,
    }),
    expect: { status: "unverified", handoffs: 0 },
    confirm: async ({ provider }) => {
      if (provider.accounts().length !== 0)
        throw new Error("A public resource must not create an account");
    },
  },
  {
    id: "delegated-authorization",
    title: "consent names the agent, and the token says who is acting",
    family: "OAuth delegated actor (proposed)",
    flowKind: "oauth-code",
    goal: "authorize",
    proposed: onBehalfOfUser,
    preconditions: ["account-exists", "account-verified", "registered-client"],
    provides: ["username", "password"],
    behavior: () => ({
      seed: 87,
      delegation: true,
      knownActors: [agentId],
    }),
    plan: ({ provider, identity }) => {
      const request = provider.authorization({ actor: agentId });
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
        throw new Error("A delegated authorization must return a code");
      const redeemed = await provider.exchange(
        result.callback.code,
        state.verifier ?? "",
        { actorToken: await provider.actorToken(agentId) },
      );
      if (redeemed.status !== 200)
        throw new Error("An authenticated agent must be able to redeem");
      const token = await provider.readAccessToken(
        String(redeemed.body["access_token"] ?? ""),
      );
      // The point of the draft: the token records that the agent acted, and
      // for whom. A token without `act` is an ordinary user token.
      if (token?.act?.sub !== agentId)
        throw new Error("The issued token must name the acting agent");
      if (!token.sub)
        throw new Error("The issued token must still name the user");
    },
  },
  {
    id: "delegated-authorization-needs-the-agent-to-authenticate",
    title: "an approved code alone does not buy a delegated token",
    family: "OAuth delegated actor (proposed)",
    flowKind: "oauth-code",
    goal: "authorize",
    proposed: onBehalfOfUser,
    preconditions: ["account-exists", "account-verified", "registered-client"],
    provides: ["username", "password"],
    behavior: () => ({
      seed: 88,
      delegation: true,
      knownActors: [agentId],
    }),
    plan: ({ provider, identity }) => {
      const request = provider.authorization({ actor: agentId });
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
    // The ceremony genuinely completes: a person approved and a code came
    // back. Whether the agent may use it is a separate question, answered at
    // the token endpoint, and the two must not be conflated.
    expect: { status: "completed", callback: true },
    confirm: async ({ provider }, result, state) => {
      if (result.status !== "completed" || !result.callback)
        throw new Error("A delegated authorization must return a code");
      const bare = await provider.exchange(
        result.callback.code,
        state.verifier ?? "",
      );
      if (bare.status === 200)
        throw new Error("A code for an actor must not redeem unauthenticated");
      const impostor = await provider.exchange(
        result.callback.code,
        state.verifier ?? "",
        { actorToken: await provider.actorToken("urn:ceremony:agent:other") },
      );
      if (impostor.status === 200)
        throw new Error("A different agent must not redeem this code");
      const forged = await provider.exchange(
        result.callback.code,
        state.verifier ?? "",
        { actorToken: await provider.actorToken(agentId, { issuer: "wrong" }) },
      );
      if (forged.status === 200)
        throw new Error("A self-signed actor token must not be accepted");
      // The refusals must not have spent the code: the real agent still works.
      const genuine = await provider.exchange(
        result.callback.code,
        state.verifier ?? "",
        { actorToken: await provider.actorToken(agentId) },
      );
      if (genuine.status !== 200)
        throw new Error("A refused attempt must not consume the grant");
    },
  },
  {
    id: "delegated-authorization-unknown-agent",
    title: "an agent the provider does not know is refused before consent",
    family: "OAuth delegated actor (proposed)",
    flowKind: "oauth-code",
    goal: "authorize",
    proposed: onBehalfOfUser,
    preconditions: ["account-exists", "account-verified", "registered-client"],
    provides: ["username", "password"],
    behavior: () => ({
      seed: 89,
      delegation: true,
      knownActors: ["urn:ceremony:agent:someone-else"],
    }),
    plan: ({ provider, identity }) => {
      const request = provider.authorization({ actor: agentId });
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
    // Not a denied consent: nobody was asked. The provider rejected the
    // request, and reporting that as a refusal would misplace the blame.
    expect: { status: "blocked", reason: "provider-error" },
    confirm: async ({ provider }) => {
      if (provider.issuedTokens().length !== 0)
        throw new Error("A refused delegation must issue nothing");
    },
  },
  {
    id: "signed-agent-passes-the-bot-gate",
    title: "a signed request reaches the sign-in page without asking anyone",
    family: "Signed agent identity (proposed)",
    flowKind: "form",
    goal: "sign-in",
    proposed: webBotAuth,
    preconditions: ["account-exists", "account-verified"],
    provides: ["username", "password"],
    needsSignatureDirectory: true,
    behavior: () => ({ seed: 90, requireSignature: true }),
    clientHeaders: ({ provider, signing }) =>
      signing
        ? signRequestHeaders(
            signing.key,
            new URL(provider.origin).host,
            signing.directory.origin,
          )
        : {},
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}/signin`,
      goal: "sign-in",
      secrets: signInSecrets(identity),
      allowedOrigins: [provider.origin],
      protectedValues: [identity.password],
      verify: () => provider.verifyAccess(identity.email),
    }),
    // The gate is invisible when it passes, which is the point: an agent the
    // site recognises does not cost a person anything.
    expect: { status: "completed", handoffs: 0 },
    confirm: async ({ provider, signing }) => {
      const verdicts = provider.signatureVerdicts();
      if (verdicts.length === 0)
        throw new Error("The gate must have inspected the request");
      if (!verdicts.every((verdict) => verdict.ok))
        throw new Error("Every request in a signed ceremony must verify");
      if ((signing?.directory.reads() ?? 0) === 0)
        throw new Error("The origin must have read the agent's directory");
    },
  },
  {
    id: "unsigned-agent-meets-the-bot-gate",
    title: "an unsigned agent is put in front of a person, not turned away",
    family: "Signed agent identity (proposed)",
    flowKind: "form",
    goal: "sign-in",
    proposed: webBotAuth,
    preconditions: ["human-available", "account-exists", "account-verified"],
    provides: ["username", "password"],
    behavior: () => ({
      seed: 91,
      requireSignature: true,
      challengeClearable: true,
    }),
    // No signature at all: this is the same agent arriving without the key.
    human: (page) => createHumanParticipant(page),
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}/signin`,
      goal: "sign-in",
      secrets: signInSecrets(identity),
      allowedOrigins: [provider.origin],
      protectedValues: [identity.password],
      verify: () => provider.verifyAccess(identity.email),
    }),
    // The fork: same goal, same provider, one path costing a person's time.
    expect: { status: "completed", handoffs: 1 },
    confirm: async ({ provider }) => {
      const verdicts = provider.signatureVerdicts();
      if (!verdicts.some((verdict) => !verdict.ok && verdict.why === "absent"))
        throw new Error("The gate must have found no signature to check");
    },
  },
  {
    id: "expired-signature-is-not-a-signature",
    title: "a lapsed signature costs a person the same work as none",
    family: "Signed agent identity (proposed)",
    flowKind: "form",
    goal: "sign-in",
    proposed: webBotAuth,
    preconditions: ["human-available", "account-exists", "account-verified"],
    provides: ["username", "password"],
    needsSignatureDirectory: true,
    behavior: () => ({
      seed: 92,
      requireSignature: true,
      challengeClearable: true,
    }),
    clientHeaders: ({ provider, signing }) =>
      signing
        ? signRequestHeaders(
            signing.key,
            new URL(provider.origin).host,
            signing.directory.origin,
            // Created and expired well before this request was made.
            { ageSeconds: 3_600, lifetimeSeconds: 60 },
          )
        : {},
    human: (page) => createHumanParticipant(page),
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}/signin`,
      goal: "sign-in",
      secrets: signInSecrets(identity),
      allowedOrigins: [provider.origin],
      protectedValues: [identity.password],
      verify: () => provider.verifyAccess(identity.email),
    }),
    expect: { status: "completed", handoffs: 1 },
    confirm: async ({ provider }) => {
      if (
        !provider
          .signatureVerdicts()
          .some((verdict) => !verdict.ok && verdict.why === "expired")
      )
        throw new Error("A lapsed signature must be refused as expired");
    },
  },
  {
    id: "unknown-signing-key-is-refused",
    title: "a signature from a key the directory never published is refused",
    family: "Signed agent identity (proposed)",
    flowKind: "form",
    goal: "sign-in",
    proposed: webBotAuth,
    preconditions: ["account-exists", "account-verified"],
    provides: ["username", "password"],
    needsSignatureDirectory: true,
    behavior: () => ({ seed: 93, requireSignature: true }),
    clientHeaders: ({ provider, signing }) =>
      signing
        ? signRequestHeaders(
            signing.key,
            new URL(provider.origin).host,
            signing.directory.origin,
            // A well-formed signature the published key cannot account for.
            { signWith: unpublishedKey() },
          )
        : {},
    plan: ({ provider, identity }) => ({
      entryUrl: `${provider.origin}/signin`,
      goal: "sign-in",
      secrets: signInSecrets(identity),
      allowedOrigins: [provider.origin],
      protectedValues: [identity.password],
      verify: () => provider.verifyAccess(identity.email),
    }),
    // Nobody to ask and a wall that cannot be cleared: the honest outcome is
    // to name the obstacle rather than keep trying or claim access.
    expect: { status: "blocked", reason: "human-challenge", handoffs: 0 },
    confirm: async ({ provider, identity }) => {
      if (
        !provider
          .signatureVerdicts()
          .some((verdict) => !verdict.ok && verdict.why === "bad-signature")
      )
        throw new Error("An unpublished key must fail signature verification");
      if (await provider.verifyAccess(identity.email))
        throw new Error("A refused agent must not have signed in");
    },
  },
];

/** Supply the name a provider requires for the thing a ceremony creates. */
function withDisplayName(
  secrets: CeremonySecrets,
  name: string,
): CeremonySecrets {
  return {
    roles: [...secrets.roles, "display-name"],
    resolve: async (role) =>
      role === "display-name" ? name : secrets.resolve(role),
  };
}

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
  const key = scenario.needsSignatureDirectory
    ? createSignatureKey()
    : undefined;
  const directory = key ? await startSignatureDirectory([key]) : undefined;
  const close = async () => {
    await provider.close();
    await directory?.close();
  };
  return {
    provider,
    identity,
    close,
    ...(untrusted ? { untrusted } : {}),
    ...(key && directory ? { signing: { key, directory } } : {}),
  };
}
