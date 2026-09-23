import type { KeyObject } from "node:crypto";
import type { CeremonyResult, HumanParticipation } from "../browser-driver.js";
import {
  certificationTranscriptSchema,
  digestOf,
  isProviderOrigin,
  signCertification,
  type AttendedCertification,
  type CertificationFlow,
  type CertificationTranscript,
} from "./certification.js";

/*
 * The attended certification harness: one flow, driven by the real browser
 * driver, with a person confirming every step that needed one.
 *
 * A flow is an ordered list of steps. A `driver` step runs `runCeremony`
 * with a human participation the harness supplies: when the driver hands a
 * step to a person, that person acts in the page (the attendant, in the
 * headed browser, at a real provider; a rehearsal step first lets its
 * scripted human double act) and the attendant must then confirm it
 * happened as they saw it. A `human` step
 * is a checkpoint with no page: the attendant confirms something only they
 * can see ("the account appears in the provider's dashboard"). A `service`
 * step is server-side work the flow needs between browser steps. The run is
 * bracketed by two attestations: that the attendant is present for this
 * provider and flow before anything starts, and that the outcome matches
 * what they saw after it ends.
 *
 * Any step that fails, is declined or is not confirmed ends the run with no
 * record. A completed run yields a signed record whose transcript is
 * value-free by construction: step names, kinds, outcomes, the driver's
 * status and counts, and a digest of the driver's own transcript. No
 * prompt answer, typed value, code or URL query is kept.
 *
 * `rehearsal` is decided by the flow, not the caller: a flow whose origins
 * include anything that cannot be a real provider is a rehearsal, and a flow
 * that claims not to be one while naming a stand-in is refused before its
 * first step.
 */

/** What the attendant is asked. Text for a person; it carries no value. */
export type AttendantPrompt = {
  step: string;
  kind: "attestation" | "driver" | "human";
  /** A sentence naming what to confirm. */
  question: string;
  /** For a driver handoff: origin and pathname of the page, never its query. */
  path?: string;
};

export interface Attendant {
  /** The name recorded as `attendedBy`; the certifier list must give their key this name. */
  readonly name: string;
  confirm(prompt: AttendantPrompt): Promise<boolean>;
}

export type CertificationStep =
  | {
      id: string;
      kind: "driver";
      /** What the attendant confirms after the driver's run completes. */
      confirm: string;
      run(human: HumanParticipation): Promise<CeremonyResult>;
    }
  | { id: string; kind: "service"; run(): Promise<boolean> }
  | { id: string; kind: "human"; question: string };

export type CertificationFlowPlan = {
  flow: CertificationFlow;
  adapterId: string;
  definition?: string;
  provider: { name: string; origins: readonly string[] };
  /** Whether this flow runs against local doubles. */
  rehearsal: boolean;
  steps: readonly CertificationStep[];
};

export type CertificationRun =
  | {
      status: "certified" | "rehearsed";
      record: AttendedCertification;
      transcript: CertificationTranscript;
    }
  | {
      status: "failed";
      /** The step that ended the run, and how. */
      step: string;
      outcome: "declined" | "failed";
      transcript: CertificationTranscript;
    };

const handoffContract = {
  surface: "provider-browser",
  recipient: "initiating-subject",
  delegation: "a2h-authorize",
  resume: "verify",
} as const;

export class CertificationRefused extends Error {
  constructor(readonly code: string) {
    super(`Certification refused: ${code}`);
    this.name = "CertificationRefused";
  }
}

