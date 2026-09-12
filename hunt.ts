import { authScenarios, createIdentity, startScenario } from "/home/user/ceremony/tests/doubles/auth-provider/scenarios.js";
import { createHttpCeremonyPage } from "/home/user/ceremony/tests/doubles/http-page.js";
import { createScriptedInterpreter } from "/home/user/ceremony/tests/doubles/scripted-interpreter.js";
import { runCeremony } from "/home/user/ceremony/src/server/browser-driver.js";
const ids = ["sign-in","registration-with-emailed-code","registration-requiring-terms","registration-started-from-sign-in","sign-in-with-second-factor","authorization-code-with-consent"];
let runs = 0, fails = 0;
for (let seed = 701; seed <= 4000; seed++) {
  for (const id of ids) {
    const scenario = authScenarios.find((s) => s.id === id)!;
    const identity = createIdentity();
    const context = await startScenario(scenario, identity, undefined, seed);
    const plan = await scenario.plan(context);
    const page = createHttpCeremonyPage();
    await page.goto(plan.entryUrl);
    const { entryUrl, state, ...options } = plan;
    runs++;
    try {
      const r = await runCeremony({ ...options, page, interpreter: createScriptedInterpreter() });
      if (r.status !== scenario.expect.status) { fails++; console.log(`FAIL ${id} seed=${seed}: ${r.status}${r.status==="blocked"?":"+r.reason:""} via ${r.transcript.map(s=>s.action).join(">")}`); }
    } catch (e) { fails++; console.log(`THREW ${id} seed=${seed}: ${(e as Error).message}`); }
    await context.provider.close();
  }
}
console.log(`runs=${runs} fails=${fails}`);
