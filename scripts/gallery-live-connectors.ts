import { z } from "zod";
import { manifestSchema, type ConnectorManifest } from "../src/core/schema.js";

/**
 * The connectors this page can really connect, and what proves it.
 *
 * Three rules hold here. The manifests are truthful: each describes the
 * mechanism that actually runs, not the one that would make a better demo, and
 * each goes through the production schema so it obeys every rule the library
 * enforces on a connector anybody else writes. The evidence is live: a probe
 * reads from the provider at the moment it is called, so nothing a visitor
 * sees was written into this file. And `server` is the connector's display
 * name exactly as the viewer's claude.ai lists it, read from that list before
 * the page is published — never a plausible spelling. The first published
 * version named "github", which the account it was published for did not
 * have, and every press failed on its first step while the page blamed an
 * unanswered prompt.
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

/**
 * One tool the page will call, and what calling it does, in a person's words.
 *
 * One list, three uses: it becomes the method's scopes, the capability manifest
 * the artifact declares, and the permissions the card shows before anybody
 * presses anything. Keeping them derived from the same place is what stops the
 * card promising one thing while the page asks for another.
 */
export interface Access {
  tool: string;
  label: string;
}

export interface LiveConnector {
  manifest: ConnectorManifest;
  /**
   * The connector's display name, exactly as the viewer's claude.ai lists it.
   *
   * `callTool` addresses a connector by this string and nothing else, and the
   * manifest naming it is declared when the page is published — before the
   * page can observe anything. So the name is checked against the account's
   * connector list at publish time, and a connector that account lacks is
   * declared anyway only so the page can say, truthfully, that it is missing
   * and where to add it.
   */
  server: string;
  access: readonly Access[];
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
  access: readonly Access[],
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
        scopes: access.map((entry) => entry.tool),
        templateId: "oauth-code",
      },
    ],
  });

const count = (total: number, noun: string) =>
  `${total} ${noun}${total === 1 ? "" : "s"}`;

/**
 * Only the fields the page reads, so an unexpected extra never breaks it.
 *
 * Each shape below was read from a real answer the same connector gave in the
 * session that published this page; none is guessed from documentation. What
 * is deliberately absent is as important as what is present: an email
 * address, an avatar, an account id — the answers carry them and the page
 * never reads them, so they cannot end up on a screen.
 */
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

const vercelTeams = z.object({
  teams: z.array(
    z.object({
      name: z.string(),
      slug: z.string().nullish(),
      plan: z.string().nullish(),
    }),
  ),
});

const linearUser = z.object({
  name: z.string().nullish(),
  displayName: z.string().nullish(),
  isAdmin: z.boolean().nullish(),
  teams: z
    .array(z.object({ name: z.string(), key: z.string().nullish() }))
    .nullish(),
});

const supabaseAccess: readonly Access[] = [
  { tool: "list_projects", label: "List your Supabase projects" },
];

const vercelAccess: readonly Access[] = [
  { tool: "list_teams", label: "List your Vercel teams" },
];

const linearAccess: readonly Access[] = [
  { tool: "get_user", label: "Read your Linear profile" },
];

const through =
  "reached through the connector you approved in claude.ai. It never sees a token and never writes.";

export const liveConnectors: readonly LiveConnector[] = [
  {
    manifest: delegated(
      "supabase",
      "Supabase",
      `Your Supabase account, ${through} It reads nothing inside your projects.`,
      supabaseAccess,
    ),
    server: "Supabase",
    access: supabaseAccess,
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
  {
    manifest: delegated(
      "vercel",
      "Vercel",
      `Your Vercel account, ${through} It lists your teams and nothing inside them.`,
      vercelAccess,
    ),
    server: "Vercel",
    access: vercelAccess,
    async probe(call) {
      const { teams } = vercelTeams.parse(await call("list_teams"));
      const facts: Fact[] = [
        { label: "Teams", value: count(teams.length, "team") },
      ];
      for (const team of teams.slice(0, 3))
        facts.push({
          label: team.name,
          value: [team.slug, team.plan && `${team.plan} plan`]
            .filter(Boolean)
            .join(" · "),
        });
      return {
        reference: teams.find((team) => team.slug)?.slug ?? "vercel",
        headline: teams.length
          ? `Connected to Vercel · ${count(teams.length, "team")}`
          : "Connected to Vercel · no teams yet",
        facts,
      };
    },
  },
  {
    manifest: delegated(
      "linear",
      "Linear",
      `Your Linear account, ${through} It reads your own profile and nothing else.`,
      linearAccess,
    ),
    server: "Linear",
    access: linearAccess,
    async probe(call) {
      // "me" is the connector's own word for the person who authorized it, so
      // the answer is about them and not about a name written here.
      const me = linearUser.parse(await call("get_user", { query: "me" }));
      const who = me.name ?? me.displayName ?? "you";
      const teams = me.teams ?? [];
      const facts: Fact[] = [];
      if (me.displayName)
        facts.push({ label: "Account", value: me.displayName });
      if (typeof me.isAdmin === "boolean")
        facts.push({ label: "Role", value: me.isAdmin ? "Admin" : "Member" });
      facts.push({ label: "Teams", value: count(teams.length, "team") });
      if (teams.length)
        facts.push({
          label: "Member of",
          value: teams
            .map((team) =>
              team.key ? `${team.name} (${team.key})` : team.name,
            )
            .join(", "),
        });
      return {
        reference: me.displayName ?? me.name ?? "linear",
        headline: `Connected to Linear as ${who}`,
        facts,
      };
    },
  },
];

/** Exactly what the page must declare to be allowed to make these calls. */
export const mcpManifest = {
  servers: liveConnectors.map((live) => ({
    server: live.server,
    tools: live.access.map((entry) => entry.tool),
  })),
};
