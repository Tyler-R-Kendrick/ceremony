import type { Markup } from "./markup.js";

/**
 * Realistic page layouts for the auth provider double.
 *
 * The randomized shape in `markup.ts` exists to stress a driver: it moves the
 * password above the username, drops visible labels, and shuffles a
 * registration form, because a driver that only works on tidy pages is fitting
 * pages rather than reading them. That is the right default for robustness and
 * the wrong thing to show anyone. No provider ships those pages, and a
 * recording made on them looks broken even when the driver did everything
 * right.
 *
 * These layouts model what real sign-in pages have in common instead: a
 * visible `<label for>` on every input, a real `name`, `type` and
 * `autocomplete`, the identifier before the password, name / email / password /
 * confirm / terms on registration, one primary action per step, and an inline
 * error banner. Each is a *pattern* many providers share, not any one
 * provider's page: the product names are invented, and no logo, colour or copy
 * is taken from a real service.
 *
 * Only markup and CSS change. Sessions, codes, PKCE, redirects and origins are
 * the server's, exactly as under the randomized layout — with one deliberate
 * exception: `identifier-first` is a two-step page by definition, so it turns
 * on the provider's existing identifier-first behaviour.
 *
 * Decorative elements add no controls a snapshot would pick up. The wordmark
 * is not a link, marketing copy is not a heading, and every link's own text
 * says where it goes, because a snapshot carries a link's caption and not the
 * sentence around it.
 */

export const realisticLayouts = [
  /** Centred card: wordmark, identifier + password, "Forgot password?". */
  "classic-card",
  /** Two steps: identifier + "Next", then an identity chip + password. */
  "identifier-first",
  /** Marketing panel on the left, the form on the right. */
  "split-panel",
] as const;
export type RealisticLayout = (typeof realisticLayouts)[number];
/** `randomized` is the robustness default; the rest look like real pages. */
export type AuthLayout = "randomized" | RealisticLayout;

type Brand = {
  product: string;
  initial: string;
  accent: string;
  accentHover: string;
  ring: string;
};

/** Invented products, one per layout, so a screenshot says which it is. */
const brands: Record<RealisticLayout, Brand> = {
  "classic-card": {
    product: "Northwind Cloud",
    initial: "N",
    accent: "#2563eb",
    accentHover: "#1d4ed8",
    ring: "rgba(37, 99, 235, 0.28)",
  },
  "identifier-first": {
    product: "Acme Accounts",
    initial: "A",
    accent: "#0f766e",
    accentHover: "#115e59",
    ring: "rgba(15, 118, 110, 0.28)",
  },
  "split-panel": {
    product: "Globex Workspace",
    initial: "G",
    accent: "#6d28d9",
    accentHover: "#5b21b6",
    ring: "rgba(109, 40, 217, 0.28)",
  },
};

/** Realistic `name` attributes: what a password manager expects to find. */
const names = {
  identifier: "username",
  email: "email",
  password: "password",
  confirm: "password_confirmation",
  displayName: "name",
  birthDate: "birthday",
  terms: "terms",
  code: "code",
  userCode: "user_code",
} as const;

/** The autocomplete token a field of each realistic name carries. */
const autocompleteFor: Record<string, string> = {
  username: "username",
  email: "email",
  password: "current-password",
  password_confirmation: "new-password",
  name: "name",
  birthday: "bday",
  code: "one-time-code",
  user_code: "off",
};

