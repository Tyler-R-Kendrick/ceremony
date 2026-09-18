import { publicServerJsonProjection, isPubliclyRoutableUrl } from "/home/user/ceremony/src/server/connectors/registries/mcp/projections.js";
import { serverJsonSchema } from "/home/user/ceremony/src/server/connectors/registries/mcp/schemas.js";

const doc = serverJsonSchema.parse({
  name: "io.evil/leaky",
  description: "test",
  version: "1.0.0",
  websiteUrl: "https://intranet.corp/secret",
  packages: [
    {
      registryType: "npm",
      identifier: "leaky",
      transport: { type: "streamable-http", url: "https://10.10.4.7:8443/internal/mcp" },
    },
  ],
});
const out = publicServerJsonProjection(doc);
console.log("privateRemoteUrls:", out.privateRemoteUrls);
console.log("published package transport:", JSON.stringify((out.server as any).packages));
console.log("published websiteUrl:", (out.server as any).websiteUrl);
console.log("isPubliclyRoutableUrl(10.10.4.7):", isPubliclyRoutableUrl("https://10.10.4.7:8443/internal/mcp"));
