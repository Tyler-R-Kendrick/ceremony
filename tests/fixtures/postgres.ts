import { chown, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import EmbeddedPostgres from "embedded-postgres";

/**
 * PostgreSQL refuses to run as uid 0. In a root container (CI images, remote
 * agents) the platform binaries are started under a dedicated non-root
 * `postgres` account with the data and socket directories owned by it, which
 * is the ownership PostgreSQL itself requires. Nothing is skipped either way.
 */
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
async function postgresAccount(): Promise<{ uid: number; gid: number }> {
  const run = promisify(execFile);
  const [uid, gid] = await Promise.all([
    run("id", ["-u", "postgres"]),
    run("id", ["-g", "postgres"]),
  ]);
  return { uid: Number(uid.stdout.trim()), gid: Number(gid.stdout.trim()) };
}

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
    // Only when root: the library creates/uses the `postgres` account and
    // chowns the data directory before spawning initdb/postgres under it.
    createPostgresUser: asRoot,
    onLog: () => {},
    onError: () => {},
  });
  try {
    if (asRoot) {
      // The data directory is created inside this root-owned 0700 directory
      // and the Unix socket lives in it, so the whole tree must belong to the
      // database account before initdb runs; the library chowns only `db`.
      const account = await postgresAccount();
      await chown(directory, account.uid, account.gid);
    }
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
