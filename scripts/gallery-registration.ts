import { z } from "zod";
import {
  actionsFor,
  snapshotSchema,
  type CeremonySnapshot,
  type CeremonyTransport,
  type Field,
} from "../src/core/schema.js";
import type { AccountProvider } from "./gallery-accounts.js";
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
  type Issued,
} from "./gallery-secrets.js";

/**
 * Registration, in the order a provider actually asks.
 *
 * The identifier comes first and it comes alone. What follows is whatever that
 * provider declared it needs — and for three of the four accounts on this page
 * that is never a password typed by a person: one mints its own, and two have
 * the provider issue the credential in its own surface. A ceremony that opened
 * with an address and a password side by side was asserting that every provider
 * wants a password, which is false for single sign-on, for a passkey, for a
 * magic link, and for every provider that issues credentials rather than
 * accepting them.
 *
 * Where a password is genuinely required and may be minted, it is minted: 20
 * characters from the platform's CSPRNG, generated in this browser, handed back
 * in a masked field, and never typed anywhere something could read it. A person
 * who wants to choose their own still can — the field is there, and leaving it
 * blank is what asks for a generated one.
 *
 * The rest holds as it did. The password is stretched with PBKDF2-SHA256 here
 * and only the derived value is stored; the record is keyed by a digest of the
 * address, so the store holds no addresses and no secrets; the confirmation
 * code is kept in derived form behind an expiry and compared without branching
 * on its content.
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

/** Long enough that its strength never depends on the provider's rules. */
const MINTED_LENGTH = 20;

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

