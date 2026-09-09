import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { ProtectedCommandService, deliverContinuations } from "../src/server/commands.js";
import { Demonstrations } from "../src/server/demonstrations.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import { OperationRegistry } from "../src/server/recipes/registry.js";
import type { ActorContext } from "../src/core/operation-contracts.js";

const actor:ActorContext={tenantId:"tenant",subjectId:"alice",sessionId:"session",actorKind:"human",capabilities:["executor","author","reviewer","publisher"]};
async function fixture(t:TestContext,options:{verified?:boolean;handler?:()=>Promise<void>}={}) {
  const store=new SQLiteCeremonyStore(":memory:",{current:"test",keys:{test:randomBytes(32)}});
  t.after(()=>store.close());
  let effects=0,authorized=true;
  const registry=new OperationRegistry(new Map([["verified",{classification:"public",schema:z.boolean()}]]));
  for(const id of ["prepare","verify"])
    registry.register({contract:{id,version:"1.0.0",provider:"github",profile:"app",inputs:{},outputs:{verified:{contract:"verified",required:true}},effects:["read"],verifier:"provider",humanFallback:"provider-consent"},inputSchema:z.strictObject({}),outputSchema:z.strictObject({verified:z.boolean()}),classifications:{},fixtures:["signed-local-provider"],handler:async()=>{effects++;await options.handler?.();return {state:"complete",outputs:{verified:true}};},verify:async()=>options.verified??true});
  const commands=new ProtectedCommandService(store,registry,async()=>authorized);
  const run=await commands.createRun(actor,{provider:"github",profile:"app",target:"personal",origin:"https://app.example",environment:"test",configurationVersion:"v1"},[{id:"prepare",operationId:"prepare",operationVersion:"1.0.0",dependsOn:[],bindings:{}},{id:"verify",operationId:"verify",operationVersion:"1.0.0",dependsOn:["prepare"],bindings:{}}],{},"resume-host");
  return {store,commands,run,registry,effects:()=>effects,revoke:()=>{authorized=false;}};
}

test("AC-16 AC-27: protected commands reject unmet dependencies and deduplicate concurrent commands",async t=>{
  const f=await fixture(t);
  await assert.rejects(f.commands.advance(actor,f.run.id,"verify",1,"forged"));
  assert.equal(f.effects(),0);
  const results=await Promise.all([f.commands.advance(actor,f.run.id,"prepare",1,"same"),f.commands.advance(actor,f.run.id,"prepare",1,"same")]);
  assert.equal(f.effects(),1);
  assert.ok(results.some(x=>x.verified));
  const repeat=await f.commands.advance(actor,f.run.id,"prepare",1,"same");
  assert.equal(repeat.verified,true);
  await assert.rejects(f.commands.advance(actor,f.run.id,"verify",2,"same"));
  await assert.rejects(f.commands.snapshot({...actor,subjectId:"mallory"},f.run.id));
  assert.equal(f.effects(),1);
});

test("AC-07 AC-10 AC-35: authoritative recording consent and durable continuation survive without UI callbacks",async t=>{
  const f=await fixture(t);
  const demos=new Demonstrations(f.store);
  const demo=await demos.start(actor,f.run.id);
  await f.commands.advance(actor,f.run.id,"prepare",1,"first");
  const timeline=await demos.timeline(actor,demo.id);
  assert.equal(timeline.events.length,1);
  assert.equal(timeline.events[0]!.verification,"accepted");
  const stopped=await demos.change(actor,demo.id,demo.revision,"stopped");
  await f.commands.advance(actor,f.run.id,"verify",2,"second");
  assert.equal((await demos.timeline(actor,demo.id)).events.length,1);
  const seen=new Set<string>();let deliveries=0;
  const handlers=new Map([["resume-host",async({deliveryId}:{deliveryId:string})=>{deliveries++;seen.add(deliveryId);if(deliveries===1)throw new Error("ack lost");}]]);
  await assert.rejects(deliverContinuations(f.store,actor,handlers));
  await f.store.transaction(tx=>tx.cancel({tenant:actor.tenantId,kind:"outbox",id:`continuation:${f.run.id}`}));
  await deliverContinuations(f.store,actor,handlers);
  await deliverContinuations(f.store,actor,handlers);
  assert.equal(seen.size,1);assert.equal(deliveries,2);
  await demos.change(actor,demo.id,stopped.revision,"discarded");
  await assert.rejects(demos.timeline(actor,demo.id));
  assert.equal((await f.commands.snapshot(actor,f.run.id)).status,"complete");
  assert.ok((await f.store.transaction(tx=>tx.list(actor.tenantId,"audit"))).length>0);
});

test("AC-18 AC-33: revocation and cancellation during an external call fence late results",async t=>{
  let release!:()=>void;
  const wait=new Promise<void>(r=>{release=r;});
  const f=await fixture(t,{handler:()=>wait});
  const pending=f.commands.advance(actor,f.run.id,"prepare",1,"slow");
  while(f.effects()===0) await new Promise<void>(r=>setImmediate(r));
  await f.commands.cancel(actor,f.run.id,1);
  release();
  await assert.rejects(pending);
  assert.equal((await f.commands.snapshot(actor,f.run.id)).status,"cancelled");
  assert.equal((await f.commands.snapshot(actor,f.run.id)).nodes[0]!.verified,false);
  f.revoke();
  await assert.rejects(f.commands.advance(actor,f.run.id,"prepare",2,"revoked"));
  assert.equal(f.effects(),1);
});

test("AC-29: an unverified handler response or uncertain effect cannot satisfy a dependency",async t=>{
  const f=await fixture(t,{verified:false});
  const result=await f.commands.advance(actor,f.run.id,"prepare",1,"unverified");
  assert.equal(result.verified,false);assert.equal(result.state,"failed");
  await assert.rejects(f.commands.advance(actor,f.run.id,"verify",2,"downstream"));
  assert.equal(f.effects(),1);
  assert.equal(JSON.stringify(await f.commands.snapshot(actor,f.run.id)).includes("outputs"),false);
});
