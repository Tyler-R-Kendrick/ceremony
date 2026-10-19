import * as oauth from "oauth4webapi";
import type { AdapterCallContext } from "../adapter.js";
import { ConnectorError } from "../errors.js";
import {
  neverSent,
  refusedBeforeSend,
  safeCause,
  tokenErrorDetail,
  wireError,
} from "./wire.js";

/*
 * What a refresh grant that did not come back as tokens means for the journal.
 * The attempt was recorded before anything was sent, and the refresh token is
 * single use, so the entry is completed by what is known:
 *
 * - never sent (nothing listening): `not-applied`, and a later try is safe;
 * - the issuer answered and refused: `failed`, with its registered error;
 * - anything else, including an answer too large to read or one that did not
 *   come back at all: `indeterminate`. The request went out and the token may
 *   have been spent, so it is never presented again.
 *
 * A refusal by this engine before a byte was sent is passed on as it is.
 */
export async function failRefresh(
  ctx: AdapterCallContext,
  effectRef: string,
  failure: unknown,
): Promise<never> {
  if (refusedBeforeSend(failure)) throw failure;
  const settle = (
    status: "not-applied" | "failed" | "indeterminate",
    code: string,
  ) =>
    ctx.environment.effects.complete(effectRef, {
      status,
      code,
      at: ctx.environment.now(),
    });
  if (neverSent(failure)) {
    await settle("not-applied", "oauth.refresh.unreachable");
    throw wireError(failure, "oauth.refresh");
  }
  if (failure instanceof oauth.ResponseBodyError) {
    await settle("failed", tokenErrorDetail(failure.error));
    throw wireError(failure, "oauth.refresh");
  }
  await settle("indeterminate", "oauth.refresh.indeterminate");
  throw new ConnectorError("indeterminate", {
    detail: "oauth.refresh.indeterminate",
    cause: safeCause(failure),
  });
}
