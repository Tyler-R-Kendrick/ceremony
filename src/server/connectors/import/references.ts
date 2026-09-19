import type { CompatibilityIssue } from "../../../core/connectors/index.js";
import { ConnectorError } from "../errors.js";
import {
  appendPointer,
  escapePointerSegment,
  isPlainObject,
  makeIssue,
  pushIssue,
  unescapePointerSegment,
} from "./common.js";
import type { ParseLimits } from "./limits.js";
import { parseBoundedDocument } from "./parse.js";

/*
 * `$ref` resolution over a bounded registry of documents. A reference is a
 * JSON pointer into the same document or into another document known by its
 * identity (an absolute URL without fragment, or a `urn:` for uploads). The
 * resolver is lazy: resolving returns the target value and expands nothing,
 * so a recursive schema is an ordinary, valid description. Expansion is a
 * separate, bounded operation that stops at a cycle with an informational
 * issue and refuses to continue past its depth or size budget with a blocking
 * one. The resolver has no network access of its own; an external document
 * is retrieved only through an explicit hook, which the import service builds
 * on the approved fetcher, and only within a document and byte budget.
 */

export type ReferenceLimits = {
  /** Documents the registry may hold, registered or fetched. */
  maxDocuments: number;
  /** External documents one resolver may retrieve. */
  maxExternalDocuments: number;
  /**
   * Total bytes of external documents one resolver may retrieve, counted as
   * they arrive and not as they are accepted. A hook that buffers a whole
   * response can only report its length afterwards, so the retrieval that
   * spends the budget may overshoot it by one response; a hook that honours
   * the `limit.maxBytes` it is given does not.
   */
  maxExternalBytes: number;
  maxRefLength: number;
  maxPointerSegments: number;
  /** Resolutions one resolver performs before refusing more. */
  maxResolutions: number;
  maxExpansionDepth: number;
  maxExpansionNodes: number;
};

export const DEFAULT_REFERENCE_LIMITS: Readonly<ReferenceLimits> =
  Object.freeze({
    maxDocuments: 64,
    // A description split across a handful of files is common; a description
    // that fans out further is a bundle to build upstream.
    maxExternalDocuments: 8,
    maxExternalBytes: 8 * 1024 * 1024,
    maxRefLength: 2048,
    maxPointerSegments: 64,
    maxResolutions: 20_000,
    // Deeper than any bounded expansion an executable projection needs.
    maxExpansionDepth: 32,
    maxExpansionNodes: 200_000,
  });

export type ReferenceLocation = { documentId: string; pointer: string };

export type ReferenceFailureStatus =
  | "unresolved"
  | "unsupported"
  | "unsafe"
  | "temporarily-unavailable"
  | "external-not-permitted"
  | "budget-exceeded"
  | "document-invalid";

export type ReferenceOutcome =
  | {
      status: "resolved";
      documentId: string;
      pointer: string;
      value: unknown;
      external: boolean;
    }
  | {
      status: ReferenceFailureStatus;
      /** Sanitized refinement of the failure; never reference text. */
      detail: string;
      issue: CompatibilityIssue;
    };

/**
 * Retrieves one external document. `limit.maxBytes` is what is left of the
 * resolver's byte budget at the moment of the call: a hook that can stop
 * reading part way through -- rather than hand back a buffer it already
 * holds -- should stop there, because everything it retrieves is charged to
 * the budget whether or not the document turns out to be usable.
 */
export type ExternalDocumentFetch = (
  url: URL,
  limit: { maxBytes: number },
) => Promise<{ bytes: Uint8Array; mediaType?: string | undefined }>;

export type ReferenceResolverOptions = {
  limits?: Partial<ReferenceLimits> | undefined;
  parseLimits?: Partial<ParseLimits> | undefined;
  /** The only path to the network; absent means every external reference is refused. */
  fetchExternal?: ExternalDocumentFetch | undefined;
};

type RegisteredDocument = { id: string; value: unknown; external: boolean };
type Failure = { status: ReferenceFailureStatus; detail: string };

