import { startHttpFixture, type RecordedRequest } from "./http-fixture.js";

/*
 * An independent Open Service Broker API v2.17 broker.
 *
 * Written from the specification (released tag `v2.17` of
 * openservicebrokerapi/servicebroker, `spec.md`), not from the adapter: it
 * decides on its own what a conforming platform request looks like, so a test
 * that passes here is evidence about the wire, not an echo of the client.
 *
 * It enforces the required `X-Broker-API-Version` header, basic
 * authentication, and the documented status codes, and it records every
 * request. Provisioning routes exist only so that an attempt to use one is
 * *recorded and refused*: `mutating()` is the assertion surface for "no
 * provisioning request was issued".
 */

export type BrokerPlan = {
  id: string;
  name: string;
  description: string;
  free?: boolean;
  bindable?: boolean;
  binding_rotatable?: boolean;
  plan_updateable?: boolean;
  maximum_polling_duration?: number;
};

export type BrokerService = {
  id: string;
  name: string;
  description: string;
  bindable: boolean;
  instances_retrievable?: boolean;
  bindings_retrievable?: boolean;
  plan_updateable?: boolean;
  tags?: string[];
  requires?: string[];
  metadata?: Record<string, unknown>;
  plans: BrokerPlan[];
};

export type BrokerInstance = {
  instanceId: string;
  serviceId: string;
  planId: string;
  dashboardUrl?: string;
  parameters?: Record<string, unknown>;
  /** `in progress` makes the fetch endpoint answer 404 the way the spec requires. */
  lastOperation?: {
    state: "in progress" | "succeeded" | "failed";
    description?: string;
  };
};

export type BrokerBinding = {
  instanceId: string;
  bindingId: string;
  credentials?: Record<string, unknown>;
  endpoints?: Array<{ host: string; ports: string[]; protocol?: string }>;
  expiresAt?: string;
  lastOperation?: { state: "in progress" | "succeeded" | "failed" };
};

export type ServiceBrokerFixtureOptions = {
  services: BrokerService[];
  instances?: BrokerInstance[];
  bindings?: BrokerBinding[];
  /** Basic-auth pair the broker demands; omit to accept unauthenticated reads. */
  credentials?: { username: string; password: string };
  /** Highest minor version this broker speaks; a platform asking for more gets 412. */
  supportedMinor?: number;
};

const json = (status: number, body: unknown) => ({
  status,
  headers: { "content-type": "application/json" },
  body: body as Record<string, unknown>,
});

function basicAuthOf(header: string | undefined) {
  if (!header?.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return undefined;
  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
  };
}

