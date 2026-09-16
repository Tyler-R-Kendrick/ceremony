import { createServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";

/**
 * Self-hosted OIDC IdP test double. Serves a real discovery document, RFC 7591
 * dynamic registration, authorization-code + PKCE (S256), a token endpoint,
 * userinfo, and account registration with email verification — over real HTTP.
 * Every page is randomly generated per fixture instance (seeded): field names,
 * labels, button texts, DOM order, signup path, and alert classes all vary, so
 * tests cannot pass by matching a fixed markup shape.
 */
function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export type IdpAccount = {
  email: string;
  handle: string;
  password: string;
  verified: boolean;
};

const identifierLabels = ["Username", "Handle", "Identifier", "Login name"];
const emailLabels = ["Email", "E-mail address", "Email address", "Your email"];
const passwordLabels = [
  "Password",
  "Choose a password",
  "Secret",
  "Passphrase",
];
const confirmLabels = ["Confirm password", "Repeat password", "Password again"];
const nameLabels = ["Your name", "Display name", "Full name"];
const dobLabels = ["Birth date", "Date of birth", "Your birthday"];
const termsLabels = [
  "I agree to the terms",
  "I accept the Terms of Service",
  "I am old enough to use this service",
];
const signinButtons = ["Sign in", "Log in", "Continue", "Next"];
const signupButtons = ["Create account", "Register", "Sign up", "Join"];
const consentButtons = ["Authorize", "Allow", "Approve", "Grant access"];
const signupLinks = ["Create account", "Sign up", "Register here", "Join now"];
const alertClasses = [
  'class="alert-danger"',
  'class="invalid-feedback"',
  'class="form-error"',
  'class="error-message"',
  'role="alert"',
];
const inUseTexts = [
  "That email is already in use.",
  "This address is already registered.",
  "The email you entered is taken.",
];
const unverifiedTexts = [
  "Please confirm your email address first.",
  "Your account is not verified yet.",
];
const checkInboxTexts = [
  "Check your inbox to confirm the account.",
  "We sent you a confirmation email.",
];
const signupPaths = [
  "/signup",
  "/register",
  "/join",
  "/account/create",
  "/auth/signup",
];

export async function oidcIdpFixture(
  options: {
    seed?: number;
    mfa?: boolean;
    outbox?: (message: { to: string; text: string; at: number }) => void;
  } = {},
) {
  const rand = mulberry32(options.seed ?? 1);
  const pick = <T>(pool: T[]): T => pool[Math.floor(rand() * pool.length)]!;
  const token = (length = 4) => randomBytes(length).toString("hex");
  const shuffle = <T>(items: T[]): T[] => [...items].sort(() => rand() - 0.5);

  const markup = {
    identifierName: `u${token(3)}`,
    emailName: `e${token(3)}`,
    passwordName: `p${token(3)}`,
    confirmName: `c${token(3)}`,
    nameName: `n${token(3)}`,
    dobName: `d${token(3)}`,
    termsName: `t${token(3)}`,
    identifierLabel: pick(identifierLabels),
    emailLabel: pick(emailLabels),
    passwordLabel: pick(passwordLabels),
    confirmLabel: pick(confirmLabels),
    nameLabel: pick(nameLabels),
    dobLabel: pick(dobLabels),
    termsLabel: pick(termsLabels),
    signinButton: pick(signinButtons),
    signupButton: pick(signupButtons),
    consentButton: pick(consentButtons),
    signupLink: pick(signupLinks),
    alertClass: pick(alertClasses),
    inUseText: pick(inUseTexts),
    unverifiedText: pick(unverifiedTexts),
    checkInboxText: pick(checkInboxTexts),
    includeDob: rand() > 0.5,
    includeDisplayName: rand() > 0.4,
    signupPath: pick(signupPaths),
  };

  const accounts = new Map<string, IdpAccount>();
  const codes = new Map<
    string,
    {
      challenge: string;
      redirectUri: string;
      clientId: string;
      email: string;
      mfaVerified?: boolean;
    }
  >();
  const pending = new Map<string, { email: string; password: string }>();
  const verifyTokens = new Map<string, string>();
  const clients = new Map<string, string>();
  const counts = { authorization: 0, signin: 0, mfa: 0, token: 0 };

  const html = (body: string) =>
    `<!doctype html><html><body>${body}</body></html>`;
  const field = (label: string, name: string, type: string, extra = "") => {
    const id = `f_${name}`;
    const style = rand();
    if (style < 0.33)
      return `<label for="${id}">${label}</label><input id="${id}" name="${name}" type="${type}" ${extra}>`;
    if (style < 0.66)
      return `<input id="${id}" name="${name}" type="${type}" aria-label="${label}" ${extra}>`;
    return `<input id="${id}" name="${name}" type="${type}" placeholder="${label}" ${extra}>`;
  };

  const loginPage = (error?: string) => {
    const fields = shuffle([
      field(markup.identifierLabel, markup.identifierName, "text", "required"),
      field(markup.passwordLabel, markup.passwordName, "password", "required"),
    ]);
    return html(`
      ${error ? `<div ${markup.alertClass}>${error}</div>` : ""}
      <h1>${pick(["Welcome", "Sign in to continue", "Account access"])}</h1>
      <form method="post" action="/session">
        ${fields.join("\n")}
        <button type="submit">${markup.signinButton}</button>
      </form>
      <a href="${markup.signupPath}">${markup.signupLink}</a>`);
  };

  const signupPage = (error?: string) => {
    const fields = shuffle([
      field(markup.emailLabel, markup.emailName, "email", "required"),
      field(markup.passwordLabel, markup.passwordName, "password", "required"),
      field(markup.confirmLabel, markup.confirmName, "password", "required"),
      ...(markup.includeDisplayName
        ? [field(markup.nameLabel, markup.nameName, "text")]
        : []),
      ...(markup.includeDob
        ? [field(markup.dobLabel, markup.dobName, "date")]
        : []),
      `<label><input name="${markup.termsName}" type="checkbox" required> ${markup.termsLabel}</label>`,
    ]);
    return html(`
      ${error ? `<div ${markup.alertClass}>${error}</div>` : ""}
      <h1>${pick(["Join us", "Create your account", "Registration"])}</h1>
      <form method="post" action="${markup.signupPath}">
        ${fields.join("\n")}
        <button type="submit">${markup.signupButton}</button>
      </form>`);
  };

  const consentPage = (session: string) =>
    html(`
      <h1>${pick(["Allow access?", "Authorize this application", "Consent"])}</h1>
      <form method="post" action="/consent">
        <input type="hidden" name="s" value="${session}">
        <button type="submit">${markup.consentButton}</button>
      </form>`);
  const mfaPage = (session: string) =>
    html(
      `<h1>Verify your account</h1><form method="post" action="/mfa?s=${session}"><label>Verification code <input name="verification_code" autocomplete="one-time-code" required></label><button type="submit">Verify</button></form>`,
    );

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: string, type = "text/html") => {
      res.writeHead(status, { "content-type": type });
      res.end(body);
    };
    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => route(url, body));
    } else route(url, "");

    function route(parsed: URL, rawBody: string) {
      const url = parsed;
      const params = new URLSearchParams(rawBody);
      if (
        url.pathname === "/.well-known/openid-configuration" ||
        url.pathname === "/.well-known/oauth-authorization-server"
      ) {
        send(
          200,
          JSON.stringify({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            userinfo_endpoint: `${origin}/userinfo`,
            registration_endpoint: `${origin}/dcr`,
            grant_types_supported: ["authorization_code", "refresh_token"],
            scopes_supported: ["openid", "profile", "email"],
            code_challenge_methods_supported: ["S256"],
          }),
          "application/json",
        );
        return;
      }
      if (url.pathname === "/dcr" && req.method === "POST") {
        const clientId = `client-${token(6)}`;
        clients.set(clientId, "public");
        send(
          201,
          JSON.stringify({
            client_id: clientId,
            client_id_issued_at: Math.floor(Date.now() / 1000),
            token_endpoint_auth_method: "none",
          }),
          "application/json",
        );
        return;
      }
      if (url.pathname === "/authorize" && req.method === "GET") {
        counts.authorization++;
        const challenge = url.searchParams.get("code_challenge") ?? "";
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const state = url.searchParams.get("state") ?? "";
        const clientId = url.searchParams.get("client_id") ?? "";
        if (
          url.searchParams.get("response_type") !== "code" ||
          !challenge ||
          !redirectUri ||
          !clients.has(clientId)
        ) {
          send(400, html("<h1>Invalid request</h1>"));
          return;
        }
        const session = token(8);
        pending.set(session, { email: "", password: "" });
        codes.set(`s:${session}`, {
          challenge,
          redirectUri: `${redirectUri}${redirectUri.includes("?") ? "&" : "?"}state=${encodeURIComponent(state)}`,
          clientId,
          email: "",
        });
        send(
          200,
          loginPage().replace(
            'action="/session"',
            `action="/session?s=${session}"`,
          ),
        );
        return;
      }
      if (url.pathname === "/session" && req.method === "POST") {
        counts.signin++;
        const session = url.searchParams.get("s") ?? "";
        const grant = codes.get(`s:${session}`);
        if (!grant) {
          send(400, html("<h1>Session expired</h1>"));
          return;
        }
        const handle = params.get(markup.identifierName) ?? "";
        const password = params.get(markup.passwordName) ?? "";
        const account = [...accounts.values()].find(
          (item) => item.handle === handle || item.email === handle,
        );
        if (!account || account.password !== password) {
          send(200, loginPage("These credentials do not match our records."));
          return;
        }
        if (!account.verified) {
          send(200, loginPage(markup.unverifiedText));
          return;
        }
        grant.email = account.email;
        send(200, options.mfa ? mfaPage(session) : consentPage(session));
        return;
      }
      if (url.pathname === "/mfa" && req.method === "POST") {
        counts.mfa++;
        const session = url.searchParams.get("s") ?? "";
        const grant = codes.get(`s:${session}`);
        if (!grant?.email || params.get("verification_code") !== "123456") {
          send(400, html("<h1>Verification failed</h1>"));
          return;
        }
        grant.mfaVerified = true;
        send(200, consentPage(session));
        return;
      }
      if (url.pathname === "/consent" && req.method === "POST") {
        const session = params.get("s") ?? "";
        const grant = codes.get(`s:${session}`);
        if (!grant || !grant.email || (options.mfa && !grant.mfaVerified)) {
          send(400, html("<h1>Session expired</h1>"));
          return;
        }
        const code = token(12);
        codes.set(code, {
          challenge: grant.challenge,
          redirectUri: grant.redirectUri,
          clientId: grant.clientId,
          email: grant.email,
        });
        codes.delete(`s:${session}`);
        const [base, query] = grant.redirectUri.split("?");
        res.writeHead(302, {
          location: `${base}?code=${code}${query ? `&${query}` : ""}`,
        });
        res.end();
        return;
      }
      if (url.pathname === "/token" && req.method === "POST") {
        counts.token++;
        const code = params.get("code") ?? "";
        const grant = codes.get(code);
        const verifier = params.get("code_verifier") ?? "";
        const digest = createHash("sha256")
          .update(verifier)
          .digest("base64url");
        if (
          params.get("grant_type") !== "authorization_code" ||
          !grant ||
          digest !== grant.challenge
        ) {
          send(
            400,
            JSON.stringify({ error: "invalid_grant" }),
            "application/json",
          );
          return;
        }
        codes.delete(code);
        send(
          200,
          JSON.stringify({
            access_token: `at_${token(16)}`,
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: `rt_${token(16)}`,
            sub_email: grant.email,
          }),
          "application/json",
        );
        return;
      }
      if (url.pathname === "/userinfo" && req.method === "GET") {
        send(
          200,
          JSON.stringify({
            sub: "user-1",
            preferred_username: [...accounts.values()][0]?.handle ?? "agent",
          }),
          "application/json",
        );
        return;
      }
      if (url.pathname === markup.signupPath && req.method === "GET") {
        send(200, signupPage());
        return;
      }
      if (url.pathname === markup.signupPath && req.method === "POST") {
        const email = params.get(markup.emailName) ?? "";
        const password = params.get(markup.passwordName) ?? "";
        const confirm = params.get(markup.confirmName) ?? "";
        if (!email || !password || password !== confirm) {
          send(200, signupPage("Please complete every field correctly."));
          return;
        }
        if (accounts.has(email)) {
          send(200, signupPage(markup.inUseText));
          return;
        }
        const handle =
          params.get(markup.nameName) ||
          email.slice(0, email.indexOf("@")) ||
          `user${token(3)}`;
        accounts.set(email, { email, handle, password, verified: false });
        const verifyToken = token(12);
        verifyTokens.set(verifyToken, email);
        options.outbox?.({
          to: email,
          text: `Confirm your account: ${origin}/verify/${verifyToken}`,
          at: Date.now(),
        });
        send(
          200,
          html(
            `<main><h1>${markup.checkInboxText}</h1><a href="${markup.signupPath}">Resend the confirmation email</a></main>`,
          ),
        );
        return;
      }
      if (url.pathname.startsWith("/verify/")) {
        const email = verifyTokens.get(url.pathname.slice("/verify/".length));
        const account = email ? accounts.get(email) : undefined;
        if (account) {
          account.verified = true;
          send(
            200,
            html(
              `<main><h1>Account confirmed.</h1><a href="/authorize">Continue</a></main>`,
            ),
          );
          return;
        }
        send(404, html("<h1>Unknown link</h1>"));
        return;
      }
      send(404, html("<h1>Not found</h1>"));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    counts,
    accounts,
    markup,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
