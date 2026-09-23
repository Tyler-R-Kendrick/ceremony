import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ActorContext } from "../../src/core/operation-contracts.js";
import type { ManagedBrowser } from "../../src/server/browser-backends.js";
import {
  createSecrets,
  runCeremony,
  type CeremonyPage,
  type CeremonyRunOptions,
  type HumanParticipation,
  type IssuedValues,
} from "../../src/server/browser-driver.js";
import { createHeuristicInterpreter } from "../../src/server/browser-interpreter.js";
import type {
  CertificationFlowPlan,
  CertificationStep,
} from "../../src/server/connectors/attended-harness.js";
import type { CertificationFlow } from "../../src/server/connectors/certification.js";
import {
  createCatalogHttpAdapter,
  providerCatalogBindingSettings,
} from "../../src/server/connectors/formats/provider-catalog/index.js";
import { ConnectorAdapterRegistry } from "../../src/server/connectors/index.js";
import {
  ConnectorCommandService,
  defaultConnectorPolicy,
} from "../../src/server/connectors/commands/index.js";
import { SQLiteCeremonyStore } from "../../src/server/persistence/index.js";
import {
  human as humanActor,
  memoryArtifactStore,
  memoryDefinitionStore,
  TENANT,
} from "../connectors/commands/harness.js";
import { memoryPorts } from "../connectors/doubles/ports.js";
import {
  authScenarios,
  createIdentity,
  startScenario,
} from "../doubles/auth-provider/scenarios.js";
import { startAuthProvider } from "../doubles/auth-provider/server.js";
import {
  configureSignIn,
  issuedAtA,
  registrationPlan,
  signInPlan,
  startChainProviders,
} from "../doubles/auth-provider/two-provider-chain.js";

/*
 * The three certification flows, as rehearsals against the local auth
 * double: the same harness, the same driver, the same production heuristic
 * interpreter and a real Chromium, with every provider a loopback double and
 * every credential synthetic. Each plan is marked `rehearsal`, and the ledger
 * validator refuses what it produces as a certification.
 *
 * A step the driver hands to a person is first acted out by the auth
 * double's scripted human participant (a person choosing a region), then
 * put to the attendant for confirmation exactly as a real run would.
 */

export type RehearsalPlan = {
  plan: CertificationFlowPlan;
  close(): Promise<void>;
};

type Plan = Omit<CeremonyRunOptions, "page" | "interpreter"> & {
  entryUrl: string;
};

/** Runs one plan in a fresh browser context with the production interpreter. */
async function drive(
  browser: ManagedBrowser,
  plan: Plan,
  human: (page: CeremonyPage) => HumanParticipation | undefined,
  issued?: CeremonyRunOptions["issued"],
) {
  const context = await browser.openContext();
  try {
    const { page } = await context.openPage();
    await page.goto(plan.entryUrl);
    const participation = human(page);
    const { entryUrl: _entry, ...options } = plan;
    void _entry;
    return await runCeremony({
      ...options,
      page,
      interpreter: createHeuristicInterpreter(),
      ...(participation ? { human: participation } : {}),
      ...(issued ? { issued } : {}),
    });
  } finally {
    await context.close();
  }
}

/**
 * The scripted person acts in the page, then the harness's participation
 * (the attendant's confirmation) decides whether it counts.
 */
function actThenConfirm(
  scripted: HumanParticipation,
  attended: HumanParticipation,
): HumanParticipation {
  return {
    contract: attended.contract,
    ...(attended.maxRequests === undefined
      ? {}
      : { maxRequests: attended.maxRequests }),
    async request(request) {
      const acted = await scripted.request(request);
      if (acted !== "completed") return acted;
      return attended.request(request);
    },
  };
}

async function registration(browser: ManagedBrowser): Promise<RehearsalPlan> {
  const scenario = authScenarios.find(
    (item) => item.id === "registration-region-chosen-by-a-person",
  )!;
  const identity = createIdentity();
  const context = await startScenario(scenario, identity);
  const plan = (await scenario.plan(context)) as Plan;
  const steps: CertificationStep[] = [
    {
      id: "register",
      kind: "driver",
      confirm:
        "The provider created the account and it is signed in, as I saw it.",
      run: (attended) =>
        drive(browser, plan, (page) =>
          actThenConfirm(scenario.human!(page, identity, context), attended),
        ),
    },
    {
      id: "provider-confirms-account",
      kind: "service",
      run: async () =>
        Boolean(context.provider.account(identity.email)?.verified) &&
        context.provider.regionOf(identity.email) !== undefined,
    },
  ];
  return {
    plan: {
      flow: "registration",
      adapterId: "catalog-http",
      definition: "rehearsal:auth-double-registration",
      provider: {
        name: "Auth double (rehearsal)",
        origins: [context.provider.origin],
      },
      rehearsal: true,
      steps,
    },
    close: context.close,
  };
}

