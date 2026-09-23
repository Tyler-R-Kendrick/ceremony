/*
 * Pinned facts about the Workato connector SDK, and the definition of the
 * static profile this repository reads and writes.
 *
 * Retrieved 2026-09-18 from https://docs.workato.com/developing-connectors/sdk.html
 * and the SDK reference pages it links to (read as the site's own Markdown):
 *   /en/developing-connectors/sdk/sdk-reference.md
 *   /en/developing-connectors/sdk/sdk-reference/connection.md
 *   /en/developing-connectors/sdk/sdk-reference/connection/authorization.md
 *   /en/developing-connectors/sdk/sdk-reference/actions.md
 *   /en/developing-connectors/sdk/sdk-reference/triggers.md
 *   /en/developing-connectors/sdk/sdk-reference/object_definitions.md
 *   /en/developing-connectors/sdk/sdk-reference/methods.md
 *   /en/developing-connectors/sdk/sdk-reference/test.md
 *   /en/developing-connectors/sdk/sdk-reference/schema.md
 *   /en/developing-connectors/sdk/guides/authentication/{api-key,basic-authentication,multi_auth}.md
 *   /en/developing-connectors/sdk/guides/authentication/oauth/{auth-code,auth-code-pkce,client-credentials}.md
 *
 * Verified there and used here: the connector is a Ruby hash with root keys
 * `title`, `connection`, `test`, `custom_action`, `custom_action_help`,
 * `actions`, `triggers`, `object_definitions`, `pick_lists`, `methods`,
 * `secure_tunnel`, `webhook_keys`, `streams`; `connection` holds `fields`,
 * `extended_fields`, `authorization`, `base_uri`; `authorization.type` is one
 * of `basic_auth`, `api_key`, `oauth2` (authorization code grant only),
 * `custom_auth`, `multi`, with `client_id`, `client_secret`,
 * `authorization_url`, `token_url`, `acquire`, `apply`, `refresh_on`,
 * `detect_on`, `refresh`, `identity`, `pkce`, `selected`, `options`,
 * `noopener`; that the client-credentials grant is written as `custom_auth`
 * with an `acquire` lambda; that `pkce` returns `verifier`, `challenge` and
 * `challenge_method`; the action keys `title`, `subtitle`, `description`,
 * `help`, `config_fields`, `input_fields`, `execute`, `output_fields`,
 * `sample_output`, `retry_on_response`, `summarize_input`,
 * `summarize_output`; the trigger keys including `poll`, `dedup`,
 * `webhook_key`, `webhook_subscribe`, `webhook_unsubscribe`,
 * `webhook_notification`, `webhook_payload_type`; `object_definitions.<name>.fields`
 * as a lambda; and the Workato schema attributes (`name`, `label`,
 * `optional`, `type`, `of`, `properties`, `control_type`, `hint`, `default`,
 * `pick_list`, `sticky`, `ngIf`, …) with `type` in string/integer/number/
 * date_time/date/timestamp/boolean/object/array.
 *
 * Unverified: nothing about Workato. The `workato-static-profile/1` format
 * below is this repository's own, defined here because Workato publishes no
 * non-Ruby serialization of a connector.
 */

export const WORKATO_ECOSYSTEM = "workato" as const;

export const WORKATO_IMPORTER = Object.freeze({
  id: "connectors.formats.workato",
  version: "1.0.0",
});

export const WORKATO_PROFILES = Object.freeze({
  /** This repository's JSON/YAML-shaped literal representation (the preferred input). */
  staticProfile: "workato-static-profile/1",
  /** A bounded literal extraction from Ruby connector source. */
  ruby: "workato-connector-ruby-static/1",
  /** The export profile this module writes (the static profile again). */
  export: "workato-static-profile/1",
});

export const WORKATO_SOURCES = Object.freeze({
  sdk: "https://docs.workato.com/developing-connectors/sdk.html",
  reference:
    "https://docs.workato.com/en/developing-connectors/sdk/sdk-reference.md",
  authorization:
    "https://docs.workato.com/en/developing-connectors/sdk/sdk-reference/connection/authorization.md",
  retrievedAt: "2026-09-18",
});

export const WORKATO_MEDIA_TYPE = "application/json";

/**
 * The marker a static profile uses where the Ruby connector had a lambda or a
 * block. It says "code was here and is not in this document"; it carries no
 * body, no arity and no behaviour, and nothing in this repository turns it
 * back into code.
 */
export const WORKATO_LAMBDA_MARKER = Object.freeze({ $lambda: true });

/** The documented authorization types; anything else is reported, not guessed. */
export const WORKATO_AUTH_TYPES = [
  "basic_auth",
  "api_key",
  "oauth2",
  "custom_auth",
  "multi",
] as const;
export type WorkatoAuthType = (typeof WORKATO_AUTH_TYPES)[number];

export const WORKATO_LIMITS = Object.freeze({
  actions: 512,
  fields: 256,
  fieldDepth: 8,
  configuration: 48,
  objectDefinitions: 256,
  servers: 32,
  issues: 4096,
});

/**
 * The `workato-static-profile/1` document, for the ledger and for anyone
 * writing one by hand. Every value is a literal; every lambda is the marker.
 *
 * ```json
 * {
 *   "profile": "workato-static-profile/1",
 *   "title": "Acme",
 *   "connection": {
 *     "fields": [{ "name": "api_key", "control_type": "password", "optional": false }],
 *     "authorization": {
 *       "type": "api_key",
 *       "apply": { "placement": "header", "parameter": "X-Api-Key" }
 *     },
 *     "base_uri": "https://api.acme.example"
 *   },
 *   "test": { "$lambda": true },
 *   "actions": {
 *     "create_invoice": {
 *       "title": "Create invoice",
 *       "input_fields": [{ "name": "amount", "type": "integer", "optional": false }],
 *       "output_fields": [{ "name": "id" }],
 *       "execute": { "$lambda": true }
 *     }
 *   },
 *   "triggers": {},
 *   "object_definitions": { "invoice": { "fields": [{ "name": "id" }] } }
 * }
 * ```
 *
 * `authorization.apply` is the one place the profile carries something the
 * Ruby source states only in code. It is optional: without it an `api_key`
 * connector is imported with its fields and its actions, and its
 * authentication is reported unsupported rather than guessed.
 * `authorization.oauth2` may carry `{ "grant": "client_credentials",
 * "token_url": "https://…" }` for the client-credentials flow, which the
 * vendor writes as `custom_auth` with an `acquire` lambda.
 */
export const WORKATO_STATIC_PROFILE_DOC = WORKATO_PROFILES.staticProfile;
