import { createHash } from "node:crypto";
import { z } from "zod";
import { publicAuthFetch } from "./public-auth-fetch.js";
import { accountIdentifierSchema } from "../core/teaching-contracts.js";
import { manifestSchema, type ConnectorManifest } from "../core/schema.js";
import type { ConnectorDraft } from "../core/connector-authoring.js";
import type { RecipeDefinition } from "../core/recipe-contracts.js";
import type {
  OperationRegistry,
  OperationContext,
  OperationResult,
  VocabularyEntry,
} from "./recipes/registry.js";
import type { ActorContext } from "../core/operation-contracts.js";
import type { AsyncCeremonyStore } from "./persistence/index.js";
import { AuthorizationError } from "./identity.js";
import { originCandidatesFromProvider } from "../core/connector-authoring.js";
import {
  ensureAuthoredApp,
  humanRedirectUri,
  readAuthoredApp,
} from "./authored-app.js";
import {
  beginAuthorization,
  dpopJwkSchema,
  dpopUserinfoRequest,
  exchangeAuthorizationCode,
  requestedScopes,
} from "./authored-oauth.js";
import type {
  AuthorizationBrowser,
  IsolatedAccount,
} from "./browser-executor.js";
import type { ProgrammableInbox } from "./authored-inbox.js";
import {
  discoverProviderAuth,
  isProviderOwnedAuth,
  readAuthResponse,
} from "./provider-discovery.js";

const slot = (contract: string) => ({ contract, required: true });
const artifact = (kind: string) =>
  `authored-${kind}-${createHash("sha256").update(kind).digest("hex").slice(0, 16)}`;

export const authoredAccountRegistrationRecipe: RecipeDefinition = {
  schemaVersion: 1,
  id: "authored-account-registration",
  title: "Register or sign in to a provider account",
  description:
    "Check the requested account, register it when available, or use traditional sign-in when it exists.",
  inputs: {},
  invocations: [
    {
      id: "account",
      use: {
        kind: "operation",
        id: "authored.register-account",
        version: "1.0.0",
      },
      dependsOn: [],
      bindings: {},
    },
  ],
  outputs: { connection: { node: "account", name: "connection" } },
};

export const authoredVocabulary = new Map<string, VocabularyEntry>(
  ["app", "session", "connection"].map((kind) => [
    `authored.${kind}`,
    {
      schema: z.string().regex(/^authored-[a-z0-9-]{4,80}$/),
      classification: "artifact",
      provider: "authored",
      profile: "authored",
    },
  ]),
);

