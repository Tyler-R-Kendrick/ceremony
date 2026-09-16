import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMailTmInbox,
  verificationFromMessage,
} from "../src/server/authored-inbox.js";

test("verification extraction finds codes and same-host links", () => {
  const code = verificationFromMessage({
    to: "a@b.c",
    text: "Your verification code is 246810. Enter it to continue.",
    at: Date.now(),
  });
  assert.equal(code?.code, "246810");
  const link = verificationFromMessage(
    {
      to: "a@b.c",
      text: "Confirm at https://provider.example/auth/confirm?token=abc123. Ignore https://evil.example/confirm?token=x",
      at: Date.now(),
    },
    "provider.example",
  );
  assert.equal(
    link?.link,
    "https://provider.example/auth/confirm?token=abc123",
  );
  const offHost = verificationFromMessage(
    {
      to: "a@b.c",
      text: "See https://evil.example/verify?token=x",
      at: Date.now(),
    },
    "provider.example",
  );
  assert.equal(offHost, undefined);
});

function mailTmFixture() {
  const state = { accounts: [] as string[], messages: [] as unknown[] };
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/domains?page=1"))
      return Response.json({
        "hydra:member": [{ domain: "inbox.test", isActive: true }],
      });
    if (url.endsWith("/accounts") && init?.method === "POST") {
      state.accounts.push(JSON.parse(String(init.body)).address);
      return Response.json({ id: "acct-1" });
    }
    if (url.endsWith("/token") && init?.method === "POST")
      return Response.json({ token: "jwt-1" });
    if (url.endsWith("/messages?page=1"))
      return Response.json({ "hydra:member": state.messages });
    if (url.includes("/messages/msg-1"))
      return Response.json({
        subject: "Verify",
        text: null,
        html: ["<p>Your code is <b>135790</b></p>"],
        createdAt: new Date().toISOString(),
      });
    return new Response("", { status: 404 });
  };
  return { state, fetcher: fetcher as typeof fetch };
}

test("mail.tm inbox provisions a fresh address and reads messages", async () => {
  const { state, fetcher } = mailTmFixture();
  const inbox = createMailTmInbox({ fetch: fetcher });
  const address = await inbox.provision();
  assert.match(address, /^cmy[0-9a-f]{12}@inbox\.test$/);
  assert.deepEqual(state.accounts, [address]);
  assert.equal(await inbox.latest(address, Date.now() - 60_000), undefined);
  state.messages.push({
    id: "msg-1",
    subject: "Verify",
    createdAt: new Date().toISOString(),
  });
  const message = await inbox.latest(address, Date.now() - 60_000);
  assert.equal(message?.subject, "Verify");
  assert.match(message?.text ?? "", /135790/);
  const found = verificationFromMessage(message!);
  assert.equal(found?.code, "135790");
});

test("mail.tm inbox accepts the bare-array content negotiation shape", async () => {
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (url.endsWith("/domains?page=1"))
      return Response.json([{ domain: "inbox.test", isActive: true }]);
    if (url.endsWith("/accounts") && init?.method === "POST")
      return Response.json({ id: "acct-1" });
    if (url.endsWith("/token") && init?.method === "POST")
      return Response.json({ token: "jwt-1" });
    if (url.endsWith("/messages?page=1"))
      return Response.json([
        {
          id: "msg-1",
          subject: "Verify",
          createdAt: new Date().toISOString(),
        },
      ]);
    if (url.includes("/messages/msg-1"))
      return Response.json({
        subject: "Verify",
        text: "Your code is 975318",
        createdAt: new Date().toISOString(),
      });
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const inbox = createMailTmInbox({ fetch: fetcher });
  const address = await inbox.provision();
  assert.match(address, /@inbox\.test$/);
  const message = await inbox.latest(address, Date.now() - 60_000);
  assert.equal(verificationFromMessage(message!)?.code, "975318");
});

test("mail.tm inbox throws when no active domain is available", async () => {
  const inbox = createMailTmInbox({
    fetch: (async () => Response.json({ "hydra:member": [] })) as typeof fetch,
  });
  await assert.rejects(inbox.provision(), /inbox unavailable/);
});
