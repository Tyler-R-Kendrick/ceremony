import {
  originOf,
  StaleTargetError,
  type BoundPageLike,
} from "./browser-targets.js";

/**
 * A window the page opened, as Playwright reports one. A popup `Page` already
 * satisfies `BoundPageLike`; the additions are what adopting a window needs -
 * whether it is still there, when its first document has arrived, and the
 * windows *it* opens, which are the page's doing one step removed and are
 * bound by the same rule.
 */
export interface PopupLike extends BoundPageLike {
  isClosed(): boolean;
  waitForLoadState(
    state?: "load" | "domcontentloaded" | "networkidle",
    options?: { timeout?: number },
  ): Promise<void>;
  on(event: "close", listener: () => void): unknown;
  on(event: "popup", listener: (popup: PopupLike) => void): unknown;
}

/** Whatever reports the windows it opens: a page, or a window it opened. */
export interface WindowOpener {
  on?(event: "popup", listener: (popup: PopupLike) => void): unknown;
}

/**
 * The one rule for windows a login page opens, shared by both browser
 * subsystems: the login driver's page adapter (`createPlaywrightCeremonyPage`)
 * and the authorization executor behind authored connectors. It used to live
 * only in the adapter, and the executor refused every window instead - so a
 * "Sign in with ..." button that opens one could be driven by a plan and never
 * by an authored connector. Keeping one copy is what keeps the two from
 * drifting on the part that decides where a credential may be typed.
 *
 * The rule: act in the page until a window at an admitted origin exists, then
 * act in that, and act in the page again once it has closed. Only a window the
 * page itself opened (or a window it opened did) is a candidate - being in the
 * same browser is not the same as being this page's doing. One at an origin
 * that is not admitted refuses (`popup-undeclared`); two at admitted origins
 * identify no document and refuse (`popup-ambiguous`); one still at
 * `about:blank` has not committed a document and is neither adopted nor
 * refused - `settle` is what waits for it.
 */
export function createWindowTracker<W extends PopupLike = PopupLike>(
  page: WindowOpener,
  options: {
    popupOrigins: readonly string[];
    settleTimeoutMs?: number;
    /** Told about every window as it is reported, before anything reads it. */
    onWindow?: (opened: W) => void;
  },
) {
  const popupOrigins = [...options.popupOrigins];
  const settleTimeout = options.settleTimeoutMs ?? 5_000;
  /**
   * How long a settle gives a click to produce its window: the settle
   * timeout, capped at two seconds. The report it waits for is normally
   * milliseconds behind the click, so the margin is wide even on a loaded
   * machine, and the wait ends the moment a window is reported.
   */
  const windowGrace = Math.min(settleTimeout, 2_000);
  const windows = new Set<W>();
  /** Whoever is waiting for the next window to be reported, told once. */
  let arrivals: (() => void)[] = [];
  const watch = (opened: PopupLike) => {
    const window = opened as W;
    windows.add(window);
    options.onWindow?.(window);
    window.on("close", () => windows.delete(window));
    window.on("popup", watch);
    for (const arrived of arrivals.splice(0)) arrived();
  };
  if (popupOrigins.length > 0) {
    if (!page.on)
      throw new Error(
        "popupOrigins needs a page that reports the windows it opens",
      );
    page.on("popup", watch);
  }
  let adopted: W | undefined;
  const noWindowOpen = () => [...windows].every((opened) => opened.isClosed());

  return {
    popupOrigins,
    /** Whether any window this page opened is still open. */
    noWindowOpen,
    /** The window the latest `current` chose, if it chose one. */
    adopted: () => adopted,
    /**
     * The window this attempt acts in, when a window is where it is, or
     * `undefined` for the page. Resolved freshly on every call, so the origin
     * is rechecked at every read and every action.
     */
    current(): W | undefined {
      adopted = undefined;
      if (popupOrigins.length === 0) return undefined;
      const arrived = [...windows].filter(
        (opened) => !opened.isClosed() && opened.url() !== "about:blank",
      );
      if (
        arrived.some((opened) => !popupOrigins.includes(originOf(opened.url())))
      )
        throw new StaleTargetError("popup-undeclared");
      if (arrived.length > 1) throw new StaleTargetError("popup-ambiguous");
      adopted = arrived[0];
      return adopted;
    },
    /**
     * Wait for what an action may have set in motion in windows.
     *
     * Playwright reports a window once it has set it up, which is after the
     * click that opened it has returned and can be after the opener has
     * already reported itself idle. So a caller that knows an action may have
     * asked for a window (`windowMayOpen`) waits, bounded, for the report -
     * and the wait ends the moment it arrives. Then every open window is
     * given until its first document commits, so the next read sees where
     * the window went instead of reading past it at `about:blank`.
     */
    async settle(windowMayOpen: boolean): Promise<void> {
      if (windowMayOpen && noWindowOpen()) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await new Promise<void>((resolve) => {
          arrivals.push(resolve);
          timer = setTimeout(resolve, windowGrace);
        });
        clearTimeout(timer);
        arrivals = [];
      }
      await Promise.all(
        [...windows]
          .filter((opened) => !opened.isClosed())
          .map((opened) =>
            opened
              .waitForLoadState("domcontentloaded", {
                timeout: settleTimeout,
              })
              .catch(() => {}),
          ),
      );
    },
  };
}

export type WindowTracker<W extends PopupLike = PopupLike> = ReturnType<
  typeof createWindowTracker<W>
>;
