import { createRequire as __wkfCreateRequire } from "node:module";
if (typeof globalThis.require === "undefined") globalThis.require = __wkfCreateRequire(import.meta.url);
import { __exportAll } from "../_runtime.mjs";
import { _enum, _null, array, boolean, createGateway, discriminatedUnion, literal, number, object, record, strictObject, string, tool, union, url, uuid } from "../_libs/@ai-sdk/gateway+[...].mjs";
import { datetime, number as number$1 } from "../_libs/modelcontextprotocol__core+zod.mjs";
import { ClientSecretPost, None, allowInsecureRequests, authorizationCodeGrantRequest, calculatePKCECodeChallenge, discoveryRequest, dynamicClientRegistrationRequest, generateRandomCodeVerifier, generateRandomNonce, generateRandomState, getValidatedIdTokenClaims, processAuthorizationCodeResponse, processDiscoveryResponse, processDynamicClientRegistrationResponse, validateApplicationLevelSignature, validateAuthResponse } from "../_libs/oauth4webapi.mjs";
import { Pool } from "../_libs/pg+[...].mjs";
import { ToolLoopAgent, isStepCount } from "../_libs/ai.mjs";
import { createOpenAICompatible } from "../_libs/ai-sdk__openai-compatible.mjs";
import { createAppAuth, request } from "../_libs/@octokit/auth-app+[...].mjs";
import { Stripe } from "../_libs/stripe.mjs";
import { resumeHook } from "../_libs/@workflow/core+[...].mjs";
import "../_libs/workflow.mjs";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import "node:timers/promises";
import { parseEnv } from "node:util";
//#region src/core/operation-contracts.ts
const identifierSchema = string().regex(/^[a-zA-Z][a-zA-Z0-9_.:-]{0,95}$/).refine((value) => ![
	"__proto__",
	"prototype",
	"constructor"
].includes(value));
const semanticVersionSchema = string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
const fieldClassificationSchema = _enum([
	"public",
	"personal",
	"secret",
	"artifact",
	"unclassified"
]);
/** This is a reference into host-owned vocabulary, never a caller-defined schema. */
const registeredInputContractSchema = object({
	contract: identifierSchema,
	required: boolean()
}).strict();
const publicValueSchema = union([
	string().max(512),
	number().finite(),
	boolean(),
	_null()
]);
const operationContractSchema = object({
	id: identifierSchema,
	version: semanticVersionSchema,
	provider: identifierSchema,
	profile: identifierSchema,
	inputs: record(identifierSchema, registeredInputContractSchema),
	outputs: record(identifierSchema, registeredInputContractSchema),
	effects: array(identifierSchema).max(16),
	verifier: identifierSchema,
	humanFallback: identifierSchema
}).strict();
/** Parsing this shape does not authenticate it. Only a trusted host identity adapter may derive it. */
const actorIdentifierSchema = string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/);
const actorContextSchema = object({
	tenantId: actorIdentifierSchema,
	subjectId: actorIdentifierSchema,
	sessionId: actorIdentifierSchema,
	actorKind: _enum([
		"human",
		"agent",
		"system"
	]),
	capabilities: array(_enum([
		"author",
		"reviewer",
		"publisher",
		"executor",
		"admin"
	])).max(5),
	delegationId: actorIdentifierSchema.optional()
}).strict();
//#endregion
//#region src/server/identity.ts
var AuthorizationError = class extends Error {
	code;
	constructor(code) {
		super(code);
		this.code = code;
	}
};
async function authenticatedActor(request, identity) {
	const actor = await identity.authenticate(request);
	if (!actor) throw new AuthorizationError("unauthenticated");
	return actorContextSchema.parse(actor);
}
function requireCapability(actor, capability) {
	if (!actor.capabilities.includes(capability) && !actor.capabilities.includes("admin")) throw new AuthorizationError("denied");
}
//#endregion
//#region src/server/persistence/index.ts
const recordKinds = [
	"run",
	"node",
	"collection",
	"recipe",
	"draft",
	"review",
	"command",
	"effect",
	"evidence",
	"artifact",
	"handoff",
	"demonstration",
	"event",
	"outbox",
	"continuation",
	"budget",
	"session",
	"audit"
];
const backupKey = string().regex(/^[a-zA-Z0-9_.:@/-]{1,200}$/);
const encryptedBackupSchema = strictObject({
	schemaVersion: literal(1),
	records: array(strictObject({
		tenant: backupKey,
		kind: _enum(recordKinds),
		id: backupKey,
		revision: number().int().positive().max(Number.MAX_SAFE_INTEGER),
		value: string().max(2e6).regex(/^[A-Za-z0-9+/]+={0,2}$/)
	})).max(1e4),
	claims: array(strictObject({
		tenant: backupKey,
		kind: _enum(recordKinds),
		id: backupKey,
		generation: number().int().positive().max(Number.MAX_SAFE_INTEGER - 1)
	})).max(1e4)
});
var PersistenceConflict = class extends Error {
	constructor() {
		super("Persistence revision or fencing conflict");
	}
};
const migration = `CREATE TABLE IF NOT EXISTS ceremony_records (
 tenant TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
 revision BIGINT NOT NULL, value BYTEA NOT NULL, PRIMARY KEY(tenant,kind,id));
 CREATE TABLE IF NOT EXISTS ceremony_claims (
 tenant TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
 generation BIGINT NOT NULL, worker TEXT NOT NULL, expires BIGINT NOT NULL,
 PRIMARY KEY(tenant,kind,id));`;
