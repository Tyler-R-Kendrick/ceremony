/**
 * The directory a person browses before any ceremony exists.
 *
 * A marketplace row is a promise, so this module keeps two things apart that
 * catalogues usually blur. `support` is what the server can actually execute
 * today; `auth` is what the service's protocol looks like. A row may describe a
 * protocol perfectly and still be unable to run, and saying so on the card is
 * cheaper than saying it after somebody presses Connect.
 *
 * Nothing here is authorization, and nothing here is fetched. The directory is
 * static host copy; manifests remain the only source of executable method
 * inventories.
 */

export const categories = [
  "AI",
  "Analytics",
  "Commerce",
  "Communication",
  "Content",
  "Data",
  "Developer",
  "Productivity",
  "Other",
] as const;
export type Category = (typeof categories)[number];

/**
 * How far a row has been taken, which is the only claim the card is allowed to
 * make about it.
 *
 * - `provider-backed` — a live adapter exists and verifies real access.
 * - `fixture` — the deterministic local harness drives it; never a vendor claim.
 * - `declared` — an authorable template with no adapter yet. It opens the
 *   studio rather than a connection.
 */
export type CatalogSupport = "provider-backed" | "fixture" | "declared";

/**
 * Auth families the drawer knows how to configure.
 *
 * The first five are the families a hosted connector marketplace normally
 * stops at. The rest are the ones this project exists for: a family is listed
 * here only when something in `src/` can actually carry it.
 */
export const authFamilyLabels = {
  "oauth-code": "OAuth 2.1 · authorization code + PKCE",
  "oauth-client-credentials": "OAuth 2.0 · client credentials",
  "api-key": "API key",
  basic: "HTTP Basic · identifier + token",
  device: "Device authorization",
  "github-app": "GitHub App · manifest registration",
  "browser-login": "Attended browser login",
  "account-registration": "Account registration",
  "anonymous-claim": "Anonymous, then claimed",
} as const;
export type AuthFamily = keyof typeof authFamilyLabels;

/**
 * What the drawer offers beyond a credential form, and what each one costs a
 * person. Every capability names the module that implements it so a reviewer
 * can check the claim instead of trusting the copy.
 */
export const capabilityDetails = {
  teaching: {
    label: "Teach this connection",
    summary:
      "Record the transitions a provider actually permits, then replay them without a model. Provider DOM and private input are never captured.",
    module: "src/server/teaching.ts",
  },
  recipes: {
    label: "Save as a reusable recipe",
    summary:
      "Publish a whole ceremony or a contiguous fragment. Compatible recipes compose under fresh principal and environment bindings; sharing procedure never shares access.",
    module: "src/core/recipe-contracts.ts",
  },
  a2h: {
    label: "Agent-to-human handoff",
    summary:
      "An agent may prepare a step and hand the approval back to the person who owns the account. Consent stays with them; private input never enters model context.",
    module: "src/server/a2h.ts",
  },
  prerequisites: {
    label: "Prerequisite child ceremonies",
    summary:
      "Registration, installation and consent run as their own verified children. A later step cannot start until the one it depends on is proven.",
    module: "src/core/connector-contracts.ts",
  },
  arazzo: {
    label: "Arazzo workflow binding",
    summary:
      "Bind host-held workflow documents by identity and version. Remote executable URLs are never fetched.",
    module: "src/server/arazzo.ts",
  },
  "session-environment": {
    label: "Session environment bindings",
    summary:
      "Client ids, secrets and project URLs resolve from encrypted session-scoped configuration instead of a form somebody retypes per connector.",
    module: "src/server/environment.ts",
  },
  verification: {
    label: "Verify real access before completing",
    summary:
      "A returned token is not a connection. Completion requires the adapter to read something the grant was for.",
    module: "src/server/verification.ts",
  },
  webmcp: {
    label: "Expose to WebMCP and MCP clients",
    summary:
      "The same validated commands drive the UI, native WebMCP and a chat client. Browser source labels are not authority.",
    module: "src/core/webmcp.ts",
  },
  "minted-password": {
    label: "Mint the credential",
    summary:
      "Where a provider will hold a password, generate a strong one instead of asking a person to invent and type it.",
    module: "src/core/connector-contracts.ts",
  },
} satisfies Record<string, { label: string; summary: string; module: string }>;
export type Capability = keyof typeof capabilityDetails;

