/**
 * The layout of one ceremony interface, and the rules it must keep.
 *
 * A human step's interface (title, body, fields, actions) is laid out by one
 * straight-line program in the container's width and the reader's font scale.
 * The copy is the interface's own, so its lengths are constants of the
 * program. The rules below are quantities that must never go negative; they
 * are proved for every width and every scale in the stated range, not sampled.
 */
import type { InterfaceSpec } from "../ceremony.js";
import { exact } from "./algebras.js";
import { prove, type Domain, type Proof } from "./prove.js";
import { run, Tape, type Ref } from "./tape.js";

export interface BoxRefs {
  readonly x: Ref;
  readonly y: Ref;
  readonly width: Ref;
  readonly height: Ref;
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Rule {
  readonly name: string;
  /** What breaks for a person when the quantity goes negative. */
  readonly harm: string;
  readonly quantity: Ref;
}

export interface SheetLayout {
  readonly tape: Tape;
  readonly boxes: Readonly<Record<string, BoxRefs>>;
  readonly height: Ref;
  readonly rules: readonly Rule[];
  readonly domain: Domain;
}

export interface SheetOptions {
  /** Let an action's label wrap inside its button. Off shows why it must. */
  readonly wrapActions?: boolean;
  readonly domain?: Domain;
}

/** Narrowest phone to a wide desktop column; default text size to doubled. */
export const SHEET_DOMAIN: Domain = { width: [320, 1280], scale: [1, 2] };

const GUTTER = 16;
const TARGET = 44;
/** Space the layout leaves between neighbours. */
const GAP = 8;
/** Space the rules insist on: less than the layout leaves, so rounding cannot break a rule. */
const CLEARANCE = 4;
/** Distance from either edge the rules insist on; the layout leaves `GUTTER`. */
const EDGE = GUTTER - CLEARANCE;
/** Every rule holds to within this much of a pixel. */
export const TOLERANCE = 1 / 64;
/**
 * Advance of one character as a share of the font size. The renderer uses a
 * fixed-width font; this is a little more than such fonts take, so the model
 * never fits more on a line than the browser does. It is the layout's one
 * assumption about the font, and the browser properties check it.
 */
export const CHARACTER = 0.62;
/** Room a line must have to spare before the model trusts the text to fit on it. */
const SPARE = 0.5;

/**
 * Lines a browser needs for `words` when `capacity` whole characters fit on a
 * line. It breaks at spaces and, as browsers do, after a hyphen or a slash
 * inside a word; a piece longer than a line is broken wherever the line ends.
 */
export function wrappedLines(words: string, capacity: number): number {
  let lines = 1;
  let used = 0;
  for (const word of words.split(/\s+/).filter((part) => part.length > 0)) {
    const pieces = word.match(/[^-/]*[-/]+|[^-/]+/g) ?? [word];
    pieces.forEach((piece, index) => {
      // A space goes before a word, never before a later piece of one.
      const gap = index === 0 && used > 0 ? 1 : 0;
      let rest = piece.length;
      if (used > 0 && used + gap + rest > capacity) {
        lines += 1;
        used = 0;
      } else {
        used += gap;
      }
      while (used + rest > capacity) {
        rest -= capacity - used;
        lines += 1;
        used = 0;
      }
      used += rest;
    });
  }
  return lines;
}

/**
 * For each line count, the fewest characters per line at which `words` fits
 * in that many lines. The line count is then a sum of steps over the room.
 */
export function wrapThresholds(words: string, most: number): number[] {
  const thresholds: number[] = [];
  const longest = Math.max(1, words.length);
  for (let count = 1; count < most; count += 1) {
    let capacity = 1;
    while (capacity < longest && wrappedLines(words, capacity) > count) {
      capacity += 1;
    }
    thresholds.push(capacity);
  }
  return thresholds;
}
const BODY_FONT = 16;
const TITLE_FONT = 20;
const LINE = 1.5;
const BUTTON_PADDING = 32;

export function sheetLayout(
  spec: InterfaceSpec,
  options: SheetOptions = {},
): SheetLayout {
  const wrapActions = options.wrapActions ?? true;
  const domain = options.domain ?? SHEET_DOMAIN;
  const [narrowest] = domain.width as readonly [number, number];
  const [, largest] = domain.scale as readonly [number, number];
  const t = new Tape();
  const width = t.input("width");
  const scale = t.input("scale");
  const rules: Rule[] = [];
  const boxes: Record<string, BoxRefs> = {};

  const pad = t.affine(t.step(t.affine(width, 1, -480)), 8, GUTTER);
  const content = t.sum([
    [1, width],
    [-2, pad],
  ]);
  const smallestContent = narrowest - 2 * GUTTER;

  /**
   * Lines `words` needs in `room`, wrapping at spaces as a browser does. The
   * copy is fixed, so for each line count there is a least room in which it
   * fits, and the count is one step per such threshold.
   */
  const lines = (
    words: string,
    font: number,
    room: Ref,
    least: number,
  ): Ref => {
    const advance = CHARACTER * font;
    const fewest = Math.max(
      1,
      Math.floor((least - SPARE) / (advance * largest)),
    );
    const most = wrappedLines(words, fewest);
    const steps = wrapThresholds(words, most).map(
      (capacity) =>
        [
          1,
          t.step(
            t.sum(
              [
                [capacity * advance, scale],
                [-1, room],
              ],
              SPARE,
            ),
          ),
        ] as const,
    );
    return t.sum(steps, 1);
  };

  const text = (
    name: string,
    words: string,
    font: number,
    top: Ref,
  ): BoxRefs => {
    const box: BoxRefs = {
      x: pad,
      y: top,
      width: content,
      height: t.mul(
        lines(words, font, content, smallestContent),
        t.affine(scale, LINE * font),
      ),
    };
    boxes[name] = box;
    return box;
  };

  const bottom = (box: BoxRefs): Ref => t.add(box.y, box.height);
  const below = (upper: BoxRefs, gap: number): Ref =>
    t.affine(bottom(upper), 1, gap);
  const order: [string, BoxRefs][] = [];

  const title = text("title", spec.title, TITLE_FONT, pad);
  order.push(["title", title]);
  let last = title;
  if (spec.body.length > 0) {
    last = text("body", spec.body, BODY_FONT, below(last, GAP));
    order.push(["body", last]);
  }

  const control = t.max(t.constant(TARGET), t.affine(scale, 2.75 * BODY_FONT));
  for (const field of spec.fields ?? []) {
    // The label wraps like any other text; the control sits under it.
    const label = t.mul(
      lines(field.label, BODY_FONT, content, smallestContent),
      t.affine(scale, LINE * BODY_FONT),
    );
    const box: BoxRefs = {
      x: pad,
      y: below(last, 2 * GAP),
      width: content,
      height: t.sum(
        [
          [1, label],
          [1, control],
        ],
        GAP / 2,
      ),
    };
    boxes[`field:${field.name}`] = box;
    order.push([`field:${field.name}`, box]);
    rules.push({
      name: `field ${field.name} is tall enough to hit`,
      harm: "the field is too small to tap",
      quantity: t.affine(control, 1, -TARGET),
    });
    last = box;
  }

  // Two characters more than the label, so one line is never a tight fit.
  const natural = spec.actions.map((action) =>
    t.max(
      t.affine(
        scale,
        (action.label.length + 2) * CHARACTER * BODY_FONT,
        BUTTON_PADDING,
      ),
      t.constant(TARGET),
    ),
  );
  const needed = t.sum(
    natural.map((size) => [1, size] as const),
    GAP * (spec.actions.length - 1),
  );
  const inline = t.step(t.sub(content, needed));
  const top = below(last, 3 * GAP);

  /**
   * The actions laid out one way: side by side, or stacked. Both are computed
   * and blended by the breakpoint. Each rule is stated per arrangement and
   * blended once, so near the breakpoint it has to hold for both, and a bound
   * never mixes the position of one arrangement with the size of the other.
   */
  const arrange = (
    sideBySide: boolean,
  ): {
    readonly boxes: BoxRefs[];
    readonly counts: Ref[];
    readonly needs: Ref[];
  } => {
    const arranged: BoxRefs[] = [];
    /** Lines each button is given. */
    const counts: Ref[] = [];
    /** Lines each label needs. */
    const needs: Ref[] = [];
    let x = pad;
    let y = top;
    spec.actions.forEach((action, index) => {
      const actionWidth = sideBySide ? (natural[index] as Ref) : content;
      // Side by side a button is its label and two characters wide, so the
      // label needs one line; stacked, it wraps in the column's width.
      const need = lines(
        action.label,
        BODY_FONT,
        t.affine(actionWidth, 1, -BUTTON_PADDING),
        sideBySide
          ? (action.label.length + 2) * CHARACTER * BODY_FONT * largest
          : smallestContent - BUTTON_PADDING,
      );
      const count = wrapActions ? need : t.constant(1);
      needs.push(need);
      const height = t.max(
        t.constant(TARGET),
        t.add(
          t.mul(count, t.affine(scale, LINE * BODY_FONT)),
          t.constant(GAP * 2.5),
        ),
      );
      arranged.push({ x, y, width: actionWidth, height });
      counts.push(count);
      if (sideBySide)
        x = t.sum(
          [
            [1, x],
            [1, actionWidth],
          ],
          GAP,
        );
      else
        y = t.sum(
          [
            [1, y],
            [1, height],
          ],
          GAP,
        );
    });
    return { boxes: arranged, counts, needs };
  };
  const beside = arrange(true);
  const stacked = arrange(false);
  const either = (quantity: (arrangement: typeof beside) => Ref): Ref =>
    t.blend(inline, quantity(beside), quantity(stacked));

  const actionBoxes: BoxRefs[] = spec.actions.map((action, index) => {
    const pick = (side: keyof BoxRefs): Ref =>
      either((arrangement) => (arrangement.boxes[index] as BoxRefs)[side]);
    const box: BoxRefs = {
      x: pick("x"),
      y: pick("y"),
      width: pick("width"),
      height: pick("height"),
    };
    boxes[`action:${action.id}`] = box;
    const own = (arrangement: typeof beside): BoxRefs =>
      arrangement.boxes[index] as BoxRefs;
    rules.push(
      {
        name: `action ${action.id} is wide enough to hit`,
        harm: "the button is too narrow to tap",
        quantity: either((m) => t.affine(own(m).width, 1, -TARGET)),
      },
      {
        name: `action ${action.id} is tall enough to hit`,
        harm: "the button is too short to tap",
        quantity: either((m) => t.affine(own(m).height, 1, -TARGET)),
      },
      {
        name: `action ${action.id} holds its label`,
        harm: `the label "${action.label}" is cut off`,
        quantity: either((m) =>
          t.sub(m.counts[index] as Ref, m.needs[index] as Ref),
        ),
      },
      {
        name: `action ${action.id} keeps the left gutter`,
        harm: "the button touches or leaves the left edge",
        quantity: either((m) => t.affine(own(m).x, 1, -EDGE)),
      },
      {
        name: `action ${action.id} keeps the right gutter`,
        harm: "the button touches or leaves the right edge",
        quantity: either((m) =>
          t.sum(
            [
              [1, width],
              [-1, own(m).x],
              [-1, own(m).width],
            ],
            -EDGE,
          ),
        ),
      },
    );
    if (index > 0) {
      rules.push({
        name: `action ${action.id} clears action ${spec.actions[index - 1]?.id}`,
        harm: "two buttons overlap or touch",
        quantity: t.blend(
          inline,
          t.sum(
            [
              [1, own(beside).x],
              [-1, (beside.boxes[index - 1] as BoxRefs).x],
              [-1, (beside.boxes[index - 1] as BoxRefs).width],
            ],
            -CLEARANCE,
          ),
          t.sum(
            [
              [1, own(stacked).y],
              [-1, (stacked.boxes[index - 1] as BoxRefs).y],
              [-1, (stacked.boxes[index - 1] as BoxRefs).height],
            ],
            -CLEARANCE,
          ),
        ),
      });
    }
    return box;
  });

  for (const [name, box] of order) {
    rules.push(
      {
        name: `${name} keeps the left gutter`,
        harm: `${name} touches or leaves the left edge`,
        quantity: t.affine(box.x, 1, -EDGE),
      },
      {
        name: `${name} keeps the right gutter`,
        harm: `${name} touches or leaves the right edge`,
        quantity: t.sum(
          [
            [1, width],
            [-1, box.x],
            [-1, box.width],
          ],
          -EDGE,
        ),
      },
    );
  }
  for (let i = 1; i < order.length; i += 1) {
    const [upperName, upper] = order[i - 1] as [string, BoxRefs];
    const [lowerName, lower] = order[i] as [string, BoxRefs];
    rules.push({
      name: `${lowerName} starts below ${upperName}`,
      harm: `${lowerName} overlaps ${upperName}`,
      quantity: t.sum(
        [
          [1, lower.y],
          [-1, bottom(upper)],
        ],
        -CLEARANCE,
      ),
    });
  }
  const first = actionBoxes[0];
  if (first !== undefined) {
    rules.push({
      name: "actions start below the content",
      harm: "the first button overlaps the content",
      quantity: t.sum(
        [
          [1, first.y],
          [-1, bottom(last)],
        ],
        -CLEARANCE,
      ),
    });
  }
  let lowest = bottom(last);
  for (const box of actionBoxes) lowest = t.max(lowest, bottom(box));
  const height = t.add(lowest, pad);
  return {
    tape: t,
    boxes,
    height,
    rules: rules.map((rule) => ({
      ...rule,
      quantity: t.affine(rule.quantity, 1, TOLERANCE),
    })),
    domain,
  };
}

export interface Measured {
  readonly boxes: Readonly<Record<string, Box>>;
  readonly height: number;
}

/** Where everything goes at one width and scale: what the renderer draws. */
export function measure(
  layout: SheetLayout,
  at: { readonly width: number; readonly scale: number },
): Measured {
  const values = run(layout.tape, exact, at);
  const read = (ref: Ref): number => values[ref] as number;
  return {
    height: read(layout.height),
    boxes: Object.fromEntries(
      Object.entries(layout.boxes).map(([name, box]) => [
        name,
        {
          x: read(box.x),
          y: read(box.y),
          width: read(box.width),
          height: read(box.height),
        },
      ]),
    ),
  };
}

export type SheetProof =
  | {
      readonly status: "proved";
      readonly rules: number;
      readonly boxes: number;
    }
  | {
      readonly status: "refuted";
      readonly rule: Rule;
      readonly at: Readonly<Record<string, number>>;
      readonly value: number;
    }
  | {
      readonly status: "undecided";
      readonly rule: Rule;
      readonly within: Domain;
    };

/** Every rule, for every width and scale in the layout's range. */
export function proveSheet(layout: SheetLayout): SheetProof {
  const proof: Proof = prove(
    layout.tape,
    layout.rules.map((rule) => rule.quantity),
    layout.domain,
  );
  if (proof.status === "proved") {
    return { status: "proved", rules: layout.rules.length, boxes: proof.boxes };
  }
  const rule = layout.rules[proof.quantity] as Rule;
  return proof.status === "refuted"
    ? { status: "refuted", rule, at: proof.at, value: proof.value }
    : { status: "undecided", rule, within: proof.within };
}
