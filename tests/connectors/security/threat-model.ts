/*
 * SEC-01. The trust-boundary threat model for connector interoperability,
 * written as data so the negative tests can be enumerated from it and a
 * boundary cannot be quietly dropped.
 *
 * Every boundary names the two sides, the authority that must not cross it,
 * the concrete confused-deputy or cross-tenant path an attacker would take,
 * and the test file that carries the executable refusal. `implemented` says
 * whether the module that owns the boundary existed and was stable when the
 * security swarm tested it; an unimplemented boundary carries no passing
 * evidence and must not be read as covered.
 */

export type TrustBoundary = {
  id: string;
  /** Who is speaking, and who is being asked to act. */
  from: string;
  to: string;
  /** What the "from" side must never be able to acquire by speaking. */
  authorityWithheld: string;
  /** The concrete attack: how a confused deputy or a cross-tenant read would happen. */
  attack: string;
  /** Kind of boundary failure this models. */
  kind: "confused-deputy" | "cross-tenant" | "both";
  /** Modules that enforce it. */
  modules: readonly string[];
  /** Name of the executable negative test that proves the refusal. */
  negativeTest: string;
  implemented: boolean;
};

export const trustBoundaries: readonly TrustBoundary[] = Object.freeze([
  {
    id: "TB-01",
    from: "imported data (OpenAPI/Arazzo/server.json/overlay bytes)",
    to: "the Ceremony importer and its object graph",
    authorityWithheld:
      "the ability to reach the runtime: to mutate a prototype, to name an executable endpoint, or to make the reader choose a different parser",
    attack:
      "a description carries `__proto__`, a duplicate member that two readers resolve differently, a YAML merge key or a language-specific tag, and the importer builds an object whose shape decides a later authorization check",
    kind: "confused-deputy",
    modules: [
      "src/server/connectors/import/parse.ts",
      "src/core/connectors/json-bounds.ts",
    ],
    negativeTest: "TB-01 imported bytes cannot reach the runtime object graph",
    implemented: true,
  },
  {
    id: "TB-02",
    from: "the hosted browser / PWA surface",
    to: "the Ceremony host's connector commands",
    authorityWithheld:
      "choosing the owner, the tenant, the destination, the shared-grant mode or the completion of a handoff",
    attack:
      "a page (or an attacker page opened in the same session) posts a completion message from its own origin with a guessed correlation, or a drawer control asserts shared-key mode, and the host treats the browser's word as the authority",
    kind: "confused-deputy",
    modules: [
      "src/server/connectors/auth/handoff.ts",
      "src/core/connectors/projections.ts",
    ],
    negativeTest: "TB-02 a browser message is never authority",
    implemented: true,
  },
  {
    id: "TB-03",
    from: "the private collector (MCP Apps protected collection)",
    to: "the Ceremony host and everything downstream of it",
    authorityWithheld:
      "putting collected private material where a model, a recipe export or a catalog can read it",
    attack:
      "the collector reference, the widget token or the PKCE verifier is copied into the summary a tool sees, so a model can replay the handoff",
    kind: "confused-deputy",
    modules: ["src/server/connectors/auth/handoff.ts"],
    negativeTest: "TB-03 private handoff material never reaches a presentation",
    implemented: true,
  },
  {
    id: "TB-04",
    from: "the Ceremony host acting on a caller's behalf",
    to: "an upstream provider or any URL a document names",
    authorityWithheld:
      "reaching the deployment's own network, the cloud metadata service, or any origin the host did not approve; and carrying host credentials there",
    attack:
      "an imported document names `http://169.254.169.254/`, or a hostname that resolves to it, or redirects to it after one public hop, and the host's own credentials travel with the request",
    kind: "confused-deputy",
    modules: [
      "src/server/connectors/import/network.ts",
      "src/server/public-auth-fetch.ts",
    ],
    negativeTest: "TB-04 the host is not a deputy for a document's network",
    implemented: true,
  },
  {
    id: "TB-05",
    from: "an external broker (Nango, and the broker-shaped adapters)",
    to: "the Ceremony host's connection lifecycle",
    authorityWithheld:
      "rebinding a connection, asserting an account, or being believed without the documented signature",
    attack:
      "an attacker replays a broker webhook body with the legacy plain-digest header, or with the right body and no HMAC, and the host moves a connection to active",
    kind: "both",
    modules: ["src/server/connectors/providers/nango/webhooks.ts"],
    negativeTest: "TB-05 an unsigned broker event is not a lifecycle change",
    implemented: true,
  },
  {
    id: "TB-06",
    from: "a registry listing (official MCP registry or a subregistry)",
    to: "the Ceremony host's import and publication surfaces",
    authorityWithheld:
      "causing an install, a process, an image pull, or a publication of anything the host did not mark public",
    attack:
      "a listing names `npx -y evil@latest` with an environment variable holding a token, and the importer either runs it or republishes it; or a private-network URL hidden outside `remotes[]` is republished by the public subregistry",
    kind: "both",
    modules: [
      "src/server/connectors/registries/mcp/import.ts",
      "src/server/connectors/registries/mcp/projections.ts",
    ],
    negativeTest: "TB-06 a registry listing is inert and not publishable by default",
    implemented: true,
  },
  {
    id: "TB-07",
    from: "an event sender (webhook producer, forwarded provider trigger)",
    to: "the Ceremony host's state machine",
    authorityWithheld:
      "replaying a delivery, back-dating one, or having one tenant's delivery counted for another",
    attack:
      "a delivery is replayed with a stale timestamp, or a signature scheme the host does not support is offered so the host falls back to accepting it",
    kind: "both",
    modules: ["src/server/connectors/events/standard-webhooks.ts"],
    negativeTest: "TB-07 an event sender cannot replay or downgrade",
    implemented: true,
  },
  {
    id: "TB-08",
    from: "an optional local runner (Docker MCP toolkit and similar)",
    to: "the Ceremony deployment",
    authorityWithheld:
      "becoming a prerequisite, or turning an imported descriptor into a process",
    attack:
      "a catalog import is treated as an execution capability, so a hosted deployment silently attempts an install or reports a runtime it does not have",
    kind: "confused-deputy",
    modules: ["src/server/connectors/registries/docker/runner.ts"],
    negativeTest: "TB-08 an absent runner refuses rather than installs",
    implemented: true,
  },
  {
    id: "TB-09",
    from: "one host tenant",
    to: "another host tenant's connections, caches and evidence",
    authorityWithheld:
      "reading or completing anything keyed by another tenant, owner, connection or generation",
    attack:
      "two tenants use the same issuer and the same provider account display name; a cached metadata document, a result cache entry or a pending handoff is served across the boundary because the key collapses them",
    kind: "cross-tenant",
    modules: [
      "src/server/connectors/auth/discovery.ts",
      "src/server/connectors/mcp/cache.ts",
      "src/server/connectors/auth/handoff.ts",
    ],
    negativeTest: "TB-09 tenancy is part of every key and every fence",
    implemented: true,
  },
]);
