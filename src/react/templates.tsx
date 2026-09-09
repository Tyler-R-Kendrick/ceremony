"use client";
import {
  createContext,
  useContext,
  useState,
  useId,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  createLibrary,
  createParser,
  defineComponent,
  Renderer,
} from "@openuidev/react-lang";
import { z } from "zod";
import {
  requiredParts,
  steps,
  templateSchema,
  type ActionName,
  type CeremonySnapshot,
  type CeremonyTemplate,
} from "../core/index.js";

interface Bindings {
  snapshot: CeremonySnapshot;
  busy: boolean;
  act(action: ActionName, values?: Record<string, string>): void;
  navigate?: (() => void) | undefined;
  errorId?: string | undefined;
}
const Context = createContext<(Bindings & { idPrefix: string }) | null>(null);
function useBindings(): Bindings & { idPrefix: string } {
  const value = useContext(Context);
  if (!value) throw new Error("Ceremony bindings missing");
  return value;
}
const Title = defineComponent({
  name: "Title",
  description: "A short screen heading.",
  props: z.object({ text: z.string().min(1).max(100) }),
  component: ({ props }) => <h2>{props.text}</h2>,
});
const Text = defineComponent({
  name: "Text",
  description:
    "Optional supporting copy. Never assert permissions or authentication success here.",
  props: z.object({ text: z.string().max(400) }),
  component: ({ props }) => <p className="supporting">{props.text}</p>,
});
const Details = defineComponent({
  name: "Details",
  description:
    "Required trusted connector name, description and auth method. Runtime binding.",
  props: z.object({}),
  component: () => {
    const { snapshot } = useBindings();
    return (
      <div className="details">
        <strong>{snapshot.connectorName}</strong>
        <span>{snapshot.method.label}</span>
        <p>{snapshot.description}</p>
      </div>
    );
  },
});
const Access = defineComponent({
  name: "Access",
  description: "Required trusted permissions. Runtime binding.",
  props: z.object({}),
  component: () => {
    const { snapshot } = useBindings();
    return (
      <div className="access">
        <span className="eyebrow">Requested access</span>
        <ul>
          {snapshot.method.scopes.map((scope) => (
            <li key={scope}>{scope}</li>
          ))}
        </ul>
        {!snapshot.method.scopes.length && <p>No permissions declared.</p>}
      </div>
    );
  },
});
const Fields = defineComponent({
  name: "Fields",
  description:
    "Required complete credential or claim form. Field definitions and validation come from runtime.",
  props: z.object({}),
  component: () => {
    const { snapshot, busy, idPrefix, errorId } = useBindings();
    return (
      <fieldset
        disabled={busy}
        data-ceremony-part="fields"
        aria-describedby={errorId}
      >
        <legend className="sr-only">
          {snapshot.step === "claim" ? "Account claiming" : "Credentials"}
        </legend>
        {snapshot.fields.map((field) => (
          <label key={field.name} htmlFor={`${idPrefix}-${field.name}`}>
            {field.label}
            <input
              id={`${idPrefix}-${field.name}`}
              name={field.name}
              type={field.type}
              required={field.required}
              aria-describedby={errorId}
              maxLength={4096}
              autoComplete={
                field.type === "password"
                  ? "off"
                  : field.type === "email"
                    ? "email"
                    : "username"
              }
            />
          </label>
        ))}
      </fieldset>
    );
  },
});
const Redirect = defineComponent({
  name: "Redirect",
  description: "Required trusted provider redirect link. Runtime binding.",
  props: z.object({}),
  component: () => {
    const { snapshot, busy, navigate } = useBindings();
    return snapshot.authorizationUrl ? (
      <a
        className="button primary"
        href={snapshot.authorizationUrl}
        rel="noreferrer"
        aria-disabled={busy}
        onClick={(event) => {
          if (navigate || busy) event.preventDefault();
          if (!busy) navigate?.();
        }}
      >
        Continue to provider ↗
      </a>
    ) : null;
  },
});
const Device = defineComponent({
  name: "Device",
  description:
    "Required verification code, trusted approval link and deadline. Runtime binding.",
  props: z.object({}),
  component: () => {
    const { snapshot, busy, navigate } = useBindings();
    return (
      <div className="device">
        <span className="field-label">Your verification code</span>
        <output aria-label="Verification code">{snapshot.userCode}</output>
        <p>Enter this code at the provider to approve this connection.</p>
        <a
          className="button primary"
          href={snapshot.verificationUri}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={busy}
          onClick={(event) => {
            if (navigate || busy) event.preventDefault();
            if (!busy) navigate?.();
          }}
        >
          Open approval page ↗
        </a>
        <p className="muted">
          Approval expires at{" "}
          {new Date(snapshot.expiresAt).toLocaleTimeString()}.
        </p>
      </div>
    );
  },
});
const Notice = defineComponent({
  name: "Notice",
  description: "Required trusted error and progress messages. Runtime binding.",
  props: z.object({}),
  component: () => {
    const { snapshot } = useBindings();
    return (
      <div role="status" aria-live="polite">
        {snapshot.message && <p className="notice">{snapshot.message}</p>}
        {snapshot.step === "waiting" && (
          <p className="pending">
            <span />
            Waiting for your approval…
          </p>
        )}
      </div>
    );
  },
});
const Outcome = defineComponent({
  name: "Outcome",
  description:
    "Required verified connection status and actual granted access. Runtime binding.",
  props: z.object({}),
  component: () => {
    const { snapshot } = useBindings();
    const outcome = snapshot.outcome;
    return outcome ? (
      <div className="outcome">
        <span className="eyebrow">
          {outcome.ownership === "anonymous"
            ? "Anonymous access · unclaimed"
            : outcome.ownership === "claimed"
              ? "Ownership claimed"
              : "Connection verified"}
        </span>
        <p>
          {outcome.ownership === "anonymous"
            ? "You can use the available access now, or claim ownership."
            : outcome.ownership === "claimed"
              ? "Ownership is confirmed. See the provider details for available access."
              : "Your connection is ready to use."}
        </p>
        <ul>
          {outcome.scopes.map((scope) => (
            <li key={scope}>{scope}</li>
          ))}
        </ul>
      </div>
    ) : null;
  },
});
const labels: Record<ActionName, string> = {
  begin: "Connect",
  submit: "Continue",
  claim: "Claim ownership",
  finish: "Continue anonymously",
  retry: "Try again",
  cancel: "Cancel",
  "request-human": "Request human assistance",
};
const Actions = defineComponent({
  name: "Actions",
  description:
    "Required complete set of allowed actions; labels and dispatch are controlled by runtime.",
  props: z.object({}),
  component: () => {
    const { snapshot, busy, act } = useBindings();
    return (
      <div className="actions">
        {snapshot.actions.map((action) => (
          <button
            key={action}
            type={action === "submit" ? "submit" : "button"}
            className={action === "cancel" ? "quiet" : "primary"}
            disabled={busy}
            onClick={action === "submit" ? undefined : () => act(action)}
          >
            {busy && action !== "cancel"
              ? "Working…"
              : action === "begin" && snapshot.method.kind === "github-app"
                ? "Prepare integration"
                : labels[action]}
          </button>
        ))}
      </div>
    );
  },
});
const leaf = z.union([
  Title.ref,
  Text.ref,
  Details.ref,
  Access.ref,
  Fields.ref,
  Redirect.ref,
  Device.ref,
  Notice.ref,
  Outcome.ref,
  Actions.ref,
]);
const Panel = defineComponent({
  name: "Panel",
  description: "Group related ceremony content.",
  props: z.object({ children: z.array(leaf).max(16) }),
  component: ({ props, renderNode }) => (
    <section className="panel">{renderNode(props.children)}</section>
  ),
});
const Stack = defineComponent({
  name: "Stack",
  description: "Root vertical ceremony layout.",
  props: z.object({ children: z.array(z.union([leaf, Panel.ref])).max(20) }),
  component: ({ props, renderNode }) => (
    <div className="ceremony-stack">{renderNode(props.children)}</div>
  ),
});
export const ceremonyLibrary = createLibrary({
  components: [
    Stack,
    Panel,
    Title,
    Text,
    Details,
    Access,
    Fields,
    Redirect,
    Device,
    Notice,
    Outcome,
    Actions,
  ],
  root: "Stack",
});