function parameters(key) {
	if (!recordKinds.includes(key.kind) || ![key.tenant, key.id].every((v) => typeof v === "string" && /^[a-zA-Z0-9_.:@/-]{1,200}$/.test(v))) throw new Error("Invalid persistence key");
	return [
		key.tenant,
		key.kind,
		key.id
	];
}
function validateKeys(keyring) {
	if (!Object.hasOwn(keyring.keys, keyring.current) || !Object.entries(keyring.keys).every(([id, key]) => /^[a-zA-Z0-9_-]{1,64}$/.test(id) && key.byteLength === 32)) throw new Error("Invalid encryption key configuration");
}
function seal(key, revision, value, keyring) {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", keyring.keys[keyring.current], iv);
	cipher.setAAD(Buffer.from(JSON.stringify([
		...parameters(key),
		revision,
		keyring.current
	])));
	const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
	return Buffer.from(JSON.stringify({
		key: keyring.current,
		iv: iv.toString("base64"),
		tag: cipher.getAuthTag().toString("base64"),
		data: ciphertext.toString("base64")
	}));
}
function open(key, revision, value, keyring) {
	try {
		if (!(value instanceof Uint8Array)) throw new Error();
		const envelope = JSON.parse(Buffer.from(value).toString());
		if (typeof envelope.key !== "string" || !Object.hasOwn(keyring.keys, envelope.key)) throw new Error();
		const decipher = createDecipheriv("aes-256-gcm", keyring.keys[envelope.key], Buffer.from(envelope.iv, "base64"));
		decipher.setAAD(Buffer.from(JSON.stringify([
			...parameters(key),
			revision,
			envelope.key
		])));
		decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
		return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString());
	} catch {
		throw new Error("Protected record cannot be decrypted");
	}
}
function transaction(query, postgres, keyring) {
	let active = true;
	const q = (sql, args) => {
		if (!active) throw new Error("Transaction is closed");
		return query(sql, args);
	};
	const lock = postgres ? " FOR UPDATE" : "";
	const now = async () => Number((await q(postgres ? "SELECT floor(extract(epoch from clock_timestamp()) * 1000) AS now" : "SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now"))[0].now);
	const fenceRow = async (key) => (await q(`SELECT * FROM ceremony_claims WHERE tenant=$1 AND kind=$2 AND id=$3${lock}`, parameters(key)))[0];
	const assertFence = async (fence) => {
		const row = await fenceRow(fence);
		if (!row || Number(row.generation) !== fence.generation || row.worker !== fence.worker || Number(row.expires) <= await now()) throw new PersistenceConflict();
	};
	const duration = (ms) => {
		if (!Number.isSafeInteger(ms) || ms < 1 || ms > 3e5) throw new Error("Invalid claim duration");
	};
	return {
		finish() {
			active = false;
		},
		now,
		async get(key) {
			const row = (await q(`SELECT revision,value FROM ceremony_records WHERE tenant=$1 AND kind=$2 AND id=$3${lock}`, parameters(key)))[0];
			return row ? {
				revision: Number(row.revision),
				value: open(key, Number(row.revision), row.value, keyring)
			} : void 0;
		},
		async put(key, value, expectedRevision) {
			if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) throw new Error("Invalid expected revision");
			const revision = (expectedRevision ?? 0) + 1;
			const bytes = seal(key, revision, value, keyring);
			if (!(expectedRevision === null ? await q("INSERT INTO ceremony_records(tenant,kind,id,revision,value) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING revision", [
				...parameters(key),
				revision,
				bytes
			]) : await q("UPDATE ceremony_records SET revision=$4,value=$5 WHERE tenant=$1 AND kind=$2 AND id=$3 AND revision=$6 RETURNING revision", [
				...parameters(key),
				revision,
				bytes,
				expectedRevision
			])).length) throw new PersistenceConflict();
			return revision;
		},
		async delete(key, expectedRevision) {
			if (!(await q("DELETE FROM ceremony_records WHERE tenant=$1 AND kind=$2 AND id=$3 AND revision=$4 RETURNING id", [...parameters(key), expectedRevision])).length) throw new PersistenceConflict();
		},
		async list(tenant, kind, limit = 100, afterId = "") {
			parameters({
				tenant,
				kind,
				id: "validation"
			});
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1e3) throw new Error("Invalid record limit");
			if (afterId) parameters({
				tenant,
				kind,
				id: afterId
			});
			return (await q(`SELECT id,revision,value FROM ceremony_records WHERE tenant=$1 AND kind=$2 AND id>$3 ORDER BY id LIMIT $4${lock}`, [
				tenant,
				kind,
				afterId,
				limit
			])).map((row) => ({
				id: String(row.id),
				revision: Number(row.revision),
				value: open({
					tenant,
					kind,
					id: String(row.id)
				}, Number(row.revision), row.value, keyring)
			}));
		},
		async claim(key, worker, durationMs) {
			duration(durationMs);
			if (!/^[a-zA-Z0-9_-]{1,200}$/.test(worker)) throw new Error("Invalid worker identity");
			const time = await now();
			const rows = await q("INSERT INTO ceremony_claims(tenant,kind,id,generation,worker,expires) VALUES($1,$2,$3,1,$4,$5) ON CONFLICT(tenant,kind,id) DO UPDATE SET generation=ceremony_claims.generation+1,worker=excluded.worker,expires=excluded.expires WHERE ceremony_claims.expires<=$6 RETURNING generation", [
				...parameters(key),
				worker,
				time + durationMs,
				time
			]);
			if (!rows.length) throw new PersistenceConflict();
			return {
				...key,
				generation: Number(rows[0].generation),
				worker
			};
		},
		async heartbeat(fence, durationMs) {
			duration(durationMs);
			await assertFence(fence);
			await q("UPDATE ceremony_claims SET expires=$4 WHERE tenant=$1 AND kind=$2 AND id=$3", [...parameters(fence), await now() + durationMs]);
		},
		assertFence,
		async cancel(key) {
			await q("INSERT INTO ceremony_claims(tenant,kind,id,generation,worker,expires) VALUES($1,$2,$3,1,'cancelled',0) ON CONFLICT(tenant,kind,id) DO UPDATE SET generation=ceremony_claims.generation+1,worker='cancelled',expires=0", parameters(key));
		}
	};
}
var PostgresCeremonyStore = class {
	keyring;
	pool;
	idleFailure = false;
	constructor(config, keyring) {
		this.keyring = keyring;
		validateKeys(keyring);
		this.pool = new Pool(config);
		this.pool.on("error", () => {
			this.idleFailure = true;
		});
		this.pool.on("connect", (client) => {
			client.on("error", () => {
				this.idleFailure = true;
			});
		});
	}
	health() {
		return this.idleFailure ? "degraded" : "ready";
	}
	async migrate() {
		try {
			await this.pool.query(migration);
		} catch {
			throw new Error("Persistence migration unavailable");
		}
	}
	/** Offline maintenance only: locks both tables and refuses outstanding live leases. Never exports plaintext. */
	async encryptedBackup() {
		return this.maintenance(async (client) => {
			if ((await client.query("SELECT 1 FROM ceremony_claims WHERE expires > (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint LIMIT 1")).rowCount) throw new Error();
			const size = await client.query("SELECT COUNT(*)::int AS count, COALESCE(SUM(octet_length(value)),0)::bigint AS bytes FROM ceremony_records");
			if (size.rows[0].count > 1e4 || Number(size.rows[0].bytes) > 16e6) throw new Error();
			const records = (await client.query("SELECT tenant,kind,id,revision,value FROM ceremony_records ORDER BY tenant,kind,id LIMIT 10001")).rows.map((r) => ({
				tenant: r.tenant,
				kind: r.kind,
				id: r.id,
				revision: Number(r.revision),
				value: r.value.toString("base64")
			}));
			const claims = (await client.query("SELECT tenant,kind,id,generation FROM ceremony_claims ORDER BY tenant,kind,id LIMIT 10001")).rows.map((r) => ({
				tenant: r.tenant,
				kind: r.kind,
				id: r.id,
				generation: Number(r.generation)
			}));
			return encryptedBackupSchema.parse({
				schemaVersion: 1,
				records,
				claims
			});
		});
	}
	/** Fresh, offline database only. Authenticate every envelope before importing; invalidate every historical worker generation. */
	async restoreEncryptedBackup(input) {
		let backup;
		try {
			if (JSON.stringify(input).length > 24e6) throw new Error();
			backup = encryptedBackupSchema.parse(input);
			for (const r of backup.records) open(r, r.revision, Buffer.from(r.value, "base64"), this.keyring);
		} catch {
			throw new Error("Encrypted backup is invalid or unavailable with configured keys");
		}
		await this.maintenance(async (client) => {
			if ((await client.query("SELECT 1 FROM ceremony_records UNION ALL SELECT 1 FROM ceremony_claims LIMIT 1")).rowCount) throw new Error();
			for (const r of backup.records) await client.query("INSERT INTO ceremony_records(tenant,kind,id,revision,value) VALUES($1,$2,$3,$4,$5)", [
				r.tenant,
				r.kind,
				r.id,
				r.revision,
				Buffer.from(r.value, "base64")
			]);
			for (const c of backup.claims) await client.query("INSERT INTO ceremony_claims(tenant,kind,id,generation,worker,expires) VALUES($1,$2,$3,$4,'restored',0)", [
				c.tenant,
				c.kind,
				c.id,
				c.generation + 1
			]);
		});
	}
	async maintenance(work) {
		const client = await this.pool.connect().catch(() => {
			throw new Error("Persistence maintenance unavailable");
		});
		try {
			await client.query("BEGIN");
			await client.query("SET LOCAL lock_timeout = '5s'");
			await client.query("LOCK TABLE ceremony_records, ceremony_claims IN ACCESS EXCLUSIVE MODE");
			const result = await work(client);
			await client.query("COMMIT");
			return result;
		} catch {
			await client.query("ROLLBACK").catch(() => {});
			throw new Error("Persistence maintenance refused; require valid keys, quiescent source or empty destination");
		} finally {
			client.release();
		}
	}
	async transaction(work) {
		const client = await this.pool.connect().catch(() => {
			throw new Error("Persistence connection unavailable");
		});
		const query = async (sql, args) => {
			try {
				return (await client.query(sql, args)).rows;
			} catch {
				throw new Error("Persistence operation unavailable");
			}
		};
		const tx = transaction(query, true, this.keyring);
		try {
			await query("BEGIN");
			const value = await work(tx);
			await query("COMMIT");
			this.idleFailure = false;
			return value;
		} catch (error) {
			await query("ROLLBACK");
			throw error;
		} finally {
			tx.finish();
			client.release();
		}
	}
	async close() {
		await this.pool.end();
	}
};
//#endregion
//#region src/server/authorization.ts
/** Shared subject-scoped fixed window; no process-local rate-limit authority. */
async function reserveRequest(store, actor, limit = 120, windowMs = 6e4) {
	if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1) throw new AuthorizationError("invalid_request");
	await store.transaction(async (tx) => {
		const key = {
			tenant: "identity",
			kind: "budget",
			id: `request:${createHash("sha256").update(JSON.stringify([actor.tenantId, actor.subjectId])).digest("hex")}`
		};
		const record = await tx.get(key);
		const now = await tx.now();
		const value = record && record.value.expires > now ? record.value : {
			count: 0,
			expires: now + windowMs
		};
		if (value.count >= limit) throw new AuthorizationError("rate_limited");
		await tx.put(key, {
			count: value.count + 1,
			expires: value.expires
		}, record?.revision ?? null);
	});
}
function exactOrigin(value, development = false) {
	const url = new URL(value);
	if (url.origin !== value || url.protocol !== "https:" && !(development && url.protocol === "http:" && url.hostname === "127.0.0.1")) throw new AuthorizationError("invalid_request");
	return url.origin;
}
function assertRequestBoundary(request, options) {
	if (new URL(request.url).origin !== options.origin) throw new AuthorizationError("invalid_request");
	if (["GET", "HEAD"].includes(request.method)) return;
	if (request.headers.get("origin") !== options.origin || request.headers.get("sec-fetch-site") === "cross-site") throw new AuthorizationError("denied");
	if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new AuthorizationError("invalid_request");
	const length = request.headers.get("content-length");
	if (length !== null && (!/^\d+$/.test(length) || Number(length) > (options.maxBytes ?? 262144))) throw new AuthorizationError("invalid_request");
}
/** Reads with an actual byte ceiling; Content-Length alone is not trustworthy. */
async function boundedJson(request, maxBytes = 262144) {
	const reader = request.body?.getReader();
	if (!reader) throw new AuthorizationError("invalid_request");
	const chunks = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel();
				throw new AuthorizationError("invalid_request");
			}
			chunks.push(value);
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new AuthorizationError("invalid_request");
	}
}
strictObject({
	tenantId: string().min(1).max(200),
	subjectId: string().min(1).max(200),
	runId: string().min(1).max(200),
	operationId: string().min(1).max(200),
	operationVersion: string().min(1).max(80),
	target: string().max(500),
	configurationVersion: string().min(1).max(200),
	scopes: array(string().max(100)).max(64),
	argumentsDigest: string().regex(/^[a-f0-9]{64}$/)
});
//#endregion
//#region src/server/oidc-identity.ts
function persistentIdentityStore(store) {
	const recordKey = (id) => ({
		tenant: "identity",
		kind: "session",
		id
	});
	const read = (id, consume) => store.transaction(async (tx) => {
		const record = await tx.get(recordKey(id));
		if (!record) return void 0;
		const expired = record.value.expiresAt <= await tx.now();
		if (consume || expired) await tx.delete(recordKey(id), record.revision);
		return expired ? void 0 : record.value.value;
	});
	return {
		get: (id) => read(id, false),
		take: (id) => read(id, true),
		put: (id, value, expiresAt) => store.transaction(async (tx) => {
			await tx.put(recordKey(id), {
				value,
				expiresAt
			}, null);
		}),
		delete: (id) => store.transaction(async (tx) => {
			const record = await tx.get(recordKey(id));
			if (record) await tx.delete(recordKey(id), record.revision);
		})
	};
}
const pendingSchema = strictObject({
	state: string(),
	nonce: string(),
	verifier: string(),
	expiresAt: number()
});
const sessionSchema = strictObject({
	actor: actorContextSchema,
	expiresAt: number()
});
/** A client the identity registered for itself, persisted so a restart or a
* second instance reuses the one registration instead of making another. */
const registeredClientSchema = strictObject({ client_id: string().min(1) });
const token = () => randomBytes(32).toString("base64url");
const key$2 = (kind, value) => `${kind}:${createHash("sha256").update(value).digest("hex")}`;
function cookie(request, name) {
	const values = (request.headers.get("cookie") ?? "").split(";").map((v) => v.trim()).filter((v) => v.startsWith(`${name}=`));
	if (values.length !== 1) return void 0;
	const value = values[0].slice(name.length + 1);
	return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : void 0;
}
async function createOidcIdentity(config, store) {
	const origin = exactOrigin(config.origin, config.development);
	const redirect = `${origin}/api/auth/callback`;
	const issuer = new URL(config.issuer);
	const safeEndpoint = (endpoint) => {
		if (!endpoint) throw new AuthorizationError("invalid_request");
		const url = new URL(endpoint);
		if (url.username || url.password || url.hash || url.protocol !== "https:" && !(config.development && url.protocol === "http:" && url.hostname === "127.0.0.1")) throw new AuthorizationError("invalid_request");
		return url;
	};
	if (issuer.username || issuer.password || issuer.search || issuer.hash || issuer.protocol !== "https:" && !(config.development && issuer.protocol === "http:" && issuer.hostname === "127.0.0.1")) throw new AuthorizationError("invalid_request");
	if (config.sessionSeconds !== void 0 && (!Number.isInteger(config.sessionSeconds) || config.sessionSeconds < 60 || config.sessionSeconds > 86400)) throw new AuthorizationError("invalid_request");
	const options = { [allowInsecureRequests]: config.development === true };
	const as = await processDiscoveryResponse(issuer, await discoveryRequest(issuer, options));
	for (const endpoint of [
		as.authorization_endpoint,
		as.token_endpoint,
		as.jwks_uri
	]) safeEndpoint(endpoint);
	let client;
	if (config.clientId) client = { client_id: config.clientId };
	else {
		safeEndpoint(as.registration_endpoint);
		const registrationKey = key$2("identity-client", `${issuer.href}|${redirect}`);
		const cached = registeredClientSchema.safeParse(await store.get(registrationKey));
		if (cached.success) client = { client_id: cached.data.client_id };
		else {
			const registered = await processDynamicClientRegistrationResponse(await dynamicClientRegistrationRequest(as, {
				client_name: config.clientName ?? "Ceremony connection",
				redirect_uris: [redirect],
				grant_types: ["authorization_code"],
				response_types: ["code"],
				token_endpoint_auth_method: config.clientSecret ? "client_secret_post" : "none",
				application_type: "web"
			}, options));
			if (!registered.client_id) throw new AuthorizationError("invalid_request");
			client = { client_id: registered.client_id };
			await store.put(registrationKey, { client_id: registered.client_id }, Date.now() + 31536e6);
		}
	}
	const prefix = config.development ? "ceremony_" : "__Host-ceremony_";
	const sessionName = `${prefix}session`;
	const stateName = `${prefix}login`;
	const seconds = config.sessionSeconds ?? 3600;
	const setCookie = (name, value, age) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${config.development ? "" : "; Secure"}`;
	const response = (location, cookies) => {
		const headers = new Headers({
			location,
			"cache-control": "no-store",
			"referrer-policy": "no-referrer"
		});
		for (const value of cookies) headers.append("set-cookie", value);
		return new Response(null, {
			status: 303,
			headers
		});
	};
	return {
		async authenticate(request) {
			const id = cookie(request, sessionName);
			if (!id) return null;
			const parsed = sessionSchema.safeParse(await store.get(key$2("identity-session", id)));
			if (!parsed.success || parsed.data.expiresAt <= Date.now()) return null;
			return parsed.data.actor;
		},
		async login(request) {
			assertRequestBoundary(request, { origin });
			if (request.method !== "POST") throw new AuthorizationError("invalid_request");
			const binding = token();
			const pending = {
				state: generateRandomState(),
				nonce: generateRandomNonce(),
				verifier: generateRandomCodeVerifier(),
				expiresAt: Date.now() + 6e5
			};
			await store.put(key$2("identity-login", binding), pending, pending.expiresAt);
			const url = new URL(as.authorization_endpoint);
			url.search = new URLSearchParams({
				client_id: client.client_id,
				redirect_uri: redirect,
				response_type: "code",
				scope: "openid",
				state: pending.state,
				nonce: pending.nonce,
				code_challenge: await calculatePKCECodeChallenge(pending.verifier),
				code_challenge_method: "S256"
			}).toString();
			return response(url.href, [setCookie(stateName, binding, 600)]);
		},
		async callback(request) {
			try {
				if (request.method !== "GET" || new URL(request.url).origin !== origin || new URL(request.url).pathname !== "/api/auth/callback") throw new AuthorizationError("denied");
				const binding = cookie(request, stateName);
				if (!binding) throw new AuthorizationError("denied");
				const pending = pendingSchema.parse(await store.take(key$2("identity-login", binding)));
				if (pending.expiresAt <= Date.now()) throw new AuthorizationError("denied");
				const params = validateAuthResponse(as, client, new URL(request.url), pending.state);
				const result = await authorizationCodeGrantRequest(as, client, config.clientSecret ? ClientSecretPost(config.clientSecret) : None(), params, redirect, pending.verifier, options);
				const tokens = await processAuthorizationCodeResponse(as, client, result, {
					expectedNonce: pending.nonce,
					requireIdToken: true
				});
				await validateApplicationLevelSignature(as, result, options);
				const claims = getValidatedIdTokenClaims(tokens);
				if (!claims) throw new AuthorizationError("denied");
				const actor = actorContextSchema.parse({
					...await config.mapClaims(claims),
					sessionId: token(),
					actorKind: "human"
				});
				const old = cookie(request, sessionName);
				if (old) await store.delete(key$2("identity-session", old));
				const id = token();
				const expiresAt = Math.min(Date.now() + seconds * 1e3, claims.exp * 1e3);
				if (expiresAt <= Date.now()) throw new AuthorizationError("denied");
				await store.put(key$2("identity-session", id), {
					actor,
					expiresAt
				}, expiresAt);
				return response(origin, [setCookie(sessionName, id, Math.floor((expiresAt - Date.now()) / 1e3)), setCookie(stateName, "", 0)]);
			} catch {
				throw new AuthorizationError("denied");
			}
		},
		async logout(request) {
			assertRequestBoundary(request, { origin });
			if (request.method !== "POST") throw new AuthorizationError("invalid_request");
			const id = cookie(request, sessionName);
			if (id) await store.delete(key$2("identity-session", id));
			return response(origin, [setCookie(sessionName, "", 0)]);
		}
	};
}
//#endregion
//#region src/core/recipe-contracts.ts
const RECIPE_LIMITS = Object.freeze({
	bytes: 262144,
	leaves: 32,
	depth: 8
});
const bindingSchema = discriminatedUnion("from", [
	object({
		from: literal("input"),
		name: identifierSchema
	}).strict(),
	object({
		from: literal("output"),
		node: identifierSchema,
		name: identifierSchema
	}).strict(),
	object({
		from: literal("literal"),
		value: publicValueSchema
	}).strict()
]);
const recipeInvocationSchema = object({
	id: identifierSchema,
	use: discriminatedUnion("kind", [object({
		kind: literal("operation"),
		id: identifierSchema,
		version: semanticVersionSchema
	}).strict(), object({
		kind: literal("recipe"),
		id: identifierSchema,
		version: semanticVersionSchema,
		digest: string().regex(/^[a-f0-9]{64}$/)
	}).strict()]),
	dependsOn: array(identifierSchema).max(32),
	bindings: record(identifierSchema, bindingSchema).refine((v) => Object.keys(v).length <= 32)
}).strict();
const recipeDefinitionSchema = object({
	schemaVersion: literal(1),
	id: identifierSchema,
	title: string().min(1).max(100),
	description: string().max(1e3),
	inputs: record(identifierSchema, registeredInputContractSchema).refine((v) => Object.keys(v).length <= 32),
	invocations: array(recipeInvocationSchema).min(1).max(RECIPE_LIMITS.leaves),
	outputs: record(identifierSchema, object({
		node: identifierSchema,
		name: identifierSchema
	}).strict()).refine((v) => Object.keys(v).length <= 32)
}).strict().superRefine((recipe, context) => {
	const nodes = new Map(recipe.invocations.map((node) => [node.id, node]));
	const issue = (message) => context.addIssue({
		code: "custom",
		message
	});
	if (nodes.size !== recipe.invocations.length) issue("Duplicate invocation");
	for (const node of recipe.invocations) {
		if (new Set(node.dependsOn).size !== node.dependsOn.length) issue("Duplicate dependency");
		for (const dependency of node.dependsOn) if (!nodes.has(dependency)) issue("Unknown dependency");
		for (const binding of Object.values(node.bindings)) {
			if (binding.from === "input" && !Object.hasOwn(recipe.inputs, binding.name)) issue("Unbound input");
			if (binding.from === "output" && !node.dependsOn.includes(binding.node)) issue("Output producer must be an explicit dependency");
		}
	}
	for (const output of Object.values(recipe.outputs)) if (!nodes.has(output.node)) issue("Unknown output producer");
	const visited = /* @__PURE__ */ new Set();
	const active = /* @__PURE__ */ new Set();
	function visit(id) {
		if (active.has(id)) {
			issue("Dependency cycle");
			return;
		}
		if (visited.has(id)) return;
		active.add(id);
		for (const dependency of nodes.get(id)?.dependsOn ?? []) visit(dependency);
		active.delete(id);
		visited.add(id);
	}
	for (const id of nodes.keys()) visit(id);
});
function parseRecipeImport(text) {
	if (new TextEncoder().encode(text).byteLength > RECIPE_LIMITS.bytes) throw new Error("Recipe exceeds import limit");
	return recipeDefinitionSchema.parse(JSON.parse(text));
}
function canonicalRecipeDefinition(definition) {
	const recipe = recipeDefinitionSchema.parse(definition);
	function canonical(value) {
		if (Array.isArray(value)) return value.map(canonical);
		if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
		return value;
	}
	return JSON.stringify(canonical(recipe));
}
/** Integrity only: a digest conveys neither publication rights nor provider evidence. */
async function digestRecipeDefinition(definition) {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalRecipeDefinition(definition)));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
//#endregion
//#region src/core/teaching-contracts.ts
const commandEnvelopeSchema = object({
	commandId: identifierSchema,
	runId: identifierSchema,
	nodeId: identifierSchema,
	expectedRevision: number().int().nonnegative(),
	operationId: identifierSchema,
	operationVersion: semanticVersionSchema,
	bindings: record(identifierSchema, bindingSchema).refine((v) => Object.keys(v).length <= 32)
}).strict();
const diagnosticCodeSchema = _enum([
	"denied",
	"conflict",
	"unavailable",
	"invalid-input",
	"awaiting-human",
	"uncertain",
	"verification-rejected",
	"cancelled",
	"expired"
]);
const demonstrationEventSchema = object({
	schemaVersion: literal(1),
	eventId: identifierSchema,
	demonstrationId: identifierSchema,
	sequence: number().int().nonnegative(),
	nodeId: identifierSchema,
	operationId: identifierSchema,
	operationVersion: semanticVersionSchema,
	actorKind: _enum([
		"human",
		"agent",
		"system"
	]),
	kind: _enum([
		"choice",
		"transition",
		"handoff",
		"verification",
		"failure"
	]),
	beforeState: identifierSchema,
	afterState: identifierSchema,
	publicBindings: record(identifierSchema, publicValueSchema).refine((v) => Object.keys(v).length <= 32),
	verification: _enum([
		"none",
		"pending",
		"accepted",
		"rejected"
	]),
	diagnosticCode: diagnosticCodeSchema.optional()
}).strict();
const demonstrationConsentSchema = _enum([
	"recording",
	"paused",
	"stopped",
	"discarded"
]);
object({
	id: identifierSchema,
	verifier: identifierSchema,
	status: _enum([
		"pending",
		"accepted",
		"rejected"
	]),
	revision: number().int().nonnegative()
}).strict();
object({
	state: _enum([
		"required",
		"waiting",
		"verifying",
		"expired",
		"cancelled"
	]),
	purpose: _enum([
		"provider-consent",
		"private-input",
		"owner-choice"
	])
}).strict();
//#endregion
//#region src/core/connector-contracts.ts
/** Portable requirements only. Values, recipients, URLs and authority stay with the host. */
const humanHandoffContractSchema = strictObject({
	surface: _enum(["provider-browser", "private-collector"]),
	recipient: _enum(["initiating-subject", "authorized-owner"]),
	delegation: literal("a2h-authorize"),
	resume: literal("verify")
});
/**
* What a provider needs before it will make an account, in the order it needs it.
*
* Registration does not begin with a password. It begins with whatever names
* the account — an address at one provider, a handle at another, both at a
* third — and only then, if at all, with something proving it. A flow built the
* other way round asks every person for a password whether or not their
* provider wants one, which is wrong for single sign-on, wrong for a passkey,
* wrong for a magic link, and wrong for every provider that issues the
* credential itself rather than accepting one.
*
* So the identifier is declared separately from the secret, and the secret is
* declared as a kind rather than assumed to exist:
*
* - `none` — nothing beyond the identifier. A passkey, single sign-on, or a
*   link the provider mails. No credential field is ever shown.
* - `password` — a password, which the provider will hold. `mint` says whether
*   the ceremony may generate it instead of asking a person to invent one.
* - `issued-token` — the provider issues the credential in its own surface and
*   a person brings it back. Never generated here: only the provider can make
*   one that works.
* - `provider` — the provider owns the credential step completely, as a
*   redirect or a device code. Nothing is collected and nothing is minted.
*
* `mint` is only ever true for `password`, and being true is what lets a
* ceremony hand somebody a strong credential they never had to think of — and
* never had to type where anything could read it.
*/
const registrationContractSchema = strictObject({
	identifier: array(_enum([
		"email",
		"username",
		"organization"
	])).min(1).max(3).refine((values) => new Set(values).size === values.length, "Duplicate identifier"),
	secret: _enum([
		"none",
		"password",
		"issued-token",
		"provider"
	]),
	mint: boolean(),
	/** Where the account comes into existence: here, or in the provider's own surface. */
	createdBy: _enum(["this-ceremony", "provider-browser"])
}).refine((value) => !value.mint || value.secret === "password", "Only a password may be minted");
const methodContractSchema = strictObject({
	profile: identifierSchema,
	surfaces: array(_enum(["browser", "headless"])).min(1).max(2).refine((values) => new Set(values).size === values.length, "Duplicate surface"),
	configuration: array(strictObject({
		name: string().regex(/^[A-Z][A-Z0-9_]{0,95}$/),
		source: _enum(["session-environment", "host"]),
		classification: _enum([
			"public",
			"personal",
			"secret"
		]),
		required: boolean()
	})).max(24),
	configurationGroups: array(strictObject({
		id: identifierSchema,
		rule: _enum(["all-or-none", "at-least-one"]),
		names: array(string().regex(/^[A-Z][A-Z0-9_]{0,95}$/)).min(2).max(24)
	})).max(12),
	prerequisites: array(strictObject({
		id: identifierSchema,
		kind: _enum([
			"configuration",
			"provider-registration",
			"provider-consent"
		]),
		reuse: literal("verified-context"),
		handoff: humanHandoffContractSchema
	})).max(12),
	handoff: humanHandoffContractSchema,
	/** Present when this method can bring an account into being, not merely use one. */
	registration: registrationContractSchema.optional(),
	completion: strictObject({
		verifier: identifierSchema,
		ownership: array(_enum([
			"authenticated",
			"anonymous",
			"claimed"
		])).min(1).max(3).refine((values) => new Set(values).size === values.length, "Duplicate ownership")
	}),
	/** Host-bound document identity; never a remotely fetched executable URL. */
	workflows: array(strictObject({
		document: identifierSchema,
		version: semanticVersionSchema,
		workflowId: identifierSchema
	})).max(12)
}).superRefine((value, context) => {
	for (const [items, keys] of [
		[value.configuration, value.configuration.map((item) => item.name)],
		[value.prerequisites, value.prerequisites.map((item) => item.id)],
		[value.configurationGroups, value.configurationGroups.map((item) => item.id)],
		[value.workflows, value.workflows.map((item) => `${item.document}:${item.workflowId}`)]
	]) if (items.length !== new Set(keys).size) context.addIssue({
		code: "custom",
		message: "Duplicate contract requirement"
	});
	for (const group of value.configurationGroups) if (new Set(group.names).size !== group.names.length || group.names.some((name) => !value.configuration.some((item) => item.name === name))) context.addIssue({
		code: "custom",
		message: "Configuration group requires distinct declared names"
	});
});
const flowKindSchema = _enum([
	"api-key",
	"basic",
	"form",
	"oauth-code",
	"device",
	"authmd-anonymous",
	"github-app"
]);
const fieldSchema = object({
	name: string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/),
	label: string().min(1).max(100),
	type: _enum([
		"text",
		"email",
		"password"
	]),
	required: boolean(),
	classification: fieldClassificationSchema.optional()
}).strict().refine((field) => !(field.type === "password" || ["password", "token"].includes(field.name)) || field.classification === void 0 || field.classification === "secret", "Credential fields must remain secret");
const methodSchema = object({
	id: string().regex(/^[a-z0-9-]{1,64}$/),
	label: string().min(1).max(100),
	kind: flowKindSchema,
	fields: array(fieldSchema).max(12),
	/** Omit for the email/code profile; [] supports provider-owned claiming. */
	claimFields: array(fieldSchema).max(12).optional(),
	scopes: array(string().min(1).max(100)).max(30),
	templateId: string().regex(/^[a-z0-9-]{1,64}$/),
	contract: methodContractSchema.optional()
}).strict().superRefine((method, ctx) => {
	const names = method.fields.map((field) => field.name);
	if (method.claimFields && (method.kind !== "authmd-anonymous" || new Set(method.claimFields.map((field) => field.name)).size !== method.claimFields.length)) ctx.addIssue({
		code: "custom",
		message: "Claim fields require anonymous auth and unique names"
	});
	if (new Set(names).size !== names.length) ctx.addIssue({
		code: "custom",
		message: "Duplicate field names"
	});
	if (method.contract && method.kind !== "authmd-anonymous" && method.contract.completion.ownership.some((ownership) => ownership !== "authenticated")) ctx.addIssue({
		code: "custom",
		message: "This method requires authenticated completion"
	});
	if (method.contract && [
		"basic",
		"api-key",
		"form"
	].includes(method.kind) && method.contract.handoff.surface !== "private-collector") ctx.addIssue({
		code: "custom",
		message: "Credential methods require private collection"
	});
	const expected = method.kind === "basic" ? ["username", "password"] : method.kind === "api-key" ? ["token"] : null;
	if (expected && (names.length !== expected.length || expected.some((name) => !names.includes(name)))) ctx.addIssue({
		code: "custom",
		message: `${method.kind} requires ${expected.join(", ")}`
	});
	if (method.kind === "form" && !names.length) ctx.addIssue({
		code: "custom",
		message: "Form requires fields"
	});
	if (![
		"basic",
		"api-key",
		"form"
	].includes(method.kind) && names.length) ctx.addIssue({
		code: "custom",
		message: "This method does not collect credentials"
	});
	if ([...method.fields, ...method.claimFields ?? []].some((field) => ["password", "token"].includes(field.name) && field.type !== "password")) ctx.addIssue({
		code: "custom",
		message: "Credentials require masked inputs"
	});
});
const manifestSchema = object({
	schemaVersion: literal(1).optional(),
	support: _enum(["fixture", "live-adapter"]).optional(),
	id: string().regex(/^[a-z0-9-]{1,64}$/),
	name: string().min(1).max(100),
	description: string().max(500),
	methods: array(methodSchema).min(1).max(12)
}).strict().superRefine((value, ctx) => {
	if (value.schemaVersion === 1 && (!value.support || value.methods.some((method) => !method.contract || [...method.fields, ...method.claimFields ?? []].some((field) => !field.classification)))) ctx.addIssue({
		code: "custom",
		message: "Version 1 requires support, method contracts and explicit field classifications"
	});
	if (new Set(value.methods.map((method) => method.id)).size !== value.methods.length) ctx.addIssue({
		code: "custom",
		message: "Duplicate method IDs"
	});
});
const classifiedFieldSchema = fieldSchema.safeExtend({ classification: fieldClassificationSchema });
manifestSchema.safeExtend({
	schemaVersion: literal(1),
	support: _enum(["fixture", "live-adapter"]),
	methods: array(methodSchema.safeExtend({
		contract: methodContractSchema,
		fields: array(classifiedFieldSchema).max(12),
		claimFields: array(classifiedFieldSchema).max(12).optional()
	})).min(1).max(12)
});
const steps = [
	"intro",
	"input",
	"redirect",
	"waiting",
	"anonymous",
	"claim",
	"complete",
	"error",
	"cancelled",
	"expired"
];
const actionNames = [
	"begin",
	"submit",
	"claim",
	"finish",
	"retry",
	"cancel",
	"request-human"
];
const outcomeSchema = object({
	connectionRef: string().min(1).max(200),
	ownership: _enum([
		"authenticated",
		"anonymous",
		"claimed"
	]),
	scopes: array(string()),
	/**
	* A reference to the credential this ceremony established — never the
	* credential. Without it a completed ceremony is orphaned: the connection
	* exists and nothing the host owns can name it. The host redeems this
	* through its own tooling, so the secret never enters a snapshot, an
	* assistant's context, or this component's markup.
	*/
	secretRef: uuid().optional()
}).strict();
const displayUrlSchema = url().refine((value) => {
	const url = new URL(value);
	return !url.username && !url.password && !url.hash && (url.protocol === "https:" || url.protocol === "http:" && [
		"localhost",
		"127.0.0.1",
		"[::1]"
	].includes(url.hostname));
}, "Unsafe navigation URL");
object({
	id: string().min(1),
	revision: number().int().nonnegative(),
	connectorId: string(),
	connectorName: string(),
	description: string(),
	method: methodSchema,
	step: _enum(steps),
	fields: array(fieldSchema),
	actions: array(_enum(actionNames)),
	expiresAt: number().finite(),
	message: string().optional(),
	authorizationUrl: displayUrlSchema.optional(),
	verificationUri: displayUrlSchema.optional(),
	userCode: string().optional(),
	outcome: outcomeSchema.optional(),
	prerequisites: array(object({
		id: string(),
		label: string(),
		status: _enum([
			"blocked",
			"ready",
			"awaiting-human",
			"verifying",
			"succeeded",
			"failed"
		])
	}).strict()).optional()
}).strict();
object({
	action: _enum(actionNames),
	revision: number().int().nonnegative(),
	values: record(string(), string().max(4096)).default({}),
	secretRef: uuid().optional()
}).strict();
object({
	version: literal(1),
	id: string().regex(/^[a-z0-9-]{1,64}$/),
	kind: flowKindSchema,
	screens: record(_enum(steps), string().min(1).max(2e4))
}).strict();
//#endregion
//#region src/core/projections.ts
/** Policy is supplied by the trusted operation registry, never the caller/event. */
function demonstrationProjection(event, policy) {
	const publicBindings = {};
	for (const [name, rule] of Object.entries(policy)) {
		if (rule.classification !== "public" || !Object.hasOwn(event.publicBindings, name)) continue;
		const value = rule.schema.safeParse(event.publicBindings[name]);
		if (value.success) {
			const primitive = publicValueSchema.safeParse(value.data);
			if (primitive.success) publicBindings[name] = primitive.data;
		}
	}
	return demonstrationEventSchema.parse({
		schemaVersion: 1,
		eventId: event.eventId,
		demonstrationId: event.demonstrationId,
		sequence: event.sequence,
		nodeId: event.nodeId,
		operationId: event.operationId,
		operationVersion: event.operationVersion,
		actorKind: event.actorKind,
		kind: event.kind,
		beforeState: event.beforeState,
		afterState: event.afterState,
		publicBindings,
		verification: event.verification,
		...event.diagnosticCode === void 0 ? {} : { diagnosticCode: event.diagnosticCode }
	});
}
function auditProjection(event) {
	return {
		sequence: event.sequence,
		operationId: event.operationId,
		operationVersion: event.operationVersion,
		actorKind: event.actorKind,
		kind: event.kind,
		verification: event.verification,
		...event.diagnosticCode === void 0 ? {} : { diagnosticCode: event.diagnosticCode }
	};
}
//#endregion
//#region src/server/demonstrations.ts
const demonstrationSchema = strictObject({
	id: string(),
	tenantId: string(),
	subjectId: string(),
	runId: string(),
	scope: array(string()).max(32),
	consent: demonstrationConsentSchema,
	startSequence: number().int().nonnegative(),
	endSequence: number().int().nonnegative().nullable()
});
const key$1 = (actor, id) => ({
	tenant: actor.tenantId,
	kind: "demonstration",
	id
});
/** Consent and transitions share a transactional ledger, independent of tab lifetime. */
var Demonstrations = class {
	store;
	constructor(store) {
		this.store = store;
	}
	async start(actor, runId, scope = []) {
		requireCapability(actor, "author");
		return this.store.transaction(async (tx) => {
			const run = await tx.get({
				tenant: actor.tenantId,
				kind: "run",
				id: runId
			});
			if (!run || run.value.subjectId !== actor.subjectId) throw new AuthorizationError("denied");
			const ledger = await tx.get({
				tenant: actor.tenantId,
				kind: "event",
				id: `sequence:${runId}`
			});
			const demo = demonstrationSchema.parse({
				id: `demo:${randomUUID()}`,
				tenantId: actor.tenantId,
				subjectId: actor.subjectId,
				runId,
				scope,
				consent: "recording",
				startSequence: ledger?.value.sequence ?? 0,
				endSequence: null
			});
			const revision = await tx.put(key$1(actor, demo.id), demo, null);
			const pointer = {
				tenant: actor.tenantId,
				kind: "session",
				id: `demonstration:${runId}`
			};
			const previous = await tx.get(pointer);
			await tx.put(pointer, { id: demo.id }, previous?.revision ?? null);
			return {
				...demo,
				revision
			};
		});
	}
	async change(actor, id, expectedRevision, consent) {
		requireCapability(actor, "author");
		return this.store.transaction(async (tx) => {
			const saved = await tx.get(key$1(actor, id));
			if (!saved || saved.value.subjectId !== actor.subjectId) throw new AuthorizationError("denied");
			if (saved.revision !== expectedRevision) throw new PersistenceConflict();
			if (saved.value.consent === "discarded" || saved.value.consent === "stopped" && consent !== "discarded") throw new AuthorizationError("denied");
			const ledger = await tx.get({
				tenant: actor.tenantId,
				kind: "event",
				id: `sequence:${saved.value.runId}`
			});
			const demo = {
				...saved.value,
				consent: demonstrationConsentSchema.parse(consent),
				endSequence: ledger?.value.sequence ?? 0
			};
			const revision = await tx.put(key$1(actor, id), demo, saved.revision);
			if (consent === "discarded") {
				let after = `${id}:`;
				for (;;) {
					const own = (await tx.list(actor.tenantId, "event", 1e3, after)).filter((record) => record.id.startsWith(`${id}:`));
					for (const record of own) {
						if (record.value.demonstrationId !== id) throw new AuthorizationError("denied");
						await tx.delete({
							tenant: actor.tenantId,
							kind: "event",
							id: record.id
						}, record.revision);
					}
					if (own.length < 1e3) break;
					after = own.at(-1).id;
				}
			}
			await tx.put({
				tenant: actor.tenantId,
				kind: "audit",
				id: `consent:${randomUUID()}`
			}, {
				kind: "demonstration-consent",
				consent,
				subjectId: actor.subjectId,
				sequence: demo.endSequence
			}, null);
			return {
				...demo,
				revision
			};
		});
	}
	async timeline(actor, id, after = 0, limit = 100) {
		if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AuthorizationError("invalid_request");
		return this.store.transaction(async (tx) => {
			const saved = await tx.get(key$1(actor, id));
			if (!saved || saved.value.consent === "discarded" || saved.value.subjectId !== actor.subjectId && !actor.capabilities.includes("reviewer")) throw new AuthorizationError("denied");
			const events = (await tx.list(actor.tenantId, "event", limit, `${id}:${String(after).padStart(12, "0")}`)).filter((x) => x.id.startsWith(`${id}:`) && x.value.demonstrationId === id && x.value.sequence > after).map((x) => demonstrationEventSchema.parse(x.value));
			return {
				...saved.value,
				revision: saved.revision,
				events
			};
		});
	}
};
/** Caller MUST append in the same transaction as the authoritative state change. */
async function appendSemanticTransition(tx, actor, runId, event, policy) {
	const ledgerKey = {
		tenant: actor.tenantId,
		kind: "event",
		id: `sequence:${runId}`
	};
	const prior = await tx.get(ledgerKey);
	const sequence = (prior?.value.sequence ?? 0) + 1;
	await tx.put(ledgerKey, { sequence }, prior?.revision ?? null);
	const safe = demonstrationProjection({
		...event,
		schemaVersion: 1,
		eventId: `event:${randomUUID()}`,
		demonstrationId: "audit",
		sequence
	}, policy);
	await tx.put({
		tenant: actor.tenantId,
		kind: "audit",
		id: safe.eventId
	}, auditProjection(safe), null);
	let after = "";
	for (;;) {
		const demos = await tx.list(actor.tenantId, "demonstration", 1e3, after);
		for (const demo of demos) {
			const d = demo.value;
			if (d.runId !== runId || d.subjectId !== actor.subjectId || d.consent !== "recording" || d.scope.length && !d.scope.includes(event.nodeId)) continue;
			await tx.put({
				tenant: actor.tenantId,
				kind: "event",
				id: `${d.id}:${String(sequence).padStart(12, "0")}`
			}, {
				...safe,
				demonstrationId: d.id
			}, null);
		}
		if (demos.length < 1e3) break;
		after = demos.at(-1).id;
	}
	return sequence;
}
//#endregion
//#region src/server/commands.ts
const key = (actor, kind, id) => ({
	tenant: actor.tenantId,
	kind,
	id
});
function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
	return value;
}
const digest = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
/** Shared authority service. Actor context is supplied by trusted host middleware, never command JSON. */
var ProtectedCommandService = class {
	store;
	registry;
	reauthorize;
	constructor(store, registry, reauthorize) {
		this.store = store;
		this.registry = registry;
		this.reauthorize = reauthorize;
	}
	async createRun(actor, context, nodes, inputs, continuation) {
		requireCapability(actor, "executor");
		if (!nodes.length || nodes.length > 32 || new Set(nodes.map((n) => n.id)).size !== nodes.length) throw new AuthorizationError("invalid_request");
		const prior = /* @__PURE__ */ new Set();
		for (const node of nodes) {
			const operation = this.registry.require(node.operationId, node.operationVersion);
			if (operation.contract.provider !== context.provider || operation.contract.profile !== context.profile || node.dependsOn.some((id) => !prior.has(id))) throw new AuthorizationError("denied");
			commandEnvelopeSchema.parse({
				commandId: "validate",
				runId: "validate",
				nodeId: node.id,
				operationId: node.operationId,
				operationVersion: node.operationVersion,
				expectedRevision: 0,
				bindings: node.bindings
			});
			prior.add(node.id);
		}
		const run = {
			...context,
			id: `run:${randomUUID()}`,
			subjectId: actor.subjectId,
			sessionId: actor.sessionId,
			status: "active",
			nodes: structuredClone(nodes),
			inputs: structuredClone(inputs),
			...continuation ? { continuation } : {}
		};
		if (!await this.reauthorize(actor, run, nodes[0].operationId)) throw new AuthorizationError("denied");
		await this.store.transaction((tx) => tx.put(key(actor, "run", run.id), run, null));
		return this.snapshot(actor, run.id);
	}
	async owned(tx, actor, runId) {
		const run = await tx.get(key(actor, "run", runId));
		if (!run || run.value.subjectId !== actor.subjectId) throw new AuthorizationError("denied");
		return run;
	}
	async snapshot(actor, runId) {
		return this.store.transaction(async (tx) => {
			const run = await this.owned(tx, actor, runId);
			const nodes = [];
			for (const node of run.value.nodes) {
				const state = await tx.get(key(actor, "node", `${runId}:${node.id}`));
				nodes.push({
					id: node.id,
					operationId: node.operationId,
					operationVersion: node.operationVersion,
					state: state?.value.state ?? "pending",
					verified: state?.value.verified ?? false
				});
			}
			return {
				id: runId,
				revision: run.revision,
				provider: run.value.provider,
				profile: run.value.profile,
				status: run.value.status,
				nodes
			};
		});
	}
	async cancel(actor, runId, expectedRevision) {
		requireCapability(actor, "executor");
		if (actor.actorKind === "agent") {
			const current = await this.store.transaction((tx) => this.owned(tx, actor, runId));
			if (!await this.reauthorize(actor, current.value, "cancel")) throw new AuthorizationError("denied");
		}
		await this.store.transaction(async (tx) => {
			const run = await this.owned(tx, actor, runId);
			if (actor.actorKind === "agent" && !await this.reauthorize(actor, run.value, "cancel", tx)) throw new AuthorizationError("denied");
			if (run.revision !== expectedRevision) throw new PersistenceConflict();
			await tx.cancel(key(actor, "run", runId));
			await tx.put(key(actor, "run", runId), {
				...run.value,
				status: "cancelled"
			}, run.revision);
		});
		return this.snapshot(actor, runId);
	}
	/** Fresh provider evidence is required for reuse; never rerun an effect to test validity. */
	async revalidate(actor, runId) {
		requireCapability(actor, "executor");
		const initial = await this.store.transaction(async (tx) => {
			const run = await this.owned(tx, actor, runId);
			if (run.value.status === "cancelled") throw new AuthorizationError("denied");
			const nodes = /* @__PURE__ */ new Map();
			for (const node of run.value.nodes) {
				const record = await tx.get(key(actor, "node", `${runId}:${node.id}`));
				if (record) nodes.set(node.id, record.value);
			}
			return {
				run,
				nodes,
				fence: await tx.claim(key(actor, "run", runId), `revalidate-${randomUUID()}`, 6e4)
			};
		});
		const invalid = /* @__PURE__ */ new Set();
		for (const node of initial.run.value.nodes) {
			const result = initial.nodes.get(node.id);
			if (node.dependsOn.some((id) => invalid.has(id))) {
				invalid.add(node.id);
				continue;
			}
			if (!result?.verified) continue;
			const operation = this.registry.require(node.operationId, node.operationVersion);
			const run = initial.run.value;
			if (!await this.reauthorize(actor, run, node.operationId)) throw new AuthorizationError("denied");
			try {
				if (!(operation.verify && await operation.verify({
					actor,
					runId,
					nodeId: node.id,
					commandId: `reuse:${runId}`,
					effectId: `reuse:${runId}`,
					target: run.target,
					configurationVersion: run.configurationVersion,
					origin: run.origin,
					environment: run.environment,
					signal: AbortSignal.timeout(3e4)
				}, {
					state: "complete",
					outputs: operation.outputSchema.parse(result.outputs)
				}))) invalid.add(node.id);
			} catch {
				invalid.add(node.id);
			}
		}
		await this.store.transaction(async (tx) => {
			await tx.assertFence(initial.fence);
			const current = await this.owned(tx, actor, runId);
			if (current.revision !== initial.run.revision || current.value.status === "cancelled") throw new PersistenceConflict();
			for (const node of current.value.nodes) {
				if (!await this.reauthorize(actor, current.value, node.operationId, tx)) throw new AuthorizationError("denied");
				if (!invalid.has(node.id)) continue;
				const nodeKey = key(actor, "node", `${runId}:${node.id}`);
				const prior = await tx.get(nodeKey);
				if (prior) await tx.put(nodeKey, {
					state: "failed",
					verified: false,
					outputs: {}
				}, prior.revision);
			}
			if (invalid.size) await tx.put(key(actor, "run", runId), {
				...current.value,
				status: "active"
			}, current.revision);
			await tx.cancel(key(actor, "run", runId));
		});
		return this.snapshot(actor, runId);
	}
	async advance(actor, runId, nodeId, expectedRevision, commandId, signal) {
		const node = (await this.store.transaction((tx) => this.owned(tx, actor, runId))).value.nodes.find((n) => n.id === nodeId);
		if (!node) throw new AuthorizationError("denied");
		return this.execute(actor, {
			commandId,
			runId,
			nodeId,
			expectedRevision,
			operationId: node.operationId,
			operationVersion: node.operationVersion,
			bindings: node.bindings
		}, signal);
	}
	async execute(actor, input, signal = AbortSignal.timeout(3e4)) {
		requireCapability(actor, "executor");
		const command = commandEnvelopeSchema.parse(input);
		const initial = await this.store.transaction((tx) => this.owned(tx, actor, command.runId));
		if (!await this.reauthorize(actor, initial.value, command.operationId)) throw new AuthorizationError("denied");
		signal.throwIfAborted();
		const operation = this.registry.require(command.operationId, command.operationVersion);
		const admission = await this.store.transaction(async (tx) => {
			const saved = await this.owned(tx, actor, command.runId);
			const run = saved.value;
			if (!await this.reauthorize(actor, run, command.operationId, tx)) throw new AuthorizationError("denied");
			const intent = digest({
				command,
				tenantId: actor.tenantId,
				subjectId: actor.subjectId,
				context: {
					provider: run.provider,
					profile: run.profile,
					target: run.target,
					origin: run.origin,
					environment: run.environment,
					configurationVersion: run.configurationVersion
				}
			});
			const prior = await tx.get(key(actor, "command", command.commandId));
			if (prior) {
				if (prior.value.digest !== intent) throw new AuthorizationError("denied");
				if (prior.value.state === "running" && run.status === "active") {
					if (await tx.claim(key(actor, "run", run.id), `reconcile-${randomUUID()}`, 6e4).catch((error) => {
						if (error instanceof PersistenceConflict) return void 0;
						throw error;
					})) {
						const effectKey = key(actor, "effect", prior.value.effectId);
						const effect = await tx.get(effectKey);
						if (!effect) throw new AuthorizationError("denied");
						const nodeKey = key(actor, "node", `${run.id}:${command.nodeId}`);
						const previous = await tx.get(nodeKey);
						await tx.put(key(actor, "command", command.commandId), {
							...prior.value,
							state: "uncertain"
						}, prior.revision);
						await tx.put(effectKey, {
							...effect.value,
							status: "uncertain",
							verified: false
						}, effect.revision);
						await tx.put(nodeKey, {
							state: "uncertain",
							verified: false,
							outputs: {}
						}, previous?.revision ?? null);
						const revision = await tx.put(key(actor, "run", run.id), run, saved.revision);
						await appendSemanticTransition(tx, actor, run.id, {
							nodeId: command.nodeId,
							operationId: command.operationId,
							operationVersion: command.operationVersion,
							actorKind: "system",
							kind: "transition",
							beforeState: previous?.value.state ?? "pending",
							afterState: "uncertain",
							publicBindings: {},
							verification: "pending"
						}, {});
						await tx.put(key(actor, "outbox", `reconciliation:${command.commandId}`), {
							task: "reconciliation-required",
							runId: run.id,
							subjectId: run.subjectId,
							status: "pending"
						}, null);
						await tx.cancel(key(actor, "run", run.id));
						return { existing: {
							commandId: command.commandId,
							runId: run.id,
							nodeId: command.nodeId,
							revision,
							state: "uncertain",
							verified: false
						} };
					}
				}
				return { existing: {
					commandId: command.commandId,
					runId: run.id,
					nodeId: command.nodeId,
					revision: saved.revision,
					state: prior.value.state,
					verified: prior.value.state === "complete"
				} };
			}
			if (run.status !== "active" || saved.revision !== command.expectedRevision) throw new PersistenceConflict();
			const node = run.nodes.find((n) => n.id === command.nodeId);
			if (!node || node.operationId !== command.operationId || node.operationVersion !== command.operationVersion || digest(node.bindings) !== digest(command.bindings)) throw new AuthorizationError("denied");
			const ownState = await tx.get(key(actor, "node", `${run.id}:${node.id}`));
			if (ownState?.value.state === "uncertain" || ownState?.value.state === "complete" || ownState?.value.verified) throw new AuthorizationError("denied");
			const outputs = /* @__PURE__ */ new Map();
			for (const dependency of node.dependsOn) {
				const complete = await tx.get(key(actor, "node", `${run.id}:${dependency}`));
				if (!complete?.value.verified || complete.value.state !== "complete") throw new AuthorizationError("denied");
				outputs.set(dependency, complete.value.outputs);
			}
			const values = {};
			for (const [name, binding] of Object.entries(node.bindings)) {
				if (!Object.hasOwn(operation.contract.inputs, name)) throw new AuthorizationError("invalid_request");
				if (binding.from === "literal") {
					if (operation.classifications[name]?.classification !== "public") throw new AuthorizationError("denied");
					values[name] = binding.value;
				} else if (binding.from === "input") {
					if (!Object.hasOwn(run.inputs, binding.name)) throw new AuthorizationError("invalid_request");
					values[name] = run.inputs[binding.name];
				} else {
					const source = outputs.get(binding.node);
					if (!source || !Object.hasOwn(source, binding.name)) throw new AuthorizationError("denied");
					values[name] = source[binding.name];
				}
			}
			const checked = operation.inputSchema.safeParse(values);
			if (!checked.success) throw new AuthorizationError("invalid_request");
			const fence = await tx.claim(key(actor, "run", run.id), `worker-${randomUUID()}`, 6e4);
			const effectId = `effect:${randomUUID()}`;
			const record = {
				digest: intent,
				state: "running",
				effectId,
				nodeId: node.id
			};
			await tx.put(key(actor, "command", command.commandId), record, null);
			await tx.put(key(actor, "effect", effectId), {
				commandId: command.commandId,
				intent,
				status: "intent-persisted"
			}, null);
			return {
				run,
				node,
				values: checked.data,
				fence,
				effectId,
				record
			};
		});
		if (admission.existing) return admission.existing;
		const { run, node, values, fence, effectId } = admission;
		const context = {
			actor,
			runId: run.id,
			nodeId: node.id,
			commandId: command.commandId,
			effectId,
			target: run.target,
			configurationVersion: run.configurationVersion,
			origin: run.origin,
			environment: run.environment,
			signal
		};
		let result;
		let verified = false;
		try {
			if (!await this.reauthorize(actor, run, command.operationId)) throw new AuthorizationError("denied");
			signal.throwIfAborted();
			result = await operation.handler(context, values);
			if (result.state === "complete") {
				result.outputs = operation.outputSchema.parse(result.outputs);
				verified = Boolean(operation.verify && await operation.verify(context, result));
				if (!verified) result = {
					state: "failed",
					outputs: {},
					diagnosticCode: "verification-rejected"
				};
			} else result.outputs = strictObject({}).parse(result.outputs);
		} catch {
			result = {
				state: "uncertain",
				outputs: {},
				diagnosticCode: "uncertain"
			};
		}
		if (!await this.reauthorize(actor, run, command.operationId)) throw new AuthorizationError("denied");
		return this.store.transaction(async (tx) => {
			await tx.assertFence(fence);
			const current = await this.owned(tx, actor, run.id);
			if (!await this.reauthorize(actor, current.value, command.operationId, tx)) throw new AuthorizationError("denied");
			if (current.value.status !== "active" || current.revision !== command.expectedRevision) throw new PersistenceConflict();
			const nodeKey = key(actor, "node", `${run.id}:${node.id}`);
			const prior = await tx.get(nodeKey);
			await tx.put(nodeKey, {
				state: result.state,
				verified,
				outputs: result.outputs
			}, prior?.revision ?? null);
			const record = await tx.get(key(actor, "command", command.commandId));
			await tx.put(key(actor, "command", command.commandId), {
				...record.value,
				state: result.state
			}, record.revision);
			const effect = await tx.get(key(actor, "effect", effectId));
			await tx.put(key(actor, "effect", effectId), {
				commandId: command.commandId,
				status: result.state,
				verified
			}, effect.revision);
			let complete = true;
			for (const planned of run.nodes) if (!(await tx.get(key(actor, "node", `${run.id}:${planned.id}`)))?.value.verified) complete = false;
			const revision = await tx.put(key(actor, "run", run.id), {
				...run,
				status: complete ? "complete" : "active"
			}, current.revision);
			await appendSemanticTransition(tx, actor, run.id, {
				nodeId: node.id,
				operationId: node.operationId,
				operationVersion: node.operationVersion,
				actorKind: actor.actorKind,
				kind: verified ? "verification" : result.state === "awaiting-human" ? "handoff" : "transition",
				beforeState: prior?.value.state ?? "pending",
				afterState: result.state,
				publicBindings: values,
				verification: verified ? "accepted" : result.state === "failed" ? "rejected" : "pending",
				...result.diagnosticCode ? { diagnosticCode: result.diagnosticCode } : {}
			}, operation.classifications);
			if (verified) {
				const delegation = await tx.get({
					tenant: "workload",
					kind: "session",
					id: run.id
				});
				const budget = await tx.get({
					tenant: actor.tenantId,
					kind: "budget",
					id: `agent:${run.id}`
				});
				if (delegation && !delegation.value.revoked && delegation.value.expiresAt > await tx.now() && !budget?.value.stopped) await tx.put(key(actor, "outbox", `agent-wake:${run.id}:${revision}`), {
					task: "agent-wake",
					runId: run.id,
					subjectId: run.subjectId,
					status: "pending"
				}, null);
			}
			if (complete && run.continuation && !await tx.get(key(actor, "outbox", `continuation:${run.id}`))) await tx.put(key(actor, "outbox", `continuation:${run.id}`), {
				runId: run.id,
				subjectId: run.subjectId,
				task: run.continuation,
				deliveryId: `continuation:${run.id}`,
				status: "pending"
			}, null);
			await tx.cancel(key(actor, "run", run.id));
			return {
				commandId: command.commandId,
				runId: run.id,
				nodeId: node.id,
				revision,
				state: result.state,
				verified
			};
		});
	}
};
/** Delivery handlers must use the stable ID to deduplicate/reconcile their own external effect. */
async function deliverContinuations(store, actor, handlers) {
	let after = "";
	for (;;) {
		const entries = await store.transaction((tx) => tx.list(actor.tenantId, "outbox", 100, after));
		for (const entry of entries) {
			const value = entry.value;
			if (value.status !== "pending" || value.subjectId !== actor.subjectId) continue;
			const handler = handlers.get(value.task);
			if (!handler) continue;
			const fence = await store.transaction(async (tx) => {
				const current = await tx.get(key(actor, "outbox", entry.id));
				if (!current || current.value.status !== "pending") return void 0;
				return tx.claim(key(actor, "outbox", entry.id), `delivery-${randomUUID()}`, 3e4);
			}).catch((error) => {
				if (error instanceof PersistenceConflict) return void 0;
				throw error;
			});
			if (!fence) continue;
			try {
				await handler({
					runId: value.runId,
					deliveryId: value.deliveryId
				});
				await store.transaction(async (tx) => {
					await tx.assertFence(fence);
					await tx.put(key(actor, "outbox", entry.id), {
						...value,
						status: "delivered"
					}, entry.revision);
					await tx.cancel(key(actor, "outbox", entry.id));
				});
			} catch (error) {
				await store.transaction(async (tx) => {
					await tx.assertFence(fence);
					await tx.cancel(key(actor, "outbox", entry.id));
				}).catch(() => {});
				throw error;
			}
		}
		if (entries.length < 100) break;
		after = entries.at(-1).id;
	}
}
//#endregion
//#region src/server/recipes/registry.ts
/** Registry construction is a trusted host operation, never an authoring API. */
var OperationRegistry = class {
	operations = /* @__PURE__ */ new Map();
	vocabulary;
	constructor(vocabulary = /* @__PURE__ */ new Map()) {
		this.vocabulary = new Map(vocabulary);
	}
	register(operation) {
		const contract = operationContractSchema.parse(operation.contract);
		const key = `${contract.id}@${contract.version}`;
		if (this.operations.has(key)) throw new Error("Operation version already registered");
		for (const slot of [...Object.values(contract.inputs), ...Object.values(contract.outputs)]) if (!this.vocabulary.has(slot.contract)) throw new Error("Unknown registered input contract");
		this.operations.set(key, {
			...operation,
			contract
		});
	}
	get(id, version) {
		return this.operations.get(`${id}@${version}`);
	}
	require(id, version) {
		const operation = this.get(id, version);
		if (!operation) throw new Error("Unsupported operation version");
		return operation;
	}
	catalog() {
		return Array.from(this.operations.values(), ({ contract }) => operationContractSchema.parse(contract));
	}
};
//#endregion
//#region src/server/recipes/index.ts
/** Expand only trusted, pinned definitions. No expression evaluation or inferred branch. */
async function validateRecipe(definition, registry, resolve) {
	const recipe = recipeDefinitionSchema.parse(definition);
	const diagnostics = [];
	const leaves = [];
	const closure = {};
	const fail = (code, node) => diagnostics.push(node === void 0 ? { code } : {
		code,
		node
	});
	const active = /* @__PURE__ */ new Set();
	let visited = 0;
	let exhausted = false;
	async function expand(current, prefix, inputs, depth, inherited = []) {
		if (depth > RECIPE_LIMITS.depth) {
			fail("recipe-depth-limit");
			exhausted = true;
			return {};
		}
		const outputs = /* @__PURE__ */ new Map();
		const completionNodes = /* @__PURE__ */ new Map();
		const remaining = new Map(current.invocations.map((node) => [node.id, node]));
		while (remaining.size) {
			if (exhausted) break;
			if (++visited > RECIPE_LIMITS.leaves * RECIPE_LIMITS.depth) {
				fail("recipe-expansion-limit");
				exhausted = true;
				break;
			}
			const node = Array.from(remaining.values()).find((candidate) => candidate.dependsOn.every((id) => outputs.has(id)));
			if (!node) {
				fail("unresolved-dependency");
				break;
			}
			remaining.delete(node.id);
			const id = `${prefix}${node.id}`;
			const predecessors = [.../* @__PURE__ */ new Set([...inherited, ...node.dependsOn.flatMap((dependency) => completionNodes.get(dependency) ?? [])])];
			const bindings = {};
			for (const [name, binding] of Object.entries(node.bindings)) if (binding.from === "input") {
				const input = inputs[binding.name];
				if (input) bindings[name] = input;
				else fail("unbound-input", id);
			} else if (binding.from === "output") {
				const producer = outputs.get(binding.node)?.[binding.name];
				if (producer) bindings[name] = {
					from: "output",
					...producer
				};
				else fail("missing-output", id);
			} else bindings[name] = binding;
			if (node.use.kind === "recipe") {
				const key = `${node.use.id}@${node.use.version}:${node.use.digest}`;
				if (active.has(key)) {
					fail("recipe-cycle", id);
					outputs.set(node.id, {});
					continue;
				}
				try {
					const child = recipeDefinitionSchema.parse(await resolve(node.use.id, node.use.version, node.use.digest));
					if (await digestRecipeDefinition(child) !== node.use.digest) {
						fail("child-digest-mismatch", id);
						outputs.set(node.id, {});
						continue;
					}
					for (const [name, input] of Object.entries(child.inputs)) if (input.required && !bindings[name]) fail("missing-child-input", id);
					for (const name of Object.keys(bindings)) if (!Object.hasOwn(child.inputs, name)) fail("unknown-child-input", id);
					active.add(key);
					closure[key] = child;
					const firstLeaf = leaves.length;
					outputs.set(node.id, await expand(child, `${id}.`, bindings, depth + 1, predecessors));
					completionNodes.set(node.id, leaves.slice(firstLeaf).map((leaf) => leaf.id));
					active.delete(key);
				} catch {
					fail("unavailable-child", id);
					outputs.set(node.id, {});
				}
			} else {
				if (leaves.length >= RECIPE_LIMITS.leaves) {
					fail("recipe-leaf-limit", id);
					exhausted = true;
					outputs.set(node.id, {});
					continue;
				}
				const operation = registry.get(node.use.id, node.use.version);
				if (!operation) {
					fail("unsupported-operation", id);
					outputs.set(node.id, {});
					continue;
				}
				if (!operation.fixtures.length) fail("missing-operation-fixtures", id);
				if (!operation.verify) fail("missing-verifier", id);
				for (const [name, input] of Object.entries(operation.contract.inputs)) {
					const binding = bindings[name];
					const vocabulary = registry.vocabulary.get(input.contract);
					if (!binding) {
						if (input.required) fail("unbound-required-input", id);
						continue;
					}
					if (binding.from === "literal") {
						if (!vocabulary || vocabulary.classification !== "public" || !vocabulary.schema.safeParse(binding.value).success) fail("forbidden-literal", id);
					} else if (binding.from === "input") {
						if (recipe.inputs[binding.name]?.contract !== input.contract) fail("incompatible-input", id);
					} else {
						const producer = leaves.find((leaf) => leaf.id === binding.node);
						if ((producer?.use.kind === "operation" ? registry.get(producer.use.id, producer.use.version) : void 0)?.contract.outputs[binding.name]?.contract !== input.contract) fail("incompatible-output", id);
					}
				}
				for (const name of Object.keys(bindings)) if (!Object.hasOwn(operation.contract.inputs, name)) fail("unknown-operation-input", id);
				const dependsOn = predecessors;
				leaves.push({
					id,
					use: node.use,
					dependsOn,
					bindings
				});
				completionNodes.set(node.id, [id]);
				outputs.set(node.id, Object.fromEntries(Object.keys(operation.contract.outputs).map((name) => [name, {
					node: id,
					name
				}])));
			}
		}
		const result = {};
		for (const [name, output] of Object.entries(current.outputs)) {
			const producer = outputs.get(output.node)?.[output.name];
			if (producer) result[name] = producer;
			else fail("missing-declared-output");
		}
		return result;
	}
	for (const input of Object.values(recipe.inputs)) if (!registry.vocabulary.has(input.contract)) fail("unknown-input-contract");
	return {
		definition: recipe,
		leaves,
		diagnostics,
		closure,
		outputs: await expand(recipe, "", Object.fromEntries(Object.keys(recipe.inputs).map((name) => [name, {
			from: "input",
			name
		}])), 1)
	};
}
function allowed(actor, capability) {
	if (!actor.capabilities.includes(capability) && !actor.capabilities.includes("admin")) throw new Error("Recipe access denied");
}
var RecipeService = class {
	store;
	registry;
	constructor(store, registry) {
		this.store = store;
		this.registry = registry;
	}
	async composePublished(actor, references) {
		allowed(actor, "author");
		if (references.length < 2 || references.length > 32) throw new Error("Composition requires two to thirty-two recipes");
		return this.createDraft(actor, await this.composition(actor, references));
	}
	async composition(actor, references) {
		allowed(actor, "executor");
		if (!references.length || references.length > 32) throw new Error("Composition limit exceeded");
		const inputs = {};
		const invocations = [];
		const available = [];
		let finalOutputs = {};
		const parts = await Promise.all(references.map(async (reference) => {
			const published = await this.getPublished(actor, reference.id, reference.version, reference.digest);
			const validated = await this.preview(actor, published.definition);
			if (validated.diagnostics.length) throw new Error("Child recipe is not executable");
			return {
				reference,
				published,
				validated,
				contracts: Object.values(validated.outputs).map((output) => {
					const producer = validated.leaves.find((leaf) => leaf.id === output.node);
					return this.registry.require(producer.use.id, producer.use.version).contract.outputs[output.name].contract;
				})
			};
		}));
		const dependencies = new Map(parts.map((part) => [part, new Set(Object.values(part.published.definition.inputs).flatMap((input) => {
			const producers = parts.filter((candidate) => candidate !== part && candidate.contracts.filter((contract) => contract === input.contract).length > 0);
			return producers.length === 1 && producers[0].contracts.filter((contract) => contract === input.contract).length === 1 ? [producers[0]] : [];
		}))]));
		const ordered = [];
		const remaining = new Set(parts);
		while (remaining.size) {
			const ready = [...remaining].filter((part) => [...dependencies.get(part)].every((dependency) => !remaining.has(dependency))).sort((a, b) => a.reference.id.localeCompare(b.reference.id));
			if (!ready.length) throw new Error("Composition dependencies require an explicit input");
			for (const part of ready) {
				ordered.push(part);
				remaining.delete(part);
			}
		}
		for (const [index, { reference, published, validated }] of ordered.entries()) {
			const id = `part-${index + 1}`;
			const bindings = {};
			const dependsOn = /* @__PURE__ */ new Set();
			for (const [name, contract] of Object.entries(published.definition.inputs)) {
				const producers = available.filter((output) => output.contract === contract.contract);
				const candidateCount = parts.filter((part) => part.reference !== reference).reduce((count, part) => count + part.contracts.filter((output) => output === contract.contract).length, 0);
				if (producers.length === 1 && candidateCount === 1) {
					const producer = producers[0];
					bindings[name] = {
						from: "output",
						node: producer.node,
						name: producer.name
					};
					dependsOn.add(producer.node);
				} else {
					const input = `${id}.${name}`;
					inputs[input] = contract;
					bindings[name] = {
						from: "input",
						name: input
					};
				}
			}
			invocations.push({
				id,
				use: {
					kind: "recipe",
					...reference
				},
				dependsOn: [...dependsOn],
				bindings
			});
			finalOutputs = {};
			for (const [name, output] of Object.entries(validated.outputs)) {
				const producer = validated.leaves.find((leaf) => leaf.id === output.node);
				const contract = this.registry.require(producer.use.id, producer.use.version).contract.outputs[output.name];
				available.push({
					node: id,
					name,
					contract: contract.contract
				});
				finalOutputs[name] = {
					node: id,
					name
				};
			}
		}
		return recipeDefinitionSchema.parse({
			schemaVersion: 1,
			id: `recipe-${randomUUID()}`,
			title: "Combined connection steps",
			description: "Compatible reviewed procedures with fresh runtime inputs.",
			inputs,
			invocations,
			outputs: finalOutputs
		});
	}
	/** Non-effectful resolution of current tenant procedures. No author/publisher grant or model is involved. */
	async selectConnection(actor, profile) {
		allowed(actor, "executor");
		const rows = await this.store.transaction((tx) => tx.list(actor.tenantId, "recipe", 257));
		if (rows.length > 256) throw new Error("Recipe catalog exceeds automatic selection budget");
		const latest = /* @__PURE__ */ new Map();
		for (const row of rows) {
			const value = row.value;
			if (!value.definition) continue;
			const prior = latest.get(value.definition.id);
			if (!prior || value.version.localeCompare(prior.version, void 0, { numeric: true }) > 0) latest.set(value.definition.id, value);
		}
		const candidates = [];
		for (const value of latest.values()) try {
			const reference = {
				id: value.definition.id,
				version: value.version,
				digest: value.digest
			};
			const published = await this.getPublished(actor, reference.id, reference.version, reference.digest);
			const validated = await this.preview(actor, published.definition);
			if (validated.diagnostics.length || validated.leaves.some((leaf) => {
				const operation = this.registry.require(leaf.use.id, leaf.use.version).contract;
				return operation.provider !== profile.provider || operation.profile !== profile.profile;
			})) continue;
			const outputs = Object.values(validated.outputs).map((output) => {
				const leaf = validated.leaves.find((leaf) => leaf.id === output.node);
				return this.registry.require(leaf.use.id, leaf.use.version).contract.outputs[output.name].contract;
			});
			candidates.push({
				reference,
				published,
				outputs
			});
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "Recipe unavailable") throw error;
		}
		const choices = [];
		for (const target of candidates.filter((candidate) => candidate.outputs.includes(profile.outputContract))) {
			const selected = /* @__PURE__ */ new Set();
			const visiting = /* @__PURE__ */ new Set();
			const resolve = (candidate) => {
				if (selected.has(candidate)) return true;
				if (visiting.has(candidate) || selected.size + visiting.size >= 32) return false;
				visiting.add(candidate);
				for (const input of Object.values(candidate.published.definition.inputs)) {
					const producers = candidates.filter((other) => other !== candidate && other.outputs.filter((output) => output === input.contract).length === 1);
					if (producers.length !== 1 || !resolve(producers[0])) return false;
				}
				visiting.delete(candidate);
				selected.add(candidate);
				return true;
			};
			if (!resolve(target)) continue;
			try {
				const definition = await this.composition(actor, [...selected].map((candidate) => candidate.reference));
				const validated = await this.preview(actor, definition);
				if (validated.diagnostics.length || Object.keys(definition.inputs).length) continue;
				if (Object.values(validated.outputs).map((output) => {
					const leaf = validated.leaves.find((leaf) => leaf.id === output.node);
					return this.registry.require(leaf.use.id, leaf.use.version).contract.outputs[output.name].contract;
				}).includes(profile.outputContract)) choices.push({
					definition,
					leaves: validated.leaves.length,
					key: target.reference.id
				});
			} catch (error) {
				if (!(error instanceof Error) || ![
					"Recipe unavailable",
					"Child recipe is not executable",
					"Composition dependencies require an explicit input",
					"Composition limit exceeded"
				].includes(error.message)) throw error;
			}
		}
		choices.sort((a, b) => a.leaves - b.leaves || a.key.localeCompare(b.key));
		return choices[0]?.definition;
	}
	async published(tx, actor, id, version, digest) {
		const record = await tx.get({
			tenant: actor.tenantId,
			kind: "recipe",
			id: `${id}@${version}`
		});
		if (!record || record.value.retired || record.value.digest !== digest) throw new Error("Recipe unavailable");
		return record.value;
	}
	async preview(actor, definition) {
		allowed(actor, "executor");
		return validateRecipe(definition, this.registry, async (id, version, digest) => this.store.transaction(async (tx) => (await this.published(tx, actor, id, version, digest)).definition));
	}
	async createDraft(actor, definition) {
		return this.saveDraft(actor, definition, []);
	}
	async compileDraft(actor, events, selection) {
		const compiled = compileDemonstration(events, selection, this.registry);
		return this.saveDraft(actor, compiled.definition, compiled.diagnostics);
	}
	async saveDraft(actor, definition, sourceDiagnostics) {
		allowed(actor, "author");
		const parsed = recipeDefinitionSchema.parse(definition);
		const validation = await validateRecipe(parsed, this.registry, async (id, version, digest) => this.store.transaction(async (tx) => (await this.published(tx, actor, id, version, digest)).definition));
		const value = {
			definition: parsed,
			author: actor.subjectId,
			digest: await digestRecipeDefinition(parsed),
			diagnostics: [...sourceDiagnostics, ...validation.diagnostics]
		};
		const id = `draft-${randomUUID()}`;
		await this.store.transaction((tx) => tx.put({
			tenant: actor.tenantId,
			kind: "draft",
			id
		}, value, null));
		return {
			id,
			revision: 1,
			...value
		};
	}
	async getDraft(actor, id) {
		return this.store.transaction(async (tx) => {
			const record = await tx.get({
				tenant: actor.tenantId,
				kind: "draft",
				id
			});
			if (!record || record.value.author !== actor.subjectId && !actor.capabilities.some((cap) => [
				"reviewer",
				"publisher",
				"admin"
			].includes(cap))) throw new Error("Recipe unavailable");
			return {
				id,
				revision: record.revision,
				...record.value
			};
		});
	}
	async editDraft(actor, id, revision, definition) {
		allowed(actor, "author");
		const parsed = recipeDefinitionSchema.parse(definition);
		const digest = await digestRecipeDefinition(parsed);
		return this.store.transaction(async (tx) => {
			const record = await tx.get({
				tenant: actor.tenantId,
				kind: "draft",
				id
			});
			if (!record || record.value.author !== actor.subjectId) throw new Error("Recipe unavailable");
			const validation = await validateRecipe(parsed, this.registry, async (child, version, pin) => (await this.published(tx, actor, child, version, pin)).definition);
			const value = {
				definition: parsed,
				author: actor.subjectId,
				digest,
				diagnostics: validation.diagnostics
			};
			return {
				id,
				revision: await tx.put({
					tenant: actor.tenantId,
					kind: "draft",
					id
				}, value, revision),
				...value
			};
		});
	}
	async review(actor, id, revision, digest) {
		allowed(actor, "reviewer");
		return this.store.transaction(async (tx) => {
			const draft = await tx.get({
				tenant: actor.tenantId,
				kind: "draft",
				id
			});
			if (!draft || draft.revision !== revision || draft.value.digest !== digest || draft.value.diagnostics.length) throw new Error("Review does not match a valid draft");
			const key = {
				tenant: actor.tenantId,
				kind: "review",
				id: `${id}:${revision}`
			};
			const previous = await tx.get(key);
			await tx.put(key, {
				digest,
				reviewer: actor.subjectId
			}, previous?.revision ?? null);
		});
	}
	async publish(actor, id, revision, digest) {
		allowed(actor, "publisher");
		return this.store.transaction(async (tx) => {
			const draft = await tx.get({
				tenant: actor.tenantId,
				kind: "draft",
				id
			});
			const review = await tx.get({
				tenant: actor.tenantId,
				kind: "review",
				id: `${id}:${revision}`
			});
			if (!draft || draft.revision !== revision || draft.value.digest !== digest || review?.value.digest !== digest) throw new Error("Publication requires current review");
			const validation = await validateRecipe(draft.value.definition, this.registry, async (child, version, pin) => (await this.published(tx, actor, child, version, pin)).definition);
			if (validation.diagnostics.length) throw new Error("Recipe is not executable");
			const counterKey = {
				tenant: actor.tenantId,
				kind: "session",
				id: `${draft.value.definition.id}@counter`
			};
			const counter = await tx.get(counterKey);
			const next = counter?.value.next ?? 1;
			const version = `1.0.${next}`;
			await tx.put(counterKey, { next: next + 1 }, counter?.revision ?? null);
			const value = {
				definition: draft.value.definition,
				version,
				digest,
				closure: validation.closure,
				retired: false,
				publisher: actor.subjectId
			};
			await tx.put({
				tenant: actor.tenantId,
				kind: "recipe",
				id: `${value.definition.id}@${version}`
			}, value, null);
			return value;
		});
	}
	async getPublished(actor, id, version, digest) {
		allowed(actor, "executor");
		return this.store.transaction(async (tx) => {
			const value = await this.published(tx, actor, id, version, digest);
			for (const key of Object.keys(value.closure)) {
				const split = key.lastIndexOf(":");
				const reference = key.slice(0, split);
				const at = reference.lastIndexOf("@");
				await this.published(tx, actor, reference.slice(0, at), reference.slice(at + 1), key.slice(split + 1));
			}
			return value;
		});
	}
	async retire(actor, id, version) {
		allowed(actor, "admin");
		await this.store.transaction(async (tx) => {
			const key = {
				tenant: actor.tenantId,
				kind: "recipe",
				id: `${id}@${version}`
			};
			const value = await tx.get(key);
			if (!value) throw new Error("Recipe unavailable");
			await tx.put(key, {
				...value.value,
				retired: true
			}, value.revision);
		});
	}
};
/** Selected events must be a contiguous server sequence range; observed values never become defaults. */
function compileDemonstration(events, selection, registry) {
	if (!Number.isSafeInteger(selection.first) || !Number.isSafeInteger(selection.last) || selection.last < selection.first || events.length > 1e3) throw new Error("Invalid demonstration selection");
	const selected = events.map((event) => demonstrationEventSchema.parse(event)).filter((event) => event.sequence >= selection.first && event.sequence <= selection.last).sort((a, b) => a.sequence - b.sequence);
	if (!selected.length || selected[0].sequence !== selection.first || selected.at(-1).sequence !== selection.last || selected.some((event, index) => index > 0 && event.sequence !== selected[index - 1].sequence + 1)) throw new Error("Selection must be contiguous");
	if (new Set(selected.map((event) => event.demonstrationId)).size !== 1) throw new Error("Mixed demonstrations");
	const diagnostics = [];
	const inputs = {};
	const invocations = [];
	const recorded = /* @__PURE__ */ new Set();
	const produced = [];
	for (const event of selected) {
		if (event.kind === "failure") {
			diagnostics.push({ code: "observed-failure" });
			continue;
		}
		if (event.kind !== "verification" || event.verification !== "accepted" || recorded.has(event.nodeId)) continue;
		const operation = registry.get(event.operationId, event.operationVersion);
		if (!operation) {
			diagnostics.push({ code: "unsupported-operation" });
			continue;
		}
		recorded.add(event.nodeId);
		const id = `step-${invocations.length + 1}`;
		const bindings = {};
		for (const [name, contract] of Object.entries(operation.contract.inputs)) {
			const candidates = produced.filter((output) => output.contract === contract.contract);
			if (candidates.length === 1) {
				const producer = candidates[0];
				bindings[name] = {
					from: "output",
					node: producer.node,
					name: producer.name
				};
				continue;
			}
			const parameter = `${id}.${name}`;
			inputs[parameter] = contract;
			bindings[name] = {
				from: "input",
				name: parameter
			};
		}
		invocations.push({
			id,
			use: {
				kind: "operation",
				id: operation.contract.id,
				version: operation.contract.version
			},
			dependsOn: [.../* @__PURE__ */ new Set([...invocations.length ? [invocations.at(-1).id] : [], ...Object.values(bindings).filter((binding) => binding.from === "output").map((binding) => binding.node)])],
			bindings
		});
		for (const [name, contract] of Object.entries(operation.contract.outputs)) produced.push({
			node: id,
			name,
			contract: contract.contract
		});
	}
	if (!invocations.length) throw new Error("No verified executable boundary");
	if (selected.at(-1).verification !== "accepted") diagnostics.push({ code: "incomplete-ending" });
	const final = invocations.at(-1);
	const operation = registry.require(final.use.id, final.use.version);
	return {
		definition: recipeDefinitionSchema.parse({
			schemaVersion: 1,
			id: `recipe-${randomUUID()}`,
			title: "Reusable connection step",
			description: "Reviewed semantic operations with fresh runtime inputs.",
			inputs,
			invocations,
			outputs: Object.fromEntries(Object.keys(operation.contract.outputs).map((name) => [name, {
				node: final.id,
				name
			}]))
		}),
		diagnostics
	};
}
//#endregion
//#region src/server/agent/model.ts
/** No implicit gateway, model name, or ambient paid routing. */
function configuredModel(config) {
	if (!config.model && !config.endpoint && !config.gateway) return void 0;
	if (!config.model || config.model.length > 200 || config.gateway && config.endpoint) throw new Error("Invalid model configuration");
	if (config.gateway) return createGateway(config.apiKey ? { apiKey: config.apiKey } : {})(config.model);
	if (!config.endpoint) throw new Error("Model endpoint is required");
	const endpoint = new URL(config.endpoint);
	if (endpoint.username || endpoint.password || endpoint.hash || endpoint.search || endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && [
		"127.0.0.1",
		"localhost",
		"[::1]"
	].includes(endpoint.hostname)) || !endpoint.pathname.endsWith("/chat/completions")) throw new Error("Invalid model endpoint");
	const baseURL = endpoint.href.slice(0, -17);
	return createOpenAICompatible({
		name: "ceremony-configured",
		baseURL,
		...config.apiKey ? { apiKey: config.apiKey } : {},
		fetch: (url, init) => {
			if (String(url) !== endpoint.href) throw new Error("Model endpoint mismatch");
			return fetch(url, {
				...init,
				redirect: "error"
			});
		}
	}).chatModel(config.model);
}
/** Rejected text is neither returned nor logged. This heuristic cannot identify arbitrary passwords. */
function validateAgentText(text, protectedValues = []) {
	if (text.length > 2e3 || /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+|\bgh[pousr]_[A-Za-z0-9]+|\bgithub_pat_[A-Za-z0-9_]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\bBearer\s+\S+)/i.test(text) || protectedValues.some((value) => value.length > 0 && text.includes(value))) throw new Error("Use private collection for credentials");
	return text;
}
//#endregion
//#region src/server/agent/coordinator.ts
const empty = () => ({
	calls: 0,
	tools: 0,
	stopped: false,
	turns: {}
});
const safeId = string().regex(/^[A-Za-z0-9_.:-]{1,120}$/);
var AgentCoordinator = class {
	store;
	commands;
	model;
	constructor(store, commands, model) {
		this.store = store;
		this.commands = commands;
		this.model = model;
	}
	key(actor, runId) {
		return {
			tenant: actor.tenantId,
			kind: "budget",
			id: `agent:${safeId.parse(runId)}`
		};
	}
	async status(actor, runId, turnId) {
		const run = await this.commands.snapshot(actor, runId);
		const budget = await this.store.transaction((tx) => tx.get(this.key(actor, runId)));
		return {
			status: run.status === "cancelled" || budget?.value.stopped ? "stopped" : run.status === "complete" ? "complete" : budget?.value.turns[turnId ?? Object.keys(budget?.value.turns ?? {}).at(-1) ?? ""]?.status ?? "idle",
			calls: budget?.value.calls ?? 0,
			tools: budget?.value.tools ?? 0
		};
	}
	async stop(actor, runId) {
		requireCapability(actor, "executor");
		await this.commands.snapshot(actor, runId);
		await this.store.transaction(async (tx) => {
			const key = this.key(actor, runId), prior = await tx.get(key);
			await tx.put(key, {
				...prior?.value ?? empty(),
				stopped: true
			}, prior?.revision ?? null);
		});
	}
	async update(actor, runId, turnId, calls, tools, status) {
		if (!await this.store.transaction(async (tx) => {
			const key = this.key(actor, runId), prior = await tx.get(key);
			const value = prior?.value ?? empty();
			const turn = value.turns[turnId] ?? {
				calls: 0,
				tools: 0,
				status: "idle"
			};
			if (value.stopped) throw new Error("stopped");
			if (status === "running" && turn.status !== "idle") throw new Error("uncertain");
			const exceeded = value.calls + calls > 16 || value.tools + tools > 64 || turn.tools + tools > 8 || Object.keys(value.turns).length > 64;
			if (!exceeded) value.calls += calls;
			value.tools += tools;
			if (!exceeded) turn.calls += calls;
			turn.tools += tools;
			if (exceeded) turn.status = "budget-exhausted";
			else if (status) turn.status = status;
			value.turns[turnId] = turn;
			await tx.put(key, value, prior?.revision ?? null);
			return !exceeded;
		})) throw new Error("budget-exhausted");
	}
	/** Receives no narration, secret fields, URLs, broker handles or user-authored transcript. */
	async turn(actor, runId, turnId) {
		safeId.parse(turnId);
		requireCapability(actor, "executor");
		const initial = await this.commands.snapshot(actor, runId);
		if (initial.status === "complete") return "complete";
		if (initial.status === "cancelled") return "stopped";
		const existing = await this.status(actor, runId, turnId);
		if (existing.status === "stopped") return "stopped";
		if (initial.nodes.some((node) => [
			"awaiting-human",
			"verifying",
			"uncertain"
		].includes(node.state))) {
			await this.update(actor, runId, turnId, 0, 0, "awaiting-human");
			return "awaiting-human";
		}
		if (!this.model) return "unavailable";
		if (existing.status !== "idle") return existing.status === "running" ? "uncertain" : existing.status;
		try {
			await this.update(actor, runId, turnId, 0, 0, "running");
		} catch {
			return "uncertain";
		}
		let terminal = "idle";
		const agent = new ToolLoopAgent({
			model: this.model,
			maxRetries: 0,
			maxOutputTokens: 1e3,
			instructions: "Complete the already-authorized connection using only advance. Use exact pending node IDs and revision from state. Stop at any human wait, verification wait, uncertainty, or completion. Never infer permission or invent inputs.",
			tools: { advance: tool({
				description: "Advance a registered node using server-pinned authorized bindings. Human waits are not approvals.",
				inputSchema: strictObject({
					nodeId: safeId,
					expectedRevision: number().int().min(1)
				}),
				execute: async (input, options) => {
					if (terminal !== "idle") return {
						state: "awaiting-human",
						verified: false
					};
					await this.update(actor, runId, turnId, 0, 0);
					const commandId = `agent:${createHash("sha256").update(JSON.stringify([
						runId,
						turnId,
						options.toolCallId
					])).digest("hex")}`;
					try {
						const result = await this.commands.advance({
							...actor,
							actorKind: "agent"
						}, runId, input.nodeId, input.expectedRevision, commandId);
						if (result.state === "awaiting-human" || result.state === "verifying") terminal = "awaiting-human";
						if (result.state === "uncertain") terminal = "uncertain";
						if ((await this.commands.snapshot(actor, runId)).status === "complete") terminal = "complete";
						return {
							state: result.state,
							verified: result.verified,
							revision: result.revision
						};
					} catch {
						return {
							state: "denied",
							verified: false
						};
					}
				}
			}) },
			prepareStep: async () => {
				await this.update(actor, runId, turnId, 1, 0);
				const snapshot = await this.commands.snapshot(actor, runId);
				for (const value of [
					snapshot.id,
					snapshot.provider,
					snapshot.profile,
					...snapshot.nodes.flatMap((node) => [
						node.id,
						node.operationId,
						node.operationVersion
					])
				]) validateAgentText(value);
				return { messages: [{
					role: "user",
					content: JSON.stringify(snapshot)
				}] };
			},
			onLanguageModelCallEnd: async (event) => {
				await this.update(actor, runId, turnId, 0, event.content.filter((part) => part.type === "tool-call").length);
			},
			stopWhen: [isStepCount(8), () => terminal !== "idle"],
			telemetry: { isEnabled: false }
		});
		try {
			await agent.generate({
				prompt: "Connect this service using the trusted current state.",
				abortSignal: AbortSignal.timeout(3e4)
			});
			if ((await this.commands.snapshot(actor, runId)).status === "complete") terminal = "complete";
			if (terminal === "idle") terminal = "awaiting-human";
		} catch {
			const state = (await this.status(actor, runId, turnId)).status;
			terminal = state === "stopped" || state === "budget-exhausted" ? state : "unavailable";
		}
		if (terminal !== "stopped" && terminal !== "budget-exhausted") await this.update(actor, runId, turnId, 0, 0, terminal);
		return terminal;
	}
};
//#endregion
//#region src/server/teaching-runtime.ts
const githubConnectionRecipe = {
	schemaVersion: 1,
	id: "github-connect",
	title: "Connect GitHub",
	description: "Reuse or prepare an app, obtain installation consent, and verify access.",
	inputs: {},
	invocations: [
		{
			id: "app",
			use: {
				kind: "operation",
				id: "github.prepare-app",
				version: "1.0.0"
			},
			dependsOn: [],
			bindings: {}
		},
		{
			id: "installation",
			use: {
				kind: "operation",
				id: "github.authorize-installation",
				version: "1.0.0"
			},
			dependsOn: ["app"],
			bindings: { app: {
				from: "output",
				node: "app",
				name: "app"
			} }
		},
		{
			id: "access",
			use: {
				kind: "operation",
				id: "github.verify-access",
				version: "1.0.0"
			},
			dependsOn: ["installation"],
			bindings: { installation: {
				from: "output",
				node: "installation",
				name: "installation"
			} }
		}
	],
	outputs: { connection: {
		node: "access",
		name: "connection"
	} }
};
function createTeachingRuntime(options) {
	const { store, registry, identity, origin } = options;
	const connections = new Map(options.connections ?? [["github", {
		definition: githubConnectionRecipe,
		outputContract: "github.connection",
		revalidateOperation: "github.verify-access"
	}]]);
	function connection(connectorId) {
		const registered = connections.get(connectorId);
		if (!registered) throw new AuthorizationError("invalid_request");
		return registered;
	}
	const commands = new ProtectedCommandService(store, registry, async (actor, run, operationId, tx) => {
		if (!tx && !await options.authorize(actor, run, operationId)) return false;
		if (actor.actorKind !== "agent") return true;
		const check = async (transaction) => {
			const delegation = await transaction.get({
				tenant: "workload",
				kind: "session",
				id: run.id
			});
			const budget = await transaction.get({
				tenant: actor.tenantId,
				kind: "budget",
				id: `agent:${run.id}`
			});
			return Boolean(delegation && !delegation.value.revoked && delegation.value.expiresAt > await transaction.now() && delegation.value.runId === run.id && delegation.value.actor.tenantId === actor.tenantId && delegation.value.actor.subjectId === actor.subjectId && delegation.value.actor.sessionId === actor.sessionId && !budget?.value.stopped);
		};
		return tx ? check(tx) : store.transaction(check);
	});
	const recipes = new RecipeService(store, registry);
	const demonstrations = new Demonstrations(store);
	const modelConfiguration = options.modelConfiguration ?? {};
	const agent = new AgentCoordinator(store, commands, configuredModel(modelConfiguration));
	async function executeRecipe(actor, definition, inputs, connectorId) {
		connection(connectorId);
		const checked = await recipes.preview(actor, definition);
		if (checked.diagnostics.length) throw new AuthorizationError("invalid_request");
		for (const [name, value] of Object.entries(inputs)) {
			const contract = definition.inputs[name];
			const vocabulary = contract && registry.vocabulary.get(contract.contract);
			if (!vocabulary || vocabulary.classification !== "public" || !vocabulary.schema.safeParse(value).success) throw new AuthorizationError("denied");
		}
		const nodes = checked.leaves.map((n) => ({
			id: n.id,
			operationId: n.use.id,
			operationVersion: n.use.version,
			dependsOn: n.dependsOn,
			bindings: n.bindings
		}));
		return commands.createRun(actor, await options.context(actor, connectorId), nodes, inputs, options.continuation?.id);
	}
	async function connect(actor, connectorId, fresh = true) {
		requireCapability(actor, "executor");
		const registered = connection(connectorId);
		const context = await options.context(actor, connectorId);
		const existing = await store.transaction(async (tx) => {
			let after = "";
			for (;;) {
				const page = await tx.list(actor.tenantId, "run", 1e3, after);
				const match = page.find((r) => r.value.subjectId === actor.subjectId && r.value.continuation === options.continuation?.id && r.value.status !== "cancelled" && Object.entries(context).every(([k, v]) => Reflect.get(r.value, k) === v));
				if (match || page.length < 1e3) return match;
				after = page.at(-1).id;
			}
		});
		if (existing && await options.authorize(actor, existing.value, registered.revalidateOperation)) return fresh ? commands.revalidate(actor, existing.id) : commands.snapshot(actor, existing.id);
		return executeRecipe(actor, await recipes.selectConnection(actor, {
			provider: context.provider,
			profile: context.profile,
			outputContract: registered.outputContract
		}) ?? registered.definition, {}, connectorId);
	}
	async function flushContinuations(actor) {
		if (!options.continuation) return;
		const continuation = options.continuation;
		await deliverContinuations(store, actor, /* @__PURE__ */ new Map([[continuation.id, async (input) => {
			const record = await store.transaction((tx) => tx.get({
				tenant: actor.tenantId,
				kind: "run",
				id: input.runId
			}));
			if (!record || record.value.subjectId !== actor.subjectId || record.value.status !== "complete" || record.value.continuation !== continuation.id || !await options.authorize(actor, record.value, "continuation")) throw new AuthorizationError("denied");
			await continuation.handler(input);
		}]]));
	}
	async function delegate(actor, runId) {
		requireCapability(actor, "executor");
		await commands.snapshot(actor, runId);
		const initial = await store.transaction((tx) => tx.get({
			tenant: actor.tenantId,
			kind: "run",
			id: runId
		}));
		if (!initial || initial.value.status === "cancelled" || !await options.authorize(actor, initial.value, "agent")) throw new AuthorizationError("denied");
		const id = `turn:${randomUUID()}`;
		await store.transaction(async (tx) => {
			const run = await tx.get({
				tenant: actor.tenantId,
				kind: "run",
				id: runId
			});
			const budget = await tx.get({
				tenant: actor.tenantId,
				kind: "budget",
				id: `agent:${runId}`
			});
			if (!run || run.value.subjectId !== actor.subjectId || run.value.status === "cancelled" || run.revision !== initial.revision || budget?.value.stopped) throw new AuthorizationError("denied");
			const recordKey = {
				tenant: "workload",
				kind: "session",
				id: runId
			};
			const existing = await tx.get(recordKey);
			await tx.put(recordKey, {
				actor,
				runId,
				expiresAt: await tx.now() + 36e5,
				revoked: false
			}, existing?.revision ?? null);
		});
		return id;
	}
	async function agentActor(runId) {
		const delegation = await store.transaction(async (tx) => {
			const record = await tx.get({
				tenant: "workload",
				kind: "session",
				id: runId
			});
			if (!record || record.value.revoked || record.value.expiresAt <= await tx.now()) throw new AuthorizationError("denied");
			return record.value;
		});
		const run = await store.transaction((tx) => tx.get({
			tenant: delegation.actor.tenantId,
			kind: "run",
			id: runId
		}));
		if (!run || !await options.authorize(delegation.actor, run.value, "agent")) throw new AuthorizationError("denied");
		return {
			...delegation.actor,
			actorKind: "agent"
		};
	}
	async function connectForAgent(actor, connectorId) {
		const selected = await connect(actor, connectorId, false);
		await delegate(actor, selected.id);
		const delegated = await agentActor(selected.id);
		return {
			run: await commands.revalidate(delegated, selected.id),
			actor: delegated
		};
	}
	return {
		store,
		registry,
		identity,
		origin,
		connectors: Object.freeze([...connections.keys()]),
		commands,
		recipes,
		demonstrations,
		agent,
		modelConfiguration,
		connect,
		connectForAgent,
		executeRecipe,
		delegate,
		agentActor,
		human: options.human,
		humanReturn: options.humanReturn,
		cancel: options.cancel,
		selectTarget: options.selectTarget,
		flushContinuations
	};
}
//#endregion
//#region src/server/recipes/github.ts
const appSchema = object({
	id: number().int().positive(),
	slug: string().regex(/^[a-zA-Z0-9-]+$/),
	pem: string().min(1).max(3e4),
	owner: object({ login: string().min(1).max(100) })
});
const installationReturnPath = "/api/v1/teaching/github/installation-return";
const returnKey = (tenant, nonce) => ({
	tenant,
	kind: "handoff",
	id: `github-return:${createHash("sha256").update(nonce).digest("hex")}`
});
/** Routing only, not approval. The run handler must still authorize and verify the installation. */
async function resolveGitHubInstallationRun(store, actor, origin, url) {
	const nonce = url.searchParams.get("state");
	if (actor.actorKind !== "human" || url.origin !== origin || url.pathname !== installationReturnPath || !nonce || !/^[A-Za-z0-9_-]{43}$/.test(nonce) || url.searchParams.getAll("state").length !== 1) throw new Error("GitHub return unavailable");
	return store.transaction(async (tx) => {
		const record = await tx.get(returnKey(actor.tenantId, nonce));
		if (!record || record.value.subject !== actor.subjectId || record.value.origin !== origin || record.value.expires <= await tx.now()) throw new Error("GitHub return unavailable");
		return record.value.runId;
	});
}
const slot$1 = (contract) => ({
	contract,
	required: true
});
const githubVocabulary = new Map([
	"app",
	"installation",
	"connection"
].map((kind) => [`github.${kind}`, {
	schema: string().regex(/^github-[a-f0-9]{64}$/),
	classification: "artifact",
	provider: "github",
	profile: "github-app"
}]));
/** Registered children use the same official manifest, app JWT and installation APIs as the legacy adapter. */
var AsyncGitHubChildren = class {
	store;
	options;
	constructor(store, options) {
		this.store = store;
		this.options = options;
		const url = new URL(options.origin);
		if (url.origin !== options.origin || url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1") || options.expectedAccount !== void 0 && !/^[a-zA-Z0-9-]{1,100}$/.test(options.expectedAccount)) throw new Error("Invalid trusted GitHub configuration");
		if (options.app) appSchema.parse(options.app);
	}
	scope(context) {
		if (context.origin !== this.options.origin || context.environment !== this.options.environment || context.configurationVersion !== this.options.configurationVersion || !/^[a-zA-Z0-9-]{1,100}$/.test(context.target) || this.options.expectedAccount !== void 0 && context.target.toLowerCase() !== this.options.expectedAccount.toLowerCase()) throw new Error("GitHub context unavailable");
		return createHash("sha256").update(JSON.stringify([
			context.actor.tenantId,
			context.actor.subjectId,
			"github",
			"github-app",
			context.origin,
			context.environment,
			context.configurationVersion,
			context.target.toLowerCase(),
			"contents:read",
			this.options.app?.id ?? null
		])).digest("hex");
	}
	key(context) {
		return {
			tenant: context.actor.tenantId,
			kind: "handoff",
			id: `github:${context.runId}`
		};
	}
	setupKey(context) {
		return {
			tenant: context.actor.tenantId,
			kind: "handoff",
			id: `github-setup:${this.scope(context)}`
		};
	}
	artifactKey(context, kind) {
		return {
			tenant: context.actor.tenantId,
			kind: "artifact",
			id: `github-${createHash("sha256").update(`${this.scope(context)}:${kind}`).digest("hex")}`
		};
	}
	async read(context) {
		await this.options.authorize(context);
		const record = await this.store.transaction(async (tx) => {
			const local = await tx.get(this.key(context));
			if (local?.value.sharedSetup && local.value.phase !== "cancelled") {
				const shared = await tx.get(this.setupKey(context));
				if (!shared?.value.subscribers?.includes(context.runId)) throw new Error("GitHub subscription unavailable");
				return shared;
			}
			return local;
		});
		if (!record || record.value.scope !== this.scope(context)) throw new Error("GitHub handoff unavailable");
		return record;
	}
	async api(context, path, token, body) {
		await this.options.authorize(context);
		try {
			return (await request(`https://api.github.com${path}`, {
				method: body === void 0 ? "GET" : "POST",
				headers: {
					accept: "application/vnd.github+json",
					"x-github-api-version": "2022-11-28",
					...token ? { authorization: `Bearer ${token}` } : {}
				},
				...body === void 0 ? {} : { data: body },
				request: {
					fetch: this.options.fetch ?? fetch,
					redirect: "error",
					signal: AbortSignal.any([context.signal, AbortSignal.timeout(15e3)])
				}
			})).data;
		} catch {
			throw new Error("GitHub verification unavailable");
		}
	}
	async jwt(app) {
		return (await createAppAuth({
			appId: String(app.id),
			privateKey: app.pem
		})({ type: "app" })).token;
	}
	async verifyApp(context, app) {
		const checked = object({
			id: number(),
			slug: string(),
			owner: object({ login: string() }),
			permissions: record(string(), string())
		}).parse(await this.api(context, "/app", await this.jwt(app)));
		if (checked.id !== app.id || checked.slug !== app.slug || checked.owner.login.toLowerCase() !== app.owner.login.toLowerCase() || checked.owner.login.toLowerCase() !== context.target.toLowerCase() || !["read", "write"].includes(checked.permissions.contents ?? "")) throw new Error("GitHub app verification rejected");
	}
	async artifact(context, kind, supplied) {
		const key = this.artifactKey(context, kind);
		if (supplied !== void 0 && supplied !== key.id) throw new Error("GitHub artifact unavailable");
		return this.store.transaction(async (tx) => {
			const record = await tx.get(key);
			return record && record.value.scope === this.scope(context) && record.value.kind === kind && record.value.expires > await tx.now() ? record.value : void 0;
		});
	}
	async saveArtifact(context, value) {
		await this.options.authorize(context);
		const key = this.artifactKey(context, value.kind);
		await this.store.transaction(async (tx) => {
			if ((await tx.get(this.key(context)))?.value.phase === "cancelled") throw new Error("GitHub run cancelled");
			const old = await tx.get(key);
			await tx.put(key, value, old?.revision ?? null);
		});
		return key.id;
	}
	result(kind, id) {
		return {
			state: "complete",
			outputs: { [kind]: id }
		};
	}
	register(registry) {
		const operations = [
			{
				id: "prepare-app",
				kind: "app",
				input: void 0,
				handler: (context) => this.prepare(context)
			},
			{
				id: "authorize-installation",
				kind: "installation",
				input: "app",
				handler: (context, inputs) => this.install(context, inputs.app)
			},
			{
				id: "verify-access",
				kind: "connection",
				input: "installation",
				handler: (context, inputs) => this.verifyAccess(context, inputs.installation)
			}
		];
		for (const operation of operations) registry.register({
			contract: {
				id: `github.${operation.id}`,
				version: "1.0.0",
				provider: "github",
				profile: "github-app",
				inputs: operation.input ? { [operation.input]: slot$1(`github.${operation.input}`) } : {},
				outputs: { [operation.kind]: slot$1(`github.${operation.kind}`) },
				effects: [`github.${operation.id}`],
				verifier: `github.verify-${operation.kind}`,
				humanFallback: "github.own-browser"
			},
			inputSchema: object(operation.input ? { [operation.input]: string() } : {}).strict(),
			outputSchema: object({ [operation.kind]: string() }).strict(),
			classifications: {},
			fixtures: ["tests/github-children.test.ts"],
			handler: operation.handler,
			verify: async (context, result) => {
				if (result.state !== "complete") return false;
				const artifact = await this.artifact(context, operation.kind, result.outputs[operation.kind]);
				if (!artifact) return false;
				await this.verifyApp(context, artifact.app);
				if (artifact.installation) await this.checkInstallation(context, artifact.app, artifact.installation);
				if (operation.kind === "connection") {
					if (!artifact.token) return false;
					object({
						total_count: number().int().nonnegative(),
						repositories: array(object({ id: number() }))
					}).parse(await this.api(context, "/installation/repositories?per_page=1", artifact.token));
				}
				return true;
			}
		});
	}
	async prepare(context, admissionAttempt = 0) {
		await this.options.authorize(context);
		let app = (await this.artifact(context, "app"))?.app ?? this.options.app;
		const previous = await this.store.transaction(async (tx) => {
			const local = await tx.get(this.key(context));
			return local?.value.sharedSetup && local.value.phase !== "cancelled" ? await tx.get(this.setupKey(context)) : local;
		});
		if (previous && previous.value.scope !== this.scope(context)) throw new Error("GitHub context changed");
		if (previous?.value.phase === "cancelled") throw new Error("GitHub run cancelled");
		app ??= previous?.value.app;
		if (app) {
			await this.verifyApp(context, app);
			const id = await this.saveArtifact(context, {
				scope: this.scope(context),
				kind: "app",
				app,
				expires: Date.now() + 36e5
			});
			return this.result("app", id);
		}
		if (previous?.value.phase === "registration" && previous.value.expires <= await this.store.transaction((tx) => tx.now())) {
			await this.store.transaction(async (tx) => {
				const key = (await tx.get(this.key(context)))?.value.sharedSetup ? this.setupKey(context) : this.key(context);
				const next = previous.value.handoffIssued ? {
					...previous.value,
					phase: "uncertain",
					nonce: "consumed"
				} : {
					...previous.value,
					nonce: randomBytes(32).toString("base64url"),
					expires: await tx.now() + 36e5
				};
				await tx.put(key, next, previous.revision);
			});
			return this.prepare(context, admissionAttempt);
		}
		if (previous) return {
			state: ["converting", "uncertain"].includes(previous.value.phase) ? "uncertain" : "awaiting-human",
			outputs: {}
		};
		try {
			await this.store.transaction(async (tx) => {
				const existingLocal = await tx.get(this.key(context));
				if (existingLocal?.value.phase === "cancelled") throw new Error("GitHub run cancelled");
				const setupKey = this.setupKey(context);
				const existing = await tx.get(setupKey);
				if (existing?.value.phase === "cancelled" && !existing.value.restartable) throw new Error("GitHub setup requires reconciliation");
				const subscribers = Array.from(/* @__PURE__ */ new Set([...existing?.value.subscribers ?? [], context.runId]));
				if (subscribers.length > 32) throw new Error("GitHub setup subscriber limit");
				const shared = (existing?.value.phase !== "cancelled" ? existing?.value : void 0) ?? {
					scope: this.scope(context),
					phase: "registration",
					nonce: randomBytes(32).toString("base64url"),
					expires: await tx.now() + 36e5
				};
				await tx.put(setupKey, {
					...shared,
					subscribers
				}, existing?.revision ?? null);
				await tx.put(this.key(context), {
					...shared,
					sharedSetup: setupKey.id
				}, existingLocal?.revision ?? null);
			});
		} catch (error) {
			if (error instanceof PersistenceConflict && admissionAttempt < 2) return this.prepare(context, admissionAttempt + 1);
			throw error;
		}
		return this.prepare(context, admissionAttempt);
	}
	async install(context, appRef) {
		await this.options.authorize(context);
		const app = await this.artifact(context, "app", appRef);
		if (!app) throw new Error("Verified app prerequisite unavailable");
		await this.verifyApp(context, app.app);
		if (await this.artifact(context, "installation")) return this.result("installation", this.artifactKey(context, "installation").id);
		await this.store.transaction(async (tx) => {
			const previous = await tx.get(this.key(context));
			if (previous?.value.scope !== void 0 && previous.value.scope !== this.scope(context)) throw new Error("GitHub context changed");
			if (previous?.value.phase === "cancelled") throw new Error("GitHub run cancelled");
			if (previous?.value.phase === "installation" && previous.value.expires > await tx.now()) return;
			const nonce = randomBytes(32).toString("base64url");
			const expires = await tx.now() + 36e5;
			await tx.put(this.key(context), {
				scope: this.scope(context),
				phase: "installation",
				app: app.app,
				nonce,
				expires
			}, previous?.revision ?? null);
			await tx.put(returnKey(context.actor.tenantId, nonce), {
				subject: context.actor.subjectId,
				runId: context.runId,
				origin: this.options.origin,
				expires
			}, null);
		});
		return {
			state: "awaiting-human",
			outputs: {}
		};
	}
	/** Only the authenticated human route may render this projection; never serialize it into model/tool state. */
	async human(context) {
		const { value: state } = await this.read(context);
		if (state.expires <= Date.now()) throw new Error("GitHub handoff expired");
		const callback = `${this.options.origin}/api/v1/teaching/github/${encodeURIComponent(context.runId)}/callback`;
		if (state.phase === "registration") {
			const account = object({
				login: string(),
				type: _enum(["User", "Organization"])
			}).parse(await this.api(context, `/users/${encodeURIComponent(context.target)}`));
			if (account.login.toLowerCase() !== context.target.toLowerCase()) throw new Error("GitHub target unavailable");
			await this.store.transaction(async (tx) => {
				const local = await tx.get(this.key(context));
				if (local?.value.phase === "cancelled") throw new Error("GitHub run cancelled");
				const key = local?.value.sharedSetup ? this.setupKey(context) : this.key(context);
				const current = await tx.get(key);
				if (!current || current.value.phase !== "registration" || current.value.nonce !== state.nonce) throw new Error("GitHub handoff unavailable");
				await tx.put(key, {
					...current.value,
					handoffIssued: true
				}, current.revision);
			});
			return {
				method: "POST",
				url: `https://github.com${account.type === "Organization" ? `/organizations/${encodeURIComponent(context.target)}` : ""}/settings/apps/new?state=${encodeURIComponent(state.nonce)}`,
				manifest: {
					name: `Ceremony connection ${createHash("sha256").update(state.nonce).digest("hex").slice(0, 12)}`,
					url: this.options.origin,
					redirect_url: callback,
					setup_url: `${this.options.origin}${installationReturnPath}`,
					setup_on_update: true,
					public: false,
					default_permissions: { contents: "read" },
					default_events: []
				}
			};
		}
		if (state.phase === "installation" && state.app) return {
			method: "GET",
			url: `https://github.com/apps/${state.app.slug}/installations/new?state=${encodeURIComponent(state.nonce)}`
		};
		throw new Error("GitHub human action unavailable");
	}
	/** Server-only callback routing: a cancelled parent grants nothing; a surviving subscriber is authorized afresh. */
	async activeSetupSubscriber(context, url) {
		const setupKey = this.setupKey(context);
		const candidates = await this.store.transaction(async (tx) => {
			const local = await tx.get(this.key(context));
			const shared = await tx.get(setupKey);
			if (local?.value.sharedSetup !== setupKey.id || local.value.scope !== this.scope(context) || !shared || shared.value.phase !== "registration" || shared.value.expires <= await tx.now() || shared.value.nonce !== url.searchParams.get("state") || url.origin !== this.options.origin || url.pathname !== `/api/v1/teaching/github/${encodeURIComponent(context.runId)}/callback`) throw new Error("GitHub callback unavailable");
			return shared.value.subscribers ?? [];
		});
		for (const runId of candidates) {
			const next = {
				...context,
				runId
			};
			try {
				await this.options.authorize(next);
				const local = await this.store.transaction((tx) => tx.get(this.key(next)));
				if (local?.value.phase !== "cancelled" && local?.value.sharedSetup === setupKey.id) return runId;
			} catch {}
		}
		throw new Error("GitHub callback unavailable");
	}
	async callback(context, url) {
		const record = await this.read(context);
		const state = record.value;
		if (url.origin !== this.options.origin || url.pathname !== `/api/v1/teaching/github/${encodeURIComponent(context.runId)}/callback` || url.searchParams.get("state") !== state.nonce || url.searchParams.getAll("state").length !== 1 || state.expires <= Date.now()) throw new Error("GitHub callback unavailable");
		if (state.phase === "registration") {
			const callbackKey = (await this.store.transaction((tx) => tx.get(this.key(context))))?.value.sharedSetup ? this.setupKey(context) : this.key(context);
			const code = string().regex(/^[a-zA-Z0-9_-]{1,200}$/).parse(url.searchParams.get("code"));
			const admitted = await this.store.transaction(async (tx) => {
				return {
					fence: await tx.claim(callbackKey, `callback-${randomBytes(16).toString("hex")}`, 6e4),
					revision: await tx.put(callbackKey, {
						...state,
						phase: "converting",
						nonce: "consumed"
					}, record.revision)
				};
			});
			try {
				const app = appSchema.parse(await this.api(context, `/app-manifests/${code}/conversions`, void 0, {}));
				await this.store.transaction(async (tx) => {
					await tx.assertFence(admitted.fence);
					const current = await tx.get(callbackKey);
					return tx.put(callbackKey, {
						...current.value,
						phase: "converting",
						nonce: "consumed",
						app
					}, current.revision);
				});
				await this.verifyApp(context, app);
				await this.options.authorize(context);
				await this.store.transaction(async (tx) => {
					await tx.assertFence(admitted.fence);
					const current = await tx.get(callbackKey);
					await tx.put(callbackKey, {
						...current.value,
						phase: "app-ready",
						nonce: "consumed",
						app
					}, current.revision);
				});
			} catch {
				await this.store.transaction(async (tx) => {
					try {
						await tx.assertFence(admitted.fence);
					} catch {
						return;
					}
					const current = await tx.get(callbackKey);
					if (current && current.value.phase !== "cancelled") await tx.put(callbackKey, {
						...current.value,
						phase: "uncertain",
						nonce: "consumed"
					}, current.revision);
				});
				throw new Error("GitHub registration requires reconciliation");
			}
			return;
		}
		if (state.phase !== "installation" || !state.app) throw new Error("GitHub callback already consumed");
		const app = state.app;
		const installation = number$1().int().positive().parse(url.searchParams.get("installation_id"));
		await this.checkInstallation(context, state.app, installation);
		await this.options.authorize(context);
		await this.store.transaction(async (tx) => {
			await tx.put(this.key(context), {
				...state,
				phase: "installed",
				nonce: "consumed",
				installation
			}, record.revision);
			const key = this.artifactKey(context, "installation");
			const old = await tx.get(key);
			await tx.put(key, {
				scope: this.scope(context),
				kind: "installation",
				app,
				installation,
				expires: await tx.now() + 36e5
			}, old?.revision ?? null);
			const routingKey = returnKey(context.actor.tenantId, state.nonce);
			const routing = await tx.get(routingKey);
			if (routing) await tx.delete(routingKey, routing.revision);
		});
	}
	async registrationRestartAvailable(context) {
		const { value } = await this.read(context);
		return value.phase === "uncertain" && !value.app && !value.installation;
	}
	/** Native, explicitly confirmed recovery only; never an automatic retry. */
	async restartRegistration(context, tx) {
		const key = (await tx.get(this.key(context)))?.value.sharedSetup ? this.setupKey(context) : this.key(context);
		const current = await tx.get(key);
		if (!current || current.value.scope !== this.scope(context) || current.value.phase !== "uncertain" || current.value.app || current.value.installation) throw new Error("GitHub registration restart unavailable");
		const fence = await tx.claim(key, `restart-${randomBytes(16).toString("hex")}`, 3e4);
		await tx.put(key, {
			...current.value,
			phase: "registration",
			handoffIssued: false,
			nonce: randomBytes(32).toString("base64url"),
			expires: await tx.now() + 36e5
		}, current.revision);
		await tx.assertFence(fence);
		await tx.cancel(key);
	}
	/** Input is accepted only from a purpose-bound private collector, never from an agent tool. */
	async recover(context, input) {
		const record = await this.read(context);
		const recoveryKey = (await this.store.transaction((tx) => tx.get(this.key(context))))?.value.sharedSetup ? this.setupKey(context) : this.key(context);
		if (!["uncertain", "converting"].includes(record.value.phase)) throw new Error("GitHub recovery unavailable");
		const values = object({
			appId: number().int().positive(),
			pem: string().min(1).max(3e4)
		}).strict().parse(input);
		const pending = {
			id: values.appId,
			pem: values.pem,
			slug: "pending",
			owner: { login: "pending" }
		};
		const identity = object({
			id: number().int().positive(),
			slug: string(),
			owner: object({ login: string() })
		}).parse(await this.api(context, "/app", await this.jwt(pending)));
		const app = appSchema.parse({
			...identity,
			pem: values.pem
		});
		if (app.id !== values.appId) throw new Error("GitHub recovery rejected");
		await this.verifyApp(context, app);
		await this.options.authorize(context);
		await this.store.transaction(async (tx) => {
			await tx.cancel(recoveryKey);
			await tx.put(recoveryKey, {
				...record.value,
				app,
				phase: "app-ready",
				nonce: "consumed"
			}, record.revision);
		});
	}
	/** Local cancellation fences callbacks; it does not revoke an upstream GitHub grant. */
	async cancel(context) {
		const scope = this.scope(context);
		await this.store.transaction(async (tx) => {
			const record = await tx.get(this.key(context));
			if (record && record.value.scope !== scope) throw new Error("GitHub handoff unavailable");
			await tx.cancel(this.key(context));
			if (record?.value.sharedSetup) {
				const sharedKey = this.setupKey(context);
				const shared = await tx.get(sharedKey);
				if (shared) {
					const subscribers = (shared.value.subscribers ?? []).filter((id) => id !== context.runId);
					if (!subscribers.length) await tx.cancel(sharedKey);
					await tx.put(sharedKey, {
						...shared.value,
						subscribers,
						...!subscribers.length ? {
							phase: "cancelled",
							nonce: "cancelled",
							restartable: shared.value.phase === "registration" && !shared.value.handoffIssued
						} : {}
					}, shared.revision);
				}
			}
			await tx.put(this.key(context), {
				...record?.value ?? {
					scope,
					expires: await tx.now()
				},
				phase: "cancelled",
				nonce: "cancelled"
			}, record?.revision ?? null);
		});
	}
	async checkInstallation(context, app, installation) {
		await this.verifyApp(context, app);
		const checked = object({
			id: number(),
			app_id: number(),
			account: object({ login: string() }),
			suspended_at: string().nullable(),
			permissions: record(string(), string())
		}).parse(await this.api(context, `/app/installations/${installation}`, await this.jwt(app)));
		if (checked.id !== installation || checked.app_id !== app.id || checked.account.login.toLowerCase() !== context.target.toLowerCase() || checked.suspended_at || !["read", "write"].includes(checked.permissions.contents ?? "") || Object.keys(checked.permissions).some((key) => !["contents", "metadata"].includes(key))) throw new Error("GitHub installation rejected");
	}
	async verifyAccess(context, installationRef) {
		await this.options.authorize(context);
		const installed = await this.artifact(context, "installation", installationRef);
		if (!installed?.installation) throw new Error("Verified installation prerequisite unavailable");
		await this.checkInstallation(context, installed.app, installed.installation);
		if ((await this.artifact(context, "connection"))?.token) return this.result("connection", this.artifactKey(context, "connection").id);
		const token = object({
			token: string().min(1),
			expires_at: datetime(),
			permissions: object({ contents: literal("read") })
		}).parse(await this.api(context, `/app/installations/${installed.installation}/access_tokens`, await this.jwt(installed.app), { permissions: { contents: "read" } }));
		object({
			total_count: number().int().nonnegative(),
			repositories: array(object({ id: number() }))
		}).parse(await this.api(context, "/installation/repositories?per_page=1", token.token));
		if (Date.parse(token.expires_at) <= Date.now()) throw new Error("GitHub access expired");
		const id = await this.saveArtifact(context, {
			...installed,
			kind: "connection",
			token: token.token,
			expires: Date.parse(token.expires_at)
		});
		return this.result("connection", id);
	}
};
//#endregion
//#region src/server/persistence/collections.ts
const privateCollectionBindingSchema = object({
	purpose: identifierSchema,
	provider: identifierSchema,
	operationId: identifierSchema,
	operationVersion: semanticVersionSchema,
	runId: identifierSchema,
	nodeId: identifierSchema,
	revision: number().int().nonnegative(),
	fields: array(identifierSchema).min(1).max(32).refine((fields) => new Set(fields).size === fields.length)
}).strict();
const valuesSchema = record(identifierSchema, string().max(3e4)).refine((values) => Object.keys(values).length <= 32 && Object.values(values).reduce((size, value) => size + Buffer.byteLength(value), 0) <= 65536);
const unavailable = () => /* @__PURE__ */ new Error("Private collection unavailable");
function binding(value) {
	const parsed = privateCollectionBindingSchema.safeParse(value);
	if (!parsed.success) throw unavailable();
	return {
		...parsed.data,
		fields: [...parsed.data.fields].sort()
	};
}
function equivalent(a, b) {
	return a.purpose === b.purpose && a.provider === b.provider && a.operationId === b.operationId && a.operationVersion === b.operationVersion && a.runId === b.runId && a.nodeId === b.nodeId && a.revision === b.revision && a.fields.length === b.fields.length && a.fields.every((field, index) => field === b.fields[index]);
}
function identity(actor) {
	if (!actorContextSchema.safeParse(actor).success) throw unavailable();
	return actor;
}
function commandKey(actor, commandId) {
	if (!identifierSchema.safeParse(commandId).success) throw unavailable();
	return {
		tenant: actor.tenantId,
		kind: "command",
		id: `private:${commandId}`
	};
}
function collectionKey(actor, ref) {
	if (!uuid().safeParse(ref).success) throw unavailable();
	return {
		tenant: actor.tenantId,
		kind: "collection",
		id: ref
	};
}
/** Server-only private transport. An authenticated host supplies actor and trusted operation binding, never browser owner/source labels. */
var AsyncPrivateCollectionBroker = class {
	store;
	recoveryTtlMs;
	constructor(store, recoveryTtlMs = 36e5) {
		this.store = store;
		this.recoveryTtlMs = recoveryTtlMs;
		if (!Number.isSafeInteger(recoveryTtlMs) || recoveryTtlMs < 1 || recoveryTtlMs > 864e5) throw new Error("Invalid private recovery lifetime");
	}
	async collect(actor, contract, input, ttlMs = 3e5) {
		identity(actor);
		if (actor.actorKind !== "human" || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 3e5) throw unavailable();
		const checked = binding(contract);
		const values = valuesSchema.safeParse(input);
		if (!values.success || Object.keys(values.data).sort().join("\0") !== checked.fields.join("\0")) throw unavailable();
		const ref = randomUUID();
		await this.store.transaction(async (tx) => {
			const record = {
				tag: "private-collection",
				subject: actor.subjectId,
				binding: checked,
				values: values.data,
				expires: await tx.now() + ttlMs
			};
			await tx.put(collectionKey(actor, ref), record, null);
		});
		return ref;
	}
	async consume(actor, contract, reference, commandId) {
		return this.store.transaction((tx) => this.consumeIn(tx, actor, contract, reference, commandId));
	}
	/** Call inside the SAME transaction as command admission. A rollback restores the unconsumed collection. */
	async consumeIn(tx, actor, contract, reference, commandId) {
		identity(actor);
		const checked = binding(contract);
		const key = collectionKey(actor, reference);
		const associationKey = commandKey(actor, commandId);
		const record = await tx.get(key);
		const association = await tx.get(associationKey);
		const now = await tx.now();
		if (!record || record.value.tag !== "private-collection" || record.value.subject !== actor.subjectId || !equivalent(record.value.binding, checked)) throw unavailable();
		if (association && (association.value.subject !== actor.subjectId || association.value.reference !== reference || association.value.state !== "bound" || !equivalent(association.value.binding, checked))) throw unavailable();
		if (record.value.commandId) {
			if (record.value.commandId !== commandId || !association || !record.value.recoveryExpires || record.value.recoveryExpires <= now) throw unavailable();
			return record.value.values;
		}
		if (record.value.expires <= now || association) throw unavailable();
		await tx.put(key, {
			...record.value,
			commandId,
			recoveryExpires: now + this.recoveryTtlMs
		}, record.revision);
		await tx.put(associationKey, {
			subject: actor.subjectId,
			binding: checked,
			reference,
			state: "bound"
		}, null);
		return record.value.values;
	}
	async complete(actor, contract, reference, commandId) {
		identity(actor);
		const checked = binding(contract);
		await this.store.transaction(async (tx) => {
			const key = collectionKey(actor, reference);
			const record = await tx.get(key);
			const associationKey = commandKey(actor, commandId);
			const association = await tx.get(associationKey);
			if (!association || association.value.subject !== actor.subjectId || association.value.reference !== reference || !equivalent(association.value.binding, checked)) throw unavailable();
			if (record) {
				if (record.value.subject !== actor.subjectId || record.value.commandId !== commandId) throw unavailable();
				await tx.delete(key, record.revision);
			}
			if (association.value.state !== "purged") await tx.put(associationKey, {
				...association.value,
				state: "purged"
			}, association.revision);
		});
	}
	/** Trusted retention worker only. Audit and command tombstones have independent policies and are not deleted here. */
	async purgeExpired(tenant, limit = 100, afterId = "") {
		return this.store.transaction(async (tx) => {
			const records = await tx.list(tenant, "collection", limit, afterId);
			const now = await tx.now();
			let deleted = 0;
			for (const record of records) {
				if (record.value.tag !== "private-collection") continue;
				const expires = record.value.commandId ? record.value.recoveryExpires : record.value.expires;
				if (expires !== void 0 && expires <= now) {
					await tx.delete({
						tenant,
						kind: "collection",
						id: record.id
					}, record.revision);
					deleted++;
				}
			}
			return {
				deleted,
				lastId: records.at(-1)?.id
			};
		});
	}
};
//#endregion
//#region src/server/arazzo.ts
const name = string().regex(/^[A-Za-z0-9_-]+$/);
/** Deliberately bounded Arazzo 1.0.1 profile: sequential trusted operations.
* Unsupported control flow fails validation; no eval, source fetching or implicit retries.
*/
const arazzoSchema = object({
	arazzo: literal("1.0.1"),
	info: object({
		title: string(),
		version: string()
	}).strict(),
	sourceDescriptions: array(object({
		name,
		url: string(),
		type: literal("openapi")
	}).strict()).length(1),
	workflows: array(object({
		workflowId: name,
		summary: string(),
		steps: array(object({
			stepId: name,
			description: string(),
			operationId: string().min(1).optional(),
			operationPath: string().regex(/^\{\$sourceDescriptions\.[A-Za-z0-9_-]+\.url\}#\/paths\/.+\/(get|post|put|patch|delete|head|options)$/).optional()
		}).strict().refine((step) => !!step.operationId !== !!step.operationPath, "Specify exactly one operationId or operationPath")).min(1).max(32)
	}).strict()).min(1).max(32)
}).strict().superRefine((doc, ctx) => {
	const unique = (values) => new Set(values).size === values.length;
	if (!unique(doc.workflows.map((w) => w.workflowId)) || doc.workflows.some((w) => !unique(w.steps.map((s) => s.stepId)))) ctx.addIssue({
		code: "custom",
		message: "Workflow and step IDs must be unique"
	});
});
/** Validate the host's pinned catalog before mounting a connector; never fetch a source URL. */
function validateConnectorWorkflows(manifest, documents) {
	for (const method of manifestSchema.parse(manifest).methods) for (const reference of method.contract?.workflows ?? []) {
		const document = arazzoSchema.parse(documents.get(reference.document));
		if (document.info.version !== reference.version || !document.workflows.some((workflow) => workflow.workflowId === reference.workflowId)) throw new Error("Connector workflow reference is unavailable or incompatible");
	}
}
/** Bind operations in trusted host code. Authentication and input validation belong
* to those SDK-backed handlers, never to imported documents or model-generated code.
* Handler results remain private to the caller; observer events contain identifiers only.
*/
async function runArazzo(document, workflowId, operations, onStep) {
	const workflow = arazzoSchema.parse(document).workflows.find((w) => w.workflowId === workflowId);
	if (!workflow) throw new Error("Unknown Arazzo workflow");
	for (const step of workflow.steps) {
		const operation = step.operationId ?? step.operationPath;
		if (typeof operations.get(operation) !== "function") throw new Error(`Unbound workflow operation: ${operation}`);
	}
	for (const step of workflow.steps) {
		const notify = (status) => {
			try {
				const pending = onStep?.({
					workflowId,
					stepId: step.stepId,
					...step.operationId ? { operationId: step.operationId } : { operationPath: step.operationPath },
					status
				});
				Promise.resolve(pending).catch(() => {});
			} catch {}
		};
		try {
			await operations.get(step.operationId ?? step.operationPath)();
			notify("success");
		} catch (error) {
			notify("failure");
			throw error;
		}
	}
}
//#endregion
//#region src/server/services.ts
const serviceManifests = [manifestSchema.parse({
	schemaVersion: 1,
	support: "live-adapter",
	id: "stripe",
	name: "Stripe",
	description: "Account setup, restricted key, verified read access.",
	methods: [{
		id: "api-key",
		label: "API key",
		kind: "api-key",
		templateId: "api-key",
		scopes: [],
		contract: {
			profile: "stripe-api-key",
			surfaces: ["browser", "headless"],
			configuration: [{
				name: "STRIPE_SECRET_KEY",
				source: "session-environment",
				classification: "secret",
				required: false
			}],
			prerequisites: [{
				id: "stripe-account",
				kind: "provider-registration",
				reuse: "verified-context",
				handoff: {
					surface: "provider-browser",
					recipient: "initiating-subject",
					delegation: "a2h-authorize",
					resume: "verify"
				}
			}],
			configurationGroups: [],
			handoff: {
				surface: "private-collector",
				recipient: "initiating-subject",
				delegation: "a2h-authorize",
				resume: "verify"
			},
			completion: {
				verifier: "stripe.balance-read",
				ownership: ["authenticated"]
			},
			workflows: [{
				document: "stripe",
				version: "1.0.0",
				workflowId: "verify-access"
			}]
		},
		fields: [{
			name: "token",
			label: "Stripe secret key",
			type: "password",
			required: true,
			classification: "secret"
		}]
	}]
}), manifestSchema.parse({
	schemaVersion: 1,
	support: "live-adapter",
	id: "supabase",
	name: "Supabase",
	description: "Sign in to your Supabase project, with missing project setup included.",
	methods: [{
		id: "form",
		label: "Email & password",
		kind: "form",
		templateId: "form",
		scopes: [],
		contract: {
			profile: "supabase-password",
			surfaces: ["browser", "headless"],
			configuration: [
				{
					name: "SUPABASE_URL",
					source: "session-environment",
					classification: "public",
					required: true
				},
				{
					name: "SUPABASE_PUBLISHABLE_KEY",
					source: "session-environment",
					classification: "public",
					required: false
				},
				{
					name: "SUPABASE_ANON_KEY",
					source: "session-environment",
					classification: "public",
					required: false
				}
			],
			prerequisites: [{
				id: "project-configuration",
				kind: "configuration",
				reuse: "verified-context",
				handoff: {
					surface: "private-collector",
					recipient: "authorized-owner",
					delegation: "a2h-authorize",
					resume: "verify"
				}
			}],
			configurationGroups: [{
				id: "project-key",
				rule: "at-least-one",
				names: ["SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"]
			}],
			handoff: {
				surface: "private-collector",
				recipient: "initiating-subject",
				delegation: "a2h-authorize",
				resume: "verify"
			},
			completion: {
				verifier: "supabase.auth-session",
				ownership: ["authenticated"]
			},
			workflows: [{
				document: "supabase",
				version: "1.0.0",
				workflowId: "sign-in"
			}]
		},
		fields: [{
			name: "email",
			label: "Email",
			type: "email",
			required: true,
			classification: "personal"
		}, {
			name: "password",
			label: "Password",
			type: "password",
			required: true,
			classification: "secret"
		}]
	}]
})];
const serviceWorkflows = {
	stripe: {
		arazzo: "1.0.1",
		info: {
			title: "Stripe API access",
			version: "1.0.0"
		},
		sourceDescriptions: [{
			name: "stripe",
			type: "openapi",
			url: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json"
		}],
		workflows: [{
			workflowId: "verify-access",
			summary: "Read balance to verify key permissions; never create payments.",
			steps: [{
				stepId: "verify",
				description: "Verify read access with the Stripe SDK",
				operationId: "GetBalance"
			}]
		}]
	},
	supabase: {
		arazzo: "1.0.1",
		info: {
			title: "Supabase project sign-in",
			version: "1.0.0"
		},
		sourceDescriptions: [{
			name: "auth",
			type: "openapi",
			url: "https://raw.githubusercontent.com/supabase/auth/master/openapi.yaml"
		}],
		workflows: [{
			workflowId: "sign-in",
			summary: "Sign in an existing project user with the Supabase SDK.",
			steps: [{
				stepId: "authenticate",
				description: "Exchange email and password for a project session",
				operationPath: "{$sourceDescriptions.auth.url}#/paths/~1token/post"
			}, {
				stepId: "verify-user",
				description: "Verify the issued session with a fresh Auth user lookup",
				operationPath: "{$sourceDescriptions.auth.url}#/paths/~1user/get"
			}]
		}]
	}
};
//#endregion
//#region src/server/recipes/stripe.ts
const keySchema = string().max(512).regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/);
const artifactSchema = string().regex(/^stripe:(account|credential|connection):[a-f0-9]{64}$/);
const slot = (contract) => ({
	contract,
	required: true
});
const stripeVocabulary = new Map([
	"account",
	"credential",
	"connection"
].map((kind) => [`stripe.${kind}`, {
	schema: artifactSchema,
	classification: "artifact",
	provider: "stripe",
	profile: "stripe-api-key"
}]));
const stripeConnectionRecipe = {
	schemaVersion: 1,
	id: "stripe-connect",
	title: "Connect Stripe",
	description: "Open or create an account, obtain a restricted key, and verify read-only access. Account readiness is a setup choice, not proof of account ownership.",
	inputs: {},
	invocations: [
		{
			id: "account",
			use: {
				kind: "operation",
				id: "stripe.prepare-account",
				version: "1.0.0"
			},
			dependsOn: [],
			bindings: {}
		},
		{
			id: "credential",
			use: {
				kind: "operation",
				id: "stripe.obtain-key",
				version: "1.0.0"
			},
			dependsOn: ["account"],
			bindings: { account: {
				from: "output",
				node: "account",
				name: "account"
			} }
		},
		{
			id: "access",
			use: {
				kind: "operation",
				id: "stripe.verify-access",
				version: "1.0.0"
			},
			dependsOn: ["credential"],
			bindings: { credential: {
				from: "output",
				node: "credential",
				name: "credential"
			} }
		}
	],
	outputs: { connection: {
		node: "access",
		name: "connection"
	} }
};
/** Real Stripe SDK leaves. Account setup is a human choice; only Balance verification proves API access. */
var AsyncStripeChildren = class {
	store;
	options;
	broker;
	constructor(store, options) {
		this.store = store;
		this.options = options;
		this.broker = new AsyncPrivateCollectionBroker(store);
	}
	scope(context) {
		return createHash("sha256").update(JSON.stringify([
			context.actor.tenantId,
			context.actor.subjectId,
			context.actor.sessionId,
			"stripe",
			"stripe-api-key",
			context.origin,
			context.environment,
			context.configurationVersion,
			context.target
		])).digest("hex");
	}
	key(context, kind) {
		return {
			tenant: context.actor.tenantId,
			kind: "artifact",
			id: `stripe:${kind}:${this.scope(context)}`
		};
	}
	async authorize(context) {
		context.signal.throwIfAborted();
		await this.options.authorize(context);
		const run = await this.store.transaction((tx) => tx.get({
			tenant: context.actor.tenantId,
			kind: "run",
			id: context.runId
		}));
		if (!run || run.value.subjectId !== context.actor.subjectId || run.value.status === "cancelled" || run.value.provider !== "stripe" || run.value.profile !== "stripe-api-key" || run.value.target !== context.target || run.value.origin !== context.origin || run.value.environment !== context.environment || run.value.configurationVersion !== context.configurationVersion) throw new AuthorizationError("denied");
		const configuration = await this.options.configuration(context);
		if (configuration.version !== context.configurationVersion) throw new AuthorizationError("denied");
		return configuration;
	}
	async read(context, kind, reference) {
		await this.authorize(context);
		const key = this.key(context, kind);
		if (reference !== void 0 && reference !== key.id) throw new AuthorizationError("denied");
		return this.store.transaction(async (tx) => {
			const record = await tx.get(key);
			return record && record.value.scope === this.scope(context) && record.value.kind === kind && record.value.expires > await tx.now() ? record.value : void 0;
		});
	}
	async saveIn(tx, context, kind, data = {}) {
		const run = await tx.get({
			tenant: context.actor.tenantId,
			kind: "run",
			id: context.runId
		});
		if (!run || run.value.subjectId !== context.actor.subjectId || run.value.status !== "active" || run.value.configurationVersion !== context.configurationVersion) throw new AuthorizationError("denied");
		const key = this.key(context, kind);
		const prior = await tx.get(key);
		await tx.put(key, {
			scope: this.scope(context),
			kind,
			expires: await tx.now() + 864e5,
			...data
		}, prior?.revision ?? null);
		return key.id;
	}
	async save(context, kind, data = {}) {
		await this.authorize(context);
		return this.store.transaction(async (tx) => {
			const command = await tx.get({
				tenant: context.actor.tenantId,
				kind: "command",
				id: context.commandId
			});
			if (!command || command.value.state !== "running" || command.value.effectId !== context.effectId) throw new AuthorizationError("denied");
			return this.saveIn(tx, context, kind, data);
		});
	}
	result(kind, reference) {
		return {
			state: "complete",
			outputs: { [kind]: reference }
		};
	}
	register(registry) {
		for (const operation of [
			{
				id: "prepare-account",
				kind: "account",
				input: void 0,
				handler: (context) => this.prepareAccount(context)
			},
			{
				id: "obtain-key",
				kind: "credential",
				input: "account",
				handler: (context, inputs) => this.obtainKey(context, inputs.account)
			},
			{
				id: "verify-access",
				kind: "connection",
				input: "credential",
				handler: (context, inputs) => this.verifyAccess(context, inputs.credential)
			}
		]) registry.register({
			contract: {
				id: `stripe.${operation.id}`,
				version: "1.0.0",
				provider: "stripe",
				profile: "stripe-api-key",
				inputs: operation.input ? { [operation.input]: slot(`stripe.${operation.input}`) } : {},
				outputs: { [operation.kind]: slot(`stripe.${operation.kind}`) },
				effects: [`stripe.${operation.id}`],
				verifier: operation.kind === "connection" ? "stripe.balance-read" : "stripe.bound-setup",
				humanFallback: operation.kind === "account" ? "stripe.own-browser" : "stripe.private-collector"
			},
			inputSchema: strictObject(operation.input ? { [operation.input]: artifactSchema } : {}),
			outputSchema: strictObject({ [operation.kind]: artifactSchema }),
			classifications: {},
			fixtures: ["tests/stripe-children.test.ts"],
			handler: async (context, inputs) => {
				try {
					return await operation.handler(context, inputs);
				} catch {
					return {
						state: operation.kind === "connection" ? "awaiting-human" : "failed",
						outputs: {},
						diagnosticCode: "verification-rejected"
					};
				}
			},
			verify: async (context, result) => {
				if (result.state !== "complete") return false;
				const artifact = await this.read(context, operation.kind, result.outputs[operation.kind]);
				if (!artifact) return false;
				if (operation.kind !== "connection") return true;
				if (!artifact.token) return false;
				if (artifact.evidenceEffect !== context.effectId) await this.balance(context, artifact.token);
				return true;
			}
		});
	}
	async prepareAccount(context) {
		if ((await this.authorize(context)).token || await this.read(context, "account")) return this.result("account", await this.save(context, "account"));
		return {
			state: "awaiting-human",
			outputs: {}
		};
	}
	async obtainKey(context, account) {
		if (!await this.read(context, "account", account)) throw new AuthorizationError("denied");
		const configured = await this.authorize(context);
		const collected = await this.read(context, "credential");
		const token = configured.token ?? collected?.token;
		if (!token || !keySchema.safeParse(token).success) return {
			state: "awaiting-human",
			outputs: {}
		};
		return this.result("credential", await this.save(context, "credential", { token }));
	}
	async balance(context, token) {
		await this.authorize(context);
		const transport = this.options.fetch ?? fetch;
		const stripe = new Stripe(keySchema.parse(token), {
			maxNetworkRetries: 0,
			timeout: 15e3,
			httpClient: Stripe.createFetchHttpClient((url, init) => transport(url, {
				...init,
				redirect: "error",
				signal: AbortSignal.any([context.signal, ...init?.signal ? [init.signal] : []])
			}))
		});
		try {
			await runArazzo(serviceWorkflows.stripe, "verify-access", /* @__PURE__ */ new Map([["GetBalance", async () => {
				const balance = await stripe.balance.retrieve();
				if (balance.object !== "balance" || typeof balance.livemode !== "boolean" || balance.livemode !== token.includes("_live_")) throw new Error();
			}]]));
		} catch {
			throw new AuthorizationError("denied");
		}
		await this.authorize(context);
	}
	async verifyAccess(context, credential) {
		const artifact = await this.read(context, "credential", credential);
		if (!artifact?.token) throw new AuthorizationError("denied");
		await this.balance(context, artifact.token);
		return this.result("connection", await this.save(context, "connection", {
			token: artifact.token,
			evidenceEffect: context.effectId
		}));
	}
	/** Authenticated native collector only. Acknowledgment enables key acquisition, never authenticated access. */
	async humanInput(context, revision, input) {
		await this.authorize(context);
		if (context.actor.actorKind !== "human") throw new AuthorizationError("denied");
		const parsed = union([strictObject({ accountReady: literal(true) }), strictObject({ token: keySchema })]).safeParse(input);
		if (!parsed.success) throw new AuthorizationError("invalid_request");
		const collecting = "token" in parsed.data;
		const planned = await this.store.transaction(async (tx) => (await tx.get({
			tenant: context.actor.tenantId,
			kind: "run",
			id: context.runId
		}))?.value.nodes.find((node) => node.id === context.nodeId));
		if (!planned || !(collecting ? ["stripe.obtain-key", "stripe.verify-access"] : ["stripe.prepare-account"]).includes(planned.operationId)) throw new AuthorizationError("denied");
		const operationId = planned.operationId;
		const binding = {
			purpose: "stripe-key",
			provider: "stripe",
			operationId,
			operationVersion: "1.0.0",
			runId: context.runId,
			nodeId: context.nodeId,
			revision,
			fields: ["token"]
		};
		const reference = collecting ? await this.broker.collect(context.actor, binding, parsed.data) : void 0;
		await this.store.transaction(async (tx) => {
			const runKey = {
				tenant: context.actor.tenantId,
				kind: "run",
				id: context.runId
			};
			const run = await tx.get(runKey);
			const node = run?.value.nodes.find((n) => n.id === context.nodeId && n.operationId === operationId);
			const state = await tx.get({
				tenant: context.actor.tenantId,
				kind: "node",
				id: `${context.runId}:${context.nodeId}`
			});
			if (!run || !node || run.revision !== revision || run.value.subjectId !== context.actor.subjectId || run.value.status !== "active" || state?.value.state !== "awaiting-human") throw new AuthorizationError("denied");
			for (const dependency of node.dependsOn) if (!(await tx.get({
				tenant: context.actor.tenantId,
				kind: "node",
				id: `${context.runId}:${dependency}`
			}))?.value.verified) throw new AuthorizationError("denied");
			const fence = await tx.claim(runKey, `collector-${createHash("sha256").update(context.commandId).digest("hex")}`, 3e4);
			if (reference) {
				const values = await this.broker.consumeIn(tx, context.actor, binding, reference, context.commandId);
				await this.saveIn(tx, context, "credential", { token: values.token });
			} else await this.saveIn(tx, context, "account");
			await tx.put(runKey, run.value, run.revision);
			await appendSemanticTransition(tx, context.actor, context.runId, {
				nodeId: node.id,
				operationId: node.operationId,
				operationVersion: node.operationVersion,
				actorKind: "human",
				kind: "handoff",
				beforeState: "awaiting-human",
				afterState: "awaiting-human",
				publicBindings: {},
				verification: "pending"
			}, {});
			await tx.assertFence(fence);
			await tx.cancel(runKey);
		});
		if (reference) await this.broker.complete(context.actor, binding, reference, context.commandId);
	}
};
//#endregion
//#region src/server/stripe-human.ts
const escape$1 = (text) => text.replace(/[&<>"']/g, (c) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	"\"": "&quot;",
	"'": "&#39;"
})[c]);
/** Isolated native HTML; no PWA shell, model, recorder, or credential-bearing redirects. */
async function stripeHuman(store, children, context, record, request, returnUrl, advance) {
	if (context.actor.actorKind !== "human" || record.value.provider !== "stripe") throw new AuthorizationError("denied");
	const headers = {
		"cache-control": "no-store",
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff"
	};
	const nodes = await store.transaction(async (tx) => {
		for (const node of record.value.nodes) {
			const state = await tx.get({
				tenant: context.actor.tenantId,
				kind: "node",
				id: `${context.runId}:${node.id}`
			});
			if (!state?.value.verified) return {
				node,
				state: state?.value.state
			};
		}
	});
	if (!nodes || nodes.state !== "awaiting-human" || ![
		"stripe.prepare-account",
		"stripe.obtain-key",
		"stripe.verify-access"
	].includes(nodes.node.operationId)) throw new AuthorizationError("denied");
	const account = nodes.node.operationId === "stripe.prepare-account";
	const key = (id) => ({
		tenant: context.actor.tenantId,
		kind: "handoff",
		id: `stripe-collector:${id}`
	});
	if (request.method === "POST") {
		const input = union([strictObject({
			ticket: uuid(),
			accountReady: literal(true)
		}), strictObject({
			ticket: uuid(),
			token: string().max(512)
		})]).safeParse(await boundedJson(request, 4096));
		if (!input.success) throw new AuthorizationError("invalid_request");
		const ticket = await store.transaction(async (tx) => {
			const value = await tx.get(key(input.data.ticket));
			if (!value || value.value.expires <= await tx.now()) throw new AuthorizationError("denied");
			return value;
		});
		if (ticket.value.subject !== context.actor.subjectId || ticket.value.session !== context.actor.sessionId || ticket.value.runId !== context.runId || ticket.value.nodeId !== nodes.node.id || ticket.value.revision !== record.revision) throw new AuthorizationError("denied");
		await children.humanInput({
			...context,
			nodeId: nodes.node.id,
			commandId: `collector:${input.data.ticket}`
		}, record.revision, "token" in input.data ? { token: input.data.token } : { accountReady: input.data.accountReady });
		await store.transaction((tx) => tx.delete(key(input.data.ticket), ticket.revision));
		await advance();
		return Response.json({ returnUrl: account ? request.url : returnUrl }, { headers });
	}
	if (request.method !== "GET") throw new AuthorizationError("denied");
	const ticket = randomUUID();
	await store.transaction(async (tx) => tx.put(key(ticket), {
		subject: context.actor.subjectId,
		session: context.actor.sessionId,
		runId: context.runId,
		nodeId: nodes.node.id,
		revision: record.revision,
		expires: await tx.now() + 3e5
	}, null));
	const nonce = randomUUID();
	if (request.headers.get("accept") === "application/json") return Response.json({
		ticket,
		operationId: nodes.node.operationId
	}, { headers });
	return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${account ? "Set up your Stripe account" : "Connect your Stripe key"}</title>
  <style nonce="${nonce}">:root{color-scheme:light;font:16px/1.5 system-ui,sans-serif;color:#17212d;background:#f4f6f8}body{margin:0}main{box-sizing:border-box;max-width:680px;margin:40px auto;padding:24px;background:#fff}h1{font-size:28px;line-height:1.2;letter-spacing:-.02em}p{max-width:65ch}a{color:#1749c7;text-underline-offset:3px}form{margin-block:24px}label{display:block;font-weight:600}input{box-sizing:border-box;display:block;width:100%;margin-block:8px 16px;min-height:44px;border:1px solid #aebdce;border-radius:6px;padding:10px 12px;font:inherit;caret-color:#1749c7}button{min-height:44px;border:0;border-radius:6px;background:#1749c7;color:#fff;padding:10px 16px;font:600 16px/1.5 system-ui;cursor:pointer}button:hover{background:#103aa5}button:disabled{opacity:.55;cursor:wait}:focus-visible{outline:2px solid #1749c7;outline-offset:3px}::selection{background:#d9e5ff;color:#152f70}#status{color:#a03620} @media(max-width:720px){main{margin:0;padding:24px 20px;min-height:100dvh}}</style></head><body><main>
  <h1>${account ? "Set up your Stripe account" : "Connect your Stripe key"}</h1>
  ${account ? `<p>Create an account if you are new to Stripe, or sign in to the account you want to connect. Complete Stripe’s email verification, MFA, and any required checks there.</p><p><a href="https://dashboard.stripe.com/register" target="_blank" rel="noopener noreferrer">Create a Stripe account (new tab)</a> · <a href="https://dashboard.stripe.com/login" target="_blank" rel="noopener noreferrer">Sign in to Stripe (new tab)</a></p><p>Return here when the account is ready. This choice does not verify ownership or grant API access; we check access after you provide a restricted key.</p>` : `<p>In Stripe’s <a href="https://dashboard.stripe.com/apikeys" target="_blank" rel="noopener noreferrer">API keys page (new tab)</a>, create a restricted key with Balance read permission. Choose a sandbox for testing. No payment or write permission is needed.</p><p>The key goes directly to the encrypted private broker and Stripe. It is not sent to the assistant or saved in your demonstration. Never paste it into chat.</p>`}
  <form id="private">${account ? "" : `<label for="token">Restricted API key</label><input id="token" name="token" type="password" required maxlength="512" pattern="(sk|rk)_(test|live)_[A-Za-z0-9]+" title="Use a restricted rk_test_ or rk_live_ key, or an existing sk_test_ or sk_live_ secret key. Publishable keys cannot verify access." aria-describedby="key-format" autocomplete="off" spellcheck="false"><p id="key-format">Use a restricted key beginning rk_test_ or rk_live_. Existing sk_test_ and sk_live_ keys also work; publishable pk_ keys do not.</p>`}<button>${account ? "My account is ready" : "Verify Stripe access"}</button></form>
  <p id="status" role="status" aria-live="polite"></p><p><a href="${escape$1(returnUrl)}">Return to connection</a></p>
  </main><script nonce="${nonce}">const form=document.getElementById('private');form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('button');const body={ticket:${JSON.stringify(ticket)},${account ? "accountReady:true" : "token:new FormData(form).get('token')"}};form.reset();button.disabled=true;try{const fresh=await fetch(location.pathname,{headers:{accept:'application/json'},credentials:'same-origin',cache:'no-store'});if(!fresh.ok)throw new Error();const admission=await fresh.json();if(admission.operationId!==${JSON.stringify(nodes.node.operationId)})throw new Error();body.ticket=admission.ticket;const response=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify(body)});if(!response.ok)throw new Error();const result=await response.json();location.assign(result.returnUrl)}catch{document.getElementById('status').textContent='This step could not finish. Return to the connection to check its current status, then reopen this step.'}finally{button.disabled=false}});addEventListener('pagehide',()=>form.reset());<\/script></body></html>`, { headers: {
		...headers,
		"content-type": "text/html; charset=utf-8",
		"content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`
	} });
}
//#endregion
//#region src/server/github-runtime.ts
const escape = (text) => text.replace(/[&<>"']/g, (c) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	"\"": "&quot;",
	"'": "&#39;"
})[c]);
function createGitHubRuntime(options) {
	const { store, identity, origin } = options;
	const broker = new AsyncPrivateCollectionBroker(store);
	const registry = new OperationRegistry(new Map([...githubVocabulary, ...options.stripe ? stripeVocabulary : []]));
	const targetKey = (actor) => ({
		tenant: actor.tenantId,
		kind: "session",
		id: `target:${createHash("sha256").update(actor.subjectId).digest("hex")}`
	});
	const configuration = (actor) => options.configuration?.(actor) ?? Promise.resolve({
		configurationVersion: options.configurationVersion,
		...options.github?.app ? { app: options.github.app } : {}
	});
	const authorize = async (actor, run, operationId) => (operationId === "continuation" || (run.provider === "stripe" ? (await options.stripe?.configuration(actor))?.version : (await configuration(actor)).configurationVersion) === run.configurationVersion) && await options.authorize(actor, run, operationId);
	const childOptions = {
		origin,
		environment: options.environment,
		configurationVersion: options.configurationVersion,
		...options.expectedAccount ? { expectedAccount: options.expectedAccount } : {},
		...options.github,
		authorize: async (context) => {
			const run = await store.transaction((tx) => tx.get({
				tenant: context.actor.tenantId,
				kind: "run",
				id: context.runId
			}));
			if (!run || run.value.subjectId !== context.actor.subjectId || run.value.status === "cancelled" || !await authorize(context.actor, run.value, run.value.provider)) throw new AuthorizationError("denied");
		}
	};
	const stripe = options.stripe ? new AsyncStripeChildren(store, {
		configuration: (context) => options.stripe.configuration(context.actor),
		authorize: childOptions.authorize,
		...options.stripe.fetch ? { fetch: options.stripe.fetch } : {}
	}) : void 0;
	stripe?.register(registry);
	const childrenFor = async (context) => {
		const config = await configuration(context.actor);
		if (config.configurationVersion !== context.configurationVersion) throw new AuthorizationError("denied");
		return new AsyncGitHubChildren(store, {
			...childOptions,
			configurationVersion: config.configurationVersion,
			...config.app ? { app: config.app } : {}
		});
	};
	const contractRegistry = new OperationRegistry(githubVocabulary);
	new AsyncGitHubChildren(store, childOptions).register(contractRegistry);
	for (const contract of contractRegistry.catalog()) {
		const operation = contractRegistry.require(contract.id, contract.version);
		const bound = async (context) => {
			const registered = new OperationRegistry(githubVocabulary);
			(await childrenFor(context)).register(registered);
			return registered.require(contract.id, contract.version);
		};
		registry.register({
			...operation,
			handler: async (context, inputs) => (await bound(context)).handler(context, inputs),
			verify: async (context, result) => Boolean(await (await bound(context)).verify?.(context, result))
		});
	}
	const operationContext = (actor, record) => ({
		actor,
		runId: record.id,
		nodeId: "human",
		commandId: `human:${record.id}`,
		effectId: `human:${record.id}`,
		target: record.target,
		configurationVersion: record.configurationVersion,
		origin,
		environment: record.environment,
		signal: AbortSignal.timeout(3e4)
	});
	const returnPath = options.returnPath ?? "/";
	const returnBase = new URL(returnPath, origin);
	if (!returnPath.startsWith("/") || returnPath.startsWith("//") || returnPath.length > 512 || returnBase.origin !== origin || returnBase.search || returnBase.hash) throw new Error("Invalid host return path");
	const returnUrl = (runId) => {
		const target = new URL(returnBase);
		target.searchParams.set("teachingRun", runId);
		return target.href;
	};
	const headers = {
		"cache-control": "no-store",
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff"
	};
	const runtime = createTeachingRuntime({
		store,
		identity,
		registry,
		origin,
		connections: new Map([["github", {
			definition: githubConnectionRecipe,
			outputContract: "github.connection",
			revalidateOperation: "github.verify-access"
		}], ...stripe ? [["stripe", {
			definition: stripeConnectionRecipe,
			outputContract: "stripe.connection",
			revalidateOperation: "stripe.verify-access"
		}]] : []]),
		...options.modelConfiguration ? { modelConfiguration: options.modelConfiguration } : {},
		...options.continuation ? { continuation: options.continuation } : {},
		authorize,
		humanReturn: async (actor, request) => {
			const url = new URL(request.url);
			const runId = await resolveGitHubInstallationRun(store, actor, origin, url).catch(() => {
				throw new AuthorizationError("denied");
			});
			url.pathname = `/api/v1/teaching/github/${encodeURIComponent(runId)}/callback`;
			return runtime.human(actor, runId, new Request(url, { headers: request.headers }));
		},
		cancel: async (actor, runId) => {
			const record = await store.transaction((tx) => tx.get({
				tenant: actor.tenantId,
				kind: "run",
				id: runId
			}));
			if (!record || record.value.subjectId !== actor.subjectId || record.value.status !== "cancelled") throw new AuthorizationError("denied");
			if (record.value.provider === "stripe") return;
			const context = operationContext(actor, record.value);
			if ((await configuration(actor)).configurationVersion === record.value.configurationVersion) await (await childrenFor(context)).cancel(context);
		},
		context: async (actor, connectorId) => {
			if (connectorId === "stripe" && options.stripe) return {
				provider: "stripe",
				profile: "stripe-api-key",
				target: "self",
				origin,
				environment: options.environment,
				configurationVersion: (await options.stripe.configuration(actor)).version
			};
			const config = await configuration(actor);
			const target = options.expectedAccount ?? (await store.transaction((tx) => tx.get(targetKey(actor))))?.value.target;
			if (!target) throw new Error("account-required");
			return {
				provider: "github",
				profile: "github-app",
				target,
				origin,
				environment: options.environment,
				configurationVersion: config.configurationVersion
			};
		},
		selectTarget: async (actor, target, connectorId = "github") => {
			if (connectorId !== "github" || !/^[a-zA-Z0-9-]{1,100}$/.test(target) || !options.allowTarget || !await options.allowTarget(actor, target)) throw new AuthorizationError("denied");
			await store.transaction(async (tx) => {
				const prior = await tx.get(targetKey(actor));
				await tx.put(targetKey(actor), { target }, prior?.revision ?? null);
			});
		},
		human: async (actor, runId, request) => {
			let record = await store.transaction((tx) => tx.get({
				tenant: actor.tenantId,
				kind: "run",
				id: runId
			}));
			let callbackUrl = new URL(request.url);
			if (!record || callbackUrl.pathname.split("/")[4] !== record.value.provider) throw new AuthorizationError("denied");
			if (record?.value.subjectId === actor.subjectId && record.value.status === "cancelled" && actor.actorKind === "human" && callbackUrl.pathname.endsWith("/callback")) {
				const original = operationContext(actor, record.value);
				const surviving = await (await childrenFor(original)).activeSetupSubscriber(original, callbackUrl).catch(() => {
					throw new AuthorizationError("denied");
				});
				record = await store.transaction((tx) => tx.get({
					tenant: actor.tenantId,
					kind: "run",
					id: surviving
				}));
				runId = surviving;
				callbackUrl = new URL(callbackUrl);
				callbackUrl.pathname = `/api/v1/teaching/github/${encodeURIComponent(surviving)}/callback`;
			}
			if (!record || record.value.subjectId !== actor.subjectId || record.value.status !== "active") throw new AuthorizationError("denied");
			if (actor.actorKind !== "human" || !await authorize(actor, record.value, `${record.value.provider}.human`)) throw new AuthorizationError("denied");
			const context = operationContext(actor, record.value);
			if (record.value.provider === "stripe") {
				if (!stripe || decodeURIComponent(new URL(request.url).pathname) !== `/api/v1/teaching/stripe/${runId}/human`) throw new AuthorizationError("denied");
				const stripeReturn = new URL(returnUrl(runId));
				stripeReturn.searchParams.set("connector", "stripe");
				return stripeHuman(store, stripe, context, record, request, stripeReturn.href, () => advance(actor, runId));
			}
			const children = await childrenFor(context);
			if (new URL(request.url).pathname.endsWith("/recovery")) {
				const node = record.value.nodes.find((node) => node.operationId === "github.prepare-app");
				if (!node) throw new AuthorizationError("denied");
				if ((await store.transaction((tx) => tx.get({
					tenant: actor.tenantId,
					kind: "node",
					id: `${runId}:${node.id}`
				})))?.value.state !== "uncertain") throw new AuthorizationError("denied");
				const binding = {
					purpose: "github-app-recovery",
					provider: "github",
					operationId: "github.prepare-app",
					operationVersion: "1.0.0",
					runId,
					nodeId: node.id,
					revision: record.revision,
					fields: ["appId", "pem"]
				};
				if (request.method === "POST") {
					assertRequestBoundary(request, {
						origin,
						maxBytes: 65536
					});
					const input = union([strictObject({
						ticket: uuid(),
						appId: string().regex(/^[1-9][0-9]{0,15}$/),
						pem: string().min(1).max(3e4)
					}), strictObject({
						ticket: uuid(),
						restart: literal(true)
					})]).parse(await boundedJson(request, 65536));
					const key = {
						tenant: actor.tenantId,
						kind: "handoff",
						id: `recovery:${input.ticket}`
					};
					const prior = await store.transaction((tx) => tx.get(key));
					if (!prior || prior.value.subject !== actor.subjectId || prior.value.session !== actor.sessionId || prior.value.runId !== runId || prior.value.revision !== record.revision) throw new AuthorizationError("denied");
					if (prior.value.complete || prior.value.expires <= await store.transaction((tx) => tx.now())) throw new AuthorizationError("denied");
					let reference;
					const restarting = "restart" in input;
					if (!restarting) {
						reference = prior.value.reference ?? await broker.collect(actor, binding, {
							appId: input.appId,
							pem: input.pem
						});
						const commandId = `recovery:${input.ticket}`;
						const boundReference = reference;
						const material = await store.transaction(async (tx) => {
							const ticket = await tx.get(key);
							const current = await tx.get({
								tenant: actor.tenantId,
								kind: "run",
								id: runId
							});
							if (!ticket || ticket.value.expires <= await tx.now() || ticket.value.complete || !current || current.revision !== binding.revision || current.value.status !== "active") throw new AuthorizationError("denied");
							if (ticket.value.reference && ticket.value.reference !== boundReference) throw new AuthorizationError("denied");
							const values = await broker.consumeIn(tx, actor, binding, boundReference, commandId);
							if (values.appId !== input.appId || values.pem !== input.pem) throw new AuthorizationError("denied");
							await tx.put(key, {
								...ticket.value,
								reference: boundReference
							}, ticket.revision);
							return values;
						});
						await children.recover({
							...context,
							commandId,
							effectId: commandId
						}, {
							appId: Number(material.appId),
							pem: material.pem
						});
					}
					if (!await authorize(actor, record.value, "github.prepare-app")) throw new AuthorizationError("denied");
					await store.transaction(async (tx) => {
						const runKey = {
							tenant: actor.tenantId,
							kind: "run",
							id: runId
						};
						const current = await tx.get(runKey);
						const nodeKey = {
							tenant: actor.tenantId,
							kind: "node",
							id: `${runId}:${node.id}`
						};
						const pending = await tx.get(nodeKey);
						const ticket = await tx.get(key);
						if (!ticket || ticket.value.complete || ticket.value.expires <= await tx.now() || restarting && ticket.value.reference !== void 0 || !current || current.value.status !== "active" || current.revision !== binding.revision || pending?.value.state !== "uncertain") throw new AuthorizationError("denied");
						const fence = await tx.claim(runKey, `recovery-${randomUUID()}`, 3e4);
						if (restarting) await children.restartRegistration(context, tx);
						await tx.put(nodeKey, {
							state: "verifying",
							verified: false,
							outputs: {}
						}, pending.revision);
						const revision = await tx.put(runKey, current.value, current.revision);
						await appendSemanticTransition(tx, actor, runId, {
							nodeId: node.id,
							operationId: node.operationId,
							operationVersion: node.operationVersion,
							actorKind: "human",
							kind: "transition",
							beforeState: "uncertain",
							afterState: "verifying",
							publicBindings: {},
							verification: "pending"
						}, {});
						await tx.put({
							tenant: actor.tenantId,
							kind: "outbox",
							id: `recovery:${runId}:${revision}`
						}, {
							task: restarting ? "recovery-restarted" : "recovery-verified",
							runId,
							subjectId: actor.subjectId,
							status: "pending"
						}, null);
						if (ticket) await tx.put(key, {
							...ticket.value,
							complete: true
						}, ticket.revision);
						await tx.assertFence(fence);
						await tx.cancel(runKey);
					});
					if (reference) await broker.complete(actor, binding, reference, `recovery:${input.ticket}`);
					await advance(actor, runId);
					return Response.json({ returnUrl: returnUrl(runId) }, { headers });
				}
				const ticket = randomUUID();
				await store.transaction(async (tx) => tx.put({
					tenant: actor.tenantId,
					kind: "handoff",
					id: `recovery:${ticket}`
				}, {
					subject: actor.subjectId,
					session: actor.sessionId,
					runId,
					revision: record.revision,
					expires: await tx.now() + 3e5
				}, null));
				const nonce = randomUUID();
				const restartAvailable = await children.registrationRestartAvailable(context);
				return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Recover GitHub setup</title><main><h1>Recover your existing GitHub App</h1><p>The registration response was interrupted or expired. Check your GitHub App settings first. If an app exists, enter its ID and private key here. These go directly to the private broker, never the assistant or demonstration.</p><form id="private"><label>App ID<input name="appId" inputmode="numeric" required autocomplete="off"></label><label>Private key<textarea name="pem" required autocomplete="off" spellcheck="false"></textarea></label><button>Verify existing app</button></form>
          ${restartAvailable ? `<details><summary>No app was created?</summary><p>Starting again invalidates the old return link. Any app already created on GitHub remains there; this does not delete or revoke it. Check GitHub before authorizing a new registration.</p><form id="restart"><label><input type="checkbox" required>I checked GitHub and authorize a new app registration.</label><button>Start a new registration</button></form></details>` : ""}
          <p id="status" role="status"></p><a href="${escape(returnUrl(runId))}">Return to connection</a></main><script nonce="${nonce}">
          async function submit(body){try{const response=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),cache:'no-store',credentials:'same-origin'});if(!response.ok)throw new Error();const result=await response.json();location.assign(result.returnUrl);}catch{document.getElementById('status').textContent='Recovery could not finish. Return to the connection to check its current status.'}}
          const form=document.getElementById('private');form.addEventListener('submit',event=>{event.preventDefault();const data=new FormData(form);const body={ticket:${JSON.stringify(ticket)},appId:data.get('appId'),pem:data.get('pem')};form.reset();void submit(body)});
          document.getElementById('restart')?.addEventListener('submit',event=>{event.preventDefault();void submit({ticket:${JSON.stringify(ticket)},restart:true})});addEventListener('pagehide',()=>form.reset());<\/script></html>`, { headers: {
					...headers,
					"content-type": "text/html; charset=utf-8",
					"content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`
				} });
			}
			if (new URL(request.url).pathname.endsWith("/callback")) {
				try {
					await children.callback(context, callbackUrl);
				} catch {
					await advance(actor, runId);
					return new Response(`<!doctype html><html lang="en"><title>GitHub needs attention</title><main><h1>GitHub could not confirm this return</h1><p>No authorization was inferred from this callback. Return to the connection for the current verified status and recovery options.</p><a href="${escape(returnUrl(runId))}">Return to connection</a></main></html>`, {
						status: 409,
						headers: {
							...headers,
							"content-type": "text/html; charset=utf-8",
							"content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
						}
					});
				}
				await advance(actor, runId);
				return new Response(null, {
					status: 303,
					headers: {
						location: returnUrl(runId),
						"cache-control": "no-store",
						"referrer-policy": "no-referrer"
					}
				});
			}
			const handoff = await children.human(context).catch(async () => {
				await advance(actor, runId);
			});
			if (!handoff) return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><title>GitHub needs attention</title><main><h1>GitHub setup needs attention</h1><p>The handoff expired or GitHub could not verify the selected account. Your completed steps are preserved. Return to check the account or recover this registration.</p><a href="${escape(returnUrl(runId))}">Return to connection</a></main></html>`, {
				status: 409,
				headers: {
					...headers,
					"content-type": "text/html; charset=utf-8",
					"content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
				}
			});
			if (handoff.method === "GET") return new Response(null, {
				status: 303,
				headers: {
					location: handoff.url,
					"cache-control": "no-store",
					"referrer-policy": "no-referrer"
				}
			});
			const nonce = randomUUID();
			return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Continue with GitHub</title><main><h1>Continue at GitHub</h1><p>GitHub will ask you to confirm the app and its permissions. If you are not redirected, continue below.</p><form id="handoff" method="post" action="${escape(handoff.url)}"><input type="hidden" name="manifest" value="${escape(JSON.stringify(handoff.manifest))}"><button>Continue with GitHub</button></form></main><script nonce="${nonce}">document.getElementById('handoff').submit();<\/script></html>`, { headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
				"content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; form-action https://github.com; frame-ancestors 'none'; base-uri 'none'`
			} });
		}
	});
	async function advance(actor, runId) {
		let run = await runtime.commands.snapshot(actor, runId);
		for (const node of run.nodes) {
			if (node.verified) continue;
			const result = await runtime.commands.advance(actor, runId, node.id, run.revision, `return:${runId}:${node.id}:${run.revision}`);
			run = await runtime.commands.snapshot(actor, runId);
			if (result.state !== "complete") break;
		}
	}
	return runtime;
}
//#endregion
//#region src/server/agent/workflow-api.ts
/** Wake conveys no approval. The durable outbox retries false (hook not yet registered). */
async function wakeAgent(commands, actor, runId) {
	await commands.snapshot(actor, runId);
	try {
		await resumeHook(`ceremony-agent:${runId}`, { wake: true });
		return true;
	} catch {
		return false;
	}
}
/** Server outbox dispatcher. History receives only run correlation plus {wake:true}, never callback contents. */
async function dispatchAgentWakes(runtime, tenant, resume = wakeAgent) {
	let after = "";
	for (;;) {
		const page = await runtime.store.transaction((tx) => tx.list(tenant, "outbox", 100, after));
		for (const row of page) {
			if (row.value.task !== "agent-wake" || row.value.status !== "pending") continue;
			const key = {
				tenant,
				kind: "outbox",
				id: row.id
			};
			const fence = await runtime.store.transaction(async (tx) => {
				const current = await tx.get(key);
				if (!current || current.value.status !== "pending") return void 0;
				return tx.claim(key, `wake-${randomUUID()}`, 3e4);
			}).catch((error) => {
				if (error instanceof PersistenceConflict) return void 0;
				throw error;
			});
			if (!fence) continue;
			let status = "pending";
			try {
				const actor = await runtime.agentActor(row.value.runId);
				if (actor.tenantId !== tenant || actor.subjectId !== row.value.subjectId) throw new AuthorizationError("denied");
				if (await resume(runtime.commands, actor, row.value.runId)) status = "delivered";
			} catch (error) {
				if (error instanceof AuthorizationError) status = "blocked";
			}
			await runtime.store.transaction(async (tx) => {
				await tx.assertFence(fence);
				if (status !== "pending") await tx.put(key, {
					...row.value,
					status
				}, row.revision);
				await tx.cancel(key);
			});
		}
		if (page.length < 100) break;
		after = page.at(-1).id;
	}
}
//#endregion
//#region src/server/hosted/continuations.ts
/** Explicit host configuration only. Endpoint and authorization never come from a recipe or browser request. */
function hostedContinuation(env, fetcher = fetch) {
	if (!env.CEREMONY_CONTINUATION_URL && !env.CEREMONY_CONTINUATION_TOKEN) return void 0;
	const endpoint = new URL(env.CEREMONY_CONTINUATION_URL ?? "");
	const token = env.CEREMONY_CONTINUATION_TOKEN;
	if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !token || token.length < 32) throw new Error("Invalid host continuation configuration");
	return {
		id: "host-task",
		async handler(input) {
			try {
				const response = await fetcher(endpoint, {
					method: "POST",
					redirect: "error",
					signal: AbortSignal.timeout(15e3),
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
						"idempotency-key": input.deliveryId
					},
					body: JSON.stringify(input)
				});
				if (!response.ok) throw new Error();
				if (object({
					deliveryId: string(),
					completed: literal(true)
				}).strict().parse(await response.json()).deliveryId !== input.deliveryId) throw new Error();
			} catch {
				throw new Error("Host continuation unavailable");
			}
		}
	};
}
async function dispatchHostedContinuations(runtime, tenant) {
	await dispatchAgentWakes(runtime, tenant);
	let after = "";
	const subjects = /* @__PURE__ */ new Set();
	for (;;) {
		const page = await runtime.store.transaction((tx) => tx.list(tenant, "outbox", 100, after));
		for (const row of page) if (row.value.status === "pending" && row.value.subjectId) subjects.add(row.value.subjectId);
		if (page.length < 100) break;
		after = page.at(-1).id;
	}
	for (const subjectId of subjects) await runtime.flushContinuations({
		tenantId: tenant,
		subjectId,
		sessionId: "continuation-workload",
		actorKind: "system",
		capabilities: ["executor"]
	});
}
/** Dedicated cron/workload authentication; not end-user authentication or a grant for a different task. */
function validContinuationWorker(request, secret) {
	if (!secret || secret.length < 32) return false;
	const value = request.headers.get("authorization") ?? "";
	const expected = `Bearer ${secret}`;
	return Buffer.byteLength(value) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}
