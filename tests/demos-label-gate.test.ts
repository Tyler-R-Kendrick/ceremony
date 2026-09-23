import assert from "node:assert/strict";
import { test } from "node:test";
import type { RecordedTraceEntry } from "../src/core/recorded-ceremony.js";
import type { SnapshotElement } from "../src/core/browser-contracts.js";
import { fillMismatches } from "../scripts/demos/label-gate.js";

/**
 * A demo is refused when a value went into a control labelled for something
 * else — the recording a person watches must show an address going into the
 * address field. The gate reads the sanitized snapshot's descriptors only.
 */
function fill(role: string, element: Omit<SnapshotElement, "index">) {
  return {
    action: "fill",
    role,
    element: 0,
    snapshot: {
      path: "http://127.0.0.1:1/signup",
      title: "Sign up",
      headings: [],
      alerts: [],
      challenge: false,
      passkey: false,
      elements: [{ index: 0, ...element }],
    },
  } as unknown as RecordedTraceEntry;
}

test("DEMO-LABELS: fills that match their controls pass", () => {
  assert.deepEqual(
    fillMismatches([
      fill("email", { kind: "input", type: "text", label: "Work email" }),
      fill("password", { kind: "input", type: "password", label: "Password" }),
      fill("password-confirm", {
        kind: "input",
        type: "password",
        placeholder: "Repeat password",
      }),
      fill("verification-code", {
        kind: "input",
        type: "text",
        label: "6-digit code",
      }),
      fill("username", { kind: "input", type: "text", label: "Username" }),
    ]),
    [],
  );
});

test("DEMO-LABELS: a username in a password box, or a password in a text field, fails", () => {
  const found = fillMismatches([
    fill("username", {
      kind: "input",
      type: "password",
      label: "Your password",
    }),
    fill("password", { kind: "input", type: "text", label: "Username" }),
    fill("email", { kind: "input", type: "text", label: "Display name" }),
  ]);
  assert.deepEqual(
    found.map((item) => item.role),
    ["username", "password", "email"],
  );
  // A click is not a fill and is never judged.
  assert.deepEqual(
    fillMismatches([
      { ...fill("email", { kind: "button", text: "Next" }), action: "click" },
    ]),
    [],
  );
});
