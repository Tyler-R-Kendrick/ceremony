import { randomUUID } from "node:crypto";
import { z } from "zod";
import { boundedJson } from "./authorization.js";
import { AuthorizationError } from "./identity.js";
import type { AsyncCeremonyStore, StoredRecord } from "./persistence/index.js";
import type { RunRecord } from "./commands.js";
import type { OperationContext } from "./recipes/registry.js";
import type { AsyncSupabaseChildren } from "./recipes/supabase.js";

const escape = (value: string) =>
  value.replace(
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

/** Private native page. Never mount inside the assistant, recorder or cached PWA shell. */
export async function supabaseHuman(
  store: AsyncCeremonyStore,
  children: AsyncSupabaseChildren,
  context: OperationContext,
  record: StoredRecord<RunRecord>,
  request: Request,
  returnUrl: string,
  advance: () => Promise<void>,
): Promise<Response> {
  if (
    context.actor.actorKind !== "human" ||
    record.value.provider !== "supabase"
  )
    throw new AuthorizationError("denied");
  const headers = {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
  const pending = await store.transaction(async (tx) => {
    for (const node of record.value.nodes) {
      const state = await tx.get<{
        verified: boolean;
        state: string;
        diagnosticCode?: string;
      }>({
        tenant: context.actor.tenantId,
        kind: "node",
        id: `${context.runId}:${node.id}`,
      });
      if (!state?.value.verified)
        return {
          node,
          state: state?.value.state,
          diagnosticCode: state?.value.diagnosticCode,
        };
    }
    return undefined;
  });
  if (
    !pending ||
    !["awaiting-human", "uncertain"].includes(pending.state ?? "")
  )
    throw new AuthorizationError("denied");
  const bound = { ...context, nodeId: pending.node.id };
  const view = await children.humanView(bound);
  const notice =
    pending.state === "uncertain"
      ? "The previous provider outcome is unknown. Use fresh private input to recover; Ceremony will not replay the previous submission."
      : pending.diagnosticCode === "verification-rejected"
        ? view.mode === "mfa"
          ? "The authenticator code could not be verified. Enter a fresh code, or use a fresh sign-in."
          : view.mode === "confirmation"
            ? "Email confirmation has not been verified yet. Follow the confirmation link, then check again."
            : "Sign-in could not be verified. Check the project account and password, then try again."
        : "";
  const submissionError =
    view.mode === "project"
      ? "Could not use these project details. Use an HTTPS project.supabase.co URL and a publishable or legacy anon key, not a secret or service-role key. Correct the fields and try again. If the details are correct, return to the connection to check its current status."
      : "This step could not finish. Check the inputs and try again. If the problem continues, return to the connection to check its status.";
  const key = (id: string) => ({
    tenant: context.actor.tenantId,
    kind: "handoff" as const,
    id: `supabase-collector:${id}`,
  });
  if (request.method === "POST") {
    const input = z
      .strictObject({
        ticket: z.uuid(),
        values: z.union([
          z.strictObject({
            projectUrl: z.string().max(2048),
            publishableKey: z.string().max(4096),
          }),
          z.strictObject({
            action: z.enum(["sign-in", "sign-up"]),
            email: z.email().max(254),
            password: z.string().min(1).max(1024),
          }),
          z.strictObject({ confirmed: z.literal(true) }),
          z.strictObject({
            factorId: z.uuid(),
            code: z.string().regex(/^\d{6}$/),
          }),
        ]),
      })
      .safeParse(await boundedJson(request, 8192));
    if (!input.success) throw new AuthorizationError("invalid_request");
    const values = input.data.values;
    if (
      !(view.mode === "project"
        ? "projectUrl" in values
        : view.mode === "mfa"
          ? ("factorId" in values && view.factors.includes(values.factorId)) ||
            ("action" in values && values.action === "sign-in")
          : view.mode === "confirmation"
            ? "confirmed" in values ||
              ("action" in values && values.action === "sign-in")
            : "action" in values &&
              (view.allowSignup || values.action === "sign-in"))
    )
      throw new AuthorizationError("denied");
    const ticket = await store.transaction(async (tx) => {
      const record = await tx.get<Ticket>(key(input.data.ticket));
      if (!record || record.value.expires <= (await tx.now()))
        throw new AuthorizationError("denied");
      return record;
    });
    if (
      ticket.value.subject !== context.actor.subjectId ||
      ticket.value.session !== context.actor.sessionId ||
      ticket.value.runId !== context.runId ||
      ticket.value.nodeId !== pending.node.id ||
      ticket.value.revision !== record.revision
    )
      throw new AuthorizationError("denied");
    await children.humanInput(
      { ...bound, commandId: `collector:${input.data.ticket}` },
      record.revision,
      values,
    );
    await store.transaction((tx) =>
      tx.delete(key(input.data.ticket), ticket.revision),
    );
    await advance();
    const current = await store.transaction((tx) =>
      tx.get<RunRecord>({
        tenant: context.actor.tenantId,
        kind: "run",
        id: context.runId,
      }),
    );
    return Response.json(
      {
        returnUrl:
          current?.value.status === "complete" ? returnUrl : request.url,
      },
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
        nodeId: pending.node.id,
        revision: record.revision,
        expires: (await tx.now()) + 300000,
      } satisfies Ticket,
      null,
    ),
  );
  if (request.headers.get("accept") === "application/json")
    return Response.json(
      { ticket, operationId: pending.node.operationId, mode: view.mode },
      { headers },
    );
  const nonce = randomUUID();
  const credentials = (signup: boolean) =>
    `<form data-kind="credentials">${signup ? '<label for="action">Account action</label><select id="action" name="action"><option value="sign-in">Sign in to an existing project account</option><option value="sign-up">Create a project account</option></select>' : '<input type="hidden" name="action" value="sign-in">'}<label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="username" maxlength="254" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="1024" required><button>${signup ? "Continue with this account" : "Sign in again"}</button></form>`;
  const title = {
    project: "Set up your Supabase project",
    credentials: "Connect your project account",
    confirmation: "Confirm your email",
    mfa: "Verify with your authenticator",
  }[view.mode];
  const content =
    view.mode === "project"
      ? `<p>New to Supabase? <a href="https://supabase.com/dashboard/sign-up" target="_blank" rel="noopener noreferrer">Create a Supabase account (new tab)</a>, or <a href="https://supabase.com/dashboard/sign-in" target="_blank" rel="noopener noreferrer">sign in (new tab)</a>. Then create or select your project in the dashboard. Only its authorized owner should configure this connection.</p><p>Copy the project URL and publishable key from the project’s Connect dialog. We will connect a project user next; this is not access to your Supabase dashboard account.</p><form data-kind="project"><label for="projectUrl">Project URL</label><input id="projectUrl" name="projectUrl" type="url" required maxlength="2048" autocomplete="off" spellcheck="false"><label for="publishableKey">Publishable or legacy anon key</label><input id="publishableKey" name="publishableKey" type="password" required maxlength="4096" autocomplete="off" spellcheck="false"><p>Secret and service-role keys are not accepted.</p><button>Use this project</button></form>`
      : view.mode === "credentials"
        ? `<p>${view.allowSignup ? "Sign in to the user account in this project, or explicitly choose to create one." : "A previous attempt has not established usable access. Sign in again; Ceremony will not repeat account creation."} This is separate from your Supabase dashboard login.</p>${credentials(view.allowSignup)}`
        : view.mode === "confirmation"
          ? `<p>Open the confirmation email from your project and follow its link. Return here to check access. A confirmation click alone does not complete this connection.</p><form data-kind="confirmation"><button>Check confirmed account</button></form><details><summary>Need to sign in again?</summary>${credentials(false)}</details>`
          : `<p>Use a verified authenticator already enrolled for this project user. Ceremony does not enroll or replace authenticators for you.</p>${view.factors.length ? `<form data-kind="mfa"><label for="factorId">Authenticator</label><select id="factorId" name="factorId">${view.factors.map((id, index) => `<option value="${escape(id)}">Authenticator ${index + 1}</option>`).join("")}</select><label for="code">Six-digit code</label><input id="code" name="code" type="password" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required><button>Verify authenticator</button></form>` : "<p>No supported enrolled authenticator is available. Ask your project administrator for the required MFA setup or account recovery route. This connection cannot bypass that requirement.</p>"}<details><summary>Use a fresh sign-in</summary>${credentials(false)}</details>`;
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style nonce="${nonce}">:root{color-scheme:light;font:16px/1.5 system-ui,sans-serif;color:#17212d;background:#f4f6f8;accent-color:#1749c7;scrollbar-color:#94a3b4 #f4f6f8}body{margin:0}main{box-sizing:border-box;max-width:680px;margin:40px auto;padding:24px;background:#fff}h1{font-size:28px;line-height:1.2;letter-spacing:-.02em;text-wrap:balance}p{max-width:65ch;overflow-wrap:anywhere}a{color:#1749c7;text-underline-offset:3px}form,details{margin-block:24px}label{display:block;font-weight:600}input:not([type=hidden]),select{box-sizing:border-box;display:block;width:100%;margin-block:8px 16px;min-height:44px;border:1px solid #aebdce;border-radius:6px;padding:10px 12px;font:inherit;background:#fff;color:#17212d;caret-color:#1749c7}button{min-height:44px;border:0;border-radius:6px;background:#1749c7;color:#fff;padding:10px 16px;font:600 16px/1.5 system-ui;cursor:pointer}button:hover{background:#103aa5}button:disabled{opacity:.55;cursor:wait}summary{min-height:44px;cursor:pointer}:focus-visible{outline:2px solid #1749c7;outline-offset:3px}::selection{background:#d9e5ff;color:#152f70}#status{color:#a03620}@media(max-width:720px){main{margin:0;padding:24px 20px;min-height:100dvh}}</style></head><body><main><h1>${title}</h1>${content}<p>Your inputs go only to the private broker and the configured project’s Auth service, not the assistant or demonstration. Signup credentials are encrypted for up to 15 minutes while awaiting confirmation; authenticator codes expire locally after five minutes and are not automatically replayed.</p><p id="status" role="status" aria-live="polite">${escape(notice)}</p><p><a href="${escape(returnUrl)}">Return to connection</a></p></main><script nonce="${nonce}">const forms=[...document.querySelectorAll('form')];for(const form of forms)form.addEventListener('submit',async event=>{event.preventDefault();const values=form.dataset.kind==='confirmation'?{confirmed:true}:Object.fromEntries(new FormData(form));for(const item of forms){item.reset();item.querySelector('button').disabled=true}try{const admission=await fetch(location.pathname,{headers:{accept:'application/json'},credentials:'same-origin',cache:'no-store'});if(!admission.ok)throw new Error();const fresh=await admission.json();if(fresh.operationId!==${JSON.stringify(pending.node.operationId)}||fresh.mode!==${JSON.stringify(view.mode)})throw new Error();const response=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify({ticket:fresh.ticket,values})});if(!response.ok)throw new Error();location.assign((await response.json()).returnUrl)}catch{document.getElementById('status').textContent=${JSON.stringify(submissionError)}}finally{for(const key of Object.keys(values))delete values[key];for(const item of forms)item.querySelector('button').disabled=false}});addEventListener('pagehide',()=>forms.forEach(form=>form.reset()));const action=document.getElementById('action');if(action)action.addEventListener('change',()=>document.getElementById('password').autocomplete=action.value==='sign-up'?'new-password':'current-password');</script></body></html>`,
    {
      headers: {
        ...headers,
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
      },
    },
  );
}
