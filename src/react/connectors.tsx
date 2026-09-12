"use client";
import { useMemo, type CSSProperties, type ReactNode } from "react";
import type { ConnectorManifest } from "../core/schema.js";
import {
  humanHandoffs,
  resolveConnection,
  type ConnectionRoute,
  type EntryContext,
  type ResolvedConnection,
} from "../core/resolution.js";

/**
 * The kickoff surface: one card per service, before any ceremony starts.
 *
 * A card answers the three questions somebody actually asks — what is this,
 * what will it be able to do, and what will it cost me. It never asks a fourth
 * one. "OAuth · PKCE or device code?" is a question about a protocol, and the
 * person reading the card is trying to connect a service; the host already
 * declared everything needed to answer it, so the route is resolved here and
 * described in terms of what is about to happen to them.
 *
 * Nothing here fetches, stores or decides. A card renders a manifest against a
 * declared intent and calls `onConnect`; the host owns what happens next.
 */

export type ConnectorStatus = "available" | "connected" | "attention";

export {
  declaredHandoffs,
  humanHandoffs,
  routeFor,
  startsWithoutAPerson,
} from "../core/resolution.js";

/**
 * The route for this manifest under this intent, or nothing when the intent
 * rules every route out.
 *
 * A card must render either way: a service the host cannot currently use is
 * worth showing as unavailable, and is much worse as a button that fails after
 * it is pressed.
 */
export function resolveQuietly(
  manifest: ConnectorManifest,
  intent?: EntryContext,
): ResolvedConnection | undefined {
  try {
    return resolveConnection(manifest, intent ?? {});
  } catch {
    return undefined;
  }
}

const routeLabels: Record<ConnectionRoute, string> = {
  "provider-approval": "Approve at the provider",
  "second-device": "Code on another device",
  "supplied-credential": "Credential you hold",
  "no-account": "No account needed",
};

function initials(name: string): string {
  const words = name.split(/[\s-]+/).filter(Boolean);
  return (
    words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : name.slice(0, 2)
  ).toUpperCase();
}

export interface ProviderMarkProps {
  name: string;
  /** Host-supplied brand asset. Manifests carry no logo, and should not. */
  logo?: ReactNode;
  /** Brand colour behind the fallback initials. */
  tint?: string;
}

export function ProviderMark({ name, logo, tint }: ProviderMarkProps) {
  const style: CSSProperties | undefined = tint
    ? { background: tint, borderColor: tint, color: "#fff" }
    : undefined;
  return (
    <span
      className="connector-mark"
      aria-hidden="true"
      {...(style ? { style } : {})}
    >
      {logo ?? initials(name)}
    </span>
  );
}

export interface HandoffMeterProps {
  count: number;
  /** Pips drawn in total; the scale a reader compares cards against. */
  of?: number;
}

/**
 * The meter is the one loud thing on an otherwise quiet card, because it is the
 * fact that decides whether somebody starts this now or later. It is also the
 * number the resolver minimises, so the card cannot advertise a cost that the
 * route was not chosen for.
 */
export function HandoffMeter({ count, of = 3 }: HandoffMeterProps) {
  const total = Math.max(of, count);
  return (
    <span
      className="handoff"
      data-cost={count}
      title={
        count === 0
          ? "Completes without asking anyone"
          : `Stops to ask a person ${count} ${count === 1 ? "time" : "times"}`
      }
    >
      <span className="handoff-pips" aria-hidden="true">
        {Array.from({ length: total }, (_, index) => (
          <span
            key={index}
            className="handoff-pip"
            data-on={index < count ? "true" : "false"}
          />
        ))}
      </span>
      {count === 0
        ? "No one is interrupted"
        : `${count} ${count === 1 ? "handoff" : "handoffs"}`}
    </span>
  );
}

export function StatusChip({
  status,
  children,
}: {
  status: ConnectorStatus;
  children?: ReactNode;
}) {
  const tone =
    status === "connected" ? "ok" : status === "attention" ? "stop" : "muted";
  return (
    <span className="chip" data-tone={tone}>
      <span className="dot" aria-hidden="true" />
      {children ??
        (status === "connected"
          ? "Connected"
          : status === "attention"
            ? "Needs attention"
            : "Not connected")}
    </span>
  );
}

