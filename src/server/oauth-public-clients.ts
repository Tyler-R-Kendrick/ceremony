/**
 * Public native OAuth clients keyed by authorization-server origin.
 * Use this for issuers that publish a native/device client and do not offer
 * RFC 7591 dynamic registration. Add issuers here; do not branch on connector
 * names in ceremony code.
 */
export const publicNativeClients: Record<
  string,
  { clientId: string; scopes?: string[] }
> = {
  "https://auth.x.ai": {
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    scopes: [
      "openid",
      "profile",
      "email",
      "offline_access",
      "grok-cli:access",
      "api:access",
    ],
  },
};
