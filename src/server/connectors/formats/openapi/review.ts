import type {
  BindingReview,
  BindingReviewResult,
  ReviewedOperation,
} from "../../adapter.js";
import type { BoundOperation } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import { parseBoundedDocument } from "../../import/parse.js";
import { PROFILES_SETTINGS_KEY } from "./authorize.js";
import { compileOperations, type OperationReview } from "./compile.js";
import { READER_VERSION, isReadResult } from "./model.js";
import {
  PLAN_SETTINGS_KEY,
  PLAN_VERSION,
  type OperationPlan,
  type PlanSettings,
} from "./plan.js";
import { readOpenApi, type ReadOptions } from "./read.js";

/*
 * Binding review for an imported OpenAPI description. A normalized definition
 * names operations; it cannot say how their inputs are serialized, so the
 * reviewed approval re-reads the exact source bytes the definition came from
 * (the command layer checked their digest) and compiles the plans for exactly
 * the operations the reviewer approved, under the reviewer's decisions. An
 * approved operation that falls outside the executable subset refuses the
 * whole approval by code rather than binding something that cannot run.
 *
 * Nothing here reaches the network: external references resolve only through
 * the host hook the adapter was built with, as at import.
 */

export type ReviewOptions = {
  maxImportBytes: number;
  parseDocument?:
    ((bytes: Uint8Array, mediaType: string) => unknown) | undefined;
  resolveExternal?: ReadOptions["resolveExternal"] | undefined;
};

function parse(
  bytes: Uint8Array,
  mediaType: string,
  options: ReviewOptions,
): unknown {
  try {
    if (options.parseDocument) return options.parseDocument(bytes, mediaType);
    return parseBoundedDocument(bytes, { mediaType }).value;
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError("invalid-request", {
      detail: "openapi.document-unparseable",
    });
  }
}

function reviewOf(operation: ReviewedOperation): OperationReview {
  return {
    effect: operation.effect,
    outputClassification: operation.outputClassification,
    cost: operation.cost,
    consent: operation.consent,
    replay: operation.replay,
    targetParameters: operation.targetParameters,
  };
}

export async function reviewOpenApiBinding(
  input: BindingReview,
  options: ReviewOptions,
): Promise<BindingReviewResult> {
  if (!input.source)
    throw new ConnectorError("configuration-required", {
      detail: "openapi.review.source-missing",
    });
  if (input.source.bytes.byteLength > options.maxImportBytes)
    throw new ConnectorError("invalid-request", {
      detail: "openapi.document-too-large",
    });
  const read = await readOpenApi(
    parse(input.source.bytes, input.source.mediaType, options),
    {
      sourceRef: input.definition.sourceRef,
      ...(options.resolveExternal
        ? { resolveExternal: options.resolveExternal }
        : {}),
    },
  );
  if (!isReadResult(read))
    throw new ConnectorError("invalid-request", {
      detail: "openapi.review.unreadable",
    });

  const byDestination = new Map<string, ReviewedOperation[]>();
  for (const operation of input.operations) {
    const group = byDestination.get(operation.destinationId) ?? [];
    group.push(operation);
    byDestination.set(operation.destinationId, group);
  }
  const operations: BoundOperation[] = [];
  const plans: Record<string, OperationPlan> = {};
  let verifier: PlanSettings["verifier"];
  for (const [destinationId, group] of byDestination) {
    const destination = input.destinations.find(
      (item) => item.id === destinationId,
    );
    if (!destination)
      throw new ConnectorError("invalid-request", {
        detail: "operation.destination-unapproved",
      });
    const names = group.map((item) => item.nativeId);
    const verifierHere =
      input.verifier && names.includes(input.verifier.nativeId)
        ? input.verifier
        : undefined;
    const compiled = compileOperations(input.definition, read, {
      destinationId,
      destination,
      include: names,
      ...(input.profileId ? { profiles: [input.profileId] } : {}),
      review: Object.fromEntries(
        group.map((item) => [item.nativeId, reviewOf(item)]),
      ),
      ...(verifierHere ? { verifier: verifierHere } : {}),
    });
    for (const reviewed of group) {
      const bound = compiled.operations.find(
        (item) => item.nativeId === reviewed.nativeId,
      );
      // Blocked by the compiler: outside the executable subset, or no bound
      // profile satisfies its security. The diagnostics are on the import.
      if (!bound)
        throw new ConnectorError("invalid-request", {
          detail: "openapi.operation-not-executable",
        });
      if (
        reviewed.authenticationProfile &&
        bound.authenticationProfile !== reviewed.authenticationProfile
      )
        throw new ConnectorError("invalid-request", {
          detail: "openapi.profile-mismatch",
        });
      operations.push(bound);
      plans[bound.operationRef] = compiled.plans[bound.operationRef]!;
    }
    const settings = compiled.settings[PLAN_SETTINGS_KEY] as PlanSettings;
    if (settings.verifier) verifier = settings.verifier;
  }
  if (input.verifier && !verifier)
    throw new ConnectorError("invalid-request", {
      detail: "openapi.verifier-not-read",
    });
  const settings: PlanSettings = {
    version: PLAN_VERSION,
    readerVersion: READER_VERSION,
    plans,
    ...(verifier ? { verifier } : {}),
  };
  return {
    operations,
    settings: {
      [PLAN_SETTINGS_KEY]: settings,
      [PROFILES_SETTINGS_KEY]: input.definition.authentication,
    },
  };
}