export interface CatalogEntry {
  id: string;
  name: string;
  summary: string;
  category: Category;
  support: CatalogSupport;
  auth: readonly AuthFamily[];
  capabilities: readonly Capability[];
  featured?: boolean;
  /** Pre-checked in Customize; the reason somebody chose this card. */
  defaultCapabilities?: readonly Capability[];
  /**
   * The workspace's registered origin for this service, when it has one.
   *
   * Used as the entry address of a compiled plan in Managed mode, so a person
   * does not have to retype something the workspace already knows. A row
   * without one has to be told where it lives before a plan can be compiled.
   */
  origin?: string;
  /** Brand colour behind fallback initials. Manifests carry no logo, and should not. */
  tint?: string;
  ink?: string;
}

/**
 * The two rows that are not services at all.
 *
 * Every catalogue eventually meets a provider it has never heard of, and the
 * usual answer is a support request. These rows answer it in the product: pick
 * the protocol, point it at an origin, and the same machinery runs.
 */
export const customEntries: readonly CatalogEntry[] = [
  {
    id: "custom-oauth",
    name: "OAuth",
    summary: "Connect any OAuth 2.0 or 2.1 provider by discovery or by hand.",
    category: "Developer",
    support: "declared",
    auth: ["oauth-code"],
    capabilities: [
      "session-environment",
      "verification",
      "prerequisites",
      "a2h",
      "webmcp",
    ],
    tint: "#2b2b2b",
  },
  {
    id: "custom-client-credentials",
    name: "OAuth Machine",
    summary:
      "Server-to-server access from a client id and secret. Nobody is interrupted.",
    category: "Developer",
    support: "declared",
    auth: ["oauth-client-credentials"],
    capabilities: ["session-environment", "verification", "webmcp"],
    tint: "#2b2b2b",
  },
  {
    id: "custom-api-key",
    name: "API Key",
    summary: "Store a shared key, or ask each person for their own.",
    category: "Developer",
    support: "declared",
    auth: ["api-key"],
    capabilities: ["session-environment", "verification", "webmcp"],
    tint: "#2b2b2b",
  },
  {
    id: "custom-basic",
    name: "HTTP Basic",
    summary:
      "An identifier and a provider-issued token, never an account password.",
    category: "Developer",
    support: "declared",
    auth: ["basic"],
    capabilities: ["session-environment", "verification", "webmcp"],
    tint: "#2b2b2b",
  },
  {
    id: "custom-device",
    name: "Device Code",
    summary:
      "Approval on a second device, for a CLI, a TV, or anything with no browser.",
    category: "Developer",
    support: "declared",
    auth: ["device"],
    capabilities: ["session-environment", "verification", "a2h", "webmcp"],
    tint: "#2b2b2b",
  },
  {
    id: "custom-browser-login",
    name: "Browser Login",
    summary:
      "Sign in to a service that publishes no API at all, in an attended session.",
    category: "Developer",
    support: "declared",
    auth: ["browser-login"],
    capabilities: ["teaching", "recipes", "a2h", "verification"],
    tint: "#2b2b2b",
  },
  {
    /**
     * The one that has no equivalent anywhere else: show it the way in once,
     * and it replays without a model afterwards. Teaching is on by default
     * here, because recording is the entire point of choosing this card.
     */
    id: "custom-record",
    name: "Record a Sign-in",
    summary:
      "Demonstrate a sign-in once, review what was captured, then replay it without a model.",
    category: "Developer",
    support: "declared",
    auth: ["browser-login"],
    capabilities: ["teaching", "recipes", "a2h", "verification", "webmcp"],
    defaultCapabilities: ["teaching", "recipes", "verification"],
    tint: "#2b2b2b",
  },
  {
    id: "custom-registration",
    name: "Create an Account",
    summary:
      "Bring an account into being, including minting the password so nobody types one.",
    category: "Developer",
    support: "declared",
    auth: ["account-registration"],
    capabilities: [
      "minted-password",
      "prerequisites",
      "a2h",
      "verification",
      "session-environment",
    ],
    defaultCapabilities: ["minted-password", "verification"],
    tint: "#2b2b2b",
  },
  {
    id: "custom-anonymous",
    name: "Anonymous",
    summary:
      "Complete with nobody's name on it, and transfer ownership at the provider later.",
    category: "Developer",
    support: "declared",
    auth: ["anonymous-claim"],
    capabilities: ["verification", "a2h", "recipes"],
    tint: "#2b2b2b",
  },
];

