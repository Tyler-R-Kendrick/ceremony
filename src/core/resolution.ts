import { z } from "zod";
import {
  manifestSchema,
  type AuthMethod,
  type ConnectorManifest,
} from "./schema.js";

/**
 * What a host declares it needs, and how that resolves to one route.
 *
 * A person cannot answer "PKCE or device code?", because the question is about
 * a protocol and they are trying to connect a service. The things they can
 * answer — whose account this is, what the integration will be able to do, how
 * much of their attention it costs — are the things a host knows in advance.
 * So the host declares them once, and the route is resolved rather than asked.
 *
 * The same declaration reaches the component, the server controller and the
 * agent tools, because all three already funnel through this context. None of
 * it is authorization or evidence of stored credentials: it is a statement of
 * intent, and the server still decides what it will actually do.
 */

/**
 * One thing the integration must be able to do, and what that costs in scopes.
 *
 * Both halves come from the host because only the host knows both: it knows
 * that "open pull requests for you" is why it wants the connection, and it
 * knows that means `repo`. Connector manifests deliberately carry no such
 * vocabulary — a registry of capability names would be one more thing for
 * connector authors to keep true, and it would be wrong the moment a provider
 * renamed a scope. The label is what a person reads; the scopes are what
 * filters.
 */
export const permissionSchema = z.strictObject({
  label: z.string().min(1).max(80),
  scopes: z.array(z.string().min(1).max(100)).max(10).default([]),
});
export type Permission = z.input<typeof permissionSchema>;

/** Caller hints are not authorization or evidence of stored credentials. */
export const entryContextSchema = z
  .object({
    surface: z.enum(["browser", "headless"]).default("browser"),
    requiredScopes: z.array(z.string().min(1).max(100)).max(30).default([]),
    /** What the integration must be able to do, in the host's own words. */
    permissions: z.array(permissionSchema).max(20).default([]),
    /**
     * Whose access this is. "personal" needs someone to own the result;
     * "anonymous" must complete without anyone. "either" leaves it open, which
     * is the default because most hosts have no opinion and saying nothing
     * should not narrow anything.
     */
    identity: z.enum(["personal", "anonymous", "either"]).default("either"),
    /** How often the host will accept a person being interrupted. */
    interruptions: z.enum(["any", "at-most-one", "none"]).default("any"),
    /**
     * Contract configuration the host already holds — an app id, a client
     * secret. Presence does not authorize anything; it says a route will not
     * have to stop and ask for it, which is what makes that route cheaper.
     */
    heldConfiguration: z
      .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/))
      .max(24)
      .default([]),
  })
  .strict();
export type EntryContext = z.input<typeof entryContextSchema>;
export type MethodAvailability = "available" | "configured" | "unavailable";

/**
 * What a route asks of a person, named by what happens to them.
 *
 * This is the vocabulary the interface is allowed to use. It is derived from
 * the connector's own contract wherever the contract states it — the handoff
 * surface and the completion ownership are the connector saying what happens —
 * and from the flow kind only where the contract has nothing to say, which is
 * the case for a second device and for a manifest carrying no contract at all.
 */
export const connectionRoutes = [
  "provider-approval",
  "second-device",
  "supplied-credential",
  "no-account",
] as const;
export const connectionRouteSchema = z.enum(connectionRoutes);
export type ConnectionRoute = z.infer<typeof connectionRouteSchema>;

/** A route completing with nobody's name on it interrupts nobody. */
export function startsWithoutAPerson(method: AuthMethod): boolean {
  return method.contract
    ? method.contract.completion.ownership.includes("anonymous")
    : method.kind === "authmd-anonymous";
}

/** Handoff points the contract declares: its own, plus one per prerequisite. */
export function declaredHandoffs(method: AuthMethod): number {
  return method.contract ? 1 + method.contract.prerequisites.length : 1;
}

/**
 * Handoffs a person actually experiences.
 *
 * The one number that both decides the route and appears on the card, so the
 * interface cannot advertise a cost the resolver did not pay attention to.
 */
