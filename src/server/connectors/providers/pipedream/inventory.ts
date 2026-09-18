import { z } from "zod";
import {
  canonicalDigest,
  completeDimensions,
  encodePathSegment,
  type CompatibilityIssue,
  type NativeCapability,
  type NormalizedDefinition,
} from "../../../../core/connectors/index.js";
import type {
  DiscoverInput,
  DiscoverResult,
  DiscoveredItem,
  ImportInput,
  ImportOutcome,
} from "../../adapter.js";
import { ConnectorError } from "../../errors.js";
import { expectJson } from "./client.js";
import { accountView, type AccountView } from "./connect.js";
import type { PipedreamCall } from "./context.js";
import { checkJsonBounds } from "./guards.js";
import { pipedreamAppSlugSchema, sha256Hex } from "./identity.js";
import {
  accountListSchema,
  appListSchema,
  appSchema,
  componentDocumentSchema,
  componentSchema,
  PIPEDREAM_SOURCE_PROFILE,
  type PipedreamApp,
  type PipedreamComponent,
} from "./wire.js";

/*
 * Inventory (PD-01). Apps are the broker's catalogue; connected accounts are
 * what this host's owner actually has in this project and environment. The
 * two are reported together but never merged: the app slug is the configured
 * identity, the display name is decoration, and an account belongs to the
 * host-derived external user or it is not listed at all. Importing a
 * component description produces inert capability descriptors; no component
 * source is fetched, parsed or evaluated.
 */

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const discoverInputSchema = z.strictObject({
  query: z.string().max(200).optional(),
  cursor: z
    .string()
    .max(512)
    .regex(/^[A-Za-z0-9_=-]*$/)
    .optional(),
  limit: z.number().int().min(1).max(100).optional(),
  scope: z.record(z.string().max(64), z.string().max(250)).optional(),
  refresh: z.boolean().optional(),
});

function appAuthentication(app: PipedreamApp): string {
  switch (app.auth_type) {
    case "oauth":
      return "oauth";
    case "keys":
      return "keys";
    case "none":
      return "none";
    default:
      return "unknown";
  }
}

function appItem(
  call: PipedreamCall,
  app: PipedreamApp,
  accounts: AccountView[],
): DiscoveredItem {
  const slug = pipedreamAppSlugSchema.safeParse(app.name_slug);
  const mine = accounts.filter((account) => account.app === app.name_slug);
  return {
    identity: {
      ecosystem: "pipedream",
      authorityNamespace: call.authority,
      // The slug is the configured identity of the app; the display name is not.
      nativeId: slug.success ? slug.data : app.name_slug,
      nativeVersion: PIPEDREAM_SOURCE_PROFILE,
    },
    displayName: app.name.slice(0, 200),
    description: (app.description ?? "").slice(0, 500),
    provenance: {
      app: app.name_slug,
      environment: call.config.environment,
      project: call.config.projectId,
      authType: appAuthentication(app),
      proxyEnabled: app.connect?.proxy_enabled === true ? "true" : "false",
      allowedDomains: (app.connect?.allowed_domains ?? [])
        .slice(0, 8)
        .join(",")
        .slice(0, 500),
      connectedAccounts: String(mine.length),
      healthyAccounts: String(
        mine.filter((account) => account.healthy && !account.dead).length,
      ),
      // Ownership is the host's derived external user, never a broker-supplied identity.
      ownerScope: sha256Hex(call.externalUserId).slice(0, 16),
      bound: call.settings.app === app.name_slug ? "binding-app" : "catalogue",
    },
    status: "active",
  };
}

/** Accounts this host owner holds in this project and environment, optionally for one app. */
export async function listOwnAccounts(
  call: PipedreamCall,
  app?: string,
): Promise<AccountView[]> {
  const response = await call.client.send({
    method: "GET",
    path: call.client.projectPath("/accounts"),
    query: {
      external_user_id: call.externalUserId,
      ...(app ? { app } : {}),
    },
    timeoutMs: call.options.timeouts.read,
    consequential: false,
  });
  const data = expectJson(response, accountListSchema);
  return data.data
    .map(accountView)
    .filter((account) => account.externalId === call.externalUserId);
}

