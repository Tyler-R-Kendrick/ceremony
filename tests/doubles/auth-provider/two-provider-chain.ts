import { randomBytes } from "node:crypto";
import {
  createSecrets,
  type CeremonyRunOptions,
} from "../../../src/server/browser-driver.js";
import { oauthAppsPath } from "./developer-settings.js";
import { startRelyingApp, type RelyingApp } from "./relying-app.js";
import { startAuthProvider, type ProviderDouble } from "./server.js";

/**
 * The two providers of "create an OAuth app at A, use it at B", started
 * together, and the two browser plans the chain drives.
 *
 * Provider A is the auth provider double with `strictClients`: it knows only
 * the clients registered at its developer settings, checks redirect URIs
 * exactly and makes confidential clients authenticate. Provider B is a
 * relying app that signs people in with A. One person owns an account at A;
 * the same account registers the app and later signs in to B through it.
 * Every value is synthetic and every server is local.
 */

export type ChainProviders = {
  a: ProviderDouble;
  b: RelyingApp;
  /** The person's account at A. Private collection stands in for these. */
  account: { email: string; username: string; password: string };
  close(): Promise<void>;
};

/** Where A shows what the chain keeps, named by label as the page shows it. */
export const issuedAtA = {
  "client-id": "Client ID",
  "client-secret": "Client secret",
} as const;

export async function startChainProviders(): Promise<ChainProviders> {
  const seed = randomBytes(4).toString("hex");
  const account = {
    email: `owner-${seed}@ceremony.invalid`,
    username: `owner-${seed}`,
    password: `pw-${randomBytes(9).toString("base64url")}`,
  };
  const a = await startAuthProvider({
    layout: "classic-card",
    strictClients: true,
    accounts: [account],
  });
  const b = await startRelyingApp({
    issuer: a.origin,
    issuerName: "Northwind Cloud",
    layout: "split-panel",
  });
  return {
    a,
    b,
    account,
    close: async () => {
      await b.close();
      await a.close();
    },
  };
}

type Plan = Omit<CeremonyRunOptions, "page" | "interpreter"> & {
  entryUrl: string;
};

/**
 * Step 1, in the browser at A: sign in, open "New OAuth app" with B's public
 * details filled in the way B's own "register this app" link would, submit,
 * generate a client secret. The plan keeps the client ID and secret it names
 * by label; nothing else in it knows either value.
 */
export function registrationPlan(
  chain: ChainProviders,
  options: { callbackUrl?: string } = {},
): Omit<Plan, "issued"> {
  const entry = new URL(`${chain.a.origin}${oauthAppsPath}/new`);
  entry.searchParams.set("name", chain.b.name);
  entry.searchParams.set("homepage_url", chain.b.homepageUrl);
  entry.searchParams.set(
    "callback_url",
    options.callbackUrl ?? chain.b.callbackUrl,
  );
  return {
    entryUrl: entry.href,
    goal: "obtain-credential",
    secrets: createSecrets({
      username: chain.account.username,
      password: chain.account.password,
    }),
    allowedOrigins: [chain.a.origin],
    protectedValues: [chain.account.password],
    maxSteps: 16,
    verify: async () =>
      chain.a
        .oauthApps()
        .some(
          (app) =>
            app.owner === chain.account.email &&
            app.callbackUrl === (options.callbackUrl ?? chain.b.callbackUrl) &&
            app.secrets > 0,
        ),
  };
}

/**
 * Step 3, in the browser at B: "Continue with Northwind Cloud", sign in at A,
 * allow B's registered app, and arrive back at B signed in. Both origins are
 * admitted; the password is only ever typed on A's.
 */
export function signInPlan(chain: ChainProviders): Plan {
  return {
    entryUrl: `${chain.b.origin}/login`,
    goal: "sign-in",
    secrets: createSecrets({
      username: chain.account.username,
      password: chain.account.password,
    }),
    allowedOrigins: [chain.b.origin, chain.a.origin],
    protectedValues: [chain.account.password],
    maxSteps: 16,
    verify: async () => chain.b.signIns().includes(chain.account.email),
  };
}

/** Configure B's "Sign in with A" through its admin API, as step 2 does. */
export async function configureSignIn(
  b: RelyingApp,
  client: { clientId: string; clientSecret?: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${b.origin}/api/admin/sign-in-providers/idp`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${b.adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_id: client.clientId,
      client_secret: client.clientSecret ?? "",
    }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}
