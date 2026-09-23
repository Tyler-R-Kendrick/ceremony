import {
  loginResultSchema,
  mintReference,
  type BrowserOperationReason,
  type LoginEvidence,
  type LoginResult,
} from "../core/browser-session-contracts.js";
import type { ActorContext } from "../core/operation-contracts.js";
import {
  ceremonyRoles,
  derivedRoleOf,
  heldCredentialKinds,
  heldSecretRoles,
  issuedFieldsOf,
  type CeremonyGoal,
  type CeremonyRole,
  type HeldCredentialKind,
  type IssuedSinkKind,
} from "../core/browser-contracts.js";
import {
  launchManagedBrowser,
  UnsupportedBackend,
  type ManagedBrowser,
  type ManagedContext,
} from "./browser-backends.js";
import {
  compileRecording,
  RecordingRejected,
  type RecordedCeremony,
  type RecordedTraceEntry,
  type RecordingReference,
  type RecordingRejectionReason,
} from "../core/recorded-ceremony.js";
import {
  CeremonySecretLeak,
  createSecrets,
  runCeremony,
  runRecordedCeremony,
  type CeremonyPage,
  type CeremonyResult,
  type HumanParticipation,
  type IssuedValues,
  type RecordingDrift,
} from "./browser-driver.js";
import {
  createHeuristicInterpreter,
  type CeremonyInterpreter,
} from "./browser-interpreter.js";
import type { BrowserSessionRegistry } from "./browser-sessions.js";
import {
  mintAttestation,
  mintLoginEvidence,
  type VerifierRegistry,
} from "./browser-verification.js";
import { recipientsFor, type EffectiveLoginPlan } from "./login-plan.js";
import { effectIsIndeterminate, type EffectLedger } from "./browser-effects.js";
import { totpCode, totpSeedSpellings } from "./totp.js";
import { storageStateSchema, type BrowserStateStore } from "./browser-state.js";

/**
 * One authorized browser login, end to end.
 *
 * The order here is the product requirement in miniature: resolve the plan,
 * open the *selected* browser, drive a deterministic login, prove which account
 * is present in that exact context, and only then decide whether the session
 * stays. Each of those can fail in its own way and each failure has its own
 * outcome, because "it didn't work" is not something a caller can act on.
 *
 * Two things this deliberately does not do. It does not accept a URL, socket or
 * profile path as a target — the plan names a backend the server registered. And
 * it does not let a successful drive stand in for verification: a page that says
 * "welcome back" has said nothing about whose session it is.
 */

/** Values resolved privately, inside this trusted path, never handed outward. */
export interface CredentialSource {
  /**
   * Resolve one role for one plan. Implementations read the existing private
   * collector; a reference is not a value and resolution is authorized here.
   *
   * A held credential kind — a `totp-seed` — is resolved the same way and is
   * never handed onward: the service derives the role's value from it at fill
   * time, and the kind itself is never offered to an interpreter.
   */
  resolve(
    actor: ActorContext,
    plan: EffectiveLoginPlan,
    role: CeremonyRole | HeldCredentialKind,
  ): Promise<string | undefined>;
}

/**
 * Where a plan's issued values go: a host function, registered by kind.
 *
 * The host writes them somewhere trusted and bound to this run - a
 * `common.oauth-client` record through `mintOAuthClient`, keyed by `runRef`,
 * or its private collector - and returns nothing. Nothing it is given, and
 * nothing it could return, reaches the login's result, its steps, a
 * recording or an interpreter; the run reference is how the host's own next
 * step finds what was kept.
 */
export type IssuedValueSink = (
  actor: ActorContext,
  run: { runRef: string; plan: EffectiveLoginPlan },
  values: IssuedValues,
) => Promise<void>;

export type LoginServiceOptions = {
  sessions: BrowserSessionRegistry;
  verifiers: VerifierRegistry;
  credentials: CredentialSource;
  /** Swapped in tests; production passes the real launcher. */
  launch?: typeof launchManagedBrowser;
  now?: () => number;
  /** How long verified evidence stays fresh before it must be re-established. */
  evidenceFreshnessMs?: number;
  /**
   * Records what an attempt sent before it sends it. Without one, a repeated
   * request is a repeated submission and a lost response is reported as though
   * nothing was dispatched — so callers that can persist should supply it.
   */
  effects?: EffectLedger;
  /**
   * The host's model, as an interpreter, for plans that compiled to
   * `reasoning: "host-model"`.
   *
   * A factory rather than a value, so a host that builds its model lazily —
   * or whose configuration changed since the plan compiled — answers at the
   * moment the question is asked. Returning `undefined` is a legitimate
   * answer and is treated as one: the attempt is refused by name, never run
   * on the deterministic rules under a plan that says a model decided.
   *
   * Absent means this host runs no inference, which is the only safe default
   * for an option whose presence decides whether somebody's sign-in page is
   * sent anywhere.
   */
  modelInterpreter?: () => CeremonyInterpreter | undefined;
  /**
   * Where verified sessions are kept between logins, when the host wants a
   * later login for the same subject, connector, origin and account to start
   * from the cookies the last one earned.
   *
   * Absent means every login starts from an empty browser, which is the
   * conservative default: a saved state is a bearer credential, and keeping
   * one is a decision a host makes, not one this service makes for it.
   */
  states?: BrowserStateStore;
  /**
   * The sinks a plan's `issued` declaration may name, by kind. Absent means
   * this host keeps nothing a provider page issues, and a plan that declares
   * something is refused before a browser starts.
   */
  issuedSinks?: Partial<Record<IssuedSinkKind, IssuedValueSink>>;
};