const failureIssue: Readonly<
  Record<
    ReferenceFailureStatus,
    Pick<
      CompatibilityIssue,
      | "code"
      | "category"
      | "disposition"
      | "severity"
      | "executionImpact"
      | "message"
      | "remediation"
    >
  >
> = Object.freeze({
  unresolved: {
    code: "reference.unresolved",
    category: "schema",
    disposition: "rejected",
    severity: "blocking",
    executionImpact: "blocks-operation",
    message:
      "A reference does not point at anything in the referenced document.",
    remediation:
      "Correct the reference or include the referenced document in the import.",
  },
  unsupported: {
    code: "reference.unsupported",
    category: "schema",
    disposition: "unsupported",
    severity: "blocking",
    executionImpact: "blocks-operation",
    message:
      "A reference uses a form this importer does not resolve: a non-pointer fragment, a relative location without a base, or an unsupported scheme.",
    remediation:
      "Use a JSON pointer fragment with an HTTPS location, or register the document before import.",
  },
  unsafe: {
    code: "reference.unsafe",
    category: "network",
    disposition: "rejected",
    severity: "blocking",
    executionImpact: "blocks-operation",
    message: "A reference points at a location the network policy refuses.",
    remediation:
      "Reference only public HTTPS documents, or ask an administrator to approve the private origin.",
  },
  "temporarily-unavailable": {
    code: "reference.temporarily-unavailable",
    category: "network",
    disposition: "rejected",
    severity: "blocking",
    executionImpact: "blocks-operation",
    message: "A referenced document could not be retrieved right now.",
    remediation: "Retry the import when the referenced document is reachable.",
  },
  "external-not-permitted": {
    code: "reference.external-not-permitted",
    category: "network",
    disposition: "rejected",
    severity: "blocking",
    executionImpact: "blocks-operation",
    message:
      "A reference points outside the imported documents and external retrieval is not enabled for this import.",
    remediation:
      "Upload the referenced document alongside this one, or enable approved-network resolution.",
  },
  "budget-exceeded": {
    code: "reference.budget-exceeded",
    category: "structure",
    disposition: "rejected",
    severity: "blocking",
    executionImpact: "blocks-operation",
    message:
      "Reference resolution exceeded the import's document, byte or resolution budget.",
    remediation:
      "Reduce the number of referenced documents or split the import.",
  },
  "document-invalid": {
    code: "reference.document-invalid",
    category: "structure",
    disposition: "rejected",
    severity: "blocking",
    executionImpact: "blocks-operation",
    message: "A referenced document could not be parsed within bounds.",
    remediation:
      "Fix the referenced document; its own parse diagnostics apply.",
  },
});

const recursiveSchemaIssue = (pointer: string) =>
  makeIssue({
    code: "structure.recursive-schema",
    category: "structure",
    sourcePointer: pointer,
    disposition: "exact",
    severity: "info",
    executionImpact: "none",
    message:
      "A schema refers to itself. It is preserved by reference and never expanded in place; executable use of it is bounded explicitly.",
  });

const expansionBoundIssue = (pointer: string) =>
  makeIssue({
    code: "reference.expansion-exceeds-bounds",
    category: "structure",
    sourcePointer: pointer,
    disposition: "rejected",
    severity: "blocking",
    executionImpact: "blocks-operation",
    message:
      "Expanding references in place would exceed the import's depth or size bounds; the expansion was refused.",
    remediation:
      "Keep the schema by reference; executable use of it is limited to bounded expansion.",
  });

class ExpansionBound extends Error {}

function resolveLimits(overrides: Partial<ReferenceLimits> = {}) {
  const limits: ReferenceLimits = { ...DEFAULT_REFERENCE_LIMITS };
  for (const key of Object.keys(limits) as Array<keyof ReferenceLimits>) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1)
      throw new ConnectorError("invalid-request", {
        detail: "reference.limits-invalid",
      });
    limits[key] = value;
  }
  return limits;
}

const documentIdPattern = /^[^\p{Cc}\s]{1,2048}$/u;