export function manifestFromProject(
  project: ConnectorDraft,
): ConnectorManifest {
  const id = project.manifest.id || "authored";
  return manifestSchema.parse({
    schemaVersion: 1,
    support: "fixture",
    id,
    name: project.manifest.name || id,
    description:
      project.manifest.description ||
      `Authored ${project.manifest.name || id} ceremony.`,
    methods: project.manifest.methods.map((method) => ({
      id: method.kind,
      label: method.label,
      kind: method.kind,
      templateId: method.templateId,
      fields:
        method.kind === "api-key"
          ? [
              {
                name: "token",
                label: "Secret",
                type: "password",
                required: true,
                classification: "secret",
              },
            ]
          : method.kind === "basic" ||
              method.kind === "form" ||
              method.kind === "account-registration"
            ? [
                {
                  name: "username",
                  label: "Username",
                  type: "text",
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
              ]
            : [],
      scopes: method.scopes,
      contract: method.contract,
    })),
  });
}

export function recipeFromProject(project: ConnectorDraft): RecipeDefinition {
  const secret = project.manifest.methods.every((method) =>
    ["api-key", "basic", "form", "account-registration"].includes(method.kind),
  );
  if (!secret)
    return {
      schemaVersion: 1,
      id: `${project.manifest.id || "authored"}-connect`,
      title: `Connect ${project.manifest.name || "provider"}`,
      description: "Prepare, authorize, and verify the authored ceremony.",
      inputs: {},
      invocations: [
        {
          id: "app",
          use: {
            kind: "operation",
            id: "authored.prepare-app",
            version: "1.0.0",
          },
          dependsOn: [],
          bindings: {},
        },
        {
          id: "user",
          use: {
            kind: "operation",
            id: "authored.authorize-user",
            version: "1.0.0",
          },
          dependsOn: ["app"],
          bindings: { app: { from: "output", node: "app", name: "app" } },
        },
        {
          id: "access",
          use: {
            kind: "operation",
            id: "authored.verify-access",
            version: "1.0.0",
          },
          dependsOn: ["user"],
          bindings: {
            session: { from: "output", node: "user", name: "session" },
          },
        },
      ],
      outputs: { connection: { node: "access", name: "connection" } },
    };
  if (secret)
    return {
      schemaVersion: 1,
      id: `${project.manifest.id || "authored"}-connect`,
      title: `Connect ${project.manifest.name || "provider"}`,
      description: "Collect a secret and verify the authored ceremony.",
      inputs: {},
      invocations: [
        {
          id: "secret",
          use: {
            kind: "operation",
            id: "authored.collect-credential",
            version: "1.0.0",
          },
          dependsOn: [],
          bindings: {},
        },
        {
          id: "access",
          use: {
            kind: "operation",
            id: "authored.verify-access",
            version: "1.0.0",
          },
          dependsOn: ["secret"],
          bindings: {
            session: { from: "output", node: "secret", name: "session" },
          },
        },
      ],
      outputs: { connection: { node: "access", name: "connection" } },
    };
  return {
    schemaVersion: 1,
    id: `${project.manifest.id || "authored"}-connect`,
    title: `Connect ${project.manifest.name || "provider"}`,
    description: "Verify the authored ceremony.",
    inputs: {},
    invocations: [
      {
        id: "access",
        use: {
          kind: "operation",
          id: "authored.verify-access",
          version: "1.0.0",
        },
        dependsOn: [],
        bindings: {},
      },
    ],
    outputs: { connection: { node: "access", name: "connection" } },
  };
}

const sessionSchema = z.object({
  handle: z.string().min(1).max(256),
  did: z.string().min(1).max(256).optional(),
  accessToken: z.string().min(1).max(8000),
  refreshToken: z.string().min(1).max(8000).optional(),
  dpopJwk: dpopJwkSchema.optional(),
  verifiedEmail: z.email().max(254).optional(),
});
export const discoveredAuthSchema = z.object({
  origin: z.string().max(200),
  documents: z.array(z.string().max(200)).max(16),
  methods: z.array(z.string()).max(12),
  grantTypes: z.array(z.string()).max(32).default([]),
  searchUsed: z.boolean(),
  authorizationEndpoint: z.string().url().optional(),
  tokenEndpoint: z.string().url().optional(),
  userinfoEndpoint: z.string().url().optional(),
  revocationEndpoint: z.string().url().optional(),
  deviceAuthorizationEndpoint: z.string().url().optional(),
  registrationEndpoint: z.string().url().optional(),
  clientId: z.string().min(1).max(2048).optional(),
  scopes: z.array(z.string().max(80)).max(16).optional(),
  issuer: z.string().url().optional(),
  pushedAuthorizationRequestEndpoint: z.string().url().optional(),
  requirePushedAuthorizationRequests: z.boolean().optional(),
  clientIdMetadataDocumentSupported: z.boolean().optional(),
  dpopRequired: z.boolean().optional(),
  dpopSigningAlgorithms: z.array(z.string().min(1).max(32)).max(32).optional(),
  openApiUrl: z.string().url().optional(),
  assumed: z.boolean().optional(),
  candidates: z.array(z.string().max(200)).max(8).optional(),
  codeChallengeMethods: z.array(z.string().max(32)).max(16).optional(),
  retryable: z.boolean().optional(),
});
function sessionKey(actor: ActorContext, runId: string) {
  return {
    tenant: actor.tenantId,
    kind: "artifact" as const,
    id: `authored-session:${createHash("sha256").update(runId).digest("hex").slice(0, 24)}`,
  };
}
export async function publicAuthoredIdentity(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  runId: string,
) {
  const record = await store.transaction((tx) =>
    tx.get(sessionKey(actor, runId)),
  );
  const parsed = sessionSchema.safeParse(record?.value);
  return parsed.success
    ? {
        handle: parsed.data.handle,
        did: parsed.data.did ?? parsed.data.handle,
      }
    : undefined;
}
export async function installedConnector(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  connectorId: string,
) {
  const record = await store.transaction((tx) =>
    tx.get({
      tenant: actor.tenantId,
      kind: "artifact",
      id: `installed-connector:${connectorId}`,
    }),
  );
  const parsed = z
    .object({
      author: z.string(),
      discovery: discoveredAuthSchema.optional(),
      manifest: z
        .object({
          name: z.string().optional(),
          methods: z.array(z.object({ kind: z.string() })).optional(),
        })
        .passthrough()
        .optional(),
    })
    .safeParse(record?.value);
  return parsed.success && parsed.data.author === actor.subjectId
    ? parsed.data
    : undefined;
}
export async function installedDiscovery(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  connectorId: string,
) {
  return (await installedConnector(store, actor, connectorId))?.discovery;
}
export async function saveInstalledDiscovery(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  connectorId: string,
  discovery: z.infer<typeof discoveredAuthSchema>,
) {
  const recordKey = {
    tenant: actor.tenantId,
    kind: "artifact" as const,
    id: `installed-connector:${connectorId}`,
  };
  await store.transaction(async (tx) => {
    const current = await tx.get(recordKey);
    if (!current) throw new AuthorizationError("denied");
    const parsed = z
      .object({
        author: z.string(),
        session: z.string(),
        manifest: z.unknown(),
        definition: z.unknown(),
        discovery: z.unknown().optional(),
      })
      .parse(current.value);
    if (parsed.author !== actor.subjectId)
      throw new AuthorizationError("denied");
    await tx.put(recordKey, { ...parsed, discovery }, current.revision);
  });
}

function identityFromUnknown(value: unknown) {
  const json = z.record(z.string(), z.unknown()).safeParse(value);
  if (!json.success) return undefined;
  const text = (key: string) => {
    const item = json.data[key];
    return typeof item === "string" && item.trim() ? item.trim() : undefined;
  };
  const handle =
    text("handle") ??
    text("preferred_username") ??
    text("username") ??
    text("login") ??
    text("name") ??
    text("email") ??
    text("sub") ??
    text("id");
  if (!handle) return undefined;
  return {
    handle,
    did: text("did") ?? text("sub") ?? text("id") ?? handle,
    ...(json.data.email_verified === true &&
    z.email().max(254).safeParse(text("email")).success
      ? { verifiedEmail: text("email")! }
      : {}),
  };
}
function identityFromJwt(token: string) {
  const parts = token.split(".");
  if (parts.length < 2 || parts.length > 3) return;
  try {
    return identityFromUnknown(
      JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")),
    );
  } catch {
    return;
  }
}
function identityFromAccess(
  accessToken: string,
  claims?: Record<string, unknown>,
) {
  return identityFromUnknown(claims) ?? identityFromJwt(accessToken);
}
async function tokenRequest(
  endpoint: string,
  body: URLSearchParams,
  fetcher: typeof fetch,
) {
  const response = await fetcher(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body,
  });
  if (!response.ok) return undefined;
  const json = z
    .record(z.string(), z.unknown())
    .safeParse(await response.json());
  if (!json.success) return undefined;
  const access =
    typeof json.data.access_token === "string"
      ? json.data.access_token
      : undefined;
  if (!access) return undefined;
  return {
    accessToken: access,
    refreshToken:
      typeof json.data.refresh_token === "string"
        ? json.data.refresh_token
        : undefined,
    claims: json.data,
  };
}
export async function pollDeviceToken(
  endpoint: string,
  input: { deviceCode: string; clientId: string },
  fetcher: typeof fetch,
) {
  const response = await fetcher(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: input.deviceCode,
      client_id: input.clientId,
    }),
  }).catch(() => undefined);
  if (!response || response.status === 429 || response.status >= 500) {
    const retry = response?.headers.get("retry-after");
    const seconds = retry
      ? /^\d+$/.test(retry)
        ? Number(retry)
        : (Date.parse(retry) - Date.now()) / 1000
      : 0;
    return {
      status: "pending" as const,
      slow: true,
      transient: true,
      retryAfter: Number.isFinite(seconds)
        ? Math.max(0, Math.ceil(seconds))
        : 0,
    };
  }
  const json = z
    .record(z.string(), z.unknown())
    .safeParse(await response.json().catch(() => null));
  if (!json.success) return { status: "denied" as const };
  if (
    response.ok &&
    typeof json.data.access_token === "string" &&
    json.data.access_token
  )
    return {
      status: "ready" as const,
      accessToken: json.data.access_token,
      refreshToken:
        typeof json.data.refresh_token === "string"
          ? json.data.refresh_token
          : undefined,
      claims: json.data,
    };
  const error = json.data.error;
  if (error === "authorization_pending" || error === "slow_down")
    return {
      status: "pending" as const,
      slow: error === "slow_down",
      transient: false,
      retryAfter: 0,
    };
  return { status: "denied" as const };
}
async function readUserinfo(
  endpoint: string | undefined,
  accessToken: string,
  fetcher: typeof fetch,
  dpopJwk?: JsonWebKey,
) {
  if (!endpoint) return undefined;
  const response = await readAuthResponse(
    dpopJwk
      ? () => dpopUserinfoRequest(endpoint, accessToken, dpopJwk, fetcher)
      : fetcher,
    endpoint,
    {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
    },
  );
  if (!response || response.status !== 200) return undefined;
  try {
    return identityFromUnknown(JSON.parse(response.body));
  } catch {
    return undefined;
  }
}
async function persistSession(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  runId: string,
  stored: z.infer<typeof sessionSchema>,
) {
  const intent = await readAuthoredAccountIntent(store, actor, runId);
  if (
    intent &&
    (intent.identifier.includes("@")
      ? stored.verifiedEmail !== intent.identifier
      : intent.identifier.toLowerCase() !== stored.handle.toLowerCase())
  )
    throw new AuthorizationError("denied");
  await store.transaction(async (tx) => {
    const run = await tx.get<{
      subjectId: string;
      sessionId: string;
      status: string;
    }>({ tenant: actor.tenantId, kind: "run", id: runId });
    if (
      !run ||
      run.value.subjectId !== actor.subjectId ||
      run.value.sessionId !== actor.sessionId ||
      run.value.status !== "active"
    )
      throw new AuthorizationError("denied");
    const prior = await tx.get(sessionKey(actor, runId));
    await tx.put(sessionKey(actor, runId), stored, prior?.revision ?? null);
  });
  return { handle: stored.handle, did: stored.did ?? stored.handle };
}
export async function saveAuthoredDeviceSession(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  runId: string,
  discovery: z.infer<typeof discoveredAuthSchema>,
  input: { deviceCode: string; clientId: string },
  fetcher: typeof fetch,
) {
  if (!discovery.tokenEndpoint) return { status: "denied" as const };
  const poll = await pollDeviceToken(discovery.tokenEndpoint, input, fetcher);
  if (poll.status !== "ready") return poll;
  const identity = await saveAuthoredGrantSession(
    store,
    actor,
    runId,
    discovery,
    {
      ...poll.claims,
      access_token: poll.accessToken,
      refresh_token: poll.refreshToken,
    },
    fetcher,
  );
  if (!identity) return { status: "denied" as const };
  return { status: "ready" as const, handle: identity.handle };
}
export async function saveAuthoredGrantSession(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  runId: string,
  discovery: z.infer<typeof discoveredAuthSchema>,
  token: {
    access_token: string;
    token_type?: string;
    refresh_token?: string | undefined;
    sub?: string;
  },
  fetcher: typeof fetch,
  dpopJwk?: JsonWebKey,
) {
  if (discovery.dpopRequired && token.token_type?.toLowerCase() !== "dpop")
    throw new AuthorizationError("denied");
  const proofKey =
    token.token_type?.toLowerCase() === "dpop"
      ? dpopJwkSchema.parse(dpopJwk)
      : undefined;
  const identity = discovery.userinfoEndpoint
    ? await readUserinfo(
        discovery.userinfoEndpoint,
        token.access_token,
        fetcher,
        proofKey,
      )
    : identityFromAccess(token.access_token, token);
  if (!identity) return undefined;
  return persistSession(store, actor, runId, {
    ...identity,
    accessToken: token.access_token,
    ...(proofKey ? { dpopJwk: proofKey } : {}),
    ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
  });
}
export async function saveAuthoredAuthorizationSession(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  runId: string,
  discovery: z.infer<typeof discoveredAuthSchema>,
  input: {
    code: string;
    redirectUri: string;
    verifier: string;
    clientId: string;
  },
  fetcher: typeof fetch,
) {
  if (!discovery.tokenEndpoint) return undefined;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.verifier,
  });
  const token = await tokenRequest(discovery.tokenEndpoint, body, fetcher);
  if (!token) return undefined;
  return saveAuthoredGrantSession(
    store,
    actor,
    runId,
    discovery,
    {
      ...token.claims,
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
    },
    fetcher,
  );
}
export async function deleteAuthoredSession(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  runId: string,
  fetcher: typeof fetch = publicAuthFetch,
  revocationEndpoint?: string,
) {
  const run = await store.transaction((tx) =>
    tx.get<{ subjectId: string; sessionId: string }>({
      tenant: actor.tenantId,
      kind: "run",
      id: runId,
    }),
  );
  if (
    !run ||
    run.value.subjectId !== actor.subjectId ||
    run.value.sessionId !== actor.sessionId
  )
    throw new AuthorizationError("denied");
  const key = sessionKey(actor, runId);
  const record = await store.transaction((tx) => tx.get(key));
  const session = sessionSchema.safeParse(record?.value);
  if (session.success && revocationEndpoint && session.data.refreshToken) {
    try {
      await fetcher(revocationEndpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: session.data.refreshToken }),
      });
    } catch {
      /* Local deletion still proceeds. */
    }
  }
  return store.transaction(async (tx) => {
    if (record) await tx.delete(key, record.revision);
    const pendingKey = pendingRegistrationKey(actor, runId);
    const pending = await tx.get(pendingKey);
    if (pending) await tx.delete(pendingKey, pending.revision);
    return Boolean(record || pending);
  });
}
async function liveSession(
  store: AsyncCeremonyStore,
  context: OperationContext,
  fetcher: typeof fetch,
  userinfoEndpoint?: string,
) {
  const record = await store.transaction((tx) =>
    tx.get(sessionKey(context.actor, context.runId)),
  );
  const session = sessionSchema.safeParse(record?.value);
  if (!session.success) return undefined;
  if (!userinfoEndpoint) return session.data;
  const live = await readUserinfo(
    userinfoEndpoint,
    session.data.accessToken,
    fetcher,
    session.data.dpopJwk,
  );
  if (
    !live ||
    live.handle !== session.data.handle ||
    (session.data.verifiedEmail &&
      live.verifiedEmail !== session.data.verifiedEmail)
  )
    return undefined;
  return session.data;
}

