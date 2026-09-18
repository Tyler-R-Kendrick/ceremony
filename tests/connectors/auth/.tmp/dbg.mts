import { startAuthorizationServer } from "../../doubles/authorization-server.js";
import * as oauth from "oauth4webapi";
import { requestOptions } from "../../../../src/server/connectors/auth/wire.js";

const server = await startAuthorizationServer({ redirectUris: ["https://app.example/cb"] });
const as = await oauth.processDiscoveryResponse(
  new URL(server.issuer),
  await oauth.discoveryRequest(new URL(server.issuer), { [oauth.allowInsecureRequests]: true, algorithm: "oauth2" }),
);
const client: oauth.Client = { client_id: server.clientId, token_endpoint_auth_method: "none" };
const verifier = oauth.generateRandomCodeVerifier();
const challenge = await oauth.calculatePKCECodeChallenge(verifier);
const state = oauth.generateRandomState();
const url = new URL(as.authorization_endpoint!);
url.searchParams.set("response_type", "code");
url.searchParams.set("client_id", client.client_id);
url.searchParams.set("redirect_uri", "https://app.example/cb");
url.searchParams.set("state", state);
url.searchParams.set("code_challenge", challenge);
url.searchParams.set("code_challenge_method", "S256");
const cb = await server.authorize(url.href);
const params = oauth.validateAuthResponse(as, client, new URL(cb), state);
try {
  const res = await oauth.authorizationCodeGrantRequest(
    as, client, oauth.None(), params, "https://app.example/cb", verifier,
    requestOptions({ fetch: globalThis.fetch, allowLoopbackHttp: true }),
  );
  const t = await oauth.processAuthorizationCodeResponse(as, client, res, { expectedNonce: oauth.expectNoNonce });
  console.log("OK", Object.keys(t));
} catch (e) {
  console.log("ERRNAME", (e as Error).name);
  console.log("ERRMSG", (e as Error).message);
  console.log("CAUSE", JSON.stringify((e as { cause?: unknown }).cause)?.slice(0, 400));
}
await server.close();