/** Validates a document identity: an absolute http(s) URL without fragment or userinfo, or a `urn:`. */
export function normalizeDocumentId(value: string): string {
  if (typeof value !== "string" || !documentIdPattern.test(value))
    throw new ConnectorError("invalid-request", {
      detail: "reference.document-id-invalid",
    });
  if (value.startsWith("urn:")) return value;
  if (!URL.canParse(value))
    throw new ConnectorError("invalid-request", {
      detail: "reference.document-id-invalid",
    });
  const url = new URL(value);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new ConnectorError("invalid-request", {
      detail: "reference.document-id-invalid",
    });
  return url.href;
}

export class ReferenceResolver {
  readonly limits: ReferenceLimits;
  readonly issues: CompatibilityIssue[] = [];
  private readonly seen = new Set<string>();
  private readonly documents = new Map<string, RegisteredDocument>();
  private readonly failures = new Map<string, Failure>();
  private readonly inflight = new Map<
    string,
    Promise<RegisteredDocument | Failure>
  >();
  private readonly fetchExternal: ExternalDocumentFetch | undefined;
  private readonly parseLimits: Partial<ParseLimits>;
  private externalDocuments = 0;
  private externalBytes = 0;
  private resolutions = 0;

  constructor(options: ReferenceResolverOptions = {}) {
    this.limits = resolveLimits(options.limits);
    this.fetchExternal = options.fetchExternal;
    this.parseLimits = options.parseLimits ?? {};
  }

  /** Adds a parsed document under its identity; a second registration of the same identity is refused. */
  register(documentId: string, value: unknown): string {
    const id = normalizeDocumentId(documentId);
    if (this.documents.has(id))
      throw new ConnectorError("conflict", {
        detail: "reference.document-duplicate",
      });
    if (this.documents.size >= this.limits.maxDocuments)
      throw new ConnectorError("invalid-request", {
        detail: "reference.registry-full",
      });
    this.documents.set(id, { id, value, external: false });
    return id;
  }

  has(documentId: string): boolean {
    return this.documents.has(documentId);
  }

  budget() {
    return {
      documents: this.documents.size,
      externalDocuments: this.externalDocuments,
      externalBytes: this.externalBytes,
      resolutions: this.resolutions,
    };
  }

  private failure(
    status: ReferenceFailureStatus,
    detail: string,
    from: ReferenceLocation,
  ): ReferenceOutcome {
    const issue = makeIssue({
      ...failureIssue[status],
      sourcePointer: appendPointer(from.pointer, "$ref"),
    });
    pushIssue(this.issues, this.seen, issue);
    return { status, detail, issue };
  }

