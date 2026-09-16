import {
  manifestSchema,
  type ConnectorManifest,
  type Field,
} from "../src/core/schema.js";
import {
  methodContractSchema,
  type RegistrationContract,
} from "../src/core/connector-contracts.js";

/** The accounts this page can make, and what each provider needs to make one. */

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
      description: "Register or sign in. The password is generated for you.",
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
      "Register or sign in",
      "Generate a password",
      "Issue a session token and recovery code",
    ],
    completion: "Registered and confirmed.",
  },
  {
    manifest: manifestSchema.parse({
      id: "github",
      name: "GitHub",
      description:
        "Register at GitHub, then bring back a personal access token.",
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
      note: "read:user, shortest expiry.",
    },
    credential: secret("token", "GitHub personal access token"),
    shape: looksLike(
      'GitHub tokens begin "ghp_" or "github_pat_".',
      ["ghp_", "github_pat_"],
      20,
    ),
    promises: [
      "Open GitHub signup with your address",
      "Token page, read:user only",
      "Hold the issued token in this tab",
    ],
    completion: "GitHub issued this token. Shape checked; held in this tab.",
  },
  {
    manifest: manifestSchema.parse({
      id: "stripe",
      name: "Stripe",
      description:
        "Register at Stripe, then bring back a test-mode secret key.",
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
      note: "Test mode only — sk_test_, never a live key.",
    },
    credential: secret("token", "Stripe test secret key"),
    shape: looksLike(
      'Stripe test keys begin "sk_test_" or, restricted, "rk_test_".',
      ["sk_test_", "rk_test_"],
      20,
    ),
    promises: [
      "Open Stripe signup with your address",
      "Test-mode keys only",
      "Hold the issued key in this tab",
    ],
    completion: "Stripe issued this key. Shape checked; held in this tab.",
  },
  {
    manifest: manifestSchema.parse({
      id: "jira",
      name: "Jira",
      description: "Register at Atlassian, then bring back an API token.",
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
      note: "Copy it before the dialog closes.",
    },
    credential: secret("token", "Atlassian API token"),
    shape: looksLike('Atlassian API tokens begin "ATATT".', ["ATATT"], 24),
    promises: [
      "Open Atlassian signup with your address",
      "API token page",
      "Hold the issued token in this tab",
    ],
    completion: "Atlassian issued this token. Shape checked; held in this tab.",
  },
];