function walk(node: unknown, counts: Map<string, number>): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((value) => walk(value, counts));
    return;
  }
  if (
    "type" in node &&
    node.type === "element" &&
    "typeName" in node &&
    typeof node.typeName === "string" &&
    "props" in node
  ) {
    counts.set(node.typeName, (counts.get(node.typeName) ?? 0) + 1);
    walk(node.props, counts);
  } else Object.values(node).forEach((value) => walk(value, counts));
}
/** Closed authoring subset: only static component calls, references, arrays, and JSON strings. */
function staticSource(source: string): boolean {
  const withoutStrings = source.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return (
    !/[^A-Za-z0-9_\s=(),\[\]"]/.test(withoutStrings) &&
    !/\b(?:Query|Mutation|Action)\s*\(/.test(withoutStrings)
  );
}
export function validateTemplate(input: unknown): {
  template?: CeremonyTemplate;
  errors: string[];
} {
  const shape = templateSchema.safeParse(input);
  if (!shape.success)
    return {
      errors: shape.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      ),
    };
  const errors: string[] = [];
  for (const step of steps) {
    const source = shape.data.screens[step];
    if (!staticSource(source)) {
      errors.push(
        `${step}: only static components and declared runtime bindings are allowed`,
      );
      continue;
    }
    try {
      const parsed = createParser(ceremonyLibrary.toJSONSchema()).parse(source);
      if (
        !parsed.root ||
        parsed.root.typeName !== "Stack" ||
        parsed.meta.incomplete ||
        parsed.meta.errors.length ||
        parsed.meta.unresolved.length ||
        parsed.meta.orphaned.length ||
        parsed.queryStatements.length ||
        parsed.mutationStatements.length ||
        Object.keys(parsed.stateDeclarations).length
      ) {
        errors.push(
          `${step}: incomplete, invalid or unreachable OpenUI components`,
        );
        continue;
      }
      const counts = new Map<string, number>();
      walk(parsed.root, counts);
      for (const name of ["Title", ...requiredParts[step]])
        if (counts.get(name) !== 1)
          errors.push(`${step}: requires exactly one ${name}`);
      for (const name of [
        "Fields",
        "Access",
        "Redirect",
        "Device",
        "Outcome",
        "Actions",
        "Notice",
        "Details",
      ])
        if (!requiredParts[step].includes(name) && counts.has(name))
          errors.push(`${step}: ${name} is not allowed here`);
      if (counts.get("Stack") !== 1)
        errors.push(`${step}: requires one root Stack`);
    } catch {
      errors.push(`${step}: OpenUI parsing failed`);
    }
  }
  return errors.length ? { errors } : { template: shape.data, errors };
}
export function authoringPrompt(): string {
  return ceremonyLibrary.prompt({
    bindings: false,
    toolCalls: false,
    preamble:
      "Author reusable authentication ceremony templates. Output one JSON object with version:1, id, kind and screens. Every screen is static OpenUI Lang, root = Stack([...]). Never put secrets, literal URLs, authentication decisions or field definitions in source. Runtime components provide all bindings. Use only double quoted JSON strings, component calls, references and arrays.",
    additionalRules: steps.map(
      (step) =>
        `${step}: exactly one Title and one each of ${requiredParts[step].join(", ")}. Other bound components are forbidden. Optional Text and Panel may be used.`,
    ),
  });
}
export function BoundCeremony({
  snapshot,
  template,
  busy = false,
  act,
  navigate,
  errorId,
  children,
}: Bindings & { template: CeremonyTemplate; children?: ReactNode }) {
  const [renderError, setRenderError] = useState(false);
  const idPrefix = useId();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values: Record<string, string> = {};
    for (const [key, value] of new FormData(event.currentTarget))
      if (typeof value === "string") values[key] = value;
    event.currentTarget.reset();
    act("submit", values);
  };
  if (renderError)
    return (
      <p role="alert">
        The ceremony could not render. Reload or contact the connector author.
      </p>
    );
  return (
    <Context.Provider
      value={{ snapshot, busy, act, navigate, idPrefix, errorId }}
    >
      <form
        onSubmit={submit}
        className="ceremony-form"
        data-ceremony=""
        data-ceremony-part="form"
        key={`${snapshot.id}:${snapshot.revision}`}
      >
        <Renderer
          library={ceremonyLibrary}
          response={template.screens[snapshot.step]}
          isStreaming={false}
          publishObservability={false}
          onError={(errors) => {
            if (errors.length) setRenderError(true);
          }}
        />
        {children}
      </form>
    </Context.Provider>
  );
}
