import { type PageSnapshot } from "../core/browser-contracts.js";
import {
  createBoundTargets,
  originOf,
  StaleTargetError,
  type BoundPageLike,
  type JsHandleLike,
} from "./browser-targets.js";
import type { CeremonyPage } from "./browser-driver.js";
import { createWindowTracker, type PopupLike } from "./browser-windows.js";

export { StaleTargetError, DispatchUncertain } from "./browser-targets.js";
export type { PopupLike } from "./browser-windows.js";

/**
 * The part of a Playwright page this adapter uses. Declaring it structurally
 * keeps `playwright-core` out of the driver's type surface and lets unit tests
 * substitute a recording page while the browser suite passes a real one.
 *
 * `evaluateHandle` is the important addition: it is what lets the adapter hold
 * references to the controls it observed instead of addressing them later
 * through the page's own DOM, which the page is free to rewrite in between.
 */
export interface PlaywrightPageLike extends BoundPageLike {
  url(): string;
  goto(
    url: string,
    options?: { waitUntil?: "domcontentloaded" },
  ): Promise<unknown>;
  evaluateHandle(source: string): Promise<JsHandleLike>;
  waitForLoadState(
    state?: "load" | "domcontentloaded" | "networkidle",
    options?: { timeout?: number },
  ): Promise<void>;
  /**
   * Every frame currently in the page, main frame included, as Playwright
   * reports them. A Playwright `Frame` already satisfies `BoundPageLike`
   * exactly — `url`, `evaluateHandle`, `evaluate` — which is why observing
   * inside one needs no second implementation of anything below.
   */
  frames(): readonly BoundPageLike[];
  /**
   * The top-level document. Named separately rather than inferred from
   * position, because "is this the page itself?" is the one question the
   * frame rule below has to answer exactly, and a same-origin frame would
   * make any guess about it wrong.
   */
  mainFrame(): BoundPageLike;
  /**
   * Windows this page opens, as it opens them, in the shape Playwright's
   * `popup` event delivers them. Optional: a page that cannot report them can
   * still be driven, only never with `popupOrigins`, which refuses at
   * construction rather than binding to windows it would never hear about.
   */
  on?(event: "popup", listener: (popup: PopupLike) => void): unknown;
}

/**
 * Bind a live Playwright page to the driver. The adapter exposes navigation,
 * form entry and clicks, and reading the one kind of value a plan may declare
 * it keeps — what an observed read-only field displays. No scripting,
 * downloads, network interception or markup extraction is reachable through it.
 *
 * Every action is revalidated against the observation that authorized it. A
 * navigation, a re-render, a moved control, a disabled control or a changed
 * form destination between the snapshot and the action ends the step with a
 * named refusal rather than filling whatever is in the page now — which is the
 * whole difference between approving an element and approving a position.
 */
