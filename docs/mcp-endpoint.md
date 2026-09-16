# Driving ceremonies from a chat client

Until now an agent could drive a ceremony only through the browser application's HTTP API. The MCP endpoint gives a chat client the same four operations, against the same runtime, under the same authorization.

## One implementation, two transports

`src/server/agent-tools.ts` holds what an agent may do to a run: `connect`, `snapshot`, `advance`, `cancel`. The HTTP route and the MCP server both call it.

That sharing is the point rather than a tidiness preference. The rule these operations exist to enforce — a run may be driven only by the session that created it — is one comparison in one place. Two copies of an authorization rule is not duplication, it is a hole waiting for one copy to be updated.

## What authenticates a chat client

The browser is authenticated by a cookie over an OIDC code flow. A chat client is authenticated by an access token, validated against the issuer's published keys and required to name this MCP endpoint as its audience. Both end at the same `ActorContext`, so capabilities, ownership and delegation are enforced once.

The audience check is what separates a token minted for this deployment from any other token the same person holds from the same issuer. Without it, every token that issuer ever signed would drive these ceremonies.

`/.well-known/oauth-protected-resource/mcp` publishes only what [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728) asks of a resource server: which authorization server issues its tokens. The client reads the authorization server's own metadata from the issuer, so nothing here restates it and nothing can drift out of date with it. A request with no token, or one the host refuses, is answered `401` with `WWW-Authenticate: Bearer resource_metadata="…"`, which is how a client discovers where to go.

## Why the endpoint sits outside the browser boundary

Every request to the browser application passes `assertRequestBoundary`, which requires an `Origin` header equal to the application's own. That is a CSRF defence, and it is a defence specifically for requests authenticated by an ambient cookie — the browser attaches those whether or not the page meant to.

A chat client is not a browser. It sends no `Origin`, and it carries a bearer token that a hostile page has no way to cause to be attached. Applying the check would reject every MCP request while defending against nothing, so the MCP handler is mounted ahead of it. It authenticates every request itself and answers only its own two paths, returning `undefined` for everything else.

## A session, and why it is not the token

A run may be driven only from the session that created it. So the session cannot be the token's own identifier: refreshing an access token in the middle of a ceremony would orphan the run the previous token started, and the person would be told their own run belongs to someone else.

Subject plus client id is stable across refresh, and still separates two chat clients held by the same person. Reading and driving are deliberately different permissions: the same person in a second session can read a run and cannot drive it.

## Credentials still never cross MCP

The tools carry run state. They do not carry credentials, and there is no tool that accepts one.

When a ceremony needs a value from a person, the MCP App collector renders in the chat client and posts the value **directly to the credential broker over HTTPS**. The assistant receives a one-use reference; the value is never in a tool argument, a tool result, or the conversation. `ceremony_bind_private` binds that reference and, by its own description, never accepts a raw credential.

That collector requires stable HTTPS origins for both the broker and the app. On a plain-HTTP development origin it is **not registered at all**, rather than registered in some weaker form — `ceremony_connectors` reports `privateCollection: "web-application-only"` so a client can tell the difference, and credential entry stays in the authenticated web application. A test asserts the collector stays unmounted on an HTTP origin.

## Configuration

The endpoint is built from the same protected environment as the web application, so a deployment cannot offer chat access under a different issuer or tenant than the application beside it. It needs `CEREMONY_PUBLIC_ORIGIN`, `CEREMONY_OIDC_ISSUER` and `CEREMONY_TENANT_ID`, all of which the hosted server already requires.

Absent or invalid configuration produces no handler rather than an open one: the route answers `503` and no ceremony is reachable over MCP at all.

## What this does not do

It does not register an OAuth client for you, and it is not an authorization server. It validates tokens; it does not issue them. Dynamic client registration, consent, and token issuance belong to the configured issuer.

It does not certify any provider. Driving a real provider from chat still runs the same ceremonies with the same evidence requirements as the browser, and the same human steps still cost a person's attention.
