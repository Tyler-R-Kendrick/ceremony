import { z } from "zod";
import type { AuthOutcome } from "../core/index.js";
import { trustedUrl, type CredentialStore } from "./adapters.js";
import { CeremonyError, type AuthAdapter } from "./controller.js";

/** Claimable Neon's documented auth.md profile, not the WorkOS email/code profile. */
export function createNeonAdapter(
  store: CredentialStore,
  config = {
    issuer: "https://claimable.neon.tech",
    claimOrigins: [
      "https://console.neon.tech",
      "https://neon.com",
      "https://claimable.neon.tech",
    ],
    allowLoopbackHttp: false,
  },
  now = Date.now,
): AuthAdapter {
  const origin = trustedUrl(config.issuer, config).origin;
  let assertion = "";
  let accessToken = "";
  let projectId = "";
  let projectExpires = 0;
  let nextPoll = 0;
  let interval = 5000;
  let stopped = false;
  let outcome: AuthOutcome | undefined;
  const request = (path: string, init: RequestInit = {}) =>
    fetch(new URL(path, origin), {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  const checked = async (response: Response) => {
    if (!response.ok) {
      await response.body?.cancel();
      throw new CeremonyError(
        "Neon could not complete this request. Retry the ceremony.",
      );
    }
    if (stopped) {
      await response.body?.cancel();
      throw new CeremonyError("Attempt cancelled");
    }
    return response.json();
  };
  const persist = async () => {
    const connectionRef = await store.put(
      {
        identity_assertion: assertion,
        access_token: accessToken,
        project_id: projectId,
      },
      outcome?.connectionRef,
    );
    outcome = { connectionRef, ownership: "anonymous", scopes: [] };
    return outcome;
  };
  const exchange = async () => {
    const token = z
      .object({
        access_token: z.string().min(1),
        token_type: z.string().regex(/^bearer$/i),
      })
      .parse(
        await checked(
          await request("/v1/oauth2/token", {
            method: "POST",
            body: new URLSearchParams({
              grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
              assertion,
              resource: `${origin}/`,
            }),
          }),
        ),
      );
    accessToken = token.access_token;
  };
  const claim = async (method: "GET" | "POST") => {
    const send = () =>
      request(`/v1/projects/${encodeURIComponent(projectId)}/claim`, {
        method,
        headers: { authorization: `Bearer ${accessToken}` },
      });
    let response = await send();
    if (response.status === 401) {
      await response.body?.cancel();
      await exchange();
      await persist();
      response = await send();
    }
    return checked(response);
  };
  return {
    async begin() {
      stopped = false;
      const registration = z
        .object({
          identity_assertion: z.string().min(1),
          project: z.object({
            id: z.string().min(1),
            expires_at: z.iso.datetime(),
          }),
        })
        .parse(
          await checked(
            await request("/v1/agent/identity", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                type: "anonymous",
                capabilities: ["postgres"],
                source: "ceremony",
              }),
            }),
          ),
        );
      projectId = registration.project.id;
      projectExpires = Date.parse(registration.project.expires_at);
      if (projectExpires <= now())
        throw new CeremonyError("The project has expired.");
      assertion = registration.identity_assertion;
      await exchange();
      return {
        step: "anonymous",
        expiresAt: projectExpires,
        outcome: await persist(),
        message:
          "Anonymous project access is ready. Claiming transfers ownership; it does not retain these credentials.",
      };
    },
    async submit(values, claiming) {
      if (
        !claiming ||
        Object.keys(values).length ||
        !assertion ||
        projectExpires <= now()
      )
        throw new CeremonyError(
          "This project cannot be claimed from this step.",
        );
      stopped = false;
      const attempt = z
        .object({
          verification_uri_complete: z.url(),
          user_code: z.string().min(1),
          expires_in: z.number().positive(),
          interval: z.number().positive(),
        })
        .parse(await claim("POST"));
      const verification = trustedUrl(
        attempt.verification_uri_complete,
        config,
        false,
      );
      if (!config.claimOrigins.includes(verification.origin))
        throw new CeremonyError("Unrecognized Neon claim origin.");
      interval = attempt.interval * 1000;
      nextPoll = now() + interval;
      return {
        step: "waiting",
        verificationUri: verification.href,
        userCode: attempt.user_code,
        expiresAt: Math.min(projectExpires, now() + attempt.expires_in * 1000),
        message:
          "Sign in on the provider page, choose a destination organization, and accept the transfer.",
      };
    },
    async poll() {
      if (stopped || now() < nextPoll) return undefined;
      nextPoll = now() + interval;
      const status = z
        .object({ reconciled: z.boolean() })
        .parse(await claim("GET"));
      if (!status.reconciled) return undefined;
      if (!outcome) throw new CeremonyError("No project connection exists.");
      // Replace, never retain, pre-claim secrets after ownership transfers.
      await store.put({ project_id: projectId }, outcome.connectionRef);
      assertion = "";
      accessToken = "";
      outcome = { ...outcome, ownership: "claimed", scopes: [] };
      return {
        step: "complete",
        outcome,
        message:
          "Project ownership transferred. Anonymous credentials were discarded; reconnect through your organization for API access.",
      };
    },
    async callback() {
      throw new CeremonyError("Neon claiming does not use an app callback.");
    },
    cancel() {
      stopped = true;
    },
  };
}