export function authoredOauthKey(actor: ActorContext, runId: string) {
  return {
    tenant: actor.tenantId,
    kind: "handoff" as const,
    id: `authored-oauth:${createHash("sha256").update(runId).digest("hex").slice(0, 24)}`,
  };
}

const isolatedAuthorizationSchema = z.object({
  isolated: z.literal(true),
  subject: z.string(),
  actorSession: z.string(),
  runId: z.string(),
  nodeId: z.string(),
  configurationVersion: z.string(),
  session: z.string().min(1),
  redirectUri: z.string().url(),
  expires: z.number().int(),
  location: z.string().url().max(16_384),
  state: z.string().min(1).max(1024),
  verifier: z.string().min(1).max(1024),
  dpopJwk: dpopJwkSchema.optional(),
  discovery: discoveredAuthSchema.extend({
    authorizationEndpoint: z.string().url(),
    tokenEndpoint: z.string().url(),
  }),
});

/** A paused browser must retain the authorization request that created it. */
async function isolatedAuthorizationAttempt(
  store: AsyncCeremonyStore,
  context: OperationContext,
  discovery: z.infer<typeof discoveredAuthSchema>,
  app: {
    clientId: string;
    scope?: string | undefined;
    dpopRequired?: boolean | undefined;
  },
  resume: boolean,
  fetcher: typeof fetch,
) {
  const key = authoredOauthKey(context.actor, context.runId);
  const redirectUri = humanRedirectUri(
    context.origin,
    context.target,
    context.runId,
  );
  if (resume) {
    const record = await store.transaction((tx) => tx.get(key));
    const parsed = isolatedAuthorizationSchema.safeParse(record?.value);
    if (
      !record ||
      !parsed.success ||
      parsed.data.subject !== context.actor.subjectId ||
      parsed.data.actorSession !== context.actor.sessionId ||
      parsed.data.runId !== context.runId ||
      parsed.data.nodeId !== context.nodeId ||
      parsed.data.configurationVersion !== context.configurationVersion ||
      parsed.data.session !== app.clientId ||
      parsed.data.redirectUri !== redirectUri ||
      parsed.data.expires <= Date.now()
    )
      throw new AuthorizationError("denied");
    return { ...parsed.data, recordRevision: record.revision };
  }
  const boundDiscovery = isolatedAuthorizationSchema.shape.discovery.parse({
    ...discovery,
    ...(app.dpopRequired ? { dpopRequired: true } : {}),
  });
  const started = await beginAuthorization({
    discovery: {
      ...boundDiscovery,
      origin: boundDiscovery.origin || boundDiscovery.issuer || "",
    },
    clientId: app.clientId,
    redirectUri,
    scope: app.scope || requestedScopes(boundDiscovery.scopes).join(" "),
    dpop: Boolean(boundDiscovery.dpopRequired || app.dpopRequired),
    fetch: fetcher,
  });
  const value = isolatedAuthorizationSchema.parse({
    ...started,
    isolated: true,
    subject: context.actor.subjectId,
    actorSession: context.actor.sessionId,
    runId: context.runId,
    nodeId: context.nodeId,
    configurationVersion: context.configurationVersion,
    session: app.clientId,
    redirectUri,
    expires: Date.now() + 600_000,
    discovery: boundDiscovery,
  });
  const recordRevision = await store.transaction(async (tx) => {
    const previous = await tx.get(key);
    return tx.put(key, value, previous?.revision ?? null);
  });
  return { ...value, recordRevision };
}