export async function pipedreamDiscover(
  call: PipedreamCall,
  input: DiscoverInput,
): Promise<DiscoverResult> {
  const parsed = discoverInputSchema.safeParse(input ?? {});
  if (!parsed.success)
    throw new ConnectorError("invalid-request", {
      detail: "pipedream.discover.invalid",
    });
  const requested = parsed.data.scope?.app;
  if (requested !== undefined && !pipedreamAppSlugSchema.safeParse(requested).success)
    throw new ConnectorError("invalid-request", {
      detail: "pipedream.discover.app",
    });
  const issues: CompatibilityIssue[] = [];
  const query: Record<string, string> = {};
  if (parsed.data.query) query.q = parsed.data.query;
  if (parsed.data.cursor) query.after = parsed.data.cursor;
  if (parsed.data.limit) query.limit = String(parsed.data.limit);

  let apps: PipedreamApp[];
  let nextCursor: string | undefined;
  if (requested) {
    // The single-app read is not project-scoped and takes the slug or id.
    const response = await call.client.send({
      method: "GET",
      path: `/v1/connect/apps/${encodePathSegment(requested)}`,
      environment: false,
      timeoutMs: call.options.timeouts.read,
      consequential: false,
    });
    if (response.status === 404) apps = [];
    else {
      const wrapped = z
        .looseObject({ data: appSchema })
        .safeParse(response.json);
      const bare = wrapped.success ? undefined : appSchema.safeParse(response.json);
      if (!wrapped.success && !bare?.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "pipedream.response.malformed",
        });
      apps = [wrapped.success ? wrapped.data.data : bare!.data!];
    }
  } else {
    const response = await call.client.send({
      method: "GET",
      path: "/v1/connect/apps",
      query,
      environment: false,
      timeoutMs: call.options.timeouts.read,
      consequential: false,
    });
    const data = expectJson(response, appListSchema);
    apps = data.data;
    const cursor = data.page_info?.end_cursor;
    if (typeof cursor === "string" && cursor && apps.length)
      nextCursor = cursor;
  }

  let accounts: AccountView[] = [];
  try {
    accounts = await listOwnAccounts(call, requested);
  } catch (error) {
    // The catalogue is still useful when the account listing is refused; the
    // report says so rather than implying the owner has no accounts.
    issues.push({
      code: "pipedream.accounts.unavailable",
      category: "network",
      sourcePointer: "/accounts",
      dimension: "discover",
      disposition: "requires-configuration",
      severity: "warning",
      executionImpact: "none",
      message:
        "Connected accounts could not be listed for this owner; app metadata is shown without connection state.",
      remediation:
        error instanceof ConnectorError && error.code === "rate-limited"
          ? "The broker is rate limiting this project. Retry later."
          : "Check the project credentials and environment configuration.",
    });
  }

  return {
    items: apps.map((app) => appItem(call, app, accounts)),
    ...(nextCursor ? { nextCursor } : {}),
    freshness: {
      fetchedAt: call.ctx.environment.now(),
      stale: false,
      source: "live",
    },
    issues,
  };
}

function capabilityFor(component: PipedreamComponent): NativeCapability {
  const annotations = component.annotations ?? {};
  const effect: NativeCapability["effect"] =
    annotations.readOnlyHint === true
      ? "read"
      : annotations.destructiveHint === true
        ? "write"
        : "unknown";
  const props = (component.configurable_props ?? [])
    .slice(0, 64)
    .map((prop) => ({
      name: String(prop.name).slice(0, 120),
      type: String(prop.type).slice(0, 64),
      ...(prop.app ? { app: String(prop.app).slice(0, 120) } : {}),
      optional: prop.optional === true,
      remoteOptions: prop.remoteOptions === true,
      reloadProps: prop.reloadProps === true,
      secret: prop.secret === true,
    }));
  return {
    kind: component.component_type === "trigger" ? "event" : "action",
    nativeId: component.key,
    label: component.name.slice(0, 200),
    ...(component.description
      ? { summary: component.description.slice(0, 500) }
      : {}),
    // Declared by the source, not decided here: an annotation is a hint.
    effect,
    dataClassification: "unknown",
    cost: "unknown",
    nativeExtensions: {
      "pipedream.version": component.version,
      "pipedream.componentType": component.component_type ?? "unknown",
      "pipedream.configurableProps": props,
      ...(component.stash ? { "pipedream.stash": component.stash } : {}),
      ...(component.annotations
        ? { "pipedream.annotations": component.annotations }
        : {}),
    },
  };
}

function componentIssues(
  component: PipedreamComponent,
  index: number,
): CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = [];
  const pointer = `/data/${index}`;
  if (component.stash === "required")
    issues.push({
      code: "pipedream.component.stash-required",
      category: "structure",
      sourcePointer: pointer,
      dimension: "invoke",
      disposition: "unsupported",
      severity: "warning",
      executionImpact: "blocks-operation",
      message:
        "This component requires Pipedream's File Stash, which this adapter does not bind.",
      remediation: "Bind a component that does not require file stashing.",
    });
  if ((component.configurable_props ?? []).some((prop) => prop.reloadProps === true))
    issues.push({
      code: "pipedream.component.dynamic-props",
      category: "schema",
      sourcePointer: pointer,
      dimension: "invoke",
      disposition: "requires-configuration",
      severity: "warning",
      executionImpact: "none",
      message:
        "Some properties reload the component's schema; the reviewed binding must fix their values.",
      remediation:
        "Configure the dependent properties in the binding rather than accepting them from callers.",
    });
  return issues;
}

