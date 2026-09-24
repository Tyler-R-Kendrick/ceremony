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

/** A port nothing is listening on at the moment of asking; see `postgresFixture`. */
async function unusedPort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture port unavailable");
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

/** What PostgreSQL logs when another socket already holds its port. */
const portTaken =
  /could not bind IPv[46] address "[^"]*": Address already in use/;

/** Attempts at starting the server, each on a fresh port. */
const startAttempts = 4;

/** Actual isolated PostgreSQL server, never a production URL or a fake SQL implementation. */
export async function postgresFixture() {
  const directory = await mkdtemp(join(tmpdir(), "ceremony-postgres-"));
  await grantDataDirectory(directory);
  const password = randomBytes(24).toString("hex");
  // Only a start's own output is kept, to be read if that start fails. Once
  // the server is up it logs for as long as the tests run, and none of that is
  // wanted here.
  let log = "";
  let starting = false;
  const serverOn = (port: number) =>
    new EmbeddedPostgres({
      databaseDir: join(directory, "db"),
      port,
      user: "ceremony",
      password,
      persistent: true,
      authMethod: "scram-sha-256",
      postgresFlags: ["-h", "127.0.0.1", "-k", directory],
      onLog: (message) => {
        if (starting) log += String(message);
      },
      onError: () => {},
    });
  /*
   * The port is picked by asking the OS for an unused one and then letting it
   * go, and PostgreSQL binds it only later, in `start()`, after `initdb` has
   * run for a second or more. Anything else on the machine that binds or
   * connects in that gap can be given the same port: a parallel test file's
   * listener, or an outbound connection's local port, which comes from the
   * same ephemeral range. PostgreSQL then exits with "could not bind" and
   * `start()` rejects with nothing at all. No port can be reserved across
   * that gap and handed over, so the gap is closed from the other side: a
   * start refused because the port was taken is tried again on a fresh one.
   * `initdb` never uses the port, so the cluster is initialised once. Any
   * other failure, or a port taken every time, still fails the fixture.
   */
  let port = await unusedPort();
  let server = serverOn(port);
  try {
    await server.initialise();
    for (let attempt = 1; ; attempt++) {
      log = "";
      starting = true;
      try {
        await server.start();
        break;
      } catch (error) {
        if (attempt === startAttempts || !portTaken.test(log)) throw error;
      } finally {
        starting = false;
      }
      port = await unusedPort();
      server = serverOn(port);
    }
    log = "";
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
