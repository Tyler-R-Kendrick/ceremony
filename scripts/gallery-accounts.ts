import {
  manifestSchema,
  type ConnectorManifest,
  type Field,
} from "../src/core/schema.js";
import {
  methodContractSchema,
  type RegistrationContract,
} from "../src/core/connector-contracts.js";

/**
 * The accounts this page can make, and what each provider needs to make one.
 *
 * Read the shape before the list. Every one of these starts with an identifier
 * and none of them starts with a password, because that is the order providers
 * actually work in: something names the account, and only then, sometimes, does
 * something prove it. Three of the four never ask a person for a password at
 * all — one mints its own, two have the provider issue the credential — and the
 * declaration is what decides that rather than a screen written by hand.
 *
 * The provider URLs are the real ones, and the identifier is carried into them
 * so nobody types their address twice. What a published page cannot do is
 * verify an issued credential against the provider that issued it: that takes a
 * request to the provider, and this page has no way to make one. It checks the
 * documented shape instead, says that is what it checked, and keeps the
 * credential in the tab rather than pretending to have used it.
 */

export interface CredentialShape {
  /** What a good one looks like, in a person's words. */
  hint: string;
  /** The complaint, or nothing when the value could be genuine. */
  check(value: string): string | undefined;
}

export interface IssuingSurface {
  url: string;
  label: string;
  note: string;
}

export interface AccountProvider {
  manifest: ConnectorManifest;
  registration: RegistrationContract;
  /** Asked first, and alone. */
  identity: Field[];
  /** The provider's own registration page, carrying the identifier. */
  signup?: (values: Record<string, string>) => string;
  /** Where the provider issues the credential it will accept back. */
  issuing?: IssuingSurface;
  /** The credential field, for providers that issue one. */
  credential?: Field;
  shape?: CredentialShape;
  /** What pressing the button will do, before anybody presses it. */
  promises: readonly string[];
  /** What is true once this ceremony finishes, stated exactly. */
  completion: string;
}

const registration = (value: RegistrationContract): RegistrationContract =>
  value;

const contract = (profile: string, signature: RegistrationContract) =>
  methodContractSchema.parse({
    profile,
    surfaces: ["browser"],
    configuration: [],
    configurationGroups: [],
    prerequisites: [],
    handoff: {
      // Private collection, even where the provider's own browser is where the
      // account comes into being: the credential still comes back through a
      // field, and the schema is right to refuse a credential method that
      // claims otherwise. Only a method collecting nothing hands off openly.
      surface:
        signature.secret === "provider" || signature.secret === "none"
          ? "provider-browser"
          : "private-collector",
      recipient: "initiating-subject",
      delegation: "a2h-authorize",
      resume: "verify",
    },
    registration: signature,
    completion: {
      verifier: "gallery.registration",
      ownership: ["authenticated"],
    },
    workflows: [],
  });

const email: Field = {
  name: "email",
  label: "Email address",
  type: "email",
  required: true,
  classification: "personal",
};

const secret = (name: string, label: string): Field => ({
  name,
  label,
  type: "password",
  required: true,
  classification: "secret",
});

/** A prefix the provider documents, and a length below which nothing is real. */
const looksLike = (
  hint: string,
  prefixes: readonly string[],
  minimum: number,
): CredentialShape => ({
  hint,
  check(value) {
    const trimmed = value.trim();
    if (!prefixes.some((prefix) => trimmed.startsWith(prefix)))
      return `That does not start with ${prefixes.length > 1 ? "any of " : ""}${prefixes.map((prefix) => `"${prefix}"`).join(", ")}, which every one of these carries.`;
    if (trimmed.length < minimum)
      return `That is shorter than one of these ever is, so something was cut off in the copy.`;
    return undefined;
  },
});

/** The address, safely inside a query string, for a provider that prefills it. */
const carrying = (base: string, parameter: string, value: string) => {
  const url = new URL(base);
  if (value) url.searchParams.set(parameter, value);
  return url.toString();
};

const ownAccount = registration({
  identifier: ["email"],
  secret: "password",
  mint: true,
  createdBy: "this-ceremony",
});

const issued = (identifier: RegistrationContract["identifier"]) =>
  registration({
    identifier,
    secret: "issued-token",
    mint: false,
    createdBy: "provider-browser",
  });