export function authoredCeremonyKey(actor: ActorContext, runId: string) {
  return {
    tenant: actor.tenantId,
    kind: "session" as const,
    id: `authored-ceremony:${runId}`,
  };
}

export async function readAuthoredCeremony(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  runId: string,
) {
  const record = await store.transaction((tx) =>
    tx.get<{ kind?: string }>(authoredCeremonyKey(actor, runId)),
  );
  return record?.value.kind;
}

export type AuthoredAccountIntent = {
  identifier: string;
  status: "existing" | "available" | "unchecked";
};

export function accountMatchesIntent(
  account: { username: string; email?: string | undefined } | undefined,
  intent: AuthoredAccountIntent,
) {
  return intent.identifier.includes("@")
    ? account?.email === intent.identifier ||
        account?.username === intent.identifier
    : account?.username.toLowerCase() === intent.identifier.toLowerCase();
}

async function accountForIntent(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  connectorId: string,
  intent?: AuthoredAccountIntent,
) {
  const account = await readAuthoredAccount(store, actor, connectorId);
  return !intent || accountMatchesIntent(account, intent) ? account : undefined;
}

export function authoredNativeKey(actor: ActorContext, runId: string) {
  return {
    tenant: actor.tenantId,
    kind: "handoff" as const,
    id: `authored-native:${runId}`,
  };
}

export function accountBrowserKey(actor: ActorContext, runId: string) {
  return {
    tenant: actor.tenantId,
    kind: "handoff" as const,
    id: `account-browser:${createHash("sha256")
      .update(JSON.stringify([actor.tenantId, actor.subjectId, runId]))
      .digest("hex")}`,
  };
}

export async function readAccountBrowser(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  runId: string,
) {
  return (
    await store.transaction((tx) =>
      tx.get<{ pending: boolean; verified: boolean }>(
        accountBrowserKey(actor, runId),
      ),
    )
  )?.value;
}

async function saveAccountBrowser(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  runId: string,
  value: { pending: boolean; verified: boolean },
) {
  await store.transaction(async (tx) => {
    const key = accountBrowserKey(actor, runId);
    const prior = await tx.get(key);
    await tx.put(key, value, prior?.revision ?? null);
  });
}

const pendingRegistrationSchema = z.strictObject({
  subjectId: z.string(),
  sessionId: z.string(),
  runId: z.string(),
  nodeId: z.string(),
  connectorId: z.string(),
  identifier: accountIdentifierSchema,
  account: z.strictObject({
    username: accountIdentifierSchema,
    password: z.string().min(1).max(1024),
    email: z.email().max(254).optional(),
  }),
});

function pendingRegistrationKey(actor: ActorContext, runId: string) {
  const key = accountBrowserKey(actor, runId);
  return { ...key, id: `registration:${key.id}` };
}

export async function stageAuthoredRegistration(
  store: AsyncCeremonyStore,
  context: OperationContext,
  connectorId: string,
  account: IsolatedAccount,
) {
  const intent = await readAuthoredAccountIntent(
    store,
    context.actor,
    context.runId,
  );
  const value = pendingRegistrationSchema.parse({
    subjectId: context.actor.subjectId,
    sessionId: context.actor.sessionId,
    runId: context.runId,
    nodeId: context.nodeId,
    connectorId,
    identifier: intent?.identifier ?? account.email ?? account.username,
    account,
  });
  await store.transaction(async (tx) => {
    const run = await tx.get<{
      subjectId: string;
      sessionId: string;
      status: string;
    }>({ tenant: context.actor.tenantId, kind: "run", id: context.runId });
    if (
      !run ||
      run.value.subjectId !== context.actor.subjectId ||
      run.value.sessionId !== context.actor.sessionId ||
      run.value.status !== "active"
    )
      throw new AuthorizationError("denied");
    const key = pendingRegistrationKey(context.actor, context.runId);
    const prior = await tx.get(key);
    await tx.put(key, value, prior?.revision ?? null);
  });
}

export async function readPendingRegistration(
  store: AsyncCeremonyStore,
  context: OperationContext,
  connectorId: string,
) {
  const record = await store.transaction((tx) =>
    tx.get(pendingRegistrationKey(context.actor, context.runId)),
  );
  const parsed = pendingRegistrationSchema.safeParse(record?.value);
  if (!record || !parsed.success) return undefined;
  const value = parsed.data;
  if (
    value.subjectId !== context.actor.subjectId ||
    value.sessionId !== context.actor.sessionId ||
    value.runId !== context.runId ||
    value.nodeId !== context.nodeId ||
    value.connectorId !== connectorId
  )
    return undefined;
  const intent = await readAuthoredAccountIntent(
    store,
    context.actor,
    context.runId,
  );
  if (intent && intent.identifier !== value.identifier) return undefined;
  return { ...value, revision: record.revision };
}

export async function recoverAuthoredRegistration(
  store: AsyncCeremonyStore,
  context: OperationContext,
  connectorId: string,
) {
  const pending = await readPendingRegistration(store, context, connectorId);
  if (!pending) throw new AuthorizationError("denied");
  await store.transaction(async (tx) => {
    const run = await tx.get<{
      subjectId: string;
      sessionId: string;
      status: string;
    }>({ tenant: context.actor.tenantId, kind: "run", id: context.runId });
    const journal = await tx.get(
      pendingRegistrationKey(context.actor, context.runId),
    );
    const node = await tx.get<{ state: string; verified: boolean }>({
      tenant: context.actor.tenantId,
      kind: "node",
      id: `${context.runId}:${context.nodeId}`,
    });
    if (
      !run ||
      run.value.subjectId !== context.actor.subjectId ||
      run.value.sessionId !== context.actor.sessionId ||
      run.value.status !== "active" ||
      journal?.revision !== pending.revision ||
      node?.value.state !== "awaiting-human" ||
      node.value.verified
    )
      throw new AuthorizationError("denied");
    const intentKey = authoredAccountIntentKey(context.actor, context.runId);
    const intent = await tx.get<AuthoredAccountIntent>(intentKey);
    if (intent && intent.value.identifier !== pending.identifier)
      throw new AuthorizationError("denied");
    await tx.put(
      intentKey,
      { identifier: pending.identifier, status: "existing" },
      intent?.revision ?? null,
    );
    const loginKey = authoredLoginKey(context.actor, context.runId);
    const login = await tx.get(loginKey);
    await tx.put(
      loginKey,
      { needed: true, ...pending.account },
      login?.revision ?? null,
    );
    const browserKey = accountBrowserKey(context.actor, context.runId);
    const browser = await tx.get(browserKey);
    await tx.put(
      browserKey,
      { pending: false, verified: false },
      browser?.revision ?? null,
    );
  });
}