/**
 * Which saved state a plan may reuse.
 *
 * The subject is not here because the store already scopes every slot to it.
 * What is here is everything that makes two logins "the same login": the
 * connector, the origin the login starts at, and the account it expects. A
 * plan that accepts whichever account is present shares a slot only with
 * other such plans, so a state kept for an expected account is never offered
 * to a plan that would accept anyone.
 */
function stateSlot(plan: EffectiveLoginPlan): string {
  return JSON.stringify([
    plan.connectorId,
    new URL(plan.entryUrl).origin,
    plan.account.kind === "expect" ? plan.account.accountRef : "*",
  ]);
}

export type LoginRunInput = {
  plan: EffectiveLoginPlan;
  /** Where a person is brought in, when the plan's budget allows it at all. */
  human?: HumanParticipation | undefined;
  /** Observed steps, value-free, for a caller's progress display. */
  onStep?: ((step: { path: string; action: string }) => void) | undefined;
  /**
   * The caller's name for "this same request". Two calls carrying the same key
   * under the same plan are one request: the second reports what the first did
   * instead of logging in again. Omitting it means every call is a new request,
   * which is the old behaviour and is only safe when the caller knows it.
   */
  idempotencyKey?: string | undefined;
  /**
   * Capture what this login does, so it can be saved as a recorded ceremony.
   *
   * Recording changes nothing about how the login runs: the same interpreter
   * decides, under the same rules. It only keeps the value-free trace of the
   * actions that were applied and compiles it at the end. What comes out is
   * handed to `onRecording`, and only when the login got as far as a
   * submission — a failed login is not a procedure worth replaying.
   */
  record?: { id: string; title: string } | undefined;
  /**
   * Replay a recorded ceremony instead of asking an interpreter.
   *
   * No model is consulted. With `repair`, and only when the plan says a model
   * may decide (`reasoning: "host-model"`) and this host has one, a page the
   * recording cannot place is handed to that model and what worked is
   * compiled as a new recording based on `reference`. A repair is a draft for
   * a person to review; nothing here publishes it.
   */
  replay?:
    | {
        recording: RecordedCeremony;
        reference?: RecordingReference | undefined;
        repair?: boolean | undefined;
      }
    | undefined;
  /** What recording or replay produced. Value-free; called once, at the end. */
  onRecording?: ((outcome: RecordingOutcome) => void) | undefined;
};

/**
 * What a recording or a replay produced.
 *
 * `recording` is present only when the login reached a submission and the
 * trace compiled; `rejected` says why a trace that should have compiled did
 * not. Neither carries a value: the recording is checked against every value
 * the login resolved before it is handed out.
 */
export type RecordingOutcome = {
  recording?: RecordedCeremony;
  rejected?: RecordingRejectionReason;
  drift?: RecordingDrift;
  /** Calls to a model during a replay. Zero means none was consulted. */
  interpreterCalls: number;
  repaired: boolean;
};

/** What a drive left behind for the recording, filled in as it runs. */
type Capture = {
  recording?: RecordedCeremony;
  rejected?: RecordingRejectionReason;
  drift?: RecordingDrift;
  interpreterCalls: number;
  repaired: boolean;
};

