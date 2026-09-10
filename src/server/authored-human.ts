import { randomUUID } from "node:crypto";
import { z } from "zod";
import { boundedJson } from "./authorization.js";
import { AuthorizationError } from "./identity.js";
import type { AsyncCeremonyStore, StoredRecord } from "./persistence/index.js";
import type { RunRecord } from "./commands.js";
import type { OperationContext } from "./recipes/registry.js";
import {
  publicAuthoredIdentity,
  saveAuthoredSession,
} from "./authored-operations.js";

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

/** Private collector for an authored provider. Credentials never return to chat. */
export async function authoredHuman(
  store: AsyncCeremonyStore,
  context: OperationContext,
  record: StoredRecord<RunRecord>,
  request: Request,
  returnUrl: string,
  advance: () => Promise<void>,
  options: { fetch?: typeof fetch; connectorId: string; name: string } = {
    connectorId: "authored",
    name: "provider",
  },
): Promise<Response> {
  if (
    context.actor.actorKind !== "human" ||
    record.value.profile !== "authored"
  )
    throw new AuthorizationError("denied");
  const headers = {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
  const identity = await publicAuthoredIdentity(
    store,
    context.actor,
    context.runId,
  );
  if (identity)
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(options.name)} connected</title></head><body><main><h1>Connected as ${escape(identity.handle)}</h1><p><code>${escape(identity.did)}</code></p><p><a href="${escape(returnUrl)}">Return to connection</a></p></main></body></html>`,
      { headers: { ...headers, "content-type": "text/html; charset=utf-8" } },
    );
  const pending = await store.transaction(async (tx) => {
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
    !pending ||
    pending.state !== "awaiting-human" ||
    pending.node.operationId !== "authored.authorize-user"
  )
    throw new AuthorizationError("denied");
  const key = (id: string) => ({
    tenant: context.actor.tenantId,
    kind: "handoff" as const,
    id: `authored-collector:${id}`,
  });
  if (request.method === "POST") {
    const input = z
      .strictObject({
        ticket: z.uuid(),
        identifier: z.string().min(1).max(256),
        password: z.string().min(1).max(256),
      })
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
      ticket.value.nodeId !== pending.node.id ||
      ticket.value.revision !== record.revision
    )
      throw new AuthorizationError("denied");
    const created = await saveAuthoredSession(
      store,
      context.actor,
      context.runId,
      {
        identifier: input.data.identifier,
        password: input.data.password,
      },
      options.fetch ?? fetch,
    );
    if (!created) throw new AuthorizationError("denied");
    await store.transaction((tx) =>
      tx.delete(key(input.data.ticket), ticket.revision),
    );
    await advance();
    return Response.json({ returnUrl }, { headers });
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
        nodeId: pending.node.id,
        revision: record.revision,
        expires: (await tx.now()) + 300000,
      } satisfies Ticket,
      null,
    ),
  );
  const nonce = randomUUID();
  const title = `Sign in to ${options.name}`;
  if (request.headers.get("accept") === "application/json")
    return Response.json(
      { ticket, operationId: pending.node.operationId },
      { headers },
    );
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
  <style nonce="${nonce}">:root{color-scheme:light;font:16px/1.5 system-ui,sans-serif;color:#17212d;background:#f4f6f8}body{margin:0}main{box-sizing:border-box;max-width:680px;margin:40px auto;padding:24px;background:#fff}h1{font-size:28px;line-height:1.2}label{display:block;font-weight:600}input{box-sizing:border-box;display:block;width:100%;margin-block:8px 16px;min-height:44px;border:1px solid #aebdce;border-radius:6px;padding:10px 12px;font:inherit}button{min-height:44px;border:0;border-radius:6px;background:#1749c7;color:#fff;padding:10px 16px;font:600 16px/1.5 system-ui}#status{color:#a03620}</style></head><body><main>
  <h1>${escape(title)}</h1>
  <p>Use your ${escape(options.name)} handle and an <strong>app password</strong>, not your account password. Create one in the app’s settings. It is sent only to ${escape(options.name)} and the encrypted collector — never to chat.</p>
  <p><a href="https://bsky.app/settings/app-passwords" target="_blank" rel="noopener noreferrer">Create a Bluesky app password (new tab)</a></p>
  <form id="private"><label for="identifier">Handle or email</label><input id="identifier" name="identifier" required maxlength="256" autocomplete="username"><label for="password">App password</label><input id="password" name="password" type="password" required maxlength="256" autocomplete="current-password"><button>Verify ${escape(options.name)} access</button></form>
  <p id="status" role="status" aria-live="polite"></p><p><a href="${escape(returnUrl)}">Return to connection</a></p>
  </main><script nonce="${nonce}">const form=document.getElementById('private');form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('button');const data=new FormData(form);const body={ticket:${JSON.stringify(ticket)},identifier:data.get('identifier'),password:data.get('password')};form.reset();button.disabled=true;try{const fresh=await fetch(location.pathname,{headers:{accept:'application/json'},credentials:'same-origin',cache:'no-store'});if(!fresh.ok)throw new Error();const admission=await fresh.json();body.ticket=admission.ticket;const response=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify(body)});if(!response.ok)throw new Error();location.assign((await response.json()).returnUrl)}catch{document.getElementById('status').textContent='Sign-in failed. Check the handle and app password, then try again.'}finally{button.disabled=false}});addEventListener('pagehide',()=>form.reset());</script></body></html>`,
    {
      headers: {
        ...headers,
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
      },
    },
  );
}
