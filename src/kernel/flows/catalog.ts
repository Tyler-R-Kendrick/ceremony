/**
 * The auth families, each as facts and operators.
 *
 * These are models of the protocols, not adapters for a vendor: what has to
 * be true, what makes it true, and every way each step can end. A connector
 * binds a family to a provider by supplying adapters for its machine steps.
 * The families share fact names where they share meaning (`session`,
 * `accessToken`), so they compose into fallbacks by union.
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
  type InterfaceField,
} from "../ceremony.js";

const network = {
  rateLimited: retry("The provider asked the caller to slow down."),
  unavailable: retry("The provider did not answer."),
} as const;

const lostReply = {
  timedOut: unsure("The request was sent and no reply arrived."),
} as const;

const cancel = {
  id: "cancel",
  label: "Not now",
  outcome: "declined",
  emphasis: "secondary",
} as const;

/**
 * A secret the person already has: an API key, a personal access token, a
 * username and password for Basic. Collected privately, then proved by use.
 */
function suppliedCredential<const Id extends string>(spec: {
  readonly id: Id;
  readonly title: string;
  readonly ask: string;
  readonly fields: readonly InterfaceField[];
}) {
  return defineCeremony({
    id: spec.id,
    title: spec.title,
    facts: {
      entered: fact({
        description: "The person entered the secret.",
        value: of<Readonly<Record<string, string>>>(),
        volatile: true,
        secret: true,
      }),
      credential: fact({
        description: "Ceremony holds a secret the provider accepts.",
        value: of<Readonly<Record<string, string>>>(),
        volatile: true,
        observable: true,
        secret: true,
      }),
    },
    operators: {
      collect: operator({
        description: "Ask the person for the secret, in a private field.",
        establishes: ["entered"],
        actor: "human",
        idempotent: true,
        outcomes: {
          entered: established("The person submitted the secret."),
          declined: terminal("declined", "The person chose not to provide it."),
        },
        interface: {
          title: spec.title,
          body: spec.ask,
          fields: spec.fields,
          actions: [
            {
              id: "submit",
              label: "Connect",
              outcome: "entered",
              emphasis: "primary",
            },
            cancel,
          ],
        },
      }),
      verify: operator({
        description: "Make one harmless call with the secret.",
        establishes: ["credential"],
        requires: ["entered"],
        consumes: ["entered"],
        actor: "machine",
        idempotent: true,
        outcomes: {
          accepted: established("The provider accepted the secret."),
          rejected: invalidates(
            ["entered"],
            "The provider refused the secret.",
          ),
          ...network,
        },
      }),
    },
    goal: ["credential"],
  });
}

export const apiKey = suppliedCredential({
  id: "api-key",
  title: "Connect with an API key",
  ask: "Paste a key for this service. It is stored encrypted and never shown again.",
  fields: [{ name: "key", label: "API key", kind: "secret" }],
});

export const httpBasic = suppliedCredential({
  id: "http-basic",
  title: "Connect with a username and password",
  ask: "Enter the account this connection should use.",
  fields: [
    { name: "username", label: "Username", kind: "text" },
    { name: "password", label: "Password", kind: "secret" },
  ],
});

const oauthFacts = {
  client: fact({
    description: "Ceremony is registered as a client of the provider.",
    value: of<{ readonly clientId: string }>(),
    observable: true,
    discoverable: true,
    volatile: true,
  }),
  refreshToken: fact({
    description: "Ceremony holds a refresh token.",
    value: of<string>(),
    volatile: true,
    secret: true,
  }),
  accessToken: fact({
    description: "Ceremony holds an unexpired access token.",
    value: of<{ readonly token: string; readonly expiresAt: string }>(),
    volatile: true,
    observable: true,
    secret: true,
  }),
} as const;

const registerClient = operator({
  description: "Register a client with the provider's registration endpoint.",
  establishes: ["client"],
  actor: "machine",
  idempotent: false,
  outcomes: {
    registered: established("The provider issued a client id."),
    unsupported: blocked("The provider has no dynamic client registration."),
    ...network,
    ...lostReply,
  },
});

const refresh = operator({
  description: "Use the refresh token to get a new access token.",
  establishes: ["accessToken", "refreshToken"],
  requires: ["refreshToken", "client"],
  actor: "machine",
  idempotent: false,
  outcomes: {
    refreshed: established("The provider issued a new token pair."),
    refreshRejected: invalidates(
      ["refreshToken"],
      "The refresh token was revoked, expired or already rotated.",
    ),
    clientRejected: invalidates(
      ["client"],
      "The provider no longer knows the client.",
    ),
    ...network,
    ...lostReply,
  },
});

