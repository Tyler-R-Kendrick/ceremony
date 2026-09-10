import { z } from "zod";
import {
  connectorManifestV1Schema,
  defaultTemplate,
  type AuthMethod,
  type ConnectorManifest,
  type FlowKind,
  templateSchema,
} from "./schema.js";

const identifier = z.string().regex(/^[a-z0-9-]{1,64}$/);
const operation = z.string().regex(/^[A-Za-z][A-Za-z0-9._/-]{0,119}$/);
/** Authoring envelope, not an execution engine or publication grant. */
export const connectorProjectSchema = z
  .strictObject({
    format: z.literal("ceremony-connector"),
    version: z.literal(1),
    manifest: connectorManifestV1Schema,
    templates: z.array(templateSchema).max(12).default([]),
    workflows: z
      .array(
        z.strictObject({
          document: identifier,
          arazzo: z.literal("1.0.1"),
          info: z.strictObject({
            title: z.string().min(1).max(100),
            version: z.literal("1.0.0"),
          }),
          sourceDescriptions: z
            .array(
              z.strictObject({
                name: z.literal("provider"),
                url: z
                  .string()
                  .max(500)
                  .url()
                  .refine((value) => {
                    if (!URL.canParse(value)) return false;
                    const url = new URL(value);
                    return (
                      url.protocol === "https:" &&
                      !url.username &&
                      !url.password &&
                      !url.search &&
                      !url.hash
                    );
                  }, "Use a public HTTPS OpenAPI document URL without credentials or query parameters"),
                type: z.literal("openapi"),
              }),
            )
            .length(1),
          workflows: z
            .array(
              z.strictObject({
                workflowId: identifier,
                summary: z.string().min(1).max(500),
                steps: z
                  .array(
                    z.strictObject({
                      stepId: identifier,
                      description: z.string().min(1).max(500),
                      operationId: operation,
                    }),
                  )
                  .min(1)
                  .max(32),
              }),
            )
            .min(1)
            .max(12),
        }),
      )
      .min(1)
      .max(12),
  })
  .superRefine(validateReferences);
function validateReferences(
  project: {
    manifest: {
      methods: Array<{
        kind: string;
        templateId: string;
        contract: {
          workflows: Array<{
            document: string;
            version: string;
            workflowId: string;
          }>;
        };
      }>;
    };
    templates: Array<{ id: string; kind: string }>;
    workflows: Array<{
      document: string;
      info: { version: string };
      workflows: Array<{
        workflowId: string;
        steps: Array<{ stepId: string }>;
      }>;
    }>;
  },
  ctx: z.RefinementCtx,
) {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  const documents = new Set<string>();
  let count = 0;
  for (const doc of project.workflows) {
    if (documents.has(doc.document)) fail("Duplicate workflow document");
    documents.add(doc.document);
    if (
      new Set(doc.workflows.map((w) => w.workflowId)).size !==
      doc.workflows.length
    )
      fail("Duplicate workflow ID");
    for (const workflow of doc.workflows) {
      count += workflow.steps.length;
      if (
        new Set(workflow.steps.map((s) => s.stepId)).size !==
        workflow.steps.length
      )
        fail("Duplicate step ID");
    }
  }
  if (count > 32) fail("A connector project supports at most 32 steps");
  const referenced = new Set<string>();
  const presentationKinds = new Map<string, string>();
  for (const method of project.manifest.methods) {
    const kind = presentationKinds.get(method.templateId);
    if (kind !== undefined && kind !== method.kind)
      fail("Presentation ID cannot be shared across authentication families");
    presentationKinds.set(method.templateId, method.kind);
    if (method.contract.workflows.length !== 1)
      fail("Studio methods require exactly one editable workflow");
    for (const ref of method.contract.workflows) {
      const doc = project.workflows.find((d) => d.document === ref.document);
      const workflow = doc?.workflows.find(
        (w) => w.workflowId === ref.workflowId,
      );
      if (!workflow || doc?.info.version !== ref.version)
        fail("Method references an unavailable workflow version");
      referenced.add(`${ref.document}:${ref.workflowId}`);
    }
  }
  for (const doc of project.workflows)
    for (const workflow of doc.workflows)
      if (!referenced.has(`${doc.document}:${workflow.workflowId}`))
        fail("Workflow is not attached to an authentication method");
  if (
    new Set(project.templates.map((t) => t.id)).size !==
    project.templates.length
  )
    ctx.addIssue({ code: "custom", message: "Duplicate presentation ID" });
  for (const template of project.templates)
    if (
      !project.manifest.methods.some(
        (method) =>
          method.kind === template.kind && method.templateId === template.id,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Presentation is not attached to a method",
      });
}
export type ConnectorProject = z.infer<typeof connectorProjectSchema>;

