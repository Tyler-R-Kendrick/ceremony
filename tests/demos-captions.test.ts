import assert from "node:assert/strict";
import { test } from "node:test";
import {
  caption,
  chainSummary,
  maxCaptionLength,
  panel,
  phases,
  type CaptionEvent,
  type PanelEvent,
} from "../scripts/demos/captions.js";
import { deviceScreen } from "../scripts/demos/device.js";
import { outcomeFacts } from "../scripts/demos/story.js";
import type { CeremonyResult } from "../src/server/browser-driver.js";

/**
 * A demo video is made to be shared, so what it prints is held to a stricter
 * rule than a transcript: roles and step names, never values. These canaries
 * are pushed through every field of every caption and panel entry point —
 * including fields the types do not allow, because a caller that casts is
 * exactly the caller this has to survive.
 */
const canaries = {
  password: "Cm9!canary-password-7f3a",
  code: "846213",
  link: "https://provider.example/confirm/canary-link-token-91b2",
  token: "at_canarytoken0123456789abcdef",
  address: "canary-address-55e1@inbox.ceremony.test",
};
const values = Object.values(canaries);

function assertClean(text: string, context: string) {
  for (const value of values)
    assert.ok(!text.includes(value), `${context} printed a value: ${text}`);
  assert.ok(
    text.length <= maxCaptionLength,
    `${context} is ${text.length} characters, longer than one HUD row`,
  );
}

/** Every field of an event replaced, one at a time, with every canary. */
function poisoned(event: CaptionEvent): CaptionEvent[] {
  const out: CaptionEvent[] = [];
  for (const key of Object.keys(event))
    for (const value of values)
      out.push({ ...event, [key]: value } as unknown as CaptionEvent);
  // Extra fields a caller might smuggle in alongside the real ones.
  for (const value of values)
    out.push({
      ...event,
      note: value,
      text: value,
      value,
      path: `/confirm?code=${value}`,
    } as unknown as CaptionEvent);
  return out;
}

const events: CaptionEvent[] = [
  { kind: "fill", actor: "agent", role: "password", source: "generated" },
  {
    kind: "fill",
    actor: "agent",
    role: "verification-code",
    source: "inbox-message",
  },
  { kind: "fill", actor: "agent", role: "email", source: "agent-inbox" },
  {
    kind: "fill",
    actor: "agent",
    role: "alternate-email",
    source: "agent-inbox",
  },
  { kind: "fill", actor: "person", role: "totp-code" },
  { kind: "click", actor: "agent", control: "button", phase: "consent" },
  { kind: "click", actor: "agent", control: "link", phase: "no-account" },
  { kind: "check", actor: "agent" },
  { kind: "wait", actor: "agent" },
  { kind: "claim-done", actor: "agent" },
  { kind: "inbox", stage: "provisioned" },
  { kind: "inbox", stage: "waiting" },
  { kind: "inbox", stage: "received" },
  { kind: "provider", says: "address-in-use" },
  { kind: "provider", says: "consent-screen" },
  { kind: "blocked", reason: "account-exists" },
  { kind: "outcome", status: "blocked", reason: "human-challenge" },
  { kind: "verified", what: "token" },
  { kind: "handoff", what: "consent-approved" },
  { kind: "connector", stage: "exchange" },
  { kind: "decision", what: "no-account-register" },
  { kind: "recording", stage: "replayed" },
  { kind: "step", index: 3, total: 7, phase: "verify-email" },
  { kind: "step", index: 3, total: 6, phase: "enroll-authenticator" },
  { kind: "fill", actor: "agent", role: "totp-code", source: "totp-seed" },
  { kind: "fill", actor: "agent", role: "user-code", source: "plan" },
  { kind: "fill", actor: "person", role: "user-code", source: "device-screen" },
  { kind: "click", actor: "agent", control: "button", phase: "device-code" },
  {
    kind: "click",
    actor: "agent",
    control: "button",
    phase: "enroll-authenticator",
  },
  { kind: "blocked", reason: "device-code-required" },
  { kind: "handoff", what: "device-code" },
  { kind: "decision", what: "code-in-plan" },
  { kind: "decision", what: "no-code-hand-off" },
  { kind: "device", stage: "requested" },
  { kind: "device", stage: "polling" },
  { kind: "device", stage: "connected" },
  { kind: "custody", stage: "seed-kept" },
  { kind: "custody", stage: "code-derived" },
  { kind: "provider", says: "setup-authenticator" },
  { kind: "provider", says: "device-connected" },
  { kind: "provider", says: "device-consent" },
];

