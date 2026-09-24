import createClient from "openapi-fetch";
import type { paths } from "./generated/connectors.js";

/*
 * Calls the generated types must refuse. Each line below is a mistake the
 * description rules out, marked `@ts-expect-error`; if the generated types
 * stopped ruling it out, the directive would be unused and the type-check in
 * tests/openapi-client.test.ts would fail. That is what shows the client is
 * typed by the description rather than merely compiling against `any`.
 *
 * Never executed.
 */

const client = createClient<paths>({ baseUrl: "https://connectors.example" });

export async function mistakes() {
  // A POST without the required same-origin `Origin` header parameter.
  // @ts-expect-error params.header.Origin is required
  await client.POST("/api/v1/connectors/import", {
    body: { kind: "upload", mediaType: "application/json", text: "{}" },
  });

  await client.POST("/api/v1/connectors/import", {
    params: { header: { Origin: "https://connectors.example" } },
    // @ts-expect-error `kind` is "upload" or "url", nothing else
    body: { kind: "paste", mediaType: "application/json", text: "{}" },
  });

  // @ts-expect-error there is no such route in the description
  await client.GET("/api/v1/connectors/credentials");

  await client.GET("/api/v1/connectors/connections", {
    // @ts-expect-error `lifecycle` is a closed set
    params: { query: { lifecycle: "connected" } },
  });

  const { data } = await client.GET(
    "/api/v1/connectors/connections/{connectionRef}",
    { params: { path: { connectionRef: "connection:1" } } },
  );
  if (data && "verified" in data) {
    // @ts-expect-error the assistant's projection never carries a presentation
    void data.presentation;
  }
}