function componentsOf(document: unknown): PipedreamComponent[] {
  const parsed = componentDocumentSchema.safeParse(document);
  if (!parsed.success)
    throw new ConnectorError("invalid-request", {
      detail: "pipedream.import.unrecognized",
    });
  const value: unknown = parsed.data;
  if (value && typeof value === "object" && "data" in value) {
    const data = (value as { data: unknown }).data;
    const many = z.array(componentSchema).safeParse(data);
    if (many.success) return many.data;
    return [componentSchema.parse(data)];
  }
  return [componentSchema.parse(value)];
}

/**
 * Imports a Pipedream component description as inert capability descriptors.
 * The bytes are bounded and parsed as data; component source is never
 * fetched, and nothing in the document can register an operation, name a
 * destination or grant authority. Binding those capabilities is a separate,
 * reviewed decision.
 */
export async function pipedreamImport(
  call: PipedreamCall,
  input: ImportInput,
): Promise<ImportOutcome> {
  if (input.bytes.byteLength > MAX_IMPORT_BYTES)
    throw new ConnectorError("invalid-request", {
      detail: "pipedream.import.too-large",
    });
  if (!/json/i.test(input.mediaType))
    throw new ConnectorError("unsupported", {
      detail: "pipedream.import.media-type",
    });
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder().decode(input.bytes));
  } catch {
    throw new ConnectorError("invalid-request", {
      detail: "pipedream.import.malformed",
    });
  }
  checkJsonBounds(document, "pipedream.import.bounds");
  const components = componentsOf(document);
  if (components.length > 512)
    throw new ConnectorError("invalid-request", {
      detail: "pipedream.import.too-many",
    });
  const app =
    typeof input.identityHint?.nativeId === "string" &&
    pipedreamAppSlugSchema.safeParse(input.identityHint.nativeId).success
      ? input.identityHint.nativeId
      : call.settings.app;
  const digest = sha256Hex(new TextDecoder().decode(input.bytes));
  const sourceRef = `pipedream:source:${digest.slice(0, 32)}`;
  const capabilities = components.map(capabilityFor);
  const issues = components.flatMap(componentIssues);
  const identity = {
    ecosystem: "pipedream" as const,
    authorityNamespace: call.authority,
    nativeId: app,
    nativeVersion: PIPEDREAM_SOURCE_PROFILE,
  };
  const body = {
    schemaVersion: 1 as const,
    identity,
    importer: { id: "pipedream-connect-components", version: call.adapterVersion },
    display: {
      name: `Pipedream Connect: ${app}`,
      description:
        "Pipedream Connect component descriptions imported as inert capabilities.",
      ecosystem: "pipedream",
      service: app.replace(/_/g, "-"),
    },
    authentication: [
      {
        id: "pipedream-connect",
        label: "Pipedream Connect managed auth",
        kind: "external-broker" as const,
        broker: "pipedream",
        custody: "external-execution-broker" as const,
      },
    ],
    configuration: [
      {
        name: "PIPEDREAM_PROJECT_ID",
        source: "session-environment" as const,
        classification: "public" as const,
        required: true,
      },
      {
        name: "PIPEDREAM_ENVIRONMENT",
        source: "session-environment" as const,
        classification: "public" as const,
        required: true,
      },
      {
        name: "PIPEDREAM_CLIENT_ID",
        source: "session-environment" as const,
        classification: "public" as const,
        required: true,
      },
      {
        name: "PIPEDREAM_CLIENT_SECRET",
        source: "session-environment" as const,
        classification: "secret" as const,
        required: true,
      },
    ],
    capabilities,
    events: components
      .filter((component) => component.component_type === "trigger")
      .slice(0, 512)
      .map((component) => ({
        nativeId: component.key,
        label: component.name.slice(0, 200),
        transport: "http-webhook" as const,
        verification: "vendor" as const,
      })),
    declaredServers: [],
    compatibility: {
      issues,
      dimensions: completeDimensions({
        discover: "exact",
        import: "adapted",
        configure: "exact",
        authorize: "requires-configuration",
        verify: "requires-configuration",
        invoke: "requires-configuration",
        events: "requires-configuration",
        reconnect: "requires-configuration",
        disconnect: "exact",
        revoke: "unsupported",
        delegate: "unsupported",
      }),
    },
    nativeExtensions: {},
  };
  const definition: NormalizedDefinition = {
    ...body,
    definitionRef: `pipedream:definition:${digest.slice(0, 32)}`,
    sourceRef,
    normalizedDigest: await canonicalDigest(body),
  };
  return {
    source: {
      sourceRef,
      identity,
      format: { name: "pipedream-component", version: PIPEDREAM_SOURCE_PROFILE },
      origin: input.origin,
      digest: { algorithm: "sha256", value: digest },
      byteLength: input.bytes.byteLength,
      mediaType: "application/json",
      capturedAt: new Date(call.ctx.environment.now()).toISOString(),
      adaptation: [],
      overlays: [],
    },
    definitions: [definition],
    issues,
    // Candidates a reviewer may bind; importing registers nothing executable.
    executableCandidates: capabilities.map((capability) => capability.nativeId),
  };
}
