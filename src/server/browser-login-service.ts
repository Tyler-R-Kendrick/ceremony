import {
  mintReference,
  type BrowserOperationReason,
  type LoginEvidence,
  type LoginResult,
} from "../core/browser-session-contracts.js";
import type { ActorContext } from "../core/operation-contracts.js";
import type { CeremonyRole } from "../core/browser-contracts.js";
import {
  launchManagedBrowser,
  UnsupportedBackend,
  type ManagedBrowser,
  type ManagedContext,
} from "./browser-backends.js";
import {
  createSecrets,
  runCeremony,
  type CeremonyPage,
  type HumanParticipation,
} from "./browser-driver.js";
import { createHeuristicInterpreter } from "./browser-interpreter.js";
import type { BrowserSessionRegistry } from "./browser-sessions.js";
import {
  mintAttestation,
  mintLoginEvidence,
  type VerifierRegistry,
} from "./browser-verification.js";
import { recipientsFor, type EffectiveLoginPlan } from "./login-plan.js";
import { effectIsIndeterminate, type EffectLedger } from "./browser-effects.js";

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
   */
  resolve(
    actor: ActorContext,
    plan: EffectiveLoginPlan,
    role: CeremonyRole,
  ): Promise<string | undefined>;
}

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
};

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
          return {
            status: "blocked",
            runRef: prior.runRef,
            reason: "cancelled",
          };
        }
        effectRef = claim.record.effectRef;
      }
      /** Whether anything left the browser. Decides uncertainty from refusal. */
      let dispatched = false;
      /** Close the effect honestly, whatever the attempt turned out to be. */
      const settle = async (outcome: string) => {
        if (!ledger || !effectRef) return;
        // An undetermined attempt is not closed. "Observed" means this process
        // saw the attempt through, and marking an outcome nobody saw as
        // observed would erase the exact uncertainty the record exists to
        // keep — and with it the reason a retry is refused.
        if (outcome === "indeterminate") return;
        if (dispatched) await ledger.observed(actor, effectRef, outcome);
        else await ledger.abandon(actor, effectRef);
      };

      const run = async (): Promise<LoginResult> => {
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
        try {
          context = await browser.openContext();
          const { page } = await context.openPage();

          const outcome = await drive(
            actor,
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
          );
          if (outcome.kind === "indeterminate")
            return {
              status: "indeterminate",
              runRef,
              effectRef: effectRef ?? mintReference("beff"),
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
          if (plan.continuation === "dispose") {
            // The caller asked for the old ephemeral behaviour. The account was
            // still genuinely verified; the session simply does not outlive it.
            await options.sessions.release(
              actor,
              sessionRef,
              "dispose-managed",
            );
            retained = false;
            return {
              status: "verified",
              runRef,
              sessionRef,
              evidenceRef,
              evidenceKind: evidence.kind,
            };
          }
          return {
            status: "verified",
            runRef,
            sessionRef,
            evidenceRef,
            evidenceKind: evidence.kind,
          };
        } catch {
          // The difference that matters. A failure before anything was sent is a
          // refusal a caller may retry; a failure after a submission left the
          // browser is not, because the provider may already have acted on it.
          if (dispatched)
            return {
              status: "indeterminate",
              runRef,
              effectRef: effectRef ?? mintReference("beff"),
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
      await settle(result.status);
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
   * Drive the login itself.
   *
   * The interpreter is the deterministic one: a password login needs no model,
   * and a plan that permits no interaction must not acquire one by accident.
   * Secrets are resolved by role inside this call and never leave it.
   */
  async function drive(
    actor: ActorContext,
    plan: EffectiveLoginPlan,
    page: CeremonyPage,
    input: LoginRunInput,
    onDispatch: (info: { destination: string }) => Promise<void> | void,
  ): Promise<
    | { kind: "done" }
    | { kind: "indeterminate" }
    | { kind: "blocked"; reason: BrowserOperationReason }
    | { kind: "human"; reason: "human-challenge" | "passkey" | "native-dialog" }
  > {
    await page.goto(plan.entryUrl);
    const roles: CeremonyRole[] = [];
    for (const role of Object.keys(plan.credentialRefs) as CeremonyRole[])
      roles.push(role);

    const values: Partial<Record<CeremonyRole, () => Promise<string>>> = {};
    for (const role of roles)
      values[role] = async () => {
        const value = await options.credentials.resolve(actor, plan, role);
        if (value === undefined) throw new Error("credential unavailable");
        return value;
      };

    const result = await runCeremony({
      page,
      interpreter: createHeuristicInterpreter(),
      goal: "sign-in",
      secrets: createSecrets(values),
      // The driver's origin rule is the union of everywhere a secret may go,
      // and its per-role narrowing is applied by the plan before we get here.
      allowedOrigins: plan.navigationOrigins,
      onDispatch,
      ...(input.human && plan.interactionRounds > 0
        ? { human: { ...input.human, maxRequests: plan.interactionRounds } }
        : {}),
      ...(input.onStep
        ? {
            onStep: (step) =>
              input.onStep?.({ path: step.path, action: step.action }),
          }
        : {}),
    });

    // Uncertainty travels first: it is the one ending that must never be
    // rewritten into a cheerier or a more retryable one further down.
    if (result.status === "indeterminate") return { kind: "indeterminate" };
    if (result.status === "blocked") {
      if (result.reason === "human-challenge")
        return { kind: "human", reason: "human-challenge" };
      if (result.reason === "passkey-required")
        return { kind: "human", reason: "passkey" };
      if (result.reason === "native-dialog")
        return { kind: "human", reason: "native-dialog" };
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
      if (
        result.reason === "consent-denied" ||
        result.reason === "human-declined"
      )
        return { kind: "blocked", reason: "human-declined" };
    }
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
