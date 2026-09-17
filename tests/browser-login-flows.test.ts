import assert from "node:assert/strict";
import test from "node:test";
import { selectInitialStep } from "../src/browser-login/flows.js";
import type { Observation } from "../src/browser-login/templates.js";

const origin = "http://127.0.0.1:4919";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function page(): Observation {
  return {
    document: id(1),
    origin,
    challenge: false,
    controls: [
      {
        ref: id(2),
        form: id(4),
        kind: "identifier",
        label: "Email",
        recipient: `${origin}/login`,
      },
      {
        ref: id(3),
        form: id(4),
        kind: "submit",
        label: "Continue",
        recipient: `${origin}/login`,
      },
    ],
  };
}

test("initial selection follows catalog alternatives and exact run-origin admission", () => {
  const observation = page();
  const result = selectInitialStep("owned-fixture-login", origin, observation);
  assert.equal(result?.kind, "identifier");
  assert.deepEqual(result?.sequence, [
    "identifier",
    "password",
    "verification",
  ]);
  assert.equal(result?.step.mapping.identifier, id(2));
  assert.equal(
    selectInitialStep("github-login", origin, observation),
    undefined,
  );
  assert.equal(selectInitialStep("missing", origin, observation), undefined);
  assert.equal(
    selectInitialStep(
      "owned-fixture-login",
      "http://127.0.0.1:4920",
      observation,
    ),
    undefined,
  );
  assert.equal(
    selectInitialStep("owned-fixture-login", origin, {
      ...observation,
      challenge: true,
    }),
    undefined,
  );
});
