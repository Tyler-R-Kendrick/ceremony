import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ActorContext } from "../core/operation-contracts.js";
import {
  createTeachingRuntime,
  githubConnectionRecipe,
  type TeachingRuntime,
  type TeachingRuntimeOptions,
} from "./teaching-runtime.js";
import {
  OperationRegistry,
  type OperationContext,
} from "./recipes/registry.js";
import {
  AsyncGitHubChildren,
  githubVocabulary,
  resolveGitHubInstallationRun,
  type AsyncGitHubOptions,
} from "./recipes/github.js";
import { type AsyncCeremonyStore } from "./persistence/index.js";
import { AuthorizationError, type HostIdentityAdapter } from "./identity.js";
import type { RunRecord } from "./commands.js";
import type { ModelConfiguration } from "./agent/model.js";
import { AsyncPrivateCollectionBroker } from "./persistence/collections.js";
import { boundedJson, assertRequestBoundary } from "./authorization.js";
import { appendSemanticTransition } from "./demonstrations.js";
import {
  AsyncStripeChildren,
  stripeConnectionRecipe,
  stripeVocabulary,
} from "./recipes/stripe.js";
import { stripeHuman } from "./stripe-human.js";

export interface GitHubRuntimeOptions {
  store: AsyncCeremonyStore;
  identity: HostIdentityAdapter;
  origin: string;
  environment: string;
  configurationVersion: string;
  /** Trusted host UI route. Never accepted from a callback, recipe, or tool argument. */
  returnPath?: string;
  expectedAccount?: string;
  modelConfiguration?: ModelConfiguration;
  github?: Partial<Pick<AsyncGitHubOptions, "app" | "fetch">>;
  stripe?: {
    configuration(
      actor: ActorContext,
    ): Promise<{ version: string; token?: string }>;
    fetch?: typeof fetch;
  };
  authorize(
    actor: ActorContext,
    run: RunRecord,
    operationId: string,
  ): Promise<boolean>;
  /** Explicit host policy for a human-chosen account; never a model-generated wildcard. */
  allowTarget?(actor: ActorContext, target: string): Promise<boolean>;
  continuation?: TeachingRuntimeOptions["continuation"];
  /** Trusted private session configuration; checked again at each provider boundary. */
  configuration?(
    actor: ActorContext,
  ): Promise<{ configurationVersion: string; app?: AsyncGitHubOptions["app"] }>;
}
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function createGitHubRuntime(
  options: GitHubRuntimeOptions,
): TeachingRuntime {
  const { store, identity, origin } = options;
  const broker = new AsyncPrivateCollectionBroker(store);
  const registry = new OperationRegistry(
    new Map([...githubVocabulary, ...(options.stripe ? stripeVocabulary : [])]),
  );
  const targetKey = (actor: ActorContext) => ({
    tenant: actor.tenantId,
    kind: "session" as const,
    id: `target:${createHash("sha256").update(actor.subjectId).digest("hex")}`,
  });
  const configuration = (actor: ActorContext) =>
    options.configuration?.(actor) ??
    Promise.resolve({
      configurationVersion: options.configurationVersion,
      ...(options.github?.app ? { app: options.github.app } : {}),
    });
  const authorize = async (
    actor: ActorContext,
    run: RunRecord,
    operationId: string,
  ) =>
    (operationId === "continuation" ||
      (run.provider === "stripe"
        ? (await options.stripe?.configuration(actor))?.version
        : (await configuration(actor)).configurationVersion) ===
        run.configurationVersion) &&
    (await options.authorize(actor, run, operationId));
  const childOptions = {
    origin,
    environment: options.environment,
    configurationVersion: options.configurationVersion,
    ...(options.expectedAccount
      ? { expectedAccount: options.expectedAccount }
      : {}),
    ...options.github,
    authorize: async (context) => {
      const run = await store.transaction((tx) =>
        tx.get<RunRecord>({
          tenant: context.actor.tenantId,
          kind: "run",
          id: context.runId,
        }),
      );
      if (
        !run ||
        run.value.subjectId !== context.actor.subjectId ||
        run.value.status === "cancelled" ||
        !(await authorize(context.actor, run.value, run.value.provider))
      )
        throw new AuthorizationError("denied");
    },
  } satisfies AsyncGitHubOptions;
  const stripe = options.stripe
    ? new AsyncStripeChildren(store, {
        configuration: (context) =>
          options.stripe!.configuration(context.actor),
        authorize: childOptions.authorize,
        ...(options.stripe.fetch ? { fetch: options.stripe.fetch } : {}),
      })
    : undefined;
  stripe?.register(registry);
  const childrenFor = async (context: OperationContext) => {
    const config = await configuration(context.actor);
    if (config.configurationVersion !== context.configurationVersion)
      throw new AuthorizationError("denied");
    return new AsyncGitHubChildren(store, {
      ...childOptions,
      configurationVersion: config.configurationVersion,
      ...(config.app ? { app: config.app } : {}),
    });
  };
  const contractRegistry = new OperationRegistry(githubVocabulary);
  new AsyncGitHubChildren(store, childOptions).register(contractRegistry);
  for (const contract of contractRegistry.catalog()) {
    const operation = contractRegistry.require(contract.id, contract.version);
    const bound = async (context: OperationContext) => {
      const registered = new OperationRegistry(githubVocabulary);
      (await childrenFor(context)).register(registered);
      return registered.require(contract.id, contract.version);
    };
    registry.register({
      ...operation,
      handler: async (context, inputs) =>
        (await bound(context)).handler(context, inputs),
      verify: async (context, result) =>
        Boolean(await (await bound(context)).verify?.(context, result)),
    });
  }
  const operationContext = (
    actor: ActorContext,
    record: RunRecord,
  ): OperationContext => ({
    actor,
    runId: record.id,
    nodeId: "human",
    commandId: `human:${record.id}`,
    effectId: `human:${record.id}`,
    target: record.target,
    configurationVersion: record.configurationVersion,
    origin,
    environment: record.environment,
    signal: AbortSignal.timeout(30_000),
  });
  const returnPath = options.returnPath ?? "/";
  const returnBase = new URL(returnPath, origin);
  if (
    !returnPath.startsWith("/") ||
    returnPath.startsWith("//") ||
    returnPath.length > 512 ||
    returnBase.origin !== origin ||
    returnBase.search ||
    returnBase.hash
  )
    throw new Error("Invalid host return path");
  const returnUrl = (runId: string) => {
    const target = new URL(returnBase);
    target.searchParams.set("teachingRun", runId);
    return target.href;
  };
  const headers = {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
  const runtime = createTeachingRuntime({
    store,
    identity,
    registry,
    origin,
    connections: new Map([
      [
        "github",
        {
          definition: githubConnectionRecipe,
          outputContract: "github.connection",
          revalidateOperation: "github.verify-access",
        },
      ],
      ...(stripe
        ? [
            [
              "stripe",
              {
                definition: stripeConnectionRecipe,
                outputContract: "stripe.connection",
                revalidateOperation: "stripe.verify-access",
              },
            ] as const,
          ]
        : []),
    ]),
    ...(options.modelConfiguration
      ? { modelConfiguration: options.modelConfiguration }
      : {}),
    ...(options.continuation ? { continuation: options.continuation } : {}),
    authorize,
    humanReturn: async (actor, request) => {
      const url = new URL(request.url);
      const runId = await resolveGitHubInstallationRun(
        store,
        actor,
        origin,
        url,
      ).catch(() => {
        throw new AuthorizationError("denied");
      });
      url.pathname = `/api/v1/teaching/github/${encodeURIComponent(runId)}/callback`;
      return runtime.human!(
        actor,
        runId,
        new Request(url, { headers: request.headers }),
      );
    },
    cancel: async (actor, runId) => {
      const record = await store.transaction((tx) =>
        tx.get<RunRecord>({ tenant: actor.tenantId, kind: "run", id: runId }),
      );
      if (
        !record ||
        record.value.subjectId !== actor.subjectId ||
        record.value.status !== "cancelled"
      )
        throw new AuthorizationError("denied");
      if (record.value.provider === "stripe") return;
      // Cancellation must still fence the old handoff after configuration rotation.
      const context = operationContext(actor, record.value);
      // The authoritative run fence above remains valid even when retired configuration cannot be loaded.
      if (
        (await configuration(actor)).configurationVersion ===
        record.value.configurationVersion
      )
        await (await childrenFor(context)).cancel(context);
    },
    context: async (actor, connectorId) => {
      if (connectorId === "stripe" && options.stripe)
        return {
          provider: "stripe",
          profile: "stripe-api-key",
          target: "self",
          origin,
          environment: options.environment,
          configurationVersion: (await options.stripe.configuration(actor))
            .version,
        };
      const config = await configuration(actor);
      const target =
        options.expectedAccount ??
        (
          await store.transaction((tx) =>
            tx.get<{ target: string }>(targetKey(actor)),
          )
        )?.value.target;
      if (!target) throw new Error("account-required");
      return {
        provider: "github",
        profile: "github-app",
        target,
        origin,
        environment: options.environment,
        configurationVersion: config.configurationVersion,
      };
    },
    selectTarget: async (actor, target) => {
      if (
        !/^[a-zA-Z0-9-]{1,100}$/.test(target) ||
        !options.allowTarget ||
        !(await options.allowTarget(actor, target))
      )
        throw new AuthorizationError("denied");
      await store.transaction(async (tx) => {
        const prior = await tx.get(targetKey(actor));
        await tx.put(targetKey(actor), { target }, prior?.revision ?? null);
      });
    },
    human: async (actor, runId, request) => {
      let record = await store.transaction((tx) =>
        tx.get<RunRecord>({ tenant: actor.tenantId, kind: "run", id: runId }),
      );
      let callbackUrl = new URL(request.url);
      if (
        !record ||
        callbackUrl.pathname.split("/")[4] !== record.value.provider
      )
        throw new AuthorizationError("denied");
      if (
        record?.value.subjectId === actor.subjectId &&
        record.value.status === "cancelled" &&
        actor.actorKind === "human" &&
        callbackUrl.pathname.endsWith("/callback")
      ) {
        const original = operationContext(actor, record.value);
        const surviving = await (
          await childrenFor(original)
        )
          .activeSetupSubscriber(original, callbackUrl)
          .catch(() => {
            throw new AuthorizationError("denied");
          });
        record = await store.transaction((tx) =>
          tx.get<RunRecord>({
            tenant: actor.tenantId,
            kind: "run",
            id: surviving,
          }),
        );
        runId = surviving;
        callbackUrl = new URL(callbackUrl);
        callbackUrl.pathname = `/api/v1/teaching/github/${encodeURIComponent(surviving)}/callback`;
      }
      if (
        !record ||
        record.value.subjectId !== actor.subjectId ||
        record.value.status !== "active"
      )
        throw new AuthorizationError("denied");
      if (
        actor.actorKind !== "human" ||
        !(await authorize(
          actor,
          record.value,
          `${record.value.provider}.human`,
        ))
      )
        throw new AuthorizationError("denied");
      const context = operationContext(actor, record.value);
      if (record.value.provider === "stripe") {
        if (
          !stripe ||
          decodeURIComponent(new URL(request.url).pathname) !==
            `/api/v1/teaching/stripe/${runId}/human`
        )
          throw new AuthorizationError("denied");
        const stripeReturn = new URL(returnUrl(runId));
        stripeReturn.searchParams.set("connector", "stripe");
        return stripeHuman(
          store,
          stripe,
          context,
          record,
          request,
          stripeReturn.href,
          () => advance(actor, runId),
        );
      }
      const children = await childrenFor(context);
      if (new URL(request.url).pathname.endsWith("/recovery")) {
        const node = record.value.nodes.find(
          (node) => node.operationId === "github.prepare-app",
        );
        if (!node) throw new AuthorizationError("denied");
        const state = await store.transaction((tx) =>
          tx.get<{ state: string }>({
            tenant: actor.tenantId,
            kind: "node",
            id: `${runId}:${node.id}`,
          }),
        );
        if (state?.value.state !== "uncertain")
          throw new AuthorizationError("denied");
        const binding = {
          purpose: "github-app-recovery",
          provider: "github",
          operationId: "github.prepare-app",
          operationVersion: "1.0.0",
          runId,
          nodeId: node.id,
          revision: record.revision,
          fields: ["appId", "pem"],
        };
        type Ticket = {
          subject: string;
          session: string;
          runId: string;
          revision: number;
          expires: number;
          reference?: string;
          complete?: boolean;
        };
        if (request.method === "POST") {
          assertRequestBoundary(request, { origin, maxBytes: 65536 });
          const input = z
            .union([
              z.strictObject({
                ticket: z.uuid(),
                appId: z.string().regex(/^[1-9][0-9]{0,15}$/),
                pem: z.string().min(1).max(30000),
              }),
              z.strictObject({ ticket: z.uuid(), restart: z.literal(true) }),
            ])
            .parse(await boundedJson(request, 65536));
          const key = {
            tenant: actor.tenantId,
            kind: "handoff" as const,
            id: `recovery:${input.ticket}`,
          };
          const prior = await store.transaction((tx) => tx.get<Ticket>(key));
          if (
            !prior ||
            prior.value.subject !== actor.subjectId ||
            prior.value.session !== actor.sessionId ||
            prior.value.runId !== runId ||
            prior.value.revision !== record.revision
          )
            throw new AuthorizationError("denied");
          if (
            prior.value.complete ||
            prior.value.expires <= (await store.transaction((tx) => tx.now()))
          )
            throw new AuthorizationError("denied");
          let reference: string | undefined;
          const restarting = "restart" in input;
          if (!restarting) {
            reference =
              prior.value.reference ??
              (await broker.collect(actor, binding, {
                appId: input.appId,
                pem: input.pem,
              }));
            const commandId = `recovery:${input.ticket}`;
            const boundReference = reference;
            const material = await store.transaction(async (tx) => {
              const ticket = await tx.get<Ticket>(key);
              const current = await tx.get<RunRecord>({
                tenant: actor.tenantId,
                kind: "run",
                id: runId,
              });
              if (
                !ticket ||
                ticket.value.expires <= (await tx.now()) ||
                ticket.value.complete ||
                !current ||
                current.revision !== binding.revision ||
                current.value.status !== "active"
              )
                throw new AuthorizationError("denied");
              if (
                ticket.value.reference &&
                ticket.value.reference !== boundReference
              )
                throw new AuthorizationError("denied");
              const values = await broker.consumeIn(
                tx,
                actor,
                binding,
                boundReference,
                commandId,
              );
              if (values.appId !== input.appId || values.pem !== input.pem)
                throw new AuthorizationError("denied");
              await tx.put(
                key,
                { ...ticket.value, reference: boundReference },
                ticket.revision,
              );
              return values;
            });
            await children.recover(
              { ...context, commandId, effectId: commandId },
              { appId: Number(material.appId), pem: material.pem },
            );
          }
          if (!(await authorize(actor, record.value, "github.prepare-app")))
            throw new AuthorizationError("denied");
          await store.transaction(async (tx) => {
            const runKey = {
              tenant: actor.tenantId,
              kind: "run" as const,
              id: runId,
            };
            const current = await tx.get<RunRecord>(runKey);
            const nodeKey = {
              tenant: actor.tenantId,
              kind: "node" as const,
              id: `${runId}:${node.id}`,
            };
            const pending = await tx.get<{ state: string }>(nodeKey);
            const ticket = await tx.get<Ticket>(key);
            if (
              !ticket ||
              ticket.value.complete ||
              ticket.value.expires <= (await tx.now()) ||
              (restarting && ticket.value.reference !== undefined) ||
              !current ||
              current.value.status !== "active" ||
              current.revision !== binding.revision ||
              pending?.value.state !== "uncertain"
            )
              throw new AuthorizationError("denied");
            const fence = await tx.claim(
              runKey,
              `recovery-${randomUUID()}`,
              30000,
            );
            if (restarting) await children.restartRegistration(context, tx);
            await tx.put(
              nodeKey,
              { state: "verifying", verified: false, outputs: {} },
              pending.revision,
            );
            const revision = await tx.put(
              runKey,
              current.value,
              current.revision,
            );
            await appendSemanticTransition(
              tx,
              actor,
              runId,
              {
                nodeId: node.id,
                operationId: node.operationId,
                operationVersion: node.operationVersion,
                actorKind: "human",
                kind: "transition",
                beforeState: "uncertain",
                afterState: "verifying",
                publicBindings: {},
                verification: "pending",
              },
              {},
            );
            await tx.put(
              {
                tenant: actor.tenantId,
                kind: "outbox",
                id: `recovery:${runId}:${revision}`,
              },
              {
                task: restarting ? "recovery-restarted" : "recovery-verified",
                runId,
                subjectId: actor.subjectId,
                status: "pending",
              },
              null,
            );
            if (ticket)
              await tx.put(
                key,
                { ...ticket.value, complete: true },
                ticket.revision,
              );
            await tx.assertFence(fence);
            await tx.cancel(runKey);
          });
          if (reference)
            await broker.complete(
              actor,
              binding,
              reference,
              `recovery:${input.ticket}`,
            );
          await advance(actor, runId);
          return Response.json({ returnUrl: returnUrl(runId) }, { headers });
        }
        const ticket = randomUUID();
        await store.transaction(async (tx) =>
          tx.put(
            {
              tenant: actor.tenantId,
              kind: "handoff",
              id: `recovery:${ticket}`,
            },
            {
              subject: actor.subjectId,
              session: actor.sessionId,
              runId,
              revision: record.revision,
              expires: (await tx.now()) + 300000,
            } satisfies Ticket,
            null,
          ),
        );
        const nonce = randomUUID();
        const restartAvailable =
          await children.registrationRestartAvailable(context);
        return new Response(
          `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Recover GitHub setup</title><main><h1>Recover your existing GitHub App</h1><p>The registration response was interrupted or expired. Check your GitHub App settings first. If an app exists, enter its ID and private key here. These go directly to the private broker, never the assistant or demonstration.</p><form id="private"><label>App ID<input name="appId" inputmode="numeric" required autocomplete="off"></label><label>Private key<textarea name="pem" required autocomplete="off" spellcheck="false"></textarea></label><button>Verify existing app</button></form>
          ${restartAvailable ? `<details><summary>No app was created?</summary><p>Starting again invalidates the old return link. Any app already created on GitHub remains there; this does not delete or revoke it. Check GitHub before authorizing a new registration.</p><form id="restart"><label><input type="checkbox" required>I checked GitHub and authorize a new app registration.</label><button>Start a new registration</button></form></details>` : ""}
          <p id="status" role="status"></p><a href="${escape(returnUrl(runId))}">Return to connection</a></main><script nonce="${nonce}">
          async function submit(body){try{const response=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),cache:'no-store',credentials:'same-origin'});if(!response.ok)throw new Error();const result=await response.json();location.assign(result.returnUrl);}catch{document.getElementById('status').textContent='Recovery could not finish. Return to the connection to check its current status.'}}
          const form=document.getElementById('private');form.addEventListener('submit',event=>{event.preventDefault();const data=new FormData(form);const body={ticket:${JSON.stringify(ticket)},appId:data.get('appId'),pem:data.get('pem')};form.reset();void submit(body)});
          document.getElementById('restart')?.addEventListener('submit',event=>{event.preventDefault();void submit({ticket:${JSON.stringify(ticket)},restart:true})});addEventListener('pagehide',()=>form.reset());</script></html>`,
          {
            headers: {
              ...headers,
              "content-type": "text/html; charset=utf-8",
              "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
            },
          },
        );
      }
      if (new URL(request.url).pathname.endsWith("/callback")) {
        try {
          await children.callback(context, callbackUrl);
        } catch {
          await advance(actor, runId);
          return new Response(
            `<!doctype html><html lang="en"><title>GitHub needs attention</title><main><h1>GitHub could not confirm this return</h1><p>No authorization was inferred from this callback. Return to the connection for the current verified status and recovery options.</p><a href="${escape(returnUrl(runId))}">Return to connection</a></main></html>`,
            {
              status: 409,
              headers: {
                ...headers,
                "content-type": "text/html; charset=utf-8",
                "content-security-policy":
                  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
              },
            },
          );
        }
        await advance(actor, runId);
        return new Response(null, {
          status: 303,
          headers: {
            location: returnUrl(runId),
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          },
        });
      }
      const handoff = await children.human(context).catch(async () => {
        await advance(actor, runId);
        return undefined;
      });
      if (!handoff)
        return new Response(
          `<!doctype html><html lang="en"><meta charset="utf-8"><title>GitHub needs attention</title><main><h1>GitHub setup needs attention</h1><p>The handoff expired or GitHub could not verify the selected account. Your completed steps are preserved. Return to check the account or recover this registration.</p><a href="${escape(returnUrl(runId))}">Return to connection</a></main></html>`,
          {
            status: 409,
            headers: {
              ...headers,
              "content-type": "text/html; charset=utf-8",
              "content-security-policy":
                "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
            },
          },
        );
      if (handoff.method === "GET")
        return new Response(null, {
          status: 303,
          headers: {
            location: handoff.url,
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          },
        });
      const nonce = randomUUID();
      return new Response(
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Continue with GitHub</title><main><h1>Continue at GitHub</h1><p>GitHub will ask you to confirm the app and its permissions. If you are not redirected, continue below.</p><form id="handoff" method="post" action="${escape(handoff.url)}"><input type="hidden" name="manifest" value="${escape(JSON.stringify(handoff.manifest))}"><button>Continue with GitHub</button></form></main><script nonce="${nonce}">document.getElementById('handoff').submit();</script></html>`,
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; form-action https://github.com; frame-ancestors 'none'; base-uri 'none'`,
          },
        },
      );
    },
  });
  async function advance(actor: ActorContext, runId: string) {
    let run = await runtime.commands.snapshot(actor, runId);
    for (const node of run.nodes) {
      if (node.verified) continue;
      const result = await runtime.commands.advance(
        actor,
        runId,
        node.id,
        run.revision,
        `return:${runId}:${node.id}:${run.revision}`,
      );
      run = await runtime.commands.snapshot(actor, runId);
      if (result.state !== "complete") break;
    }
  }
  return runtime;
}
