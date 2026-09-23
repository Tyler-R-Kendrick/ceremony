import type { Markup } from "./markup.js";

/**
 * The provider double's developer settings: where a person registers an OAuth
 * app and generates its client secret.
 *
 * The shape is the one most identity providers and code hosts share rather
 * than any one of them: "Developer settings → OAuth apps → New OAuth app",
 * a form asking for an application name, a homepage URL and an authorization
 * callback URL, then the app's page with its client ID and a "Generate a new
 * client secret" button that shows the secret exactly once.
 *
 * Two details are load-bearing for the driver, and both are what real pages
 * do anyway. The client ID and the revealed secret sit in *read-only* inputs
 * with a visible `<label for>`, which is what lets a plan name the field it
 * keeps and lets the driver read it without it ever entering a snapshot —
 * a snapshot carries whether a field is filled, never what it holds. And the
 * secret is printed nowhere else: not in a heading, not in the status banner,
 * not in the page title. A page that did would fail the attempt as a leak,
 * which is the point of having a leak check.
 *
 * Labels are fixed, not drawn from the randomized pools: the plan names these
 * fields by label, the way a recorded procedure names a control, and the
 * page's shell still comes from whichever layout the double runs.
 */

export type OAuthAppView = {
  /** The app's own settings path segment; never the client ID. */
  id: string;
  clientId: string;
  name: string;
  homepageUrl: string;
  callbackUrl: string;
  secrets: number;
};

export type NewOAuthAppValues = {
  name: string;
  homepageUrl: string;
  description: string;
  callbackUrl: string;
};

export const oauthAppsPath = "/settings/developers/oauth-apps";

export function developerSettingsPages(markup: Markup) {
  const { escape } = markup;
  const crumbs = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/settings/developers">Developer settings</a><span aria-hidden="true"> / </span><a href="${oauthAppsPath}">OAuth apps</a></nav>`;
  const field = (options: {
    id: string;
    label: string;
    name: string;
    type: string;
    value: string;
    hint?: string;
    required?: boolean;
    autocomplete?: string;
  }) => {
    const hint = options.hint
      ? `<p class="hint" id="${options.id}-hint">${escape(options.hint)}</p>`
      : "";
    const described = options.hint
      ? ` aria-describedby="${options.id}-hint"`
      : "";
    const control =
      options.type === "textarea"
        ? `<textarea id="${options.id}" name="${options.name}" rows="3"${described}>${escape(options.value)}</textarea>`
        : `<input id="${options.id}" name="${options.name}" type="${options.type}" value="${escape(options.value)}" autocomplete="${options.autocomplete ?? "off"}" spellcheck="false"${
            options.required === false ? "" : " required"
          }${described}>`;
    return `<div class="field"><label for="${options.id}">${escape(options.label)}</label>${control}${hint}</div>`;
  };
  /** A value the page shows and a person copies: read-only, labelled, once. */
  const shown = (id: string, label: string, value: string) =>
    `<div class="field"><label for="${id}">${escape(label)}</label><div class="copy-row"><input id="${id}" type="text" value="${escape(value)}" readonly autocomplete="off" spellcheck="false"><button type="button" class="btn btn-secondary">Copy</button></div></div>`;

  return {
    list(apps: readonly OAuthAppView[]) {
      const rows = apps.length
        ? `<ul class="app-list">${apps
            .map(
              (app) =>
                `<li><a href="${oauthAppsPath}/${app.id}">${escape(app.name)}</a></li>`,
            )
            .join("")}</ul>`
        : `<p class="hint">No OAuth apps yet.</p>`;
      return markup.page(
        "OAuth apps",
        `${crumbs}<h1>OAuth apps</h1>
         <p class="subtitle">Apps that let people sign in with their account here.</p>
         ${rows}
         <p><a class="btn btn-primary" href="${oauthAppsPath}/new">New OAuth app</a></p>`,
      );
    },

    newApp(values: NewOAuthAppValues, error?: string) {
      return markup.page(
        "Register a new OAuth app",
        `${crumbs}<h1>Register a new OAuth app</h1>
         <p class="subtitle">People will be asked to allow this app to use their account.</p>
         ${markup.alert(error)}
         <form method="post" action="${oauthAppsPath}/new">
           ${field({ id: "oauth-app-name", label: "Application name", name: "application_name", type: "text", value: values.name, hint: "Something people will recognise and trust." })}
           ${field({ id: "oauth-app-homepage", label: "Homepage URL", name: "homepage_url", type: "url", value: values.homepageUrl, autocomplete: "url", hint: "The full URL to your application's homepage." })}
           ${field({ id: "oauth-app-description", label: "Application description", name: "description", type: "textarea", value: values.description, required: false, hint: "Optional. Shown to people when they are asked to allow the app." })}
           ${field({ id: "oauth-app-callback", label: "Authorization callback URL", name: "callback_url", type: "url", value: values.callbackUrl, hint: "Where people are sent back after they allow the app. It must match exactly." })}
           <div class="actions"><a href="${oauthAppsPath}">Cancel</a><button type="submit" class="btn btn-primary">Register application</button></div>
         </form>`,
      );
    },

    app(app: OAuthAppView, revealed?: string) {
      const secrets = revealed
        ? `<div class="banner banner-success" role="status"><div><h3>New client secret created</h3><p>Copy your new client secret now. You won&#39;t be able to see it again.</p></div></div>
           ${shown("oauth-app-client-secret", "Client secret", revealed)}`
        : app.secrets === 0
          ? `<p class="hint">You need a client secret to authenticate as the application to the API.</p>`
          : `<p class="hint">${app.secrets} client secret${app.secrets === 1 ? "" : "s"}. A secret is shown once, when it is created.</p>`;
      return markup.page(
        app.name,
        `${crumbs}<h1>${escape(app.name)}</h1>
         <p class="subtitle">Homepage: ${escape(app.homepageUrl)}</p>
         ${shown("oauth-app-client-id", "Client ID", app.clientId)}
         <h2>Client secrets</h2>
         ${secrets}
         <form method="post" action="${oauthAppsPath}/${app.id}/secrets">
           <button type="submit" class="btn btn-secondary">Generate a new client secret</button>
         </form>
         <h2>Authorization callback URL</h2>
         <p class="hint"><code>${escape(app.callbackUrl)}</code></p>`,
      );
    },
  };
}