export function humanHandoffs(method: AuthMethod): number {
  return startsWithoutAPerson(method) ? 0 : declaredHandoffs(method);
}

export function routeFor(method: AuthMethod): ConnectionRoute {
  // No contract field distinguishes a second device, and every kind of flow
  // could in principle use one, so the kind is the only source for it.
  if (method.kind === "device") return "second-device";
  if (method.contract)
    return startsWithoutAPerson(method)
      ? "no-account"
      : method.contract.handoff.surface === "private-collector"
        ? "supplied-credential"
        : "provider-approval";
  if (method.kind === "authmd-anonymous") return "no-account";
  return ["api-key", "basic", "form"].includes(method.kind)
    ? "supplied-credential"
    : "provider-approval";
}

const interruptionBudget = {
  any: Number.POSITIVE_INFINITY,
  "at-most-one": 1,
  none: 0,
} as const;

export const methodSelectionSchema = z.strictObject({
  selectedMethodId: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/)
    .nullable(),
  candidates: z
    .array(
      z.strictObject({
        methodId: z.string().regex(/^[a-z0-9-]{1,64}$/),
        availability: z.enum(["available", "configured", "unavailable"]),
        reason: z.enum([
          "eligible",
          "unavailable",
          "unsupported-surface",
          "insufficient-scopes",
          "wrong-identity",
          "too-many-interruptions",
        ]),
      }),
    )
    .min(1)
    .max(12),
});
export type MethodSelection = z.infer<typeof methodSelectionSchema>;

/**
 * Every scope the declaration implies, whether named directly or reached
 * through a permission. Exported because anything that pre-filters methods has
 * to agree with what the resolver will do, or it narrows on one set of scopes
 * and resolves against another.
 */
export function scopesRequired(context: EntryContext = {}): string[] {
  const parsed = entryContextSchema.parse(context);
  return [
    ...new Set([
      ...parsed.requiredScopes,
      ...parsed.permissions.flatMap((permission) => permission.scopes),
    ]),
  ];
}

/** Deterministic policy shared by clients and trusted server-side entry points. */
export function explainCeremonySelection(
  manifest: ConnectorManifest,
  context: EntryContext = {},
  availability: (method: AuthMethod) => MethodAvailability = () => "available",
): MethodSelection {
  // Validate without replacing method identity: existing host callbacks may key by object.
  manifestSchema.parse(manifest);
  const intent = entryContextSchema.parse(context);
  const { surface, identity } = intent;
  const requiredScopes = scopesRequired(intent);
  const budget = interruptionBudget[intent.interruptions];
  const held = new Set(intent.heldConfiguration);
  const order =
    surface === "browser"
      ? [
          "oauth-code",
          "github-app",
          "device",
          "authmd-anonymous",
          "api-key",
          "form",
          "basic",
        ]
      : [
          "device",
          "oauth-code",
          "github-app",
          "authmd-anonymous",
          "api-key",
          "form",
          "basic",
        ];
  const candidates = manifest.methods.map((method, index) => {
    const state = z
      .enum(["available", "configured", "unavailable"])
      .parse(availability(method));
    const anonymous = startsWithoutAPerson(method);
    const handoffs = humanHandoffs(method);
    const reason =
      state === "unavailable"
        ? "unavailable"
        : method.contract && !method.contract.surfaces.includes(surface)
          ? "unsupported-surface"
          : !requiredScopes.every((scope) => method.scopes.includes(scope))
            ? "insufficient-scopes"
            : (identity === "personal" && anonymous) ||
                (identity === "anonymous" && !anonymous)
              ? "wrong-identity"
              : handoffs > budget
                ? "too-many-interruptions"
                : "eligible";
    // Configuration the host already holds costs no extra stop, so a route
    // whose requirements are met ranks above an equivalent one that must ask.
    const asking = method.contract?.configuration.some(
      (item) => item.required && item.source === "host" && !held.has(item.name),
    );
    return {
      methodId: method.id,
      availability: state,
      reason,
      score: state === "configured" ? -100 : 0,
      asking: asking ? 1 : 0,
      handoffs,
      rank: order.indexOf(method.kind),
      index,
    };
  });
  // The declaration filters and breaks ties; it does not reorder the surface
  // policy underneath. A host that wants the cheapest route asks for it with
  // `interruptions`, which is a filter — quietly preferring a device code over
  // a GitHub App install because it stops one fewer time would trade away
  // access the host may need for a saving it never asked for.
  const eligible = candidates
    .filter((item) => item.reason === "eligible")
    .sort(
      (a, b) =>
        a.score - b.score ||
        a.rank - b.rank ||
        a.asking - b.asking ||
        a.handoffs - b.handoffs ||
        a.index - b.index,
    );
  return methodSelectionSchema.parse({
    selectedMethodId: eligible[0]?.methodId ?? null,
    candidates: candidates.map(({ methodId, availability, reason }) => ({
      methodId,
      availability,
      reason,
    })),
  });
}