// Drafts use the same representation with blank form fields permitted. They are
// never accepted by the completed-definition validator or the execution runtime.
const manifestShape = connectorManifestV1Schema.shape;
const methodShape = manifestShape.methods.element.shape;
const contractShape = methodShape.contract.shape;
const documentShape = connectorProjectSchema.shape.workflows.element.shape;
const workflowShape = documentShape.workflows.element.shape;
const stepShape = workflowShape.steps.element.shape;
export const connectorProjectDraftSchema = z
  .strictObject({
    ...connectorProjectSchema.shape,
    manifest: z.strictObject({
      ...manifestShape,
      id: z.string().max(64),
      name: z.string().max(100),
      methods: z
        .array(
          z.strictObject({
            ...methodShape,
            label: z.string().max(100),
            contract: z.strictObject({
              ...contractShape,
              completion: z.strictObject({
                ...contractShape.completion.shape,
                verifier: z.string().max(120),
              }),
              configuration: z
                .array(
                  z.strictObject({
                    ...contractShape.configuration.element.shape,
                    name: z.string().max(96),
                  }),
                )
                .max(24),
              prerequisites: z
                .array(
                  z.strictObject({
                    ...contractShape.prerequisites.element.shape,
                    id: z.string().max(120),
                  }),
                )
                .max(12),
              workflows: contractShape.workflows.length(1),
            }),
          }),
        )
        .max(12),
    }),
    workflows: z
      .array(
        z.strictObject({
          ...documentShape,
          sourceDescriptions: z
            .array(
              z.strictObject({
                ...documentShape.sourceDescriptions.element.shape,
                url: z.union([
                  documentShape.sourceDescriptions.element.shape.url,
                  z.literal(""),
                ]),
              }),
            )
            .length(1),
          workflows: z
            .array(
              z.strictObject({
                ...workflowShape,
                steps: z
                  .array(
                    z.strictObject({
                      ...stepShape,
                      description: z.string().max(500),
                      operationId: z.union([operation, z.literal("")]),
                    }),
                  )
                  .min(1)
                  .max(32),
              }),
            )
            .max(12),
        }),
      )
      .min(1)
      .max(12),
  })
  .superRefine(validateReferences);

export function parseConnectorDraft(text: string) {
  if (new TextEncoder().encode(text).byteLength > 256 * 1024)
    throw new Error("Project exceeds 256 KiB");
  return connectorProjectDraftSchema.parse(JSON.parse(text));
}

export function parseConnectorProject(text: string): ConnectorProject {
  if (new TextEncoder().encode(text).byteLength > 256 * 1024)
    throw new Error("Project exceeds 256 KiB");
  return connectorProjectSchema.parse(JSON.parse(text));
}

/** Conservative initial fields, not inferred provider capabilities. Author reviews every method. */
export function newAuthoredMethod(kind: FlowKind, id: string): AuthMethod {
  const privateInput = ["api-key", "basic", "form"].includes(kind);
  const fields: AuthMethod["fields"] =
    kind === "api-key"
      ? [
          {
            name: "token",
            label: "API key",
            type: "password",
            required: true,
            classification: "secret",
          },
        ]
      : kind === "basic" || kind === "form"
        ? [
            {
              name: "username",
              label: "Username",
              type: "text",
              required: true,
              classification: "personal",
            },
            {
              name: "password",
              label: "Password",
              type: "password",
              required: true,
              classification: "secret",
            },
          ]
        : [];
  return {
    id,
    kind,
    label: kind,
    fields,
    scopes: [],
    templateId: kind,
    contract: {
      profile: id,
      surfaces: ["browser"],
      configuration: [],
      configurationGroups: [],
      prerequisites:
        kind === "oauth-code" || kind === "github-app"
          ? [
              {
                id: "shared-app",
                kind: "provider-registration" as const,
                reuse: "verified-context" as const,
                handoff: {
                  surface: "private-collector" as const,
                  recipient: "authorized-owner" as const,
                  delegation: "a2h-authorize" as const,
                  resume: "verify" as const,
                },
              },
            ]
          : [],
      handoff: {
        surface: privateInput ? "private-collector" : "provider-browser",
        recipient: "initiating-subject",
        delegation: "a2h-authorize",
        resume: "verify",
      },
      completion: {
        verifier: "",
        ownership: [
          kind === "authmd-anonymous" ? "anonymous" : "authenticated",
        ],
      },
      workflows: [{ document: "ceremonies", version: "1.0.0", workflowId: id }],
    },
  };
}

