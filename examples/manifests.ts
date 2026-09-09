import { manifestSchema, type ConnectorManifest } from "../src/core/index.js";

// Real service method inventories; the example app executes against local providers.
// This is a curated subset of each service's methods, not an exhaustive inventory.
export const manifests: ConnectorManifest[] = [
  manifestSchema.parse({
    id: "github",
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
      },
      {
        id: "device",
        label: "Device approval",
        kind: "device",
        fields: [],
        scopes: ["read:user"],
        templateId: "device",
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
          },
        ],
        scopes: [],
        templateId: "api-key",
      },
    ],
  }),
  manifestSchema.parse({
    id: "stripe",
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
          },
        ],
        scopes: [],
        templateId: "api-key",
      },
    ],
  }),
  manifestSchema.parse({
    id: "jira",
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
          },
          {
            name: "password",
            label: "Atlassian API token",
            type: "password",
            required: true,
          },
        ],
        scopes: [],
        templateId: "basic",
      },
    ],
  }),
  manifestSchema.parse({
    id: "supabase",
    name: "Supabase",
    description:
      "Sign in as a user of a Supabase Auth project. This is not a Supabase dashboard login.",
    methods: [
      {
        id: "form",
        label: "Email & password",
        kind: "form",
        fields: [
          { name: "email", label: "Email", type: "email", required: true },
          {
            name: "password",
            label: "Password",
            type: "password",
            required: true,
          },
        ],
        scopes: [],
        templateId: "form",
      },
    ],
  }),
  manifestSchema.parse({
    id: "neon",
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
    note: "Production key permissions are managed in Stripe. This example only validates local test credentials; it never creates a charge.",
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
    note: "Production sign-in needs a project URL and publishable key. Access follows that project's user and row-level security policies, not invented OAuth scopes.",
  },
  neon: {
    summary: "Anonymous → claim",
    documentationUrl: "https://neon.com/auth.md",
    note: "Neon claim opens a provider-owned transfer page without collecting email here. Completion means ownership transferred—not continued API access with anonymous credentials.",
  },
};
