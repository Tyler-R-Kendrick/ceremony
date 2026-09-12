import { startAuthProvider } from "/home/user/ceremony/tests/doubles/auth-provider/server.js";
const p = await startAuthProvider({ seed: 11, accounts: [{ email: "owner@ceremony.invalid", username: "owner", password: "pw-abc12345", verified: true }] });
console.log(`ORIGIN=${p.origin}`);
await new Promise(() => {});
