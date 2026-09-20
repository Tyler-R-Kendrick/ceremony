import {
  boundSnapshotSource,
  sameDestination,
  type ElementDestination,
  type PageSnapshot,
  type SnapshotElement,
} from "../core/browser-contracts.js";

/**
 * Element identity that lives in the driver rather than in the page.
 *
 * The previous adapter addressed controls by writing `data-ceremony-index` on
 * them and later resolving `[data-ceremony-index="3"]`. Between those two
 * moments the driver awaits an interpreter and a credential lookup, and the
 * page is running the whole time. It can move the attribute onto another input,
 * put a second element with the same attribute earlier in the document, or
 * replace the document outright — and the selector happily resolves to whatever
 * is there now. The approval was for one element; the action lands on another.
 *
 * Here the reference is a live JavaScript handle held outside the page. A page
 * cannot forge one, cannot make one point elsewhere, and cannot keep one valid
 * across a navigation. Every check below is then a real question about the
 * element that was actually approved.
 */

/** Why an action was refused. These map onto blocked reasons of the same name. */
export type StaleTargetReason =
  | "stale-document"
  | "stale-element"
  | "no-observation"
  | "unapproved-recipient"
  | "target-unavailable"
  | "target-closed"
  | "frame-missing"
  | "frame-ambiguous";

export class StaleTargetError extends Error {
  constructor(
    readonly reason: StaleTargetReason,
    /**
     * Whether the refused action had already begun.
     *
     * Every reason here means nothing was *approved*, and almost always that
     * the operation never ran either - the guards refuse before it does. The
     * exception is a dispatching click that threw while the page was being
     * replaced: Playwright can lose the execution context between sending the
     * submission and returning, so the throw is not evidence that nothing was
     * sent. A caller that would otherwise act again must not act again on
     * that one.
     */
    readonly begun = false,
  ) {
    super(`Refused: ${reason}`);
    this.name = "StaleTargetError";
  }
}

/**
 * The action already happened and where it went is genuinely not known.
 *
 * Deliberately not a `StaleTargetError`. Every reason in that type means the
 * ceremony declined to act, which a caller may safely retry. This one means the
 * opposite: something left the browser and the only honest report is that the
 * outcome is undetermined. Collapsing the two — in either direction — produces
 * a claim nobody can act on correctly.
 */
export class DispatchUncertain extends Error {
  constructor() {
    super("A submission was dispatched and its destination is not confirmed");
    this.name = "DispatchUncertain";
  }
}

/**
 * The parts of a Playwright handle this module uses.
 *
 * Declared structurally, like the existing page adapter, so `playwright-core`
 * stays out of the type surface and a recording double can stand in for unit
 * tests while the browser suite passes real handles.
 *
 * `evaluate` takes its function as a *string*. The repository compiles with
 * esbuild's `keepNames`, which rewrites function literals to call a `__name`
 * helper that exists in the bundle and not in the page; shipping source text
 * avoids making correctness depend on which tool compiled the caller.
 */
export interface JsHandleLike {
  evaluate(source: string, arg?: unknown): Promise<unknown>;
  getProperty(name: string): Promise<JsHandleLike>;
  asElement(): ElementHandleLike | null;
  dispose(): Promise<void>;
  jsonValue(): Promise<unknown>;
}

export interface ElementHandleLike extends JsHandleLike {
  fill(value: string): Promise<void>;
  click(): Promise<void>;
  check(): Promise<void>;
  selectOption(value: string): Promise<unknown>;
}

export interface BoundPageLike {
  url(): string;
  evaluateHandle(source: string): Promise<JsHandleLike>;
  /**
   * Playwright only *calls* a page function when it is given a real function;
   * a string is evaluated and its value returned. The revalidation checks
   * therefore arrive as inline arrows written at their call sites, while the
   * rules they apply live on the observation object the page cannot reach.
   */
  evaluate<Arg, Result>(fn: (arg: Arg) => Result, arg: Arg): Promise<Result>;
}

