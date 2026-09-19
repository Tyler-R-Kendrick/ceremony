/*
 * Pinned facts about the Zapier Platform source formats this reader accepts.
 *
 * Retrieved 2026-09-18 from https://docs.zapier.com/integrations/build-cli/overview
 * and the generated schema document it links to,
 * https://github.com/zapier/zapier-platform/blob/main/packages/schema/docs/build/schema.md
 * (raw file, `zapier-platform-schema` version 19.1.0). Verified there and used
 * here: AppSchema keys (`version`, `platformVersion`, `authentication`,
 * `requestTemplate`, `beforeRequest`, `afterResponse`, `hydrators`,
 * `resources`, `triggers`, `bulkReads`, `searches`, `creates`,
 * `searchOrCreates`, `searchAndCreates`, `flags`, `throttle`);
 * AuthenticationSchema `type` in (`basic`, `custom`, `digest`, `oauth1`,
 * `oauth2`, `session`) with `test`, `fields`, `connectionLabel` and the
 * per-type config objects; AuthenticationOAuth2ConfigSchema
 * (`authorizeUrl`, `getAccessToken`, `refreshAccessToken`, `codeParam`,
 * `scope`, `autoRefresh`, `enablePkce`); FunctionSchema encodings
 * (`'$func$0$f$'`, `{source, args}`, `{require}`); RequestSchema
 * (`method`, `url`, `body`, `params`, `headers`, `auth`, …) and
 * RedirectRequestSchema; TriggerSchema/SearchSchema/CreateSchema/
 * BulkReadSchema/SearchOrCreateSchema/ResourceSchema shapes; the operation
 * schemas (`perform`, `performList`, `performSubscribe`,
 * `performUnsubscribe`, `performGet`, `performResume`, `performBuffer`,
 * `inputFields`, `outputFields`, `sample`, `type`, `canPaginate`);
 * PlainInputFieldSchema keys and its `type` enum; KeySchema pattern
 * `^[a-zA-Z]+[a-zA-Z0-9_]*$`; VersionSchema pattern.
 *
 * Unverified: nothing in this file. Where the schema does not state something
 * — an app-level identifier, or the key the platform generates for a
 * resource's list/search/create method — this reader says so in a diagnostic
 * rather than inventing a spelling.
 */

export const ZAPIER_ECOSYSTEM = "zapier" as const;

export const ZAPIER_IMPORTER = Object.freeze({
  id: "connectors.formats.zapier",
  version: "1.0.0",
});

/** Profile identifiers used in capability rows and evidence. */
export const ZAPIER_PROFILES = Object.freeze({
  /** An exported app definition as JSON (the preferred input). */
  json: "zapier-app-definition/19",
  /** A bounded static extraction from CLI source text. */
  source: "zapier-app-source-static/1",
  /** The export profile this module writes. */
  export: "zapier-static-app/1",
});

export const ZAPIER_SCHEMA_VERSION = "19.1.0";
export const ZAPIER_SOURCES = Object.freeze({
  overview: "https://docs.zapier.com/integrations/build-cli/overview",
  schema:
    "https://github.com/zapier/zapier-platform/blob/main/packages/schema/docs/build/schema.md",
  retrievedAt: "2026-09-18",
});

export const ZAPIER_MEDIA_TYPE = "application/json";

export const ZAPIER_LIMITS = Object.freeze({
  actions: 512,
  fields: 256,
  fieldDepth: 6,
  configuration: 48,
  scopes: 64,
  servers: 32,
  issues: 4096,
});

/** `KeySchema`: `^[a-zA-Z]+[a-zA-Z0-9_]*$`. */
export const ZAPIER_KEY = /^[a-zA-Z]+[a-zA-Z0-9_]*$/;

/** `VersionSchema`: a simplified semver with an optional label. */
export const ZAPIER_VERSION =
  /^(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})(?:-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)?$/;

/** `FunctionSchema` pointer spelling: `$func$<arity>$<t|f>$`. */
export const ZAPIER_FUNC_MARKER = /^\$func\$\d{1,3}\$[tf]\$$/;

/**
 * The placeholder this module writes where a function was present in the
 * source. It is the vendor's own encoding for "a function lives here"; it
 * asserts nothing about what the function did, and the export reports the
 * omission as a loss.
 */
export const ZAPIER_FUNC_PLACEHOLDER = "$func$0$f$";

/** Zapier's `{{curly}}` interpolation; a string containing one is not a literal. */
export const ZAPIER_CURLIES = /\{\{[\s\S]*?\}\}/;
