/**
 * Seeded page-shape randomization for the auth scenario doubles.
 *
 * Every instance of the provider double invents its own field names, label
 * wording, label association style, control order, button captions, alert
 * markup and signup path. A driver therefore cannot pass by recognising a fixed
 * page: it has to work from the semantics the snapshot actually carries. The
 * seed makes a failure reproducible, so a broken case can be replayed exactly.
 */

/** Stable 32-bit hash so a page's shape derives from its name, not call order. */
export function hashKey(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const pools = {
  identifier: ["Username", "Handle", "Login name", "Account name"],
  email: ["Email", "E-mail address", "Email address", "Your email"],
  password: ["Password", "Choose a password", "Passphrase", "Your password"],
  confirm: ["Confirm password", "Repeat password", "Password again"],
  displayName: ["Display name", "Your name", "Full name"],
  birthDate: ["Date of birth", "Birth date", "Your birthday"],
  terms: [
    "I agree to the Terms of Service",
    "I accept the terms and the privacy policy",
    "I confirm I am old enough to use this service",
  ],
  verification: ["Confirmation code", "Verification code", "6-digit code"],
  totp: ["Authenticator code", "One-time code", "Two-factor code"],
  userCode: ["Device code", "Pairing code", "Code shown on your device"],
  signIn: ["Sign in", "Log in", "Continue", "Next"],
  signUp: ["Create account", "Register", "Sign up", "Join"],
  submitCode: ["Confirm", "Verify", "Submit code", "Continue"],
  approve: ["Authorize", "Allow", "Approve", "Grant access"],
  deny: ["Deny", "Cancel", "Not now"],
  resend: ["Resend confirmation", "Send a new link", "Email me again"],
  signUpLink: ["Create an account", "Sign up", "Register here", "Join now"],
  signInHeading: ["Welcome back", "Sign in to continue", "Account access"],
  signUpHeading: ["Create your account", "Join us", "Registration"],
  consentHeading: ["Authorize this application", "Allow access?", "Consent"],
  alert: [
    'role="alert"',
    'class="alert-danger"',
    'class="invalid-feedback"',
    'class="form-error"',
    'class="error-message"',
  ],
  signupPath: ["/signup", "/register", "/join", "/account/create", "/auth/new"],
  emailInUse: [
    "That email address is already in use.",
    "An account with this address already exists.",
    "This email is taken. Try signing in instead.",
  ],
  rejected: [
    "We could not sign you in with those details.",
    "Incorrect username or password.",
    "Those credentials were not accepted.",
  ],
  unverified: [
    "Confirm your email address before signing in.",
    "This account is not verified yet.",
  ],
  mismatch: ["The passwords do not match.", "Both passwords must be the same."],
  termsRequired: [
    "You must accept the terms to continue.",
    "Please agree to the terms first.",
  ],
  badCode: ["That code is not correct.", "The code you entered did not match."],
  checkInbox: [
    "Check your inbox to confirm the account.",
    "We sent you a confirmation message.",
  ],
} as const;

export type Markup = ReturnType<typeof createMarkup>;

export function createMarkup(seed: number) {
  const random = seededRandom(seed);
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)]!;
  const token = () => Math.floor(random() * 0xffffff).toString(36);
  /**
   * Order a page's controls. The permutation comes from the instance seed and
   * the page's own name, so a given seed renders a given page identically every
   * time it is requested — a fixture whose shape drifted between renders could
   * not be replayed from its seed.
   */
  const arrange = <T>(key: string, items: readonly T[]): T[] => {
    const local = seededRandom(
      (seed ^ hashKey(key) ^ (items.length << 16)) >>> 0,
    );
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index--) {
      const swap = Math.floor(local() * (index + 1));
      [copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
    }
    return copy;
  };

  const names = {
    identifier: `u_${token()}`,
    email: `e_${token()}`,
    password: `p_${token()}`,
    confirm: `c_${token()}`,
    displayName: `n_${token()}`,
    birthDate: `b_${token()}`,
    terms: `t_${token()}`,
    code: `v_${token()}`,
    userCode: `d_${token()}`,
  } as const;

  const labels = {
    identifier: pick(pools.identifier),
    email: pick(pools.email),
    password: pick(pools.password),
    confirm: pick(pools.confirm),
    displayName: pick(pools.displayName),
    birthDate: pick(pools.birthDate),
    terms: pick(pools.terms),
    verification: pick(pools.verification),
    totp: pick(pools.totp),
    userCode: pick(pools.userCode),
  } as const;

  const captions = {
    signIn: pick(pools.signIn),
    signUp: pick(pools.signUp),
    submitCode: pick(pools.submitCode),
    approve: pick(pools.approve),
    deny: pick(pools.deny),
    resend: pick(pools.resend),
    signUpLink: pick(pools.signUpLink),
  } as const;

  const messages = {
    emailInUse: pick(pools.emailInUse),
    rejected: pick(pools.rejected),
    unverified: pick(pools.unverified),
    mismatch: pick(pools.mismatch),
    termsRequired: pick(pools.termsRequired),
    badCode: pick(pools.badCode),
    checkInbox: pick(pools.checkInbox),
  } as const;

  const alertAttribute = pick(pools.alert);
  const signupPath = pick(pools.signupPath);
  const includeDisplayName = random() > 0.4;
  const includeBirthDate = random() > 0.5;
  /** A provider that does not use type="email" forces label-based reasoning. */
  const emailInputType = random() > 0.5 ? "email" : "text";

  const escape = (value: string) =>
    value.replace(
      /[&<>"]/g,
      (character) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[
          character
        ] as string,
    );

  /** Render one control, varying how its accessible name is attached. */
  const field = (
    label: string,
    name: string,
    type: string,
    attributes = "",
  ): string => {
    const id = `field_${name}`;
    // Derived from the field's own name for the same reason `arrange` is.
    const style = Math.floor(seededRandom((seed ^ hashKey(name)) >>> 0)() * 4);
    const input = `<input id="${id}" name="${name}" type="${type}" ${attributes}>`;
    if (style === 0)
      return `<p><label for="${id}">${escape(label)}</label>${input}</p>`;
    if (style === 1)
      return `<p><input id="${id}" name="${name}" type="${type}" aria-label="${escape(label)}" ${attributes}></p>`;
    if (style === 2)
      return `<p><input id="${id}" name="${name}" type="${type}" placeholder="${escape(label)}" ${attributes}></p>`;
    return `<p><label>${escape(label)} ${input}</label></p>`;
  };

  const checkbox = (label: string, name: string): string =>
    `<p><label><input name="${name}" type="checkbox" value="yes"> ${escape(label)}</label></p>`;

  const alert = (message?: string): string =>
    message ? `<div ${alertAttribute}>${escape(message)}</div>` : "";

  const page = (title: string, body: string): string =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title></head><body>${body}</body></html>`;

  return {
    seed,
    names,
    labels,
    captions,
    messages,
    signupPath,
    includeDisplayName,
    includeBirthDate,
    emailInputType,
    headings: {
      signIn: pick(pools.signInHeading),
      signUp: pick(pools.signUpHeading),
      consent: pick(pools.consentHeading),
    },
    escape,
    field,
    checkbox,
    alert,
    page,
    arrange,
  };
}
