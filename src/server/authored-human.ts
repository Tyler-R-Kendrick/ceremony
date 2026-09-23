import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { loopbackAuthFetch, publicAuthFetch } from "./public-auth-fetch.js";
import { accountIdentifierSchema } from "../core/teaching-contracts.js";
import { AuthorizationError } from "./identity.js";
import { boundedText } from "./authorization.js";
import {
  browserHumanActionSchema,
  type AuthorizationBrowser,
} from "./browser-executor.js";
import type { AsyncCeremonyStore, StoredRecord } from "./persistence/index.js";
import { AsyncPrivateCollectionBroker } from "./persistence/collections.js";
import type { RunRecord } from "./commands.js";
import type { OperationContext } from "./recipes/registry.js";
import {
  authoredLoginStatus,
  authoredCredentialFields,
  authoredCredentialStored,
  writeAuthoredCredential,
  accountBrowserKey,
  authoredNativeKey,
  readAccountBrowser,
  readPendingRegistration,
  recoverAuthoredRegistration,
  authoredOauthKey,
  discoveredAuthSchema,
  installedConnector,
  publicAuthoredIdentity,
  readAuthoredAccountIntent,
  readAuthoredCeremony,
  readAuthoredBlocker,
  saveAuthoredAccountIntent,
  saveAuthoredAuthorizationSession,
  saveAuthoredBlocker,
  saveAuthoredDeviceSession,
  saveAuthoredGrantSession,
  saveAuthoredLogin,
  saveInstalledDiscovery,
} from "./authored-operations.js";
import {
  discoverProviderAuth,
  isProviderOwnedAuth,
} from "./provider-discovery.js";
import { originCandidatesFromProvider } from "../core/connector-authoring.js";
import {
  authoredClientAuthentication,
  authoredClientSecretNeeded,
  ensureAuthoredApp,
  humanRedirectUri,
  readAuthoredApp,
  saveAuthoredClientSecret,
} from "./authored-app.js";
import {
  applyClientAuthentication,
  exchangeAuthorizationCode,
  beginAuthorization,
  requestedScopes,
  type ClientAuthentication,
} from "./authored-oauth.js";

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
type Ticket = {
  isolated?: boolean;
  subject: string;
  session: string;
  actorSession: string;
  discovery: z.infer<typeof discoveredAuthSchema>;
  runId: string;
  nodeId: string;
  revision: number;
  expires: number;
  state?: string;
  verifier?: string;
  deviceCode?: string;
  userCode?: string;
  verificationUri?: string;
  interval?: number;
  nextPoll?: number;
  dpopJwk?: JsonWebKey;
};

function ticketMatchesAttempt(
  ticket: Ticket,
  context: OperationContext,
  nodeId: string,
) {
  return (
    ticket.subject === context.actor.subjectId &&
    ticket.actorSession === context.actor.sessionId &&
    ticket.runId === context.runId &&
    ticket.nodeId === nodeId
  );
}

async function startDeviceAuthorization(
  endpoint: string,
  clientId: string,
  scope: string,
  fetcher: typeof fetch,
  clientAuth?: ClientAuthentication,
) {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  };
  const body = new URLSearchParams({ client_id: clientId, scope });
  applyClientAuthentication(clientId, headers, body, clientAuth);
  const response = await fetcher(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers,
    body,
  });
  if (!response.ok) return;
  const json = z
    .object({
      device_code: z.string().min(1).max(512),
      user_code: z.string().min(1).max(64),
      verification_uri: z.string().url(),
      verification_uri_complete: z.string().url().optional(),
      expires_in: z.coerce.number().int().positive(),
      interval: z.coerce.number().int().positive().optional(),
    })
    .safeParse(await response.json());
  return json.success ? json.data : undefined;
}

function consoleHints(origin: string) {
  try {
    const host = new URL(origin).hostname.replace(
      /^(auth|api|accounts|login|www)\./,
      "",
    );
    return [`https://console.${host}`, `https://developer.${host}`];
  } catch {
    return [];
  }
}

/**
 * Generic A2H for authored ceremonies. Secrets this host does collect (an API
 * key, a password, a confidential client's secret) arrive only through the
 * native private forms here, go straight to server-side custody and are
 * never echoed into a page, a run snapshot, an event or a model.
 */