/** Services with adapters, fixtures or templates in this repository. */
export const serviceEntries: readonly CatalogEntry[] = [
  {
    id: "github",
    name: "GitHub",
    origin: "https://github.com",
    summary: "Automate repos, issues, and pull requests.",
    category: "Developer",
    support: "provider-backed",
    auth: ["github-app", "oauth-code", "device", "api-key"],
    capabilities: [
      "prerequisites",
      "teaching",
      "recipes",
      "a2h",
      "session-environment",
      "verification",
      "webmcp",
    ],
    featured: true,
    tint: "#1c1c1c",
  },
  {
    id: "stripe",
    name: "Stripe",
    origin: "https://dashboard.stripe.com",
    summary: "Authenticate to the Stripe API with a secret or restricted key.",
    category: "Commerce",
    support: "provider-backed",
    auth: ["api-key"],
    capabilities: ["session-environment", "verification", "teaching", "webmcp"],
    featured: true,
    tint: "#3f3cbb",
  },
  {
    id: "supabase",
    name: "Supabase",
    origin: "https://supabase.com",
    summary: "Project setup, project-user sign-in and enrolled TOTP.",
    category: "Data",
    support: "provider-backed",
    auth: ["account-registration", "basic"],
    capabilities: [
      "prerequisites",
      "minted-password",
      "session-environment",
      "verification",
      "teaching",
      "recipes",
    ],
    featured: true,
    tint: "#1c6b4a",
  },
  {
    id: "jira",
    name: "Jira",
    origin: "https://id.atlassian.com",
    summary: "Connect Jira Cloud with 3LO consent or an Atlassian API token.",
    category: "Productivity",
    support: "provider-backed",
    auth: ["oauth-code", "basic"],
    capabilities: [
      "prerequisites",
      "a2h",
      "session-environment",
      "verification",
      "teaching",
    ],
    featured: true,
    tint: "#1c4fd8",
  },
  {
    id: "neon",
    name: "Neon",
    origin: "https://console.neon.tech",
    summary: "Start anonymously, then transfer ownership at the provider.",
    category: "Data",
    support: "provider-backed",
    auth: ["anonymous-claim"],
    capabilities: ["verification", "a2h", "recipes"],
    tint: "#1f6f4f",
  },
];

/**
 * Services with no adapter here yet, described by the protocol they actually
 * publish.
 *
 * Every one of these is reachable today through a generic family — discovery
 * for an OAuth server, a private-collector form for a key, an attended session
 * for the rest — but reachable is not the same as built, so each row carries
 * `declared` and the card says so before anybody presses anything. A directory
 * that blurs the two is how a person ends up three steps into a ceremony that
 * was never going to finish.
 */
const declared = (
  id: string,
  name: string,
  category: Category,
  summary: string,
  auth: readonly AuthFamily[],
  extra: readonly Capability[] = [],
): CatalogEntry => ({
  id,
  name,
  category,
  summary,
  support: "declared",
  auth,
  capabilities: [
    "session-environment",
    "verification",
    "webmcp",
    ...extra,
  ] as Capability[],
});

