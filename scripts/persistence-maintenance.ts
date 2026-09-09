import { readFile, writeFile, stat } from "node:fs/promises";
import { PostgresCeremonyStore } from "../src/server/persistence/index.js";
import {
  configuredKeyring,
  rotateTenant,
  retainWithoutDemonstration,
} from "../src/server/persistence/maintenance.js";
import { AsyncPrivateCollectionBroker } from "../src/server/persistence/collections.js";

async function main() {
  const [action, pathOrTenant, id] = process.argv.slice(2);
  if (
    process.env.CEREMONY_MAINTENANCE_AUTHORIZED !== "true" ||
    !process.env.CEREMONY_DATABASE_URL ||
    !pathOrTenant
  )
    throw new Error();
  if (
    ![
      "backup",
      "restore",
      "rotate",
      "purge-collections",
      "delete-demonstration",
    ].includes(action ?? "")
  )
    throw new Error();
  const store = new PostgresCeremonyStore(
    { connectionString: process.env.CEREMONY_DATABASE_URL },
    configuredKeyring(process.env),
  );
  try {
    await store.migrate();
    if (action === "backup")
      await writeFile(
        pathOrTenant,
        JSON.stringify(await store.encryptedBackup()),
        { mode: 0o600, flag: "wx" },
      );
    if (action === "restore") {
      if ((await stat(pathOrTenant)).size > 24_000_000) throw new Error();
      await store.restoreEncryptedBackup(
        JSON.parse(await readFile(pathOrTenant, "utf8")),
      );
    }
    if (action === "rotate") await rotateTenant(store, pathOrTenant);
    if (action === "purge-collections") {
      const broker = new AsyncPrivateCollectionBroker(store);
      let after = "";
      for (;;) {
        const page = await broker.purgeExpired(pathOrTenant, 100, after);
        if (!page.lastId) break;
        after = page.lastId;
      }
    }
    if (action === "delete-demonstration") {
      if (!id) throw new Error();
      await retainWithoutDemonstration(store, pathOrTenant, id);
    }
    process.stdout.write("Persistence maintenance completed\n");
  } finally {
    await store.close();
  }
}
main().catch(() => {
  process.stderr.write(
    "Persistence maintenance refused; check authorization, protected configuration, limits and offline/empty database requirements\n",
  );
  process.exitCode = 1;
});