//#endregion
//#region src/server/environment-schema.ts
const environmentValuesSchema = record(string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), string().max(16384));
const environmentEditSchema = object({
	revision: number().int().nonnegative(),
	values: environmentValuesSchema.default({}),
	remove: array(string()).max(100).default([]),
	dotenv: string().max(64e3).optional()
}).strict();
//#endregion
//#region src/server/async-environment.ts
const githubNames = [
	"GITHUB_APP_ID",
	"GITHUB_APP_PRIVATE_KEY",
	"GITHUB_APP_SLUG",
	"GITHUB_APP_OWNER"
];
function nextGitHubEnvironmentRevision(previous, values, revision) {
	return githubNames.some((name) => previous[name] !== values[name]) ? revision + 1 : revision;
}
/** Native user-session environment shared by every connector; read is a trusted server-only operation. */
var AsyncCeremonyEnvironment = class {
	store;
	constructor(store) {
		this.store = store;
	}
	key(actor) {
		return {
			tenant: actor.tenantId,
			kind: "session",
			id: `environment:${createHash("sha256").update(JSON.stringify([actor.subjectId, actor.sessionId])).digest("hex")}`
		};
	}
	async read(actor) {
		requireCapability(actor, "executor");
		const record = await this.store.transaction((tx) => tx.get(this.key(actor)));
		return {
			revision: record?.revision ?? 0,
			githubRevision: record?.value.githubRevision ?? record?.revision ?? 0,
			stripeRevision: record?.value.stripeRevision ?? record?.revision ?? 0,
			values: record?.value.values ?? {}
		};
	}
	async describe(actor) {
		const record = await this.read(actor);
		return {
			revision: record.revision,
			names: Object.keys(record.values).sort()
		};
	}
	async update(actor, input) {
		requireCapability(actor, "executor");
		if (actor.actorKind !== "human") throw new AuthorizationError("denied");
		const parsed = environmentEditSchema.safeParse(input);
		if (!parsed.success) throw new AuthorizationError("invalid_request");
		const edit = parsed.data;
		let imported = {};
		if (edit.dotenv !== void 0) try {
			imported = environmentValuesSchema.parse(parseEnv(edit.dotenv));
			if (!Object.keys(imported).length) throw new Error();
		} catch {
			throw new AuthorizationError("invalid_request");
		}
		return this.store.transaction(async (tx) => {
			const key = this.key(actor);
			const record = await tx.get(key);
			if ((record?.revision ?? 0) !== edit.revision) throw new PersistenceConflict();
			const values = {
				...record?.value.values,
				...imported,
				...edit.values
			};
			for (const name of edit.remove) delete values[name];
			if (Object.keys(values).length > 100 || Buffer.byteLength(JSON.stringify(values)) > 64e3) throw new AuthorizationError("invalid_request");
			const githubRevision = nextGitHubEnvironmentRevision(record?.value.values ?? {}, values, record?.value.githubRevision ?? record?.revision ?? 0);
			return {
				revision: await tx.put(key, {
					values,
					githubRevision,
					stripeRevision: (record?.value.stripeRevision ?? record?.revision ?? 0) + (record?.value.values.STRIPE_SECRET_KEY !== values.STRIPE_SECRET_KEY ? 1 : 0)
				}, record?.revision ?? null),
				names: Object.keys(values).sort()
			};
		});
	}
	async resolveGitHub(actor, baseVersion) {
		const record = await this.read(actor);
		return resolveGitHubEnvironment({
			revision: record.githubRevision,
			values: record.values,
			sessionId: actor.sessionId
		}, baseVersion);
	}
	async resolveStripe(actor, baseVersion) {
		const record = await this.read(actor);
		return resolveStripeEnvironment({
			revision: record.stripeRevision,
			values: record.values,
			sessionId: actor.sessionId
		}, baseVersion);
	}
};
function resolveStripeEnvironment(record, baseVersion) {
	return {
		version: createHash("sha256").update(JSON.stringify([
			baseVersion,
			record.sessionId,
			record.revision
		])).digest("hex"),
		...record.values.STRIPE_SECRET_KEY ? { token: record.values.STRIPE_SECRET_KEY } : {}
	};
}
/** Shared by async hosted and legacy local adapters. Only session/revision metadata enters the version digest. */
function resolveGitHubEnvironment(record, baseVersion) {
	const { revision, values, sessionId } = record;
	const configurationVersion = revision === 0 && !githubNames.some((name) => Boolean(values[name])) ? baseVersion : createHash("sha256").update(JSON.stringify([
		baseVersion,
		sessionId,
		revision
	])).digest("hex");
	const names = githubNames;
	if (!names.some((name) => Boolean(values[name]))) return { configurationVersion };
	if (names.filter((name) => !values[name]).length) throw new Error("incomplete-github-configuration");
	const parsed = object({
		id: number$1().int().positive(),
		pem: string().min(1).max(3e4),
		slug: string().regex(/^[a-zA-Z0-9-]+$/),
		owner: object({ login: string().regex(/^[a-zA-Z0-9-]{1,100}$/) })
	}).safeParse({
		id: values.GITHUB_APP_ID,
		pem: values.GITHUB_APP_PRIVATE_KEY?.replace(/(-----BEGIN (?:RSA )?PRIVATE KEY-----)\s*/, "$1\n").replace(/\s*(-----END (?:RSA )?PRIVATE KEY-----)/, "\n$1"),
		slug: values.GITHUB_APP_SLUG,
		owner: { login: values.GITHUB_APP_OWNER }
	});
	if (!parsed.success) throw new AuthorizationError("invalid_request");
	return {
		configurationVersion,
		app: parsed.data
	};
}
//#endregion
//#region src/server/persistence/maintenance.ts
/** Configuration comes from the operator secret store, never backup material. At most four previous keys. */
function configuredKeyring(env) {
	try {
		const id = string().regex(/^[A-Za-z0-9_-]{1,64}$/).parse(env.CEREMONY_VAULT_KEY_ID);
		const key = string().regex(/^[a-fA-F0-9]{64}$/).parse(env.CEREMONY_VAULT_KEY);
		const raw = env.CEREMONY_VAULT_PREVIOUS_KEYS ?? "{}";
		if (raw.length > 1024) throw new Error();
		const previous = record(string().regex(/^[A-Za-z0-9_-]{1,64}$/), string().regex(/^[a-fA-F0-9]{64}$/)).parse(JSON.parse(raw));
		if (Object.keys(previous).length > 4 || Object.hasOwn(previous, id)) throw new Error();
		return {
			current: id,
			keys: Object.fromEntries(Object.entries({
				...previous,
				[id]: key
			}).map(([name, value]) => [name, Buffer.from(value, "hex")]))
		};
	} catch {
		throw new Error("Invalid vault keyring configuration");
	}
}
//#endregion
//#region src/server/hosted/runtime.ts
var runtime_exports = /* @__PURE__ */ __exportAll({
	createHostedRuntime: () => createHostedRuntime,
	getHostedRuntime: () => getHostedRuntime
});
let instance;
/** Process cache holds clients only. Shared database and current policy remain authoritative. */
function getHostedRuntime() {
	return instance ??= createHostedRuntime().catch(() => {
		instance = void 0;
		throw new Error("Hosted configuration unavailable");
	});
}
async function createHostedRuntime(env = process.env) {
	if (env.CEREMONY_TEST_PROFILE === "true" && env.NODE_ENV !== "test") throw new Error("Test hosting requires the test runtime");
	const testProfile = env.NODE_ENV === "test" && env.CEREMONY_TEST_PROFILE === "true";
	const config = strictObject({
		origin: url(),
		database: string().min(1),
		key: string().regex(/^[a-fA-F0-9]{64}$/),
		keyId: string().regex(/^[A-Za-z0-9_-]{1,64}$/),
		issuer: url(),
		clientId: string().min(1).optional(),
		tenant: string().min(1).max(100),
		account: string().regex(/^[A-Za-z0-9-]{1,100}$/),
		configurationVersion: string().min(1).max(100)
	}).safeParse({
		origin: env.CEREMONY_PUBLIC_ORIGIN,
		database: env.CEREMONY_DATABASE_URL,
		key: env.CEREMONY_VAULT_KEY,
		keyId: env.CEREMONY_VAULT_KEY_ID,
		issuer: env.CEREMONY_OIDC_ISSUER,
		clientId: env.CEREMONY_OIDC_CLIENT_ID,
		tenant: env.CEREMONY_TENANT_ID,
		account: env.CEREMONY_GITHUB_ACCOUNT,
		configurationVersion: env.CEREMONY_CONFIGURATION_VERSION
	});
	if (!config.success) throw new Error("Missing or invalid hosted configuration");
	const c = config.data;
	const continuation = hostedContinuation(env);
	if (new URL(c.origin).origin !== c.origin || !c.origin.startsWith("https://") && !(testProfile && new URL(c.origin).protocol === "http:" && new URL(c.origin).hostname === "127.0.0.1")) throw new Error("Exact production HTTPS origin is required");
	let database;
	try {
		database = new URL(c.database);
	} catch {
		throw new Error("Invalid hosted database configuration");
	}
	if (!["postgres:", "postgresql:"].includes(database.protocol) || !testProfile && (database.searchParams.getAll("sslmode").length !== 1 || database.searchParams.get("sslmode") !== "verify-full")) throw new Error("Production PostgreSQL requires verified TLS");
	const store = new PostgresCeremonyStore({ connectionString: c.database }, configuredKeyring(env));
	const environment = new AsyncCeremonyEnvironment(store);
	try {
		await store.migrate();
		return createGitHubRuntime({
			store,
			identity: await createOidcIdentity({
				origin: c.origin,
				issuer: c.issuer,
				...c.clientId ? { clientId: c.clientId } : {},
				clientName: `Ceremony · ${c.tenant}`,
				...testProfile ? { development: true } : {},
				...env.CEREMONY_OIDC_CLIENT_SECRET ? { clientSecret: env.CEREMONY_OIDC_CLIENT_SECRET } : {},
				mapClaims: async (claims) => {
					const roles = array(_enum([
						"author",
						"reviewer",
						"publisher",
						"executor",
						"admin"
					])).max(5).parse(claims.ceremony_roles ?? ["executor"]);
					return {
						tenantId: c.tenant,
						subjectId: claims.sub,
						capabilities: roles
					};
				}
			}, persistentIdentityStore(store)),
			origin: c.origin,
			environment: "production",
			configurationVersion: c.configurationVersion,
			stripe: { configuration: (actor) => environment.resolveStripe(actor, c.configurationVersion) },
			configuration: (actor) => environment.resolveGitHub(actor, c.configurationVersion),
			expectedAccount: c.account,
			...continuation ? { continuation } : {},
			modelConfiguration: {
				...env.CEREMONY_MODEL ? { model: env.CEREMONY_MODEL } : {},
				...env.CEREMONY_MODEL_URL ? { endpoint: env.CEREMONY_MODEL_URL } : {},
				...env.CEREMONY_MODEL_KEY ? { apiKey: env.CEREMONY_MODEL_KEY } : {},
				...env.CEREMONY_MODEL_GATEWAY === "true" ? { gateway: true } : {}
			},
			authorize: async (actor, run, operationId) => actor.tenantId === c.tenant && actor.subjectId === run.subjectId && actor.capabilities.includes("executor") && (operationId === "continuation" || run.configurationVersion === (run.provider === "stripe" ? (await environment.resolveStripe(actor, c.configurationVersion)).version : (await environment.resolveGitHub(actor, c.configurationVersion)).configurationVersion)) && run.origin === c.origin && (run.provider === "stripe" ? run.target === "self" : run.provider === "github" && run.target === c.account)
		});
	} catch {
		await store.close();
		throw new Error("Hosted identity initialization failed");
	}
}
//#endregion
export { AsyncCeremonyEnvironment, AuthorizationError, PersistenceConflict, actorContextSchema, assertRequestBoundary, authenticatedActor, boundedJson, configuredModel, demonstrationConsentSchema, dispatchHostedContinuations, getHostedRuntime, identifierSchema, manifestSchema, parseRecipeImport, recipeDefinitionSchema, requireCapability, reserveRequest, runtime_exports, semanticVersionSchema, serviceManifests, validContinuationWorker, validateAgentText, validateConnectorWorkflows };