/** OAuth 2.0 authorization code with PKCE, refresh and optional registration. */
export const oauthAuthorizationCode = defineCeremony({
  id: "oauth-authorization-code",
  title: "Sign in with the provider (authorization code with PKCE)",
  facts: {
    ...oauthFacts,
    authorizationCode: fact({
      description: "The provider returned a one-time code with matching state.",
      value: of<{ readonly code: string; readonly verifier: string }>(),
      requires: ["client"],
      volatile: true,
      secret: true,
    }),
  },
  operators: {
    registerClient,
    refresh,
    authorize: operator({
      description: "Hand the person to the provider's consent page.",
      establishes: ["authorizationCode"],
      requires: ["client"],
      actor: "human",
      idempotent: true,
      outcomes: {
        approved: established(
          "The provider sent the person back with a code and the expected state.",
        ),
        declined: terminal("declined", "The person refused the request."),
        stateMismatch: retry(
          "The return did not carry the state that was sent.",
        ),
        clientRejected: invalidates(
          ["client"],
          "The provider no longer knows the client.",
        ),
        abandoned: retry("The hand-off expired before the person came back."),
      },
      interface: {
        title: "Approve access",
        body: "The provider will ask you to sign in and approve what this connection may do.",
        actions: [
          {
            id: "continue",
            label: "Continue to the provider",
            outcome: "approved",
            emphasis: "primary",
            leavesPage: true,
          },
          cancel,
        ],
      },
    }),
    exchangeCode: operator({
      description: "Trade the code and verifier for tokens.",
      establishes: ["accessToken", "refreshToken"],
      requires: ["authorizationCode", "client"],
      consumes: ["authorizationCode"],
      actor: "machine",
      idempotent: false,
      outcomes: {
        exchanged: established("The provider issued the token pair."),
        codeRejected: invalidates(
          ["authorizationCode"],
          "The code had expired or was already used.",
        ),
        clientRejected: invalidates(
          ["client"],
          "The provider no longer knows the client.",
        ),
        ...network,
        ...lostReply,
      },
    }),
  },
  goal: ["accessToken"],
});

/** OAuth 2.0 device authorization grant: approve on another device. */
export const oauthDevice = defineCeremony({
  id: "oauth-device",
  title: "Sign in on another device",
  facts: {
    ...oauthFacts,
    deviceGrant: fact({
      description: "The provider issued a device code and a code to show.",
      value: of<{
        readonly userCode: string;
        readonly verificationUri: string;
      }>(),
      requires: ["client"],
      volatile: true,
    }),
  },
  operators: {
    registerClient,
    refresh,
    startDevice: operator({
      description: "Ask the provider for a device code.",
      establishes: ["deviceGrant"],
      requires: ["client"],
      actor: "machine",
      idempotent: true,
      outcomes: {
        started: established("The provider issued a device code."),
        unsupported: blocked("The provider has no device authorization."),
        clientRejected: invalidates(
          ["client"],
          "The provider no longer knows the client.",
        ),
        ...network,
      },
    }),
    approveOnDevice: operator({
      description:
        "Show the code, wait for the approval, and collect the tokens.",
      establishes: ["accessToken", "refreshToken"],
      requires: ["deviceGrant"],
      actor: "human",
      idempotent: true,
      outcomes: {
        approved: established("The person approved and the tokens arrived."),
        declined: terminal("declined", "The person refused the request."),
        expired: invalidates(
          ["deviceGrant"],
          "The code expired before it was entered.",
        ),
      },
      interface: {
        title: "Enter this code on another device",
        body: "Open the address shown on any device and enter the code.",
        shows: ["deviceGrant"],
        actions: [
          {
            id: "done",
            label: "I've entered the code",
            outcome: "approved",
            emphasis: "primary",
          },
          cancel,
        ],
      },
    }),
  },
  goal: ["accessToken"],
});

/** OAuth 2.0 client credentials: no person involved. */
export const oauthClientCredentials = defineCeremony({
  id: "oauth-client-credentials",
  title: "Authenticate as the application",
  facts: {
    clientSecret: fact({
      description: "The host configured a client id and secret.",
      value: of<{ readonly clientId: string; readonly clientSecret: string }>(),
      observable: true,
      discoverable: true,
      volatile: true,
      secret: true,
      given: true,
    }),
    accessToken: oauthFacts.accessToken,
  },
  operators: {
    requestToken: operator({
      description: "Ask the token endpoint for a token as the client.",
      establishes: ["accessToken"],
      requires: ["clientSecret"],
      actor: "machine",
      idempotent: true,
      outcomes: {
        issued: established("The provider issued a token."),
        clientRejected: invalidates(
          ["clientSecret"],
          "The provider refused the client's secret.",
        ),
        ...network,
      },
    }),
  },
  goal: ["accessToken"],
});

