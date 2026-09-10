import { randomUUID } from "node:crypto";
import { z } from "zod";
import { boundedJson } from "./authorization.js";
import { AuthorizationError } from "./identity.js";
import type { AsyncCeremonyStore, StoredRecord } from "./persistence/index.js";
import type { RunRecord } from "./commands.js";
import type { OperationContext } from "./recipes/registry.js";
import type { AsyncStripeChildren } from "./recipes/stripe.js";

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
type Ticket = {
  subject: string;
  session: string;
  runId: string;
  nodeId: string;
  revision: number;
  expires: number;
};

/** Isolated native HTML; no PWA shell, model, recorder, or credential-bearing redirects. */
export async function stripeHuman(
  store: AsyncCeremonyStore,
  children: AsyncStripeChildren,
  context: OperationContext,
  record: StoredRecord<RunRecord>,
  request: Request,
  returnUrl: string,
  advance: () => Promise<void>,
): Promise<Response> {
  if (context.actor.actorKind !== "human" || record.value.provider !== "stripe")
    throw new AuthorizationError("denied");
  const headers = {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
  const nodes = await store.transaction(async (tx) => {
    for (const node of record.value.nodes) {
      const state = await tx.get<{ verified: boolean; state: string }>({
        tenant: context.actor.tenantId,
        kind: "node",
        id: `${context.runId}:${node.id}`,
      });
      if (!state?.value.verified) return { node, state: state?.value.state };
    }
    return undefined;
  });
  if (
    !nodes ||
    nodes.state !== "awaiting-human" ||
    ![
      "stripe.prepare-account",
      "stripe.obtain-key",
      "stripe.verify-access",
    ].includes(nodes.node.operationId)
  )
    throw new AuthorizationError("denied");
  const account = nodes.node.operationId === "stripe.prepare-account";
  const key = (id: string) => ({
    tenant: context.actor.tenantId,
    kind: "handoff" as const,
    id: `stripe-collector:${id}`,
  });
  if (request.method === "POST") {
    const input = z
      .union([
        z.strictObject({ ticket: z.uuid(), accountReady: z.literal(true) }),
        z.strictObject({ ticket: z.uuid(), token: z.string().max(512) }),
      ])
      .safeParse(await boundedJson(request, 4096));
    if (!input.success) throw new AuthorizationError("invalid_request");
    const ticket = await store.transaction(async (tx) => {
      const value = await tx.get<Ticket>(key(input.data.ticket));
      if (!value || value.value.expires <= (await tx.now()))
        throw new AuthorizationError("denied");
      return value;
    });
    if (
      ticket.value.subject !== context.actor.subjectId ||
      ticket.value.session !== context.actor.sessionId ||
      ticket.value.runId !== context.runId ||
      ticket.value.nodeId !== nodes.node.id ||
      ticket.value.revision !== record.revision
    )
      throw new AuthorizationError("denied");
    await children.humanInput(
      {
        ...context,
        nodeId: nodes.node.id,
        commandId: `collector:${input.data.ticket}`,
      },
      record.revision,
      "token" in input.data
        ? { token: input.data.token }
        : { accountReady: input.data.accountReady },
    );
    await store.transaction((tx) =>
      tx.delete(key(input.data.ticket), ticket.revision),
    );
    await advance();
    return Response.json(
      { returnUrl: account ? request.url : returnUrl },
      { headers },
    );
  }
  if (request.method !== "GET") throw new AuthorizationError("denied");
  const ticket = randomUUID();
  await store.transaction(async (tx) =>
    tx.put(
      key(ticket),
      {
        subject: context.actor.subjectId,
        session: context.actor.sessionId,
        runId: context.runId,
        nodeId: nodes.node.id,
        revision: record.revision,
        expires: (await tx.now()) + 300000,
      } satisfies Ticket,
      null,
    ),
  );
  const nonce = randomUUID();
  if (request.headers.get("accept") === "application/json")
    return Response.json(
      { ticket, operationId: nodes.node.operationId },
      { headers },
    );
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${account ? "Set up your Stripe account" : "Connect your Stripe key"}</title>
  <style nonce="${nonce}">:root{color-scheme:light;font:16px/1.5 system-ui,sans-serif;color:#17212d;background:#f4f6f8}body{margin:0}main{box-sizing:border-box;max-width:680px;margin:40px auto;padding:24px;background:#fff}h1{font-size:28px;line-height:1.2;letter-spacing:-.02em}p{max-width:65ch}a{color:#1749c7;text-underline-offset:3px}form{margin-block:24px}label{display:block;font-weight:600}input{box-sizing:border-box;display:block;width:100%;margin-block:8px 16px;min-height:44px;border:1px solid #aebdce;border-radius:6px;padding:10px 12px;font:inherit;caret-color:#1749c7}button{min-height:44px;border:0;border-radius:6px;background:#1749c7;color:#fff;padding:10px 16px;font:600 16px/1.5 system-ui;cursor:pointer}button:hover{background:#103aa5}button:disabled{opacity:.55;cursor:wait}:focus-visible{outline:2px solid #1749c7;outline-offset:3px}::selection{background:#d9e5ff;color:#152f70}#status{color:#a03620} @media(max-width:720px){main{margin:0;padding:24px 20px;min-height:100dvh}}</style></head><body><main>
  <h1>${account ? "Set up your Stripe account" : "Connect your Stripe key"}</h1>
  ${account ? `<p>Create an account if you are new to Stripe, or sign in to the account you want to connect. Complete Stripe’s email verification, MFA, and any required checks there.</p><p><a href="https://dashboard.stripe.com/register" target="_blank" rel="noopener noreferrer">Create a Stripe account (new tab)</a> · <a href="https://dashboard.stripe.com/login" target="_blank" rel="noopener noreferrer">Sign in to Stripe (new tab)</a></p><p>Return here when the account is ready. This choice does not verify ownership or grant API access; we check access after you provide a restricted key.</p>` : `<p>In Stripe’s <a href="https://dashboard.stripe.com/apikeys" target="_blank" rel="noopener noreferrer">API keys page (new tab)</a>, create a restricted key with Balance read permission. Choose a sandbox for testing. No payment or write permission is needed.</p><p>The key goes directly to the encrypted private broker and Stripe. It is not sent to the assistant or saved in your demonstration. Never paste it into chat.</p>`}
  <form id="private">${account ? "" : `<label for="token">Restricted API key</label><input id="token" name="token" type="password" required maxlength="512" pattern="(sk|rk)_(test|live)_[A-Za-z0-9]+" title="Use a restricted rk_test_ or rk_live_ key, or an existing sk_test_ or sk_live_ secret key. Publishable keys cannot verify access." aria-describedby="key-format" autocomplete="off" spellcheck="false"><p id="key-format">Use a restricted key beginning rk_test_ or rk_live_. Existing sk_test_ and sk_live_ keys also work; publishable pk_ keys do not.</p>`}<button>${account ? "My account is ready" : "Verify Stripe access"}</button></form>
  <p id="status" role="status" aria-live="polite"></p><p><a href="${escape(returnUrl)}">Return to connection</a></p>
  </main><script nonce="${nonce}">const form=document.getElementById('private');form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('button');const body={ticket:${JSON.stringify(ticket)},${account ? "accountReady:true" : "token:new FormData(form).get('token')"}};form.reset();button.disabled=true;try{const fresh=await fetch(location.pathname,{headers:{accept:'application/json'},credentials:'same-origin',cache:'no-store'});if(!fresh.ok)throw new Error();const admission=await fresh.json();if(admission.operationId!==${JSON.stringify(nodes.node.operationId)})throw new Error();body.ticket=admission.ticket;const response=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify(body)});if(!response.ok)throw new Error();const result=await response.json();location.assign(result.returnUrl)}catch{document.getElementById('status').textContent='This step could not finish. Return to the connection to check its current status, then reopen this step.'}finally{button.disabled=false}});addEventListener('pagehide',()=>form.reset());</script></body></html>`,
    {
      headers: {
        ...headers,
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
      },
    },
  );
}
