import { App } from "@modelcontextprotocol/ext-apps";
import { z } from "zod";
import { fieldSchema } from "../core/schema.js";

/** Bundle into a trusted MCP App resource. Raw values travel only over direct HTTPS, never MCP. */
export async function mountPrivateCollector(
  root: HTMLElement,
  brokerOrigin: string,
) {
  const trustedOrigin = new URL(brokerOrigin).origin;
  if (!trustedOrigin.startsWith("https://"))
    throw new Error("Private collection requires HTTPS");
  const app = new App(
    { name: "Ceremony private collector", version: "0.1.0" },
    {},
  );
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = "Waiting for a private collection request…";
  root.replaceChildren(status);
  app.ontoolresult = (result) => {
    const checked = z
      .object({
        handle: z.uuid(),
        endpoint: z.url(),
        instanceId: z.uuid(),
        revision: z.number(),
        fields: z.array(fieldSchema),
      })
      .safeParse(result._meta?.collection);
    if (!checked.success) return;
    const collection = checked.data;
    if (
      collection.endpoint !== `${trustedOrigin}/ceremony/private-collection`
    ) {
      status.textContent =
        "Untrusted collection destination. Continue in your ceremony webpage.";
      return;
    }
    const form = document.createElement("form");
    const heading = document.createElement("h2");
    heading.textContent = "Private credential entry";
    const description = document.createElement("p");
    description.textContent =
      "Values go directly to the credential broker. The assistant receives only a reference. Do not enter credentials in chat.";
    const inputs = collection.fields.map((field) => {
      const label = document.createElement("label");
      label.textContent = field.label;
      const input = document.createElement("input");
      input.name = field.name;
      input.type = field.type;
      input.required = field.required;
      input.maxLength = 4096;
      input.autocomplete = "off";
      label.append(input);
      form.append(label);
      return input;
    });
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Submit privately";
    form.append(submit);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      try {
        const values = Object.fromEntries(
          inputs.map((input) => [input.name, input.value]),
        );
        const request = fetch(collection.endpoint, {
          method: "POST",
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          headers: {
            "content-type": "application/json",
            "x-ceremony-collection": collection.handle,
          },
          body: JSON.stringify(values),
          signal: AbortSignal.timeout(15_000),
        });
        for (const input of inputs) input.value = "";
        const response = await request;
        if (!response.ok) throw new Error("Collection failed");
        const { secretRef } = z
          .object({ secretRef: z.uuid() })
          .parse(await response.json());
        const result = await app.callServerTool({
          name: "ceremony_bind_private",
          arguments: {
            instanceId: collection.instanceId,
            revision: collection.revision,
            secretRef,
          },
        });
        status.textContent = result.isError
          ? "Verification failed. Ask for a new private collection."
          : "Private input submitted. You can return to the ceremony.";
        form.remove();
      } catch {
        status.textContent =
          "Private collection failed. Request a new collector or continue in your ceremony webpage.";
        form.remove();
      }
    });
    status.textContent = "";
    root.replaceChildren(heading, description, form, status);
    inputs[0]?.focus();
  };
  app.onteardown = async () => {
    root.replaceChildren();
    return {};
  };
  await app.connect();
  return () => {
    root.replaceChildren();
    void app.close();
  };
}
