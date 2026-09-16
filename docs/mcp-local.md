# Driving local ceremonies from a chat client

The MCP endpoint runs against the reference application, so you can point a chat client at your own machine and drive real ceremonies through it.

Two things force the setup below. A chat client reaches your server over the public internet, so the origin has to be reachable. And the in-chat credential collector refuses to mount on anything but HTTPS — deliberately, because it exists to carry credentials — so the origin has to be HTTPS too. A tunnel gives you both.

## What you need

The reference application has no identity provider of its own: the browser uses an anonymous cookie session, which a bearer token cannot be minted from. `examples/issuer.ts` is a development issuer that fills that gap — discovery, a JWKS, dynamic client registration, an authorization code flow with PKCE, and RFC 9068 JWT access tokens.

**It approves whoever clicks the button.** There is no account behind it, no password, and nothing to steal, because there is nothing there. It exists so a chat client has a token to present. Never point anything real at it.

## Running it

Start a tunnel to port 4173. [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) needs no account for a quick tunnel:

```sh
cloudflared tunnel --url http://127.0.0.1:4173
```

It prints an HTTPS URL. Start the application with that URL as its public origin:

```sh
CEREMONY_MCP=true CEREMONY_ORIGIN=https://your-tunnel.trycloudflare.com npm run dev
```

`CEREMONY_ORIGIN` has to match the tunnel exactly. The server refuses a request whose `Host` header is not its own origin, which is what stops a tunnel from being pointed at a server that was not expecting one.

Then add `https://your-tunnel.trycloudflare.com/mcp` as a connector in your chat client. It will discover the issuer, register itself, and send you through a one-click sign-in.

## What the client gets

| Tool                  | What it does                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `ceremony_connectors` | Which services this deployment can connect, and whether credential entry is available in chat |
| `ceremony_connect`    | Start connecting a service and run every step that does not need a person                     |
| `ceremony_snapshot`   | Read a run — use it after a person has been asked to do something                             |
| `ceremony_advance`    | Advance one step, at the revision you last read                                               |
| `ceremony_cancel`     | Cancel a run; this does not revoke access an earlier ceremony already granted                 |

`ceremony_connectors` reports `privateCollection`, which tells a client where credential entry happens: `in-chat` when the collector is mounted, `web-application-only` when it is not. That is not cosmetic — a client that assumes the wrong one will either ask for a credential where it cannot be collected, or offer to collect one in a place that is not carrying it.

## What is not wired yet

The in-chat collector is **not mounted by the reference application**, even behind a tunnel, so `privateCollection` reports `web-application-only` and credential entry stays in the browser. Mounting it needs the MCP App resource bundled as HTML, which has no build step yet. The gate itself is real and tested in both directions; what is missing is the bundle it would serve.

Generation and discovery are not exposed over MCP either. `/api/config` reports `generationAvailable: false` on the hosted server, and `discoverCeremony` is not yet connected to an endpoint or a tool.

## A tunnel is a public address

While it runs, anyone with the URL can reach your development server, and the development issuer will hand a token to anyone who asks. Quick tunnels get a fresh random hostname each run and stop when you stop `cloudflared`; treat the URL as a secret while it is up, and do not leave one running unattended.
