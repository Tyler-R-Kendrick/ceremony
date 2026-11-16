/**
 * What must hold in the browser, whatever is clicked, typed or resized.
 *
 * Bombadil explores the harness on its own: it answers the ceremony's
 * interfaces, plays the environment (expires the token, removes the
 * installation, deletes the app, starts new runs), enlarges the text and
 * resizes the window. These properties are checked in every state it reaches.
 * The model checker proves the flow and the layout prover proves the
 * geometry; this checks that the pixels and the page obey what was proved.
 */
import { always, eventually, next, now } from "@antithesishq/bombadil";
import { actions, extract } from "@antithesishq/bombadil/browser";
import model from "./model.json" with { type: "json" };

export * from "@antithesishq/bombadil/browser/defaults";

const page = extract((state) => {
  const body = state.document.body;
  const stage = state.document.querySelector("#stage");
  const origin = stage?.getBoundingClientRect() ?? { x: 0, y: 0 };
  const step = state.document.querySelector("ceremony-step");
  const html = state.document.documentElement.outerHTML;
  return {
    phase: body.dataset.phase ?? "",
    operator: body.dataset.operator ?? "",
    ending: body.dataset.ending ?? "",
    request: step?.getAttribute("data-request") ?? "",
    answered: step?.hasAttribute("data-answered") ?? false,
    windowWidth: state.window.innerWidth,
    pageWidth: state.document.documentElement.scrollWidth,
    leaked: ["PRIVATE-KEY-", "ghs_SECRET_", "manifest-code-"].some((marker) =>
      html.includes(marker),
    ),
    boxes: Array.from(state.document.querySelectorAll("[data-box]")).map(
      (element) => {
        const el = element as HTMLElement;
        const rect = el.getBoundingClientRect();
        const proved = (el.dataset.model ?? "").split(",").map(Number);
        const drawn = [
          rect.x - origin.x,
          rect.y - origin.y,
          rect.width,
          rect.height,
        ];
        return {
          name: el.dataset.box ?? "",
          off: Math.max(
            ...drawn.map((value, i) => Math.abs(value - (proved[i] ?? NaN))),
          ),
          spills:
            el.scrollHeight > el.clientHeight + 1 ||
            el.scrollWidth > el.clientWidth + 1,
        };
      },
    ),
    targets: Array.from(state.document.querySelectorAll("button, input")).map(
      (element) => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      },
    ),
  };
});

/** Every box sits where the layout program, whose rules are proved, put it. */
export const drawnWhereProved = always(() =>
  page.current.boxes.every((box) => box.off <= 1),
);

/** The layout's one assumption, the width of a character, holds for the real font. */
export const textIsNeverCutOff = always(() =>
  page.current.boxes.every((box) => !box.spills),
);

export const everyTargetCanBeHit = always(() =>
  page.current.targets.every(
    (target) => target.width >= 43.5 && target.height >= 43.5,
  ),
);

export const nothingSpillsSideways = always(
  () => page.current.pageWidth <= page.current.windowWidth,
);

export const noSecretReachesThePage = always(() => !page.current.leaked);

/** The page only ever shows an interface the flow derives, or an ending it declares. */
export const onlyDerivedInterfacesAndDeclaredEndings = always(
  () =>
    (page.current.operator === "" ||
      model.interfaces.includes(page.current.operator)) &&
    (page.current.ending === "" || model.endings.includes(page.current.ending)),
);

/** A step takes one answer: once answered, that request never opens again. */
export const anAnswerIsFinal = always(
  now(() => {
    const { request, answered } = page.current;
    return next(
      () =>
        !answered || page.current.request !== request || page.current.answered,
    );
  }),
);

/** Work in flight settles: the page never stays busy. */
export const workSettles = always(
  now(() => page.current.phase === "working").implies(
    eventually(() => page.current.phase !== "working").within(5, "seconds"),
  ),
);

/** Every phone and desktop width the layout was proved for. */
export const resize = actions(() => [
  { SetViewport: { width: [320, 1280], height: [640, 900] } },
]);
