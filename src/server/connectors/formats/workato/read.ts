import type {
  AuthenticationProfile,
  ConfigurationRequirement,
  EventDescriptor,
  MappingDisposition,
  NativeCapability,
} from "../../../../core/connectors/index.js";
import {
  IssueCollector,
  inertCopy,
  locate,
  nativeId as asNativeId,
  pointer,
  safeText,
  serviceKey,
  token,
} from "../automation/common.js";
import {
  authenticationDisposition,
  buildAutomationDefinition,
  type AutomationDimensions,
  type AutomationReadResult,
} from "../automation/definition.js";
import {
  fromJsonValue,
  hashValue,
  parseRubySource,
  readRubyConnectorHash,
  rubyArray,
  rubyBoolean,
  rubyEntries,
  rubyString,
  toJsonValue,
  type RubyOpaqueReason,
  type RubyValue,
} from "../automation/ruby-literals.js";
import {
  WORKATO_AUTH_TYPES,
  WORKATO_ECOSYSTEM,
  WORKATO_IMPORTER,
  WORKATO_LIMITS,
  WORKATO_PROFILES,
} from "./profile.js";

/*
 * Reads a Workato connector into a normalized description.
 *
 * A Workato connector is Ruby, and most of what it does lives in lambdas:
 * `execute`, `poll`, `apply`, `acquire`, `refresh`, `input_fields`,
 * `object_definitions`. None of that is loaded, parsed as behaviour or run.
 * Two inputs are accepted: the `workato-static-profile/1` document this
 * repository defines and documents, in which literals are literals and every
 * lambda is an explicit marker; and Ruby source text, from which a bounded
 * tokenizer takes literal hash entries only — the connection fields, the
 * authorization type, the action and trigger names, and any field list that
 * was written as a literal array rather than a lambda.
 */

export type WorkatoIdentityHint = {
  nativeId?: string;
  nativeVersion?: string;
  authorityNamespace?: string;
  displayName?: string;
  description?: string;
  service?: string;
};

export type WorkatoReadInput = {
  /** A `workato-static-profile/1` document, already parsed from JSON or YAML. */
  staticProfile?: unknown;
  /** Ruby connector source; read by the bounded literal extractor. */
  rubySource?: string;
  identity?: WorkatoIdentityHint;
};

const REASON_MESSAGE: Record<RubyOpaqueReason, string> = {
  lambda: "a Ruby lambda",
  block: "a Ruby block",
  "method-call": "a Ruby method call",
  interpolation: "an interpolated string",
  reference: "a reference to another value",
  expression: "a Ruby expression",
  heredoc: "a heredoc",
  "percent-literal": "a percent literal",
  command: "a shell command literal",
  regex: "a regular expression literal",
  splat: "a splatted value",
  truncated: "a value beyond the reader's bounds",
};

function opaqueReason(value: RubyValue | undefined): RubyOpaqueReason | undefined {
  return value?.kind === "opaque" ? value.reason : undefined;
}

function literalUrl(value: RubyValue | undefined): string | undefined {
  const text = rubyString(value);
  if (text === undefined) return undefined;
  if (!/^https:\/\/[^\s]+$/i.test(text) || !URL.canParse(text)) return undefined;
  const parsed = new URL(text);
  return parsed.username || parsed.password ? undefined : text;
}

