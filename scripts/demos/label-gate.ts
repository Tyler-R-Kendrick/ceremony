import type { RecordedTraceEntry } from "../../src/core/recorded-ceremony.js";

/**
 * A recording is only worth keeping if every value went where a person
 * watching it would expect: an address into the field labelled as one, a
 * password into a password box. The driver's own rules make a mismatch safe;
 * they do not make it watchable. So before a video is kept, every applied
 * fill is checked against the control's own description as the sanitized
 * snapshot recorded it — label, placeholder, name, type — and a mismatch
 * fails the recording rather than publishing a confusing one.
 *
 * Reads descriptors only; the entry carries a role and never a value.
 */
export type FillMismatch = { role: string; control: string };

const expectations: Record<string, (text: string, type: string) => boolean> = {
  email: (text, type) => type === "email" || /e-?mail|address/.test(text),
  "alternate-email": (text, type) =>
    type === "email" || /e-?mail|address/.test(text),
  username: (text) => /user|handle|login|account|identifier|e-?mail/.test(text),
  password: (_text, type) => type === "password",
  "password-confirm": (_text, type) => type === "password",
  "display-name": (text) => /name/.test(text) && !/user ?name/.test(text),
  "birth-date": (text, type) => type === "date" || /birth|dob/.test(text),
  "verification-code": (text) =>
    /code|verif|confirm|one-time|otp|digit/.test(text),
  "totp-code": (text) =>
    /code|authenticat|one-time|otp|two-factor|2fa|digit/.test(text),
  "user-code": (text) => /code|device|pair/.test(text),
};

export function fillMismatches(
  entries: readonly RecordedTraceEntry[],
): FillMismatch[] {
  const found: FillMismatch[] = [];
  for (const entry of entries) {
    if (entry.action !== "fill" || !entry.role || entry.element === undefined)
      continue;
    const element = entry.snapshot.elements[entry.element];
    const text = [element?.label, element?.placeholder, element?.name]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const type = element?.type ?? "";
    const expected = expectations[entry.role];
    if (!element || !expected || !expected(text, type))
      found.push({
        role: entry.role,
        control: `${element?.kind ?? "missing"} type=${type || "-"} "${text.slice(0, 60)}"`,
      });
  }
  return found;
}