  private parseReference(
    ref: unknown,
    from: ReferenceLocation,
  ):
    | { documentId: string; segments: string[]; pointer: string }
    | { failure: ReferenceOutcome } {
    if (
      typeof ref !== "string" ||
      ref.length === 0 ||
      ref.length > this.limits.maxRefLength ||
      /\p{Cc}/u.test(ref)
    )
      return {
        failure: this.failure("unsupported", "reference.malformed", from),
      };
    const hash = ref.indexOf("#");
    const locator = hash === -1 ? ref : ref.slice(0, hash);
    const fragment = hash === -1 ? "" : ref.slice(hash + 1);
    let documentId = from.documentId;
    if (locator !== "") {
      let target: URL;
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(locator)) {
        if (!URL.canParse(locator))
          return {
            failure: this.failure("unsupported", "reference.malformed", from),
          };
        target = new URL(locator);
      } else {
        if (!/^https?:/.test(from.documentId))
          return {
            failure: this.failure(
              "unsupported",
              "reference.relative-without-base",
              from,
            ),
          };
        if (!URL.canParse(locator, from.documentId))
          return {
            failure: this.failure("unsupported", "reference.malformed", from),
          };
        target = new URL(locator, from.documentId);
      }
      if (target.protocol !== "https:" && target.protocol !== "http:")
        return {
          failure: this.failure(
            "unsupported",
            "reference.scheme-unsupported",
            from,
          ),
        };
      if (target.username || target.password)
        return {
          failure: this.failure("unsafe", "network.userinfo-forbidden", from),
        };
      target.hash = "";
      documentId = target.href;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(fragment);
    } catch {
      return {
        failure: this.failure(
          "unsupported",
          "reference.fragment-malformed",
          from,
        ),
      };
    }
    if (decoded !== "" && !decoded.startsWith("/"))
      return {
        failure: this.failure(
          "unsupported",
          "reference.plain-name-fragment",
          from,
        ),
      };
    const segments =
      decoded === ""
        ? []
        : decoded.slice(1).split("/").map(unescapePointerSegment);
    if (segments.length > this.limits.maxPointerSegments)
      return {
        failure: this.failure(
          "unsupported",
          "reference.pointer-too-long",
          from,
        ),
      };
    return {
      documentId,
      segments,
      pointer: segments
        .map((segment) => `/${escapePointerSegment(segment)}`)
        .join(""),
    };
  }

  private classifyFetchFailure(error: unknown): Failure {
    if (error instanceof ConnectorError) {
      const detail = error.detail ?? `network.${error.code}`;
      switch (error.code) {
        case "network-policy":
        case "denied":
          return { status: "unsafe", detail };
        case "upstream-rejected":
        case "not-found":
          return { status: "unresolved", detail };
        case "invalid-request":
          return { status: "document-invalid", detail };
        default:
          return { status: "temporarily-unavailable", detail };
      }
    }
    return { status: "temporarily-unavailable", detail: "network.unavailable" };
  }

  private async fetchDocument(
    documentId: string,
  ): Promise<RegisteredDocument | Failure> {
    const known = this.documents.get(documentId);
    if (known) return known;
    const failed = this.failures.get(documentId);
    if (failed) return failed;
    const fetchExternal = this.fetchExternal;
    if (!fetchExternal)
      return {
        status: "external-not-permitted",
        detail: "reference.external-not-permitted",
      };
    const pending = this.inflight.get(documentId);
    if (pending) return pending;
    const task = (async (): Promise<RegisteredDocument | Failure> => {
      if (this.externalDocuments >= this.limits.maxExternalDocuments)
        return {
          status: "budget-exceeded",
          detail: "reference.document-budget",
        };
      // A spent budget refuses before the network is touched. Checking only
      // after a document had been retrieved bounded nothing: a refusal left the
      // total at zero, so the next reference downloaded in full as well, and
      // the only real ceiling was the document count times whatever the
      // fetcher allows per response.
      const remaining = this.limits.maxExternalBytes - this.externalBytes;
      if (remaining <= 0)
        return { status: "budget-exceeded", detail: "reference.bytes-budget" };
      this.externalDocuments++;
      let fetched: Awaited<ReturnType<ExternalDocumentFetch>>;
      try {
        fetched = await fetchExternal(new URL(documentId), {
          maxBytes: remaining,
        });
      } catch (error) {
        return this.classifyFetchFailure(error);
      }
      if (!fetched || !(fetched.bytes instanceof Uint8Array))
        return {
          status: "document-invalid",
          detail: "reference.document-invalid",
        };
      // Every byte that arrived is charged, accepted or not: a hook that hands
      // back a buffer has already paid the transfer, and a document refused
      // for its size must not leave the budget looking untouched.
      this.externalBytes += fetched.bytes.byteLength;
      if (this.externalBytes > this.limits.maxExternalBytes)
        return { status: "budget-exceeded", detail: "reference.bytes-budget" };
      let value: unknown;
      try {
        value = parseBoundedDocument(fetched.bytes, {
          mediaType: fetched.mediaType,
          limits: this.parseLimits,
        }).value;
      } catch (error) {
        return {
          status: "document-invalid",
          detail:
            error instanceof ConnectorError && error.detail
              ? error.detail
              : "reference.document-invalid",
        };
      }
      if (this.documents.size >= this.limits.maxDocuments)
        return { status: "budget-exceeded", detail: "reference.registry-full" };
      const document: RegisteredDocument = {
        id: documentId,
        value,
        external: true,
      };
      this.documents.set(documentId, document);
      return document;
    })();
    this.inflight.set(documentId, task);
    try {
      const outcome = await task;
      if ("status" in outcome) this.failures.set(documentId, outcome);
      return outcome;
    } finally {
      this.inflight.delete(documentId);
    }
  }

  /**
   * Resolves one reference to its target value without expanding it. `from`
   * is the location of the object carrying the `$ref`; issues point at its
   * `$ref` member.
   */
  async resolve(
    ref: unknown,
    from: ReferenceLocation,
  ): Promise<ReferenceOutcome> {
    if (++this.resolutions > this.limits.maxResolutions)
      return this.failure(
        "budget-exceeded",
        "reference.resolution-budget",
        from,
      );
    const parsed = this.parseReference(ref, from);
    if ("failure" in parsed) return parsed.failure;
    let document = this.documents.get(parsed.documentId);
    if (!document) {
      if (!/^https?:/.test(parsed.documentId))
        return this.failure("unresolved", "reference.document-unknown", from);
      const fetched = await this.fetchDocument(parsed.documentId);
      if ("status" in fetched)
        return this.failure(fetched.status, fetched.detail, from);
      document = fetched;
    }
    let value: unknown = document.value;
    for (const segment of parsed.segments) {
      if (Array.isArray(value)) {
        if (
          !/^(0|[1-9][0-9]*)$/.test(segment) ||
          Number(segment) >= value.length
        )
          return this.failure("unresolved", "reference.pointer-missing", from);
        value = value[Number(segment)];
      } else if (isPlainObject(value) && Object.hasOwn(value, segment))
        value = value[segment];
      else return this.failure("unresolved", "reference.pointer-missing", from);
    }
    return {
      status: "resolved",
      documentId: document.id,
      pointer: parsed.pointer,
      value,
      external: document.external,
    };
  }

  /**
   * Dereferences `$ref` members in place, bounded. A cycle is reported once
   * as `structure.recursive-schema` and left as a reference; an unresolvable
   * reference is left untouched with its failure issue; an expansion that
   * would exceed the depth or node budget is refused with a blocking issue
   * and `complete: false`.
   */
  async expand(
    value: unknown,
    from: ReferenceLocation,
  ): Promise<{
    value: unknown;
    issues: CompatibilityIssue[];
    complete: boolean;
  }> {
    const issues: CompatibilityIssue[] = [];
    const seen = new Set<string>();
    let nodes = 0;
    const walk = async (
      node: unknown,
      documentId: string,
      pointer: string,
      stack: readonly string[],
      depth: number,
    ): Promise<unknown> => {
      if (++nodes > this.limits.maxExpansionNodes) throw new ExpansionBound();
      if (depth > this.limits.maxExpansionDepth) throw new ExpansionBound();
      if (Array.isArray(node)) {
        const out: unknown[] = [];
        for (let index = 0; index < node.length; index++)
          out.push(
            await walk(
              node[index],
              documentId,
              appendPointer(pointer, index),
              stack,
              depth + 1,
            ),
          );
        return out;
      }
      if (!isPlainObject(node)) return node;
      if (typeof node.$ref === "string") {
        const outcome = await this.resolve(node.$ref, { documentId, pointer });
        if (outcome.status !== "resolved") {
          pushIssue(issues, seen, outcome.issue);
          return { ...node };
        }
        const key = `${outcome.documentId}#${outcome.pointer}`;
        if (stack.includes(key)) {
          pushIssue(
            issues,
            seen,
            recursiveSchemaIssue(appendPointer(pointer, "$ref")),
          );
          return { $ref: key };
        }
        return walk(
          outcome.value,
          outcome.documentId,
          outcome.pointer,
          [...stack, key],
          depth + 1,
        );
      }
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(node))
        out[key] = await walk(
          node[key],
          documentId,
          appendPointer(pointer, key),
          stack,
          depth + 1,
        );
      return out;
    };
    try {
      const expanded = await walk(
        value,
        from.documentId,
        from.pointer,
        [`${from.documentId}#${from.pointer}`],
        0,
      );
      return { value: expanded, issues, complete: true };
    } catch (error) {
      if (!(error instanceof ExpansionBound)) throw error;
      const issue = expansionBoundIssue(from.pointer);
      pushIssue(issues, seen, issue);
      pushIssue(this.issues, this.seen, issue);
      return { value: undefined, issues, complete: false };
    }
  }
}