async function discardRejectedRegistration(
  store: AsyncCeremonyStore,
  context: OperationContext,
  connectorId: string,
) {
  const pending = await readPendingRegistration(store, context, connectorId);
  if (pending)
    await store.transaction((tx) =>
      tx.delete(
        pendingRegistrationKey(context.actor, context.runId),
        pending.revision,
      ),
    );
}

export function authoredAccountIntentKey(actor: ActorContext, runId: string) {
  return {
    tenant: actor.tenantId,
    kind: "handoff" as const,
    id: `authored-account-intent:${createHash("sha256").update(runId).digest("hex").slice(0, 24)}`,
  };
}

export async function saveAuthoredAccountIntent(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  runId: string,
  intent: AuthoredAccountIntent,
) {
  const key = authoredAccountIntentKey(actor, runId);
  intent = {
    ...intent,
    identifier: accountIdentifierSchema.parse(intent.identifier),
  };
  await store.transaction(async (tx) => {
    const current = await tx.get(key);
    await tx.put(key, intent, current?.revision ?? null);
  });
}

export async function readAuthoredAccountIntent(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  runId: string,
) {
  const record = await store.transaction((tx) =>
    tx.get<AuthoredAccountIntent>(authoredAccountIntentKey(actor, runId)),
  );
  return record?.value;
}

function authoredBlockerKey(actor: ActorContext, runId: string) {
  return {
    tenant: actor.tenantId,
    kind: "handoff" as const,
    id: `authored-blocker:${createHash("sha256").update(runId).digest("hex").slice(0, 24)}`,
  };
}

export async function saveAuthoredBlocker(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  runId: string,
  reason: string,
) {
  const key = authoredBlockerKey(actor, runId);
  await store.transaction(async (tx) => {
    const current = await tx.get(key);
    await tx.put(key, { reason }, current?.revision ?? null);
  });
}

export async function readAuthoredBlocker(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  runId: string,
) {
  const record = await store.transaction((tx) =>
    tx.get<{ reason?: string }>(authoredBlockerKey(actor, runId)),
  );
  return record?.value.reason;
}

export function authoredLoginKey(actor: ActorContext, runId: string) {
  return {
    tenant: actor.tenantId,
    kind: "handoff" as const,
    id: `authored-login:${createHash("sha256").update(runId).digest("hex").slice(0, 24)}`,
  };
}

export async function authoredLoginStatus(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  runId: string,
) {
  const record = await store.transaction((tx) =>
    tx.get<{ needed?: boolean; password?: string }>(
      authoredLoginKey(actor, runId),
    ),
  );
  if (record?.value.password) return "ready" as const;
  if (record?.value.needed) return "needed" as const;
  return "none" as const;
}

export async function markAuthoredLoginNeeded(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  runId: string,
) {
  const key = authoredLoginKey(actor, runId);
  await store.transaction(async (tx) => {
    const current = await tx.get(key);
    await tx.put(key, { needed: true }, current?.revision ?? null);
  });
}

export async function saveAuthoredLogin(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  runId: string,
  credentials: { username?: string; password: string; email?: string },
) {
  const key = authoredLoginKey(actor, runId);
  await store.transaction(async (tx) => {
    const current = await tx.get(key);
    await tx.put(
      key,
      {
        needed: true,
        ...(credentials.username ? { username: credentials.username } : {}),
        password: credentials.password,
        ...(credentials.email ? { email: credentials.email } : {}),
      },
      current?.revision ?? null,
    );
  });
}

export async function consumeAuthoredLogin(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  runId: string,
): Promise<
  | { needed?: true; username?: string; password?: string; email?: string }
  | undefined
> {
  const key = authoredLoginKey(actor, runId);
  return store.transaction(async (tx) => {
    const current = await tx.get<{
      needed?: boolean;
      username?: string;
      password?: string;
      email?: string;
    }>(key);
    if (!current) return;
    if (current.value.password) {
      await tx.delete(key, current.revision);
      return {
        ...(current.value.username ? { username: current.value.username } : {}),
        password: current.value.password,
        ...(current.value.email ? { email: current.value.email } : {}),
      };
    }
    return { needed: true as const };
  });
}

export function authoredAccountKey(actor: ActorContext, connectorId: string) {
  return {
    tenant: actor.tenantId,
    kind: "handoff" as const,
    id: `authored-account:${createHash("sha256").update(`${actor.subjectId}:${connectorId}`).digest("hex").slice(0, 24)}`,
  };
}

export async function saveAuthoredAccount(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  connectorId: string,
  account: { username: string; password: string; email?: string },
  runId?: string,
) {
  const key = authoredAccountKey(actor, connectorId);
  await store.transaction(async (tx) => {
    const current = await tx.get(key);
    await tx.put(
      key,
      {
        username: account.username,
        password: account.password,
        ...(account.email ? { email: account.email } : {}),
      },
      current?.revision ?? null,
    );
    if (runId) {
      const pendingKey = pendingRegistrationKey(actor, runId);
      const pending = await tx.get(pendingKey);
      if (pending) await tx.delete(pendingKey, pending.revision);
    }
  });
}

export async function readAuthoredAccount(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  connectorId: string,
) {
  const record = await store.transaction((tx) =>
    tx.get<{ username?: string; password?: string; email?: string }>(
      authoredAccountKey(actor, connectorId),
    ),
  );
  if (!record?.value.password) return;
  return {
    username: record.value.username ?? "",
    password: record.value.password,
    ...(record.value.email ? { email: record.value.email } : {}),
  };
}

export async function authoredAccountStored(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  connectorId: string,
  intent?: AuthoredAccountIntent,
) {
  return Boolean(await accountForIntent(store, actor, connectorId, intent));
}

export function authoredCaptureKey(actor: ActorContext, runId: string) {
  return {
    tenant: actor.tenantId,
    kind: "session" as const,
    id: `authored-capture:${createHash("sha256").update(runId).digest("hex").slice(0, 24)}`,
  };
}

export async function saveAuthoredCapture(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  runId: string,
  path: string,
) {
  const key = authoredCaptureKey(actor, runId);
  await store.transaction(async (tx) => {
    const current = await tx.get(key);
    await tx.put(key, { path }, current?.revision ?? null);
  });
}

export async function readAuthoredCapture(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  runId: string,
) {
  const record = await store.transaction((tx) =>
    tx.get<{ path?: string }>(authoredCaptureKey(actor, runId)),
  );
  return record?.value.path;
}

export function authoredLogKey(actor: ActorContext, runId: string) {
  return {
    tenant: actor.tenantId,
    kind: "session" as const,
    id: `authored-log:${createHash("sha256").update(runId).digest("hex").slice(0, 24)}`,
  };
}

export type AuthoredLogLine = { at: number; text: string };