/** One observation: what was seen, and the references that were seen. */
type Observation = {
  origin: string;
  snapshot: PageSnapshot;
  root: JsHandleLike;
  elements: JsHandleLike;
  forms: JsHandleLike;
  /** The document node observed, held so a replacement is detectable. */
  document: JsHandleLike;
  destinations: readonly ElementDestination[];
};

/**
 * A Playwright error that means the page moved on. Playwright reports a
 * destroyed execution context, a detached frame or a navigated-away handle in
 * prose rather than with a code, so the message is matched — narrowly, and only
 * to classify a refusal that has already been decided.
 */
function movedOn(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return (
    text.includes("Execution context was destroyed") ||
    text.includes("frame was detached") ||
    text.includes("Frame was detached") ||
    text.includes("navigat")
  );
}

/**
 * The page, tab or browser is gone, as opposed to showing something else.
 *
 * Split out of `movedOn` because the two call for opposite responses and had
 * been sharing an answer. A document that moved on leaves a document to read,
 * which is why a refusal naming one is worth re-reading once. A target that
 * closed leaves nothing, so the re-read is spent on a page that cannot come
 * back and the attempt then reports that the *document* moved - sending
 * whoever reads it to the guards that compare documents, for a tab that is not
 * there. Naming it is the fix; the same split #53 made between a document that
 * moved and an approval that was never taken.
 */
function closed(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return (
    text.includes("Target closed") ||
    text.includes("Target page, context or browser has been closed")
  );
}

/**
 * The origin of an address, or the empty string when there isn't one.
 *
 * Exported so that frame selection in the adapter compares origins the same
 * way the document guard here does. Two spellings of "same origin" in one
 * attempt is how a check starts disagreeing with the thing it protects.
 */
/**
 * Classify a failure that happened while talking to the page.
 *
 * A `StaleTargetError` arriving here was raised by a guard that already knows
 * exactly what went wrong — frame selection is the one that does, because it
 * runs inside every read and every action rather than before them. Re-reading
 * that as "the target is unavailable" would replace a precise name with a
 * guess, and send whoever reads it looking at the wrong thing.
 */
