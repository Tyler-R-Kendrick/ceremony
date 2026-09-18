import { chown, mkdtemp, rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import EmbeddedPostgres from "embedded-postgres";

/**
 * PostgreSQL refuses to run its server as root and drops to an unprivileged
 * account, so in a container whose tests run as root the fixture's own
 * temporary directory — created 0700 and owned by root — is one the server
 * cannot read. That surfaces as an opaque "could not access directory" and
 * looks like a missing native library.
 *
 * Handing the directory to the account the server will actually run as is the
 * ordinary requirement for a PostgreSQL data directory, not a relaxation: the
 * directory stays private, it simply belongs to its owner.
 */
async function grantDataDirectory(directory: string): Promise<void> {
  if (process.getuid?.() !== 0) return;
  let passwd: string;
  try {
    passwd = await readFile("/etc/passwd", "utf8");
  } catch {
    return;
  }
  const entry = passwd
    .split("\n")
    .map((line) => line.split(":"))
    .find((fields) => fields[0] === "postgres");
  const uid = Number(entry?.[2]);
  const gid = Number(entry?.[3]);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) return;
  await chown(directory, uid, gid);
}

/** Actual isolated PostgreSQL server, never a production URL or a fake SQL implementation. */
export async function postgresFixture() {
  const directory = await mkdtemp(join(tmpdir(), "ceremony-postgres-"));
  await grantDataDirectory(directory);
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