export function createPlaywrightCeremonyPage(
  page: PlaywrightPageLike,
  options: {
    settleTimeoutMs?: number;
    /**
     * Origins whose frame this login happens inside. Empty — the ordinary
     * case — means the top-level document and nothing else.
     */
    frameOrigins?: readonly string[];
    /**
     * Origins at which a window the page opens is where this login continues.
     * Empty - the ordinary case - means a window the page opens is not this
     * attempt's concern: the page stays the target, whatever it opened.
     */
    popupOrigins?: readonly string[];
  } = {},
): CeremonyPage {
  const settleTimeout = options.settleTimeoutMs ?? 5_000;
  const frameOrigins = [...(options.frameOrigins ?? [])];
  const popupOrigins = [...(options.popupOrigins ?? [])];

  /**
   * Windows the page opened - or a window it opened did - and the rule for
   * which one this attempt acts in. Shared with the authorization executor
   * (see `browser-windows.ts`), so both apply the same rule to the same
   * report rather than two copies of it.
   */
  const windows = createWindowTracker(page, {
    popupOrigins,
    settleTimeoutMs: settleTimeout,
  });
  /** The window the latest resolution chose, for the click that closes it. */
  const adopted = () => windows.adopted();
  const noWindowOpen = windows.noWindowOpen;
  /**
   * Whether the latest action was a click made while no window was open -
   * the one action that can open the window this attempt continues in.
   *
   * Nothing in the opener says a window is on its way, so `settle` cannot
   * wait for one unless it is told that a click might have asked for one;
   * this is that telling. Any other action disarms it. The wait it arms is
   * bounded by a grace of at most two seconds - what a click that opens
   * nothing costs on a plan that admits windows, paid per settle until the
   * next action, never on a plan that does not.
   */
  let windowMayOpen = false;

  /**
   * The window this attempt acts in, when a window is where it is.
   *
   * This is the rule frames did not need. A frame is there to be found: name
   * it, resolve it on every read, refuse when it is absent. A window is not
   * there until the page opens it, so "act in the declared window" would
   * refuse the attempt before it pressed the button that opens one. The
   * tracker's rule is therefore: act in the page until a window at an
   * admitted origin exists, then act in that, and act in the page again once
   * it has closed - with an undeclared or second window refused by name.
   */
  const windowOf = (): PopupLike | undefined => windows.current();

  /**
   * Which document this attempt observes and acts in.
   *
   * Resolved freshly on every call rather than chosen once, and that is the
   * whole design. A frame is not a stable thing to hold: it can be removed,
   * replaced, or navigated to somewhere else entirely between an observation
   * and the action it authorized. Because every read below goes through here,
   * the origin is rechecked at observation time *and* again at action time
   * without a second rule saying so — and the guards in `browser-targets.ts`
   * then compare the held document against whatever this returns, exactly as
   * they do for a page.
   *
   * A declared frame that is not here refuses rather than falling back to the
   * page. Falling back would type a credential into the embedding document,
   * which is a different origin with a different form; naming the frame was
   * the statement that it is not that one.
   */
  const target = (): BoundPageLike => {
    // A window comes first: inside one, the attempt acts in the window's own
    // document, and a frame named for the page is not looked for there.
    const opened = windowOf();
    if (opened) return opened;
    if (frameOrigins.length === 0) return page;
    const main = page.mainFrame();
    const matches = page
      .frames()
      .filter(
        (frame) =>
          frame !== main && frameOrigins.includes(originOf(frame.url())),
      );
    if (matches.length === 0) throw new StaleTargetError("frame-missing");
    if (matches.length > 1) throw new StaleTargetError("frame-ambiguous");
    return matches[0] as BoundPageLike;
  };

  /**
   * What the observation machinery binds to. Every method defers, so nothing
   * downstream holds a frame across the gap where it could stop being one.
   */
  const bound: BoundPageLike = {
    url: () => target().url(),
    evaluateHandle: (source) => target().evaluateHandle(source),
    evaluate: (fn, arg) => target().evaluate(fn, arg),
  };
  const targets = createBoundTargets(bound);
  const settle = async () => {
    try {
      await page.waitForLoadState("networkidle", { timeout: settleTimeout });
    } catch {
      // A page that keeps a connection open is not a failed step; the driver's
      // own stall detection decides whether progress stopped.
    }
    // The opener being idle says nothing about a window it has just asked
    // for: Playwright's report of it can still be on its way. Reading now
    // would read the opener, whose only button has already been pressed, and
    // an interpreter shown that page has nothing left to do but wait and then
    // give up - which is how TARGET-POPUP failed on a loaded CI runner. So a
    // click that may have opened a window waits, bounded, for the page to say
    // what it opened, and every window just opened is given until its first
    // document commits. It is closed here rather than by making the driver's
    // `wait` sleep, because only the adapter knows a click happened while a
    // window could still arrive, and so only here can the wait end the moment
    // the report does.
    await windows.settle(windowMayOpen);
  };
  return {
    url: async () => {
      // The window's address when a window is where the attempt is, so the
      // driver's own origin guard and callback check apply to the document
      // being acted in. A refusal belongs to the read that follows, under
      // its own name; until then the address reported is the page's.
      let opened: PopupLike | undefined;
      try {
        opened = windowOf();
      } catch {
        opened = undefined;
      }
      return opened ? opened.url() : page.url();
    },
    goto: async (target) => {
      windowMayOpen = false;
      await targets.release();
      await page.goto(target, { waitUntil: "domcontentloaded" });
      // `domcontentloaded` means the document has started, not that it is the
      // document that will still be here in a moment: a client-side redirect,
      // a late replacement or a framework's first commit can all follow it.
      // Whoever observes next holds a reference to whatever was there at this
      // instant, so observing too early produces a `stale-document` refusal on
      // the first action — the protection working correctly, on a page that was
      // never actually swapped underneath anyone.
      //
      // WebKit is where this showed up, intermittently and only under load,
      // which is exactly the shape of a window that is normally too narrow to
      // hit. Settling here closes it for every engine rather than special-casing
      // the one that happened to reveal it.
      await settle();
    },
    snapshot: async (): Promise<PageSnapshot> => targets.observe(),
    readIssued: (element) => targets.readIssued(element),
    fill: async (element, value) => {
      windowMayOpen = false;
      await targets.act(element, async (handle) => {
        if (element.kind === "select") await handle.selectOption(value);
        else await handle.fill(value);
      });
    },
    check: async (element) => {
      windowMayOpen = false;
      await targets.act(element, (handle) => handle.check());
    },
    // By the option's visible label, never its `value` attribute: the label
    // is what the observation listed and what the plan or recording named,
    // and a value attribute is markup no interpreter was shown. Playwright
    // refuses a label the live control does not offer, which arrives here as
    // a stale element rather than a different choice.
    select: async (element, option) => {
      windowMayOpen = false;
      if (element.kind !== "select")
        throw new StaleTargetError("stale-element");
      await targets.act(element, (handle) =>
        handle.selectOption({ label: option }),
      );
    },
    click: async (element) => {
      // The only action that can send something. `dispatches` turns on the
      // post-action destination re-read, so a form re-pointed during
      // Playwright's actionability wait is reported as uncertainty rather than
      // as a step that went where it was approved to go.
      windowMayOpen = popupOrigins.length > 0 && noWindowOpen();
      try {
        await targets.act(element, (handle) => handle.click(), {
          dispatches: true,
        });
      } catch (error) {
        // A window that closed under the click it was given is the ordinary
        // end of a window's job - the submission went, the window reported
        // back and left - and not a tab that vanished under the attempt. The
        // page that opened it is still here, and the next read is of it.
        if (
          error instanceof StaleTargetError &&
          error.reason === "target-closed" &&
          adopted() !== undefined &&
          adopted()!.isClosed()
        )
          return;
        throw error;
      }
    },
    submissionTarget: async (element) => {
      const destination = targets.destinationOf(element);
      if (!destination?.form) return undefined;
      if (!destination.action) return "unknown";
      // The origin, never the URL: a login action can carry an identifier, a
      // continuation or a token in its query string, and an effect record is
      // read by callers who are not entitled to any of that.
      try {
        return new URL(destination.action).origin;
      } catch {
        return "unknown";
      }
    },
    settle,
  };
}