export function resolveCeremonyMethod(
  manifest: ConnectorManifest,
  context: EntryContext = {},
  availability: (method: AuthMethod) => MethodAvailability = () => "available",
): AuthMethod {
  const selection = explainCeremonySelection(manifest, context, availability);
  const method = manifest.methods.find(
    (item) => item.id === selection.selectedMethodId,
  );
  if (!method)
    throw new Error(
      "No available authentication method satisfies this connection request.",
    );
  return method;
}

export interface ResolvedConnection {
  method: AuthMethod;
  route: ConnectionRoute;
  /** Interruptions a person will experience on this route. */
  handoffs: number;
  /** One sentence for the person: what happens, never how it is implemented. */
  summary: string;
  /** What the integration will be able to do, as the host worded it. */
  permissions: readonly string[];
  /** Host configuration this route will otherwise stop and ask for. */
  missingConfiguration: readonly string[];
  /** Everything ruled out and why — for the developer and the agent. */
  rejected: readonly {
    methodId: string;
    reason: MethodSelection["candidates"][number]["reason"];
  }[];
}

function describe(route: ConnectionRoute, service: string): string {
  if (route === "second-device")
    return `${service} will give you a code to enter on another device.`;
  if (route === "supplied-credential")
    return `${service} needs a credential you already hold. It goes straight to the credential broker, never through the assistant.`;
  if (route === "no-account")
    return `This starts straight away. No ${service} account is needed, and you can claim it later.`;
  return `${service} will ask you to approve this once, then bring you back.`;
}

/**
 * The whole resolution, in the terms an interface and an agent can both use.
 *
 * `resolveCeremonyMethod` answers "which method"; this answers "what is about
 * to happen to this person, and why this route rather than another" — which is
 * what a card has to render and what an assistant has to be able to say.
 */
export function resolveConnection(
  manifest: ConnectorManifest,
  context: EntryContext = {},
  availability: (method: AuthMethod) => MethodAvailability = () => "available",
): ResolvedConnection {
  const intent = entryContextSchema.parse(context);
  const selection = explainCeremonySelection(manifest, context, availability);
  const method = manifest.methods.find(
    (item) => item.id === selection.selectedMethodId,
  );
  if (!method)
    throw new Error(
      "No available authentication method satisfies this connection request.",
    );
  const held = new Set(intent.heldConfiguration);
  const route = routeFor(method);
  return {
    method,
    route,
    handoffs: humanHandoffs(method),
    summary: describe(route, manifest.name),
    permissions: intent.permissions.map((permission) => permission.label),
    missingConfiguration: (method.contract?.configuration ?? [])
      .filter(
        (item) =>
          item.required && item.source === "host" && !held.has(item.name),
      )
      .map((item) => item.name),
    rejected: selection.candidates
      .filter((candidate) => candidate.reason !== "eligible")
      .map(({ methodId, reason }) => ({ methodId, reason })),
  };
}
