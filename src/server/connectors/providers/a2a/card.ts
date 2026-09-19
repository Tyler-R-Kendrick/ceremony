import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canonicalDigest,
  normalizedDefinitionSchema,
  sourceRecordSchema,
  completeDimensions,
  type AuthenticationProfile,
  type CompatibilityIssue,
  type NativeCapability,
  type NormalizedDefinition,
  type SourceRecord,
} from "../../../../core/connectors/index.js";
import type {
  AdapterCallContext,
  ImportInput,
  ImportOutcome,
} from "../../adapter.js";
import { ConnectorError } from "../../errors.js";
import { classifyAddress } from "../../import/network.js";
import { makeIssue } from "../../import/common.js";
import {
  A2A_LIMITS,
  A2A_PROFILE_0_3,
  A2A_PROTOCOL_VERSIONS,
  A2A_SUPPORTED_BINDING,
  detectCardProfile,
  readAgentCard,
  type A2aAgentSkill,
  type A2aCardView,
  type A2aProfile,
} from "./schemas.js";

/*
 * AG-01: bounded Agent Card import.
 *
 * An Agent Card is a manifest the agent publishes about itself. Every field
 * of it is preserved here as a description and none of it becomes authority:
 * the endpoints it names are `declared`, the security schemes it lists are
 * candidate profiles, the skills it advertises are candidates a reviewer may
 * bind, and the URLs it points at — icon, documentation, provider site — are
 * stored as data. Nothing in this module fetches a URL the card supplied; the
 * importer receives bytes, never a location to go and get them.
 *
 * A card that names a private-network or metadata address is imported, with
 * the address kept verbatim for review and a network diagnostic attached. It
 * is refused a destination, not deleted: hiding it would make the review
 * worse, and keeping it executable would make the deployment worse.
 */

export const A2A_IMPORTER_ID = "a2a-agent-card";
export const A2A_IMPORTER_VERSION = "1.0.0";

const issue = (input: {
  code: string;
  category: CompatibilityIssue["category"];
  pointer: string;
  dimension: CompatibilityIssue["dimension"];
  disposition: CompatibilityIssue["disposition"];
  severity: CompatibilityIssue["severity"];
  impact: CompatibilityIssue["executionImpact"];
  message: string;
  remediation?: string;
}): CompatibilityIssue =>
  makeIssue({
    code: input.code,
    category: input.category,
    sourcePointer: input.pointer,
    dimension: input.dimension,
    disposition: input.disposition,
    severity: input.severity,
    executionImpact: input.impact,
    message: input.message,
    ...(input.remediation ? { remediation: input.remediation } : {}),
  });

export type UrlExposure =
  | { kind: "ok"; origin: string }
  | { kind: "not-a-url" }
  | { kind: "insecure-scheme"; scheme: string }
  | { kind: "credentialed" }
  | { kind: "private-network"; classification: string };

const localHostNames = new Set(["localhost", "localhost.localdomain"]);
const localSuffixes = [".local", ".internal", ".localdomain", ".home.arpa"];

/**
 * Classifies a URL a card declared, without contacting anything. Only a
 * literal address can be classified offline; a name that resolves into
 * private space is caught later by the approved fetcher, which is why a
 * declared endpoint never becomes a destination without a reviewed binding.
 */
export function classifyDeclaredUrl(value: string): UrlExposure {
  if (!URL.canParse(value)) return { kind: "not-a-url" };
  const url = new URL(value);
  if (url.username || url.password) return { kind: "credentialed" };
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return { kind: "insecure-scheme", scheme: url.protocol.replace(":", "") };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const classification = classifyAddress(host);
  if (classification !== "public" && /^[0-9[]|:/.test(url.hostname))
    return { kind: "private-network", classification };
  if (
    localHostNames.has(url.hostname) ||
    localSuffixes.some((suffix) => url.hostname.endsWith(suffix))
  )
    return { kind: "private-network", classification: "private-name" };
  if (url.protocol === "http:")
    return { kind: "insecure-scheme", scheme: "http" };
  return { kind: "ok", origin: url.origin };
}

const profileIdSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.:-]{0,95}$/);