function configurationName(
  connectorKey: string,
  fieldName: string,
  used: Set<string>,
): string {
  const clean = (value: string) =>
    value
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  const base = `WORKATO_${clean(connectorKey)}_${clean(fieldName)}`
    .replace(/_{2,}/g, "_")
    .slice(0, 96);
  let candidate = /^[A-Z][A-Z0-9_]{0,95}$/.test(base)
    ? base
    : `WORKATO_${clean(fieldName)}`.slice(0, 96);
  if (!/^[A-Z][A-Z0-9_]{0,95}$/.test(candidate)) candidate = "WORKATO_FIELD";
  let counter = 2;
  while (used.has(candidate)) {
    const suffix = `_${counter++}`;
    candidate = `${candidate.slice(0, 96 - suffix.length)}${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

const SENSITIVE =
  /(password|secret|token|key|credential|signature|passphrase|private)/i;

type AuthMapping = {
  profiles: AuthenticationProfile[];
  profileIds: string[];
  limitations: string[];
  servers: Array<[string, string]>;
  native: Record<string, unknown>;
};

/**
 * Maps one `authorization` hash. `type` is a literal in both input paths, so
 * the scheme is known; where the credential goes is stated in code, so it is
 * known only when the static profile declares it. A connector whose placement
 * is unknown keeps all of its other metadata and reports an unsupported
 * authentication method rather than a guessed one.
 */
function mapAuthorization(
  authorization: RubyValue | undefined,
  idPrefix: string,
  issues: IssueCollector,
  at: (...segments: Array<string | number>) => string,
): AuthMapping {
  const result: AuthMapping = {
    profiles: [],
    profileIds: [],
    limitations: [],
    servers: [],
    native: {},
  };
  const type = rubyString(hashValue(authorization, "type"));
  if (type !== undefined) result.native["type"] = type;
  if (hashValue(authorization, "refresh") !== undefined)
    result.native["hasRefresh"] = true;
  const unsupported = (native: string, message: string) => {
    const id = `${idPrefix}-native`.slice(0, 95);
    result.profiles.push({
      id,
      label: safeText(`Workato ${native}`, 100),
      kind: "unsupported",
      native,
    });
    result.profileIds.push(id);
    issues.add({
      code: `workato.authorization.${native.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
      category: "security",
      pointer: at("type"),
      dimension: "authorize",
      severity: "blocking",
      disposition: "unsupported",
      executionImpact: "blocks-authorization",
      message,
      remediation:
        "Declare the method explicitly in a static profile, or authorize this service through a host-owned method.",
    });
    result.limitations.push(message);
  };

  if (type === undefined) {
    issues.add({
      code: "workato.authorization.type-not-literal",
      category: "security",
      pointer: at("type"),
      dimension: "authorize",
      severity: "blocking",
      disposition: "unsupported",
      executionImpact: "blocks-authorization",
      message:
        "The authorization type is not a literal value, so no authentication method could be determined.",
    });
    return result;
  }
  if (!(WORKATO_AUTH_TYPES as readonly string[]).includes(type)) {
    unsupported(
      `workato-${safeText(type, 40).replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase() || "unknown"}`,
      `The authorization type "${token(type, 40)}" is not one the SDK documents or this runtime implements.`,
    );
    return result;
  }

  for (const key of ["apply", "acquire", "refresh", "identity", "pkce"] as const) {
    const reason = opaqueReason(hashValue(authorization, key));
    if (!reason) continue;
    issues.add({
      code: "executable-code.function",
      category: "executable-code",
      pointer: at(key),
      dimension: key === "refresh" ? "reconnect" : "authorize",
      severity: "info",
      disposition: "requires-configuration",
      message: `The authorization "${token(key)}" step is ${REASON_MESSAGE[reason]}; it was recorded, not read or run.`,
    });
  }

  switch (type) {
    case "basic_auth": {
      const id = `${idPrefix}-basic`.slice(0, 95);
      result.profiles.push({ id, label: "Workato basic authentication", kind: "http-basic" });
      result.profileIds.push(id);
      break;
    }
    case "api_key": {
      const apply = hashValue(authorization, "apply");
      const placement = rubyString(hashValue(apply, "placement"));
      const parameter = rubyString(hashValue(apply, "parameter"));
      if (
        (placement === "header" || placement === "query" || placement === "cookie") &&
        parameter !== undefined &&
        parameter.length > 0
      ) {
        const id = `${idPrefix}-api-key`.slice(0, 95);
        result.profiles.push({
          id,
          label: "Workato API key",
          kind: "api-key",
          placement,
          parameterName: parameter.slice(0, 120),
        });
        result.profileIds.push(id);
        result.native["apply"] = { placement, parameter };
        break;
      }
      unsupported(
        "workato-api-key-placement",
        "The connector declares an API key but places it in a Ruby lambda, so where the credential belongs in a request cannot be read from this description.",
      );
      break;
    }
    case "oauth2": {
      const authorizationUrl = literalUrl(hashValue(authorization, "authorization_url"));
      const tokenUrl = literalUrl(hashValue(authorization, "token_url"));
      if (authorizationUrl === undefined || tokenUrl === undefined) {
        unsupported(
          "workato-oauth2-dynamic",
          "The OAuth 2.0 endpoints are produced by Ruby lambdas rather than declared as literal URLs, so they cannot be approved from this description.",
        );
        break;
      }
      const pkce = hashValue(authorization, "pkce");
      const challengeMethod = rubyString(hashValue(pkce, "challenge_method"));
      const scopes = rubyArray(hashValue(authorization, "scopes"))
        ?.map((item) => rubyString(item))
        .filter((item): item is string => item !== undefined)
        .slice(0, 64);
      const id = `${idPrefix}-oauth2`.slice(0, 95);
      result.profiles.push({
        id,
        label: "Workato OAuth 2.0",
        kind: "oauth-authorization-code",
        pkce:
          challengeMethod === "S256"
            ? "S256"
            : challengeMethod === "plain"
              ? "plain"
              : pkce === undefined
                ? "none"
                : "unknown",
        authorizationEndpoint: authorizationUrl,
        tokenEndpoint: tokenUrl,
        scopes: scopes ?? [],
        scopeSemantics: scopes?.length ? "provider-scopes" : "unknown",
        clientRegistration: "pre-registered",
        clientAuthentication: "unknown",
        refresh:
          hashValue(authorization, "refresh") === undefined ? "unknown" : "supported",
      });
      result.profileIds.push(id);
      result.native["authorization_url"] = authorizationUrl;
      result.native["token_url"] = tokenUrl;
      if (scopes?.length) result.native["scopes"] = scopes;
      if (challengeMethod !== undefined)
        result.native["pkce"] = { challenge_method: challengeMethod };
      for (const url of [authorizationUrl, tokenUrl])
        result.servers.push([new URL(url).origin, "Declared OAuth 2.0 endpoint"]);
      break;
    }
    case "custom_auth": {
      // The SDK's own client-credentials guide writes that grant as
      // `custom_auth` with an `acquire` lambda. Only an explicit declaration
      // makes it readable; the lambda never is.
      const oauth2 = hashValue(authorization, "oauth2");
      const grant = rubyString(hashValue(oauth2, "grant"));
      const tokenUrl = literalUrl(hashValue(oauth2, "token_url"));
      if (grant === "client_credentials" && tokenUrl !== undefined) {
        const scopes = rubyArray(hashValue(oauth2, "scopes"))
          ?.map((item) => rubyString(item))
          .filter((item): item is string => item !== undefined)
          .slice(0, 64);
        const id = `${idPrefix}-client-credentials`.slice(0, 95);
        result.profiles.push({
          id,
          label: "Workato client credentials",
          kind: "oauth-client-credentials",
          tokenEndpoint: tokenUrl,
          scopes: scopes ?? [],
          clientAuthentication: "unknown",
        });
        result.profileIds.push(id);
        result.native["oauth2"] = {
          grant,
          token_url: tokenUrl,
          ...(scopes?.length ? { scopes } : {}),
        };
        result.servers.push([new URL(tokenUrl).origin, "Declared token endpoint"]);
        break;
      }
      unsupported(
        "workato-custom-auth",
        "Custom authentication acquires and applies its credential in Ruby lambdas, so the exchange cannot be read from this description.",
      );
      break;
    }
    case "multi": {
      const options = rubyEntries(hashValue(authorization, "options")) ?? [];
      if (!options.length) {
        unsupported(
          "workato-multi-auth",
          "The connector offers several authentication methods but does not list them as literals, so none could be read.",
        );
        break;
      }
      for (const option of options.slice(0, 8)) {
        if (!option.key) continue;
        const mapped = mapAuthorization(
          option.value,
          `${idPrefix}-${option.key}`.replace(/[^a-zA-Z0-9_.:-]/g, "-").slice(0, 80),
          issues,
          (...segments) => at("options", option.key, ...segments),
        );
        result.profiles.push(...mapped.profiles);
        result.profileIds.push(...mapped.profileIds);
        result.limitations.push(...mapped.limitations);
        result.servers.push(...mapped.servers);
      }
      result.native["options"] = result.profileIds.slice(0, 8);
      if (opaqueReason(hashValue(authorization, "selected")))
        issues.add({
          code: "executable-code.function",
          category: "executable-code",
          pointer: at("selected"),
          dimension: "authorize",
          severity: "info",
          disposition: "requires-configuration",
          message:
            "Which authentication method applies is decided by a Ruby lambda; the host chooses the approved profile instead.",
        });
      break;
    }
  }
  return result;
}