export async function runAttendedCertification(options: {
  plan: CertificationFlowPlan;
  attendant: Attendant;
  commit: string;
  signingKey: KeyObject;
  now: () => number;
  /** A fresh, unguessable suffix for the record id. */
  nonce: string;
}): Promise<CertificationRun> {
  const { plan, attendant } = options;
  const standIns = plan.provider.origins.filter(
    (origin) => !isProviderOrigin(origin),
  );
  // A flow cannot call a stand-in a provider: the record would be refused
  // anyway, but a person should learn that before attending a whole run.
  if (!plan.rehearsal && standIns.length > 0)
    throw new CertificationRefused("stand-in-origin");
  if (!/^[0-9a-f]{40}$/.test(options.commit))
    throw new CertificationRefused("commit-required");
  if (!/^[a-z0-9]{6,32}$/.test(options.nonce))
    throw new CertificationRefused("nonce-required");

  const transcript: CertificationTranscript = [];
  let humanSteps = 0;
  const fail = (
    step: string,
    outcome: "declined" | "failed",
  ): CertificationRun => ({ status: "failed", step, outcome, transcript });
  const ask = async (prompt: AttendantPrompt) => {
    humanSteps++;
    return attendant.confirm(prompt);
  };

  const opening = await ask({
    step: "attend",
    kind: "attestation",
    question: `I am attending this ${plan.flow} run against ${plan.provider.name} (${plan.provider.origins.join(", ")}) and will confirm only what I see.`,
  });
  transcript.push({
    step: "attend",
    kind: "attestation",
    outcome: opening ? "confirmed" : "declined",
  });
  if (!opening) return fail("attend", "declined");

  for (const step of plan.steps) {
    if (step.kind === "human") {
      const confirmed = await ask({
        step: step.id,
        kind: "human",
        question: step.question,
      });
      transcript.push({
        step: step.id,
        kind: "human",
        outcome: confirmed ? "confirmed" : "declined",
      });
      if (!confirmed) return fail(step.id, "declined");
      continue;
    }
    if (step.kind === "service") {
      const ok = await step.run().catch(() => false);
      transcript.push({
        step: step.id,
        kind: "service",
        outcome: ok ? "completed" : "failed",
      });
      if (!ok) return fail(step.id, "failed");
      continue;
    }
    let declined = false;
    const human: HumanParticipation = {
      contract: handoffContract,
      maxRequests: 3,
      async request(request) {
        const confirmed = await ask({
          step: step.id,
          kind: "driver",
          question: `The ${request.reason} step at ${request.path} was completed by a person, as I saw it.`,
          path: request.path,
        });
        if (!confirmed) declined = true;
        return confirmed ? "completed" : "declined";
      },
    };
    let result: CeremonyResult;
    try {
      result = await step.run(human);
    } catch {
      transcript.push({ step: step.id, kind: "driver", outcome: "failed" });
      return fail(step.id, "failed");
    }
    const driver = {
      status: result.status,
      steps: result.steps,
      handoffs: result.handoffs,
      digest: digestOf(result.transcript),
    };
    if (result.status !== "completed") {
      transcript.push({
        step: step.id,
        kind: "driver",
        outcome: declined ? "declined" : "failed",
        driver,
      });
      return fail(step.id, declined ? "declined" : "failed");
    }
    const confirmed = await ask({
      step: step.id,
      kind: "driver",
      question: step.confirm,
    });
    transcript.push({
      step: step.id,
      kind: "driver",
      outcome: confirmed ? "completed" : "declined",
      driver,
    });
    if (!confirmed) return fail(step.id, "declined");
  }

  const closing = await ask({
    step: "outcome",
    kind: "attestation",
    question: `The ${plan.flow} run finished at ${plan.provider.name} as I saw it, and every step I confirmed happened.`,
  });
  transcript.push({
    step: "outcome",
    kind: "attestation",
    outcome: closing ? "confirmed" : "declined",
  });
  if (!closing) return fail("outcome", "declined");

  const checked = certificationTranscriptSchema.parse(transcript);
  const recordedAt = new Date(options.now()).toISOString().slice(0, 10);
  const slug = plan.provider.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const record = signCertification(
    {
      kind: "attended-certification",
      schemaVersion: 1,
      id: `${recordedAt}-${slug || "provider"}-${plan.flow}-${options.nonce}`,
      adapterId: plan.adapterId,
      ...(plan.definition ? { definition: plan.definition } : {}),
      provider: {
        name: plan.provider.name,
        origins: [...plan.provider.origins],
      },
      flow: plan.flow,
      rehearsal: plan.rehearsal,
      attendedBy: attendant.name,
      recordedAt,
      commit: options.commit,
      transcript: {
        digest: digestOf(checked),
        steps: checked.length,
        humanSteps,
      },
      outcome: "completed",
    },
    options.signingKey,
  );
  return {
    status: plan.rehearsal ? "rehearsed" : "certified",
    record,
    transcript: checked,
  };
}
