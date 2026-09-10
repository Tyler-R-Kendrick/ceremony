import { randomUUID } from "node:crypto";
import { z } from "zod";
import { boundedJson } from "./authorization.js";
import { AuthorizationError } from "./identity.js";
import type { AsyncCeremonyStore, StoredRecord } from "./persistence/index.js";
import type { RunRecord } from "./commands.js";
import type { OperationContext } from "./recipes/registry.js";
import type { AsyncJiraChildren } from "./recipes/jira.js";

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
  mode: "app" | "recovery";
  expires: number;
};

/** Isolated native participation. No private URL, input or receipt is an agent result. */
export async function jiraHuman(
  store: AsyncCeremonyStore,
  children: AsyncJiraChildren,
  context: OperationContext,
  record: StoredRecord<RunRecord>,
  request: Request,
  returnUrl: string,
  advance: () => Promise<void>,
  scopes: readonly string[],
): Promise<Response> {
  if (
    context.actor.actorKind !== "human" ||
    record.value.provider !== "jira" ||
    record.value.id !== context.runId ||
    record.value.subjectId !== context.actor.subjectId ||
    record.value.sessionId !== context.actor.sessionId ||
    record.value.status !== "active"
  )
    throw new AuthorizationError("denied");
  const headers = {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
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
    !["awaiting-human", "uncertain"].includes(pending.state ?? "")
  )
    throw new AuthorizationError("denied");
  const bound = { ...context, nodeId: pending.node.id };
  const mode =
    pending.node.operationId === "jira.prepare-app" ? "app" : "recovery";
  if (mode === "recovery" && pending.node.operationId !== "jira.authorize-user")
    throw new AuthorizationError("denied");
  if (
    request.method === "GET" &&
    mode === "recovery" &&
    request.headers.get("accept") !== "application/json"
  ) {
    try {
      return new Response(null, {
        status: 303,
        headers: {
          ...headers,
          location: await children.authorization.humanUrl(bound),
        },
      });
    } catch {
      // A failed handoff cannot imply consent. Explicit restart rechecks expiry and the current run revision.
    }
  }
  const owner = context.actor.capabilities.includes("admin");
  const key = (ticket: string) => ({
    tenant: context.actor.tenantId,
    kind: "handoff" as const,
    id: `jira-collector:${ticket}`,
  });
  if (request.method === "POST") {
    const parsed = z
      .strictObject({
        ticket: z.uuid(),
        values: z.union([
          z.strictObject({
            clientId: z.string().min(1).max(16384),
            clientSecret: z.string().min(1).max(16384),
          }),
          z.strictObject({ restart: z.literal(true) }),
        ]),
      })
      .safeParse(await boundedJson(request, 40000));
    if (!parsed.success) throw new AuthorizationError("invalid_request");
    const { ticket, values } = parsed.data;
    if (
      (mode === "app" && (!owner || !("clientId" in values))) ||
      (mode === "recovery" && !("restart" in values))
    )
      throw new AuthorizationError("denied");
    const admission = await store.transaction(async (tx) => {
      const saved = await tx.get<Ticket>(key(ticket));
      if (
        !saved ||
        saved.value.expires <= (await tx.now()) ||
        saved.value.subject !== context.actor.subjectId ||
        saved.value.session !== context.actor.sessionId ||
        saved.value.runId !== context.runId ||
        saved.value.nodeId !== pending.node.id ||
        saved.value.revision !== record.revision ||
        saved.value.mode !== mode
      )
        throw new AuthorizationError("denied");
      return saved;
    });
    try {
      if ("clientId" in values)
        await children.configureApp(
          {
            ...bound,
            commandId: `collector:${ticket}`,
            effectId: `collector:${ticket}`,
          },
          record.revision,
          values,
        );
      else await children.authorization.restart(bound, record.revision);
    } finally {
      if ("clientId" in values) {
        values.clientId = "";
        values.clientSecret = "";
      }
    }
    await store.transaction((tx) => tx.delete(key(ticket), admission.revision));
    await advance();
    return Response.json({ returnUrl: request.url }, { headers });
  }
  if (request.method !== "GET") throw new AuthorizationError("denied");
  if (mode === "app" && !owner) {
    return new Response(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Jira integration setup needed</title><main><h1>Your integration owner needs to configure Jira</h1><p>This connection uses the host’s shared OAuth app. Ask the integration owner to configure it; you do not need to register a separate app or share an API token.</p><a href="${escape(returnUrl)}">Return to connection</a></main></html>`,
      {
        headers: {
          ...headers,
          "content-type": "text/html; charset=utf-8",
          "content-security-policy":
            "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        },
      },
    );
  }
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
        mode,
        expires: (await tx.now()) + 300000,
      } satisfies Ticket,
      null,
    ),
  );
  if (request.headers.get("accept") === "application/json")
    return Response.json({ ticket, mode }, { headers });
  const nonce = randomUUID();
  const title =
    mode === "app"
      ? "Configure Jira for this session"
      : "Restart Jira authorization";
  const content =
    mode === "app"
      ? `<p>Only the integration owner needs app setup. This private form configures the current session; a hosted integration should supply its shared app through trusted host configuration.</p><ol><li><a href="https://developer.atlassian.com/console/myapps/" target="_blank" rel="noopener noreferrer">Open the Atlassian developer console (new tab)</a>. Sign in or create your Atlassian account, then create or select an OAuth 2.0 integration.</li><li>Enable OAuth 2.0 (3LO) authorization with this exact callback: <code>${escape(`${context.origin}/api/v1/teaching/jira/authorization-return`)}</code>.</li><li>Add the Jira API permissions: <code>${escape(scopes.join(", "))}</code>. For other people to use the integration, configure its distribution in Atlassian.</li><li>Copy the client ID and secret from the app settings into this private form.</li></ol><form id="private"><label for="clientId">Client ID</label><input id="clientId" name="clientId" required maxlength="16384" autocomplete="off" spellcheck="false"><label for="clientSecret">Client secret</label><input id="clientSecret" name="clientSecret" type="password" required maxlength="16384" autocomplete="off"><button>Save app and continue</button></form><p>App configuration does not prove access. Atlassian will ask for any required login and consent next.</p>`
      : `<p>The authorization attempt expired or its result is uncertain. Starting again invalidates the old return link and asks Atlassian for fresh consent. It does not revoke an existing grant or repeat a consumed code.</p><form id="private"><label><input type="checkbox" required>I authorize a new consent attempt.</label><button>Restart authorization</button></form>`;
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style nonce="${nonce}">:root{color-scheme:light;font:16px/1.5 system-ui,sans-serif;color:#17212d;background:#f4f6f8;accent-color:#1749c7;scrollbar-color:#94a3b4 #f4f6f8}body{margin:0}main{box-sizing:border-box;max-width:680px;margin:40px auto;padding:24px;background:#fff}h1{font-size:28px;line-height:1.2;letter-spacing:-.02em;text-wrap:balance}p,li{max-width:65ch;overflow-wrap:anywhere}li+li{margin-top:12px}a{color:#1749c7;text-underline-offset:3px}form{margin-block:24px}label{display:block;font-weight:600}input:not([type=checkbox]){box-sizing:border-box;display:block;width:100%;margin-block:8px 16px;min-height:44px;border:1px solid #aebdce;border-radius:6px;padding:10px 12px;font:inherit;background:#fff;color:#17212d;caret-color:#1749c7}button{min-height:44px;border:0;border-radius:6px;background:#1749c7;color:#fff;padding:10px 16px;font:600 16px/1.5 system-ui;cursor:pointer}button:hover{background:#103aa5}button:disabled{opacity:.55;cursor:wait}:focus-visible{outline:2px solid #1749c7;outline-offset:3px}::selection{background:#d9e5ff;color:#152f70}#status{color:#a03620}@media(max-width:720px){main{margin:0;padding:24px 20px;min-height:100dvh}}</style></head><body><main><h1>${title}</h1>${content}<p>Private inputs go only to the broker and provider, never the assistant or demonstration.</p><p id="status" role="status" aria-live="polite"></p><a href="${escape(returnUrl)}">Return to connection</a></main><script nonce="${nonce}">const form=document.getElementById('private');form.addEventListener('submit',async event=>{event.preventDefault();const values=${mode === "app" ? "Object.fromEntries(new FormData(form))" : "{restart:true}"};form.reset();const button=form.querySelector('button');button.disabled=true;try{const admission=await fetch(location.pathname,{headers:{accept:'application/json'},credentials:'same-origin',cache:'no-store'});if(!admission.ok)throw new Error();const fresh=await admission.json();if(fresh.mode!==${JSON.stringify(mode)})throw new Error();const response=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify({ticket:fresh.ticket,values})});if(!response.ok)throw new Error();location.assign((await response.json()).returnUrl)}catch{document.getElementById('status').textContent='This step could not finish. Check the current connection status before trying again.';button.disabled=false}finally{for(const key of Object.keys(values))delete values[key]}});addEventListener('pagehide',()=>form.reset());</script></body></html>`,
    {
      headers: {
        ...headers,
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
      },
    },
  );
}