type SchemeInput = Record<string, unknown> | undefined;

function readOauthFlows(scheme: Record<string, unknown>): {
  kind:
    "oauth-authorization-code" | "oauth-client-credentials" | "oauth-device";
  scopes: string[];
} {
  const flows = (scheme.flows ?? scheme.oauth2SecurityScheme) as
    Record<string, unknown> | undefined;
  const container = (
    flows && typeof flows === "object" && "flows" in flows
      ? (flows as { flows?: Record<string, unknown> }).flows
      : flows
  ) as Record<string, unknown> | undefined;
  const scopesOf = (flow: unknown): string[] => {
    if (!flow || typeof flow !== "object") return [];
    const scopes = (flow as { scopes?: unknown }).scopes;
    if (!scopes || typeof scopes !== "object" || Array.isArray(scopes))
      return [];
    return Object.keys(scopes as Record<string, unknown>).slice(0, 64);
  };
  if (container?.authorizationCode)
    return {
      kind: "oauth-authorization-code",
      scopes: scopesOf(container.authorizationCode),
    };
  if (container?.deviceCode)
    return { kind: "oauth-device", scopes: scopesOf(container.deviceCode) };
  if (container?.clientCredentials)
    return {
      kind: "oauth-client-credentials",
      scopes: scopesOf(container.clientCredentials),
    };
  return { kind: "oauth-authorization-code", scopes: [] };
}

/**
 * Maps one declared security scheme to a Ceremony authentication profile.
 * Anything the runtime cannot execute is preserved as `unsupported` with the
 * native scheme name rather than replaced by a plausible-looking login.
 */
