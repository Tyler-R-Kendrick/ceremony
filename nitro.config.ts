import { defineNitroConfig } from "nitro/config";
export default defineNitroConfig({
  modules: ["workflow/nitro"],
  serverDir: "./hosted",
  publicAssets: [{ dir: "./web-dist", maxAge: 0 }],
  vercel: { entryFormat: "node" },
});