const css = (brand: Brand) => `
:root{--accent:${brand.accent};--accent-hover:${brand.accentHover};--ring:${brand.ring};--text:#101828;--muted:#5d6b82;--border:#d0d5dd;--bg:#f4f6fa;--card:#fff;--danger:#b42318;--danger-bg:#fef3f2;--danger-border:#fecdca}
*{box-sizing:border-box}
html,body{margin:0}
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:15px;line-height:1.5;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none;font-weight:500}
a:hover{text-decoration:underline}
a:focus-visible,button:focus-visible{outline:none;box-shadow:0 0 0 3px var(--ring);border-radius:6px}
h1{font-size:24px;line-height:1.25;font-weight:650;margin:0 0 6px;letter-spacing:-0.01em}
p{margin:0}
.subtitle{color:var(--muted);margin-bottom:24px}
.wordmark{display:flex;align-items:center;gap:10px;font-weight:650;font-size:18px;letter-spacing:-0.01em;color:var(--text)}
.logo{width:32px;height:32px;border-radius:8px;background:var(--accent);color:#fff;display:inline-grid;place-items:center;font-weight:700;font-size:16px}
.field{margin-bottom:16px}
.field label,.label-row label{display:block;font-weight:550;font-size:14px;margin-bottom:6px}
.label-row{display:flex;justify-content:space-between;align-items:baseline}
.label-row a{font-size:13px}
input[type=text],input[type=email],input[type=password],input[type=date]{display:block;width:100%;height:42px;padding:0 12px;font:inherit;color:var(--text);background:#fff;border:1px solid var(--border);border-radius:8px;transition:border-color .15s,box-shadow .15s}
input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--ring)}
input.code{font-size:22px;letter-spacing:.4em;text-align:center;font-variant-numeric:tabular-nums;height:52px}
.hint{font-size:13px;color:var(--muted);margin-top:6px}
.check{display:flex;gap:10px;align-items:flex-start;margin:4px 0 20px;font-size:14px}
.check input{width:16px;height:16px;margin-top:3px;accent-color:var(--accent)}
.btn{display:inline-flex;justify-content:center;align-items:center;height:42px;padding:0 18px;font:inherit;font-weight:600;border-radius:8px;border:1px solid transparent;cursor:pointer}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{background:var(--accent-hover)}
.btn-secondary{background:#fff;color:var(--text);border-color:var(--border)}
.btn-secondary:hover{background:#f9fafb}
.btn-block{width:100%}
.btn-link{background:none;border:0;padding:0;height:auto;color:var(--accent);font:inherit;font-weight:500;cursor:pointer}
.btn-link:hover{text-decoration:underline}
.divider{display:flex;align-items:center;gap:12px;color:var(--muted);font-size:13px;margin:24px 0 16px}
.divider::before,.divider::after{content:"";flex:1;height:1px;background:#e4e7ec}
.switch{text-align:center;color:var(--muted);font-size:14px}
.banner{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;margin-bottom:20px;border-radius:8px;font-size:14px}
.banner-error{background:var(--danger-bg);border:1px solid var(--danger-border);color:var(--danger)}
.banner svg{flex:none;margin-top:2px}
.banner a{color:inherit;text-decoration:underline;margin-left:4px}
.actions{display:flex;gap:12px;justify-content:space-between;align-items:center;margin-top:8px}
.legal{margin-top:24px;text-align:center;font-size:13px;color:var(--muted)}
.legal a{color:var(--muted);font-weight:400;margin:0 8px}
.legal span+span{margin-left:8px}
.chip{display:inline-flex;align-items:center;gap:8px;padding:4px 12px 4px 4px;border:1px solid var(--border);border-radius:999px;font-size:14px;margin:4px 0 20px;max-width:100%}
.avatar{width:26px;height:26px;border-radius:50%;background:var(--accent);color:#fff;display:inline-grid;place-items:center;font-size:13px;font-weight:600}
.chip span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.apps{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:20px}
.app-icon{width:48px;height:48px;border-radius:12px;display:grid;place-items:center;font-weight:700;font-size:20px;background:#e4e7ec;color:#344054}
.app-icon.product{background:var(--accent);color:#fff}
.dots{color:var(--muted);letter-spacing:3px}
.scopes{list-style:none;padding:0;margin:12px 0 20px;border:1px solid #e4e7ec;border-radius:10px}
.scopes li{display:flex;gap:10px;align-items:center;padding:12px 14px}
.scopes li+li{border-top:1px solid #e4e7ec}
.scopes svg{flex:none;color:#067647}
.callout{padding:12px 14px;border-radius:8px;background:#f2f4f7;font-size:14px;margin-bottom:20px}
.fine{font-size:13px;color:var(--muted);margin-top:16px}
.consent .actions{flex-direction:row-reverse}
.consent .actions .btn{flex:1}
h2{font-size:16px;font-weight:650;margin:24px 0 8px}
h3{font-size:14px;font-weight:650;margin:0 0 2px}
.crumbs{font-size:13px;color:var(--muted);margin-bottom:16px}
.crumbs a{font-weight:500}
input[type=url],textarea{display:block;width:100%;padding:10px 12px;font:inherit;color:var(--text);background:#fff;border:1px solid var(--border);border-radius:8px}
input[type=url]{height:42px;padding:0 12px}
select{display:block;width:100%;height:42px;padding:0 36px 0 12px;font:inherit;color:var(--text);background:#fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5l3 3 3-3' fill='none' stroke='%235d6b82' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 12px center;border:1px solid var(--border);border-radius:8px;appearance:none;-webkit-appearance:none}
select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--ring)}
input.user-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:22px;letter-spacing:.3em;text-align:center;text-transform:uppercase;height:52px}
.device-icon{width:56px;height:56px;border-radius:14px;display:grid;place-items:center;margin:0 auto 16px;background:#f2f4f7;color:var(--accent)}
.center{text-align:center}
textarea{resize:vertical}
.copy-row{display:flex;gap:8px}
.copy-row input{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;background:#f9fafb}
.banner-success{background:#ecfdf3;border:1px solid #abefc6;color:#067647}
.app-list{list-style:none;padding:0;margin:0 0 20px;border:1px solid #e4e7ec;border-radius:10px}
.app-list li{padding:12px 14px}
.app-list li+li{border-top:1px solid #e4e7ec}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;word-break:break-all}
`;

