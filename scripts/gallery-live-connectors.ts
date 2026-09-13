import { z } from "zod";
import { manifestSchema, type ConnectorManifest } from "../src/core/schema.js";

/**
 * The connectors this page can really connect, and what proves it.
 *
 * Two rules hold here. The manifests are truthful: each describes the
 * mechanism that actually runs, not the one that would make a better demo, and
 * each goes through the production schema so it obeys every rule the library
 * enforces on a connector anybody else writes. And the evidence is live: a
 * probe reads from the provider at the moment it is called, so nothing a
 * visitor sees was written into this file.
 */

export interface Fact {
  label: string;
  value: string;
}

export interface Proof {
  /** A real, non-secret identifier for the connection that was established. */
  reference: string;
  headline: string;
  facts: Fact[];
}

export type Call = (tool: string, input?: unknown) => Promise<unknown>;

export interface LiveConnector {
  manifest: ConnectorManifest;
  /** The connector's display name, as the viewer's claude.ai lists it. */
  server: string;
  probe(call: Call): Promise<Proof>;
}

/**
 * A delegated connection, described as what it is.
 *
 * `oauth-code` is the kind because that is the shape: a person approves at an
 * authorization surface, and what comes back is delegated access this page can
 * use without ever holding the credential. The label says whose surface did the
 * approving, so nobody reads "OAuth" and pictures a redirect this page never
 * performs. The scopes are the tools the page may call, which is exactly and
 * only what the grant covers.
 */
const delegated = (
  id: string,
  name: string,
  description: string,
  tools: readonly string[],
): ConnectorManifest =>
  manifestSchema.parse({
    id,
    name,
    description,
    methods: [
      {
        id: "delegated",
        label: `Approved connector · ${name} via claude.ai`,
        kind: "oauth-code",
        fields: [],
        scopes: [...tools],
        templateId: "oauth-code",
      },
    ],
  });

const count = (total: number, noun: string) =>
  `${total} ${noun}${total === 1 ? "" : "s"}`;

/** Only the fields the page reads, so an unexpected extra never breaks it. */
const githubMe = z.object({
  login: z.string(),
  details: z
    .object({
      name: z.string().nullish(),
      location: z.string().nullish(),
      public_repos: z.number().nullish(),
      followers: z.number().nullish(),
    })
    .nullish(),
});

const githubRepos = z.object({
  total_count: z.number().nullish(),
  items: z
    .array(z.object({ full_name: z.string(), language: z.string().nullish() }))
    .nullish(),
});

const supabaseProjects = z.object({
  projects: z.array(
    z.object({
      name: z.string(),
      region: z.string().nullish(),
      status: z.string().nullish(),
      organization_id: z.string().nullish(),
    }),
  ),
});

export const liveConnectors: readonly LiveConnector[] = [
  {
    manifest: delegated(
      "github",
      "GitHub",
      "Your GitHub account, reached through the connector you approved in claude.ai. This page reads your profile and searches your repositories; it never sees a token and never writes.",
      ["get_me", "search_repositories"],
    ),
    server: "github",
    async probe(call) {
      const me = githubMe.parse(await call("get_me"));
      // Scoped by what the first call returned, so the second is about the
      // person who actually authorized this rather than a name written here.
      const repos = githubRepos.parse(
        await call("search_repositories", {
          query: `owner:${me.login}`,
          perPage: 5,
          minimal_output: true,
        }),
      );
      const items = repos.items ?? [];
      const facts: Fact[] = [{ label: "Account", value: me.login }];
      if (me.details?.name)
        facts.push({ label: "Name", value: me.details.name });
      if (me.details?.location)
        facts.push({ label: "Location", value: me.details.location });
      if (typeof me.details?.public_repos === "number")
        facts.push({
          label: "Public repositories",
          value: String(me.details.public_repos),
        });
      if (typeof me.details?.followers === "number")
        facts.push({ label: "Followers", value: String(me.details.followers) });
      if (items.length)
        facts.push({
          label: `Repositories matched (${items.length})`,
          value: items.map((item) => item.full_name).join(", "),
        });
      return {
        reference: me.login,
        headline: `Connected to GitHub as ${me.details?.name ?? me.login}`,
        facts,
      };
    },
  },
  {
    manifest: delegated(
      "supabase",
      "Supabase",
      "Your Supabase account, reached through the connector you approved in claude.ai. This page lists your projects; it reads nothing inside them and never writes.",
      ["list_projects"],
    ),
    server: "Supabase",
    async probe(call) {
      const { projects } = supabaseProjects.parse(await call("list_projects"));
      const active = projects.filter(
        (project) => project.status === "ACTIVE_HEALTHY",
      );
      const facts: Fact[] = [
        { label: "Projects", value: count(projects.length, "project") },
      ];
      if (projects.length)
        facts.push({
          label: "Healthy",
          value: `${active.length} of ${projects.length}`,
        });
      const regions = [
        ...new Set(projects.flatMap((project) => project.region ?? [])),
      ];
      if (regions.length)
        facts.push({ label: "Regions", value: regions.join(", ") });
      for (const project of projects.slice(0, 3))
        facts.push({
          label: project.name,
          value: [project.region, project.status].filter(Boolean).join(" · "),
        });
      return {
        reference:
          projects.find((project) => project.organization_id)
            ?.organization_id ?? "supabase",
        headline: projects.length
          ? `Connected to Supabase · ${count(projects.length, "project")}`
          : "Connected to Supabase · no projects yet",
        facts,
      };
    },
  },
];

/** Exactly what the page must declare to be allowed to make these calls. */
export const mcpManifest = {
  servers: liveConnectors.map((live) => ({
    server: live.server,
    tools: [...live.manifest.methods[0]!.scopes],
  })),
};