export interface AccountOptions {
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

/** A credential nobody had to invent, drawn from the platform's own randomness. */
export function mintPassword(length = MINTED_LENGTH): string {
  // Ambiguous glyphs left out on purpose: this is read off a screen and typed
  // into a provider at least once, and l/I/1 and O/0 is where that goes wrong.
  const alphabet =
    "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_";
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length)
    for (const byte of randomBytes(length * 2)) {
      if (byte >= limit) continue;
      out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  return out;
}

export function createAccountTransport(
  provider: AccountProvider,
  { store, deliver, onHandback }: AccountOptions,
): CeremonyTransport {
  const method = provider.manifest.methods[0]!;
  const id = globalThis.crypto.randomUUID();
  const signature = provider.registration;
  let revision = 0;
  let current: CeremonySnapshot | undefined;
  /** What the identifier step established, carried into the steps after it. */
  let identified:
    { account: string; email: string; registering: boolean } | undefined;
  /**
   * How far through a provider's own surface this has got.
   *
   * Two handoffs, not one, because they are two errands at two addresses: the
   * account is made on one page and the credential is issued on another, and a
   * single screen naming both leaves somebody holding a token with nowhere to
   * put it. The collector is a third screen because the library will not put a
   * credential field on a screen whose purpose is to send somebody away, and it
   * is right not to.
   */
  let stage: "signup" | "issue" | "collect" | undefined;
  /** Set once a code is outstanding, so `submit` knows which form answered it. */
  let awaitingCode = false;
  /** Set once a password has been settled, so `submit` knows to expect a code. */
  let settledPassword: string | undefined;
  /** Whether that password was generated here. Only a minted one is handed back:
   * one somebody chose is already theirs, and reprinting it would be theatre. */
  let mintedPassword = false;

  const at = (
    step: CeremonySnapshot["step"],
    extra: Partial<CeremonySnapshot> = {},
  ): CeremonySnapshot => {
    revision += 1;
    current = snapshotSchema.parse({
      id,
      revision,
      connectorId: provider.manifest.id,
      connectorName: provider.manifest.name,
      description: provider.manifest.description,
      method,
      step,
      fields: [],
      actions: actionsFor(step),
      expiresAt: Date.now() + ATTEMPT_MINUTES * 60_000,
      ...extra,
    });
    return current;
  };

  const identityStep = (message: string) =>
    at("input", { fields: provider.identity, message });

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

  const hand = async (
    extra: readonly Issued[],
    reference: string,
    registered: boolean,
    message: string,
  ): Promise<CeremonySnapshot> => {
    const handback = await connections.issue(
      {
        connectorId: provider.manifest.id,
        connectorName: provider.manifest.name,
        scopes: [...method.scopes],
        reference,
      },
      extra,
    );
    onHandback({ ...handback, registered });
    identified = undefined;
    awaitingCode = false;
    settledPassword = undefined;
    mintedPassword = false;
    stage = undefined;
    return at("complete", {
      message,
      outcome: {
        connectionRef: reference,
        ownership: "authenticated" as const,
        scopes: [...method.scopes],
        secretRef: handback.record.secretRef,
      },
    });
  };

  /** The account is made here, so this ceremony holds everything it issued. */
  const finishOwn = async (
    key: string,
    email: string,
    account: Account,
    password: string,
    minted: boolean,
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
    return hand(
      [
        ...(minted
          ? [
              {
                name: "password",
                label: "Password",
                value: password,
                note: "Generated here a moment ago, never typed and never sent to an assistant. It is the account's password now, so keep it before you close this.",
                secret: true,
              } satisfies Issued,
            ]
          : []),
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
      key.slice(0, 16),
      registered,
      registered
        ? `${email} is registered and confirmed.`
        : `Signed in as ${email}.`,
    );
  };

  /** Step one, for every provider: name the account, and nothing else. */
  const identify = async (
    values: Record<string, string>,
  ): Promise<CeremonySnapshot> => {
    const email = (values.email ?? "").trim().toLowerCase();
    if (!address.test(email))
      return identityStep("That is not an email address this page can use.");

    if (signature.createdBy === "provider-browser") {
      identified = { account: "", email, registering: true };
      stage = "signup";
      return at("redirect", {
        actions: ["submit", "cancel"],
        authorizationUrl: provider.signup!({ email }),
        message: `${provider.manifest.name} makes the account, so that is where this goes — the link carries ${email}, so nobody types it twice. Come back and press Continue once the account exists.`,
      });
    }

    const key = await accountKey(email);
    const existing = await load(key);
    identified = { account: key, email, registering: !existing };
    if (!existing)
      return at("input", {
        // Not required, and that is the whole point: leaving it blank is how a
        // person asks for one they never have to think of.
        fields: [
          {
            name: "password",
            label: "Password (leave blank to have one generated)",
            type: "password",
            required: false,
            classification: "secret",
          },
        ],
        message: `No account exists for ${email}, so this will make one. Leave the field blank and a ${MINTED_LENGTH}-character password is generated here and handed to you — it is never typed, and no assistant ever sees it. Type your own only if you would rather.`,
      });
    return at("input", {
      fields: [
        {
          name: "password",
          label: "Password",
          type: "password",
          required: true,
          classification: "secret",
        },
      ],
      message: `${email} is already registered. Its password is the one it was given when it was made — nothing here can mint a new one for an account that already exists.`,
    });
  };

  /** Step two, where a password is what the provider wants. */
  const settlePassword = async (
    values: Record<string, string>,
  ): Promise<CeremonySnapshot> => {
    const who = identified!;
    const supplied = values.password ?? "";
    const existing = await load(who.account);
    if (!existing) {
      const minted = supplied.length === 0;
      const password = minted ? mintPassword() : supplied;
      if (!minted && password.length < MINIMUM_PASSWORD)
        return at("input", {
          fields: current!.fields,
          message: `Use at least ${MINIMUM_PASSWORD} characters — or leave it blank and one will be generated that is longer and stronger than anything worth typing.`,
        });
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
      await store.write(who.account, persistable(account));
      await sendCode(who.account, account, who.email, "registration");
      settledPassword = password;
      mintedPassword = minted;
      awaitingCode = true;
      return at("input", {
        fields: codeField,
        message: minted
          ? `The account is made and its password was generated for you — you will get it, in a masked field, once the address is confirmed. The code is in the mailbox.`
          : `The account is made. Confirm the address with the code in the mailbox.`,
      });
    }
    const attempt = await derive(
      supplied,
      existing.password.salt,
      existing.password.iterations,
    );
    if (!matches(attempt, existing.password.hash))
      return at("error", {
        message: `${who.email} is already registered, and that is not its password.`,
      });
    await sendCode(who.account, existing, who.email, "confirmation");
    settledPassword = supplied;
    mintedPassword = false;
    awaitingCode = true;
    return at("input", {
      fields: codeField,
      message: `Welcome back. Confirm it is you with the code in the mailbox.`,
    });
  };

  const confirm = async (
    values: Record<string, string>,
  ): Promise<CeremonySnapshot> => {
    const who = identified!;
    const account = await load(who.account);
    if (!account?.pending)
      return at("error", {
        message: "That code is no longer expected. Start again.",
      });
    if (account.pending.expiresAt < Date.now()) {
      identified = undefined;
      awaitingCode = false;
      return at("expired", {
        message: `The code for ${who.email} expired. Start again to be sent another.`,
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
    return finishOwn(
      who.account,
      who.email,
      account,
      settledPassword ?? "",
      mintedPassword,
      who.registering,
    );
  };

  /** The second handoff: the provider's own page for issuing what it will accept. */
  const issueStep = (): CeremonySnapshot => {
    const issuing = provider.issuing!;
    stage = "issue";
    return at("redirect", {
      actions: ["submit", "cancel"],
      authorizationUrl: issuing.url,
      message: `${issuing.label}. ${issuing.note} Then press Continue and bring it back here.`,
    });
  };

  const collectStep = (message: string): CeremonySnapshot => {
    stage = "collect";
    return at("input", { fields: [provider.credential!], message });
  };

  /** Step three, where the provider issued the credential and a person brings it back. */
  const accept = async (
    values: Record<string, string>,
  ): Promise<CeremonySnapshot> => {
    const who = identified!;
    const token = (values.token ?? "").trim();
    const complaint = provider.shape!.check(token);
    if (complaint) return collectStep(`${complaint} ${provider.shape!.hint}`);
    return hand(
      [
        {
          name: "token",
          label: provider.credential!.label,
          value: token,
          note: `Issued by ${provider.manifest.name}, not by this page. It stays in this tab: the store never receives it, no assistant ever sees it, and closing the tab is what ends it.`,
          secret: true,
        },
      ],
      `${provider.manifest.id}:${(await digest(who.email)).slice(0, 16)}`,
      true,
      provider.completion,
    );
  };

  /**
   * The first screen is the first question, not a screen about the question.
   *
   * The card that started this already carried the provider's name, what it is
   * about to do, and what it will be able to do afterwards — which is every
   * word an intro screen would have held. Rendering one anyway meant pressing
   * Connect and being shown a button saying Connect.
   */
  const opening = () =>
    identityStep(
      signature.createdBy === "provider-browser"
        ? `The address the ${provider.manifest.name} account will be under. It is carried into ${provider.manifest.name}'s own registration page, so nobody types it twice.`
        : "The address the account will be under. Nothing else yet — what comes after depends on what this provider asks for.",
    );

  return {
    start: async () => opening(),
    read: async () => current ?? opening(),
    act: async (_id, action) => {
      if (current && action.revision !== current.revision)
        throw new Error("This attempt moved on. Re-read it and try again.");
      if (current && !current.actions.includes(action.action))
        throw new Error(`${action.action} is not available on this screen.`);
      const reset = () => {
        identified = undefined;
        awaitingCode = false;
        settledPassword = undefined;
        mintedPassword = false;
        stage = undefined;
        onHandback(undefined);
      };
      if (action.action === "submit")
        try {
          if (!identified) return await identify(action.values);
          if (signature.secret === "issued-token") {
            if (stage === "signup") return issueStep();
            if (stage === "issue")
              return collectStep(
                `Paste what ${provider.manifest.name} issued. ${provider.shape!.hint} It stays in this tab: the store never receives it and no assistant ever sees it.`,
              );
            return await accept(action.values);
          }
          if (awaitingCode) return await confirm(action.values);
          return await settlePassword(action.values);
        } catch (error) {
          // The store is the one thing here that belongs to somebody else: a
          // viewer can decline it, a view can be served without it, and it can
          // simply fail. None of those is a reason to show a stack trace under
          // a form somebody just filled in, and every one of them leaves the
          // attempt exactly where it was — so the screen says what happened and
          // keeps the retry that starts it again.
          identified = undefined;
          awaitingCode = false;
          settledPassword = undefined;
          mintedPassword = false;
          stage = undefined;
          return at("error", {
            message: `Accounts could not be reached just now, so nothing was registered and nothing was signed in. ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
      if (action.action === "cancel") {
        reset();
        return at("cancelled");
      }
      if (action.action === "retry") {
        reset();
        return opening();
      }
      throw new Error(`${action.action} is not available here.`);
    },
  };
}