/** Generic Arazzo outline for an auth family. Authors still bind host SDK handlers. */
export function defaultWorkflowSteps(kind: FlowKind) {
  const steps: Record<
    FlowKind,
    Array<{ stepId: string; description: string; operationId: string }>
  > = {
    "api-key": [
      {
        stepId: "collect-credential",
        description: "Collect the API key through the private collector",
        operationId: "provider.collect-credential",
      },
      {
        stepId: "verify-access",
        description: "Verify the key against the provider",
        operationId: "provider.verify-access",
      },
    ],
    basic: [
      {
        stepId: "collect-credentials",
        description:
          "Collect username and password through the private collector",
        operationId: "provider.collect-credentials",
      },
      {
        stepId: "verify-access",
        description: "Verify Basic access",
        operationId: "provider.verify-access",
      },
    ],
    form: [
      {
        stepId: "collect-credentials",
        description: "Collect sign-in fields through the private collector",
        operationId: "provider.collect-credentials",
      },
      {
        stepId: "verify-access",
        description: "Verify the signed-in session",
        operationId: "provider.verify-access",
      },
    ],
    "oauth-code": [
      {
        stepId: "prepare-app",
        description: "Prepare the shared OAuth app when the host has none",
        operationId: "provider.prepare-app",
      },
      {
        stepId: "authorize-user",
        description: "Authorize the user at the provider",
        operationId: "provider.authorize-user",
      },
      {
        stepId: "verify-access",
        description: "Verify provider access",
        operationId: "provider.verify-access",
      },
    ],
    device: [
      {
        stepId: "request-device",
        description: "Request a device code",
        operationId: "provider.request-device",
      },
      {
        stepId: "wait-approval",
        description: "Wait for the user to approve the device",
        operationId: "provider.wait-approval",
      },
      {
        stepId: "verify-access",
        description: "Verify provider access",
        operationId: "provider.verify-access",
      },
    ],
    "authmd-anonymous": [
      {
        stepId: "register-anonymous",
        description: "Register an anonymous identity",
        operationId: "provider.register-anonymous",
      },
      {
        stepId: "verify-anonymous",
        description: "Verify anonymous access",
        operationId: "provider.verify-anonymous",
      },
      {
        stepId: "claim-ownership",
        description: "Claim the identity when the provider requires it",
        operationId: "provider.claim-ownership",
      },
    ],
    "github-app": [
      {
        stepId: "register-app",
        description: "Register the GitHub App",
        operationId: "github.register-app",
      },
      {
        stepId: "install-app",
        description: "Install the GitHub App",
        operationId: "github.install-app",
      },
      {
        stepId: "verify-access",
        description: "Verify installation access",
        operationId: "github.verify-access",
      },
    ],
  };
  return steps[kind].map((step) => ({ ...step }));
}

export type ConnectorDraft = ReturnType<typeof newConnectorProject>;

function nextMethodId(project: ConnectorDraft) {
  let i = project.manifest.methods.length + 1;
  while (project.manifest.methods.some((method) => method.id === `method-${i}`))
    i++;
  return `method-${i}`;
}

