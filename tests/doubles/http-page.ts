import { parseHTML } from "linkedom";
import {
  snapshotDocument,
  snapshotSelectors,
  type PageSnapshot,
  type SnapshotElement,
} from "../../src/core/browser-contracts.js";
import type { CeremonyPage } from "../../src/server/browser-driver.js";

/**
 * A `CeremonyPage` backed by real HTTP requests and a real parsed document.
 *
 * Navigation, cookies, redirects and form serialization behave as a browser's
 * do; the page is built by the same `snapshotDocument` the Playwright adapter
 * ships into a live browser, so a snapshot here is the snapshot there. What it
 * does not do is run scripts — which is why the same scenarios are also run
 * through a real Chromium in the browser suite, and why neither result is
 * reported as covering the other.
 */

type Jar = Map<string, string>;

function storeCookies(jar: Jar, response: Response): void {
  const header = response.headers.getSetCookie?.() ?? [];
  for (const cookie of header) {
    const [pair] = cookie.split(";");
    const separator = pair?.indexOf("=") ?? -1;
    if (!pair || separator <= 0) continue;
    jar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

function cookieHeader(jar: Jar): string {
  return [...jar.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

/** Controls a browser would submit, matching HTML form serialization rules. */
function serialize(form: Element, submitter?: Element): URLSearchParams {
  const body = new URLSearchParams();
  for (const control of Array.from(
    form.querySelectorAll("input,select,textarea"),
  )) {
    const name = control.getAttribute("name");
    if (!name || control.hasAttribute("disabled")) continue;
    const type = (control.getAttribute("type") ?? "").toLowerCase();
    if (type === "checkbox" || type === "radio") {
      const checked =
        (control as { checked?: boolean }).checked === true ||
        control.hasAttribute("checked");
      if (checked) body.append(name, control.getAttribute("value") ?? "on");
      continue;
    }
    if (type === "submit" || type === "button") continue;
    body.append(
      name,
      (control as { value?: string }).value ??
        control.getAttribute("value") ??
        "",
    );
  }
  const submitterName = submitter?.getAttribute("name");
  if (submitterName)
    body.append(submitterName, submitter?.getAttribute("value") ?? "");
  return body;
}

export type HttpCeremonyPage = CeremonyPage & {
  goto(url: string): Promise<void>;
  /** Every address the page has been at, for navigation assertions. */
  history(): readonly string[];
};

export function createHttpCeremonyPage(
  options: { maxRedirects?: number } = {},
): HttpCeremonyPage {
  const maxRedirects = options.maxRedirects ?? 10;
  const jar: Jar = new Map();
  const visited: string[] = [];
  let currentUrl = "about:blank";
  let document: Document | undefined;
  let elements: Element[] = [];
  let lastResponse: { status: number; authenticate?: string } | undefined;
  /** Credentials a person entered into the browser's dialog, kept per origin. */
  const dialogCredentials = new Map<string, string>();

  const load = async (
    url: string,
    init: { method: "GET" | "POST"; body?: URLSearchParams },
  ): Promise<void> => {
    let target = url;
    let request = init;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const headers: Record<string, string> = {};
      const cookies = cookieHeader(jar);
      if (cookies) headers["cookie"] = cookies;
      const dialog = dialogCredentials.get(new URL(target).origin);
      if (dialog) headers["authorization"] = dialog;
      if (request.method === "POST")
        headers["content-type"] = "application/x-www-form-urlencoded";
      const response = await fetch(target, {
        method: request.method,
        redirect: "manual",
        headers,
        ...(request.body ? { body: request.body.toString() } : {}),
      });
      storeCookies(jar, response);
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        target = new URL(location, target).href;
        request = { method: "GET" };
        continue;
      }
      const html = await response.text();
      const authenticate = response.headers.get("www-authenticate");
      lastResponse = {
        status: response.status,
        ...(authenticate ? { authenticate } : {}),
      };
      currentUrl = target;
      visited.push(target);
      const parsed = parseHTML(html);
      document = parsed.document as unknown as Document;
      // A parsed document has no window location; the snapshot reads it here.
      document.documentElement.setAttribute("data-ceremony-href", currentUrl);
      return;
    }
    throw new Error("Too many redirects");
  };

  const resolve = (element: SnapshotElement): Element => {
    const found = elements[element.index];
    if (!found) throw new Error(`No element at index ${element.index}`);
    return found;
  };

  const submitFrom = async (control: Element): Promise<void> => {
    const form = control.closest("form");
    if (!form) return;
    const method = (form.getAttribute("method") ?? "GET").toUpperCase();
    const action = new URL(
      form.getAttribute("action") ?? currentUrl,
      currentUrl,
    );
    const body = serialize(form, control);
    if (method === "POST") return load(action.href, { method: "POST", body });
    action.search = body.toString();
    return load(action.href, { method: "GET" });
  };

  return {
    goto: (url) => load(url, { method: "GET" }),
    history: () => [...visited],
    url: async () => currentUrl,
    response: async () => lastResponse,
    authenticate: async (origin, credentials) => {
      dialogCredentials.set(
        new URL(origin).origin,
        `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`,
      );
    },
    snapshot: async (): Promise<PageSnapshot> => {
      if (!document) throw new Error("No page has been loaded");
      elements = [];
      return snapshotDocument(document, snapshotSelectors, (element, index) => {
        elements[index] = element;
      });
    },
    fill: async (element, value) => {
      const control = resolve(element);
      control.setAttribute("value", value);
      (control as { value?: string }).value = value;
    },
    check: async (element) => {
      const control = resolve(element);
      control.setAttribute("checked", "checked");
      (control as { checked?: boolean }).checked = true;
    },
    click: async (element) => {
      const control = resolve(element);
      const tag = control.tagName.toLowerCase();
      const href = control.getAttribute("href");
      if (tag === "a" && href)
        return load(new URL(href, currentUrl).href, { method: "GET" });
      return submitFrom(control);
    },
    settle: async () => {
      // Navigation already completed synchronously with the click.
    },
  };
}