test("DEMO-CAPTIONS: no caption prints a password, code, link, token or address", () => {
  for (const event of events) {
    assertClean(caption(event), event.kind);
    for (const variant of poisoned(event))
      assertClean(caption(variant), `${event.kind} (poisoned)`);
  }
  // A kind nobody wrote a case for still says nothing it was given.
  for (const value of values)
    assertClean(
      caption({ kind: value, role: value } as unknown as CaptionEvent),
      "unknown kind",
    );
});

test("DEMO-CAPTIONS: captions name the role and the actor", () => {
  assert.equal(
    caption({
      kind: "fill",
      actor: "agent",
      role: "email",
      source: "agent-inbox",
    }),
    "Agent: fill email address (new agent-inbox address)",
  );
  assert.equal(
    caption({ kind: "fill", actor: "person", role: "password" }),
    "Person: fill password",
  );
  assert.equal(
    caption({ kind: "step", index: 4, total: 7, phase: "verify-email" }),
    "Step 4/7 · verify email via inbox",
  );
  // An unknown role is described as "a field", never echoed.
  assert.equal(
    caption({ kind: "fill", actor: "agent", role: "not-a-role" }),
    "Agent: fill a field",
  );
});

test("DEMO-CAPTIONS: panels and chain summaries carry no values either", () => {
  const panels: PanelEvent[] = [
    { kind: "chain", chain: [...phases], current: "consent" },
    { kind: "chain", chain: [...phases], current: "verified", finished: true },
    { kind: "inbox", stage: "provisioned" },
    { kind: "inbox", stage: "received" },
    { kind: "custody", stage: "empty" },
    { kind: "custody", stage: "held" },
    { kind: "custody", stage: "used" },
  ];
  for (const event of panels) {
    const drawn = panel(event);
    for (const text of [drawn.title, ...drawn.rows.map((row) => row.text)])
      assertClean(text, `panel ${event.kind}`);
    for (const value of values) {
      const smuggled = panel({
        ...event,
        ...(event.kind === "chain"
          ? { chain: [...event.chain, value], current: value }
          : { stage: value }),
      } as unknown as PanelEvent);
      for (const text of [
        smuggled.title,
        ...smuggled.rows.map((row) => row.text),
      ])
        assertClean(text, `panel ${event.kind} (poisoned)`);
    }
  }
  for (const line of chainSummary([...phases])) assertClean(line, "chain");
});

test("DEMO-CAPTIONS: a device's wall is reported as a hand-off, never guessed past", () => {
  assert.equal(
    caption({ kind: "blocked", reason: "device-code-required" }),
    "Agent: the device's code is not in the plan",
  );
  assert.equal(
    caption({
      kind: "fill",
      actor: "person",
      role: "user-code",
      source: "device-screen",
    }),
    "Person: fill device code (read off the device)",
  );
  assert.equal(
    caption({
      kind: "fill",
      actor: "agent",
      role: "totp-code",
      source: "totp-seed",
    }),
    "Agent: fill authenticator code (from held seed)",
  );
});

test("DEMO-DEVICE: the simulated device says it is simulated, and prints no token", () => {
  const device = {
    name: "Driftwood Terminal",
    userCode: "BCDF-GHJK",
    verificationUri: "http://127.0.0.1:4000/device",
    interval: 5,
    product: "Acme Accounts",
  };
  for (const screen of ["requested", "polling", "connected"] as const) {
    const drawn = deviceScreen(device, screen, "owner@ceremony.invalid");
    assert.deepEqual(drawn.text.slice(0, 2), [
      "Simulated device",
      "not a real product",
    ]);
    assert.ok(drawn.html.includes("Simulated device"));
    // What a device shows a person: the code and the URL, with no query.
    assert.ok(drawn.text.includes("BCDF-GHJK"));
    assert.ok(drawn.text.includes("127.0.0.1:4000/device"));
    for (const line of drawn.text)
      assert.ok(!line.includes(canaries.token) && !line.includes("?"), line);
  }
  assert.ok(
    deviceScreen(device, "connected", "owner@ceremony.invalid").text.includes(
      "Access token saved (not shown).",
    ),
  );
});

test("DEMO-CAPTIONS: the end card reports counts and closed names, not transcript notes", () => {
  const result = {
    status: "blocked",
    reason: "account-exists",
    steps: 4,
    handoffs: 0,
    transcript: [
      {
        path: "http://127.0.0.1/signup",
        action: "fill",
        note: canaries.password,
      },
    ],
  } as unknown as CeremonyResult;
  for (const line of outcomeFacts(result))
    for (const value of values) assert.ok(!line.includes(value), line);
});