async function stitchedChain(browser: ManagedBrowser): Promise<RehearsalPlan> {
  const chain = await startChainProviders();
  let kept: IssuedValues | undefined;
  const steps: CertificationStep[] = [
    {
      id: "register-app-at-a",
      kind: "driver",
      confirm:
        "An OAuth app for the second provider was registered at the first, as I saw it.",
      run: () =>
        drive(browser, registrationPlan(chain), () => undefined, {
          fields: issuedAtA,
          keep: async (values) => {
            kept = values;
          },
        }),
    },
    {
      id: "configure-b",
      kind: "service",
      run: async () =>
        Boolean(kept?.["client-id"]) &&
        (
          await configureSignIn(chain.b, {
            clientId: kept!["client-id"]!,
            clientSecret: kept!["client-secret"] ?? "",
          })
        ).status === 200,
    },
    {
      id: "sign-in-at-b",
      kind: "driver",
      confirm:
        "The second provider signed the person in through the app registered at the first, as I saw it.",
      run: (attended) => drive(browser, signInPlan(chain), () => attended),
    },
    {
      id: "same-account",
      kind: "human",
      question:
        "The account signed in at the second provider is the one that owns the app at the first.",
    },
  ];
  return {
    plan: {
      flow: "stitched-chain",
      adapterId: "catalog-http",
      definition: "rehearsal:two-provider-chain",
      provider: {
        name: "Two-provider chain (rehearsal)",
        origins: [chain.a.origin, chain.b.origin],
      },
      rehearsal: true,
      steps,
    },
    close: chain.close,
  };
}

/** A loopback page for the connector callback, so the browser lands somewhere. */
async function startCallbackOrigin() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      '<!doctype html><html><head><meta charset="utf-8"><title>Callback received</title></head><body><h1>Callback received</h1></body></html>',
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function catalogConnect(browser: ManagedBrowser): Promise<RehearsalPlan> {
  const identity = createIdentity();
  const provider = await startAuthProvider({
    seed: 43,
    layout: "classic-card",
    accounts: [
      {
        email: identity.email,
        username: identity.username,
        password: identity.password,
        verified: true,
      },
    ],
  });
  const callback = await startCallbackOrigin();
  try {
    return await catalogConnectAt(browser, identity, provider, callback);
  } catch (error) {
    await callback.close();
    await provider.close();
    throw error;
  }
}

