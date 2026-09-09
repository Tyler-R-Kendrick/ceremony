import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { calculatePKCECodeChallenge } from "oauth4webapi";

/** Local signed OIDC provider. No password, external identity, or production credential. */
export async function teachingIdentityFixture() {
  const pair = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: "fixture",
    alg: "RS256",
    use: "sig",
  };
  let issuer = "";
  let tokenCalls = 0;
  const grants = new Map<string, { nonce: string; challenge: string }>();
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url!, issuer);
    if (url.pathname === "/.well-known/openid-configuration")
      return res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
        }),
      );
    if (url.pathname === "/jwks")
      return res.end(JSON.stringify({ keys: [jwk] }));
    if (url.pathname === "/authorize") {
      const code = randomBytes(16).toString("hex");
      grants.set(code, {
        nonce: url.searchParams.get("nonce")!,
        challenge: url.searchParams.get("code_challenge")!,
      });
      const target = new URL(url.searchParams.get("redirect_uri")!);
      target.searchParams.set("code", code);
      target.searchParams.set("state", url.searchParams.get("state")!);
      res.statusCode = 303;
      res.setHeader("location", target.href);
      return res.end();
    }
    if (url.pathname === "/token") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body),
        grant = grants.get(params.get("code")!);
      grants.delete(params.get("code")!);
      if (
        !grant ||
        (await calculatePKCECodeChallenge(
          params.get("code_verifier") ?? "",
        )) !== grant.challenge
      ) {
        res.statusCode = 400;
        return res.end("{}");
      }
      tokenCalls++;
      const token = await new SignJWT({ nonce: grant.nonce })
        .setProtectedHeader({ alg: "RS256", kid: "fixture" })
        .setIssuer(issuer)
        .setAudience("client")
        .setSubject("fixture-subject")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(pair.privateKey);
      return res.end(
        JSON.stringify({
          access_token: "fixture-only",
          token_type: "Bearer",
          id_token: token,
        }),
      );
    }
    res.statusCode = 404;
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture unavailable");
  issuer = `http://127.0.0.1:${address.port}`;
  return {
    issuer,
    get tokenCalls() {
      return tokenCalls;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