/** RFC 8693 token exchange: trade a token for one aimed at another audience. */
export const oauthTokenExchange = defineCeremony({
  id: "oauth-token-exchange",
  title: "Exchange a token for another audience",
  facts: {
    subjectToken: fact({
      description: "The caller presented a token to act on behalf of.",
      value: of<string>(),
      observable: true,
      discoverable: true,
      volatile: true,
      secret: true,
      given: true,
    }),
    accessToken: oauthFacts.accessToken,
  },
  operators: {
    exchange: operator({
      description: "Ask the token endpoint to exchange the subject token.",
      establishes: ["accessToken"],
      requires: ["subjectToken"],
      actor: "machine",
      idempotent: true,
      outcomes: {
        exchanged: established("The provider issued a token for the audience."),
        subjectRejected: invalidates(
          ["subjectToken"],
          "The subject token was expired or not acceptable.",
        ),
        notAllowed: terminal(
          "not-permitted",
          "Policy does not allow this exchange.",
        ),
        ...network,
      },
    }),
  },
  goal: ["accessToken"],
});

const sessionFact = fact({
  description: "The provider recognises a signed-in session.",
  value: of<{ readonly sessionId: string }>(),
  volatile: true,
  observable: true,
  secret: true,
});

/**
 * Password sign-in with a second factor when the provider asks for one. The
 * provider decides whether a code is needed, so the short path is tried first
 * and the code is asked for only when the provider blocks it.
 */
export const passwordSignIn = defineCeremony({
  id: "password-sign-in",
  title: "Sign in with a password",
  facts: {
    password: fact({
      description: "The person entered their identifier and password.",
      value: of<{ readonly identifier: string; readonly password: string }>(),
      volatile: true,
      secret: true,
    }),
    primary: fact({
      description: "The provider accepted the password for this attempt.",
      value: of<{ readonly attempt: string }>(),
      volatile: true,
      secret: true,
    }),
    oneTimeCode: fact({
      description: "The person entered a code from their second factor.",
      value: of<string>(),
      requires: ["primary"],
      volatile: true,
      secret: true,
    }),
    session: sessionFact,
  },
  operators: {
    enterPassword: operator({
      description: "Ask for the identifier and password.",
      establishes: ["password"],
      actor: "human",
      idempotent: true,
      outcomes: {
        entered: established("The person submitted the form."),
        declined: terminal("declined", "The person chose not to sign in."),
      },
      interface: {
        title: "Sign in",
        body: "Use the account this connection should act as.",
        fields: [
          { name: "identifier", label: "Email or username", kind: "text" },
          { name: "password", label: "Password", kind: "secret" },
        ],
        actions: [
          {
            id: "submit",
            label: "Sign in",
            outcome: "entered",
            emphasis: "primary",
          },
          cancel,
        ],
      },
    }),
    submitPassword: operator({
      description: "Send the identifier and password.",
      establishes: ["primary"],
      requires: ["password"],
      consumes: ["password"],
      actor: "machine",
      idempotent: true,
      outcomes: {
        accepted: established("The provider accepted the password."),
        rejected: invalidates(["password"], "The password was not accepted."),
        lockedOut: terminal(
          "locked-out",
          "The provider locked the account against further attempts.",
        ),
        ...network,
      },
    }),
    finishSignIn: operator({
      description: "Complete the sign-in when no second factor is asked for.",
      establishes: ["session"],
      requires: ["primary"],
      actor: "machine",
      idempotent: true,
      outcomes: {
        signedIn: established("The provider opened a session."),
        secondFactorRequired: blocked("The provider wants a second factor."),
        attemptExpired: invalidates(
          ["primary"],
          "The sign-in attempt expired.",
        ),
        ...network,
      },
    }),
    enterOneTimeCode: operator({
      description: "Ask for the code from the second factor.",
      establishes: ["oneTimeCode"],
      requires: ["primary"],
      actor: "human",
      idempotent: true,
      outcomes: {
        entered: established("The person submitted a code."),
        declined: terminal("declined", "The person chose not to continue."),
        attemptExpired: invalidates(
          ["primary"],
          "The sign-in attempt expired.",
        ),
      },
      interface: {
        title: "Enter your code",
        body: "Open your authenticator and enter the current code.",
        fields: [{ name: "code", label: "Code", kind: "text" }],
        actions: [
          {
            id: "submit",
            label: "Verify",
            outcome: "entered",
            emphasis: "primary",
          },
          cancel,
        ],
      },
    }),
    verifyOneTimeCode: operator({
      description: "Send the code to finish the sign-in.",
      establishes: ["session"],
      requires: ["oneTimeCode", "primary"],
      consumes: ["oneTimeCode"],
      actor: "machine",
      idempotent: true,
      cost: 2,
      outcomes: {
        signedIn: established("The provider opened a session."),
        codeRejected: invalidates(
          ["oneTimeCode"],
          "The code was not accepted.",
        ),
        attemptExpired: invalidates(
          ["primary"],
          "The sign-in attempt expired.",
        ),
        ...network,
      },
    }),
  },
  goal: ["session"],
});