export const declaredEntries: readonly CatalogEntry[] = [
  declared(
    "openai",
    "OpenAI",
    "AI",
    "Call models and manage projects with an organization API key.",
    ["api-key"],
  ),
  declared(
    "anthropic",
    "Anthropic",
    "AI",
    "Reach the Claude API with a workspace key.",
    ["api-key"],
  ),
  declared(
    "hugging-face",
    "Hugging Face",
    "AI",
    "Read and publish models, datasets and Spaces.",
    ["oauth-code", "api-key"],
  ),
  declared(
    "replicate",
    "Replicate",
    "AI",
    "Run hosted models and read prediction output.",
    ["api-key"],
  ),
  declared(
    "elevenlabs",
    "ElevenLabs",
    "AI",
    "Synthesize speech and manage voices.",
    ["api-key"],
  ),
  declared(
    "posthog",
    "PostHog",
    "Analytics",
    "Query product analytics and manage feature flags.",
    ["api-key", "oauth-code"],
  ),
  declared(
    "amplitude",
    "Amplitude",
    "Analytics",
    "Read event data and cohorts.",
    ["api-key", "basic"],
  ),
  declared(
    "plausible",
    "Plausible",
    "Analytics",
    "Read site statistics without cookies.",
    ["api-key"],
  ),
  declared(
    "mixpanel",
    "Mixpanel",
    "Analytics",
    "Export events and manage projects.",
    ["basic", "api-key"],
  ),
  declared(
    "shopify",
    "Shopify",
    "Commerce",
    "Manage products, orders and storefronts.",
    ["oauth-code", "api-key"],
    ["prerequisites"],
  ),
  declared(
    "square",
    "Square",
    "Commerce",
    "Read catalogue and payment records.",
    ["oauth-code", "api-key"],
  ),
  declared(
    "paddle",
    "Paddle",
    "Commerce",
    "Read subscriptions and transactions.",
    ["api-key"],
  ),
  declared(
    "lemon-squeezy",
    "Lemon Squeezy",
    "Commerce",
    "Read orders, licences and subscriptions.",
    ["api-key"],
  ),
  declared(
    "slack",
    "Slack",
    "Communication",
    "Send messages and alerts to your workspace.",
    ["oauth-code"],
    ["prerequisites", "a2h"],
  ),
  declared(
    "discord",
    "Discord",
    "Communication",
    "Post messages and manage your server.",
    ["oauth-code", "api-key"],
    ["a2h"],
  ),
  declared(
    "twilio",
    "Twilio",
    "Communication",
    "Send messages and read delivery status.",
    ["basic", "api-key"],
  ),
  declared(
    "resend",
    "Resend",
    "Communication",
    "Send transactional email and read delivery events.",
    ["api-key"],
  ),
  declared(
    "zoom",
    "Zoom",
    "Communication",
    "Schedule meetings and read recordings.",
    ["oauth-code", "oauth-client-credentials"],
    ["a2h"],
  ),
  declared(
    "notion",
    "Notion",
    "Content",
    "Read and update pages and databases.",
    ["oauth-code", "api-key"],
    ["a2h"],
  ),
  declared(
    "contentful",
    "Contentful",
    "Content",
    "Read and publish entries and assets.",
    ["oauth-code", "api-key"],
  ),
  declared(
    "sanity",
    "Sanity",
    "Content",
    "Query and mutate structured content.",
    ["oauth-code", "api-key"],
  ),
  declared(
    "wordpress",
    "WordPress",
    "Content",
    "Publish posts and manage media.",
    ["oauth-code", "basic"],
  ),
  declared(
    "figma",
    "Figma",
    "Content",
    "Read files, components and design variables.",
    ["oauth-code", "api-key"],
  ),
  declared(
    "youtube",
    "YouTube",
    "Content",
    "Read channel data and manage uploads.",
    ["oauth-code"],
    ["a2h"],
  ),
  declared(
    "snowflake",
    "Snowflake",
    "Data",
    "Query and load your data warehouse.",
    ["oauth-code", "basic"],
    ["prerequisites"],
  ),
  declared(
    "bigquery",
    "BigQuery",
    "Data",
    "Run queries against your datasets.",
    ["oauth-code", "oauth-client-credentials"],
  ),
  declared(
    "planetscale",
    "PlanetScale",
    "Data",
    "Manage branches and read schema.",
    ["oauth-code", "api-key"],
  ),
  declared(
    "mongodb-atlas",
    "MongoDB Atlas",
    "Data",
    "Administer clusters and database users.",
    ["basic", "api-key"],
  ),
  declared(
    "airtable",
    "Airtable",
    "Data",
    "Read and write bases and records.",
    ["oauth-code", "api-key"],
  ),
  declared(
    "gitlab",
    "GitLab",
    "Developer",
    "Manage projects, issues and merge requests.",
    ["oauth-code", "api-key"],
    ["prerequisites"],
  ),
  declared(
    "bitbucket",
    "Bitbucket",
    "Developer",
    "Manage repositories and pull requests.",
    ["oauth-code", "basic"],
  ),
  declared(
    "vercel",
    "Vercel",
    "Developer",
    "Deploy projects and read build output.",
    ["oauth-code", "api-key"],
  ),
  declared(
    "cloudflare",
    "Cloudflare",
    "Developer",
    "Manage zones, Workers and DNS records.",
    ["api-key", "oauth-code"],
  ),
  declared("sentry", "Sentry", "Developer", "Read issues and release health.", [
    "oauth-code",
    "api-key",
  ]),
  declared(
    "npm",
    "npm",
    "Developer",
    "Publish packages and read registry access.",
    ["api-key", "device"],
  ),
  declared(
    "docker-hub",
    "Docker Hub",
    "Developer",
    "Read repositories and push images.",
    ["basic", "api-key"],
  ),
  declared(
    "linear",
    "Linear",
    "Productivity",
    "Track issues, projects and cycles.",
    ["oauth-code", "api-key"],
  ),
  declared("asana", "Asana", "Productivity", "Manage tasks and projects.", [
    "oauth-code",
    "api-key",
  ]),
  declared(
    "google-workspace",
    "Google Workspace",
    "Productivity",
    "Read mail, calendar and drive with delegated consent.",
    ["oauth-code", "device"],
    ["a2h", "prerequisites"],
  ),
  declared(
    "microsoft-365",
    "Microsoft 365",
    "Productivity",
    "Read mail, calendar and files through Graph.",
    ["oauth-code", "device"],
    ["a2h", "prerequisites"],
  ),
  declared(
    "trello",
    "Trello",
    "Productivity",
    "Manage boards, lists and cards.",
    ["oauth-code", "api-key"],
  ),
  declared(
    "calendly",
    "Calendly",
    "Productivity",
    "Read scheduled events and availability.",
    ["oauth-code", "api-key"],
  ),
  declared(
    "docusign",
    "DocuSign",
    "Other",
    "Send envelopes and read signing status.",
    ["oauth-code", "device"],
    ["a2h"],
  ),
  declared(
    "okta",
    "Okta",
    "Other",
    "Administer users, groups and applications.",
    ["oauth-client-credentials", "api-key"],
  ),
  declared(
    "auth0",
    "Auth0",
    "Other",
    "Manage tenants, connections and users.",
    ["oauth-client-credentials", "api-key"],
  ),
  declared(
    "salesforce",
    "Salesforce",
    "Other",
    "Read and update records across objects.",
    ["oauth-code", "device"],
    ["a2h", "prerequisites"],
  ),
  declared(
    "hubspot",
    "HubSpot",
    "Other",
    "Read contacts, deals and pipelines.",
    ["oauth-code", "api-key"],
  ),
  declared("zendesk", "Zendesk", "Other", "Read tickets and manage agents.", [
    "oauth-code",
    "basic",
  ]),
  declared(
    "intercom",
    "Intercom",
    "Other",
    "Read conversations and manage contacts.",
    ["oauth-code", "api-key"],
  ),
  declared(
    "legacy-portal",
    "Legacy Portal",
    "Other",
    "Any service with a sign-in page and no API at all.",
    ["browser-login"],
    ["teaching", "recipes", "a2h"],
  ),
];

/** A protocol card rather than a named service: the person supplies the service. */
export function isCustomEntry(id: string): boolean {
  return customEntries.some((entry) => entry.id === id);
}

export const catalog: readonly CatalogEntry[] = [
  ...serviceEntries,
  ...customEntries,
  ...declaredEntries,
];

export function entriesInCategory(
  entries: readonly CatalogEntry[],
  category: Category | "all",
): readonly CatalogEntry[] {
  return category === "all"
    ? entries
    : entries.filter((entry) => entry.category === category);
}

/** Case-insensitive match across the fields a person would actually type. */
export function searchEntries(
  entries: readonly CatalogEntry[],
  query: string,
): readonly CatalogEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) =>
    [
      entry.name,
      entry.summary,
      entry.category,
      ...entry.auth.map((family) => authFamilyLabels[family]),
    ]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}

export function categoryCounts(
  entries: readonly CatalogEntry[],
): Record<Category, number> {
  const counts = Object.fromEntries(
    categories.map((category) => [category, 0]),
  ) as Record<Category, number>;
  for (const entry of entries) counts[entry.category] += 1;
  return counts;
}
