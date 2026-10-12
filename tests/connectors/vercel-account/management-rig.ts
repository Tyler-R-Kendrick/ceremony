import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import {
  createVercelConnectAdapter,
  vercelOperationRef,
  type VercelSettings,
} from "../../../src/server/connectors/providers/vercel/index.js";
import { accountManagementSource } from "../../../src/server/connectors/providers/vercel-account/index.js";
import { ORIGIN } from "../commands/harness.js";
import { startVercelConnect } from "../doubles/vercel-connect.js";
import { buildBinding, buildConnection } from "../vercel/harness.js";
import { accountSetup, connectAndChoose } from "./harness.js";

/*
 * The rig the management-leg tests share: a signed-in account (the Vercel
 * account double behind real custody), a Vercel Connect double that asks the
 * account double whether a token is live, and the Connect adapter wired to the
 * account through `accountManagementSource`.
 */

export const TEAM = "team_dummy_acme";
export const PROJECT = "prj_main";
export const CONNECTOR = "slack/acme-slack";
export const WORKLOAD_TOKEN = "oidc_workload_token";
export const CONFIGURED_TOKEN = "vma_configured_token";
export const MINUTE = 60_000;

export const settings: VercelSettings = {
  project: { id: PROJECT, environment: "production" },
  profiles: {
    app: {
      connector: CONNECTOR,
      subject: { type: "app" },
      installation: { mode: "installation-free" },
      scopes: ["chat:write"],
    },
  },
  defaultProfile: "app",
  returnPath: "/connectors/vercel/return",
};

export async function rig(
  t: Parameters<typeof accountSetup>[0],
  options: {
    teamOnConnect?: string;
    configured?: boolean;
    account?: "signed-in" | "none";
  } = {},
) {
  const setup = await accountSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  const connectTeam = options.teamOnConnect ?? TEAM;
  const connect = await startVercelConnect({
    teamId: connectTeam,
    connectors: [
      {
        uid: CONNECTOR,
        type: "slack",
        typeName: "Slack",
        service: "slack",
        projects: { [PROJECT]: ["production"] },
      },
    ],
    credentials: [
      {
        token: WORKLOAD_TOKEN,
        kind: "workload",
        teamId: connectTeam,
        projectId: PROJECT,
        environment: "production",
      },
      ...(options.configured
        ? [
            {
              token: CONFIGURED_TOKEN,
              kind: "management" as const,
              teamId: connectTeam,
            },
          ]
        : []),
    ],
    // Vercel is one backend: a token its account service says is live is live.
    authenticate: (token) =>
      setup.fixture.accessTokenValid(token)
        ? { token, kind: "management", teamId: connectTeam }
        : undefined,
  });
  t.after(connect.close);
  const accountCtx = await setup.adapterContext(connectionRef);
  const source = accountManagementSource({
    account: async () => (options.account === "none" ? undefined : accountCtx),
  });
  const adapter = createVercelConnectAdapter({ managementToken: source });
  const binding = buildBinding({
    apiOrigin: connect.origin,
    teamId: connectTeam,
    settings,
    connectors: [CONNECTOR],
    projects: [PROJECT],
    environments: ["production"],
  });
  const connection = buildConnection({ binding });
  const configuration = new Map<string, string>([
    ["VERCEL_TEAM_ID", connectTeam],
    ["VERCEL_CONNECT_WORKLOAD_TOKEN", WORKLOAD_TOKEN],
    ...(options.configured
      ? ([["VERCEL_MANAGEMENT_TOKEN", CONFIGURED_TOKEN]] as const)
      : []),
  ]);
  const connectCtx = (): AdapterCallContext => ({
    actor: setup.person,
    binding,
    connection,
    generation: connection.generation,
    signal: new AbortController().signal,
    environment: setup.ports.environment({
      fetch: globalThis.fetch,
      origin: ORIGIN,
      configuration: {
        read: async (name: string) => configuration.get(name),
        present: async (names: readonly string[]) =>
          new Set(names.filter((name) => configuration.has(name))),
        revision: async () => "cfg:1",
      },
    }),
  });
  return { setup, connectionRef, connect, accountCtx, adapter, connectCtx };
}

export const list = (
  rigged: Awaited<ReturnType<typeof rig>>,
  ctx = rigged.connectCtx(),
) =>
  rigged.adapter.invoke!(ctx, {
    operationRef: vercelOperationRef("connect.connectors.list"),
    input: {},
    commandId: `list-${Math.random().toString(36).slice(2)}`,
  });

export const bearerOf = (call: { headers: Record<string, string> }) =>
  /^Bearer (\S+)$/.exec(call.headers["authorization"] ?? "")?.[1];
