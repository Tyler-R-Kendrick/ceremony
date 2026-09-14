import { z } from "zod";
import {
  actionsFor,
  manifestSchema,
  snapshotSchema,
  type CeremonySnapshot,
  type CeremonyTransport,
  type Field,
} from "../src/core/schema.js";
import {
  connections,
  derive,
  digest,
  digits,
  hex,
  matches,
  passphrase,
  randomBytes,
  type Handback,
} from "./gallery-secrets.js";

/**
 * Registration: the ceremony this project exists for, running for real.
 *
 * Every other flow on this page presumes an account. This one makes it. An
 * address the store has never seen becomes an account; an address it has seen
 * signs in; a wrong password is refused; and either way the address has to be
 * confirmed with a code that arrived somewhere else before anything is issued.
 *
 * It is not a re-enactment. The password is stretched with PBKDF2-SHA256 in
 * this browser and the derived value is what the store receives — the password
 * itself is never sent anywhere and is not recoverable from what is kept. The
 * code is drawn from the platform's CSPRNG, stored only as a derived value with
 * an expiry, and compared without branching on its content. What completion
 * issues is a real session token and a real recovery code, both of which the
 * account record then holds in derived form, so a value that was handed over
 * once is genuinely the only copy.
 *
 * Two honest limits, both stated on the page rather than here alone. There is
 * no mail server on a published page, so the code is delivered to a mailbox on
 * this page instead of an inbox — the step is real, the courier is not. And the
 * artifact store is shared by everyone who can open the page, so it is a
 * demonstration store: it holds no addresses and no secrets, only derived
 * values, and the page says to use a password you use nowhere else.
 */

/** Where accounts live. Anything satisfying this can back the ceremony. */
export interface AccountStore {
  /** The kind of store this is, in a person's words, for the page to show. */
  readonly label: string;
  read(id: string): Promise<Record<string, unknown> | undefined>;
  write(id: string, document: Record<string, unknown>): Promise<void>;
}

/** A store for a view that has none. The ceremony still runs; nothing outlives the tab. */
export function memoryStore(label: string): AccountStore {
  const held = new Map<string, Record<string, unknown>>();
  return {
    label,
    read: async (id) => held.get(id),
    write: async (id, document) => void held.set(id, document),
  };
}

const derivedSchema = z.object({
  salt: z.string().min(1),
  hash: z.string().min(1),
  iterations: z.number().int().positive(),
});

/**
 * An account, as the shared store holds it.
 *
 * Read what is absent: there is no address here, and no secret. The document is
 * keyed by a digest of the address, so the store cannot be read as a list of
 * who has registered, and every credential appears only as something derived
 * from it.
 */
const accountSchema = z.object({
  version: z.literal(1),
  password: derivedSchema,
  verified: z.boolean(),
  pending: derivedSchema.extend({ expiresAt: z.number() }).optional(),
  recovery: derivedSchema.optional(),
  session: derivedSchema.extend({ expiresAt: z.number() }).optional(),
  createdAt: z.string(),
});
type Account = z.infer<typeof accountSchema>;

const PASSWORD_ITERATIONS = 210_000;
const CODE_ITERATIONS = 100_000;
const CODE_MINUTES = 10;
const SESSION_HOURS = 12;
const ATTEMPT_MINUTES = 20;
const MINIMUM_PASSWORD = 10;

export const registrationManifest = manifestSchema.parse({
  id: "account",
  name: "Your account",
  description:
    "An email address and a password. If the address has never been here, this registers it; if it has, this signs in. Either way the address is confirmed with a code before anything is issued.",
  methods: [
    {
      id: "email-password",
      label: "Register or sign in · email and password",
      kind: "form",
      fields: [
        {
          name: "email",
          label: "Email address",
          type: "email",
          required: true,
          classification: "personal",
        },
        {
          name: "password",
          label: "Password",
          type: "password",
          required: true,
          classification: "secret",
        },
      ],
      scopes: ["account.read", "account.session"],
      templateId: "form",
    },
  ],
});

const codeField: Field[] = [
  {
    name: "verificationCode",
    label: "Six-digit code",
    type: "text",
    required: true,
    classification: "secret",
  },
];

/** One delivery, as the page's mailbox shows it. */
export interface Delivery {
  to: string;
  code: string;
  at: string;
  reason: "registration" | "confirmation";
  expiresAt: number;
}

