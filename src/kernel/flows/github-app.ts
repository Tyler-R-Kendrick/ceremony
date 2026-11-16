/**
 * GitHub App access, from first principles.
 *
 * Before a token can be issued an account has to be chosen, Ceremony has to
 * hold a GitHub App for it, and the app has to be installed there or the
 * person has to authorize it. Each of those may already be true, and each can
 * stop being true. The declarations say what establishes each fact and every
 * way each step can end; the planner derives the order, the skips and the
 * fallbacks.
 */
import {
  blocked,
  compose,
  established,
  fact,
  fragment,
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

const github = {
  rateLimited: retry("GitHub asked the caller to slow down."),
  unavailable: retry("GitHub did not answer."),
} as const;

/** Choosing the account and holding an app for it. */
export const githubApp = fragment({
  id: "github-app",
  facts: {
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
  },
  operators: {
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
        ...github,
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
        declined: terminal(
          "declined",
          "The person chose not to create an app.",
        ),
        notPermitted: blocked(
          "The person cannot create apps for this account.",
        ),
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
        ...github,
        timedOut: unsure("The request was sent and no reply arrived."),
      },
    }),
  },
});

/** Installing the app and minting an installation token. */
export const githubInstallation = fragment({
  id: "github-installation",
  facts: {
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
  },
  operators: {
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
        ...github,
        timedOut: unsure("The request was sent and no reply arrived."),
      },
    }),
  },
});

/** The person authorizing the app to act for them. */
export const githubUser = fragment({
  id: "github-user",
  facts: {
    userGrant: fact({
      description: "GitHub returned a one-time code for the person's consent.",
      value: of<string>(),
      requires: ["app"],
      volatile: true,
      secret: true,
    }),
    userRefresh: fact({
      description: "Ceremony holds a refresh token for the person.",
      value: of<string>(),
      volatile: true,
      secret: true,
    }),
    userToken: fact({
      description:
        "Ceremony holds an unexpired token that acts for the person.",
      value: of<GitHubToken>(),
      volatile: true,
      observable: true,
      secret: true,
    }),
  },
  operators: {
    authorizeUser: operator({
      description: "Hand the person to GitHub to authorize the app.",
      establishes: ["userGrant"],
      requires: ["app"],
      actor: "human",
      idempotent: true,
      outcomes: {
        approved: established("GitHub sent the person back with a code."),
        denied: terminal("declined", "The person refused the authorization."),
        noBrowser: blocked("This surface cannot open GitHub's consent page."),
        appMissing: invalidates(["app"], "GitHub no longer knows the app."),
        abandoned: retry("The hand-off expired before the person came back."),
      },
      interface: {
        title: "Authorize the app",
        body: "GitHub will ask you to let this connection act for you.",
        shows: ["target"],
        actions: [
          {
            id: "authorize",
            label: "Authorize on GitHub",
            outcome: "approved",
            emphasis: "primary",
            leavesPage: true,
          },
          {
            id: "no-browser",
            label: "I can't open GitHub here",
            outcome: "noBrowser",
            emphasis: "secondary",
          },
          {
            id: "cancel",
            label: "Not now",
            outcome: "denied",
            emphasis: "secondary",
          },
        ],
      },
    }),

    exchangeUserGrant: operator({
      description: "Trade the consent code for the person's tokens.",
      establishes: ["userToken", "userRefresh"],
      requires: ["userGrant", "app"],
      consumes: ["userGrant"],
      actor: "machine",
      idempotent: false,
      outcomes: {
        exchanged: established("GitHub issued the token pair."),
        grantRejected: invalidates(
          ["userGrant"],
          "The code had expired or was already used.",
        ),
        appRejected: invalidates(["app"], "GitHub rejected the app."),
        ...github,
        timedOut: unsure("The request was sent and no reply arrived."),
      },
    }),

    refreshUserToken: operator({
      description: "Use the refresh token to get a new token pair.",
      establishes: ["userToken", "userRefresh"],
      requires: ["userRefresh", "app"],
      actor: "machine",
      idempotent: false,
      outcomes: {
        refreshed: established("GitHub rotated the token pair."),
        refreshRejected: invalidates(
          ["userRefresh"],
          "The refresh token was revoked, expired or already rotated.",
        ),
        appRejected: invalidates(["app"], "GitHub rejected the app."),
        ...github,
        timedOut: unsure("The request was sent and no reply arrived."),
      },
    }),

    authorizeUserByDevice: operator({
      description:
        "Show a code to enter on another device, and wait for the approval.",
      establishes: ["userToken", "userRefresh"],
      requires: ["app"],
      actor: "human",
      idempotent: true,
      cost: 150,
      outcomes: {
        approved: established("The person approved on the other device."),
        denied: terminal("declined", "The person refused the authorization."),
        deviceFlowDisabled: blocked("The app does not allow device sign-in."),
        appMissing: invalidates(["app"], "GitHub no longer knows the app."),
        expired: retry("The code expired before it was entered."),
      },
      interface: {
        title: "Authorize on another device",
        body: "Open github.com/login/device on any device and enter the code shown here.",
        shows: ["target"],
        actions: [
          {
            id: "done",
            label: "I've entered the code",
            outcome: "approved",
            emphasis: "primary",
          },
          {
            id: "cancel",
            label: "Not now",
            outcome: "denied",
            emphasis: "secondary",
          },
        ],
      },
    }),
  },
});

/** Read repositories as the app's installation. */
export const githubAppAccess = compose(
  {
    id: "github-app-access",
    title: "Connect GitHub through a GitHub App",
    goal: ["token"],
  },
  githubApp,
  githubInstallation,
);

/** Act for the person who authorized the app. */
export const githubUserAccess = compose(
  {
    id: "github-user-access",
    title: "Act on GitHub for the person",
    goal: ["userToken"],
  },
  githubApp,
  githubUser,
);