/** A link or code sent to an address the person controls. */
export const magicLink = defineCeremony({
  id: "magic-link",
  title: "Sign in with a link sent by email",
  facts: {
    address: fact({
      description: "The person said where to send the link.",
      value: of<string>(),
    }),
    linkToken: fact({
      description: "The person opened the link and its one-time token arrived.",
      value: of<string>(),
      requires: ["address"],
      volatile: true,
      secret: true,
    }),
    session: sessionFact,
  },
  operators: {
    askAddress: operator({
      description: "Ask for the address.",
      establishes: ["address"],
      actor: "human",
      idempotent: true,
      outcomes: {
        entered: established("The person gave an address."),
        declined: terminal("declined", "The person chose not to sign in."),
      },
      interface: {
        title: "Sign in by email",
        body: "We send a link that signs you in. Nothing to remember.",
        fields: [{ name: "address", label: "Email", kind: "text" }],
        actions: [
          {
            id: "send",
            label: "Send link",
            outcome: "entered",
            emphasis: "primary",
          },
          cancel,
        ],
      },
    }),
    followLink: operator({
      description: "Send the link and wait for the person to open it.",
      establishes: ["linkToken"],
      requires: ["address"],
      actor: "human",
      idempotent: true,
      outcomes: {
        opened: established("The person opened the link."),
        declined: terminal("declined", "The person chose not to continue."),
        notDelivered: blocked("The provider could not send to that address."),
        expired: retry("The link expired before it was opened."),
      },
      interface: {
        title: "Check your email",
        body: "Open the link we sent. This page continues on its own.",
        shows: ["address"],
        actions: [
          {
            id: "opened",
            label: "I opened the link",
            outcome: "opened",
            emphasis: "primary",
          },
          {
            id: "resend",
            label: "Send it again",
            outcome: "expired",
            emphasis: "secondary",
          },
          cancel,
        ],
      },
    }),
    redeemLink: operator({
      description: "Trade the link's token for a session.",
      establishes: ["session"],
      requires: ["linkToken"],
      consumes: ["linkToken"],
      actor: "machine",
      idempotent: false,
      outcomes: {
        signedIn: established("The provider opened a session."),
        tokenRejected: invalidates(
          ["linkToken"],
          "The token had expired or was already used.",
        ),
        ...network,
        ...lostReply,
      },
    }),
  },
  goal: ["session"],
});

/** WebAuthn: the device proves possession of a key. */
export const passkey = defineCeremony({
  id: "passkey",
  title: "Sign in with a passkey",
  facts: {
    challenge: fact({
      description: "The provider issued a challenge to sign.",
      value: of<string>(),
      volatile: true,
    }),
    assertion: fact({
      description: "The person's device signed the challenge.",
      value: of<string>(),
      requires: ["challenge"],
      volatile: true,
      secret: true,
    }),
    session: sessionFact,
  },
  operators: {
    requestChallenge: operator({
      description: "Ask the provider for a challenge.",
      establishes: ["challenge"],
      actor: "machine",
      idempotent: true,
      outcomes: {
        issued: established("The provider issued a challenge."),
        unsupported: blocked("The provider does not offer passkeys."),
        ...network,
      },
    }),
    signChallenge: operator({
      description: "Ask the device to sign the challenge.",
      establishes: ["assertion"],
      requires: ["challenge"],
      actor: "human",
      idempotent: true,
      outcomes: {
        signed: established("The device signed the challenge."),
        declined: terminal("declined", "The person dismissed the prompt."),
        noAuthenticator: blocked("This device has no passkey for the account."),
        challengeExpired: invalidates(["challenge"], "The challenge expired."),
      },
      interface: {
        title: "Use your passkey",
        body: "Your device will ask for your fingerprint, face or screen lock.",
        actions: [
          {
            id: "use",
            label: "Use passkey",
            outcome: "signed",
            emphasis: "primary",
          },
          {
            id: "none",
            label: "I don't have one here",
            outcome: "noAuthenticator",
            emphasis: "secondary",
          },
          cancel,
        ],
      },
    }),
    verifyAssertion: operator({
      description: "Send the signed challenge.",
      establishes: ["session"],
      requires: ["assertion"],
      consumes: ["assertion"],
      actor: "machine",
      idempotent: true,
      outcomes: {
        signedIn: established("The provider opened a session."),
        assertionRejected: invalidates(
          ["assertion"],
          "The signature was not accepted.",
        ),
        challengeExpired: invalidates(["challenge"], "The challenge expired."),
        ...network,
      },
    }),
  },
  goal: ["session"],
});