function readSecurityScheme(
  id: string,
  label: string,
  raw: SchemeInput,
): { profile: AuthenticationProfile; issues: CompatibilityIssue[] } {
  const issues: CompatibilityIssue[] = [];
  const scheme = raw ?? {};
  const base = { id, label: label.slice(0, 100) || id };
  const unsupported = (native: string): AuthenticationProfile => ({
    ...base,
    kind: "unsupported",
    native: native.slice(0, 120),
  });
  const wrapped =
    scheme.apiKeySecurityScheme !== undefined
      ? "apiKey"
      : scheme.httpAuthSecurityScheme !== undefined
        ? "http"
        : scheme.oauth2SecurityScheme !== undefined
          ? "oauth2"
          : scheme.openIdConnectSecurityScheme !== undefined
            ? "openIdConnect"
            : scheme.mtlsSecurityScheme !== undefined
              ? "mutualTLS"
              : undefined;
  const inner =
    (wrapped
      ? ((scheme as Record<string, unknown>)[
          `${wrapped === "mutualTLS" ? "mtls" : wrapped === "openIdConnect" ? "openIdConnect" : wrapped === "apiKey" ? "apiKey" : wrapped === "http" ? "httpAuth" : "oauth2"}SecurityScheme`
        ] as Record<string, unknown> | undefined)
      : undefined) ?? {};
  const type = wrapped ?? (typeof scheme.type === "string" ? scheme.type : "");
  const merged = { ...scheme, ...inner };
  if (type === "apiKey") {
    const placement = String(merged.in ?? merged.location ?? "");
    const parameterName = String(merged.name ?? "");
    if (
      !["header", "query", "cookie"].includes(placement) ||
      !/^[^\p{Cc}\s]{1,120}$/u.test(parameterName)
    )
      return { profile: unsupported("apiKey"), issues };
    return {
      profile: {
        ...base,
        kind: "api-key",
        placement: placement as "header" | "query" | "cookie",
        parameterName,
      },
      issues,
    };
  }
  if (type === "http") {
    const httpScheme = String(merged.scheme ?? "").toLowerCase();
    if (httpScheme === "bearer") {
      const format =
        typeof merged.bearerFormat === "string"
          ? merged.bearerFormat.slice(0, 64)
          : undefined;
      return {
        profile: {
          ...base,
          kind: "http-bearer",
          ...(format ? { format } : {}),
        },
        issues,
      };
    }
    if (httpScheme === "basic")
      return { profile: { ...base, kind: "http-basic" }, issues };
    return { profile: unsupported(`http/${httpScheme || "unknown"}`), issues };
  }
  if (type === "oauth2") {
    const flows = readOauthFlows(merged);
    if (flows.kind === "oauth-client-credentials")
      return {
        profile: {
          ...base,
          kind: "oauth-client-credentials",
          scopes: flows.scopes,
          clientAuthentication: "unknown",
        },
        issues,
      };
    if (flows.kind === "oauth-device")
      return {
        profile: { ...base, kind: "oauth-device", scopes: flows.scopes },
        issues,
      };
    return {
      profile: {
        ...base,
        kind: "oauth-authorization-code",
        pkce: "unknown",
        scopes: flows.scopes,
        scopeSemantics: "provider-scopes",
        clientRegistration: "unknown",
        clientAuthentication: "unknown",
        refresh: "unknown",
      },
      issues,
    };
  }
  if (type === "openIdConnect") {
    const url =
      typeof merged.openIdConnectUrl === "string"
        ? merged.openIdConnectUrl
        : "";
    const exposure = classifyDeclaredUrl(url);
    if (exposure.kind !== "ok") {
      issues.push(
        issue({
          code: "a2a.security.issuer-unusable",
          category: "security",
          pointer: `/securitySchemes/${id}/openIdConnectUrl`,
          dimension: "authorize",
          disposition: "unsupported",
          severity: "blocking",
          impact: "blocks-authorization",
          message:
            "The OpenID Connect discovery URL this card declares cannot be used as an issuer by this runtime.",
          remediation:
            "Bind an approved authentication profile for this agent instead.",
        }),
      );
      return { profile: unsupported("openIdConnect"), issues };
    }
    return {
      profile: { ...base, kind: "openid-connect", issuer: url, scopes: [] },
      issues,
    };
  }
  if (type === "mutualTLS" || type === "mutualTls")
    return { profile: { ...base, kind: "mutual-tls" }, issues };
  return { profile: unsupported(type || "unknown"), issues };
}

function skillCapability(
  skill: A2aAgentSkill,
  knownProfiles: Set<string>,
  cardRequirements: Array<Record<string, string[]>>,
): NativeCapability {
  const declared =
    skill.securityRequirements ?? skill.security ?? cardRequirements;
  const authentication = [
    ...new Set(
      declared
        .flatMap((entry) => Object.keys(entry))
        .filter((name) => knownProfiles.has(name)),
    ),
  ].slice(0, 16);
  return {
    kind: "a2a-skill",
    nativeId: skill.id,
    ...(skill.name ? { label: skill.name.slice(0, 200) } : {}),
    ...(skill.description ? { summary: skill.description.slice(0, 500) } : {}),
    // A2A says nothing about whether a skill mutates anything, what it may
    // read, or what it costs. Claiming otherwise from a name or a tag would
    // be guessing; the host's binding states the effect it approved.
    effect: "unknown",
    dataClassification: "unknown",
    cost: "unknown",
    authentication,
    nativeExtensions: {
      tags: skill.tags.slice(0, 32),
      ...(skill.examples ? { examples: skill.examples.slice(0, 8) } : {}),
      ...(skill.inputModes ? { inputModes: skill.inputModes } : {}),
      ...(skill.outputModes ? { outputModes: skill.outputModes } : {}),
    },
  };
}

export type AgentCardImport = {
  card: A2aCardView;
  source: SourceRecord;
  definition: NormalizedDefinition;
  issues: CompatibilityIssue[];
};