export async function authoredHuman(
  store: AsyncCeremonyStore,
  context: OperationContext,
  record: StoredRecord<RunRecord>,
  request: Request,
  returnUrl: string,
  advance: () => Promise<void>,
  options: {
    fetch?: typeof fetch;
    connectorId: string;
    name: string;
    allowLoopbackHttp?: boolean;
    browser?: AuthorizationBrowser;
  },
): Promise<Response> {
  if (
    context.actor.actorKind !== "human" ||
    record.value.subjectId !== context.actor.subjectId ||
    record.value.sessionId !== context.actor.sessionId ||
    record.value.status === "cancelled"
  )
    throw new AuthorizationError("denied");
  const headers = {
    "cache-control": "no-store",
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
  };
  const installed = await installedConnector(
    store,
    context.actor,
    options.connectorId,
  );
  const name = installed?.manifest?.name || options.name;
  const identity = await publicAuthoredIdentity(
    store,
    context.actor,
    context.runId,
  );
  if (identity)
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(name)} connected</title></head><body><main><h1>Connected as ${escape(identity.handle)}</h1><p><code>${escape(identity.did)}</code></p><p><a href="${escape(returnUrl)}">Return to connection</a></p></main></body></html>`,
      { headers: { ...headers, "content-type": "text/html; charset=utf-8" } },
    );
  let discovery = discoveredAuthSchema.parse(
    installed?.discovery ?? {
      origin: "",
      documents: [],
      methods: [],
      grantTypes: [],
      searchUsed: false,
    },
  );
  const pending = await store.transaction(async (tx) => {
    for (const node of record.value.nodes) {
      const state = await tx.get<{ verified: boolean; state: string }>({
        tenant: context.actor.tenantId,
        kind: "node",
        id: `${context.runId}:${node.id}`,
      });
      if (!state?.value.verified) return { node, state: state?.value.state };
    }
    return undefined;
  });
  if (
    !pending ||
    pending.state !== "awaiting-human" ||
    ![
      "authored.prepare-app",
      "authored.register-account",
      "authored.authorize-user",
      "authored.collect-credential",
    ].includes(pending.node.operationId)
  )
    throw new AuthorizationError("denied");
  if (
    record.value.profile !== "authored" &&
    pending.node.operationId !== "authored.register-account"
  )
    throw new AuthorizationError("denied");
  const blocker = await readAuthoredBlocker(
    store,
    context.actor,
    context.runId,
  );
  const browserKey = accountBrowserKey(context.actor, context.runId).id;
  const browserState = await readAccountBrowser(
    store,
    context.actor,
    context.runId,
  );
  const registrationContext = { ...context, nodeId: pending.node.id };
  const recovery = await readPendingRegistration(
    store,
    registrationContext,
    options.connectorId,
  );
  const nativeMode = async () => {
    const requestedFlow =
      new URL(request.url).searchParams.get("flow") ??
      ((await readAuthoredCeremony(store, context.actor, context.runId)) ===
      "device"
        ? "device"
        : null);
    const nativeKey = authoredNativeKey(context.actor, context.runId);
    const nativeRequest =
      ["native", "oauth-code", "device"].includes(requestedFlow ?? "") ||
      ["passkey", "popup"].includes(blocker ?? "");
    const native =
      nativeRequest ||
      Boolean(await store.transaction((tx) => tx.get(nativeKey)));
    if (nativeRequest)
      await store.transaction(async (tx) => {
        const previous = await tx.get(nativeKey);
        if (!previous) await tx.put(nativeKey, { requested: true }, null);
      });
    return { requestedFlow, native };
  };
  const { requestedFlow, native } = await nativeMode();
  const browserImage = async () => {
    if (
      request.method === "GET" &&
      new URL(request.url).searchParams.has("browser-image")
    ) {
      const screenshot =
        browserState?.pending &&
        (await options.browser?.screenshot?.(browserKey));
      return screenshot
        ? new Response(Buffer.from(screenshot), {
            headers: { ...headers, "content-type": "image/png" },
          })
        : new Response("Browser session expired", { status: 410, headers });
    }
  };
  const screenshotResponse = await browserImage();
  if (screenshotResponse) return screenshotResponse;
  /**
   * The provider's live view of the waiting tab, for a remote browser that
   * offers one. Minted here, in the authenticated human route, by the
   * process holding the browser, and handed over only as this redirect: the
   * URL controls the tab, so it never reaches a page body, a run record or
   * the assistant.
   */
  const liveViewRedirect = async () => {
    if (
      request.method !== "GET" ||
      !new URL(request.url).searchParams.has("live-view")
    )
      return;
    const url =
      browserState?.pending && (await options.browser?.liveView?.(browserKey));
    return url
      ? new Response(null, {
          status: 303,
          headers: {
            ...headers,
            location: url,
            "referrer-policy": "no-referrer",
          },
        })
      : new Response("Browser session expired", { status: 410, headers });
  };
  const liveViewResponse = await liveViewRedirect();
  if (liveViewResponse) return liveViewResponse;
  const oauthKey = {
    tenant: context.actor.tenantId,
    kind: "handoff" as const,
    id: `authored-oauth:${createHash("sha256").update(context.runId).digest("hex").slice(0, 24)}`,
  };
  const fetcher =
    options.fetch ??
    (options.allowLoopbackHttp ? loopbackAuthFetch : publicAuthFetch);
  const redirectUri = new URL(request.url);
  redirectUri.search = "";
  redirectUri.hash = "";
  const completeCallback = async () => {
    const url = new URL(request.url);
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const prior = await store.transaction((tx) => tx.get<Ticket>(oauthKey));
    if (
      !prior ||
      prior.value.isolated ||
      url.searchParams.getAll("state").length !== 1 ||
      url.searchParams.getAll("code").length > 1 ||
      url.searchParams.getAll("error").length > 1 ||
      !ticketMatchesAttempt(prior.value, context, pending.node.id) ||
      prior.value.revision > record.revision ||
      prior.value.state !== state ||
      !prior.value.verifier ||
      prior.value.expires <= Date.now()
    )
      throw new AuthorizationError("denied");
    discovery = discoveredAuthSchema.parse(prior.value.discovery);
    const clientAuth = await authoredClientAuthentication(
      store,
      context.actor,
      options.connectorId,
      prior.value.session,
      discovery.tokenEndpointAuthMethod,
    );
    if (!clientAuth) throw new AuthorizationError("denied");
    // Consume before exchanging a single-use code. An uncertain exchange is never replayed.
    await store.transaction((tx) => tx.delete(oauthKey, prior.revision));
    if (url.searchParams.has("error")) {
      await saveAuthoredBlocker(
        store,
        context.actor,
        context.runId,
        "provider-denied",
      );
      return new Response(
        '<!doctype html><html lang="en"><meta charset="utf-8"><title>Authorization not completed</title><h1>Authorization was not completed</h1><p>No connection was approved. The provider declined or could not finish authentication.</p><a href="?flow=native">Choose a supported sign-in method</a></html>',
        { headers: { ...headers, "content-type": "text/html; charset=utf-8" } },
      );
    }
    let created;
    if (
      prior.value.dpopJwk ||
      discovery.requirePushedAuthorizationRequests ||
      discovery.dpopRequired
    ) {
      if (!discovery.authorizationEndpoint || !discovery.tokenEndpoint)
        throw new AuthorizationError("denied");
      const grant = await exchangeAuthorizationCode({
        discovery: {
          origin: discovery.origin || discovery.issuer || "",
          authorizationEndpoint: discovery.authorizationEndpoint,
          tokenEndpoint: discovery.tokenEndpoint,
          ...(discovery.issuer ? { issuer: discovery.issuer } : {}),
          ...(discovery.pushedAuthorizationRequestEndpoint
            ? {
                pushedAuthorizationRequestEndpoint:
                  discovery.pushedAuthorizationRequestEndpoint,
              }
            : {}),
        },
        clientId: prior.value.session,
        redirectUri: redirectUri.href,
        callbackUrl: request.url,
        verifier: prior.value.verifier,
        state,
        ...(prior.value.dpopJwk ? { dpopJwk: prior.value.dpopJwk } : {}),
        clientAuth,
        fetch: fetcher,
      });
      created = await saveAuthoredGrantSession(
        store,
        context.actor,
        context.runId,
        discovery,
        grant,
        fetcher,
        prior.value.dpopJwk,
      );
    } else
      created = await saveAuthoredAuthorizationSession(
        store,
        context.actor,
        context.runId,
        discovery,
        {
          code,
          redirectUri: redirectUri.href,
          verifier: prior.value.verifier,
          clientId: prior.value.session,
        },
        fetcher,
        clientAuth,
      );
    if (!created) throw new AuthorizationError("denied");
    await options.browser?.close?.(browserKey);
    await advance();
    return Response.redirect(returnUrl, 303);
  };
  if (
    request.method === "GET" &&
    (new URL(request.url).searchParams.has("code") ||
      new URL(request.url).searchParams.has("error"))
  )
    return completeCallback();
  const interactWithBrowser = async (form: URLSearchParams) => {
    const action = browserHumanActionSchema.parse(
      Object.fromEntries(
        [...form].filter(([key, value]) => key !== "action" && value !== ""),
      ),
    );
    if (
      !browserState?.pending ||
      !(await options.browser?.interact?.(browserKey, action))
    )
      return new Response(
        "Browser session expired. Return to the connection to restart.",
        { status: 410, headers },
      );
    // Clicking a challenge refreshes its screenshot; Continue/code resumes automation.
    if ("code" in action || Object.keys(action).length === 0) {
      await advance();
      return Response.redirect(returnUrl, 303);
    }
    return Response.redirect(request.url, 303);
  };
  const submitHumanInput = async () => {
    const form = new URLSearchParams(await boundedText(request, 16_384));
    if (form.get("action") === "recover-registration") {
      if (!recovery || native) throw new AuthorizationError("denied");
      await options.browser?.close?.(browserKey);
      await recoverAuthoredRegistration(
        store,
        registrationContext,
        options.connectorId,
      );
      await saveAuthoredBlocker(store, context.actor, context.runId, "");
      await advance();
      return Response.redirect(returnUrl, 303);
    }
    if (form.get("action") === "browser") return interactWithBrowser(form);
    if (
      ["authored.register-account", "authored.authorize-user"].includes(
        pending.node.operationId,
      ) &&
      ["email-in-use", "username-in-use", "account"].includes(blocker ?? "")
    ) {
      const username = accountIdentifierSchema.parse(form.get("username"));
      if (
        options.connectorId === "github" &&
        !/^[a-zA-Z0-9-]{1,100}$/.test(username)
      )
        throw new AuthorizationError("invalid_request");
      if (
        record.value.profile === "github-app" &&
        username.toLowerCase() !== record.value.target.toLowerCase()
      )
        return new Response(
          "Return to the connection and start with the new GitHub handle. This run remains bound to its original account.",
          { status: 409, headers },
        );
      await saveAuthoredAccountIntent(store, context.actor, context.runId, {
        identifier: username,
        status: form.get("mode") === "existing" ? "existing" : "unchecked",
      });
      await saveAuthoredBlocker(store, context.actor, context.runId, "");
      await advance();
      return Response.redirect(returnUrl, 303);
    }
    const password = String(form.get("password") ?? "");
    if (password.length < 1 || password.length > 1024)
      throw new AuthorizationError("denied");
    const username = String(form.get("username") ?? "").slice(0, 254);
    const intent = await readAuthoredAccountIntent(
      store,
      context.actor,
      context.runId,
    );
    if (
      intent &&
      username &&
      intent.identifier.toLowerCase() !== username.toLowerCase()
    )
      throw new AuthorizationError("invalid_request");
    await saveAuthoredLogin(store, context.actor, context.runId, {
      ...(username ? { username } : {}),
      password,
    });
    await advance();
    return Response.redirect(returnUrl, 303);
  };
  /**
   * The native private entry for an API key or a username and password. The
   * value is collected through the private collection broker bound to this
   * run, node and revision, consumed in the same transaction that writes it
   * into custody, and never written anywhere else.
   */
  const submitCredential = async () => {
    const form = new URLSearchParams(await boundedText(request, 16_384));
    const fields = authoredCredentialFields(installed ?? {});
    const values: Record<string, string> = {};
    for (const field of fields) {
      const value = form.get(field) ?? "";
      if (!value || value.length > (field === "username" ? 254 : 4096))
        throw new AuthorizationError("invalid_request");
      values[field] = value;
    }
    const credentialContext = { ...context, nodeId: pending.node.id };
    const binding = {
      purpose: "authored-credential",
      provider: "authored",
      operationId: "authored.collect-credential",
      operationVersion: "1.0.0",
      runId: context.runId,
      nodeId: pending.node.id,
      revision: record.revision,
      fields: [...fields],
    };
    const broker = new AsyncPrivateCollectionBroker(store);
    const reference = await broker.collect(context.actor, binding, values);
    const commandId = `authored-credential-${randomUUID()}`;
    await store.transaction(async (tx) => {
      const run = await tx.get<RunRecord>({
        tenant: context.actor.tenantId,
        kind: "run",
        id: context.runId,
      });
      const node = await tx.get<{ state: string; verified: boolean }>({
        tenant: context.actor.tenantId,
        kind: "node",
        id: `${context.runId}:${pending.node.id}`,
      });
      if (
        !run ||
        run.revision !== record.revision ||
        run.value.status !== "active" ||
        run.value.subjectId !== context.actor.subjectId ||
        run.value.sessionId !== context.actor.sessionId ||
        node?.value.state !== "awaiting-human" ||
        node.value.verified
      )
        throw new AuthorizationError("denied");
      const collected = await broker.consumeIn(
        tx,
        context.actor,
        binding,
        reference,
        commandId,
      );
      await writeAuthoredCredential(tx, credentialContext, collected);
    });
    await broker.complete(context.actor, binding, reference, commandId);
    await saveAuthoredBlocker(store, context.actor, context.runId, "");
    await advance();
    return Response.redirect(returnUrl, 303);
  };
  /** The integration owner's confidential client secret, straight into custody for the declared client. */
  const submitClientSecret = async () => {
    const form = new URLSearchParams(await boundedText(request, 16_384));
    const secret = form.get("client_secret") ?? "";
    if (
      !discovery.clientId ||
      !(await authoredClientSecretNeeded(
        store,
        context.actor,
        options.connectorId,
        discovery,
      )) ||
      !secret ||
      secret.length > 2048
    )
      throw new AuthorizationError("denied");
    await saveAuthoredClientSecret(store, context.actor, options.connectorId, {
      clientId: discovery.clientId,
      secret,
    });
    await advance();
    return Response.redirect(returnUrl, 303);
  };
  if (
    request.method === "POST" &&
    pending.node.operationId === "authored.collect-credential"
  )
    return submitCredential();
  if (
    request.method === "POST" &&
    pending.node.operationId === "authored.prepare-app"
  )
    return submitClientSecret();
  if (
    request.method === "POST" &&
    ["authored.authorize-user", "authored.register-account"].includes(
      pending.node.operationId,
    )
  )
    return submitHumanInput();
  if (request.method !== "GET") throw new AuthorizationError("denied");
  const refreshDiscovery = async () => {
    if (
      native ||
      (pending.node.operationId !== "authored.register-account" &&
        !discovery.clientId &&
        !discovery.registrationEndpoint &&
        !discovery.clientIdMetadataDocumentSupported &&
        !isProviderOwnedAuth(discovery))
    ) {
      const found = await discoverProviderAuth(
        discovery.origin
          ? [discovery.origin]
          : [
              ...originCandidatesFromProvider(name),
              ...originCandidatesFromProvider(options.connectorId),
            ].filter(Boolean),
        {
          fetch: fetcher,
          query: options.connectorId,
          ...(options.allowLoopbackHttp ? { allowLoopbackHttp: true } : {}),
        },
      );
      if (
        found.authorizationEndpoint ||
        found.deviceAuthorizationEndpoint ||
        found.clientId ||
        found.documents.length
      ) {
        if (installed)
          await saveInstalledDiscovery(
            store,
            context.actor,
            options.connectorId,
            found,
          );
        discovery = discoveredAuthSchema.parse(found);
      } else if (found.retryable) discovery = { ...discovery, retryable: true };
    }
  };
  if (pending.node.operationId !== "authored.collect-credential")
    await refreshDiscovery();
  const presentation = () => {
    const ceremonyKind =
      pending.node.operationId === "authored.prepare-app"
        ? "App registration"
        : pending.node.operationId === "authored.register-account"
          ? "Account registration"
          : pending.node.operationId === "authored.collect-credential"
            ? authoredCredentialFields(installed ?? {}).includes("token")
              ? "API key"
              : "Account credentials"
            : discovery.deviceAuthorizationEndpoint &&
                !discovery.authorizationEndpoint
              ? "OAuth device code"
              : "OAuth authorization code";
    const title = `${ceremonyKind} — ${name}`;
    const originLine = discovery.origin
      ? `<p>Origin: <code>${escape(discovery.origin)}</code>${discovery.assumed ? " (assumed from the provider name)" : ""}.</p>`
      : "";
    return { title, originLine };
  };
  const { title, originLine } = presentation();
  // Keep provider pixels unchanged: native image-submit coordinates target that page.
  const styles = ".provider-browser{overflow:auto}";
  const page = (body: string) =>
    new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${styles}</style></head><body><main>${originLine}${body}<p><a href="${escape(returnUrl)}">Return to connection</a></p></main></body></html>`,
      {
        headers: {
          ...headers,
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": `default-src 'none'; style-src 'sha256-${createHash("sha256").update(styles).digest("base64")}'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
        },
      },
    );
  const recoveryPage = () =>
    page(
      `<h1>Recover interrupted registration</h1><p>The browser is no longer available. Generated credentials are preserved privately, but registration has not been verified. Try signing in with those credentials; this does not submit registration again.</p><form method="post"><input type="hidden" name="action" value="recover-registration"><button>Try sign-in with saved credentials</button></form>`,
    );
  const accountRecovery = () => {
    if (
      !native &&
      recovery &&
      (!browserState?.pending || blocker === "session-expired")
    )
      return recoveryPage();
    if (
      ["authored.register-account", "authored.authorize-user"].includes(
        pending.node.operationId,
      ) &&
      ["email-in-use", "username-in-use", "account"].includes(blocker ?? "")
    )
      return page(
        `<h1>Choose another ${escape(name)} account name</h1>
  <p>The provider needs an account choice. Sign in if this account is yours, or choose a different account name. A GitHub App connection stays bound to the original handle; start a new connection to change it.</p>
  <form method="post">
    <label>Account name or email <input name="username" autocomplete="username" maxlength="${options.connectorId === "github" ? 100 : 254}" ${options.connectorId === "github" ? 'pattern="[A-Za-z0-9-]+"' : ""} required></label>
    <label>Action <select name="mode"><option value="register">Try registration</option><option value="existing">Sign in to my existing account</option></select></label>
    <button>Retry isolated registration</button>
  </form>`,
      );
  };
  const recoveryResponse = accountRecovery();
  if (recoveryResponse) return recoveryResponse;
  if (pending.node.operationId === "authored.collect-credential") {
    if (
      await authoredCredentialStored(store, context.actor, context.runId, {
        nodeId: pending.node.id,
      })
    ) {
      await advance();
      return Response.redirect(returnUrl, 303);
    }
    const verification = discovery.credentialVerification;
    const token = authoredCredentialFields(installed ?? {}).includes("token");
    const inputs = token
      ? `<label>API key <input name="token" type="password" autocomplete="off" maxlength="4096" required></label>`
      : `<label>Username <input name="username" autocomplete="username" maxlength="254" required></label>
    <label>Password <input name="password" type="password" autocomplete="current-password" maxlength="4096" required></label>`;
    return page(
      `<h1>${escape(title)}</h1>
  <p>Enter the ${token ? "key" : "credentials"} for ${escape(name)} here, not in chat. The value goes straight to this host's encrypted custody for this connection. It is not shown to the assistant and is not written to the run history.</p>
  ${
    verification
      ? `<p>It is checked with one request to <code>${escape(new URL(verification.url).origin)}</code> and used for nothing else here.</p>`
      : `<p>This connector declares no verification request yet, so the connection cannot be verified after you save. The author must declare one first.</p>`
  }
  <form method="post">
    ${inputs}
    <button>Save and verify</button>
  </form>`,
    );
  }
  const isolatedBrowserHandoff = async () => {
    if (
      !native &&
      ["authored.register-account", "authored.authorize-user"].includes(
        pending.node.operationId,
      ) &&
      browserState?.pending &&
      blocker !== "session"
    ) {
      const available = await options.browser?.screenshot?.(browserKey);
      if (!available && recovery) return recoveryPage();
      if (!available)
        return page(
          `<h1>Browser session expired</h1><p>The waiting browser is no longer available. Check the provider account before starting a new connection; registration may already have been submitted.</p>`,
        );
      return page(`<h1>Continue ${escape(name)}</h1><p>The browser is paused for your input. ${blocker === "required-input" ? "The provider needs information or confirmation that cannot be inferred. The missing field is selected; enter your answer below or interact with the provider page." : "Complete the challenge below, then continue."} This session expires after ten minutes.</p>
      ${options.browser?.liveView ? `<p><a href="?live-view=1" target="_blank" rel="noopener noreferrer">Take over the provider page in a live browser</a>, then return here and continue.</p>` : ""}
      <form method="post"><input type="hidden" name="action" value="browser"><label>Verification code <input name="code" autocomplete="one-time-code" maxlength="128" required></label><button>Submit code and continue</button></form>
      <div class="provider-browser" role="region" aria-label="Provider browser viewport" tabindex="0"><form method="post"><input type="hidden" name="action" value="browser"><input type="image" src="?browser-image=1" width="1280" height="720" alt="Current provider page. Scroll to view, click to interact."></form></div>
      <form method="post"><input type="hidden" name="action" value="browser"><label>Text or dropdown option label for the selected provider field <input name="text" maxlength="1024" autocomplete="off"></label><button>Apply input</button></form>
      <form method="post"><input type="hidden" name="action" value="browser"><label>Keyboard key <select name="key"><option>Tab</option><option>Enter</option><option>Space</option></select></label><button>Press key</button></form>
      <form method="post"><input type="hidden" name="action" value="browser"><button>Continue ceremony</button></form>`);
    }
    if (
      !native &&
      (blocker === "session-expired" ||
        (pending.node.operationId === "authored.register-account" &&
          !["session", "rejected"].includes(blocker ?? "")))
    )
      return page(
        `<h1>${escape(name)} needs attention</h1><p>${blocker === "inbox" ? "An email inbox is required for registration. Configure the inbox and retry." : blocker === "session-expired" ? "The previous browser expired. Check whether registration already succeeded before starting another attempt." : "The provider or browser could not be reached. Return to the connection and retry this step."}</p>`,
      );
  };
  const browserResponse = await isolatedBrowserHandoff();
  if (browserResponse) return browserResponse;
  const integrationHandoff = async () => {
    if (pending.node.operationId === "authored.prepare-app") {
      const app = await ensureAuthoredApp(store, context, discovery, fetcher);
      if (app?.clientId) {
        await advance();
        const next = new URL(request.url);
        next.search = "";
        next.hash = "";
        return Response.redirect(next.href, 303);
      }
      if (
        await authoredClientSecretNeeded(
          store,
          context.actor,
          options.connectorId,
          discovery,
        )
      )
        return page(
          `<h1>Finish the ${escape(name)} integration</h1>
  <p>This connector uses a confidential client registered at the provider. Register this redirect URI for that client, then enter its client secret. The secret goes straight to this host's encrypted custody for this connector. It is not shown to the assistant and is used only to authenticate token requests for this client.</p>
  <p>Redirect URI: <code>${escape(humanRedirectUri(context.origin, context.target, context.runId))}</code></p>
  <form method="post">
    <label>Client secret <input name="client_secret" type="password" autocomplete="off" maxlength="2048" required></label>
    <button>Save client secret</button>
  </form>`,
        );
      const consoles = discovery.origin ? consoleHints(discovery.origin) : [];
      const links = consoles
        .map(
          (url) =>
            `<p><a href="${escape(url)}">Continue at ${escape(url)}</a></p>`,
        )
        .join("");
      return page(
        `<h1>Register the ${escape(name)} integration</h1>
  <p>This host registers a public OAuth client with the provider the same way it creates a GitHub App: dynamic client registration, a published native client, or a provider developer console. It will not ask you for tokens, passwords, or client secrets.</p>
  <p>No public client is available yet. Continue at the provider if they offer a developer console; this page will keep trying registration.</p>
  ${links}`,
      );
    }
    if (
      !native &&
      ["authored.authorize-user", "authored.register-account"].includes(
        pending.node.operationId,
      )
    ) {
      const login = await authoredLoginStatus(
        store,
        context.actor,
        context.runId,
      );
      if (login === "needed") {
        const account = await readAuthoredAccountIntent(
          store,
          context.actor,
          context.runId,
        );
        return page(
          `<h1>Isolated browser needs the ${escape(name)} account</h1>
  <p>The agent is completing this ceremony in an isolated browser. Provide the account so it can continue. Values go to the encrypted broker, not chat, and are not pasted into a provider page in this tab.</p>
  <form method="post">
    <label>Account <input name="username" value="${escape(account?.identifier ?? "")}" autocomplete="username" maxlength="254"></label>
    <label>Password <input name="password" type="password" autocomplete="current-password" maxlength="1024" required></label>
    <button>Continue in the isolated browser</button>
  </form>`,
        );
      }
      const isolated = await store.transaction(async (tx) => {
        const prior = await tx.get<{ isolated?: boolean }>(
          authoredOauthKey(context.actor, context.runId),
        );
        return Boolean(prior?.value.isolated);
      });
      if (isolated) {
        await advance();
        return Response.redirect(returnUrl, 303);
      }
    }
  };
  const integrationResponse = await integrationHandoff();
  if (integrationResponse) return integrationResponse;
  const nativeHandoff = async (): Promise<Response> => {
    const app =
      (await readAuthoredApp(store, context.actor, context.runId)) ??
      (await ensureAuthoredApp(store, context, discovery, fetcher).catch(
        () => undefined,
      ));
    const scope = app?.scope || requestedScopes(discovery.scopes).join(" ");
    const clientAuth = app?.clientId
      ? await authoredClientAuthentication(
          store,
          context.actor,
          options.connectorId,
          app.clientId,
          app.tokenEndpointAuthMethod ?? discovery.tokenEndpointAuthMethod,
        )
      : undefined;
    const supportedFlows = () => {
      const canCode = Boolean(
        app?.clientId &&
        clientAuth &&
        discovery.authorizationEndpoint &&
        discovery.tokenEndpoint &&
        app.redirectRegistered &&
        (!native ||
          (discovery.userinfoEndpoint &&
            discovery.codeChallengeMethods?.includes("S256"))),
      );
      const canDevice = Boolean(
        app?.clientId &&
        clientAuth &&
        discovery.deviceAuthorizationEndpoint &&
        discovery.tokenEndpoint &&
        !app.dpopRequired &&
        !discovery.dpopRequired &&
        (!native || discovery.userinfoEndpoint),
      );
      return { canCode, canDevice };
    };
    const { canCode, canDevice } = supportedFlows();
    const devicePage = (
      userCode: string,
      verificationUri: string,
      interval: number,
    ) =>
      new Response(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="${interval}"><title>${escape(title)}</title></head><body><main>
  <h1>${escape(title)}</h1>
  <p>Continue at the provider to approve access. This host will not ask for tokens, passwords, or client secrets.</p>
  <p>If the provider asks for a code, enter <code>${escape(userCode)}</code>.</p>
  <p><a href="${escape(verificationUri)}">Continue at ${escape(name)}</a></p>
  <p>This page checks for approval automatically.</p>
  <p><a href="${escape(returnUrl)}">Return to connection</a></p>
  </main></body></html>`,
        { headers: { ...headers, "content-type": "text/html; charset=utf-8" } },
      );
    const startDevice = async () => {
      if (!app?.clientId || !discovery.deviceAuthorizationEndpoint) return;
      const device = await startDeviceAuthorization(
        discovery.deviceAuthorizationEndpoint,
        app.clientId,
        scope,
        fetcher,
        clientAuth,
      ).catch(() => undefined);
      if (!device) return;
      const verificationUri =
        device.verification_uri_complete ?? device.verification_uri;
      const verificationUrl = new URL(verificationUri);
      if (
        verificationUrl.username ||
        verificationUrl.password ||
        (verificationUrl.protocol !== "https:" &&
          !(
            options.allowLoopbackHttp &&
            verificationUrl.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(
              verificationUrl.hostname,
            )
          ))
      )
        throw new AuthorizationError("denied");
      await store.transaction(async (tx) => {
        const existing = await tx.get(oauthKey);
        await tx.put(
          oauthKey,
          {
            subject: context.actor.subjectId,
            session: app.clientId,
            actorSession: context.actor.sessionId,
            discovery,
            runId: context.runId,
            nodeId: pending.node.id,
            revision: record.revision,
            expires: (await tx.now()) + device.expires_in * 1000,
            deviceCode: device.device_code,
            userCode: device.user_code,
            verificationUri,
            interval: device.interval ?? 5,
            nextPoll: Date.now() + Math.max(5, device.interval ?? 5) * 1000,
          } satisfies Ticket,
          existing?.revision ?? null,
        );
      });
      return devicePage(
        device.user_code,
        verificationUri,
        Math.max(5, device.interval ?? 5),
      );
    };
    const startCode = async () => {
      if (
        !app?.clientId ||
        !discovery.authorizationEndpoint ||
        !discovery.tokenEndpoint
      )
        return;
      const boundDiscovery = {
        ...discovery,
        ...(app.dpopRequired ? { dpopRequired: true } : {}),
      };
      const started = await beginAuthorization({
        discovery: {
          ...boundDiscovery,
          authorizationEndpoint: discovery.authorizationEndpoint,
          tokenEndpoint: discovery.tokenEndpoint,
        },
        clientId: app.clientId,
        redirectUri: redirectUri.href,
        scope,
        ...(discovery.authorizationParams
          ? { authorizationParams: discovery.authorizationParams }
          : {}),
        ...(clientAuth ? { clientAuth } : {}),
        fetch: fetcher,
      }).catch(() => undefined);
      if (!started) return;
      await store.transaction(async (tx) => {
        const existing = await tx.get(oauthKey);
        await tx.put(
          oauthKey,
          {
            subject: context.actor.subjectId,
            session: app.clientId,
            actorSession: context.actor.sessionId,
            discovery: boundDiscovery,
            runId: context.runId,
            nodeId: pending.node.id,
            revision: record.revision,
            expires: (await tx.now()) + 600000,
            state: started.state,
            verifier: started.verifier,
            ...(started.dpopJwk ? { dpopJwk: started.dpopJwk } : {}),
          } satisfies Ticket,
          existing?.revision ?? null,
        );
      });
      return Response.redirect(started.location, 303);
    };
    const pollDevice = async (
      prior: StoredRecord<Ticket>,
      deviceCode: string,
    ) => {
      if (
        !ticketMatchesAttempt(prior.value, context, pending.node.id) ||
        prior.value.revision > record.revision
      )
        throw new AuthorizationError("denied");
      if (prior.value.expires <= Date.now()) {
        await store.transaction((tx) => tx.delete(oauthKey, prior.revision));
        return page(
          '<h1>Approval expired</h1><p>No connection was approved.</p><a href="?flow=device">Start a new device authorization</a>',
        );
      }
      const interval = Math.max(5, prior.value.interval ?? 5);
      if ((prior.value.nextPoll ?? 0) > Date.now())
        return devicePage(
          prior.value.userCode!,
          prior.value.verificationUri!,
          Math.ceil((prior.value.nextPoll! - Date.now()) / 1000),
        );
      // A confidential client never falls back to an unauthenticated poll.
      const pollAuth = await authoredClientAuthentication(
        store,
        context.actor,
        options.connectorId,
        prior.value.session,
        prior.value.discovery.tokenEndpointAuthMethod,
      );
      if (!pollAuth) throw new AuthorizationError("denied");
      const reserved = await store.transaction((tx) =>
        tx.put(
          oauthKey,
          { ...prior.value, nextPoll: Date.now() + interval * 1000 },
          prior.revision,
        ),
      );
      const poll = await saveAuthoredDeviceSession(
        store,
        context.actor,
        context.runId,
        prior.value.discovery,
        {
          deviceCode,
          clientId: prior.value.session,
        },
        fetcher,
        pollAuth,
      );
      if (poll.status === "ready") {
        await store.transaction((tx) => tx.delete(oauthKey, reserved));
        await options.browser?.close?.(browserKey);
        await advance();
        return Response.redirect(returnUrl, 303);
      }
      if (
        poll.status === "pending" &&
        prior.value.userCode &&
        prior.value.verificationUri
      ) {
        const nextInterval = Math.max(
          poll.transient ? interval * 2 : poll.slow ? interval + 5 : interval,
          poll.retryAfter,
        );
        if (poll.slow)
          await store.transaction((tx) =>
            tx.put(
              oauthKey,
              {
                ...prior.value,
                interval: nextInterval,
                nextPoll: Date.now() + nextInterval * 1000,
              },
              reserved,
            ),
          );
        return devicePage(
          prior.value.userCode,
          prior.value.verificationUri,
          nextInterval,
        );
      }
      await store.transaction((tx) => tx.delete(oauthKey, reserved));
      return page(
        '<h1>Authorization was not approved</h1><p>No registration or sign-in was replayed.</p><a href="?flow=native">Choose another supported method</a>',
      );
    };
    const prior = await store.transaction((tx) => tx.get<Ticket>(oauthKey));
    if (prior?.value.deviceCode)
      return pollDevice(prior, prior.value.deviceCode);
    const selectNativeFlow = async () => {
      const requested = requestedFlow === "native" ? undefined : requestedFlow;
      if (requested === "device" && canDevice) {
        const started = await startDevice();
        if (started) return started;
      }
      if (requested === "oauth-code" && canCode) {
        const started = await startCode();
        if (started) return started;
      }
      if (canCode && canDevice && !requested)
        return page(
          `<h1>${escape(title)}</h1>
  <p>This provider supports more than one sign-in ceremony. Continue at the provider. This host will not ask for tokens, passwords, or client secrets.</p>
  <p><a href="?flow=oauth-code">Continue in the browser (OAuth)</a></p>
  <p><a href="?flow=device">Continue with a device code</a></p>`,
        );
      if (canDevice) {
        const started = await startDevice();
        if (started) return started;
      }
      if (canCode) {
        const started = await startCode();
        if (started) return started;
      }
    };
    const selectedResponse = await selectNativeFlow();
    if (selectedResponse) return selectedResponse;
    if (request.headers.get("accept") === "application/json")
      return Response.json(
        {
          operationId: pending.node.operationId,
          flows: {
            oauthCode: canCode,
            device: canDevice,
            dcr: Boolean(discovery.registrationEndpoint),
          },
        },
        { headers },
      );
    return page(
      `<h1>${escape(title)}</h1>
  ${native ? `<p>Complete sign-in at the provider in your own browser. Any passkey stays in your authenticator; the isolated session cannot use your device's private key.</p>` : ""}
  <p>This host looks up published OAuth and OIDC documents, registers a public client when the provider allows it, and sends you to the provider. It will not ask you for tokens, passwords, client secrets, or origins.</p>
  <p>${discovery.retryable ? "Discovery is temporarily unavailable. Retry after the provider recovers." : app?.clientId ? "A client exists, but no verifiable browser or device handoff is available from the discovered capabilities." : "No usable client registration was discovered. This provider needs an integration configured before a verified handoff can proceed."} Do not paste credentials here or in chat.</p><a href="?flow=native">Retry capability discovery</a>`,
    );
  };
  return nativeHandoff();
}
