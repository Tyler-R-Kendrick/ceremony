import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import EmbeddedPostgres from "embedded-postgres";

/** Actual isolated PostgreSQL server, never a production URL or a fake SQL implementation. */
export async function postgresFixture() {
  const directory = await mkdtemp(join(tmpdir(), "ceremony-postgres-"));
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture port unavailable");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  const password = randomBytes(24).toString("hex");
  const server = new EmbeddedPostgres({
    databaseDir: join(directory, "db"),
    port,
    user: "ceremony",
    password,
    persistent: true,
    authMethod: "scram-sha-256",
    postgresFlags: ["-h", "127.0.0.1", "-k", directory],
    onLog: () => {},
    onError: () => {},
  });
  try {
    await server.initialise();
    await server.start();
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new Error(
      "Local PostgreSQL fixture could not start; verify the installed platform package's native libraries and reviewed symlink hydration (see docs/testing.md). No database tests were skipped.",
    );
  }
  return {
    config: {
      host: "127.0.0.1",
      port,
      user: "ceremony",
      password,
      database: "postgres",
    },
    async close() {
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