/** SAML 2.0 web SSO, and by the same shape OIDC sign-in through an IdP. */
export const federatedSignIn = defineCeremony({
  id: "federated-sign-in",
  title: "Sign in through your identity provider",
  facts: {
    trust: fact({
      description: "The host configured the identity provider's metadata.",
      value: of<{ readonly issuer: string }>(),
      observable: true,
      discoverable: true,
      given: true,
    }),
    assertion: fact({
      description: "The identity provider returned a signed assertion.",
      value: of<string>(),
      requires: ["trust"],
      volatile: true,
      secret: true,
    }),
    session: sessionFact,
  },
  operators: {
    signInAtProvider: operator({
      description: "Hand the person to the identity provider.",
      establishes: ["assertion"],
      requires: ["trust"],
      actor: "human",
      idempotent: true,
      outcomes: {
        returned: established("The provider sent the person back signed in."),
        declined: terminal("declined", "The person chose not to sign in."),
        notAssigned: terminal(
          "not-permitted",
          "The provider says this person may not use the application.",
        ),
        abandoned: retry("The hand-off expired before the person came back."),
      },
      interface: {
        title: "Sign in with your organization",
        body: "You will sign in where you normally do and come straight back.",
        actions: [
          {
            id: "continue",
            label: "Continue",
            outcome: "returned",
            emphasis: "primary",
            leavesPage: true,
          },
          cancel,
        ],
      },
    }),
    validateAssertion: operator({
      description:
        "Check the signature, audience, time window and replay cache.",
      establishes: ["session"],
      requires: ["assertion", "trust"],
      consumes: ["assertion"],
      actor: "machine",
      idempotent: false,
      outcomes: {
        valid: established("The assertion is valid and a session is open."),
        replayedOrExpired: invalidates(
          ["assertion"],
          "The assertion was already used or outside its time window.",
        ),
        untrusted: terminal(
          "identity-rejected",
          "The assertion is not signed by the configured provider.",
        ),
        ...network,
        ...lostReply,
      },
    }),
  },
  goal: ["session"],
});

/** Mutual TLS: the certificate is configuration, the handshake is the proof. */
export const mutualTls = defineCeremony({
  id: "mutual-tls",
  title: "Authenticate with a client certificate",
  facts: {
    certificate: fact({
      description: "The host configured a client certificate and key.",
      value: of<{ readonly fingerprint: string }>(),
      observable: true,
      discoverable: true,
      volatile: true,
      secret: true,
      given: true,
    }),
    channel: fact({
      description: "The provider accepted the certificate on a connection.",
      value: of<true>(),
      requires: ["certificate"],
      volatile: true,
      observable: true,
    }),
  },
  operators: {
    handshake: operator({
      description: "Open a connection presenting the certificate.",
      establishes: ["channel"],
      requires: ["certificate"],
      actor: "machine",
      idempotent: true,
      outcomes: {
        accepted: established("The provider accepted the certificate."),
        certificateRejected: invalidates(
          ["certificate"],
          "The certificate was expired, revoked or unknown.",
        ),
        ...network,
      },
    }),
  },
  goal: ["channel"],
});

export const catalog = {
  apiKey,
  httpBasic,
  oauthAuthorizationCode,
  oauthDevice,
  oauthClientCredentials,
  oauthTokenExchange,
  passwordSignIn,
  magicLink,
  passkey,
  federatedSignIn,
  mutualTls,
} as const;