function classify(
  error: unknown,
  settled: StaleTargetReason,
  begun = false,
): StaleTargetError {
  if (error instanceof StaleTargetError) return error;
  if (closed(error)) return new StaleTargetError("target-closed", begun);
  return new StaleTargetError(
    movedOn(error) ? "stale-document" : settled,
    begun,
  );
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/**
 * Bind observations and actions to one document.
 *
 * The contract is narrow on purpose: observe, then act on something that was
 * observed, with every action revalidated against the observation that
 * authorized it. There is no way to ask this object to run arbitrary script, to
 * read markup, or to address an element it did not itself capture.
 */
export function createBoundTargets(page: BoundPageLike) {
  let current: Observation | undefined;

  /** Let go of one observation's handles. Never touches what is held now. */
  const dispose = async (stale: Observation | undefined) => {
    if (!stale) return;
    // Disposal is best-effort: after a navigation the handles are already gone,
    // and failing to release them must not turn into a second reported fault.
    await Promise.all([
      stale.root.dispose().catch(() => {}),
      stale.elements.dispose().catch(() => {}),
      stale.forms.dispose().catch(() => {}),
      stale.document.dispose().catch(() => {}),
    ]);
  };

  const discard = async () => {
    const stale = current;
    current = undefined;
    await dispose(stale);
  };

  /**
   * Read the page, and hold what was read.
   *
   * The previous observation stays held until a new one is complete.
   *
   * `discard()` used to run first, which left nothing held for the whole of
   * the read below - several awaited round trips to the browser, and seconds
   * of them on a loaded machine. Nothing was protected by that window.
   * An approval's safety comes from the guards in `resolve()`, which compare
   * the held document against the live one and the held element against the
   * description that was approved; an empty slot adds no check. What it adds
   * is a way for anything arriving mid-read to be refused as
   * `no-observation` - a refusal that names the absence of an approval rather
   * than anything about the page, and so sends its reader nowhere.
   *
   * So the swap happens at the end and the old handles are released after the
   * new ones are installed. A read that *fails* still clears, because a failed
   * read is a real loss of confidence in what is held.
   */
  async function observe(): Promise<PageSnapshot> {
    const previous = current;
    let root: JsHandleLike;
    try {
      root = await page.evaluateHandle(boundSnapshotSource());
    } catch (error) {
      await discard();
      throw classify(error, "target-unavailable");
    }
    try {
      const [
        snapshotHandle,
        elements,
        forms,
        documentHandle,
        destinationsHandle,
        originHandle,
      ] = await Promise.all([
        root.getProperty("snapshot"),
        root.getProperty("elements"),
        root.getProperty("forms"),
        root.getProperty("document"),
        root.getProperty("destinations"),
        root.getProperty("origin"),
      ]);
      const snapshot = (await snapshotHandle.jsonValue()) as PageSnapshot;
      const destinations =
        (await destinationsHandle.jsonValue()) as readonly ElementDestination[];
      const origin = String(await originHandle.jsonValue());
      await Promise.all([
        snapshotHandle.dispose().catch(() => {}),
        destinationsHandle.dispose().catch(() => {}),
        originHandle.dispose().catch(() => {}),
      ]);
      // Installed before the old one is released, so there is no instant at
      // which this adapter holds nothing while a page is readable.
      current = {
        origin,
        snapshot,
        root,
        elements,
        forms,
        document: documentHandle,
        destinations,
      };
      await dispose(previous);
      return snapshot;
    } catch (error) {
      await root.dispose().catch(() => {});
      await discard();
      throw classify(error, "target-unavailable");
    }
  }

  /**
   * Resolve an approved index back to the element that was approved, refusing
   * if anything about it has changed.
   *
   * The order matters. The document is checked before the element, and the
   * element before its destination, so the reported reason names the outermost
   * thing that actually moved rather than a symptom of it.
   */
  async function resolve(element: SnapshotElement): Promise<ElementHandleLike> {
    const observation = current;
    // Nothing held. The document-comparison guards below are what detect a page
    // that moved on; reaching here means no approval was ever taken, or one was
    // released and not replaced, which is a different fault with a different
    // fix and so a different name.
    if (!observation) throw new StaleTargetError("no-observation");

    // The page navigating is the common case and the cheapest to detect: the
    // adapter's own view of the address is authoritative, unlike anything the
    // document could report about itself.
    if (originOf(page.url()) !== observation.origin)
      throw new StaleTargetError("stale-document");

    // An origin comparison misses a navigation that stayed on the same origin,
    // and a provider's own login flow is full of those. Comparing the held
    // document node against the live one catches every document replacement,
    // whatever address it arrived at, and a page cannot answer this falsely
    // because it never sees which node is being compared.
    const ask = async <Result>(
      fn: (arg: { root: never; index: number }) => Result,
      index: number,
    ): Promise<Result> => {
      try {
        return await page.evaluate(fn, {
          root: observation.root as never,
          index,
        });
      } catch (error) {
        throw classify(error, "stale-element");
      }
    };

    // This particular question can only fail for one reason: the observation's
    // references no longer belong to the page in front of us. Classifying it
    // from the error text would make the reported reason depend on how a
    // browser happens to word "that context is gone", so any failure here is
    // simply what it is — a document that moved on.
    let sameDocument: unknown;
    try {
      sameDocument = await page.evaluate(
        ({ root }) =>
          (root as unknown as { sameDocument(): boolean }).sameDocument(),
        { root: observation.root as never },
      );
    } catch {
      throw new StaleTargetError("stale-document");
    }
    if (sameDocument !== true) throw new StaleTargetError("stale-document");

    const approved = observation.snapshot.elements[element.index];
    const destination = observation.destinations[element.index];
    if (!approved || !destination) throw new StaleTargetError("stale-element");
    // An index alone is not a reference. The caller must be acting on the same
    // control it was shown, not merely on the same position in a list that the
    // page has since rebuilt.
    if (
      approved.kind !== element.kind ||
      approved.name !== element.name ||
      approved.type !== element.type
    )
      throw new StaleTargetError("stale-element");

    type Bound = {
      elements: unknown[];
      forms: unknown[];
      usable(element: unknown): boolean;
      sameForm(element: unknown, form: unknown): boolean;
      destination(element: unknown): ElementDestination;
    };

    const usable = await ask(({ root, index }) => {
      const bound = root as unknown as Bound;
      return bound.usable(bound.elements[index]);
    }, element.index);
    if (usable !== true) throw new StaleTargetError("stale-element");

    // Form re-association is invisible in a destination comparison when the
    // new form happens to post to the same place, so identity is checked
    // against the exact form node captured alongside the control.
    const stillOwned = await ask(({ root, index }) => {
      const bound = root as unknown as Bound;
      return bound.sameForm(bound.elements[index], bound.forms[index]);
    }, element.index);
    if (stillOwned !== true) throw new StaleTargetError("stale-element");

    const now = await ask(({ root, index }) => {
      const bound = root as unknown as Bound;
      return bound.destination(bound.elements[index]);
    }, element.index);
    if (!sameDestination(destination, now))
      throw new StaleTargetError("unapproved-recipient");

    try {
      const slot = await observation.elements.getProperty(
        String(element.index),
      );
      const handle = slot.asElement();
      if (!handle) {
        await slot.dispose().catch(() => {});
        throw new StaleTargetError("stale-element");
      }
      return handle;
    } catch (error) {
      if (error instanceof StaleTargetError) throw error;
      throw classify(error, "stale-element");
    }
  }

  /**
   * Perform one action on a revalidated element.
   *
   * Playwright's own actionability wait can run for seconds, during which the
   * page may change again, so the destination is read once more immediately
   * afterwards. That second read cannot un-send a submission, which is exactly
   * why it is reported as uncertainty rather than as success.
   */
  async function act(
    element: SnapshotElement,
    operation: (handle: ElementHandleLike) => Promise<unknown>,
    options: { dispatches?: boolean } = {},
  ): Promise<void> {
    const handle = await resolve(element);
    const approved = current?.destinations[element.index];
    try {
      await operation(handle);
    } catch (error) {
      // Marked begun only for a dispatching action. A fill that threw put
      // nothing on the wire whatever else went wrong; a click may have.
      throw classify(error, "stale-element", options.dispatches === true);
    }
    if (!options.dispatches || !approved) return;
    const observation = current;
    // The observation being gone is the same answer as the read below failing:
    // the document moved on, which is what a submission does.
    if (!observation) return;

    // Read the destination once more, now that the action is over. A page that
    // re-pointed the form during Playwright's actionability wait would have
    // passed every check above and still sent the submission somewhere else.
    let after: ElementDestination;
    try {
      after = await page.evaluate(
        ({ root, index }) => {
          const bound = root as unknown as {
            elements: unknown[];
            destination(element: unknown): ElementDestination;
          };
          return bound.destination(bound.elements[index]);
        },
        { root: observation.root as never, index: element.index },
      );
    } catch {
      // The document went away, which is what a submission normally does. An
      // unreadable page after a click is the expected shape of success, not
      // evidence against it, and reporting every completed login as uncertain
      // would make the uncertainty signal worthless.
      return;
    }
    if (!sameDestination(approved, after)) throw new DispatchUncertain();
  }

  return {
    observe,
    act,
    /**
     * The destination approved for one observed control, or `undefined` when
     * nothing has been observed or the index was never part of it. Read from
     * the observation, not from the live page: the question is what the caller
     * was shown and agreed to, which a page must not be able to answer.
     */
    destinationOf(element: SnapshotElement): ElementDestination | undefined {
      return current?.destinations[element.index];
    },
    /** Release held references; the next action must observe again. */
    async release() {
      await discard();
    },
  };
}

export type BoundTargets = ReturnType<typeof createBoundTargets>;
