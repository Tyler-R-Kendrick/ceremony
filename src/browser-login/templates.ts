import { z } from "zod";

export const controlSchema = z.strictObject({
  ref: z.string().uuid(),
  kind: z.enum(["identifier", "password", "submit", "unknown"]),
  label: z.string().max(120),
  form: z.string().uuid(),
  recipient: z.string().url().max(2000),
});
export const observationSchema = z.strictObject({
  document: z.string().uuid(),
  origin: z.string().url(),
  controls: z.array(controlSchema).max(40),
  challenge: z.boolean(),
});
export type Observation = z.infer<typeof observationSchema>;
export type Control = z.infer<typeof controlSchema>;
export type Mapping = {
  identifier?: string | undefined;
  password?: string | undefined;
  submit: string;
};
export type Step = {
  document: string;
  origin: string;
  recipient: string;
  mapping: Mapping;
};

/** AI proposes bindings, not actions, origins, values, or new transitions. */
export function validateMapping(
  page: Observation,
  mapping: Mapping,
): Step | undefined {
  if (page.challenge) return;
  const fields = [mapping.identifier, mapping.password].filter(
    (value): value is string => !!value,
  );
  if (
    !fields.length ||
    new Set([...fields, mapping.submit]).size !== fields.length + 1
  )
    return;
  const submit = page.controls.find(
    (control) => control.ref === mapping.submit && control.kind === "submit",
  );
  if (!submit) return;
  const recipient = new URL(submit.recipient);
  if (
    recipient.origin !== page.origin ||
    recipient.username ||
    recipient.password ||
    recipient.hash
  )
    return;
  for (const [role, ref] of Object.entries(mapping)) {
    const control = page.controls.find((candidate) => candidate.ref === ref);
    if (
      !control ||
      control.form !== submit.form ||
      control.recipient !== submit.recipient
    )
      return;
    if (role === "password" && control.kind !== "password") return;
    if (
      role === "identifier" &&
      !["identifier", "unknown"].includes(control.kind)
    )
      return;
  }
  return {
    document: page.document,
    origin: page.origin,
    recipient: submit.recipient,
    mapping,
  };
}

/** One form, one submit, at most one control per credential role. Never guess ties. */
export function matchTemplate(page: Observation): Step | undefined {
  const candidates: Step[] = [];
  for (const submit of page.controls.filter(
    (control) => control.kind === "submit",
  )) {
    const group = page.controls.filter(
      (control) => control.form === submit.form,
    );
    const identifiers = group.filter(
      (control) => control.kind === "identifier",
    );
    const passwords = group.filter((control) => control.kind === "password");
    if (
      identifiers.length > 1 ||
      passwords.length > 1 ||
      group.some((control) => control.kind === "unknown")
    )
      continue;
    const step = validateMapping(page, {
      ...(identifiers[0] ? { identifier: identifiers[0].ref } : {}),
      ...(passwords[0] ? { password: passwords[0].ref } : {}),
      submit: submit.ref,
    });
    if (step) candidates.push(step);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

export const mappingSchema = z.strictObject({
  identifier: z.string().uuid().optional(),
  password: z.string().uuid().optional(),
  submit: z.string().uuid(),
});

export function admittedOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
  )
    throw new Error("Use HTTPS (or the loopback fixture)");
  return url.origin;
}
