import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import {
  runCeremony,
  type CeremonyResult,
  type IssuedValues,
} from "../../src/server/browser-driver.js";
import {
  createHeuristicInterpreter,
  type InterpreterInput,
} from "../../src/server/browser-interpreter.js";
import { createHttpCeremonyPage } from "../doubles/http-page.js";
import {
  configureSignIn,
  issuedAtA,
  registrationPlan,
  signInPlan,
  startChainProviders,
  type ChainProviders,
} from "../doubles/auth-provider/two-provider-chain.js";

/**
 * Contracts for the two-provider chain's doubles: an identity provider that
 * knows only the OAuth clients a person registered at its developer settings,
 * and a relying app that signs people in with it.
 *
 * A browser demonstration of "create an OAuth app at A, use it at B" proves
 * nothing if A accepts any client ID, so these pin down that it does not: an
 * unknown client, a callback that is not the registered one and a wrong or
 * missing secret are all refused, and B saves only a client ID and secret A
 * accepts. Both providers are local fixtures; nothing here speaks to a real
 * provider.
 */

type Driven = {
  result: CeremonyResult;
  inputs: InterpreterInput[];
};

async function drive(
  plan: ReturnType<typeof signInPlan>,
  issued?: { keep(values: IssuedValues): Promise<void> },
): Promise<Driven> {
  const page = createHttpCeremonyPage();
  await page.goto(plan.entryUrl);
  const inputs: InterpreterInput[] = [];
  const heuristic = createHeuristicInterpreter();
  const { entryUrl: _entry, ...options } = plan;
  const result = await runCeremony({
    ...options,
    page,
    interpreter: async (input) => {
      inputs.push(structuredClone(input));
      return heuristic(input);
    },
    ...(issued ? { issued: { fields: issuedAtA, keep: issued.keep } } : {}),
  });
  return { result, inputs };
}

async function chain(t: TestContext): Promise<ChainProviders> {
  const providers = await startChainProviders();
  t.after(() => providers.close());
  return providers;
}

/** Register B's app at A through the browser, keeping what A issues. */
async function register(
  providers: ChainProviders,
  callbackUrl?: string,
): Promise<Driven & { kept: IssuedValues[] }> {
  const kept: IssuedValues[] = [];
  const driven = await drive(
    registrationPlan(providers, callbackUrl ? { callbackUrl } : {}),
    {
      keep: async (values) => {
        kept.push(values);
      },
    },
  );
  return { ...driven, kept };
}

const detail = (result: CeremonyResult) =>
  `${result.status}${result.status === "blocked" ? `:${result.reason}` : ""} via ${result.transcript
    .map((step) => step.action)
    .join(" > ")}`;

test("REGISTRY-REGISTER: an OAuth app registered at developer settings is kept without the interpreter seeing its secret", async (t) => {
  const providers = await chain(t);
  const { result, inputs, kept } = await register(providers);
  assert.equal(result.status, "completed", detail(result));

  const [app] = providers.a.oauthApps();
  assert.ok(app, "A registered an app");
  assert.equal(app.name, providers.b.name);
  assert.equal(app.callbackUrl, providers.b.callbackUrl);
  assert.equal(app.secrets, 1);
  assert.equal(kept.length, 1);
  const values = kept[0]!;
  assert.equal(values["client-id"], app.clientId);
  assert.match(values["client-secret"] ?? "", /^ocs_[a-f0-9]{40}$/);

  // The secret is real: A accepts it for this client, and B saves it.
  const configured = await configureSignIn(providers.b, {
    clientId: values["client-id"]!,
    clientSecret: values["client-secret"]!,
  });
  assert.equal(configured.status, 200);
  assert.deepEqual(providers.b.integration(), { clientId: app.clientId });
  assert.equal(
    JSON.stringify(configured.body).includes(values["client-secret"]!),
    false,
  );

  // Neither value reached the interpreter, the transcript or the result.
  const visible = JSON.stringify([inputs, result]);
  for (const value of [values["client-secret"]!, values["client-id"]!])
    assert.equal(visible.includes(value), false);
  assert.ok(result.transcript.some((step) => step.action === "kept"));
});

test("REGISTRY-UNKNOWN: A refuses an unregistered client and a callback it never registered, without redirecting", async (t) => {
  const providers = await chain(t);
  const { kept } = await register(providers);
  const clientId = kept[0]!["client-id"]!;
  for (const [client, callback, heading] of [
    ["oac_never-registered", providers.b.callbackUrl, "Application not found"],
    [clientId, `${providers.b.origin}/elsewhere`, "Redirect URI mismatch"],
  ] as const) {
    const target = new URL(`${providers.a.origin}/authorize`);
    target.searchParams.set("client_id", client);
    target.searchParams.set("redirect_uri", callback);
    target.searchParams.set("response_type", "code");
    const response = await fetch(target, { redirect: "manual" });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("location"), null);
    assert.match(await response.text(), new RegExp(heading));
  }
});