const layoutCss: Record<RealisticLayout, string> = {
  "classic-card": `
.shell{min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:56px 16px}
.shell>.wordmark{margin-bottom:28px}
.card{width:100%;max-width:400px;background:var(--card);border:1px solid #e4e7ec;border-radius:12px;box-shadow:0 1px 2px rgba(16,24,40,.05),0 8px 24px rgba(16,24,40,.06);padding:32px}
@media (max-width:480px){.card{padding:24px;border-radius:10px}}
`,
  "identifier-first": `
body{background:#fff}
.shell{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 16px}
.card{width:100%;max-width:448px;border:1px solid #dadce0;border-radius:16px;padding:40px 40px 32px}
.card>.wordmark{margin-bottom:24px}
.card h1{font-weight:500;font-size:24px}
.actions{margin-top:32px}
.legal{width:100%;max-width:448px;display:flex;justify-content:space-between;margin-top:16px}
.legal a{margin:0 0 0 16px}
@media (max-width:480px){.card{border:0;padding:24px 8px}}
`,
  "split-panel": `
.split{min-height:100vh;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
.panel{background:linear-gradient(160deg,var(--accent) 0%,#1e1b4b 100%);color:#fff;padding:48px;display:flex;flex-direction:column;justify-content:space-between}
.panel .wordmark{color:#fff}
.panel .logo{background:#fff;color:var(--accent)}
.pitch{max-width:420px}
.pitch-title{font-size:30px;line-height:1.2;font-weight:650;margin-bottom:16px;letter-spacing:-0.02em}
.pitch-body{opacity:.85;margin-bottom:24px}
.pitch ul{list-style:none;padding:0;margin:0}
.pitch li{display:flex;gap:10px;align-items:center;margin-bottom:10px;opacity:.95}
.quote{border-top:1px solid rgba(255,255,255,.25);padding-top:20px;font-size:14px;opacity:.85;max-width:420px}
.form-side{display:flex;align-items:center;justify-content:center;padding:48px 24px;background:#fff}
.form-wrap{width:100%;max-width:380px}
@media (max-width:800px){.split{grid-template-columns:1fr;grid-template-rows:auto 1fr}.panel{padding:16px}.pitch,.quote{display:none}.form-side{align-items:flex-start;padding:32px 16px}}
`,
};

const escape = (value: string) =>
  value.replace(
    /[&<>"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[
        character
      ] as string,
  );

