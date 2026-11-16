/**
 * GitHub App access, from first principles.
 *
 * Four things have to be true before a token can be issued: an account is
 * chosen, Ceremony holds a GitHub App for it, the app is installed there, and
 * a token is minted. Each may already be true, and each can stop being true.
 * The declarations below say what establishes each fact and every way each
 * step can end; the planner derives the order, the skips and the fallbacks.
 */
import {
  blocked,
  defineCeremony,
  established,
  fact,
  invalidates,
  of,
  operator,
  retry,
  terminal,
  unsure,
} from "../ceremony.js";

export interface GitHubTarget {
  readonly login: string;
  readonly kind: "User" | "Organization";
}

export interface GitHubAppCredentials {
  readonly appId: number;
  readonly slug: string;
  readonly privateKey: string;
}

export interface GitHubInstallation {
  readonly installationId: number;
}

export interface GitHubToken {
  readonly token: string;
  readonly expiresAt: string;
}

const facts = {
  target: fact({
    description: "The GitHub account the connection is for has been chosen.",
    value: of<GitHubTarget>(),
    observable: true,
  }),
  appConfig: fact({
    description: "The host configured an existing GitHub App.",
    value: of<GitHubAppCredentials>(),
    observable: true,
    discoverable: true,
    secret: true,
    given: true,
  }),
  manifestCode: fact({
    description:
      "GitHub returned the one-time code for an app the person just created.",
    value: of<string>(),
    requires: ["target"],
    volatile: true,
    secret: true,
  }),
  app: fact({
    description:
      "Ceremony holds working credentials for a GitHub App owned by the target.",
    value: of<GitHubAppCredentials>(),
    requires: ["target"],
    volatile: true,
    observable: true,
    secret: true,
  }),
  installation: fact({
    description:
      "The app is installed on the target, not suspended, with read access to contents.",
    value: of<GitHubInstallation>(),
    requires: ["app"],
    volatile: true,
    observable: true,
    discoverable: true,
  }),
  token: fact({
    description: "Ceremony holds an unexpired installation access token.",
    value: of<GitHubToken>(),
    requires: ["installation"],
    volatile: true,
    observable: true,
    secret: true,
  }),
} as const;

const operators = {
  chooseTarget: operator({
    description: "Ask which GitHub account to connect.",
    establishes: ["target"],
    actor: "human",
    idempotent: true,
    outcomes: {
      chosen: established("The person named an account."),
      declined: terminal("declined", "The person chose not to continue."),
    },
    interface: {
      title: "Choose a GitHub account",
      body: "Ceremony connects one personal account or organization at a time.",
      fields: [{ name: "login", label: "Account name", kind: "text" }],
      actions: [
        {
          id: "continue",
          label: "Continue",
          outcome: "chosen",
          emphasis: "primary",
        },
        {
          id: "cancel",
          label: "Not now",
          outcome: "declined",
          emphasis: "secondary",
        },
      ],
    },
  }),

  adoptConfiguredApp: operator({
    description: "Verify the app the host configured and adopt it.",
    establishes: ["app"],
    requires: ["target", "appConfig"],
    actor: "machine",
    idempotent: true,
    outcomes: {
      adopted: established("The configured app answers and matches."),
      mismatch: blocked(
        "The configured app belongs to another owner or lacks the permission.",
      ),
      rateLimited: retry("GitHub asked the caller to slow down."),
      unavailable: retry("GitHub did not answer."),
    },
  }),

  registerApp: operator({
    description:
      "Hand the person to GitHub to create the app from a prepared manifest.",
    establishes: ["manifestCode"],
    requires: ["target"],
    actor: "human",
    idempotent: false,
    outcomes: {
      created: established("GitHub sent the person back with a code."),
      declined: terminal("declined", "The person chose not to create an app."),
      notPermitted: blocked("The person cannot create apps for this account."),
      abandoned: unsure(
        "The hand-off expired; an app may exist that nobody returned from.",
      ),
    },
    interface: {
      title: "Create the GitHub App",
      body: "GitHub will ask you to confirm a private app that can read repository contents. You come straight back here.",
      shows: ["target"],
      actions: [
        {
          id: "create",
          label: "Create on GitHub",
          outcome: "created",
          emphasis: "primary",
          leavesPage: true,
        },
        {
          id: "cannot",
          label: "I can't create apps here",
          outcome: "notPermitted",
          emphasis: "secondary",
        },
        {
          id: "cancel",
          label: "Not now",
          outcome: "declined",
          emphasis: "secondary",
        },
      ],
    },
  }),

  convertManifest: operator({
    description: "Trade the one-time code for the app's credentials.",
    establishes: ["app"],
    requires: ["manifestCode", "target"],
    consumes: ["manifestCode"],
    actor: "machine",
    idempotent: false,
    outcomes: {
      converted: established("GitHub returned the app's id and key."),
      codeRejected: invalidates(
        ["manifestCode"],
        "The code had expired or was already used.",
      ),
      wrongOwner: terminal(
        "wrong-owner",
        "The app was created under a different account.",
      ),
      rateLimited: retry("GitHub asked the caller to slow down."),
      unavailable: retry("GitHub did not answer."),
      timedOut: unsure("The request was sent and no reply arrived."),
    },
  }),

  installApp: operator({
    description: "Hand the person to GitHub to install the app.",
    establishes: ["installation"],
    requires: ["app"],
    actor: "human",
    idempotent: true,
    outcomes: {
      installed: established("GitHub sent the person back installed."),
      approvalRequested: terminal(
        "awaiting-approval",
        "An organization owner has to approve the installation first.",
      ),
      declined: terminal("declined", "The person chose not to install."),
      appMissing: invalidates(["app"], "GitHub no longer knows the app."),
      abandoned: unsure(
        "The hand-off expired; the app may have been installed anyway.",
      ),
    },
    interface: {
      title: "Install the app",
      body: "Pick the repositories this connection may read. You come straight back here.",
      shows: ["target"],
      actions: [
        {
          id: "install",
          label: "Install on GitHub",
          outcome: "installed",
          emphasis: "primary",
          leavesPage: true,
        },
        {
          id: "cancel",
          label: "Not now",
          outcome: "declined",
          emphasis: "secondary",
        },
      ],
    },
  }),

  mintToken: operator({
    description:
      "Mint an installation access token and check what it can read.",
    establishes: ["token"],
    requires: ["installation", "app"],
    actor: "machine",
    idempotent: true,
    outcomes: {
      minted: established("GitHub issued a token with the permission."),
      installationGone: invalidates(
        ["installation"],
        "The installation was removed, suspended or lost the permission.",
      ),
      appRejected: invalidates(["app"], "GitHub rejected the app's key."),
      rateLimited: retry("GitHub asked the caller to slow down."),
      unavailable: retry("GitHub did not answer."),
      timedOut: unsure("The request was sent and no reply arrived."),
    },
  }),
} as const;

export const githubAppAccess = defineCeremony({
  id: "github-app-access",
  title: "Connect GitHub through a GitHub App",
  facts,
  operators,
  goal: ["token"],
});