export interface ConnectorCardProps {
  manifest: ConnectorManifest;
  /**
   * What this integration needs: the permissions it will use, whose account it
   * is for, how much attention it may spend, and which app keys the host holds.
   * The route follows from it. Nobody is asked to choose one.
   */
  intent?: EntryContext;
  status?: ConnectorStatus;
  logo?: ReactNode;
  tint?: string;
  busy?: boolean;
  /** Replaces the default action label, e.g. "Reconnect". */
  actionLabel?: string;
  onConnect(manifest: ConnectorManifest): void;
}

export function ConnectorCard({
  manifest,
  intent,
  status = "available",
  logo,
  tint,
  busy = false,
  actionLabel,
  onConnect,
}: ConnectorCardProps) {
  const resolved = useMemo(
    () => resolveQuietly(manifest, intent),
    [manifest, intent],
  );
  const permissions = resolved?.permissions ?? [];
  return (
    <article
      data-ceremony-card=""
      data-status={resolved ? status : "unavailable"}
    >
      <ProviderMark
        name={manifest.name}
        {...(logo ? { logo } : {})}
        {...(tint ? { tint } : {})}
      />
      <div className="connector-head">
        <h3 className="connector-name">{manifest.name}</h3>
        <StatusChip status={status} />
      </div>
      <p className="connector-summary">
        {resolved
          ? manifest.description
          : "Not available for this integration."}
      </p>
      <div className="connector-foot">
        {resolved ? (
          <ul
            className="connector-methods"
            aria-label={`What ${manifest.name} will be able to do`}
          >
            {permissions.length ? (
              <>
                {permissions.slice(0, 3).map((permission) => (
                  <li key={permission}>
                    <span className="chip">{permission}</span>
                  </li>
                ))}
                {permissions.length > 3 && (
                  <li>
                    <span className="chip">+{permissions.length - 3}</span>
                  </li>
                )}
              </>
            ) : (
              <li>
                <span className="chip">{routeLabels[resolved.route]}</span>
              </li>
            )}
          </ul>
        ) : (
          <p className="connector-blocked">
            No route satisfies what this integration asks for.
          </p>
        )}
        <div className="connector-foot-end">
          <HandoffMeter count={resolved?.handoffs ?? 0} />
          <button
            type="button"
            className="primary"
            disabled={busy || !resolved}
            onClick={() => onConnect(manifest)}
          >
            {busy
              ? "Opening…"
              : (actionLabel ??
                (status === "connected" ? "Manage" : "Connect"))}
          </button>
        </div>
      </div>
    </article>
  );
}

export interface ConnectorGridProps {
  manifests: readonly ConnectorManifest[];
  /** Applied to every card; a connector needing its own is given one by `present`. */
  intent?: EntryContext;
  /** Per-connector presentation the manifest deliberately does not carry. */
  present?(manifest: ConnectorManifest): {
    status?: ConnectorStatus;
    logo?: ReactNode;
    tint?: string;
    busy?: boolean;
    actionLabel?: string;
    intent?: EntryContext;
  };
  onConnect(manifest: ConnectorManifest): void;
  "aria-label"?: string;
}

export function ConnectorGrid({
  manifests,
  intent,
  present,
  onConnect,
  ...rest
}: ConnectorGridProps) {
  return (
    <div
      data-ceremony-grid=""
      role="list"
      aria-label={rest["aria-label"] ?? "Available connections"}
    >
      {manifests.map((manifest) => (
        <div role="listitem" key={manifest.id}>
          <ConnectorCard
            manifest={manifest}
            onConnect={onConnect}
            {...(intent ? { intent } : {})}
            {...(present?.(manifest) ?? {})}
          />
        </div>
      ))}
    </div>
  );
}

/** The route a person would get, without rendering anything. Useful for copy. */
export function routeOf(
  manifest: ConnectorManifest,
  intent?: EntryContext,
): ConnectionRoute | undefined {
  return resolveQuietly(manifest, intent)?.route;
}

/** Interruptions the resolved route costs, or zero when nothing is available. */
export function costOf(
  manifest: ConnectorManifest,
  intent?: EntryContext,
): number {
  const resolved = resolveQuietly(manifest, intent);
  return resolved ? humanHandoffs(resolved.method) : 0;
}