const errorIcon = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.5v4.2M8 11h.01" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const deviceIcon = `<svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" focusable="false"><rect x="3" y="5" width="22" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 23h8M14 19v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
const checkIcon = `<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false"><circle cx="9" cy="9" r="8" fill="currentColor" opacity=".12"/><path d="M5.5 9.2l2.2 2.2 4.8-4.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** "owner@example.com" as "o***@example.com": enough to recognise, no more. */
export function maskAddress(address: string): string {
  const at = address.indexOf("@");
  if (at <= 0) return "your email address";
  return `${address.slice(0, 1)}***${address.slice(at)}`;
}

/** What each requested scope lets the application do, in a person's words. */
const scopeDescriptions: Record<string, string> = {
  openid: "Confirm your identity",
  profile: "View your name and basic profile",
  email: "View your email address",
  offline_access: "Stay connected when you are not using it",
};

/** "ceremony-test-client" as "Ceremony Test Client". */
function displayName(clientId: string): string {
  return clientId
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export type RealisticPages = ReturnType<typeof createRealisticPages>;

function createRealisticPages(layout: RealisticLayout, brand: Brand) {
  const product = escape(brand.product);
  const hrefWithNext = (path: string, next: string) =>
    `${path}?next=${encodeURIComponent(next)}`;

  const banner = (message?: string, link?: { href: string; text: string }) =>
    message
      ? `<div class="banner banner-error" role="alert">${errorIcon}<div>${escape(message)}${
          link ? `<a href="${link.href}">${escape(link.text)}</a>` : ""
        }</div></div>`
      : "";

  const input = (options: {
    id: string;
    label: string;
    name: string;
    type: string;
    autocomplete: string;
    required?: boolean;
    extra?: string;
    hint?: string;
    aside?: string;
  }) => {
    const hintId = options.hint ? `${options.id}-hint` : "";
    const label = `<label for="${options.id}">${escape(options.label)}</label>`;
    return `<div class="field">${
      options.aside
        ? `<div class="label-row">${label}${options.aside}</div>`
        : label
    }<input id="${options.id}" name="${options.name}" type="${options.type}" autocomplete="${options.autocomplete}"${
      options.required === false ? "" : " required"
    }${hintId ? ` aria-describedby="${hintId}"` : ""}${options.extra ? ` ${options.extra}` : ""}>${
      options.hint
        ? `<p class="hint" id="${hintId}">${escape(options.hint)}</p>`
        : ""
    }</div>`;
  };

  const identifierLabel =
    layout === "split-panel" ? "Username or email" : "Email or username";
  /** Each layout's sign-up link names the destination in its own words. */
  const signUpLink: Record<RealisticLayout, { lead: string; text: string }> = {
    "classic-card": {
      lead: `New to ${product}?`,
      text: "Create an account",
    },
    "identifier-first": { lead: "", text: "Create account" },
    "split-panel": { lead: "Don&#39;t have an account?", text: "Sign up" },
  };

  return {
    signIn(options: {
      action: string;
      next: string;
      signupPath: string;
      error?: string;
      /** Ask for the identifier alone; the password comes on its own page. */
      identifierOnly: boolean;
      conditionalPasskey: boolean;
      /** The button sits outside any form, so pressing it does nothing. */
      inert: boolean;
    }) {
      const identifier = input({
        id: "sign-in-identifier",
        label: identifierLabel,
        name: names.identifier,
        type: "text",
        autocomplete: options.conditionalPasskey
          ? "username webauthn"
          : "username",
        extra: 'autocapitalize="none" spellcheck="false" autofocus',
      });
      const password = options.identifierOnly
        ? ""
        : input({
            id: "sign-in-password",
            label: "Password",
            name: names.password,
            type: "password",
            autocomplete: "current-password",
            aside: `<a href="/signin/forgot">Forgot password?</a>`,
          });
      const caption = options.identifierOnly ? "Next" : "Sign in";
      const link = signUpLink[layout];
      const signUp = `<a href="${hrefWithNext(options.signupPath, options.next)}">${link.text}</a>`;
      const button = options.inert
        ? `<button type="button" class="btn btn-primary btn-block">${caption}</button>`
        : `<button type="submit" class="btn btn-primary btn-block">${caption}</button>`;
      const fields = `${identifier}${password}`;
      const form = options.inert
        ? `${fields}${button}`
        : `<form method="post" action="${options.action}">${fields}${button}</form>`;
      if (layout === "identifier-first") {
        const actions = options.inert
          ? `${fields}<div class="actions">${signUp}${button.replace(" btn-block", "")}</div>`
          : `<form method="post" action="${options.action}">${fields}<div class="actions">${signUp}${button.replace(" btn-block", "")}</div></form>`;
        return page(
          "Sign in",
          `<h1>Sign in</h1><p class="subtitle">to continue to ${product}</p>${banner(options.error)}${actions}`,
        );
      }
      return page(
        "Sign in",
        `<h1>Sign in to ${product}</h1><p class="subtitle">Welcome back. Enter your details to continue.</p>${banner(options.error)}${form}<div class="divider">or</div><p class="switch">${link.lead} ${signUp}</p>`,
      );
    },

    password(options: { next: string; identifier: string; error?: string }) {
      return page(
        "Sign in",
        `<h1>Enter your password</h1>
         <div class="chip"><span class="avatar" aria-hidden="true">${escape(options.identifier.charAt(0).toUpperCase())}</span><span>${escape(options.identifier)}</span></div>
         ${banner(options.error)}
         <form method="post" action="${hrefWithNext("/signin/password", options.next)}">
           <input type="hidden" name="${names.identifier}" autocomplete="username" value="${escape(options.identifier)}">
           ${input({
             id: "sign-in-password",
             label: "Password",
             name: names.password,
             type: "password",
             autocomplete: "current-password",
             extra: "autofocus",
           })}
           <div class="actions"><a href="${hrefWithNext("/signin", options.next)}">Use a different account</a><button type="submit" class="btn btn-primary">Sign in</button></div>
         </form>`,
      );
    },

    signUp(options: {
      action: string;
      next: string;
      error?: string;
      /** The address is already registered: offer the way back to sign-in. */
      inUse?: boolean;
      /**
       * Ask for a country or region from these, in a required select whose
       * first option is an empty prompt - the picker many sign-up forms put
       * after the address, for tax, data residency or a default workspace.
       */
      regions?: readonly { code: string; name: string }[];
    }) {
      const signIn = hrefWithNext("/signin", options.next);
      const region = options.regions
        ? `<div class="field"><label for="sign-up-country">Country or region</label><select id="sign-up-country" name="country" autocomplete="country" required aria-describedby="sign-up-country-hint"><option value="">Select a country</option>${options.regions
            .map(
              (entry) =>
                `<option value="${escape(entry.code)}">${escape(entry.name)}</option>`,
            )
            .join(
              "",
            )}</select><p class="hint" id="sign-up-country-hint">Where your account&#39;s data is stored.</p></div>`
        : "";
      return page(
        "Create your account",
        `<h1>Create your ${product} account</h1>
         <p class="subtitle">Start with a free account. No card required.</p>
         ${banner(options.error, options.inUse ? { href: signIn, text: "Sign in instead" } : undefined)}
         <form method="post" action="${options.action}">
           ${input({ id: "sign-up-name", label: "Full name", name: names.displayName, type: "text", autocomplete: "name" })}
           ${input({ id: "sign-up-email", label: "Work email", name: names.email, type: "email", autocomplete: "email", extra: 'autocapitalize="none" spellcheck="false"' })}
           ${region}
           ${input({ id: "sign-up-password", label: "Password", name: names.password, type: "password", autocomplete: "new-password", extra: 'minlength="8"', hint: "Use 8 or more characters with a mix of letters, numbers and symbols." })}
           ${input({ id: "sign-up-confirm", label: "Confirm password", name: names.confirm, type: "password", autocomplete: "new-password", extra: 'minlength="8"' })}
           <div class="check"><input id="sign-up-terms" name="${names.terms}" type="checkbox" value="yes" required><label for="sign-up-terms">I agree to the <a href="/legal/terms">Terms of Service</a> and <a href="/legal/privacy">Privacy Policy</a></label></div>
           <button type="submit" class="btn btn-primary btn-block">Create account</button>
         </form>
         <p class="switch" style="margin-top:20px">Already have an account? <a href="${signIn}">Sign in</a></p>`,
      );
    },

    verifyEmail(options: {
      action: string;
      resendAction: string;
      address: string;
      /** A link-confirmed account has no code to type. */
      mode: "code" | "link";
      error?: string;
    }) {
      const masked = escape(maskAddress(options.address));
      const resend = `<form method="post" action="${options.resendAction}" class="switch" style="margin-top:20px">Didn&#39;t get it? <button type="submit" class="btn-link">Resend ${options.mode === "code" ? "code" : "email"}</button></form>`;
      if (options.mode === "link")
        return page(
          "Check your email",
          `<h1>Check your email</h1>
           <p class="subtitle">We sent a verification link to <strong>${masked}</strong>. Open it to finish creating your account.</p>
           ${banner(options.error)}${resend}`,
        );
      return page(
        "Check your email",
        `<h1>Check your email</h1>
         <p class="subtitle">We sent a 6-digit code to <strong>${masked}</strong>. Enter it below to verify your email address.</p>
         ${banner(options.error)}
         <form method="post" action="${options.action}">
           ${input({ id: "verify-code", label: "Verification code", name: names.code, type: "text", autocomplete: "one-time-code", extra: 'class="code" inputmode="numeric" pattern="[0-9]*" maxlength="6"' })}
           <button type="submit" class="btn btn-primary btn-block">Verify</button>
         </form>${resend}`,
      );
    },

    twoFactor(options: { action: string; error?: string }) {
      return page(
        "Two-factor authentication",
        `<h1>Two-factor authentication</h1>
         <p class="subtitle">Enter the 6-digit code from your authenticator app.</p>
         ${banner(options.error)}
         <form method="post" action="${options.action}">
           ${input({ id: "totp-code", label: "Authentication code", name: names.code, type: "text", autocomplete: "one-time-code", extra: 'class="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" autofocus' })}
           <button type="submit" class="btn btn-primary btn-block">Verify</button>
         </form>
         <p class="fine">Open the authenticator app on your phone to view your code.</p>`,
      );
    },

    consent(options: {
      requestId: string;
      clientId: string;
      scope: string;
      account: string;
      /** The agent a delegated grant names, or "". */
      actor: string;
      /**
       * The name the app was registered under, when the provider keeps a
       * registry. What a person is shown, rather than an identifier.
       */
      application?: string;
    }) {
      const app = escape(
        options.application ||
          displayName(options.clientId) ||
          options.clientId,
      );
      const scopes = options.scope.split(/\s+/).filter(Boolean);
      const items = (scopes.length ? scopes : ["openid"])
        .map(
          (scope) =>
            `<li>${checkIcon}<span>${escape(scopeDescriptions[scope] ?? `Access ${scope}`)}</span></li>`,
        )
        .join("");
      const delegation = options.actor
        ? `<p class="callout">${escape(options.actor)} will act on your behalf.</p>`
        : "";
      return page(
        "Authorize application",
        `<div class="consent">
           <div class="apps" aria-hidden="true"><span class="app-icon">${app.charAt(0)}</span><span class="dots">&middot;&middot;&middot;</span><span class="app-icon product">${escape(brand.initial)}</span></div>
           <h1>${app} wants to access your ${product} account</h1>
           <p class="subtitle">Signed in as <strong>${escape(options.account)}</strong></p>
           <p>This will allow ${app} to:</p>
           <ul class="scopes">${items}</ul>
           ${delegation}
           <form method="post" action="/consent">
             <input type="hidden" name="r" value="${escape(options.requestId)}">
             <div class="actions"><button type="submit" name="decision" value="allow" class="btn btn-primary">Allow</button><button type="submit" name="decision" value="deny" class="btn btn-secondary">Cancel</button></div>
           </form>
           <p class="fine">Make sure you trust ${app}. You can remove its access at any time in your account settings.</p>
         </div>`,
      );
    },

    /**
     * An RFC 8628 verification page: the person is signed in here, and types
     * the short code their TV, console or command-line tool is showing. The
     * code is never on this page - it is on the device - and the query of a
     * `verification_uri_complete` link is not read back into the field.
     */
    device(options: { action: string; account: string; error?: string }) {
      return page(
        "Connect a device",
        `<div class="device-icon" aria-hidden="true">${deviceIcon}</div>
         <h1 class="center">Connect a device</h1>
         <p class="subtitle center">Enter the code displayed on your device to let it use your ${product} account.</p>
         ${banner(options.error)}
         <form method="post" action="${options.action}">
           ${input({
             id: "device-user-code",
             label: "Device code",
             name: names.userCode,
             type: "text",
             autocomplete: "off",
             extra:
               'class="user-code" autocapitalize="characters" spellcheck="false" maxlength="9" autofocus',
             hint: "The code is on your device's screen. It expires after a few minutes.",
           })}
           <div class="actions"><a href="/">Cancel</a><button type="submit" class="btn btn-primary">Continue</button></div>
         </form>
         <p class="fine">Signed in as <strong>${escape(options.account)}</strong>. Only enter a code from a device you are setting up yourself.</p>`,
      );
    },

    deviceConnected() {
      return page(
        "Device connected",
        `<div class="device-icon" aria-hidden="true">${checkIcon}</div>
         <h1 class="center">You are signed in</h1>
         <p class="subtitle center">Your device is connected. You can close this window and return to it.</p>`,
      );
    },

    unavailable(options: { retryHref: string }) {
      return page(
        "Service unavailable",
        `<h1>Something went wrong</h1>
         ${banner("Sign-in is temporarily unavailable. Try again in a moment.")}
         <p class="switch"><a href="${options.retryHref}">Back to sign in</a></p>`,
      );
    },
  };

  function page(title: string, body: string): string {
    return wrapDocument(brand, layout, title, body);
  }
}

