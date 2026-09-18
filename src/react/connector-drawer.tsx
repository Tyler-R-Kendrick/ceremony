"use client";
import {
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";

/**
 * The drawer a connection happens in.
 *
 * It is a modal dialog, so it owes a person three things that are easy to skip:
 * focus moves into it when it opens, Tab cannot leave it while it is open, and
 * focus returns to whatever opened it when it closes. Without the third, a
 * keyboard user who closes the drawer is returned to the top of the document
 * and has to walk the whole directory again to get back to the card they were
 * on.
 *
 * It owns no connection state. Everything it renders is passed in, so the same
 * shell serves a connection, an import review, or a host's own surface.
 */

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(focusableSelector)].filter(
    (element) =>
      !element.hasAttribute("hidden") &&
      element.getAttribute("aria-hidden") !== "true",
  );
}

/**
 * Keeps Tab inside `container` while `active`, and restores focus to the
 * element that had it when the trap engaged. The restore target is captured
 * once, so re-rendering while open cannot lose it.
 */
export function useFocusTrap(
  container: RefObject<HTMLElement | null>,
  active: boolean,
  onEscape?: () => void,
): void {
  const restoreTo = useRef<HTMLElement | null>(null);
  const escape = useRef(onEscape);
  escape.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const root = container.current;
    if (!root || typeof document === "undefined") return;
    const previous = document.activeElement;
    restoreTo.current =
      previous && previous instanceof HTMLElement ? previous : null;
    const first = focusableWithin(root)[0];
    (first ?? root).focus?.();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        escape.current?.();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableWithin(root);
      if (!focusable.length) {
        event.preventDefault();
        root.focus?.();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const current = document.activeElement;
      // A container that lost focus entirely — a removed control, a click on
      // the backdrop — would otherwise let the next Tab escape the dialog.
      if (!current || !root.contains(current as Node)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };
    root.addEventListener("keydown", onKeyDown as EventListener);
    return () => {
      root.removeEventListener("keydown", onKeyDown as EventListener);
      const target = restoreTo.current;
      restoreTo.current = null;
      if (target && target.isConnected) target.focus?.();
    };
  }, [active, container]);
}

export interface ConnectorDrawerProps {
  open: boolean;
  title: string;
  /** A short line under the title; the service and how it is reached. */
  subtitle?: ReactNode;
  /** Shown at the foot of the drawer, below the content. */
  footer?: ReactNode;
  onClose(): void;
  children: ReactNode;
  id?: string;
  "aria-label"?: string;
}

export function ConnectorDrawer({
  open,
  title,
  subtitle,
  footer,
  onClose,
  children,
  id = "connector-drawer",
  "aria-label": label,
}: ConnectorDrawerProps) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useCallback(() => onClose(), [onClose]);
  useFocusTrap(panel, open, close);
  if (!open) return null;
  return (
    <div data-connector="" data-connector-drawer-root="" className="connector-drawer-root">
      {/*
        A person who clicks beside the drawer means to leave it. It is a button
        so the intent is reachable from a screen reader too, and it is hidden
        from the tab order because the drawer's own Close is the keyboard way
        out and two of them in a trap is a maze.
      */}
      <button
        type="button"
        className="connector-scrim"
        tabIndex={-1}
        aria-label={`Close ${title}`}
        onClick={close}
      />
      <div
        className="connector-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        {...(label ? { "aria-label": label } : {})}
        id={id}
        tabIndex={-1}
        ref={panel}
      >
        <div className="connector-drawer-head">
          <div>
            <h2 id={`${id}-title`}>{title}</h2>
            {subtitle && <p className="connector-muted">{subtitle}</p>}
          </div>
          <button type="button" className="quiet" onClick={close}>
            Close
          </button>
        </div>
        <div className="connector-drawer-body">{children}</div>
        {footer && <div className="connector-drawer-foot">{footer}</div>}
      </div>
    </div>
  );
}