function readFieldArray(
  value: RubyValue | undefined,
  issues: IssueCollector,
  path: Array<string | number>,
  dimension: "import" | "invoke",
  label: string,
  limitations: Set<string>,
): unknown[] | undefined {
  if (value === undefined) return undefined;
  const reason = opaqueReason(value);
  if (reason) {
    issues.add({
      code: "executable-code.function",
      category: "executable-code",
      pointer: pointer(...path),
      dimension,
      severity: "warning",
      disposition: "requires-configuration",
      message: `${label} is ${REASON_MESSAGE[reason]}; the fields it would produce are not part of this description.`,
      remediation:
        "Declare the field list as a literal array in a static profile if it must travel with the description.",
    });
    limitations.add(
      "Some field lists are built by Ruby lambdas and are not part of this description.",
    );
    return undefined;
  }
  const items = rubyArray(value);
  if (!items) return undefined;
  const preserved: unknown[] = [];
  for (const item of items.slice(0, WORKATO_LIMITS.fields)) {
    const copied = toJsonValue(item);
    if (copied !== undefined) preserved.push(inertCopy(copied));
  }
  return preserved;
}

/**
 * Reads a Workato connector from a static profile or from Ruby source into a
 * normalized description plus the diagnostics that say exactly what was not
 * imported. No Ruby is executed on any path.
 */