export async function startServiceBrokerFixture(
  options: ServiceBrokerFixtureOptions,
) {
  const supportedMinor = options.supportedMinor ?? 17;
  const instances = new Map(
    (options.instances ?? []).map((instance) => [
      instance.instanceId,
      instance,
    ]),
  );
  const bindings = new Map(
    (options.bindings ?? []).map((binding) => [
      `${binding.instanceId.length}:${binding.instanceId}|${binding.bindingId}`,
      binding,
    ]),
  );
  const serviceOf = (serviceId: string | null) =>
    options.services.find((service) => service.id === serviceId);
  const serviceForInstance = (instance: BrokerInstance) =>
    options.services.find((service) => service.id === instance.serviceId);

  const fixture = await startHttpFixture((request) => {
    // Required on every platform request; a broker MAY reject its absence.
    const version = request.headers["x-broker-api-version"];
    if (!version)
      return json(400, {
        error: "MissingVersionHeader",
        description: "X-Broker-API-Version is required.",
      });
    const [major, minor] = version.split(".").map((part) => Number(part));
    if (major !== 2 || !Number.isInteger(minor))
      return json(412, {
        error: "RequestedVersionNotSupported",
        description: `This broker speaks 2.${supportedMinor}.`,
      });
    if ((minor as number) > supportedMinor)
      return json(412, {
        error: "RequestedVersionNotSupported",
        description: `This broker speaks 2.${supportedMinor}.`,
      });

    if (options.credentials) {
      const presented = basicAuthOf(request.headers["authorization"]);
      if (
        !presented ||
        presented.username !== options.credentials.username ||
        presented.password !== options.credentials.password
      )
        return { status: 401, body: { error: "Unauthorized" } };
    }

    const path = request.url.pathname;

    if (request.method === "GET" && path === "/v2/catalog")
      return json(200, { services: options.services });

    const instanceMatch = /^\/v2\/service_instances\/([^/]+)$/.exec(path);
    const instanceOperationMatch =
      /^\/v2\/service_instances\/([^/]+)\/last_operation$/.exec(path);
    const bindingMatch =
      /^\/v2\/service_instances\/([^/]+)\/service_bindings\/([^/]+)$/.exec(
        path,
      );
    const bindingOperationMatch =
      /^\/v2\/service_instances\/([^/]+)\/service_bindings\/([^/]+)\/last_operation$/.exec(
        path,
      );

    /*
     * Anything that would change state. A conforming inspection-only platform
     * never sends one; this broker records it and refuses, so a test can
     * assert on the absence rather than on a comment.
     */
    if (request.method !== "GET")
      return json(500, {
        error: "NotOfferedByThisFixture",
        description: "This fixture broker provisions nothing.",
      });

    if (instanceMatch) {
      const instance = instances.get(decodeURIComponent(instanceMatch[1]!));
      if (!instance) return json(404, { error: "NotFound" });
      const service = serviceForInstance(instance);
      // The spec only requires the endpoint when the offering declares it.
      if (!service?.instances_retrievable)
        return json(404, { error: "NotFound" });
      if (instance.lastOperation?.state === "in progress")
        return json(404, { error: "NotFound" });
      return json(200, {
        service_id: instance.serviceId,
        plan_id: instance.planId,
        ...(instance.dashboardUrl
          ? { dashboard_url: instance.dashboardUrl }
          : {}),
        ...(instance.parameters ? { parameters: instance.parameters } : {}),
      });
    }

    if (instanceOperationMatch) {
      const instance = instances.get(
        decodeURIComponent(instanceOperationMatch[1]!),
      );
      if (!instance) return json(404, { error: "NotFound" });
      return json(200, instance.lastOperation ?? { state: "succeeded" });
    }

    if (bindingMatch) {
      const instanceId = decodeURIComponent(bindingMatch[1]!);
      const bindingId = decodeURIComponent(bindingMatch[2]!);
      const binding = bindings.get(
        `${instanceId.length}:${instanceId}|${bindingId}`,
      );
      if (!binding) return json(404, { error: "NotFound" });
      const instance = instances.get(instanceId);
      const service = instance ? serviceForInstance(instance) : undefined;
      if (!service?.bindings_retrievable)
        return json(404, { error: "NotFound" });
      if (binding.lastOperation?.state === "in progress")
        return json(404, { error: "NotFound" });
      return json(200, {
        ...(binding.expiresAt
          ? { metadata: { expires_at: binding.expiresAt } }
          : {}),
        ...(binding.credentials ? { credentials: binding.credentials } : {}),
        ...(binding.endpoints ? { endpoints: binding.endpoints } : {}),
      });
    }

    if (bindingOperationMatch) {
      const instanceId = decodeURIComponent(bindingOperationMatch[1]!);
      const bindingId = decodeURIComponent(bindingOperationMatch[2]!);
      const binding = bindings.get(
        `${instanceId.length}:${instanceId}|${bindingId}`,
      );
      if (!binding) return json(404, { error: "NotFound" });
      return json(200, binding.lastOperation ?? { state: "succeeded" });
    }

    void serviceOf;
    return json(404, { error: "NotFound" });
  });

  return {
    origin: fixture.origin,
    requests: fixture.requests,
    received: fixture.received,
    /** Every request that was not a GET: the assertion surface for "nothing was provisioned". */
    mutating(): RecordedRequest[] {
      return fixture.requests.filter((request) => request.method !== "GET");
    },
    /** Requests whose path is one of the provisioning or binding-creation routes, whatever the method. */
    provisioningAttempts(): RecordedRequest[] {
      return fixture.requests.filter(
        (request) =>
          request.method !== "GET" &&
          /^\/v2\/service_instances\//.test(request.url.pathname),
      );
    },
    apiVersionsSeen(): string[] {
      return [
        ...new Set(
          fixture.requests
            .map((request) => request.headers["x-broker-api-version"])
            .filter((value): value is string => typeof value === "string"),
        ),
      ];
    },
    originatingIdentities(): string[] {
      return fixture.requests
        .map((request) => request.headers["x-broker-api-originating-identity"])
        .filter((value): value is string => typeof value === "string");
    },
    requestIdentities(): string[] {
      return fixture.requests
        .map((request) => request.headers["x-broker-api-request-identity"])
        .filter((value): value is string => typeof value === "string");
    },
    close: fixture.close,
  };
}

export type ServiceBrokerFixture = Awaited<
  ReturnType<typeof startServiceBrokerFixture>
>;
