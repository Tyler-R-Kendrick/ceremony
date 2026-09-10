import {
  manifestSchema,
  methodContractSchema,
  type ConnectorManifest,
} from "../src/core/index.js";

// This helper describes only our deterministic fixtures, never inferred live support.
function fixtureContract(
  profile: string,
  privateInput = false,
  anonymous = false,
) {
  return methodContractSchema.parse({
    profile,
    surfaces: ["browser", "headless"],
    configuration: [],
    configurationGroups: [],
    prerequisites: [],
    handoff: {
      surface: privateInput ? "private-collector" : "provider-browser",
      recipient: "initiating-subject",
      delegation: "a2h-authorize",
      resume: "verify",
    },
    completion: {
      verifier: "fixture.adapter",
      ownership: anonymous ? ["anonymous", "claimed"] : ["authenticated"],
    },
    workflows: [],
  });
}

// Real service method inventories; the example app executes against local providers.
// This is a curated subset of each service's methods, not an exhaustive inventory.
export const manifests: ConnectorManifest[] = [
  manifestSchema.parse({
    id: "github",
    schemaVersion: 1,
    support: "fixture",
    name: "GitHub",
    description: "Connect repositories and your developer identity.",
    methods: [
      {
        id: "oauth",
        label: "OAuth · PKCE",
        kind: "oauth-code",
        fields: [],
        scopes: ["read:user"],
        templateId: "oauth-code",
        contract: fixtureContract("oauth-code-pkce"),
      },
      {
        id: "device",
        label: "Device approval",
        kind: "device",
        fields: [],
        scopes: ["read:user"],
        templateId: "device",
        contract: fixtureContract("device"),
      },
      {
        id: "api-key",
        label: "Personal access token",
        kind: "api-key",
        fields: [
          {
            name: "token",
            label: "GitHub personal access token",
            type: "password",
            required: true,
            classification: "secret",
          },
        ],
        scopes: [],
        templateId: "api-key",
        contract: fixtureContract("personal-access-token", true),
      },
    ],
  }),
  manifestSchema.parse({
    id: "stripe",
    schemaVersion: 1,
    support: "fixture",
    name: "Stripe",
    description:
      "Authenticate to the Stripe API with a secret or restricted key. No payments are performed.",
    methods: [
      {
        id: "api-key",
        label: "API key",
        kind: "api-key",
        fields: [
          {
            name: "token",
            label: "Stripe secret key",
            type: "password",
            required: true,
            classification: "secret",
          },
        ],
        scopes: [],
        templateId: "api-key",
        contract: fixtureContract("api-key", true),
      },
    ],
  }),
  manifestSchema.parse({
    id: "jira",
    schemaVersion: 1,
    support: "fixture",
    name: "Jira",
    description:
      "Connect Jira Cloud using your Atlassian email and API token—not your account password.",
    methods: [
      {
        id: "basic",
        label: "HTTP Basic · email + API token",
        kind: "basic",
        fields: [
          {
            name: "username",
            label: "Atlassian email",
            type: "email",
            required: true,
            classification: "personal",
          },
          {
            name: "password",
            label: "Atlassian API token",
            type: "password",
            required: true,
            classification: "secret",
          },
        ],
        scopes: [],
        templateId: "basic",
        contract: fixtureContract("basic-api-token", true),
      },
    ],
  }),
  manifestSchema.parse({
    id: "supabase",
    schemaVersion: 1,
    support: "fixture",
    name: "Supabase",
    description:
      "Sign in as a user of a Supabase Auth project. This is not a Supabase dashboard login.",
    methods: [
      {
        id: "form",
        label: "Email & password",
        kind: "form",
        fields: [
          {
            name: "email",
            label: "Email",
            type: "email",
            required: true,
            classification: "personal",
          },
          {
            name: "password",
            label: "Password",
            type: "password",
            required: true,
            classification: "secret",
          },
        ],
        scopes: [],
        templateId: "form",
        contract: fixtureContract("password", true),
      },
    ],
  }),
  manifestSchema.parse({
    id: "neon",
    schemaVersion: 1,
    support: "fixture",
    name: "Neon",
    description:
      "Start with an anonymous project, then transfer ownership to a Neon organization when you are ready.",
    methods: [
      {
        id: "anonymous",
        label: "Anonymous · auth.md",
        kind: "authmd-anonymous",
        fields: [],
        claimFields: [],
        scopes: [],
        templateId: "authmd-anonymous",
        contract: fixtureContract("anonymous-claim", false, true),
      },
    ],
  }),
];

export const connectorDetails: Record<
  string,
  { summary: string; documentationUrl: string; note: string }
> = {
  github: {
    summary: "OAuth · device · token",
    documentationUrl:
      "https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps",
    note: "Production OAuth needs a registered app and callback; device flow must be enabled. Token permissions are configured on GitHub, not granted by this form.",
  },
  stripe: {
    summary: "API key",
    documentationUrl: "https://docs.stripe.com/api/authentication",
    note: "Stripe verifies a secret or restricted key by reading balance. Grant Balance read permission; no charges or payments are created.",
  },
  jira: {
    summary: "HTTP Basic",
    documentationUrl:
      "https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/",
    note: "Basic encodes email and API token together. A production adapter also needs your Jira site; OAuth is recommended for distributed integrations.",
  },
  supabase: {
    summary: "Password sign-in",
    documentationUrl:
      "https://supabase.com/docs/reference/javascript/auth-signinwithpassword",
    note: "Missing project URL and publishable key are collected inline and reused in your session after successful sign-in. Access follows the project's user and row-level security policies.",
  },
  neon: {
    summary: "Anonymous → claim",
    documentationUrl: "https://neon.com/auth.md",
    note: "Neon claim opens a provider-owned transfer page without collecting email here. Completion means ownership transferred—not continued API access with anonymous credentials.",
  },
};
