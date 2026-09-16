import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PresentationStudio } from "../../examples/web/presentation-studio.js";
import { newAuthoredMethod } from "../../src/core/connector-authoring.js";
import {
  manifestSchema,
  type CeremonyTemplate,
} from "../../src/core/schema.js";

const manifest = manifestSchema.parse({
  id: "acme",
  name: "Acme",
  description: "Isolated presentation fixture",
  methods: (["oauth-code", "basic", "api-key"] as const).map((kind) => {
    const method = newAuthoredMethod(kind, kind);
    method.contract!.completion.verifier = "fixture.verify";
    return method;
  }),
});

function Fixture({ generationAvailable }: { generationAvailable: boolean }) {
  const [templates, setTemplates] = useState<CeremonyTemplate[]>([]);
  return (
    <>
      <PresentationStudio
        manifest={manifest}
        generationAvailable={generationAvailable}
        templates={templates}
        apply={(template) =>
          setTemplates((current) => [
            ...current.filter((item) => item.id !== template.id),
            template,
          ])
        }
      />
      <output hidden id="saved-presentation">
        {JSON.stringify(templates)}
      </output>
    </>
  );
}

/** Existing editor in an explicit component harness, not a Studio entry point. */
export function mountPresentationHarness(generationAvailable = false) {
  const host = document.createElement("section");
  host.id = "presentation-harness";
  host.className = "presentation-tools";
  const content = document.createElement("div");
  const unmount = document.createElement("button");
  unmount.textContent = "Close presentation fixture";
  host.append(content, unmount);
  document.body.append(host);
  const root = createRoot(content);
  unmount.onclick = () => {
    root.unmount();
    host.remove();
  };
  root.render(<Fixture generationAvailable={generationAvailable} />);
}