export const accountProviders: readonly AccountProvider[] = [
  {
    manifest: manifestSchema.parse({
      id: "account",
      name: "An account here",
      description:
        "An address, and nothing else to think of. If this page has never seen the address it registers it; if it has, it signs in. The password is generated for you unless you ask to choose one.",
      methods: [
        {
          id: "email-password",
          label: "Register or sign in · address first",
          kind: "form",
          fields: [email],
          scopes: ["account.read", "account.session"],
          templateId: "form",
          contract: contract("gallery-account", ownAccount),
        },
      ],
    }),
    registration: ownAccount,
    identity: [email],
    promises: [
      "Register the address, or sign it in if it is already here",
      "Generate a password for you, unless you would rather choose one",
      "Hand you a session token and a recovery code, masked",
    ],
    completion:
      "The account exists, its address is confirmed, and the credentials below were issued to it.",
  },
  {
    manifest: manifestSchema.parse({
      id: "github",
      name: "GitHub",
      description:
        "Register at GitHub with your address, then bring back a personal access token. GitHub issues the token; nothing here can invent one that works.",
      methods: [
        {
          id: "personal-access-token",
          label: "Register at GitHub · token issued by GitHub",
          kind: "api-key",
          fields: [secret("token", "GitHub personal access token")],
          scopes: ["read:user"],
          templateId: "api-key",
          contract: contract("github-registration", issued(["email"])),
        },
      ],
    }),
    registration: issued(["email"]),
    identity: [email],
    signup: (values) =>
      carrying("https://github.com/signup", "user_email", values.email ?? ""),
    issuing: {
      url: "https://github.com/settings/tokens/new?description=Ceremony%20catalogue&scopes=read:user",
      label: "Create the token at GitHub",
      note: "read:user is enough, and it is the only scope this asks for. Give it the shortest expiry GitHub offers.",
    },
    credential: secret("token", "GitHub personal access token"),
    shape: looksLike(
      'GitHub tokens begin "ghp_" or "github_pat_".',
      ["ghp_", "github_pat_"],
      20,
    ),
    promises: [
      "Open GitHub's registration with your address already in it",
      "Point you at the token page, asking for read:user and nothing more",
      "Hold the token GitHub issues, in this tab, masked",
    ],
    completion:
      "GitHub issued this token to that address. This page checked its shape, never sent it anywhere, and holds it under the reference below.",
  },
  {
    manifest: manifestSchema.parse({
      id: "stripe",
      name: "Stripe",
      description:
        "Register at Stripe with your address, then bring back a test-mode secret key. Stripe issues the key; nothing here can invent one that works.",
      methods: [
        {
          id: "secret-key",
          label: "Register at Stripe · key issued by Stripe",
          kind: "api-key",
          fields: [secret("token", "Stripe test secret key")],
          scopes: [],
          templateId: "api-key",
          contract: contract("stripe-registration", issued(["email"])),
        },
      ],
    }),
    registration: issued(["email"]),
    identity: [email],
    signup: (values) =>
      carrying(
        "https://dashboard.stripe.com/register",
        "email",
        values.email ?? "",
      ),
    issuing: {
      url: "https://dashboard.stripe.com/test/apikeys",
      label: "Copy the test key from Stripe",
      note: "The test-mode key, the one beginning sk_test_. A live key moves real money and has no business in a catalogue page.",
    },
    credential: secret("token", "Stripe test secret key"),
    shape: looksLike(
      'Stripe test keys begin "sk_test_" or, restricted, "rk_test_".',
      ["sk_test_", "rk_test_"],
      20,
    ),
    promises: [
      "Open Stripe's registration with your address already in it",
      "Point you at the test-mode keys, never the live ones",
      "Hold the key Stripe issues, in this tab, masked",
    ],
    completion:
      "Stripe issued this key to that address. This page checked its shape, never sent it anywhere, and holds it under the reference below.",
  },
  {
    manifest: manifestSchema.parse({
      id: "jira",
      name: "Jira",
      description:
        "Register an Atlassian account with your address, then bring back an API token. Atlassian issues the token, and it is not your password — Jira has not accepted one for years.",
      methods: [
        {
          // `api-key`, not `basic`, and the difference is real: Jira is used
          // over HTTP Basic with the address and the token together, but what
          // this ceremony collects is the one thing Atlassian issues. The
          // address is the identifier and was settled a step earlier.
          id: "api-token",
          label: "Register at Atlassian · token issued by Atlassian",
          kind: "api-key",
          fields: [secret("token", "Atlassian API token")],
          scopes: [],
          templateId: "api-key",
          contract: contract("atlassian-registration", issued(["email"])),
        },
      ],
    }),
    registration: issued(["email"]),
    identity: [email],
    signup: (values) =>
      carrying("https://id.atlassian.com/signup", "email", values.email ?? ""),
    issuing: {
      url: "https://id.atlassian.com/manage-profile/security/api-tokens",
      label: "Create the token at Atlassian",
      note: "Create API token, name it for this page, and copy it before the dialog closes — Atlassian shows it once.",
    },
    credential: secret("token", "Atlassian API token"),
    shape: looksLike('Atlassian API tokens begin "ATATT".', ["ATATT"], 24),
    promises: [
      "Open Atlassian's registration with your address already in it",
      "Point you at the API token page, which is not your password",
      "Hold the token Atlassian issues, in this tab, masked",
    ],
    completion:
      "Atlassian issued this token to that address. This page checked its shape, never sent it anywhere, and holds it under the reference below.",
  },
];
