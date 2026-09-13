import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * WCAG contrast, enforced on the palette that actually ships.
 *
 * The values are read out of src/react/styles.css rather than restated here,
 * so this cannot pass while the stylesheet says something else. Every theme
 * state is checked, because the failure mode of a themed component library is
 * a palette that was only ever looked at in one of them.
 *
 * Thresholds are WCAG 2.2 AA: 4.5:1 for body text, 3:1 for large text and for
 * the boundary of a control a person has to find and hit. A token pair that is
 * never composed is not listed — a threshold nobody renders proves nothing.
 */

const css = readFileSync(
  new URL("../src/react/styles.css", import.meta.url),
  "utf8",
);

/** Each theme state's block, by the selector that introduces it. */
const blocks: Record<string, RegExp> = {
  light:
    /:where\(\s*\[data-ceremony\],\s*\[data-ceremony-card\],[\s\S]*?\) \{([\s\S]*?)\n\}/,
  "dark (system)":
    /@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n  \}\n\}/,
  "dark (chosen)":
    /:where\(\s*\[data-theme="dark"\] \[data-ceremony\],[\s\S]*?\) \{([\s\S]*?)\n\}/,
};

function palette(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const match of source.matchAll(
    /--_ceremony-([a-z0-9-]+): var\(--ceremony-[a-z0-9-]+, (#[0-9a-fA-F]{6})\)/g,
  ))
    values[match[1]!] = match[2]!;
  return values;
}

function channel(value: number): number {
  const ratio = value / 255;
  return ratio <= 0.04045 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((offset) =>
    channel(Number.parseInt(hex.slice(offset, offset + 2), 16)),
  );
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [dark, light] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (light! + 0.05) / (dark! + 0.05);
}

/** Every pair the stylesheet actually composes, and what each one has to clear. */
const pairs: [string, string, number, string][] = [
  ["fg", "bg", 4.5, "body text on a panel"],
  ["fg", "ground", 4.5, "body text on an inset surface"],
  ["muted", "bg", 4.5, "supporting text on a panel"],
  ["muted", "ground", 4.5, "supporting text on an inset surface"],
  ["on-accent", "accent", 4.5, "the label of the primary action"],
  ["accent", "bg", 3, "the primary action against the panel"],
  ["accent", "accent-wash", 4.5, "accent text on its own wash"],
  ["ok", "bg", 4.5, "a verified state on a panel"],
  ["ok", "ok-wash", 4.5, "a verified state on its own wash"],
  ["human", "bg", 4.5, "a needs-a-person state on a panel"],
  ["human", "human-wash", 4.5, "a needs-a-person state on its own wash"],
  ["stop", "bg", 4.5, "a refused state on a panel"],
  ["stop", "stop-wash", 4.5, "a refused state on its own wash"],
  ["border-strong", "bg", 3, "the edge of a control someone has to hit"],
  ["border-strong", "ground", 3, "that edge where the control sits inset"],
  ["focus", "bg", 3, "the focus ring against the panel"],
];

for (const [theme, pattern] of Object.entries(blocks))
  test(`${theme}: every composed colour pair clears its WCAG threshold`, () => {
    const match = css.match(pattern);
    assert.ok(match, `the ${theme} token block should be found in styles.css`);
    const colours = palette(match[1]!);
    // A block that parsed to nothing would pass every assertion below.
    assert.ok(
      Object.keys(colours).length >= 13,
      `the ${theme} block should declare the full palette, found ${Object.keys(colours).length}`,
    );
    const failures: string[] = [];
    for (const [front, back, threshold, what] of pairs) {
      // focus is the one token declared as `var(--ceremony-focus, accent)`
      // rather than a hex, so it alone falls back. Every other missing token is
      // a hole in the palette, and substituting the accent would hide it.
      const a =
        front === "focus" ? (colours.focus ?? colours.accent) : colours[front];
      const b = colours[back];
      assert.ok(a && b, `${theme}: ${front}/${back} should both be declared`);
      const ratio = contrast(a, b);
      if (ratio < threshold)
        failures.push(
          `${what}: ${front} ${a} on ${back} ${b} is ${ratio.toFixed(2)}:1, needs ${threshold}:1`,
        );
    }
    assert.deepEqual(failures, []);
  });

test("the contrast maths agrees with the WCAG reference values", () => {
  // Black on white is the defined maximum; a colour against itself is 1:1.
  assert.equal(contrast("#000000", "#ffffff").toFixed(2), "21.00");
  assert.equal(contrast("#ffffff", "#ffffff").toFixed(2), "1.00");
  // WCAG's own worked example: #777777 on white is just under 4.5:1.
  assert.equal(contrast("#777777", "#ffffff").toFixed(2), "4.48");
  // Order must not matter.
  assert.equal(
    contrast("#0e1621", "#ffffff").toFixed(3),
    contrast("#ffffff", "#0e1621").toFixed(3),
  );
});