test("REGISTRY-TOKEN: a confidential client must authenticate, with its own secret, for its own code", async (t) => {
  const providers = await chain(t);
  const { kept } = await register(providers);
  const clientId = kept[0]!["client-id"]!;
  const secret = kept[0]!["client-secret"]!;
  const token = (headers: Record<string, string>, fields: object) =>
    fetch(`${providers.a.origin}/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "not-a-code",
        ...fields,
      }).toString(),
    });
  const basic = (id: string, value: string) => ({
    authorization: `Basic ${Buffer.from(`${id}:${value}`).toString("base64")}`,
  });
  // No secret, a wrong one, and someone else's client ID: invalid_client.
  for (const response of [
    await token({}, { client_id: clientId }),
    await token(basic(clientId, "ocs_wrong-secret-000000"), {}),
    await token({}, { client_id: clientId, client_secret: "ocs_wrong" }),
    await token(basic("oac_never-registered", secret), {}),
  ]) {
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "invalid_client" });
  }
  // The right secret authenticates, and only then is the code looked at.
  for (const response of [
    await token(basic(clientId, secret), {}),
    await token({}, { client_id: clientId, client_secret: secret }),
  ]) {
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_grant" });
  }
});

test("REGISTRY-RELYING: B refuses a client ID and secret A does not accept, and saves nothing", async (t) => {
  const providers = await chain(t);
  const { kept } = await register(providers);
  const clientId = kept[0]!["client-id"]!;
  for (const client of [
    { clientId: "oac_never-registered", clientSecret: "ocs_whatever-000000" },
    { clientId, clientSecret: "ocs_not-the-secret-000000" },
  ]) {
    const refused = await configureSignIn(providers.b, client);
    assert.equal(refused.status, 422);
    assert.equal(refused.body["error"], "invalid_client");
    assert.equal(
      JSON.stringify(refused.body).includes(client.clientSecret),
      false,
    );
  }
  assert.equal(providers.b.integration(), undefined);
  assert.deepEqual(providers.b.refusedClients(), [
    "oac_never-registered",
    clientId,
  ]);
  // The admin API answers only to its own bearer.
  const anonymous = await fetch(
    `${providers.b.origin}/api/admin/sign-in-providers/idp`,
    { method: "PUT", body: "{}" },
  );
  assert.equal(anonymous.status, 401);
});

test("REGISTRY-SIGN-IN: a person signs in to B with A through B's registered app, and nothing secret reaches the interpreter", async (t) => {
  const providers = await chain(t);
  const registered = await register(providers);
  const values = registered.kept[0]!;
  await configureSignIn(providers.b, {
    clientId: values["client-id"]!,
    clientSecret: values["client-secret"]!,
  });

  const { result, inputs } = await drive(signInPlan(providers));
  assert.equal(result.status, "completed", detail(result));
  assert.deepEqual(providers.b.signIns(), [providers.account.email]);

  // The consent page at A named B's app by its registered name.
  assert.ok(
    inputs.some((input) =>
      input.snapshot.headings.some((heading) =>
        heading.startsWith(`${providers.b.name} wants to access`),
      ),
    ),
  );
  const visible = JSON.stringify([inputs, result]);
  for (const value of [
    values["client-secret"]!,
    values["client-id"]!,
    providers.account.password,
  ])
    assert.equal(visible.includes(value), false);
});

test("REGISTRY-CALLBACK: an app registered with another callback cannot sign anyone in to B", async (t) => {
  const providers = await chain(t);
  const registered = await register(
    providers,
    `${providers.b.origin}/some-other-callback`,
  );
  assert.equal(registered.result.status, "completed");
  const values = registered.kept[0]!;
  // A accepts the credentials themselves; only the callback is wrong.
  const configured = await configureSignIn(providers.b, {
    clientId: values["client-id"]!,
    clientSecret: values["client-secret"]!,
  });
  assert.equal(configured.status, 200);

  const { result, inputs } = await drive(signInPlan(providers));
  assert.notEqual(result.status, "completed", detail(result));
  assert.deepEqual(providers.b.signIns(), []);
  assert.ok(
    inputs.some((input) =>
      input.snapshot.headings.includes("Redirect URI mismatch"),
    ),
  );
});

test("REGISTRY-CODE-CLIENT: a code redeems only for the client it was issued to, whoever else authenticates", async (t) => {
  const providers = await chain(t);
  const x = (await register(providers)).kept[0]!;
  const y = (await register(providers, `${providers.b.origin}/other-callback`))
    .kept[0]!;
  assert.notEqual(x["client-id"], y["client-id"]);

  // A real code for X: the person signs in at A and allows X, and the driver
  // stops at X's callback before anything redeems it.
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL(`${providers.a.origin}/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", x["client-id"]!);
  authorize.searchParams.set("redirect_uri", providers.b.callbackUrl);
  authorize.searchParams.set("scope", "openid");
  authorize.searchParams.set("state", randomBytes(8).toString("hex"));
  authorize.searchParams.set(
    "code_challenge",
    createHash("sha256").update(verifier).digest("base64url"),
  );
  authorize.searchParams.set("code_challenge_method", "S256");
  const { result } = await drive({
    ...signInPlan(providers),
    entryUrl: authorize.href,
    goal: "authorize",
    allowedOrigins: [providers.a.origin],
    redirectUri: providers.b.callbackUrl,
    verify: async () => false,
  });
  assert.equal(result.status, "completed", detail(result));
  const code = result.status === "completed" ? result.callback?.code : "";
  assert.ok(code, "the callback carried a code");

  const redeem = (client: IssuedValues) =>
    fetch(`${providers.a.origin}/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(
          `${client["client-id"]}:${client["client-secret"]}`,
        ).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: providers.b.callbackUrl,
        code_verifier: verifier,
      }).toString(),
    });
  // Y authenticates with its own valid secret, and still cannot have X's code.
  const stolen = await redeem(y);
  assert.equal(stolen.status, 400);
  assert.deepEqual(await stolen.json(), { error: "invalid_grant" });
  // The same request as X is honoured, so the refusal was the client alone.
  const own = await redeem(x);
  assert.equal(own.status, 200);
});