export function createBrowserLoginService(options: LoginServiceOptions) {
  const now = options.now ?? (() => Date.now());
  const launch = options.launch ?? launchManagedBrowser;
  const freshness = options.evidenceFreshnessMs ?? 15 * 60_000;

  return {
    /**
     * Run a login and report exactly what was established.
     *
     * The return value distinguishes five things that are routinely conflated:
     * an account verified in this browser, a person needed, something typed
     * with nobody proven, something dispatched with an unknown result, and a
     * refusal. Only the first retains a session that a caller may drive.
     */
    async login(
      actor: ActorContext,
      input: LoginRunInput,
    ): Promise<LoginResult> {
      const { plan } = input;
      const runRef = mintReference("brun");

      // Claim the request before anything is launched. A replay is answered
      // from the record and never re-executed: a caller retrying a login whose
      // response it lost must not be the reason a provider sees two attempts.
      const ledger = options.effects;
      let effectRef: string | undefined;
      if (ledger && input.idempotencyKey !== undefined) {
        const claim = await ledger.begin(actor, {
          runRef,
          effectivePlanDigest: plan.digest,
          idempotencyKey: input.idempotencyKey,
        });
        if (claim.kind === "replay") {
          const prior = claim.record;
          // Still dispatched and never observed: the first attempt sent
          // something and nobody ever learned what came back. Saying "blocked"
          // here would invite exactly the retry that must not happen.
          if (effectIsIndeterminate(prior))
            return {
              status: "indeterminate",
              runRef: prior.runRef,
              effectRef: prior.effectRef,
            };
          // An idempotent request answers the same thing twice. Returning the
          // first call's result verbatim is the only honest reply: there is no
          // reason in the vocabulary that means "this already ran", and
          // borrowing one that means something else — `cancelled` says the
          // operation stopped before dispatch — would tell a caller whose login
          // succeeded that it did not, and send them back with a fresh key.
          if (prior.settled)
            return loginResultSchema.parse(JSON.parse(prior.settled));
          // Settled without a recorded answer: older record, or an attempt that
          // ended before one existed. Refusing to re-run it is still right; the
          // honest reason is that this request is spent, not that it failed.
          return {
            status: "blocked",
            runRef: prior.runRef,
            reason: "expired",
          };
        }
        effectRef = claim.record.effectRef;
      }
      /** Whether anything left the browser. Decides uncertainty from refusal. */
      let dispatched = false;
      /** Close the effect honestly, whatever the attempt turned out to be. */
      const settle = async (outcome: string, serialized?: string) => {
        if (!ledger || !effectRef) return;
        // An undetermined attempt is not closed. "Observed" means this process
        // saw the attempt through, and marking an outcome nobody saw as
        // observed would erase the exact uncertainty the record exists to
        // keep — and with it the reason a retry is refused.
        if (outcome === "indeterminate") return;
        try {
          if (dispatched)
            await ledger.observed(actor, effectRef, outcome, serialized);
          else await ledger.abandon(actor, effectRef);
        } catch {
          // Closing the record is bookkeeping about an attempt that is already
          // over. Letting it throw would discard the attempt's answer, and for
          // a verified login that answer is the only way the caller learns the
          // `sessionRef` of a browser this call has already retained on their
          // behalf - an authenticated session nobody can reach is the exact
          // harm this module exists to prevent.
          //
          // Swallowing it is safe in the one direction that matters. The
          // record was written before the click and stays where it was: a
          // dispatched attempt stays `dispatched`, so a replay of this key
          // reports uncertainty and refuses to run again, which is the
          // conservative answer for an attempt whose outcome this process
          // failed to write down. Nothing here can turn into a second
          // submission.
        }
      };

      const capture: Capture = { interpreterCalls: 0, repaired: false };
      const run = async (): Promise<LoginResult> => {
        // Asked before anything launches, for the same reason the capability
        // check is: an attempt that cannot be run as its plan describes should
        // fail as a plan, not halfway through a login with a browser open and
        // a credential already released.
        const replay = input.replay;
        // A replay decides from the recording; an interpreter is only its
        // fallback, and only where the plan lets a model decide at all.
        const repairing =
          replay?.repair === true && plan.reasoning === "host-model";
        const interpreter =
          replay && !repairing ? undefined : interpreterFor(plan);
        if (!interpreter && (!replay || repairing))
          return { status: "blocked", runRef, reason: "reasoning-unavailable" };
        // Nowhere trusted to put an issued value is a plan this host cannot
        // run, refused before anything opens rather than after a secret has
        // been generated with nowhere to go.
        if (plan.issued && !options.issuedSinks?.[plan.issued.sink])
          return {
            status: "blocked",
            runRef,
            reason: "unsupported-capability",
          };

        let browser: ManagedBrowser;
        try {
          browser = await launch(plan.engine, plan.required);
        } catch (error) {
          // A backend that cannot provide what the plan requires is reported as
          // an unsupported capability, not as a browser that failed to start:
          // the caller's next move is different in each case.
          return {
            status: "blocked",
            runRef,
            reason:
              error instanceof UnsupportedBackend
                ? "unsupported-capability"
                : "target-unavailable",
          };
        }

        let context: ManagedContext | undefined;
        let retained = false;
        // A session this subject verified earlier for this same login, when
        // the host keeps them. Restoring it is an optimisation and nothing
        // more: the drive still runs, and the verifier still decides who is
        // signed in, so a stale or foreign cookie jar costs a login form and
        // never a wrong answer.
        const slot = stateSlot(plan);
        const restore =
          options.states && browser.descriptor.capabilities.statePersistence
            ? await options.states.recall(actor, slot).catch(() => undefined)
            : undefined;
        try {
          context = restore
            ? await browser
                .openContext({ storageState: restore })
                // A state that could not be restored is a fresh context, not a
                // failed login: the person's credentials still work.
                .catch(() => browser.openContext())
            : await browser.openContext();
          const { page } = await context.openPage({
            // What the plan said about frames, and the only route it has to
            // the adapter. A plan that declares a frame origin requires the
            // `frameBinding` capability, so reaching here with one means the
            // backend claims to observe inside a frame.
            ...(plan.frameOrigins.length > 0
              ? { frameOrigins: plan.frameOrigins }
              : {}),
            // A plan that requires `popupBinding` admits a window the page
            // opens at an origin it may navigate to, and nowhere else: the
            // navigation scope is the statement of where this login may go,
            // and a window is one more way of going there. Without the
            // requirement a window the page opens is not the attempt's
            // concern, which is what every plan got before there was a rule.
            ...(plan.required.popupBinding === true
              ? { popupOrigins: plan.navigationOrigins }
              : {}),
          });

          const outcome = await drive(
            actor,
            runRef,
            plan,
            page,
            input,
            async ({ destination }) => {
              // Durable first, then the in-memory flag. A ledger that cannot
              // record the intent stops the attempt before the click, so the
              // flag never claims a dispatch that was not written down; and a
              // record written before a click that never happened is the
              // conservative error, because it reports uncertainty rather than
              // inviting a retry.
              if (ledger && effectRef)
                await ledger.dispatching(actor, effectRef, destination);
              dispatched = true;
            },
            interpreter,
            capture,
            restore !== undefined,
          );
          /** A replay that stopped before its first step on a restored session. */
          const restoredDrift = outcome.kind === "restored-drift";
          const drifted = (): LoginResult => ({
            status: "blocked",
            runRef,
            reason: "recording-drift",
          });
          if (outcome.kind === "indeterminate")
            return {
              status: "indeterminate",
              runRef,
              ...(effectRef ? { effectRef } : {}),
            };
          if (outcome.kind === "blocked")
            return { status: "blocked", runRef, reason: outcome.reason };
          if (outcome.kind === "human")
            return {
              status: "requires-human",
              runRef,
              handoffRef: mintReference("bhof"),
              reason: outcome.reason,
            };

          // The drive is over. Whether anyone is logged in is a separate
          // question, asked of the provider through this context's own cookies.
          const verifierOrigin = plan.verifierOrigin;
          const verifier = verifierOrigin
            ? options.verifiers.find(verifierOrigin)
            : undefined;
          const request = context.request;

          if (restoredDrift && (!verifier || !request)) return drifted();
          if (!verifier || !request) {
            // No registered verifier means the honest ceiling is "something was
            // submitted". Retaining the session is still useful and still true;
            // calling it verified would not be.
            const sessionRef =
              plan.continuation === "dispose"
                ? undefined
                : await retain(actor, plan, browser, context, undefined);
            retained = sessionRef !== undefined;
            return {
              status: "submitted-unverified",
              runRef,
              ...(sessionRef ? { sessionRef } : {}),
            };
          }

          const expected =
            plan.account.kind === "expect"
              ? { accountRef: plan.account.accountRef }
              : {};
          const verification = await verifier.verify(
            {
              request,
              browserGeneration: browser.browserGeneration,
              browserSessionRef: "pending",
              effectivePlanDigest: plan.digest,
            },
            expected,
          );

          if (!verification.verified && restoredDrift) return drifted();
          if (!verification.verified) {
            // A wrong account is reported. It is never a licence to log that
            // account out, switch to another, or start a recovery flow.
            if (verification.reason === "account-mismatch")
              return { status: "blocked", runRef, reason: "account-mismatch" };
            return { status: "submitted-unverified", runRef };
          }

          const sessionRef = await retain(
            actor,
            plan,
            browser,
            context,
            undefined,
          );
          retained = true;
          const { evidenceRef, evidence } = mintLoginEvidence({
            kind: verifier.evidenceKind,
            verifier,
            browserSessionRef: sessionRef,
            browserGeneration: browser.browserGeneration,
            accountRef: verification.accountRef,
            effectivePlanDigest: plan.digest,
            now: new Date(now()),
            freshnessMs: freshness,
          });
          await options.sessions.recordEvidence(
            actor,
            sessionRef,
            evidence,
            evidenceRef,
          );
          // Kept only once the provider has said whose session this is, and
          // only for a plan that asked for the session to outlive the call. A
          // `dispose` continuation asked for nothing to remain; an unverified
          // one has no account to key the state to. The export goes straight
          // into the encrypted store and is never returned from here.
          //
          // Best-effort: failing to remember a session must not turn a
          // verified login into a failed one.
          if (
            options.states &&
            plan.continuation !== "dispose" &&
            browser.descriptor.capabilities.statePersistence
          ) {
            const states = options.states;
            await context
              .saveState()
              .then((state) =>
                states.remember(
                  actor,
                  slot,
                  {
                    browserGeneration: browser.browserGeneration,
                    effectivePlanDigest: plan.digest,
                  },
                  storageStateSchema.parse(state),
                ),
              )
              .catch(() => {});
          }
          if (plan.continuation === "dispose") {
            // The caller asked for the old ephemeral behaviour. The account was
            // still genuinely verified; the session simply does not outlive it.
            await options.sessions.release(
              actor,
              sessionRef,
              "dispose-managed",
            );
            retained = false;
            if (restoredDrift) delete capture.drift;
            return {
              status: "verified",
              runRef,
              sessionRef,
              evidenceRef,
              evidenceKind: evidence.kind,
            };
          }
          // The restored session was already where the recording leads, so
          // nothing drifted: the replay simply had nothing left to do.
          if (restoredDrift) delete capture.drift;
          return {
            status: "verified",
            runRef,
            sessionRef,
            evidenceRef,
            evidenceKind: evidence.kind,
          };
        } catch (error) {
          // The difference that matters. A failure before anything was sent is a
          // refusal a caller may retry; a failure after a submission left the
          // browser is not, because the provider may already have acted on it.
          //
          // Uncertainty outranks everything, including the tripwire below. An
          // attempt that clicked and then found a protected value on the next
          // page really did dispatch something whose outcome nobody saw, and
          // relabelling that as a refusal would invite the retry the record
          // exists to prevent. So a canary that trips after a dispatch is
          // reported as `indeterminate`; the ledger still holds the
          // dispatched-and-unobserved record, which is the fact a caller has
          // to act on.
          if (dispatched)
            return {
              status: "indeterminate",
              runRef,
              ...(effectRef ? { effectRef } : {}),
            };
          // Nothing left the browser, so the honest answer is the specific
          // one. `provider-error` would have said a provider misbehaved; what
          // happened is that this process was about to hand a value it holds
          // privately to something that must never see it, and stopped. A
          // host that cannot tell those apart cannot alarm on the second.
          if (error instanceof CeremonySecretLeak)
            return {
              status: "blocked",
              runRef,
              reason: "protected-value-exposed",
            };
          return { status: "blocked", runRef, reason: "provider-error" };
        } finally {
          // Only an unretained browser is disposed here. Closing a retained one
          // is the bug this whole module exists to fix: the deliverable of a
          // login is a browser that is still logged in.
          if (!retained) {
            await context?.close().catch(() => {});
            await browser.dispose().catch(() => {});
          }
        }
      };

      const result = await run();
      await settle(result.status, JSON.stringify(result));
      if (input.onRecording) {
        // A recording is kept only from a login that got somewhere. A refusal,
        // a person's challenge or an unknown outcome is not a procedure.
        const reached =
          result.status === "verified" ||
          result.status === "submitted-unverified";
        input.onRecording({
          ...(reached && capture.recording
            ? { recording: capture.recording }
            : {}),
          ...(reached && capture.rejected
            ? { rejected: capture.rejected }
            : {}),
          ...(capture.drift ? { drift: capture.drift } : {}),
          interpreterCalls: capture.interpreterCalls,
          repaired: capture.repaired,
        });
      }
      return result;
    },

    /** Record a person's report. A claim, kept as a claim. */
    async attest(
      actor: ActorContext,
      input: {
        sessionRef: string;
        accountRef: string;
        plan: EffectiveLoginPlan;
        browserGeneration: string;
      },
    ): Promise<LoginEvidence> {
      const { evidenceRef, evidence } = mintAttestation({
        browserSessionRef: input.sessionRef,
        browserGeneration: input.browserGeneration,
        accountRef: input.accountRef,
        effectivePlanDigest: input.plan.digest,
        now: new Date(now()),
      });
      await options.sessions.recordEvidence(
        actor,
        input.sessionRef,
        evidence,
        evidenceRef,
      );
      return evidence;
    },
  };

  async function retain(
    actor: ActorContext,
    plan: EffectiveLoginPlan,
    browser: ManagedBrowser,
    context: ManagedContext,
    controllerRef: string | undefined,
  ): Promise<string> {
    const record = await options.sessions.retain(actor, {
      ownership: "managed",
      engine: plan.engine,
      backendId: browser.descriptor.backendId,
      executorRef: options.sessions.executorRef,
      browserGeneration: browser.browserGeneration,
      contextRef: context.contextRef,
      trustMode: plan.trustMode,
      scope:
        plan.continuation === "retain-for-authorized-agent"
          ? ["observe", "navigate", "login"]
          : ["observe"],
      effectivePlanDigest: plan.digest,
      ttlMs: plan.sessionTtlMs,
      ...(controllerRef ? { controllerRef } : {}),
      browser,
      context,
    });
    return record.sessionRef;
  }

  /**
   * Which interpreter this plan compiled to, or nothing when the host cannot
   * supply it.
   *
   * The plan decides, not the service and not the caller. A password login on
   * an ordinary form needs no model, so `deterministic` stays the answer for
   * everything that did not explicitly ask — a plan must not acquire an
   * inference call by accident, and the compiler makes the omitted field mean
   * "no".
   *
   * The second branch is the one that matters. A plan compiled against a host
   * that had a model can be run later, or elsewhere, against one that does
   * not; the honest answer then is a refusal, because running the
   * deterministic rules would produce an attempt whose plan digest says a
   * model looked at the page when nothing did.
   *
   * A factory that *throws* is that same answer arriving badly. It is the
   * normal failure of the host construction this option exists for:
   * `configuredModel` throws on an invalid endpoint, an endpoint that is not
   * https, a missing model name. Letting it out of here would end `login()`
   * with an exception, and an attempt that terminates any way other than with
   * a named outcome is the one thing this module promises not to do — the
   * effect record would go unsettled and the caller would get a stack trace
   * where a reason belongs. A model that cannot be built is a model this host
   * does not have.
   */
  function interpreterFor(
    plan: EffectiveLoginPlan,
  ): CeremonyInterpreter | undefined {
    if (plan.reasoning === "deterministic") return createHeuristicInterpreter();
    try {
      return options.modelInterpreter?.();
    } catch {
      return undefined;
    }
  }

  /**
   * Drive the login itself.
   *
   * Whichever interpreter the plan chose, it has no authority here. The driver
   * validates every action it proposes, owns origin policy, decides which role
   * resolves to what, and refuses anything the observation does not support —
   * so the difference between the two is which page-reading rules run, not how
   * much is trusted. Secrets are resolved by role inside this call and never
   * leave it.
   */
  async function drive(
    actor: ActorContext,
    runRef: string,
    plan: EffectiveLoginPlan,
    page: CeremonyPage,
    input: LoginRunInput,
    onDispatch: (info: { destination: string }) => Promise<void> | void,
    interpreter: CeremonyInterpreter | undefined,
    capture: Capture,
    restored: boolean,
  ): Promise<
    | { kind: "done" }
    | { kind: "restored-drift" }
    | { kind: "indeterminate" }
    | { kind: "blocked"; reason: BrowserOperationReason }
    | {
        kind: "human";
        reason:
          | "human-challenge"
          | "passkey"
          | "native-dialog"
          | "device-code"
          | "choice";
      }
  > {
    await page.goto(plan.entryUrl);
    const declared = Object.keys(plan.credentialRefs);
    const held = heldCredentialKinds.filter((kind) => declared.includes(kind));
    const roles: CeremonyRole[] = [];
    for (const role of declared as CeremonyRole[])
      if (!(heldCredentialKinds as readonly string[]).includes(role))
        roles.push(role);

    /**
     * Every value this drive resolved, secret or not. Kept only so a recording
     * can be checked against them before it leaves; it never leaves itself.
     */
    const resolved: string[] = [];
    const values: Partial<Record<CeremonyRole, () => Promise<string>>> = {};
    for (const role of roles)
      values[role] = async () => {
        const value = await options.credentials.resolve(actor, plan, role);
        if (value === undefined) throw new Error("credential unavailable");
        resolved.push(value);
        return value;
      };
    // A held seed offers the role it derives, and the value is computed at the
    // moment of filling rather than when the attempt starts. A code minted
    // before an interpreter has decided, or before a slow page has settled, is
    // a code that can expire between being computed and being submitted.
    //
    // The seed is resolved inside this closure and goes no further. The only
    // thing that leaves is the code, which the driver guards the moment it
    // types it because `totp-code` is a secret role — so a page that echoes it
    // back trips the canary like a page that echoes a password.
    for (const kind of held) {
      const role = derivedRoleOf[kind];
      if (!ceremonyRoles.includes(role)) continue;
      roles.push(role);
      values[role] = async () => {
        const seed = await options.credentials.resolve(actor, plan, kind);
        if (seed === undefined) throw new Error("credential unavailable");
        const code = totpCode(seed, now());
        resolved.push(code);
        return code;
      };
    }

    // Arm the driver's canary before the first page is read, not after the
    // first field is typed.
    //
    // The driver adds a secret to its guarded set when it fills one, which
    // covers every snapshot from that point on. What it cannot cover is every
    // snapshot *before* it, and that window is not hypothetical: a provider
    // whose password field arrives already filled — a browser password
    // manager, a resumed form, a retry after a failed attempt — is a page the
    // driver submits without ever typing, so the guard would stay unarmed for
    // the whole attempt while the provider echoed the value back in an alert.
    //
    // This is the layer that can close it. The plan says which roles are
    // authorized and the credential source is the only thing that can turn
    // them into values, so the values are asked for here and handed to the
    // driver as the things no surface may carry.
    //
    // Only the *held* secrets, and the restriction is not a nicety. A
    // password sits in the collector and reading it early costs nothing. A
    // verification code does not exist until a submission causes the provider
    // to send one, and resolving it means waiting on a mailbox — so asking
    // before the drive starts would block every flow that uses one, on a code
    // that cannot arrive, for as long as that mailbox waits. The hole this
    // closes cannot apply to those roles anyway: a page cannot display a value
    // the provider has not issued, and once the driver types one the driver's
    // own guard covers every snapshot after it, exactly as before.
    //
    // Not the non-secret roles either. An address or a display name is shown
    // by legitimate providers on their own pages, and guarding one would make
    // an ordinary login look like a leak.
    //
    // Resolution is best-effort by design. A role the flow never reaches may
    // have no value, and a collector that cannot answer for it must not turn
    // into a failed login — that role simply resolves at fill time as before.
    const guarded: string[] = [];
    for (const role of roles) {
      if (!heldSecretRoles.includes(role)) continue;
      const value = await options.credentials
        .resolve(actor, plan, role)
        .catch(() => undefined);
      if (value !== undefined && !guarded.includes(value)) guarded.push(value);
    }
    // A held seed is the most held secret there is: every future code comes
    // out of it. It is guarded in each spelling a page could plausibly show,
    // because enrolment screens print the same secret grouped, lower-cased or
    // inside an `otpauth://` URI, and the canary matches exact text.
    for (const kind of held) {
      const seed = await options.credentials
        .resolve(actor, plan, kind)
        .catch(() => undefined);
      if (seed === undefined) continue;
      for (const spelling of totpSeedSpellings(seed))
        if (!guarded.includes(spelling)) guarded.push(spelling);
    }

    // What this login keeps, handed straight to the host's sink by the driver.
    // The values pass through this closure and no further: they are added to
    // the recording's exclusions and forgotten with the call.
    const issuedSink = plan.issued
      ? options.issuedSinks?.[plan.issued.sink]
      : undefined;
    const issuedValues: string[] = [];
    let kept = false;
    // A plan that keeps an issued credential is obtaining one, and the
    // interpreter is told so; everything else here is a sign-in.
    const goal: CeremonyGoal = plan.issued ? "obtain-credential" : "sign-in";

    const trace: RecordedTraceEntry[] = [];
    let dispatchedHere = false;
    const common = {
      page,
      goal,
      secrets: createSecrets(values),
      // The driver's origin rule is the union of everywhere a secret may go,
      // and its per-role narrowing is applied by the plan before we get here.
      allowedOrigins: plan.navigationOrigins,
      onDispatch: async (info: { destination: string }) => {
        dispatchedHere = true;
        await onDispatch(info);
      },
      ...(guarded.length > 0 ? { protectedValues: guarded } : {}),
      ...(plan.issued && issuedSink
        ? {
            issued: {
              fields: issuedFieldsOf(plan.issued),
              keep: async (values: IssuedValues) => {
                issuedValues.push(
                  ...Object.values(values).filter(
                    (value): value is string => value !== undefined,
                  ),
                );
                await issuedSink(actor, { runRef, plan }, values);
                kept = true;
              },
            },
          }
        : {}),
      ...(plan.choices ? { choices: plan.choices } : {}),
      ...(input.human && plan.interactionRounds > 0
        ? { human: { ...input.human, maxRequests: plan.interactionRounds } }
        : {}),
      ...(input.onStep
        ? {
            onStep: (step: { path: string; action: string }) =>
              input.onStep?.({ path: step.path, action: step.action }),
          }
        : {}),
    };
    let result: CeremonyResult;
    if (input.replay) {
      const replayed = await runRecordedCeremony({
        ...common,
        recording: input.replay.recording,
        ...(interpreter ? { fallback: interpreter } : {}),
      });
      trace.push(...replayed.trace);
      if (replayed.drift) capture.drift = replayed.drift;
      capture.interpreterCalls = replayed.interpreterCalls;
      capture.repaired = replayed.repaired;
      result = replayed;
    } else {
      if (!interpreter) throw new Error("No interpreter for a live drive");
      result = await runCeremony({
        ...common,
        interpreter,
        ...(input.record ? { onApplied: (entry) => trace.push(entry) } : {}),
      });
    }

    // Compile while the resolved values are still in hand, so the recording
    // is checked against every one of them and none of them has to leave
    // this function to do it.
    const recordAs = input.record
      ? { ...input.record, recordedWith: plan.reasoning }
      : input.replay && capture.repaired
        ? {
            id: input.replay.recording.id,
            title: input.replay.recording.title,
            recordedWith: "repair" as const,
          }
        : undefined;
    if (recordAs) {
      try {
        capture.recording = compileRecording(trace, {
          id: recordAs.id,
          title: recordAs.title,
          goal,
          entryUrl: plan.entryUrl,
          ...(plan.issued ? { issued: plan.issued } : {}),
          origins: plan.navigationOrigins,
          recordedWith: recordAs.recordedWith,
          ...(input.replay?.reference && recordAs.recordedWith === "repair"
            ? { basedOn: input.replay.reference }
            : {}),
          excluded: [
            ...resolved,
            ...guarded,
            ...issuedValues,
            ...(plan.account.kind === "expect"
              ? [plan.account.accountRef]
              : []),
          ],
        });
      } catch (error) {
        // The login has already happened by now. Whatever stops the trace
        // becoming a recording costs the recording, never the login's answer:
        // rethrowing here would report a signed-in session as indeterminate.
        capture.rejected =
          error instanceof RecordingRejected ? error.reason : "invalid";
      }
    }

    // Uncertainty travels first: it is the one ending that must never be
    // rewritten into a cheerier or a more retryable one further down.
    if (result.status === "indeterminate") return { kind: "indeterminate" };
    // A recording that stopped where the provider no longer matched it is its
    // own ending. It is not a provider error and not a login that ran out of
    // ideas - nothing is handed to a verifier - and the drift says exactly
    // which step and which control.
    if (
      input.replay &&
      capture.drift &&
      !capture.repaired &&
      result.status === "blocked"
    )
      // Except on a restored session, before anything was applied: a saved
      // state that is still signed in opens on the signed-in view rather than
      // the recording's first form. That is the verifier's question, and only
      // its "no" makes this drift.
      return restored && trace.length === 0 && !dispatchedHere
        ? { kind: "restored-drift" }
        : { kind: "blocked", reason: "recording-drift" };
    if (result.status === "blocked") {
      if (result.reason === "human-challenge")
        return { kind: "human", reason: "human-challenge" };
      if (result.reason === "passkey-required")
        return { kind: "human", reason: "passkey" };
      if (result.reason === "native-dialog")
        return { kind: "human", reason: "native-dialog" };
      if (result.reason === "device-code-required")
        return { kind: "human", reason: "device-code" };
      if (result.reason === "choice-required")
        return { kind: "human", reason: "choice" };
      // Refusals that mean a secret was *not* safely deliverable end the
      // attempt here. There is nothing for a verifier to adjudicate: the
      // ceremony stopped before doing the thing it would be verifying.
      if (
        result.reason === "stale-document" ||
        result.reason === "stale-element"
      )
        return { kind: "blocked", reason: "stale-document" };
      // Carried under its own name rather than folded into the one above. Both
      // end the attempt the same way, but a caller told "the document moved
      // on" goes looking at the page; a caller told no approval was held goes
      // looking at the sequence that should have taken one.
      if (result.reason === "no-observation")
        return { kind: "blocked", reason: "no-observation" };
      if (result.reason === "unapproved-recipient")
        return { kind: "blocked", reason: "unapproved-recipient" };
      if (result.reason === "untrusted-origin")
        return { kind: "blocked", reason: "unapproved-recipient" };
      // A document the plan did not describe - no frame where one was named,
      // two where one was, a window somewhere undeclared, or two windows -
      // stopped the attempt before a secret reached anything it approved.
      // Each is carried under its own name because each sends its reader
      // somewhere different: to the page, or to the plan's origins.
      if (
        result.reason === "frame-missing" ||
        result.reason === "frame-ambiguous" ||
        result.reason === "popup-undeclared" ||
        result.reason === "popup-ambiguous"
      )
        return { kind: "blocked", reason: result.reason };
      if (
        result.reason === "consent-denied" ||
        result.reason === "human-declined"
      )
        return { kind: "blocked", reason: "human-declined" };
    }
    // A login that was for an issued value and did not keep it did not do
    // what it was for, however signed in the browser now is.
    if (plan.issued && !kept)
      return { kind: "blocked", reason: "issued-value-missing" };
    // Every other ending — completed, unverified, stalled, exhausted, or a
    // page the interpreter could not read — means only that the drive is over.
    // Whether anyone is logged in is a question for the verifier, and a driver
    // that ran out of ideas on a post-login page is not evidence of failure.
    return { kind: "done" };
  }
}

/** Origins a given role's secret may reach under this plan. */
export { recipientsFor };

export type BrowserLoginService = ReturnType<typeof createBrowserLoginService>;
