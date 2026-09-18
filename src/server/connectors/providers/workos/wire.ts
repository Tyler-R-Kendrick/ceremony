import { z } from "zod";

/*
 * The WorkOS Pipes wire contract, as documented at
 * https://workos.com/docs/reference/pipes (access-token, connected-account,
 * provider pages) and https://workos.com/docs/pipes/relay, retrieved
 * 2026-09-18. Response schemas are deliberately non-strict: WorkOS states
 * that new fields and error values may appear and must be handled
 * gracefully, so unknown members are ignored rather than rejected. Anything
 * the adapter *sends* is built from these constants and host-approved
 * settings, never from caller input.
 */

export const WORKOS_API_ORIGIN = "https://api.workos.com";
export const WORKOS_DESTINATION_ID = "api";
export const WORKOS_ADAPTER_ID = "workos-pipes";
export const WORKOS_ADAPTER_VERSION = "2026.09.18";
/** Return route the host mounts; the adapter builds it from the deployment origin. */
export const WORKOS_DEFAULT_RETURN_PATH = "/api/v1/connectors/workos/return";
export const WORKOS_RETURN_CORRELATION_PARAMETER = "correlation";

/** Broker action the credential-mode operation names in its binding. */
export const WORKOS_CREDENTIALS_ACTION = "workos.pipes.credentials";

/** Authentication profile ids of the two custody modes; a binding names exactly one. */
export const workOsPipesProfiles = Object.freeze({
  credentials: "workos-pipes-credentials",
  relay: "workos-pipes-relay",
});

const slugSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);

const exactHttpsOrigin = z.string().refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.origin === value && url.protocol === "https:";
}, "Must be an exact HTTPS origin");

/**
 * Host-approved binding settings. `mode` decides whether the binding vends
 * credentials into host custody or relays requests through WorkOS; the
 * adapter checks it against the binding's custody and refuses a mismatch
 * rather than falling back from one mode to the other.
 */
export const workOsSettingsSchema = z.strictObject({
  provider: slugSchema,
  mode: z.enum(["credentials", "relay"]),
  /** Which documented endpoint vends the credential in credentials mode. */
  credentialEndpoint: z.enum(["token", "credentials"]).default("token"),
  /** Opts into the documented plural connection contract. */
  multipleConnections: z.boolean().default(false),
  /** Lease for a vended credential when WorkOS reports no expiry; re-vending is the refresh path. */
  credentialLeaseSeconds: z.number().int().min(60).max(3600).default(900),
  /** How long a broker "connected" observation counts as verification. */
  verificationTtlSeconds: z.number().int().min(60).max(86400).default(3600),
  relay: z
    .strictObject({
      routing: z.enum(["path", "url"]).default("path"),
      /** Exact upstream origin for URL routing; host-approved, never input. */
      upstreamOrigin: exactHttpsOrigin.optional(),
      /** Header carrying a host-supplied idempotency key when the operation's replay policy allows it. */
      idempotencyHeader: z
        .string()
        .regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/)
        .optional(),
      maxResponseBytes: z
        .number()
        .int()
        .min(1024)
        .max(5 * 1024 * 1024)
        .default(1024 * 1024),
    })
    .optional(),
});
export type WorkOsSettings = z.infer<typeof workOsSettingsSchema>;

const isoTime = z.string().refine((value) => !Number.isNaN(Date.parse(value)));
const stringList = z.array(z.string().max(500)).max(256);

/** POST /data-integrations/{slug}/token, `active: true`. */
export const workOsAccessTokenSchema = z.object({
  access_token: z.string().min(1),
  expires_at: isoTime.nullable().optional(),
  scopes: stringList.nullable().optional(),
  missing_scopes: stringList.nullable().optional(),
});

/** POST /data-integrations/{slug}/credentials, `active: true`. */
export const workOsCredentialSchema = z.object({
  auth_method: z.string().max(64).optional(),
  value: z.string().min(1),
  expires_at: isoTime.nullable().optional(),
  scopes: stringList.nullable().optional(),
  missing_scopes: stringList.nullable().optional(),
});

/** Documented inactive reasons; unknown values are preserved as text and treated as inactive. */
export const workOsInactiveReasons = [
  "not_installed",
  "needs_reauthorization",
  "account_selection_required",
] as const;

export const workOsVendResponseSchema = z.union([
  z.object({ active: z.literal(true), access_token: workOsAccessTokenSchema }),
  z.object({ active: z.literal(true), credential: workOsCredentialSchema }),
  z.object({ active: z.literal(false), error: z.string().max(120).optional() }),
]);
export type WorkOsVendResponse = z.infer<typeof workOsVendResponseSchema>;

/** The connected account object; `state` is "connected" or "needs_reauthorization" today. */
export const workOsConnectedAccountSchema = z.object({
  id: z.string().min(1).max(200),
  user_id: z.string().max(200).nullable().optional(),
  organization_id: z.string().max(200).nullable().optional(),
  connection_role: z.string().max(64).nullable().optional(),
  account_identifier: z.string().max(500).nullable().optional(),
  account_display_name: z.string().max(500).nullable().optional(),
  scopes: stringList.nullable().optional(),
  auth_method: z.string().max(64).nullable().optional(),
  state: z.string().max(64),
});
export type WorkOsConnectedAccount = z.infer<typeof workOsConnectedAccountSchema>;

/** POST /data-integrations/{slug}/authorize. */
export const workOsAuthorizeResponseSchema = z.object({
  url: z.string().min(1).max(4096),
});

/** GET /user_management/users/{user_id}/data_providers. */
export const workOsDataProviderSchema = z.object({
  id: z.string().max(200).optional(),
  name: z.string().max(200),
  description: z.string().max(2000).nullable().optional(),
  slug: slugSchema,
  integration_type: z.string().max(120).optional(),
  auth_methods: stringList.nullable().optional(),
  connection_owner: z.string().max(32).optional(),
  connected_account: workOsConnectedAccountSchema.nullable().optional(),
});
export const workOsDataProviderListSchema = z.object({
  data: z.array(workOsDataProviderSchema).max(500),
});

/** Relay-generated error bodies carry `code` and `message`; provider errors do not. */
export const workOsRelayErrorSchema = z.object({
  code: z.string().max(120).optional(),
  message: z.string().max(2000).optional(),
  connection: z.string().max(120).optional(),
  authorization_url: z.string().max(4096).nullable().optional(),
});

/** Input a caller may give a relay operation: template parameters, a query and a body. Nothing else. */
export const workOsRelayInputSchema = z
  .strictObject({
    parameters: z
      .record(
        z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/),
        z.string().min(1).max(512),
      )
      .optional(),
    query: z
      .record(z.string().min(1).max(120), z.string().max(2048))
      .refine((value) => Object.keys(value).length <= 64)
      .optional(),
    body: z.unknown().optional(),
  })
  .optional();
export type WorkOsRelayInput = z.infer<typeof workOsRelayInputSchema>;

/** Native connection status vocabulary preserved in results and evidence. */
export type WorkOsConnectionOwner = "user" | "organization";