export async function readWorkatoConnector(
  input: WorkatoReadInput,
): Promise<AutomationReadResult> {
  const issues = new IssueCollector(WORKATO_LIMITS.issues);
  const limitations = new Set<string>();
  const declaredServers = new Map<string, string>();
  const hint = input.identity ?? {};

  let connector: RubyValue | undefined;
  let profile: string = WORKATO_PROFILES.staticProfile;
  let importDisposition: MappingDisposition = "exact";
  let sourceMaterial: unknown = null;
  const file = input.rubySource === undefined ? undefined : "connector.rb";

  if (input.staticProfile !== undefined) {
    const value = fromJsonValue(input.staticProfile);
    sourceMaterial = input.staticProfile;
    if (value.kind === "hash") connector = value;
    else
      issues.add({
        code: "workato.profile.not-object",
        category: "structure",
        pointer: "#",
        dimension: "import",
        severity: "blocking",
        disposition: "rejected",
        executionImpact: "blocks-definition",
        message: "The static profile is not an object.",
      });
    const declared = rubyString(hashValue(connector, "profile"));
    if (declared !== undefined && declared !== WORKATO_PROFILES.staticProfile)
      issues.add({
        code: "workato.profile.version",
        category: "version",
        pointer: pointer("profile"),
        dimension: "import",
        severity: "warning",
        disposition: "adapted",
        message: `The document declares profile "${token(declared, 60)}"; this reader implements ${WORKATO_PROFILES.staticProfile}.`,
      });
  } else if (input.rubySource !== undefined) {
    profile = WORKATO_PROFILES.ruby;
    importDisposition = "adapted";
    sourceMaterial = { sourceLength: input.rubySource.length };
    const parse = parseRubySource(input.rubySource);
    const read = readRubyConnectorHash(parse);
    if (read.truncated)
      issues.add({
        code: "workato.source.truncated",
        category: "structure",
        pointer: "#",
        dimension: "import",
        severity: "warning",
        disposition: "adapted",
        message:
          "The source exceeded the reader's bounds; the description covers only the part that was read.",
      });
    if (read.value) connector = read.value;
    else
      issues.add({
        code: "workato.source.no-connector-hash",
        category: "structure",
        pointer: "#",
        dimension: "import",
        severity: "blocking",
        disposition: "rejected",
        executionImpact: "blocks-definition",
        message:
          "No connector hash was found in the Ruby source. Only a literal top-level hash is read.",
        remediation: `Supply a ${WORKATO_PROFILES.staticProfile} document instead.`,
      });
    issues.add({
      code: "workato.source.literal-only",
      category: "executable-code",
      pointer: "#",
      dimension: "import",
      severity: "info",
      disposition: "adapted",
      message:
        "Ruby source is read for literal hash entries only: connection fields, the authorization type, action and trigger names, and field lists written as literal arrays. Every lambda and block is recorded and never run.",
    });
  } else {
    issues.add({
      code: "workato.input.missing",
      category: "structure",
      pointer: "#",
      dimension: "import",
      severity: "blocking",
      disposition: "rejected",
      executionImpact: "blocks-definition",
      message: "No static profile and no Ruby source were supplied.",
    });
  }

  const title = rubyString(hashValue(connector, "title"));
  const nativeId =
    asNativeId(hint.nativeId) ?? asNativeId(title) ?? "workato-connector";
  const nativeVersion = asNativeId(hint.nativeVersion) ?? "unversioned";
  if (hint.nativeVersion === undefined)
    issues.add({
      code: "workato.connector.no-version",
      category: "version",
      pointer: "#",
      dimension: "import",
      severity: "info",
      disposition: "adapted",
      message:
        "A Workato connector carries no version of its own; the host must supply one for a binding to be pinned to an exact revision.",
    });

  const connection = hashValue(connector, "connection");
  const at = (...segments: Array<string | number>) =>
    locate(pointer("connection", "authorization", ...segments), {
      line: connection?.loc.line ?? 0,
      column: connection?.loc.column ?? 0,
      ...(file ? { file } : {}),
    });
  const auth = mapAuthorization(
    hashValue(connection, "authorization"),
    "workato",
    issues,
    at,
  );
  for (const limitation of auth.limitations) limitations.add(limitation);
  for (const [origin, note] of auth.servers) declaredServers.set(origin, note);

  const configuration: ConfigurationRequirement[] = [];
  const used = new Set<string>();
  const connectionFieldsValue = hashValue(connection, "fields");
  const connectionFields = rubyArray(connectionFieldsValue);
  const literalConnectionFields: unknown[] = [];
  if (connectionFieldsValue !== undefined && connectionFields === undefined)
    issues.add({
      code: "workato.connection.fields-not-literal",
      category: "structure",
      pointer: pointer("connection", "fields"),
      dimension: "configure",
      severity: "warning",
      disposition: "unsupported",
      message:
        "The connection fields are not a literal array, so the connection form could not be imported.",
    });
  for (const [index, field] of (connectionFields ?? [])
    .slice(0, WORKATO_LIMITS.configuration)
    .entries()) {
    const name = rubyString(hashValue(field, "name"));
    if (name === undefined) {
      issues.add({
        code: "workato.connection.field-not-literal",
        category: "structure",
        pointer: pointer("connection", "fields", index),
        dimension: "configure",
        severity: "warning",
        disposition: "unsupported",
        message: "A connection field has no literal name and was not imported.",
      });
      continue;
    }
    const controlType = rubyString(hashValue(field, "control_type"));
    const optional = rubyBoolean(hashValue(field, "optional"));
    const label = rubyString(hashValue(field, "label"));
    const hintText = rubyString(hashValue(field, "hint"));
    configuration.push({
      name: configurationName(nativeId, name, used),
      source: "session-environment",
      classification:
        controlType === "password" || SENSITIVE.test(name) ? "secret" : "secret",
      // The SDK treats a field as required unless `optional` says otherwise.
      required: optional !== true,
      ...(label || hintText
        ? {
            description: safeText(
              [label, hintText].filter(Boolean).join(". ").replace(/<[^>]*>/g, ""),
              500,
            ),
          }
        : {}),
    });
    const copied = toJsonValue(field);
    if (copied !== undefined) literalConnectionFields.push(inertCopy(copied));
  }

  const baseUri = hashValue(connection, "base_uri");
  const baseUriUrl = literalUrl(baseUri);
  if (baseUriUrl !== undefined)
    declaredServers.set(new URL(baseUriUrl).origin, "Declared connector base URI");
  else if (baseUri !== undefined) {
    const reason = opaqueReason(baseUri);
    issues.add({
      code: reason ? "executable-code.function" : "workato.connection.base-uri",
      category: reason ? "executable-code" : "network",
      pointer: pointer("connection", "base_uri"),
      dimension: "invoke",
      severity: "warning",
      disposition: "requires-configuration",
      message: reason
        ? `The connector's base URI is ${REASON_MESSAGE[reason]}; it was recorded, not read or run, so no destination can be approved from it.`
        : "The connector's base URI is not a literal https URL, so no destination can be approved from it.",
      remediation:
        "Approve an exact destination origin in the binding instead of deriving one from connector code.",
    });
    limitations.add(
      "The connector's base URI is built by connector code; an approved destination must be named explicitly.",
    );
  }

  for (const key of ["test", "webhook_keys", "pick_lists", "methods", "streams"] as const) {
    const value = hashValue(connector, key);
    const reason = opaqueReason(value);
    if (value === undefined) continue;
    if (reason)
      issues.add({
        code: "executable-code.function",
        category: "executable-code",
        pointer: pointer(key),
        dimension: key === "test" ? "verify" : "invoke",
        severity: "info",
        disposition: "requires-configuration",
        message: `The connector's "${token(key)}" is ${REASON_MESSAGE[reason]}; it was recorded, not read or run.`,
      });
    if (key === "pick_lists" || key === "methods")
      limitations.add(
        "Picklists and reusable methods are Ruby lambdas and are not part of this description.",
      );
  }

  const capabilities: NativeCapability[] = [];
  const events: EventDescriptor[] = [];
  const executableCandidates: string[] = [];
  const collections: Array<{
    name: "actions" | "triggers";
    kind: NativeCapability["kind"];
    effect: NativeCapability["effect"];
  }> = [
    // An action does not declare whether it reads or writes; a trigger does.
    { name: "actions", kind: "action", effect: "unknown" },
    { name: "triggers", kind: "event", effect: "read" },
  ];
  for (const collection of collections) {
    const value = hashValue(connector, collection.name);
    if (value === undefined) continue;
    const entries = rubyEntries(value);
    if (!entries) {
      issues.add({
        code: "workato.collection.not-literal",
        category: "structure",
        pointer: pointer(collection.name),
        dimension: "import",
        severity: "warning",
        disposition: "unsupported",
        message: `The "${token(collection.name)}" collection is not a literal hash and was not imported.`,
      });
      continue;
    }
    for (const entry of entries.slice(0, WORKATO_LIMITS.actions)) {
      const id = asNativeId(entry.key);
      if (id === undefined) continue;
      const path = [collection.name, entry.key];
      const actionTitle = rubyString(hashValue(entry.value, "title"));
      const subtitle = rubyString(hashValue(entry.value, "subtitle"));
      const description = rubyString(hashValue(entry.value, "description"));
      const inputFields = readFieldArray(
        hashValue(entry.value, "input_fields"),
        issues,
        [...path, "input_fields"],
        "import",
        `The input fields of "${token(entry.key)}"`,
        limitations,
      );
      const outputFields = readFieldArray(
        hashValue(entry.value, "output_fields"),
        issues,
        [...path, "output_fields"],
        "import",
        `The output fields of "${token(entry.key)}"`,
        limitations,
      );
      const configFields = readFieldArray(
        hashValue(entry.value, "config_fields"),
        issues,
        [...path, "config_fields"],
        "import",
        `The configuration fields of "${token(entry.key)}"`,
        limitations,
      );
      const bodyKeys =
        collection.name === "actions"
          ? (["execute", "sample_output", "help"] as const)
          : ([
              "poll",
              "dedup",
              "webhook_subscribe",
              "webhook_unsubscribe",
              "webhook_notification",
              "webhook_key",
              "sample_output",
              "help",
            ] as const);
      const bodies: Record<string, unknown> = {};
      for (const key of bodyKeys) {
        const body = hashValue(entry.value, key);
        if (body === undefined) continue;
        const reason = opaqueReason(body);
        bodies[key] = reason ? { code: "lambda" } : (inertCopy(toJsonValue(body)) ?? null);
        if (!reason) continue;
        issues.add({
          code: "executable-code.function",
          category: "executable-code",
          pointer: pointer(...path, key),
          dimension: "invoke",
          severity: "warning",
          disposition: "requires-configuration",
          message: `"${token(entry.key)}" implements "${token(key)}" as ${REASON_MESSAGE[reason]}; it was recorded, not read or run.`,
          remediation:
            "Bind this operation to an approved host runtime; imported connector code is never executed.",
        });
        limitations.add(
          "Action and trigger bodies are Ruby lambdas and are not executed by this runtime; invoking one requires an approved external runtime binding.",
        );
      }
      const isWebhook =
        collection.name === "triggers" &&
        ["webhook_subscribe", "webhook_notification", "webhook_key"].some(
          (key) => hashValue(entry.value, key) !== undefined,
        );
      const extensions: Record<string, unknown> = {
        collection: collection.name,
        ...(subtitle ? { subtitle: safeText(subtitle, 200) } : {}),
        ...(inputFields ? { input_fields: inputFields } : {}),
        ...(outputFields ? { output_fields: outputFields } : {}),
        ...(configFields ? { config_fields: configFields } : {}),
        ...(Object.keys(bodies).length ? { bodies } : {}),
        ...(isWebhook ? { deliveryStyle: "webhook" } : {}),
        ...(collection.name === "triggers" && !isWebhook
          ? { deliveryStyle: "poll" }
          : {}),
      };
      capabilities.push({
        kind: isWebhook ? "event" : collection.name === "actions" ? "action" : "query",
        nativeId: id,
        ...(actionTitle ? { label: safeText(actionTitle, 200) } : {}),
        ...(description
          ? { summary: safeText(description.replace(/<[^>]*>/g, ""), 500) }
          : {}),
        effect: collection.effect,
        dataClassification: "unknown",
        cost: "unknown",
        authentication: [...new Set(auth.profileIds)].slice(0, 16),
        inputSchemaRef: pointer(...path, "input_fields"),
        outputSchemaRef: pointer(...path, "output_fields"),
        nativeExtensions: extensions,
      });
      if (isWebhook)
        events.push({
          nativeId: id,
          ...(actionTitle ? { label: safeText(actionTitle, 200) } : {}),
          transport: "http-webhook",
          verification:
            hashValue(connector, "webhook_keys") === undefined ? "unknown" : "vendor",
          messageSchemaRef: pointer(...path, "output_fields"),
        });
      executableCandidates.push(id);
    }
  }
  if (capabilities.length)
    issues.add({
      code: "workato.action.effect-undeclared",
      category: "policy",
      pointer: pointer("actions"),
      dimension: "invoke",
      severity: "info",
      disposition: "requires-configuration",
      message:
        "A Workato action does not declare whether it reads or writes; every imported action records an unknown effect until host policy classifies it.",
    });

  const objectDefinitions: Record<string, unknown> = {};
  const definitionEntries = rubyEntries(hashValue(connector, "object_definitions"));
  for (const entry of (definitionEntries ?? []).slice(
    0,
    WORKATO_LIMITS.objectDefinitions,
  )) {
    if (!entry.key) continue;
    const fields = readFieldArray(
      hashValue(entry.value, "fields"),
      issues,
      ["object_definitions", entry.key, "fields"],
      "import",
      `The object definition "${token(entry.key)}"`,
      limitations,
    );
    if (fields) objectDefinitions[entry.key] = fields;
  }

  const nativeExtensions: Record<string, unknown> = {
    profile,
    ...(title ? { title } : {}),
    ...(hashValue(connector, "webhook_keys") === undefined
      ? {}
      : { hasWebhookKeys: true }),
    ...(hashValue(connector, "test") === undefined ? {} : { hasTest: true }),
    ...(Object.keys(auth.native).length ? { authorization: auth.native } : {}),
    ...(literalConnectionFields.length
      ? { connectionFields: literalConnectionFields }
      : {}),
    ...(baseUriUrl === undefined ? {} : { baseUri: baseUriUrl }),
    ...(Object.keys(objectDefinitions).length ? { objectDefinitions } : {}),
    limitations: [...limitations].slice(0, 32),
  };

  const authenticationProfiles: AuthenticationProfile[] = auth.profiles.length
    ? auth.profiles
    : [
        {
          id: "workato-none",
          label: "No credential declared",
          kind: "none",
          reason: "public",
        },
      ];
  const dimensions: AutomationDimensions = {
    import: issues.blocksDefinition() ? "unsupported" : importDisposition,
    configure: "adapted",
    authorize: authenticationDisposition(authenticationProfiles),
    invoke: "requires-configuration",
    export: "adapted",
    delegate: "requires-configuration",
    events: events.length ? "requires-configuration" : "unsupported",
  };

  const definition = await buildAutomationDefinition({
    identity: {
      ecosystem: WORKATO_ECOSYSTEM,
      authorityNamespace: safeText(hint.authorityNamespace ?? "", 256),
      nativeId,
      nativeVersion,
    },
    importer: WORKATO_IMPORTER,
    display: {
      name: safeText(hint.displayName ?? title ?? nativeId, 200),
      description: safeText(
        hint.description ??
          "Workato SDK connector imported as a description; its Ruby is not executed here.",
        500,
      ),
      ecosystem: WORKATO_ECOSYSTEM,
      service: hint.service ? serviceKey(hint.service) : serviceKey(nativeId),
    },
    authentication: authenticationProfiles,
    configuration,
    capabilities,
    events,
    declaredServers: [...declaredServers.entries()]
      .slice(0, WORKATO_LIMITS.servers)
      .map(([url, note]) => ({ url, description: note })),
    issues: issues.issues,
    dimensions,
    nativeExtensions,
    sourceMaterial,
  });

  return {
    definition,
    issues: issues.issues,
    executableCandidates: issues.blocksDefinition() ? [] : executableCandidates,
  };
}