/** Attach a generic family ceremony, including its OpenUI template. */
export function attachGenericCeremony(
  project: ConnectorDraft,
  kind: FlowKind,
  label: string,
) {
  if (project.manifest.methods.length >= 12) throw new Error("method limit");
  const id = nextMethodId(project);
  const method = newAuthoredMethod(kind, id);
  method.label = label;
  method.contract!.workflows[0]!.document = project.workflows[0]!.document;
  method.contract!.completion.verifier = `${id}.verify-access`;
  project.manifest.methods.push(method);
  project.workflows[0]!.workflows.push({
    workflowId: id,
    summary: label,
    steps: defaultWorkflowSteps(kind),
  });
  if (!project.templates.some((template) => template.id === method.templateId))
    project.templates.push(defaultTemplate(kind));
  return method;
}

export const providerCatalog: Record<
  string,
  {
    name: string;
    description: string;
    methods: FlowKind[];
    origins: string[];
  }
> = {
  github: {
    name: "GitHub",
    description: "Connect a GitHub account or App.",
    methods: ["github-app", "oauth-code", "device", "api-key"],
    origins: ["https://github.com", "https://api.github.com"],
  },
  stripe: {
    name: "Stripe",
    description: "Verify a Stripe secret or restricted key.",
    methods: ["api-key"],
    origins: ["https://api.stripe.com"],
  },
  jira: {
    name: "Jira",
    description:
      "Authorize a Jira Cloud site through a shared OAuth app, then the user's consent.",
    methods: ["oauth-code"],
    origins: ["https://developer.atlassian.com"],
  },
  atlassian: {
    name: "Atlassian",
    description:
      "Authorize an Atlassian Cloud site through a shared OAuth app, then the user's consent.",
    methods: ["oauth-code"],
    origins: ["https://developer.atlassian.com"],
  },
  supabase: {
    name: "Supabase",
    description: "Sign in to a Supabase Auth project.",
    methods: ["form"],
    origins: ["https://supabase.com"],
  },
  neon: {
    name: "Neon",
    description:
      "Start anonymous Neon access and claim the project when required.",
    methods: ["authmd-anonymous"],
    origins: ["https://neon.com"],
  },
  slack: {
    name: "Slack",
    description: "Authorize a Slack workspace with OAuth.",
    methods: ["oauth-code"],
    origins: ["https://slack.com"],
  },
  google: {
    name: "Google",
    description: "Authorize a Google account with OAuth.",
    methods: ["oauth-code"],
    origins: ["https://accounts.google.com"],
  },
};

const providerAliases: Record<string, string> = {
  gh: "github",
  ghe: "github",
  goog: "google",
};

function providerSlug(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function editDistance(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = i - 1;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(
        row[j]! + 1,
        row[j - 1]! + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = current;
    }
  }
  return row[b.length]!;
}

export type ProviderResolution = {
  query: string;
  resolved: string;
  confidence: "high" | "low";
  alternatives: string[];
};

/** High-confidence catalog correction only. Ambiguous names stay unresolved. */
export function disambiguateProvider(name: string): ProviderResolution {
  const slug = providerSlug(name);
  const aliased = providerAliases[slug];
  if (aliased)
    return {
      query: name,
      resolved: aliased,
      confidence: "high",
      alternatives: [],
    };
  if (providerCatalog[slug])
    return {
      query: name,
      resolved: slug,
      confidence: "high",
      alternatives: [],
    };
  const first = slug.split("-")[0]!;
  if (first && providerCatalog[first])
    return {
      query: name,
      resolved: first,
      confidence: "high",
      alternatives: [],
    };
  const scored = Object.keys(providerCatalog)
    .map((key) => ({ key, distance: editDistance(slug, key) }))
    .filter((item) => item.distance <= 2)
    .sort((left, right) => left.distance - right.distance);
  const best = scored[0];
  const next = scored[1];
  if (
    best &&
    best.distance <= 1 &&
    slug.length >= 4 &&
    (next?.distance ?? 9) > best.distance
  )
    return {
      query: name,
      resolved: best.key,
      confidence: "high",
      alternatives: [],
    };
  return {
    query: name,
    resolved: slug || name.trim(),
    confidence: "low",
    alternatives: scored.slice(0, 3).map((item) => item.key),
  };
}

/** Conservative family selection from a provider name. Does not fetch or certify the provider. */
export function proposeConnectorForProvider(name: string) {
  const resolution = disambiguateProvider(name);
  const slug = resolution.resolved;
  const known = providerCatalog[slug];
  if (known && resolution.confidence === "high")
    return { slug, ...known, resolution };
  const label = name.trim() || "Provider";
  return {
    slug: slug || "provider",
    name: label,
    description: `Connect ${label} with a generic OAuth ceremony. Review every step before export.`,
    methods: ["oauth-code"] as FlowKind[],
    origins: [] as string[],
    resolution,
  };
}