/** The document every page of a layout is wrapped in. */
function wrapDocument(
  brand: Brand,
  layout: RealisticLayout,
  title: string,
  body: string,
): string {
  const product = escape(brand.product);
  const wordmark = `<div class="wordmark" aria-hidden="true"><span class="logo">${escape(brand.initial)}</span><span>${product}</span></div>`;
  const legal = `<footer class="legal"><span>&copy; ${product}</span><span><a href="/legal/privacy">Privacy</a><a href="/legal/terms">Terms</a></span></footer>`;
  const shells: Record<RealisticLayout, string> = {
    "classic-card": `<div class="shell">${wordmark}<main class="card">${body}</main>${legal}</div>`,
    "identifier-first": `<div class="shell"><main class="card">${wordmark}${body}</main>${legal}</div>`,
    "split-panel": `<div class="split"><aside class="panel" aria-hidden="true">${wordmark}<div class="pitch"><p class="pitch-title">Plan, write and ship together.</p><p class="pitch-body">One workspace for your team&#39;s docs, projects and decisions.</p><ul><li>${checkIcon}<span>Shared docs with live editing</span></li><li>${checkIcon}<span>Projects that track themselves</span></li><li>${checkIcon}<span>Single sign-on for every teammate</span></li></ul></div><p class="quote">&ldquo;We moved our whole team over in an afternoon.&rdquo;<br>&mdash; An example customer</p></aside><main class="form-side"><div class="form-wrap">${body}${legal}</div></main></div>`,
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · ${product}</title><style>${css(brand)}${layoutCss[layout]}</style></head><body>${shells[layout]}</body></html>`;
}

/**
 * A `Markup` for a realistic layout. Pages the server builds from parts (the
 * device code, token and application pages) get realistic fields and the
 * layout's shell from here; the sign-in, registration, verification,
 * two-factor and consent pages are rendered whole by `pages`.
 */
export function createRealisticMarkup(
  layout: RealisticLayout,
  seed: number,
): Markup {
  const brand = brands[layout];
  const field = (
    label: string,
    name: string,
    type: string,
    attributes = "",
  ): string => {
    const id = `field_${name}`;
    // A field no password manager should offer anything for (an application
    // or token name) says so, as real pages do.
    const autocomplete = /\bautocomplete=/.test(attributes)
      ? ""
      : ` autocomplete="${autocompleteFor[name] ?? "off"}"`;
    return `<div class="field"><label for="${id}">${escape(label)}</label><input id="${id}" name="${name}" type="${type}"${autocomplete} ${attributes}></div>`;
  };
  return {
    seed,
    layout,
    names,
    labels: {
      identifier: "Email or username",
      email: "Email",
      password: "Password",
      confirm: "Confirm password",
      displayName: "Full name",
      birthDate: "Date of birth",
      terms: "I agree to the Terms of Service and Privacy Policy",
      verification: "Verification code",
      totp: "Authentication code",
      userCode: "Device code",
    },
    captions: {
      signIn: "Sign in",
      signUp: "Create account",
      submitCode: "Verify",
      approve: "Allow",
      deny: "Cancel",
      resend: "Resend code",
      signUpLink: "Create an account",
    },
    messages: {
      emailInUse: "An account with this email already exists.",
      rejected: "Incorrect password. Try again or reset your password.",
      unverified: "Confirm your email address to finish signing in.",
      mismatch: "Passwords do not match.",
      termsRequired: "Please accept the Terms of Service to continue.",
      badCode: "That code is incorrect or has expired.",
      checkInbox: "Check your email",
    },
    signupPath: "/signup",
    includeDisplayName: true,
    includeBirthDate: false,
    emailInputType: "email",
    headings: {
      signIn: `Sign in to ${brand.product}`,
      signUp: `Create your ${brand.product} account`,
      consent: "Authorize application",
    },
    escape,
    field,
    checkbox: (label, name) =>
      `<div class="check"><input id="field_${name}" name="${name}" type="checkbox" value="yes"><label for="field_${name}">${escape(label)}</label></div>`,
    alert: (message) =>
      message
        ? `<div class="banner banner-error" role="alert">${errorIcon}<div>${escape(message)}</div></div>`
        : "",
    page: (title, body) => wrapDocument(brand, layout, title, body),
    // Real pages keep one order: identifier before password, and name, email,
    // password, confirmation, terms on registration.
    arrange: (_key, items) => [...items],
    pages: createRealisticPages(layout, brand),
  };
}
