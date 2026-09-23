import type { LoginEvidence } from "../core/browser-session-contracts.js";
import type { ActorContext } from "../core/operation-contracts.js";
import type {
  CredentialSource,
  LoginServiceOptions,
} from "./browser-login-service.js";
import type {
  BrowserLoginToolDeps,
  BrowserLoginTools,
} from "./browser-login-tools.js";
import type { BrowserSessionRegistry } from "./browser-sessions.js";
import type { SessionVerifier } from "./browser-verification.js";
import type { AsyncCeremonyStore } from "./persistence/index.js";
import { RecordedCeremonies } from "./recorded-ceremonies.js";

/**
 * The retained-browser login tools, assembled the way a host runs them.
 *
 * Every piece already existed — the session registry, the effect ledger, the
 * verifier registry, the login service and the shared tools — and was only
 * ever put together inside tests. So no host offered `browser_login`, and the
 * MCP and HTTP surfaces that register it when a runtime carries it never did.
 * This is that assembly, once, so a host supplies its decisions and nothing
 * else.
 *
 * What a host must decide, because nothing here can decide it for them:
 *
 * - `credentials`: how a collector reference becomes a value. There is no
 *   default. A host with no private collector for browser logins passes one
 *   that resolves nothing, and plans that need a credential then stop by name.
 * - `knownConnectors`: which connectors a login may name. An unknown one is
 *   rejected; nothing falls back to the first.
 * - `verifiers`: which providers can say whose session a browser holds.
 *   Without one for an origin, the honest ceiling is `submitted-unverified`.
 *
 * Nothing heavy loads until the first call. A deployment that configures this
 * and never logs anybody in does not start a browser driver, which is the
 * same promise the tools make about their backend list.
 *
 * Recorded ceremonies come with it, kept in the same `store`: an author may
 * record a login as a draft, people review and publish it, and a plan naming
 * the published version replays it with no model. That needs no decision
 * from the host beyond the ones above, so it is not an option.
 */
export type HostBrowserLoginOptions = {
  store: AsyncCeremonyStore;
  credentials: CredentialSource;
  knownConnectors: BrowserLoginToolDeps["knownConnectors"];
  /** Verifiers the host has reviewed. Registered here, never by a caller. */
  verifiers?: readonly SessionVerifier[];
  credentialRefs?: BrowserLoginToolDeps["credentialRefs"];
  allowUnverified?: boolean;
  human?: BrowserLoginToolDeps["human"];
  backends?: BrowserLoginToolDeps["backends"];
  launch?: LoginServiceOptions["launch"];
  modelInterpreter?: LoginServiceOptions["modelInterpreter"];
  /**
   * Keep each verified session, encrypted in `store`, and start the next
   * login for the same subject, connector, origin and account from it. Off
   * unless a host turns it on: a saved state is a bearer credential.
   */
  reuseVerifiedSessions?: boolean;
};

/**
 * The evidence behind each session this process established, so a status
 * read can recompute `verified` from evidence in hand instead of reporting a
 * remembered label. Secret-free, and process-local for the same reason the
 * live browsers are: a session this process no longer holds is reported lost
 * regardless of what is remembered about it. An entry goes when its session
 * is released, or a long-running host would keep one for every login it ever
 * ran.
 */
export function withEvidenceLedger(registry: BrowserSessionRegistry) {
  const ledger = new Map<string, LoginEvidence>();
  const evidenceKey = (actor: ActorContext, sessionRef: string) =>
    JSON.stringify([actor.tenantId, actor.subjectId, sessionRef]);
  const sessions: BrowserSessionRegistry = {
    ...registry,
    async recordEvidence(actor, sessionRef, evidence, evidenceRef) {
      const recorded = await registry.recordEvidence(
        actor,
        sessionRef,
        evidence,
        evidenceRef,
      );
      ledger.set(evidenceKey(actor, sessionRef), evidence);
      return recorded;
    },
    async release(actor, sessionRef, kind) {
      const released = await registry.release(actor, sessionRef, kind);
      // Cancelling a run stops dispatch and leaves the session in place.
      if (kind !== "cancel-run") ledger.delete(evidenceKey(actor, sessionRef));
      return released;
    },
  };
  const evidenceFor = async (actor: ActorContext, sessionRef: string) =>
    ledger.get(evidenceKey(actor, sessionRef));
  return { sessions, evidenceFor };
}

export function createHostBrowserLogin(
  options: HostBrowserLoginOptions,
): BrowserLoginTools {
  let built: Promise<BrowserLoginTools> | undefined;
  const recordings = new RecordedCeremonies(options.store);
  const tools = () =>
    (built ??= (async () => {
      const [
        { createBrowserSessionRegistry },
        { createEffectLedger },
        { createVerifierRegistry },
        { createBrowserLoginService },
        { createBrowserLoginTools },
        { createBrowserStateStore },
      ] = await Promise.all([
        import("./browser-sessions.js"),
        import("./browser-effects.js"),
        import("./browser-verification.js"),
        import("./browser-login-service.js"),
        import("./browser-login-tools.js"),
        import("./browser-state.js"),
      ]);
      const registry = createBrowserSessionRegistry({ store: options.store });
      const { sessions, evidenceFor } = withEvidenceLedger(registry);
      const service = createBrowserLoginService({
        sessions,
        verifiers: createVerifierRegistry(options.verifiers ?? []),
        credentials: options.credentials,
        effects: createEffectLedger({ store: options.store }),
        ...(options.launch ? { launch: options.launch } : {}),
        ...(options.modelInterpreter
          ? { modelInterpreter: options.modelInterpreter }
          : {}),
        ...(options.reuseVerifiedSessions === true
          ? { states: createBrowserStateStore({ store: options.store }) }
          : {}),
      });
      return createBrowserLoginTools({
        service,
        sessions,
        knownConnectors: options.knownConnectors,
        ...(options.backends ? { backends: options.backends } : {}),
        ...(options.credentialRefs
          ? { credentialRefs: options.credentialRefs }
          : {}),
        ...(options.allowUnverified === true ? { allowUnverified: true } : {}),
        ...(options.human ? { human: options.human } : {}),
        // The compiler refuses a draft asking for inference on a host with no
        // model. Without this a host that configured one had every such draft
        // refused anyway, which read as "no model" to a host that had one.
        ...(options.modelInterpreter ? { modelAvailable: true } : {}),
        recordings,
        evidenceFor,
      });
    })().catch((error: unknown) => {
      // A failed assembly is retried on the next call rather than cached as
      // a permanent refusal.
      built = undefined;
      throw error;
    }));
  return {
    login: async (actor, input) => (await tools()).login(actor, input),
    sessionStatus: async (actor, input) =>
      (await tools()).sessionStatus(actor, input),
    release: async (actor, input) => (await tools()).release(actor, input),
    backends: async (actor, input) => (await tools()).backends(actor, input),
    recordLogin: async (actor, input) =>
      (await tools()).recordLogin(actor, input),
    readRecording: async (actor, input) =>
      (await tools()).readRecording(actor, input),
    recordings,
  };
}
