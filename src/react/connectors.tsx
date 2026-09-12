"use client";
import type { CSSProperties, ReactNode } from "react";
import type { AuthMethod, ConnectorManifest } from "../core/schema.js";

/**
 * The kickoff surface: one card per service, before any ceremony starts.
 *
 * A card answers three questions in the order somebody actually asks them —
 * what is this, how would I connect, and what will it cost me. The third is the
 * one a list of logos never answers, and it is the only thing on the card that
 * this project knows and a directory of integrations does not.
 *
 * Nothing here fetches, stores or decides. A card renders a manifest and calls
 * `onConnect`; the host owns what happens next.
 */

export type ConnectorStatus = "available" | "connected" | "attention";

/** How many points a route hands off to a person, as its contract declares. */
export function declaredHandoffs(method: AuthMethod): number {
  // The schema requires a handoff on the method and on every prerequisite, so
  // this counts what is written down rather than estimating from the kind.
  return method.contract ? 1 + method.contract.prerequisites.length : 1;
}

/** Anonymous access is reachable without anyone being asked for anything. */
export function startsWithoutAPerson(method: AuthMethod): boolean {
  return (
    method.kind === "authmd-anonymous" ||
    (method.contract?.completion.ownership.includes("anonymous") ?? false)
  );
}

/**
 * The route a person would pick: fewest interruptions, then fewest fields.
 * Same rule `preferredPath` applies to a discovered plan, for the same reason.
 */
export function cheapestMethod(manifest: ConnectorManifest): AuthMethod {
  return [...manifest.methods].sort(
    (a, b) =>
      declaredHandoffs(a) - declaredHandoffs(b) ||
      a.fields.length - b.fields.length,
  )[0]!;
}

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
 * fact that decides whether somebody starts this now or later.
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
  status = "available",
  logo,
  tint,
  busy = false,
  actionLabel,
  onConnect,
}: ConnectorCardProps) {
  const route = cheapestMethod(manifest);
  const cost = declaredHandoffs(route);
  const anonymous = startsWithoutAPerson(route);
  return (
    <article data-ceremony-card="" data-status={status}>
      <ProviderMark
        name={manifest.name}
        {...(logo ? { logo } : {})}
        {...(tint ? { tint } : {})}
      />
      <div className="connector-head">
        <h3 className="connector-name">{manifest.name}</h3>
        <StatusChip status={status} />
      </div>
      <p className="connector-summary">{manifest.description}</p>
      <div className="connector-foot">
        <ul
          className="connector-methods"
          aria-label={`${manifest.name} methods`}
        >
          {manifest.methods.slice(0, 3).map((method) => (
            <li key={method.id}>
              <span className="chip">{method.label}</span>
            </li>
          ))}
          {manifest.methods.length > 3 && (
            <li>
              <span className="chip">+{manifest.methods.length - 3}</span>
            </li>
          )}
        </ul>
        <div className="connector-foot-end">
          <HandoffMeter count={anonymous ? 0 : cost} />
          <button
            type="button"
            className="primary"
            disabled={busy}
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
  /** Per-connector presentation the manifest deliberately does not carry. */
  present?(manifest: ConnectorManifest): {
    status?: ConnectorStatus;
    logo?: ReactNode;
    tint?: string;
    busy?: boolean;
    actionLabel?: string;
  };
  onConnect(manifest: ConnectorManifest): void;
  "aria-label"?: string;
}

export function ConnectorGrid({
  manifests,
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
            {...(present?.(manifest) ?? {})}
          />
        </div>
      ))}
    </div>
  );
}