export function applyProviderProposal(
  project: ConnectorDraft,
  name: string,
  overrides?: { methods?: FlowKind[]; openApiUrl?: string },
) {
  const proposal = proposeConnectorForProvider(name);
  if (!project.manifest.name) project.manifest.name = proposal.name;
  if (!project.manifest.id) project.manifest.id = proposal.slug;
  if (!project.manifest.description)
    project.manifest.description = proposal.description;
  if (overrides?.openApiUrl)
    project.workflows[0]!.sourceDescriptions[0]!.url = overrides.openApiUrl;
  const kinds = overrides?.methods?.length
    ? overrides.methods
    : proposal.methods;
  const familyNames: Record<FlowKind, string> = {
    "api-key": "API key",
    basic: "Username and password (Basic)",
    form: "Sign-in form",
    "oauth-code": "Browser authorization (OAuth)",
    device: "Device authorization",
    "authmd-anonymous": "Anonymous access and claiming",
    "github-app": "GitHub App",
  };
  for (const kind of kinds)
    attachGenericCeremony(project, kind, familyNames[kind]);
  return proposal;
}

/** Parent ceremony that reuses selected child ceremonies as prerequisites. */
export function composeAuthoredMethods(
  project: ConnectorDraft,
  childIds: string[],
) {
  const children = childIds.map((id) => {
    const method = project.manifest.methods.find((item) => item.id === id);
    if (!method) throw new Error("unknown method");
    return method;
  });
  if (children.length < 2) throw new Error("compose requires two ceremonies");
  const parent = attachGenericCeremony(
    project,
    children[0]!.kind,
    "Composed ceremony",
  );
  parent.contract!.prerequisites = children.map((child) => ({
    id: child.id,
    kind:
      child.kind === "oauth-code" || child.kind === "github-app"
        ? ("provider-registration" as const)
        : ("provider-consent" as const),
    reuse: "verified-context" as const,
    handoff: child.contract!.handoff,
  }));
  parent.contract!.completion.verifier = `${parent.id}.verify-access`;
  const workflow = project.workflows[0]!.workflows.find(
    (item) => item.workflowId === parent.id,
  )!;
  workflow.summary = "Complete after the composed ceremonies";
  workflow.steps = [
    {
      stepId: "verify-composed",
      description: "Verify access after the selected ceremonies succeed",
      operationId: "provider.verify-composed",
    },
  ];
  return parent;
}

export function newConnectorProject(): Omit<ConnectorProject, "manifest"> & {
  manifest: ConnectorManifest;
} {
  return {
    format: "ceremony-connector" as const,
    version: 1 as const,
    templates: [],
    manifest: {
      schemaVersion: 1 as const,
      support: "live-adapter" as const,
      id: "",
      name: "",
      description: "",
      methods: [] as AuthMethod[],
    },
    workflows: [
      {
        document: "ceremonies",
        arazzo: "1.0.1" as const,
        info: { title: "Connector ceremonies", version: "1.0.0" as const },
        sourceDescriptions: [
          { name: "provider" as const, url: "", type: "openapi" as const },
        ],
        workflows: [] as ConnectorProject["workflows"][number]["workflows"],
      },
    ],
  };
}

/** Portable files only. The host must register handlers and verifiers separately. */
export function exportConnectorFiles(project: ConnectorProject) {
  const parsed = connectorProjectSchema.parse(project);
  return {
    manifest: parsed.manifest,
    workflows: parsed.workflows.map(({ document, ...definition }) => ({
      name: `${document}.arazzo.json`,
      definition,
    })),
    templates: parsed.manifest.methods
      .filter(
        (method, index, methods) =>
          methods.findIndex((m) => m.templateId === method.templateId) ===
          index,
      )
      .map(
        (method) =>
          parsed.templates.find(
            (template) => template.id === method.templateId,
          ) ?? {
            ...defaultTemplate(method.kind),
            id: method.templateId,
          },
      ),
  };
}