/**
 * Reads card bytes into a source record and a normalized definition. The
 * caller supplies the bytes and where they came from; this function performs
 * no network access of any kind.
 */
export async function readAgentCardBytes(
  input: ImportInput,
  options: { capturedAt: string },
): Promise<AgentCardImport> {
  if (input.bytes.byteLength > A2A_LIMITS.cardBytes)
    throw new ConnectorError("invalid-request", {
      detail: "a2a.card.too-large",
    });
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(input.bytes),
    ) as unknown;
  } catch {
    throw new ConnectorError("invalid-request", {
      detail: "a2a.card.not-json",
    });
  }
  const profile = detectCardProfile(parsed);
  if (!profile)
    throw new ConnectorError("invalid-request", { detail: "a2a.card.shape" });
  let card: A2aCardView;
  try {
    card = readAgentCard(profile, parsed);
  } catch (cause) {
    throw new ConnectorError("invalid-request", {
      detail: "a2a.card.invalid",
      cause,
    });
  }
  const issues: CompatibilityIssue[] = [];
  const preferred = card.interfaces[0];
  if (!preferred)
    throw new ConnectorError("invalid-request", {
      detail: "a2a.card.no-interface",
    });

  // Endpoints. Every interface is preserved as declared; the diagnostics say
  // which one this runtime could execute and why the others could not.
  const declaredServers: Array<{
    url: string;
    description?: string;
    status: "declared";
  }> = [];
  let executableInterfaces = 0;
  card.interfaces.forEach((entry, index) => {
    const pointer =
      profile === A2A_PROFILE_0_3 && index === 0
        ? "/url"
        : `/${profile === A2A_PROFILE_0_3 ? "additionalInterfaces" : "supportedInterfaces"}/${index}/url`;
    const exposure = classifyDeclaredUrl(entry.url);
    if (
      /^[^\p{Cc}?#]+$/u.test(entry.url) &&
      !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*@/.test(entry.url)
    )
      declaredServers.push({
        url: entry.url,
        description: `${entry.binding} ${entry.protocolVersion}`.slice(0, 500),
        status: "declared",
      });
    if (exposure.kind === "private-network")
      issues.push(
        issue({
          code: "a2a.interface.private-network",
          category: "network",
          pointer,
          dimension: "delegate",
          disposition: "requires-configuration",
          severity: "warning",
          impact: "blocks-operation",
          message:
            "This interface names a private, loopback or link-local address. It is kept as data and is never contacted without an administrator-approved private destination.",
          remediation:
            "Approve an explicit private destination in the runtime binding, or use a public HTTPS interface.",
        }),
      );
    else if (exposure.kind !== "ok")
      issues.push(
        issue({
          code: "a2a.interface.unusable-url",
          category: "network",
          pointer,
          dimension: "delegate",
          disposition: "unsupported",
          severity: "warning",
          impact: "blocks-operation",
          message:
            "This interface URL is not an HTTPS endpoint without credentials, so it cannot become an approved destination.",
        }),
      );
    if (entry.binding !== A2A_SUPPORTED_BINDING)
      issues.push(
        issue({
          code: "a2a.binding.unsupported",
          category: "structure",
          pointer: pointer.replace(/url$/, "protocolBinding"),
          dimension: "delegate",
          disposition: "unsupported",
          severity: "warning",
          impact: "blocks-operation",
          message:
            "Only the JSON-RPC protocol binding is implemented; this interface declares another one.",
        }),
      );
    const known = Object.entries(A2A_PROTOCOL_VERSIONS).find(([, versions]) =>
      versions.includes(entry.protocolVersion),
    );
    if (!known)
      issues.push(
        issue({
          code: "a2a.version.unsupported",
          category: "version",
          pointer: pointer.replace(/url$/, "protocolVersion"),
          dimension: "delegate",
          disposition: "unsupported",
          severity: "warning",
          impact: "blocks-operation",
          message:
            "This interface declares an A2A protocol version outside the supported matrix (1.0 and 0.3).",
        }),
      );
    if (
      exposure.kind === "ok" &&
      entry.binding === A2A_SUPPORTED_BINDING &&
      known
    )
      executableInterfaces++;
  });
  if (executableInterfaces === 0)
    issues.push(
      issue({
        code: "a2a.interface.none-executable",
        category: "structure",
        pointer: "/",
        dimension: "delegate",
        disposition: "unsupported",
        severity: "blocking",
        impact: "blocks-operation",
        message:
          "No interface on this card is an HTTPS JSON-RPC endpoint on a supported protocol version, so delegation cannot be bound from it alone.",
        remediation:
          "Approve an explicit destination and profile in the runtime binding before delegating.",
      }),
    );

  // Card claims about authority. A signature is a signer's statement; nothing
  // here verifies one, so a signed card is reported as claiming a signature.
  if (card.signatures > 0)
    issues.push(
      issue({
        code: "a2a.card.signature-unverified",
        category: "identity",
        pointer: "/signatures",
        dimension: "import",
        disposition: "native-extension",
        severity: "warning",
        impact: "none",
        message:
          "The card carries JWS signatures. They are preserved as data and are not verified here; a signature proves a signer's statement only under a trust policy this import does not have.",
      }),
    );
  for (const extension of card.capabilities.extensions ?? [])
    if (extension.required)
      issues.push(
        issue({
          code: "a2a.extension.required-unsupported",
          category: "structure",
          pointer: "/capabilities/extensions",
          dimension: "delegate",
          disposition: "unsupported",
          severity: "blocking",
          impact: "blocks-operation",
          message:
            "The agent marks a protocol extension as required; this adapter negotiates no extensions, so delegation to it is blocked.",
        }),
      );
  if (card.capabilities.pushNotifications)
    issues.push(
      issue({
        code: "a2a.push-notifications.not-configured",
        category: "structure",
        pointer: "/capabilities/pushNotifications",
        dimension: "events",
        disposition: "unsupported",
        severity: "warning",
        impact: "blocks-operation",
        message:
          "The agent offers push notifications. This adapter does not register a webhook; task progress is polled through an approved status operation instead.",
      }),
    );
  for (const [key, value] of [
    ["documentationUrl", card.documentationUrl],
    ["iconUrl", card.iconUrl],
    ["provider/url", card.provider?.url],
  ] as const) {
    if (!value) continue;
    const exposure = classifyDeclaredUrl(value);
    if (exposure.kind === "private-network" || exposure.kind === "credentialed")
      issues.push(
        issue({
          code: "a2a.card.private-reference",
          category: "network",
          pointer: `/${key}`,
          dimension: "import",
          disposition: "native-extension",
          severity: "warning",
          impact: "none",
          message:
            "The card points at a private-network or credentialed URL. It is stored verbatim as data for review and is never fetched.",
        }),
      );
  }

  // Authentication. Scheme keys come from the card, so a key that is not a
  // usable profile id gets a generated one and keeps its native spelling in
  // the label; nothing is dropped and nothing collides.
  const authentication: AuthenticationProfile[] = [];
  const idByScheme = new Map<string, string>();
  const used = new Set<string>();
  Object.entries(card.securitySchemes)
    .slice(0, A2A_LIMITS.securitySchemes)
    .forEach(([name, scheme], index) => {
      let id = profileIdSchema.safeParse(name).success
        ? name
        : `scheme-${index}`;
      while (used.has(id)) id = `${id}-${index}`;
      used.add(id);
      idByScheme.set(name, id);
      const mapped = readSecurityScheme(
        id,
        name,
        scheme as Record<string, unknown>,
      );
      authentication.push(mapped.profile);
      issues.push(...mapped.issues);
      if (mapped.profile.kind === "unsupported")
        issues.push(
          issue({
            code: "a2a.security.scheme-unsupported",
            category: "security",
            pointer: `/securitySchemes/${index}`,
            dimension: "authorize",
            disposition: "unsupported",
            severity: "blocking",
            impact: "blocks-authorization",
            message:
              "This declared security scheme is not executable by this runtime; it is preserved for review.",
            remediation:
              "Configure an approved credential for this agent in the runtime binding.",
          }),
        );
    });
  if (!authentication.length) {
    authentication.push({
      id: "declared-none",
      label: "No credential declared",
      kind: "none",
      reason: "anonymous",
    });
    issues.push(
      issue({
        code: "a2a.security.none-declared",
        category: "security",
        pointer: "/securitySchemes",
        dimension: "authorize",
        disposition: "requires-configuration",
        severity: "warning",
        impact: "blocks-authorization",
        message:
          "The card declares no security scheme. A no-credential description is recorded rather than a fabricated login; the binding decides what this deployment presents.",
      }),
    );
  }
  const knownProfiles = new Set(idByScheme.keys());
  const capabilities = card.skills.map((skill) =>
    skillCapability(skill, knownProfiles, card.securityRequirements),
  );
  // Capability identity must be unique; two skills with the same id would make
  // first-match binding the only option and that is never an option.
  const seenSkills = new Set<string>();
  for (const [index, capability] of capabilities.entries()) {
    if (seenSkills.has(capability.nativeId))
      issues.push(
        issue({
          code: "a2a.skill.duplicate-id",
          category: "structure",
          pointer: `/skills/${index}/id`,
          dimension: "delegate",
          disposition: "rejected",
          severity: "blocking",
          impact: "blocks-operation",
          message:
            "Two skills share one id. Binding names a skill by id, so the duplicate is refused rather than resolved by position.",
        }),
      );
    seenSkills.add(capability.nativeId);
  }
  const unique = capabilities.filter(
    (capability, index) =>
      capabilities.findIndex(
        (other) => other.nativeId === capability.nativeId,
      ) === index,
  );
  // Remap capability authentication ids to the sanitized profile ids.
  const remapped = unique.map((capability) => ({
    ...capability,
    authentication: (capability.authentication ?? [])
      .map((name) => idByScheme.get(name))
      .filter((value): value is string => value !== undefined),
  }));

  const digest = createHash("sha256").update(input.bytes).digest("hex");
  // Identity names the interface this runtime could actually reach. A card
  // whose preferred interface is a metadata address, a private host or a
  // credentialed URL does not get that URL promoted into an identifier: the
  // agent projection carries native ids, and a navigable private URL has no
  // business in a model's context. Every declared interface is still kept, in
  // `declaredServers` and in the inert extensions, for a reviewer to see.
  const usable = card.interfaces.find(
    (entry) => classifyDeclaredUrl(entry.url).kind === "ok",
  );
  const origin = usable ? new URL(usable.url).origin : "";
  if (!usable)
    issues.push(
      issue({
        code: "a2a.card.identity-synthesized",
        category: "identity",
        pointer: "/",
        dimension: "import",
        disposition: "adapted",
        severity: "warning",
        impact: "blocks-operation",
        message:
          "No interface on this card is a reachable HTTPS endpoint, so the connector identity is a digest of the card rather than one of its URLs.",
      }),
    );
  const identity = {
    ecosystem: "a2a" as const,
    authorityNamespace: origin.slice(0, 256),
    nativeId: usable
      ? usable.url.slice(0, 512)
      : `a2a-card:${digest.slice(0, 32)}`,
    nativeVersion: card.version.slice(0, 128),
  };
  const source = sourceRecordSchema.parse({
    sourceRef: `a2a:src:${digest.slice(0, 32)}`,
    identity,
    format: { name: "a2a-agent-card", version: card.protocolVersion },
    origin: input.origin,
    digest: { algorithm: "sha256", value: digest },
    byteLength: input.bytes.byteLength,
    mediaType: /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(input.mediaType)
      ? input.mediaType
      : "application/json",
    capturedAt: options.capturedAt,
    adaptation: [],
    overlays: [],
  } satisfies Record<string, unknown>) as SourceRecord;

  const body = {
    schemaVersion: 1 as const,
    definitionRef: `a2a:def:${digest.slice(0, 32)}`,
    identity,
    sourceRef: source.sourceRef,
    importer: { id: A2A_IMPORTER_ID, version: A2A_IMPORTER_VERSION },
    display: {
      name: card.name.slice(0, 200),
      description: card.description.slice(0, 500),
      ecosystem: "a2a" as const,
      service: serviceSlugFor(card, origin),
    },
    authentication,
    configuration: [],
    capabilities: remapped,
    events: [],
    declaredServers,
    compatibility: {
      issues,
      dimensions: completeDimensions({
        import: "exact",
        configure: "requires-configuration",
        authorize: "requires-configuration",
        verify: "requires-configuration",
        delegate: "requires-configuration",
        disconnect: "adapted",
        reconnect: "adapted",
      }),
    },
    nativeExtensions: {
      // Everything the card said that is not a Ceremony concept, kept inert.
      profile,
      protocolVersion: card.protocolVersion,
      agentVersion: card.version,
      interfaces: card.interfaces.map((entry) => ({
        url: entry.url,
        binding: entry.binding,
        protocolVersion: entry.protocolVersion,
        ...(entry.tenant === undefined ? {} : { tenant: entry.tenant }),
        preferred: entry.preferred,
      })),
      taskCapabilities: {
        // A2A tasks are part of the protocol, not of the card: every A2A agent
        // answers GetTask and CancelTask, and may interrupt for input.
        statusPolling: true,
        cancel: true,
        inputRequired: true,
        authRequired: true,
        streaming: card.capabilities.streaming === true,
        pushNotifications: card.capabilities.pushNotifications === true,
        extendedAgentCard: card.extendedCard,
      },
      defaultInputModes: card.defaultInputModes,
      defaultOutputModes: card.defaultOutputModes,
      securityRequirements: card.securityRequirements,
      ...(card.provider ? { provider: card.provider } : {}),
      ...(card.documentationUrl
        ? { documentationUrl: card.documentationUrl }
        : {}),
      ...(card.iconUrl ? { iconUrl: card.iconUrl } : {}),
      signatures: card.signatures,
      extensions: (card.capabilities.extensions ?? []).map((extension) => ({
        ...(extension.uri ? { uri: extension.uri } : {}),
        required: extension.required === true,
      })),
    },
  };
  const definition = normalizedDefinitionSchema.parse({
    ...body,
    normalizedDigest: await canonicalDigest(
      (() => {
        const {
          definitionRef: _definitionRef,
          sourceRef: _sourceRef,
          ...rest
        } = body;
        void _definitionRef;
        void _sourceRef;
        return rest;
      })(),
    ),
  });
  return { card, source, definition, issues };
}

function serviceSlugFor(card: A2aCardView, origin: string): string | undefined {
  const host = origin ? new URL(origin).hostname : "";
  const candidate = (host || card.name)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return /^[a-z0-9][a-z0-9._-]*$/.test(candidate) ? candidate : undefined;
}

/** The adapter's `import` entry point: bytes in, descriptions out, nothing fetched. */
export async function importAgentCard(
  ctx: AdapterCallContext,
  input: ImportInput,
): Promise<ImportOutcome> {
  const outcome = await readAgentCardBytes(input, {
    capturedAt: new Date(ctx.environment.now()).toISOString(),
  });
  return {
    source: outcome.source,
    definitions: [outcome.definition],
    issues: outcome.issues,
    executableCandidates: outcome.definition.capabilities.map(
      (capability) => capability.nativeId,
    ),
  };
}

export type { A2aProfile };