export async function appendAuthoredLog(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  runId: string,
  text: string,
) {
  const key = authoredLogKey(actor, runId);
  await store.transaction(async (tx) => {
    const current = await tx.get<{ events?: AuthoredLogLine[] }>(key);
    const events = [
      ...(current?.value.events ?? []),
      { at: Date.now(), text },
    ].slice(-120);
    await tx.put(key, { events }, current?.revision ?? null);
  });
}

export async function readAuthoredLog(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  runId: string,
) {
  const record = await store.transaction((tx) =>
    tx.get<{ events?: AuthoredLogLine[] }>(authoredLogKey(actor, runId)),
  );
  return record?.value.events ?? [];
}

export function registerAuthoredOperations(
  registry: OperationRegistry,
  options: {
    store: AsyncCeremonyStore;
    fetch?: typeof fetch;
    browser?: AuthorizationBrowser;
    inbox?: ProgrammableInbox;
  },
): void {
  const complete = (outputs: Record<string, string>): OperationResult => ({
    state: "complete",
    outputs,
  });
  const operations = [
    {
      id: "authored.register-account",
      effect: "authored.register-account",
      inputs: {},
      outputs: { connection: slot("authored.connection") },
      handler: async (context: OperationContext) => {
        if (
          await publicAuthoredIdentity(
            options.store,
            context.actor,
            context.runId,
          )
        )
          return complete({ connection: artifact("connection") });
        if (
          await options.store.transaction((tx) =>
            tx.get(authoredNativeKey(context.actor, context.runId)),
          )
        )
          return {
            state: "awaiting-human" as const,
            outputs: {},
            diagnosticCode: "awaiting-human" as const,
          };
        const discovery = await installedDiscovery(
          options.store,
          context.actor,
          context.provider ?? context.target,
        );
        const origin =
          discovery?.origin ||
          discovery?.issuer ||
          (context.provider === "github" ? "https://github.com" : undefined);
        const intent = await readAuthoredAccountIntent(
          options.store,
          context.actor,
          context.runId,
        );
        if (!options.browser || !origin || !intent) {
          await saveAuthoredBlocker(
            options.store,
            context.actor,
            context.runId,
            !intent ? "account" : "unavailable",
          );
          return {
            state: "awaiting-human" as const,
            outputs: {},
            diagnosticCode: "awaiting-human" as const,
          };
        }
        const registering = intent.status !== "existing";
        if (
          registering &&
          !options.inbox &&
          !z.email().safeParse(intent.identifier).success
        ) {
          await saveAuthoredBlocker(
            options.store,
            context.actor,
            context.runId,
            "inbox",
          );
          return {
            state: "awaiting-human" as const,
            outputs: {},
            diagnosticCode: "awaiting-human" as const,
          };
        }
        const suppliedLogin = await consumeAuthoredLogin(
          options.store,
          context.actor,
          context.runId,
        );
        const base = origin.replace(/\/$/, "");
        const browserState = await readAccountBrowser(
          options.store,
          context.actor,
          context.runId,
        );
        if (browserState?.verified)
          return complete({ connection: artifact("connection") });
        if (
          registering &&
          !browserState?.pending &&
          (await readPendingRegistration(
            options.store,
            context,
            context.provider ?? context.target,
          ))
        ) {
          await saveAuthoredBlocker(
            options.store,
            context.actor,
            context.runId,
            "session-expired",
          );
          return {
            state: "awaiting-human" as const,
            outputs: {},
            diagnosticCode: "awaiting-human" as const,
          };
        }
        const runAccountBrowser = async () => {
          const startUrls = registering
            ? [
                `${base}/signup`,
                `${base}/register`,
                `${base}/join`,
                `${base}/account/create`,
              ]
            : [`${base}/login`, `${base}/signin`, base];
          const result = await options.browser!.complete({
            accountOnly: true,
            sessionKey: accountBrowserKey(context.actor, context.runId).id,
            ...(browserState?.pending ? { resumeSession: true } : {}),
            startUrl: startUrls[0]!,
            startUrls,
            redirectUri: context.origin,
            allowedOrigins: [
              origin,
              discovery?.issuer,
              discovery?.authorizationEndpoint,
              context.origin,
            ].filter((value): value is string => Boolean(value)),
            preferredUsername: intent.identifier,
            ...(registering
              ? {
                  generateAccount: true,
                  ...(options.inbox ? { inbox: options.inbox } : {}),
                  timeoutMs: 180_000,
                }
              : {}),
            ...(suppliedLogin?.password
              ? {
                  credentials: {
                    username: suppliedLogin.username ?? intent.identifier,
                    password: suppliedLogin.password,
                    ...(suppliedLogin.email
                      ? { email: suppliedLogin.email }
                      : {}),
                  },
                }
              : {}),
            vault: {
              stage: (account) =>
                stageAuthoredRegistration(
                  options.store,
                  context,
                  context.provider ?? context.target,
                  account,
                ),
              get: () =>
                accountForIntent(
                  options.store,
                  context.actor,
                  context.provider ?? context.target,
                  intent,
                ),
              put: (account) =>
                saveAuthoredAccount(
                  options.store,
                  context.actor,
                  context.provider ?? context.target,
                  account,
                  context.runId,
                ),
            },
          });
          await saveAccountBrowser(
            options.store,
            context.actor,
            context.runId,
            {
              pending: Boolean(result.sessionPending),
              verified: result.status !== "blocked",
            },
          );
          if (result.capturePath)
            await saveAuthoredCapture(
              options.store,
              context.actor,
              context.runId,
              result.capturePath,
            );
          return result;
        };
        const result = await runAccountBrowser();
        const finishAccountBrowser = async () => {
          if (result.status === "blocked") {
            if (
              registering &&
              ["username-in-use", "email-in-use"].includes(result.reason)
            )
              await discardRejectedRegistration(
                options.store,
                context,
                context.provider ?? context.target,
              );
            const reason =
              !registering &&
              [
                "session",
                "no-form",
                "unreachable",
                "missing",
                "timeout",
                "rejected",
              ].includes(result.reason)
                ? "session"
                : result.reason;
            await saveAuthoredBlocker(
              options.store,
              context.actor,
              context.runId,
              reason,
            );
            if (reason === "session")
              await markAuthoredLoginNeeded(
                options.store,
                context.actor,
                context.runId,
              );
            return {
              state: "awaiting-human" as const,
              outputs: {},
              diagnosticCode: "awaiting-human" as const,
            };
          }
          if (suppliedLogin?.password)
            await saveAuthoredAccount(
              options.store,
              context.actor,
              context.provider ?? context.target,
              {
                username: suppliedLogin.username ?? intent.identifier,
                password: suppliedLogin.password,
                ...(suppliedLogin.email ? { email: suppliedLogin.email } : {}),
              },
              context.runId,
            );
          await saveAuthoredBlocker(
            options.store,
            context.actor,
            context.runId,
            "",
          );
          return complete({ connection: artifact("connection") });
        };
        return finishAccountBrowser();
      },
    },
    {
      id: "authored.prepare-app",
      effect: "authored.prepare-app",
      inputs: {},
      outputs: { app: slot("authored.app") },
      handler: async (context: OperationContext) => {
        const fetcher = options.fetch ?? publicAuthFetch;
        let discovery = await installedDiscovery(
          options.store,
          context.actor,
          context.target,
        );
        if (
          !discovery?.clientId &&
          !discovery?.registrationEndpoint &&
          !discovery?.clientIdMetadataDocumentSupported &&
          !(discovery && isProviderOwnedAuth(discovery))
        ) {
          const found = await discoverProviderAuth(
            [
              discovery?.origin ?? "",
              ...originCandidatesFromProvider(context.target),
            ].filter(Boolean),
            {
              fetch: fetcher,
              query: context.target,
            },
          );
          if (
            found.authorizationEndpoint ||
            found.deviceAuthorizationEndpoint ||
            found.registrationEndpoint ||
            found.clientIdMetadataDocumentSupported ||
            found.clientId
          ) {
            discovery = discoveredAuthSchema.parse(found);
            await saveInstalledDiscovery(
              options.store,
              context.actor,
              context.target,
              discovery,
            );
          }
        }
        const app = await ensureAuthoredApp(
          options.store,
          context,
          discovery,
          fetcher,
        );
        if (!app?.clientId)
          return {
            state: "awaiting-human" as const,
            outputs: {},
            diagnosticCode: "awaiting-human" as const,
          };
        return complete({ app: artifact("app") });
      },
    },
    {
      id: "authored.authorize-user",
      effect: "authored.authorize-user",
      inputs: { app: slot("authored.app") },
      outputs: { session: slot("authored.session") },
      handler: async (context: OperationContext) => {
        const session = await publicAuthoredIdentity(
          options.store,
          context.actor,
          context.runId,
        );
        if (session) return complete({ session: artifact("session") });
        if (
          await options.store.transaction((tx) =>
            tx.get(authoredNativeKey(context.actor, context.runId)),
          )
        )
          return {
            state: "awaiting-human" as const,
            outputs: {},
            diagnosticCode: "awaiting-human" as const,
          };
        const fetcher = options.fetch ?? publicAuthFetch;
        let discovery = await installedDiscovery(
          options.store,
          context.actor,
          context.target,
        );
        const app =
          (await readAuthoredApp(
            options.store,
            context.actor,
            context.runId,
          )) ??
          (await ensureAuthoredApp(options.store, context, discovery, fetcher));
        const selected =
          (await readAuthoredCeremony(
            options.store,
            context.actor,
            context.runId,
          )) ?? "oauth-code";
        if (
          selected === "device" ||
          !options.browser ||
          !app?.clientId ||
          !discovery?.authorizationEndpoint ||
          !discovery.tokenEndpoint
        )
          return {
            state: "awaiting-human" as const,
            outputs: {},
            diagnosticCode: "awaiting-human" as const,
          };
        const redirectUri = humanRedirectUri(
          context.origin,
          context.target,
          context.runId,
        );
        const browserState = await readAccountBrowser(
          options.store,
          context.actor,
          context.runId,
        );
        const resume = Boolean(browserState?.pending);
        const recovery = await readPendingRegistration(
          options.store,
          context,
          context.target,
        );
        const registrationInterrupted = async () =>
          Boolean(
            recovery &&
            !resume &&
            (
              await readAuthoredAccountIntent(
                options.store,
                context.actor,
                context.runId,
              )
            )?.status !== "existing",
          );
        if (await registrationInterrupted()) {
          await saveAuthoredBlocker(
            options.store,
            context.actor,
            context.runId,
            "session-expired",
          );
          return {
            state: "awaiting-human" as const,
            outputs: {},
            diagnosticCode: "awaiting-human" as const,
          };
        }
        try {
          const started = await isolatedAuthorizationAttempt(
            options.store,
            context,
            discovery,
            app,
            resume,
            fetcher,
          );
          discovery = started.discovery;
          const attemptDiscovery = discovery;
          const origin = discovery.origin || discovery.issuer || "";
          let logQueue = Promise.resolve();
          const log = (text: string) => {
            logQueue = logQueue
              .then(() =>
                appendAuthoredLog(
                  options.store,
                  context.actor,
                  context.runId,
                  text,
                ),
              )
              .catch(() => {});
          };
          log(`Running the ${selected} ceremony in the isolated browser`);
          const prepareAccountAttempt = async () => {
            const accountIntent = await readAuthoredAccountIntent(
              options.store,
              context.actor,
              context.runId,
            );
            const storedAccount = await accountForIntent(
              options.store,
              context.actor,
              context.target,
              accountIntent,
            );
            const selectedEmail = z
              .email()
              .safeParse(accountIntent?.identifier).success;
            const canRegister = selectedEmail || Boolean(options.inbox);
            const suppliedLogin = await consumeAuthoredLogin(
              options.store,
              context.actor,
              context.runId,
            );
            const registering =
              (selected === "account-registration" &&
                accountIntent?.status !== "existing") ||
              (selected === "oauth-code" &&
                !storedAccount &&
                accountIntent?.status !== "existing");
            if (registering && !canRegister) {
              log(
                selected === "account-registration"
                  ? "Account registration needs a fresh email address the agent can receive mail at; no programmable inbox is configured on this host"
                  : "No stored account and no agent inbox to register one with; the provider will require an existing session",
              );
              if (selected === "account-registration") {
                await saveAuthoredBlocker(
                  options.store,
                  context.actor,
                  context.runId,
                  "inbox",
                );
                return;
              }
            }
            if (
              registering &&
              canRegister &&
              selected !== "account-registration"
            )
              log(
                selectedEmail
                  ? "No stored account; registering with the selected email and human verification"
                  : "No stored account; registering one with the agent inbox first",
              );
            const signupCandidates = origin
              ? [
                  `${origin}/signup`,
                  `${origin}/register`,
                  `${origin}/join`,
                  `${origin}/account/create`,
                  `${origin}/auth/signup`,
                ]
              : [];
            let signupUrls: string[] = [];
            if (
              !resume &&
              registering &&
              canRegister &&
              signupCandidates.length
            ) {
              const probed = await Promise.all(
                signupCandidates.map(async (url) => {
                  try {
                    const check = await fetcher(url, {
                      method: "GET",
                      redirect: "manual",
                      signal: AbortSignal.timeout(6_000),
                    });
                    return check.status < 400 ? url : undefined;
                  } catch {
                    return undefined;
                  }
                }),
              );
              signupUrls = probed.filter((url): url is string => Boolean(url));
              if (!signupUrls.length)
                log(
                  `No registration page answered at ${origin}; continuing to provider sign-in`,
                );
            }
            const generateAccount =
              registering && canRegister && Boolean(signupUrls.length);
            return {
              accountIntent,
              suppliedLogin,
              registering,
              signupUrls,
              generateAccount,
            };
          };
          const prepared = await prepareAccountAttempt();
          if (!prepared)
            return {
              state: "awaiting-human" as const,
              outputs: {},
              diagnosticCode: "awaiting-human" as const,
            };
          const {
            accountIntent,
            suppliedLogin,
            registering,
            signupUrls,
            generateAccount,
          } = prepared;
          const runAuthorizationBrowser = async () => {
            const result = await options.browser!.complete({
              sessionKey: accountBrowserKey(context.actor, context.runId).id,
              ...(resume ? { resumeSession: true } : {}),
              startUrl: signupUrls[0] ?? started.location,
              ...(accountIntent?.identifier
                ? { preferredUsername: accountIntent.identifier }
                : {}),
              ...(suppliedLogin?.password
                ? {
                    credentials: {
                      ...((suppliedLogin.username ?? accountIntent?.identifier)
                        ? {
                            username:
                              suppliedLogin.username ??
                              accountIntent!.identifier,
                          }
                        : {}),
                      password: suppliedLogin.password,
                      ...(suppliedLogin.email
                        ? { email: suppliedLogin.email }
                        : {}),
                    },
                  }
                : {}),
              ...(generateAccount
                ? {
                    startUrls: [...signupUrls, started.location],
                    generateAccount: true,
                    timeoutMs: 180_000,
                    ...(options.inbox ? { inbox: options.inbox } : {}),
                  }
                : {}),
              redirectUri,
              allowedOrigins: [
                attemptDiscovery.origin,
                attemptDiscovery.issuer ?? "",
                attemptDiscovery.authorizationEndpoint ?? "",
                context.origin,
              ].filter(Boolean),
              onEvent: log,
              vault: {
                stage: (account) =>
                  stageAuthoredRegistration(
                    options.store,
                    context,
                    context.target,
                    account,
                  ),
                get: () =>
                  accountForIntent(
                    options.store,
                    context.actor,
                    context.target,
                    accountIntent,
                  ),
                put: (account) =>
                  saveAuthoredAccount(
                    options.store,
                    context.actor,
                    context.target,
                    account,
                    context.runId,
                  ),
              },
            });
            await saveAccountBrowser(
              options.store,
              context.actor,
              context.runId,
              {
                pending: Boolean(result.sessionPending),
                verified: browserState?.verified ?? false,
              },
            );
            if (result.capturePath)
              await saveAuthoredCapture(
                options.store,
                context.actor,
                context.runId,
                result.capturePath,
              );
            return result;
          };
          const result = await runAuthorizationBrowser();
          const finishAuthorizationBrowser = async () => {
            if (result.status === "blocked") {
              if (
                registering &&
                ["username-in-use", "email-in-use"].includes(result.reason)
              )
                await discardRejectedRegistration(
                  options.store,
                  context,
                  context.target,
                );
              await saveAuthoredBlocker(
                options.store,
                context.actor,
                context.runId,
                result.reason,
              );
              if (result.reason === "session")
                await markAuthoredLoginNeeded(
                  options.store,
                  context.actor,
                  context.runId,
                );
              const reasons: Record<string, string> = {
                missing: "the provider page was not found",
                unreachable: "the provider page could not be loaded",
                "no-form": "no sign-in or registration form appeared",
                verification:
                  "the provider requires a verification code the isolated browser cannot receive",
                "email-in-use":
                  "the provider rejected the generated address as already in use",
                challenge: "the provider requires a human challenge (CAPTCHA)",
                rejected: "the provider rejected the submitted form",
                inbox: "the agent inbox could not provision a fresh address",
                session: "an existing provider session is required",
                origin: "the provider sent the browser to an unexpected origin",
                timeout: "the provider did not finish in time",
              };
              log(
                `Isolated browser stopped: ${reasons[result.reason] ?? result.reason}`,
              );
            }
            if (result.status === "callback") {
              if (started.expires <= Date.now())
                throw new AuthorizationError("denied");
              // Consume before the single-use exchange; a lost response is not replayable.
              await options.store.transaction((tx) =>
                tx.delete(
                  authoredOauthKey(context.actor, context.runId),
                  started.recordRevision,
                ),
              );
              await saveAuthoredBlocker(
                options.store,
                context.actor,
                context.runId,
                "",
              );
              const grant = await exchangeAuthorizationCode({
                discovery: {
                  ...started.discovery,
                  origin:
                    started.discovery.origin || started.discovery.issuer || "",
                },
                clientId: app.clientId,
                redirectUri,
                callbackUrl: result.url,
                verifier: started.verifier,
                state: started.state,
                ...(started.dpopJwk ? { dpopJwk: started.dpopJwk } : {}),
                fetch: fetcher,
              });
              const created = await saveAuthoredGrantSession(
                options.store,
                context.actor,
                context.runId,
                attemptDiscovery,
                grant,
                fetcher,
                started.dpopJwk,
              );
              if (created) return complete({ session: artifact("session") });
            }
          };
          const completed = await finishAuthorizationBrowser();
          if (completed) return completed;
          /* Isolated browser keeps provider login. Never collect passwords here. */
        } catch {
          if (resume) {
            await options.browser
              .close?.(accountBrowserKey(context.actor, context.runId).id)
              .catch(() => {});
            await saveAccountBrowser(
              options.store,
              context.actor,
              context.runId,
              {
                pending: false,
                verified: browserState?.verified ?? false,
              },
            );
            await saveAuthoredBlocker(
              options.store,
              context.actor,
              context.runId,
              "session-expired",
            );
          }
          /* Isolated browser failure falls through to a human fallback. */
        }
        return {
          state: "awaiting-human" as const,
          outputs: {},
          diagnosticCode: "awaiting-human" as const,
        };
      },
    },
    {
      id: "authored.collect-credential",
      effect: "authored.collect-credential",
      inputs: {},
      outputs: { session: slot("authored.session") },
      handler: async () => ({
        state: "awaiting-human" as const,
        outputs: {},
        diagnosticCode: "awaiting-human" as const,
      }),
    },
    {
      id: "authored.verify-access",
      effect: "authored.verify-access",
      inputs: { session: slot("authored.session") },
      outputs: { connection: slot("authored.connection") },
      handler: async (context: OperationContext) => {
        const discovery = await installedDiscovery(
          options.store,
          context.actor,
          context.target,
        );
        const session = await liveSession(
          options.store,
          context,
          options.fetch ?? publicAuthFetch,
          discovery?.userinfoEndpoint,
        );
        if (!session)
          return {
            state: "awaiting-human" as const,
            outputs: {},
            diagnosticCode: "awaiting-human" as const,
          };
        return complete({ connection: artifact("connection") });
      },
    },
  ];
  for (const operation of operations)
    registry.register({
      contract: {
        id: operation.id,
        version: "1.0.0",
        provider: "authored",
        profile: "authored",
        inputs: operation.inputs,
        outputs: operation.outputs,
        effects: [operation.effect],
        verifier: "authored.verify-access",
        humanFallback: "authored.own-browser",
      },
      inputSchema: z
        .object(
          Object.fromEntries(
            Object.keys(operation.inputs).map((name) => [name, z.string()]),
          ),
        )
        .strict(),
      outputSchema: z
        .object(
          Object.fromEntries(
            Object.keys(operation.outputs).map((name) => [name, z.string()]),
          ),
        )
        .strict(),
      classifications: {},
      fixtures: ["tests/authoring-tools.test.ts"],
      handler: operation.handler,
      verify: async (context, result) => {
        if (result.state !== "complete") return false;
        if (operation.id === "authored.register-account")
          return Boolean(
            (await publicAuthoredIdentity(
              options.store,
              context.actor,
              context.runId,
            )) ||
            (
              await readAccountBrowser(
                options.store,
                context.actor,
                context.runId,
              )
            )?.verified,
          );
        if (operation.id === "authored.prepare-app")
          return Boolean(
            (await readAuthoredApp(options.store, context.actor, context.runId))
              ?.clientId,
          );
        return Boolean(
          await publicAuthoredIdentity(
            options.store,
            context.actor,
            context.runId,
          ),
        );
      },
    });
}
