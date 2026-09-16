import { z } from "zod";
import { assertRequestBoundary, boundedText } from "./authorization.js";
import { AuthorizationError, requireCapability } from "./identity.js";
import type { AsyncCeremonyStore, StoredRecord } from "./persistence/index.js";
import type { RunRecord } from "./commands.js";
import type { OperationContext } from "./recipes/registry.js";
import {
  accountMatchesIntent,
  authoredAccountKey,
  authoredAccountIntentKey,
  type AuthoredAccountIntent,
} from "./authored-operations.js";

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const accountSchema = z.strictObject({
  username: z.string().min(1).max(254),
  password: z.string().min(1).max(1024),
  email: z.string().max(254).optional(),
});

/** Private human disclosure. The caller authorizes claim-account before this final transactional fence. */
export async function authoredAccountClaim(
  store: AsyncCeremonyStore,
  context: OperationContext,
  record: StoredRecord<RunRecord>,
  request: Request,
  returnUrl: string,
): Promise<Response> {
  requireCapability(context.actor, "executor");
  if (context.actor.actorKind !== "human")
    throw new AuthorizationError("denied");
  assertRequestBoundary(request, {
    origin: context.origin,
    maxBytes: 256,
    contentTypes: ["application/x-www-form-urlencoded"],
  });
  if (!["GET", "POST"].includes(request.method))
    throw new AuthorizationError("denied");
  const reveal = request.method === "POST";
  if (reveal) {
    const form = new URLSearchParams(await boundedText(request, 256));
    if (form.size !== 1 || form.get("action") !== "reveal")
      throw new AuthorizationError("invalid_request");
  }
  const account = await store.transaction(async (tx) => {
    const current = await tx.get<RunRecord>({
      tenant: context.actor.tenantId,
      kind: "run",
      id: context.runId,
    });
    if (
      !current ||
      current.revision !== record.revision ||
      current.value.id !== context.runId ||
      current.value.subjectId !== context.actor.subjectId ||
      current.value.sessionId !== context.actor.sessionId ||
      !["active", "complete"].includes(current.value.status)
    )
      throw new AuthorizationError("denied");
    let verified = false;
    for (const node of current.value.nodes) {
      if (
        !["authored.register-account", "authored.authorize-user"].includes(
          node.operationId,
        )
      )
        continue;
      const state = await tx.get<{ verified: boolean }>({
        tenant: context.actor.tenantId,
        kind: "node",
        id: `${context.runId}:${node.id}`,
      });
      if (state?.value.verified) verified = true;
    }
    if (!verified) throw new AuthorizationError("denied");
    const intent = await tx.get<AuthoredAccountIntent>(
      authoredAccountIntentKey(context.actor, context.runId),
    );
    const stored = await tx.get(
      authoredAccountKey(context.actor, current.value.provider),
    );
    const parsed = accountSchema.safeParse(stored?.value);
    if (
      !intent ||
      !parsed.success ||
      !accountMatchesIntent(parsed.data, intent.value)
    )
      throw new AuthorizationError("denied");
    return parsed.data;
  });
  const content = reveal
    ? `<p>Save these credentials in your password manager. Do not paste them into chat. This does not grant or verify resource access.</p><p><label>Account <input name="username" value="${escape(account.username)}" readonly autocomplete="off"></label></p>${account.email ? `<p><label>Email <input name="email" value="${escape(account.email)}" readonly autocomplete="off"></label></p>` : ""}<p><label>Password <input name="password" value="${escape(account.password)}" readonly autocomplete="off" spellcheck="false"></label></p>`
    : `<p>Your saved account credentials stay private until you choose to display them here. They are not sent to the assistant or included in the connection status.</p><form method="post" action="${escape(new URL(request.url).pathname)}"><button name="action" value="reveal">Show saved account credentials</button></form>`;
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Saved account credentials</title></head><body><main><h1>Saved account credentials</h1>${content}<p><a href="${escape(returnUrl)}">Return to connection</a></p></main></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        // A no-referrer landing page makes native form POSTs send Origin: null.
        "referrer-policy": reveal ? "no-referrer" : "same-origin",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      },
    },
  );
}
