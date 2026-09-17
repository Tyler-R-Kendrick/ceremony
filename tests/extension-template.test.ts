import assert from "node:assert/strict";
import { test } from "node:test";
import {
  matchTemplate,
  validateMapping,
  type Observation,
} from "../src/browser-login/templates.js";
import {
  inferMapping,
  localTextModel,
} from "../src/browser-login/inference.js";

const identifier = "00000000-0000-4000-8000-000000000001";
const password = "00000000-0000-4000-8000-000000000002";
const submit = "00000000-0000-4000-8000-000000000003";
const form = "00000000-0000-4000-8000-000000000004";
function page(): Observation {
  return {
    document: "00000000-0000-4000-8000-000000000005",
    origin: "https://owned.example",
    challenge: false,
    passkey: false,
    controls: [
      {
        ref: identifier,
        kind: "identifier",
        label: "Username",
        form,
        recipient: "https://owned.example/login",
      },
      {
        ref: password,
        kind: "password",
        label: "Password",
        form,
        recipient: "https://owned.example/login",
      },
      {
        ref: submit,
        kind: "submit",
        label: "Sign in",
        form,
        recipient: "https://owned.example/login",
      },
    ],
  };
}
test("combined login template binds credential roles without inference", () => {
  const step = matchTemplate(page());
  assert.deepEqual(step?.mapping, { identifier, password, submit });
  assert.equal(step?.recipient, "https://owned.example/login");
});
test("AI SDK invokes local model and validates proposed mapping", async () => {
  let calls = 0;
  const observed = page();
  observed.controls[0]!.kind = "unknown";
  assert.equal(matchTemplate(observed), undefined);
  const model = localTextModel(async (prompt) => {
    calls++;
    assert.ok(prompt.includes(identifier));
    assert.ok(!prompt.includes("https://owned.example"));
    return JSON.stringify({ identifier, password, submit });
  });
  const step = await inferMapping(model, observed, AbortSignal.timeout(5000));
  assert.deepEqual(step?.mapping, { identifier, password, submit });
  assert.equal(calls, 1);
});
test("AI mapping cannot authorize cross-origin recipients or invented controls", async () => {
  const observed = page();
  for (const control of observed.controls)
    control.recipient = "https://other.example/login";
  assert.equal(
    validateMapping(observed, { identifier, password, submit }),
    undefined,
  );
  const model = localTextModel(async () =>
    JSON.stringify({ identifier, password, submit: form }),
  );
  assert.equal(
    await inferMapping(model, page(), AbortSignal.timeout(5000)),
    undefined,
  );
});
test("ambiguous forms, human challenges, and malformed inference stop", async () => {
  const observed = page();
  observed.challenge = true;
  assert.equal(matchTemplate(observed), undefined);
  const passkeyOnly = page();
  passkeyOnly.passkey = true;
  passkeyOnly.controls = passkeyOnly.controls.filter(
    (control) => control.kind !== "password",
  );
  assert.equal(matchTemplate(passkeyOnly)?.mapping.password, undefined);
  const conditional = page();
  conditional.passkey = true;
  assert.equal(matchTemplate(conditional)?.mapping.password, password);
  const ambiguous = page();
  ambiguous.controls.push({
    ...ambiguous.controls[0]!,
    ref: crypto.randomUUID(),
  });
  assert.equal(matchTemplate(ambiguous), undefined);
  assert.equal(
    await inferMapping(
      localTextModel(async () => "not JSON"),
      page(),
      AbortSignal.timeout(5000),
    ),
    undefined,
  );
});