async function catalogConnectAt(
  browser: ManagedBrowser,
  identity: ReturnType<typeof createIdentity>,
  provider: Awaited<ReturnType<typeof startAuthProvider>>,
  callback: Awaited<ReturnType<typeof startCallbackOrigin>>,
): Promise<RehearsalPlan> {
  const registry = new ConnectorAdapterRegistry();
  registry.register(createCatalogHttpAdapter({ allowLoopbackHttp: true }));
  // The real command service over in-memory ports, with its origin on the
  // loopback callback page so the browser lands on the connector's callback.
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "rehearsal",
    keys: { rehearsal: randomBytes(32) },
  });
  const ports = memoryPorts();
  const definitions = memoryDefinitionStore();
  const configuration = new Map([
    ["AUTH_DOUBLE_CLIENT_ID", "rehearsal-client"],
    ["AUTH_DOUBLE_CLIENT_SECRET", "rehearsal-client-secret"],
  ]);
  const harness = {
    definitions,
    service: new ConnectorCommandService({
      registry,
      ports: {
        connections: ports.connections,
        evidence: ports.evidence,
        effects: ports.effects,
        handoffs: ports.handoffs,
        credentials: ports.credentials,
        definitions,
        artifacts: memoryArtifactStore(),
      },
      configuration: () => ({
        read: async (name) => configuration.get(name),
        present: async (names) =>
          new Set(names.filter((name) => configuration.has(name))),
        revision: async () => "cfg:rehearsal",
      }),
      policy: defaultConnectorPolicy({ store, loopbackFixtures: true }),
      fetch: (input, init) => fetch(input as RequestInfo, init),
      origin: callback.origin,
    }),
    close: () => store.close(),
  };
  const actor: ActorContext = humanActor();
  const imported = await harness.service.import(actor, {
    kind: "upload",
    mediaType: "application/json",
    adapterId: "catalog-http",
    text: JSON.stringify({
      "auth-double": {
        display_name: "Auth double",
        categories: ["identity"],
        auth_mode: "OAUTH2",
        authorization_url: `${provider.origin}/authorize`,
        token_url: `${provider.origin}/token`,
        default_scopes: ["profile"],
        proxy: { base_url: provider.origin },
      },
    }),
  });
  const definition = (await harness.definitions.getDefinition(
    TENANT,
    imported.definitions[0]!,
  ))!;
  let connectionRef = "";
  let operationRef = "";
  let authorizationUrl = "";
  let callbackResult: { code: string; state?: string } | undefined;
  const steps: CertificationStep[] = [
    {
      id: "review-and-connect",
      kind: "service",
      run: async () => {
        const reference = await harness.service.approveBinding(actor, {
          definitionRef: definition.definitionRef,
          adapterId: "catalog-http",
          approvals: {
            destinations: [provider.origin],
            operations: [
              { nativeId: "proxy.get", outputClassification: "personal" },
            ],
            profileId: "oauth2",
            settings: providerCatalogBindingSettings(definition),
          },
        });
        const binding = harness.definitions
          .bindings()
          .filter((item) => item.bindingRef === reference.bindingRef)
          .sort((a, b) => a.revision - b.revision)
          .at(-1)!;
        operationRef = binding.operations.find(
          (item) => item.nativeId === "proxy.get",
        )!.operationRef;
        const view = (await harness.service.connect(actor, {
          bindingRef: reference.bindingRef,
          intent: { profileId: "oauth2", requestedPermissions: [] },
        })) as { connectionRef: string; presentation?: { url?: string } };
        connectionRef = view.connectionRef;
        authorizationUrl = view.presentation?.url ?? "";
        return Boolean(authorizationUrl);
      },
    },
    {
      id: "authorize",
      kind: "driver",
      confirm:
        "I signed in at the provider and approved this connector's access, as I saw it.",
      run: async (attended) => {
        const result = await drive(
          browser,
          {
            entryUrl: authorizationUrl,
            goal: "authorize",
            secrets: createSecrets({
              username: identity.username,
              email: identity.email,
              password: identity.password,
            }),
            allowedOrigins: [provider.origin],
            protectedValues: [identity.password],
            redirectUri: harness.service.callbackUrl,
            maxSteps: 20,
          },
          () => attended,
        );
        if (result.status === "completed") callbackResult = result.callback;
        return result;
      },
    },
    {
      id: "callback-and-verify",
      kind: "service",
      run: async () => {
        if (!callbackResult) return false;
        const url = new URL(harness.service.callbackUrl);
        url.searchParams.set("code", callbackResult.code);
        if (callbackResult.state)
          url.searchParams.set("state", callbackResult.state);
        const view = (await harness.service.callback(actor, url)) as {
          lifecycle?: string;
        };
        if (view.lifecycle !== "active") return false;
        const call = await harness.service.invoke(actor, connectionRef, {
          operationRef,
          input: { path: "/userinfo" },
          commandId: `rehearsal-${Date.now().toString(36)}`,
        });
        return (
          call.state === "complete" &&
          (call.output as { status?: number } | undefined)?.status === 200
        );
      },
    },
  ];
  return {
    plan: {
      flow: "catalog-connect",
      adapterId: "catalog-http",
      definition: `sha256:${definition.normalizedDigest}`,
      provider: {
        name: "Auth double (rehearsal)",
        origins: [provider.origin],
      },
      rehearsal: true,
      steps,
    },
    close: async () => {
      await harness.close();
      await callback.close();
      await provider.close();
    },
  };
}

/** A rehearsal plan for one flow; the caller owns `browser` and must call `close`. */
export async function rehearsalPlan(
  flow: CertificationFlow,
  browser: ManagedBrowser,
): Promise<RehearsalPlan> {
  switch (flow) {
    case "registration":
      return registration(browser);
    case "stitched-chain":
      return stitchedChain(browser);
    case "catalog-connect":
      return catalogConnect(browser);
  }
}