export interface RegistrationOptions {
  store: AccountStore;
  deliver(delivery: Delivery): void;
  onHandback(handback: (Handback & { registered: boolean }) | undefined): void;
}

const accountKey = (email: string) =>
  digest(`ceremony/account/${email.trim().toLowerCase()}`);

const address = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Only what the store may hold: `undefined` is dropped, not written as null. */
const persistable = (account: Account): Record<string, unknown> =>
  JSON.parse(JSON.stringify(account)) as Record<string, unknown>;

export function createRegistrationTransport({
  store,
  deliver,
  onHandback,
}: RegistrationOptions): CeremonyTransport {
  const method = registrationManifest.methods[0]!;
  const credentials = [...method.fields];
  const id = globalThis.crypto.randomUUID();
  let revision = 0;
  let current: CeremonySnapshot | undefined;
  /** Set once a code is outstanding, so `submit` knows which form answered it. */
  let awaiting:
    { account: string; email: string; registered: boolean } | undefined;

  const at = (
    step: CeremonySnapshot["step"],
    extra: Partial<CeremonySnapshot> = {},
  ): CeremonySnapshot => {
    revision += 1;
    current = snapshotSchema.parse({
      id,
      revision,
      connectorId: registrationManifest.id,
      connectorName: registrationManifest.name,
      description: registrationManifest.description,
      method,
      step,
      fields: [],
      actions: actionsFor(step),
      expiresAt: Date.now() + ATTEMPT_MINUTES * 60_000,
      ...extra,
    });
    return current;
  };

  const load = async (key: string): Promise<Account | undefined> => {
    const raw = await store.read(key);
    if (!raw) return undefined;
    const parsed = accountSchema.safeParse(raw);
    // A document this page cannot read is treated as absent rather than as a
    // reason to stop: a shared store can hold anything, and refusing to let
    // somebody register because of a stranger's malformed row would be worse.
    return parsed.success ? parsed.data : undefined;
  };

  const sendCode = async (
    key: string,
    account: Account,
    email: string,
    reason: Delivery["reason"],
  ): Promise<void> => {
    const code = digits(6);
    const salt = hex(randomBytes(16));
    const expiresAt = Date.now() + CODE_MINUTES * 60_000;
    await store.write(
      key,
      persistable({
        ...account,
        pending: {
          salt,
          hash: await derive(code, salt, CODE_ITERATIONS),
          iterations: CODE_ITERATIONS,
          expiresAt,
        },
      }),
    );
    deliver({
      to: email,
      code,
      at: new Date().toISOString(),
      reason,
      expiresAt,
    });
  };

  const finish = async (
    key: string,
    email: string,
    account: Account,
    registered: boolean,
  ): Promise<CeremonySnapshot> => {
    const token = hex(randomBytes(32));
    const recovery = passphrase();
    const tokenSalt = hex(randomBytes(16));
    const recoverySalt = hex(randomBytes(16));
    const settled: Account = {
      ...account,
      verified: true,
      recovery: {
        salt: recoverySalt,
        hash: await derive(recovery, recoverySalt, CODE_ITERATIONS),
        iterations: CODE_ITERATIONS,
      },
      session: {
        salt: tokenSalt,
        hash: await derive(token, tokenSalt, CODE_ITERATIONS),
        iterations: CODE_ITERATIONS,
        expiresAt: Date.now() + SESSION_HOURS * 3_600_000,
      },
    };
    delete settled.pending;
    await store.write(key, persistable(settled));
    const handback = await connections.issue(
      {
        connectorId: registrationManifest.id,
        connectorName: registrationManifest.name,
        scopes: [...method.scopes],
        reference: key.slice(0, 16),
      },
      [
        {
          name: "sessionToken",
          label: "Session token",
          value: token,
          note: `Authenticates as this account for ${SESSION_HOURS} hours. The account record holds a derived form of it, so this is the only copy.`,
          secret: true,
        },
        {
          name: "recoveryCode",
          label: "Recovery code",
          value: recovery,
          note: "Shown once, on purpose. Keep it somewhere you would keep a key — nothing on this page can print it again.",
          secret: true,
        },
      ],
    );
    onHandback({ ...handback, registered });
    awaiting = undefined;
    return at("complete", {
      message: registered
        ? `${email} is registered and confirmed.`
        : `Signed in as ${email}.`,
      outcome: {
        connectionRef: key,
        ownership: "authenticated" as const,
        scopes: [...method.scopes],
        secretRef: handback.record.secretRef,
      },
    });
  };

  const identify = async (
    values: Record<string, string>,
  ): Promise<CeremonySnapshot> => {
    const email = (values.email ?? "").trim().toLowerCase();
    const password = values.password ?? "";
    const again = (message: string) =>
      at("input", { fields: credentials, message });
    if (!address.test(email))
      return again("That is not an email address this page can use.");
    if (password.length < MINIMUM_PASSWORD)
      return again(
        `Use at least ${MINIMUM_PASSWORD} characters — and a password you use nowhere else, because this is a demonstration store.`,
      );
    const key = await accountKey(email);
    const existing = await load(key);
    if (!existing) {
      const salt = hex(randomBytes(16));
      const account: Account = {
        version: 1,
        password: {
          salt,
          hash: await derive(password, salt, PASSWORD_ITERATIONS),
          iterations: PASSWORD_ITERATIONS,
        },
        verified: false,
        createdAt: new Date().toISOString(),
      };
      await store.write(key, persistable(account));
      await sendCode(key, account, email, "registration");
      awaiting = { account: key, email, registered: true };
      return at("input", {
        fields: codeField,
        message: `No account existed for ${email}, so one was created. Confirm the address with the code in the mailbox below.`,
      });
    }
    const attempt = await derive(
      password,
      existing.password.salt,
      existing.password.iterations,
    );
    if (!matches(attempt, existing.password.hash))
      return at("error", {
        message: `${email} is already registered, and that is not its password.`,
      });
    if (!existing.verified) {
      await sendCode(key, existing, email, "confirmation");
      awaiting = { account: key, email, registered: false };
      return at("input", {
        fields: codeField,
        message: `${email} was registered but never confirmed. A new code is in the mailbox below.`,
      });
    }
    await sendCode(key, existing, email, "confirmation");
    awaiting = { account: key, email, registered: false };
    return at("input", {
      fields: codeField,
      message: `Welcome back. Confirm it is you with the code in the mailbox below.`,
    });
  };

  const confirm = async (
    values: Record<string, string>,
  ): Promise<CeremonySnapshot> => {
    const pending = awaiting;
    if (!pending)
      return at("error", { message: "No code is outstanding. Start again." });
    const account = await load(pending.account);
    if (!account?.pending)
      return at("error", {
        message: "That code is no longer expected. Start again.",
      });
    if (account.pending.expiresAt < Date.now()) {
      awaiting = undefined;
      return at("expired", {
        message: `The code for ${pending.email} expired. Start again to be sent another.`,
      });
    }
    const code = (values.verificationCode ?? "").trim();
    const attempt = await derive(
      code,
      account.pending.salt,
      account.pending.iterations,
    );
    if (!matches(attempt, account.pending.hash))
      return at("input", {
        fields: codeField,
        message: "That is not the code in the mailbox. Try it again.",
      });
    return finish(pending.account, pending.email, account, pending.registered);
  };

  return {
    start: async () => at("intro"),
    read: async () => current ?? at("intro"),
    act: async (_id, action) => {
      if (current && action.revision !== current.revision)
        throw new Error("This attempt moved on. Re-read it and try again.");
      if (current && !current.actions.includes(action.action))
        throw new Error(`${action.action} is not available on this screen.`);
      if (action.action === "begin")
        return at("input", {
          fields: credentials,
          message:
            "An address and a password. If the address is new here it becomes an account; if it is not, this signs in.",
        });
      if (action.action === "submit")
        try {
          return await (awaiting
            ? confirm(action.values)
            : identify(action.values));
        } catch (error) {
          // The store is the one thing here that belongs to somebody else: a
          // viewer can decline it, a view can be served without it, and it can
          // simply fail. None of those is a reason to show a stack trace under
          // a form somebody just filled in, and every one of them leaves the
          // attempt exactly where it was — so the screen says what happened and
          // keeps the retry that starts it again.
          awaiting = undefined;
          return at("error", {
            message: `Accounts could not be reached just now, so nothing was registered and nothing was signed in. ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
      if (action.action === "cancel") {
        awaiting = undefined;
        onHandback(undefined);
        return at("cancelled");
      }
      if (action.action === "retry") {
        awaiting = undefined;
        onHandback(undefined);
        return at("intro");
      }
      throw new Error(`${action.action} is not available here.`);
    },
  };
}
