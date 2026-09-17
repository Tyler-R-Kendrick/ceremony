import {
  mappingSchema,
  validateMapping,
  type Observation,
} from "../../src/browser-login/templates.js";

// An isolated-world closure owns element references; page attributes are not authority.
const installed = globalThis as typeof globalThis & {
  ceremonyAdapterInstalled?: boolean;
};
if (!installed.ceremonyAdapterInstalled) {
  installed.ceremonyAdapterInstalled = true;
  const documentRef = crypto.randomUUID();
  let elements = new Map<string, HTMLElement>();
  let observed: Observation | undefined;
  let revision = 0;
  let observedRevision = -1;
  const observer = new MutationObserver(() => {
    revision++;
  });
  observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  const visible = (element: HTMLElement) =>
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== "hidden";
  const label = (element: HTMLInputElement | HTMLButtonElement) =>
    (
      element.getAttribute("aria-label") ||
      ("labels" in element
        ? Array.from(element.labels ?? [])
            .map((item) => item.textContent)
            .join(" ")
        : "") ||
      (element instanceof HTMLButtonElement
        ? element.textContent
        : element.getAttribute("placeholder")) ||
      ""
    )
      .replace(/\s+/g, " ")
      .slice(0, 120);
  function snapshot(): Observation {
    elements = new Map();
    const controls: Observation["controls"] = [];
    for (const form of Array.from(document.forms).slice(0, 10)) {
      const formRef = crypto.randomUUID();
      const recipient = form.action;
      for (const element of Array.from(form.elements)) {
        if (
          !(
            element instanceof HTMLInputElement ||
            element instanceof HTMLButtonElement
          ) ||
          !visible(element) ||
          element.disabled ||
          (element instanceof HTMLInputElement && element.readOnly)
        )
          continue;
        const type = element.type.toLowerCase();
        if (!["text", "email", "password", "submit"].includes(type)) continue;
        const ref = crypto.randomUUID();
        const caption = label(element);
        const kind =
          type === "password"
            ? "password"
            : type === "submit"
              ? "submit"
              : element.getAttribute("autocomplete") === "username" ||
                  type === "email" ||
                  /user|email|login|identifier/i.test(caption)
                ? "identifier"
                : "unknown";
        const destination =
          type === "submit" && element.hasAttribute("formaction")
            ? element.formAction
            : recipient;
        controls.push({
          ref,
          form: formRef,
          kind,
          label: caption,
          recipient: destination,
        });
        elements.set(ref, element);
      }
    }
    observedRevision = revision;
    return (observed = {
      document: documentRef,
      origin: location.origin,
      controls: controls.slice(0, 40),
      challenge: !!document.querySelector(
        'iframe[src*="captcha"], [data-sitekey], input[autocomplete="one-time-code"]',
      ),
    });
  }
  chrome.runtime.onMessage.addListener((raw, sender, reply) => {
    if (sender.id !== chrome.runtime.id || sender.tab) return;
    const message = raw as {
      type?: string;
      step?: { document?: string; mapping?: unknown };
      username?: string;
      password?: string;
    };
    if (message.type === "observe") {
      reply(snapshot());
      return;
    }
    if (message.type !== "apply") return;
    try {
      if (observer.takeRecords().length) revision++;
      if (
        !observed ||
        observedRevision !== revision ||
        message.step?.document !== documentRef ||
        location.origin !== observed.origin
      )
        throw new Error("stale");
      const mapping = mappingSchema.parse(message.step.mapping);
      const step = validateMapping(observed, mapping);
      if (!step) throw new Error("mapping");
      const submit = elements.get(mapping.submit);
      if (
        !(
          submit instanceof HTMLButtonElement ||
          submit instanceof HTMLInputElement
        ) ||
        !submit.form
      )
        throw new Error("submit");
      const form = submit.form;
      const isApprovedSubmission = () =>
        submit.form === form &&
        (submit.hasAttribute("formaction")
          ? submit.formAction
          : form.action) === step.recipient &&
        (submit.hasAttribute("formmethod")
          ? submit.formMethod
          : form.method
        ).toLowerCase() === "post" &&
        ["", "_self"].includes(
          submit.hasAttribute("formtarget") ? submit.formTarget : form.target,
        );
      if (!isApprovedSubmission()) throw new Error("recipient");
      for (const [role, ref] of Object.entries(mapping)) {
        if (role === "submit" || !ref) continue;
        const element = elements.get(ref);
        const value = role === "password" ? message.password : message.username;
        if (
          !(element instanceof HTMLInputElement) ||
          element.form !== form ||
          !element.isConnected ||
          !visible(element) ||
          element.disabled ||
          element.readOnly ||
          typeof value !== "string" ||
          !value ||
          value.length > 4096
        )
          throw new Error("field");
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!.call(element, value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (
        !submit.isConnected ||
        !visible(submit) ||
        submit.disabled ||
        !isApprovedSubmission()
      )
        throw new Error("changed");
      observed = undefined;
      form.requestSubmit(submit);
      reply({ status: "submitted-unverified" });
    } catch {
      observed = undefined;
      reply({ status: "refused" });
    }
  });
}
