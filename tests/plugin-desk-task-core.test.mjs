import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync, chmodSync, lstatSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createDeskStore } from '../plugin/server/desk-store.ts';
import { runAssignmentRegister } from '../plugin/server/desk-handback.ts';
import { runTaskCommand, runTaskEffect, taskIntegrationCleanupAdmissionSha256, taskIntegrationCleanupArtifactPath,
  taskIntegrationCleanupBundleBytes, taskIntegrationCleanupSourceControlDigest } from '../plugin/server/desk-task.ts';
import { createDeskSeat, decideSeatCommand } from '../plugin/server/desk-seat.ts';
import { memberRow, seedMemberships } from '../tests/helpers/desk-bridge-fixture.mjs';
import { resolveDeskTaskCapacityReserve } from '../plugin/server/desk-task-capacity.ts';
import { createRoleInjection } from '../plugin/server/role-injection.ts';

test('real durable reserve, issue replay, atomic attachment and scope claim', async () => {
const dir = mkdtempSync(join(tmpdir(), 'slp-task-admit-'));
try {
  const repository = join(dir, 'repo'); mkdirSync(repository);
  execFileSync('git', ['init', '-q', repository]);
  const stableRoot = join(dir, 'home', 'slp-runtime');
  mkdirSync(stableRoot, { recursive: true, mode: 0o700 });
  const store = createDeskStore({ stableRoot });
  const lead = memberRow('native-owner', { provider: 'slp-codex-lead', at: '2026-01-01T00:00:00.000Z' },
    { role: 'lead', agentId: 'native-owner', createCwd: repository, workspaceId: null });
  const repo = { hostId: 'local', gitCommonDir: realpathSync(join(repository, '.git')) };
  const repoKey = await seedMemberships(store, repo, [lead]);
  const ctx = { repoKey, row: lead };
  const registered = await runAssignmentRegister(ctx, { requestId: 'register', authorityRef: 'human:fixture', objective: 'Investigation' }, { store });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  const assignmentId = registered.assignmentId;
  const defined = await runTaskCommand(ctx, {
    operation: 'define', requestId: 'define', assignmentId, taskId: null,
    expectedLedgerRevision: store.read(repoKey).ledger.revision,
    expectedBriefRevision: 0, expectedOwnershipRevision: 0, expectedTaskRevision: 0,
    task: { state: 'open', outcome: 'Return a bounded investigation artifact', objective: null,
      authorityRef: 'human:fixture', dependencies: [], scope: {label:'bounded writer',refs:['grant:fixture'],ownership:{writerAgentId:'future-seat',writerAuthorityRef:null,paths:['src/core'],resources:[],stateOwners:[],dependsOnScopeIds:[],notifications:[]},reviewPlan:{kind:'not-required',authorityRef:'human:fixture',ruleRef:'protocol:proof',reason:'fixture independent scope proof',lenses:[],exemptionClass:null}},
      proofPolicy: { kind: 'declared', authorityRef: 'human:fixture', ruleRef: 'protocol:proof',
        reason: 'Read-only investigation; owner verifies artifact', requiredChecks: [], requiredEvidence: [],
        reviewRequired: false, availability: 'artifact', verificationRecipes: [] },
      grants: { create: 'grant:create', send: 'grant:send', archive: null, integrate: null, commit: null },
      budgets: { maxAttempts: 1, maxActionsPerAttempt: 8 }, reason: null },
  }, { store });
  assert.equal(defined.ok, true, JSON.stringify(defined));
  const reserved = await runTaskCommand(ctx, {
    operation: 'reserve', requestId: 'reserve', assignmentId, taskId: defined.taskId,
    expectedLedgerRevision: store.read(repoKey).ledger.revision,
    expectedBriefRevision: 0, expectedOwnershipRevision: 0, expectedTaskRevision: 1,
    grantRef: 'grant:create', placement: { kind: 'shared-checkout', cwd: repository },
    runtime: { optionId: 'fixture', catalogSha256: 'a'.repeat(64) },
    seatPin: { provider: 'slp-codex-peer', model: 'fixture', optionId: 'fixture', catalogSha256: 'a'.repeat(64) },
    reuseTarget: 'new', effectBudget: 8,
  }, { store });
  assert.equal(reserved.ok, true, JSON.stringify(reserved));
  const issued = await runTaskEffect(ctx, {
    operation: 'issue', requestId: 'issue', attemptId: reserved.attemptId, actionId: reserved.next.actionId,
  }, { store });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  assert.equal(store.read(repoKey).state, 'ok');
  const replay = await runTaskEffect(ctx, {operation:'issue',requestId:'issue',attemptId:reserved.attemptId,actionId:reserved.next.actionId},{store});
  assert.equal(replay.perform,false,'receipt replay must never repeat effects');
  const at = '2026-01-01T00:00:00.000Z';
  const worker = memberRow('native-worker',{provider:'slp-codex-peer',at},{agentId:'native-worker',createCwd:repository,workspaceId:null});
  await seedMemberships(store,repo,[lead,worker]);
  const observed = await runTaskEffect(ctx,{operation:'observe',requestId:'place-observe',attemptId:reserved.attemptId,actionId:reserved.next.actionId,actionKind:'place',receipt:{status:'observed',cwd:repository}},{store});
  assert.equal(observed.ok,true,JSON.stringify(observed));
  const created=await runTaskEffect(ctx,{operation:'intent',requestId:'create-intent',attemptId:reserved.attemptId,actionKind:'create',body:{grantRef:'grant:create'}},{store});assert.equal(created.ok,true,JSON.stringify(created));
  const createIssue=await runTaskEffect(ctx,{operation:'issue',requestId:'create-issue',attemptId:reserved.attemptId,actionId:created.actionId},{store});assert.equal(createIssue.perform,true,JSON.stringify(createIssue));
  const createObserve=await runTaskEffect(ctx,{operation:'observe',requestId:'create-observe',attemptId:reserved.attemptId,actionId:created.actionId,actionKind:'create',receipt:{status:'observed',agentId:worker.agentId}},{store});assert.equal(createObserve.ok,true,JSON.stringify(createObserve));
  const bound = await runTaskEffect(ctx,{operation:'bind',requestId:'bind',attemptId:reserved.attemptId,member:{agentId:worker.agentId,membershipId:worker.membershipId},observed:{provider:worker.provider,createCwd:repository,workspaceId:null}},{store});
  assert.equal(bound.ok,true,JSON.stringify(bound));
  const ledger = store.read(repoKey).ledger;
  assert.ok(ledger.assignments.find(a=>a.assignmentId===assignmentId).seats.some(s=>s.membershipId===worker.membershipId));
  const attempt = ledger.taskEntries.filter(r=>r.kind==='attempt').at(-1);
  assert.ok(attempt.boundScopeId);
  assert.equal(attempt.boundScopeRevision,1);
  assert.equal(ledger.scopeTransitions.at(-1).to,'claimed');
  assert.equal(store.read(repoKey).state,'ok');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

});

async function coreFixture(t,{now}={}) {
  const dir = mkdtempSync(join(tmpdir(), 'slp-core-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const repository=join(dir,'repo');mkdirSync(repository);execFileSync('git',['init','-q',repository]);
  const stableRoot=join(dir,'home','slp-runtime');mkdirSync(stableRoot,{recursive:true,mode:0o700});
  const store=createDeskStore({stableRoot,...(now===undefined?{}:{now})});
  const at='2026-01-01T00:00:00.000Z';
  const lead=memberRow('owner',{provider:'slp-codex-lead',at},{role:'lead',agentId:'owner',createCwd:repository,workspaceId:null});
  const worker=memberRow('worker',{provider:'slp-codex-peer',at},{agentId:'worker',createCwd:repository,workspaceId:null});
  const successor=memberRow('next',{provider:'slp-codex-lead',at},{role:'lead',agentId:'next',createCwd:repository,workspaceId:null});
  const repo={hostId:'local',gitCommonDir:realpathSync(join(repository,'.git'))};
  const repoKey=await seedMemberships(store,repo,[lead,worker,successor]);
  const ctx={repoKey,row:lead};const deps={store};
  const registration=await runAssignmentRegister(ctx,{requestId:'register',authorityRef:'human:fixture',objective:'bounded task'},{store});
  assert.equal(registration.ok,true,JSON.stringify(registration));
  const assignmentId=registration.assignmentId;
  const ledger=()=>{const read=store.read(repoKey);assert.equal(read.state,'ok',JSON.stringify(read));return read.ledger;};
  const pins=(taskRevision=1)=>({expectedLedgerRevision:ledger().revision,expectedBriefRevision:0,expectedOwnershipRevision:0,expectedTaskRevision:taskRevision});
  const body={state:'open',outcome:'artifact',objective:null,authorityRef:'human:fixture',dependencies:[],scope:null,proofPolicy:{kind:'declared',authorityRef:'human:fixture',ruleRef:'protocol:proof',reason:'bounded artifact proof',requiredChecks:[],requiredEvidence:[],reviewRequired:false,availability:'artifact',verificationRecipes:[]},grants:{create:'grant:create',send:'grant:send',archive:'grant:archive',integrate:'grant:integrate',commit:null},budgets:{maxAttempts:3,maxActionsPerAttempt:12},reason:null};
  const command=async input=>runTaskCommand(ctx,{assignmentId,...input},deps);
  const effect=async input=>runTaskEffect(ctx,input,deps);
  const define=async(id,dependencies=[])=>{const r=await command({operation:'define',requestId:`define-${id}`,taskId:id,...pins(0),task:{...body,dependencies}});assert.equal(r.ok,true,JSON.stringify(r));return id;};
  const reserve=async(id,extra={})=>{const r=await command({operation:'reserve',requestId:`reserve-${id}`,taskId:id,...pins(),grantRef:'grant:send',placement:{kind:'shared-checkout',cwd:repository},runtime:{optionId:'fixture',catalogSha256:'a'.repeat(64)},seatPin:{provider:worker.provider,model:'fixture',optionId:'fixture',catalogSha256:'a'.repeat(64)},reuseTarget:{agentId:worker.agentId},effectBudget:12,...extra});return r;};
  const start=async id=>{
    const reserved=await reserve(id);assert.equal(reserved.ok,true,JSON.stringify(reserved));
    const issue=await effect({operation:'issue',requestId:`place-issue-${id}`,attemptId:reserved.attemptId,actionId:reserved.next.actionId});assert.equal(issue.perform,true,JSON.stringify(issue));
    const base={root:repository,snapshotSha256:'b'.repeat(64),head:null,kind:'git-snapshot',measuredAt:at,incomplete:[],artifactSha256:null};
    const observed=await effect({operation:'observe',requestId:`place-observe-${id}`,attemptId:reserved.attemptId,actionId:reserved.next.actionId,actionKind:'place',receipt:{status:'observed',cwd:repository,base}});assert.equal(observed.ok,true,JSON.stringify(observed));
    const bind=await effect({operation:'bind',requestId:`bind-${id}`,attemptId:reserved.attemptId,member:{agentId:worker.agentId,membershipId:worker.membershipId},observed:{provider:worker.provider,createCwd:repository,workspaceId:null}});assert.equal(bind.ok,true,JSON.stringify(bind));
    const attempt=ledger().taskEntries.filter(r=>r.kind==='attempt'&&r.attemptId===reserved.attemptId).at(-1);
    const controlPins={assignmentId,taskId:id,...pins(),expectedAttemptRevision:attempt.revision};
    const intent=await effect({operation:'intent',requestId:`send-intent-${id}`,attemptId:attempt.attemptId,actionKind:'send',body:{grantRef:'grant:send',controlPins,messageId:`message-${id}`}});assert.equal(intent.ok,true,JSON.stringify(intent));
    const send=await effect({operation:'issue',requestId:`send-issue-${id}`,attemptId:attempt.attemptId,actionId:intent.actionId,actionKind:'send'});assert.equal(send.perform,true,JSON.stringify(send));
    const sent=await effect({operation:'observe',requestId:`send-observe-${id}`,attemptId:attempt.attemptId,actionId:intent.actionId,actionKind:'send',receipt:{status:'observed',messageId:`message-${id}`}});assert.equal(sent.ok,true,JSON.stringify(sent));
    return attempt.attemptId;
  };
  const resultPins=new Map();
  const result=async(id,attemptId,requestId=`result-${id}`)=>{
    if(!resultPins.has(requestId)) resultPins.set(requestId,pins());
    const r=await runTaskCommand({repoKey,row:worker},{operation:'result',assignmentId,requestId,taskId:id,attemptId,...resultPins.get(requestId),result:{snapshotSha256:'b'.repeat(64),candidate:null,handbackId:null,handbackDigest:null,artifacts:[{key:'out.txt',sha256:'c'.repeat(64)}],scopeId:null,scopeRevision:null,reviewRound:null,checkRuns:[],findings:[],provenance:'claimed'}},deps);assert.equal(r.ok,true,JSON.stringify(r));return r;
  };
  const rule=async(id,resultId,verdict='accepted',requestId=`rule-${id}`)=>{
    const r=await command({operation:'rule',requestId,taskId:id,...pins(),adjudication:{resultId,expectedResultRevision:1,verdict,reason:'owner judgment',evidence:[],counterevidence:[],residualRisk:null,findings:[]}});assert.equal(r.ok,true,JSON.stringify(r));return r;
  };
  return {store,dir,repository,repo,repoKey,lead,worker,successor,ctx,deps,assignmentId,body,ledger,pins,command,effect,define,reserve,start,result,rule};
}

test('equal-timestamp revocation is ordered after prior task authority and denies later commits',async t=>{
  const at=new Date('2026-01-01T00:00:00.000Z');
  const f=await coreFixture(t,{now:()=>new Date(at)});await f.define('A');const attemptId=await f.start('A');
  const first=await f.result('A',attemptId,'before-seat-revoke');
  assert.equal(first.ok,true);
  const revoker=createDeskSeat({stableRoot:join(f.dir,'home','slp-runtime'),store:f.store,now:()=>new Date(at),warn:message=>assert.fail(message)});
  await revoker.deskRevoke({agent:{id:f.worker.agentId,workspaceId:null,parentAgentId:f.lead.agentId,provider:f.worker.provider,
    cwd:f.repository,title:null},archivedAt:at.toISOString()});
  const afterRevoke=f.ledger();
  assert.equal(afterRevoke.memberships.find(row=>row.membershipId===f.worker.membershipId).revokedAt,at.toISOString());
  const beforeRequests=afterRevoke.requests.length,beforeEntries=afterRevoke.taskEntries.length;
  const later=await runTaskCommand({repoKey:f.repoKey,row:f.worker},{operation:'result',assignmentId:f.assignmentId,requestId:'after-seat-revoke',taskId:'A',attemptId,
    ...f.pins(1),result:{snapshotSha256:'b'.repeat(64),candidate:null,handbackId:null,handbackDigest:null,
      artifacts:[{key:'out.txt',sha256:'c'.repeat(64)}],scopeId:null,scopeRevision:null,reviewRound:null,checkRuns:[],findings:[],provenance:'claimed'}},f.deps);
  assert.equal(later.ok,false,'a revoked live actor cannot commit a new task result');
  assert.equal(later.code,'AUTHORITY_REQUIRED');
  assert.equal(f.ledger().requests.length,beforeRequests+1,'the denial receipt is recorded under the revoked actor request');
  assert.equal(f.ledger().taskEntries.length,beforeEntries,'a current-authority denial appends no task history');
});

test('a revoked exact owner cannot replay its original reserve after event-time revocation',async t=>{
  const f=await coreFixture(t);await f.define('A');
  const input={operation:'reserve',requestId:'reserve-before-revoke',taskId:'A',...f.pins(),grantRef:'grant:send',
    placement:{kind:'shared-checkout',cwd:f.repository},runtime:{optionId:'fixture',catalogSha256:'a'.repeat(64)},
    seatPin:{provider:f.lead.provider,model:'fixture',optionId:'fixture',catalogSha256:'a'.repeat(64)},
    reuseTarget:{agentId:f.worker.agentId},effectBudget:12};
  const reserved=await f.command(input);assert.equal(reserved.ok,true,JSON.stringify(reserved));
  const revoker=createDeskSeat({stableRoot:join(f.dir,'home','slp-runtime'),store:f.store,warn:message=>assert.fail(message)});
  await revoker.deskRevoke({agent:{id:f.lead.agentId,workspaceId:null,parentAgentId:null,provider:f.lead.provider,
    cwd:f.repository,title:null},archivedAt:new Date().toISOString()});
  const before=f.ledger();
  const replay=await f.command(input);
  assert.equal(replay.ok,false,JSON.stringify(replay));assert.equal(replay.code,'AUTHORITY_REQUIRED');
  const after=f.ledger();
  assert.equal(after.revision,before.revision,'revoked replay is rejected before a new store transaction');
  assert.equal(after.requests.length,before.requests.length);
  assert.equal(after.taskEntries.length,before.taskEntries.length);
});

test('actual role hook and deskMint consume one issued create ticket before exact scope bind',async t=>{
  const f=await coreFixture(t);
  const runtime={optionId:'fixture',catalogSha256:'a'.repeat(64)};
  const seatPin={provider:'slp-codex-peer',model:'fixture',optionId:'fixture',catalogSha256:'a'.repeat(64)};
  const taskScope={label:'claimed writer',refs:['grant:scope'],ownership:{writerAgentId:'task-created-worker',writerAuthorityRef:null,
    paths:['src/core'],resources:[],stateOwners:[],dependsOnScopeIds:[],notifications:[]},
    reviewPlan:{kind:'not-required',authorityRef:'human:fixture',ruleRef:'protocol:proof',reason:'bounded test scope',lenses:[],exemptionClass:null}};
  const defined=await f.command({operation:'define',requestId:'define-task-claim',taskId:'claim-task',...f.pins(0),task:{...f.body,scope:taskScope}});
  assert.equal(defined.ok,true,JSON.stringify(defined));
  const reserved=await f.command({operation:'reserve',requestId:'reserve-task-claim',taskId:'claim-task',...f.pins(),grantRef:'grant:create',
    placement:{kind:'shared-checkout',cwd:f.repository},runtime,seatPin,reuseTarget:'new',effectBudget:8});
  assert.equal(reserved.ok,true,JSON.stringify(reserved));
  const placeIssue=await f.effect({operation:'issue',requestId:'place-claim-issue',attemptId:reserved.attemptId,actionId:reserved.next.actionId});
  assert.equal(placeIssue.perform,true,JSON.stringify(placeIssue));
  const measuredBase={root:f.repository,snapshotSha256:'b'.repeat(64),head:null,kind:'git-snapshot',measuredAt:'2026-01-01T00:00:00.000Z',incomplete:[],artifactSha256:null};
  const placed=await f.effect({operation:'observe',requestId:'place-claim-observe',attemptId:reserved.attemptId,actionId:reserved.next.actionId,
    actionKind:'place',receipt:{status:'observed',cwd:f.repository,base:measuredBase}});
  assert.equal(placed.ok,true,JSON.stringify(placed));
  const labels={'slp.repo':f.repoKey,'slp.assignment':f.assignmentId,'slp.task':'claim-task','slp.attempt':reserved.attemptId};
  const idempotencyKey='task-create-idempotency';
  const hostRequestId='task-create-host-request';
  const createTicket=randomBytes(32).toString('hex');
  const publicInput={phase:'bootstrap',requestId:'public-bootstrap-claim',assignmentId:f.assignmentId,taskId:'claim-task',attemptId:null,
    expectedLedgerRevision:f.ledger().revision,expectedBriefRevision:0,expectedOwnershipRevision:0,expectedTaskRevision:1,
    expectedAttemptRevision:0,grantRef:'grant:create',runtime,placement:{kind:'shared-checkout',cwd:f.repository},effectBudget:8};
  const malformedTicket=await f.effect({operation:'intent',requestId:'create-claim-malformed-ticket',attemptId:reserved.attemptId,actionKind:'create',body:{
    runtime,seat:seatPin,placement:{cwd:f.repository,kind:'shared-checkout'},idempotencyKey,hostRequestId,labels,parent:f.lead.agentId,
    grantRef:'grant:create',createTicketSha256:'bad',publicRequestId:publicInput.requestId,publicRequestSha256:canonicalSha256(publicInput)}});
  assert.equal(malformedTicket.ok,false,'ticketed creates reject malformed ticket/public request pins before creating an action');
  assert.equal(f.ledger().taskEntries.some(row=>row.kind==='action'&&row.actionKind==='create'),false);
  const createIntent=await f.effect({operation:'intent',requestId:'create-claim-intent',attemptId:reserved.attemptId,actionKind:'create',body:{
    runtime,seat:seatPin,placement:{cwd:f.repository,kind:'shared-checkout'},idempotencyKey,hostRequestId,
    labels,parent:f.lead.agentId,grantRef:'grant:create',resourceIntents:['agent-archive','membership'],
    createTicketSha256:sha256Hex(createTicket),publicRequestId:publicInput.requestId,publicRequestSha256:canonicalSha256(publicInput),
  }});
  assert.equal(createIntent.ok,true,JSON.stringify(createIntent));
  const createIssue=await f.effect({operation:'issue',requestId:'create-claim-issue',attemptId:reserved.attemptId,actionId:createIntent.actionId,actionKind:'create'});
  assert.equal(createIssue.perform,true,JSON.stringify(createIssue));
  const createAction=f.ledger().taskEntries.filter(row=>row.kind==='action'&&row.actionId===createIntent.actionId).at(-1);
  assert.equal(createAction.state,'issued');
  const taskCreateTicketContext={ticket:createTicket,
    config:{provider:seatPin.provider,model:seatPin.model,cwd:f.repository,modeId:null,thinkingOptionId:null,featureValues:null}};
  const warnings=[];
  const tracedStore={...f.store,transact:async(...args)=>{try{const result=await f.store.transact(...args);if(result?.constructor?.name==='OperationConflict')warnings.push(`store conflict: ${JSON.stringify(result)}`);return result;}catch(error){warnings.push(`store throw: ${String(error)}`);throw error;}}};
  const seat=createDeskSeat({stableRoot:join(f.dir,'home','slp-runtime'),store:tracedStore,warn:line=>warnings.push(line)});
  const runtimePath=join(f.dir,'runtime'),roleModulePath=join(runtimePath,'plugin/server/runtime/cli/role-bundle.ts');
  mkdirSync(join(runtimePath,'plugin/server/runtime/cli'),{recursive:true});writeFileSync(roleModulePath,'// local role bundle fixture\n');
  writeFileSync(join(runtimePath,'installed.json'),JSON.stringify({candidate:{files:[{path:'plugin/server/runtime/cli/role-bundle.ts'}]}}));
  const roleInjection=createRoleInjection({readActiveBinding:()=>({candidateSha256:'a'.repeat(64),payloadSha256:'b'.repeat(64),
    runtimePath,nodePath:process.execPath,daemonHome:join(f.dir,'home')}),verifyCandidate:()=>{},
    importModule:async()=>({roleBundle:()=>({role:'peer',instructions:'fixture task role'})}),deskMint:input=>seat.deskMint(input)});
  let nativeCreates=0;
  const padMemberships=async target=>{
    const rows=[...f.ledger().memberships];
    while(rows.length<target){const n=rows.length;rows.push({...f.worker,membershipId:crypto.randomUUID(),
      bindingHandleSha256:sha256Hex(`ticket-capacity-${n}`),agentId:`ticket-capacity-${n}`,capacityClaim:null});}
    const padded=await f.store.transact(f.repoKey,{repo:f.repo,actorKey:'fixture:capacity',assignmentId:'fixture',requestId:`ticket-capacity-${target}`,command:{kind:'fixture-capacity'}},
      ()=>({ok:true,events:[],memberships:rows}));
    assert.equal(padded.ok,true,JSON.stringify(padded));
  };
  await padMemberships(LEDGER_LIMITS.memberships-1);
  assert.equal(f.ledger().memberships.length,4095);
  const beforeClaimReserve=resolveDeskTaskCapacityReserve({taskEntries:f.ledger().taskEntries,memberships:f.ledger().memberships,assignments:f.ledger().assignments,
    scopes:f.ledger().scopes,scopeTransitions:f.ledger().scopeTransitions},{eventPayloadBytes:16_384});
  assert.equal(beforeClaimReserve.memberships,1,'an issued new-seat attempt holds exactly one future membership slot');
  const nativeCreateThroughHook=async request=>{
    const hooked=await roleInjection.agentCreate({request});
    const actual=hooked??request;
    nativeCreates++;
    return actual;
  };
  const nativeRequest={config:{...taskCreateTicketContext.config},env:{SLP_TASK_CREATE_TICKET:createTicket}};
  await assert.rejects(nativeCreateThroughHook({...nativeRequest,config:{...nativeRequest.config,model:'foreign-model'}}),/task create ticket claim/);
  assert.equal(nativeCreates,0,'mismatched actual hook config is denied before the fixture native create effect');
  assert.equal(f.ledger().memberships.some(row=>row.capacityClaim?.createActionId===createIntent.actionId),false);
  const createdRequest=await nativeCreateThroughHook(nativeRequest);
  assert.equal(Object.hasOwn(createdRequest.env,'SLP_TASK_CREATE_TICKET'),false,'the hook strips the one-use opaque ticket');
  assert.equal(JSON.stringify(f.ledger()).includes(createTicket),false,'the raw one-use ticket stays out of every durable row/event/request');
  await assert.rejects(nativeCreateThroughHook(nativeRequest),/task create ticket claim/);
  assert.equal(nativeCreates,1,'a duplicate ticket does not reach a second native create');
  const handle=createdRequest.env.SLP_DESK_HANDLE;
  assert.ok(typeof handle==='string');
  assert.match(handle,/^[0-9a-f]{64}$/);assert.equal(nativeCreates,1);
  assert.equal(f.ledger().memberships.length,4096,'the exact issued ticket consumes the one reserved membership slot');
  const afterClaimReserve=resolveDeskTaskCapacityReserve({taskEntries:f.ledger().taskEntries,memberships:f.ledger().memberships,assignments:f.ledger().assignments,
    scopes:f.ledger().scopes,scopeTransitions:f.ledger().scopeTransitions},{eventPayloadBytes:16_384});
  assert.equal(afterClaimReserve.memberships,0,'the consumed claim is not reserved a second time');
  let ledger=f.ledger();
  let claimed=ledger.memberships.find(row=>row.bindingHandleSha256===sha256Hex(handle));
  assert.ok(claimed?.capacityClaim);
  assert.equal(claimed.capacityClaim.createActionId,createIntent.actionId);
  assert.equal(claimed.capacityClaim.attemptId,reserved.attemptId);
  assert.equal(claimed.capacityClaim.version,2);
  assert.equal(claimed.capacityClaim.basis,'create-ticket');
  assert.equal(claimed.capacityClaim.ticketSha256,sha256Hex(createTicket));
  assert.equal(claimed.capacityClaim.intendedBodySha256,createAction.bodySha256);
  assert.equal(claimed.capacityClaim.observedConfigSha256,canonicalSha256(taskCreateTicketContext.config));
  assert.deepEqual(claimed.capacityClaim.createIssueRef,{entryId:createAction.entryId,entrySha256:createAction.entrySha256});
  await seat.deskBind({agentId:'task-created-worker',workspaceId:null,provider:seatPin.provider,cwd:f.repository,
    reason:'create',purpose:'interactive',env:{SLP_DESK_HANDLE:handle}});
  await seat.deskRegister({agent:{id:'task-created-worker',workspaceId:null,parentAgentId:f.lead.agentId,provider:seatPin.provider,cwd:f.repository,title:null}});
  const afterCreate=await f.effect({operation:'observe',requestId:'create-claim-observe',attemptId:reserved.attemptId,actionId:createIntent.actionId,
    actionKind:'create',receipt:{status:'observed',agentId:'task-created-worker'}});
  assert.equal(afterCreate.ok,true,JSON.stringify(afterCreate));
  const bound=await f.effect({operation:'bind',requestId:'bind-task-claim',attemptId:reserved.attemptId,
    member:{agentId:'task-created-worker',membershipId:claimed.membershipId},
    observed:{provider:seatPin.provider,createCwd:f.repository,workspaceId:null}});
  assert.equal(bound.ok,true,JSON.stringify(bound));
  ledger=f.ledger();claimed=ledger.memberships.find(row=>row.membershipId===claimed.membershipId);
  assert.ok(claimed?.capacityClaim,'bind/register retain the exact event-time capacity claim');
  const attempt=ledger.taskEntries.filter(row=>row.kind==='attempt'&&row.attemptId===reserved.attemptId).at(-1);
  assert.equal(attempt.state,'bound');assert.ok(attempt.boundScopeId);
  assert.equal(ledger.scopeTransitions.filter(row=>row.scopeId===attempt.boundScopeId).at(-1).to,'claimed');
  assert.equal(f.store.read(f.repoKey).state,'ok',JSON.stringify(f.store.read(f.repoKey)));
});

test('worker result/question authority, exact stale tuple rejection and original request replay',async t=>{
  const f=await coreFixture(t);await f.define('A');const attempt=await f.start('A');
  const first=await f.result('A',attempt,'first');const second=await f.result('A',attempt,'second');
  const replay=await f.result('A',attempt,'first');assert.equal(replay.resultId,first.resultId);assert.notEqual(first.resultId,second.resultId);
  const stale={...f.worker,membershipId:f.successor.membershipId};
  const denied=await runTaskCommand({repoKey:f.repoKey,row:stale},{operation:'hold',assignmentId:f.assignmentId,requestId:'bad-worker',taskId:'A',attemptId:attempt,holdId:null,...f.pins(),hold:{holdKind:'question',question:'Need a decision',proposition:null,claimRefs:[],resourceIds:[]},ruling:null},f.deps);
  assert.equal(denied.ok,false);assert.equal(denied.code,'AUTHORITY_REQUIRED');
  const hold=await runTaskCommand({repoKey:f.repoKey,row:f.worker},{operation:'hold',assignmentId:f.assignmentId,requestId:'question',taskId:'A',attemptId:attempt,holdId:null,...f.pins(),hold:{holdKind:'question',question:'Need a decision',proposition:null,claimRefs:[],resourceIds:[]},ruling:null},f.deps);
  assert.equal(hold.ok,true,JSON.stringify(hold));
  const release=await f.command({operation:'hold',requestId:'release',taskId:'A',attemptId:attempt,holdId:hold.holdId,...f.pins(),hold:null,ruling:{reason:'Proceed',outcome:'release'}});assert.equal(release.ok,true,JSON.stringify(release));
});

import { currentTaskReadiness,currentTaskResultQualification,taskQueueCounts,taskWorkflowItems,decideDeskTask } from '../plugin/server/desk-task.ts';
import { canonicalJson,canonicalSha256,sha256Hex } from '../plugin/server/config-view.ts';
import { runAssignmentOffer,runAssignmentAccept } from '../plugin/server/desk-ownership.ts';
import { LEDGER_LIMITS } from '../plugin/server/desk-store.ts';
import { WIRE_LIMITS,DeskTaskEntry,DeskTaskRecapResult,DeskTaskIntegrationCleanupBundle } from '../plugin/shared/enforcement.ts';
import { readFileSync,readdirSync } from 'node:fs';

test('DAG diamond, measured consumer artifacts, reopen holds running descendants and keeps old consumed pins',async t=>{
  const f=await coreFixture(t);await f.define('A');const attempt=await f.start('A');const result=await f.result('A',attempt);await f.rule('A',result.resultId);
  const dep={taskId:'A',availability:'artifact',artifactKey:'out.txt',targetPath:'out.txt',target:null};
  await f.define('B',[dep]);await f.define('C',[dep]);await f.define('D',[{...dep,taskId:'B'},{...dep,taskId:'C'}]);
  let l=f.ledger(),asg=l.assignments[0];
  assert.equal(currentTaskReadiness(l,asg,l.taskEntries.find(r=>r.taskId==='B'&&r.kind==='task')).eligible,true);
  assert.equal(currentTaskReadiness(l,asg,l.taskEntries.find(r=>r.taskId==='D'&&r.kind==='task')).eligible,false);
  const unavailable=await f.reserve('B');assert.equal(unavailable.code,'CAPABILITY_GAP');
  let calls=0;
  f.deps.observe={observeDependencies:async req=>{calls++;return {consumerBase:{root:f.repository,snapshotSha256:'b'.repeat(64),head:null,kind:'git-snapshot',measuredAt:'2026-01-01T00:00:00.000Z',incomplete:[],artifactSha256:null},reference:null,results:req.pins.map(pin=>({taskId:pin.taskId,resultEntrySha256:pin.resultEntrySha256,adjudicationEntrySha256:pin.adjudicationEntrySha256,available:true,sha256:'d'.repeat(64),actualTargetPin:null,evidence:[{kind:'bytes',ref:'out.txt'}]}))};}};
  const wrong=await f.reserve('B',{requestId:'wrong-bytes'});assert.equal(wrong.code,'CANDIDATE_DRIFT');
  const observe=f.deps.observe.observeDependencies;f.deps.observe.observeDependencies=async req=>{const r=await observe(req);r.results[0].sha256='c'.repeat(64);return r;};
  const ready=await f.reserve('B',{requestId:'measured-reserve'});assert.equal(ready.ok,true,JSON.stringify(ready));
  const pinned=f.ledger().taskEntries.filter(r=>r.kind==='attempt'&&r.taskId==='B').at(-1).consumedDependencies;
  const replay=await f.reserve('B',{requestId:'measured-reserve',expectedLedgerRevision:ready.ledgerRevision-1});assert.equal(replay.ok,true,JSON.stringify(replay));
  const opened=await f.command({operation:'reopen',requestId:'reopen-A',taskId:'A',expectedTaskRevision:1,reason:'new prerequisite requirement'});assert.equal(opened.ok,true,JSON.stringify(opened));
  l=f.ledger();asg=l.assignments[0];
  assert.equal(currentTaskResultQualification(l,f.assignmentId,'A').qualified,false);
  assert.equal(currentTaskReadiness(l,asg,l.taskEntries.find(r=>r.taskId==='B'&&r.kind==='task')).bucket,'held');
  assert.deepEqual(l.taskEntries.filter(r=>r.kind==='attempt'&&r.taskId==='B').at(-1).consumedDependencies,pinned);
  const cycle=await f.command({operation:'amend',requestId:'cycle',taskId:'A',expectedTaskRevision:2,task:{dependencies:[{...dep,taskId:'D'}]}});assert.equal(cycle.code,'SCOPE_CONFLICT');
});

test('stop and never-issued cancellation keep history, replay is exact and cannot authorize effects',async t=>{
  const f=await coreFixture(t);await f.define('A');const reserved=await f.reserve('A');assert.equal(reserved.ok,true,JSON.stringify(reserved));
  const stop=await f.command({operation:'stop',requestId:'stop',taskId:'A',attemptId:reserved.attemptId,...f.pins(),reason:'cancel before any placement'});assert.equal(stop.ok,true,JSON.stringify(stop));
  const issue=await f.effect({operation:'issue',requestId:'late-issue',attemptId:reserved.attemptId,actionId:reserved.next.actionId});assert.equal(issue.perform,false,JSON.stringify(issue));
  const attempt=f.ledger().taskEntries.filter(r=>r.kind==='attempt').at(-1);
  const input={operation:'reconcile',requestId:'settle-never-issued',attemptIds:[attempt.attemptId],actionIds:[],resourceIds:[],observationTypes:[],attemptRulings:[{attemptId:attempt.attemptId,expectedAttemptRevision:attempt.revision,disposition:'stopped',reason:'no effect ever issued',evidence:['ledger:never-issued']}]};
  const end=await f.command(input);assert.equal(end.ok,true,JSON.stringify(end));
  assert.equal(f.ledger().taskEntries.filter(r=>r.kind==='attempt').at(-1).state,'stopped');
  const replay=await f.command(input);assert.equal(replay.ok,true,JSON.stringify(replay));assert.equal(replay.replayed,true);assert.equal(replay.ledgerRevision,end.ledgerRevision);
});

test('archive, membership revoke and a single absence never discharge worker obligations',async t=>{
  const f=await coreFixture(t);await f.define('A');const attemptId=await f.start('A');
  const resources=f.ledger().taskEntries.filter(r=>r.kind==='resource');
  f.deps.observe={observeResources:async req=>({results:req.resources.map(row=>({resourceId:row.resourceId,kind:row.kind,archived:true,revoked:true,exists:false}))})};
  const read=await f.command({operation:'reconcile',requestId:'absence',attemptIds:[attemptId],actionIds:[],resourceIds:resources.map(r=>r.resourceId),observationTypes:['resources']});assert.equal(read.ok,true,JSON.stringify(read));
  assert.ok(f.ledger().taskEntries.filter(r=>r.kind==='resource').every(r=>r.disposition==='retained'));
  const denied=await f.command({operation:'reconcile',requestId:'force-release',attemptIds:[attemptId],actionIds:[],resourceIds:resources.map(r=>r.resourceId),observationTypes:['resources'],releaseRulings:resources.map(r=>({resourceId:r.resourceId,expectedResourceRevision:r.revision,reason:'stop',evidence:['human:claim']}))});assert.equal(denied.code,'EVIDENCE_INCOMPLETE');
});

test('early bound cancellation uses internal task-cancel while public close remains denied',async t=>{
  const f=await coreFixture(t);
  const scope={label:'writer',refs:[],ownership:{writerAgentId:'future',writerAuthorityRef:null,paths:['src/A'],resources:[],stateOwners:[],dependsOnScopeIds:[],notifications:[]},reviewPlan:{kind:'not-required',authorityRef:'human:fixture',ruleRef:'protocol',reason:'fixture proof',lenses:[],exemptionClass:null}};
  const declared=await f.command({operation:'define',requestId:'define-scoped',taskId:'A',...f.pins(0),task:{...f.body,scope}});assert.equal(declared.ok,true,JSON.stringify(declared));
  const r=await f.reserve('A');assert.equal(r.ok,true,JSON.stringify(r));
  const issue=await f.effect({operation:'issue',requestId:'place',attemptId:r.attemptId,actionId:r.next.actionId});assert.equal(issue.perform,true);
  const o=await f.effect({operation:'observe',requestId:'placed',attemptId:r.attemptId,actionId:r.next.actionId,actionKind:'place',receipt:{status:'observed',cwd:f.repository}});assert.equal(o.ok,true,JSON.stringify(o));
  const bind=await f.effect({operation:'bind',requestId:'bind',attemptId:r.attemptId,member:{agentId:f.worker.agentId,membershipId:f.worker.membershipId},observed:{provider:f.worker.provider,createCwd:f.repository,workspaceId:null}});assert.equal(bind.ok,true,JSON.stringify(bind));
  const a=f.ledger().taskEntries.filter(row=>row.kind==='attempt').at(-1);
  const close=await runScopeTransition(f.ctx,{requestId:'public-close',assignmentId:f.assignmentId,scopeId:a.boundScopeId,scopeRevision:1,transition:'close',candidateSnapshot:null,candidateHead:null,briefRevision:0},f.deps);assert.equal(close.ok,false);
  const steered=await runAssignmentAmend(f.ctx,{requestId:'brief-before-cancel',assignmentId:f.assignmentId,expectedBriefRevision:0,brief:{objective:'steer then cancel old scope',acceptanceCriteria:['retain obligations'],constraints:[],provisionalDesign:'preserve existing writer scope',assumptions:[],unknowns:[],requiredEvidence:[],ownedSurfaces:[],excludedSurfaces:[],dependencies:[],notifications:[]},changeReason:'new current brief',authorityRef:'human:steering',affectedOwners:[]},f.deps);assert.equal(steered.ok,true,JSON.stringify(steered));
  const resources=f.ledger().taskEntries.filter(row=>row.kind==='resource');
  f.deps.observe={observeResources:async req=>({results:req.resources.map(row=>({resourceId:row.resourceId,kind:row.kind,positive:true,quiescent:true,evidence:[{kind:'fixture-positive-quiescence',ref:`fixture:${row.resourceId}`}]}))})};
  const ended=await f.command({operation:'reconcile',requestId:'cancel-bound',attemptIds:[a.attemptId],actionIds:[],resourceIds:resources.map(row=>row.resourceId),observationTypes:['resources'],releaseRulings:resources.map(row=>({resourceId:row.resourceId,expectedResourceRevision:row.revision,reason:'fixture observer proves no work',evidence:['owner:cancel']})),attemptRulings:[{attemptId:a.attemptId,expectedAttemptRevision:a.revision,disposition:'stopped',reason:'cancel without any writable prompt',evidence:['ledger:no-send-or-create']} ]});
  assert.equal(ended.ok,true,JSON.stringify(ended));
  const l=f.ledger();assert.equal(l.scopeTransitions.at(-1).command,'task-cancel');assert.equal(l.scopeTransitions.at(-1).to,'closed');
  assert.equal(currentTaskResultQualification(l,f.assignmentId,'A').qualified,false);
});

import { runScopeTransition,currentScopeReviewQualification } from '../plugin/server/desk-scope.ts';

test('lost action observation remains uncertainty with valid null nonintegration phase and replay does not reobserve',async t=>{
  const f=await coreFixture(t);await f.define('A');const r=await f.reserve('A');
  const issue=await f.effect({operation:'issue',requestId:'issued',actionId:r.next.actionId,attemptId:r.attemptId});assert.equal(issue.perform,true);
  const uncertain=await f.effect({operation:'observe',requestId:'uncertain',actionId:r.next.actionId,attemptId:r.attemptId,actionKind:'place',receipt:{status:'uncertain'}});assert.equal(uncertain.ok,true);
  let calls=0;f.deps.observe={observeAction:async()=>{calls++;return {resolved:false,reason:'no-positive-identity'};}};
  const input={operation:'reconcile',requestId:'reconcile',attemptIds:[r.attemptId],actionIds:[],resourceIds:[],observationTypes:['action']};
  const reconciled=await f.command(input);assert.equal(reconciled.ok,true,JSON.stringify(reconciled));
  const replay=await f.command(input);assert.equal(replay.ok,true);assert.equal(calls,1);
  const action=f.ledger().taskEntries.filter(row=>row.kind==='action').at(-1);assert.equal(action.state,'uncertain');assert.equal(action.phase,null);
});

import { deskRepoPaths } from '../plugin/server/desk-store.ts';
import { projectDeskWorkflow } from '../plugin/server/desk-assignment.ts';
import { buildTaskRecap } from '../plugin/server/runtime/handoff-recap.ts';

test('null-task assignment obligations use real store and full-ledger counters/recap with foreign/dangling negatives',async t=>{
  const f=await coreFixture(t);
  const stamp=(id,kind,fields)=>{
    const row={entryId:id,entityId:id,kind,assignmentId:f.assignmentId,taskId:null,revision:1,priorEntryId:null,priorEntrySha256:null,requestId:`seed-${id}`,actorAgentId:f.lead.agentId,actorMembershipId:f.lead.membershipId,ownershipRevision:0,briefRevision:0,...fields};return {...row,entrySha256:canonicalSha256(row)};
  };
  const delivery=stamp('dlv-null','delivery',{deliveryId:'dlv-null',deliveryKind:'brief',senderAgentId:f.lead.agentId,senderMembershipId:f.lead.membershipId,recipientAgentId:f.worker.agentId,recipientMembershipId:f.worker.membershipId,bodySha256:null,bodyRef:null,actionId:null,attemptId:null,resultId:null,state:'pending',ackEvidence:[],handlingEvidence:null,reason:null});
  const resource=stamp('rsc-null','resource',{resourceId:'rsc-null',resourceKind:'artifact',resourceKey:'out',ownerAgentId:f.lead.agentId,ownerMembershipId:f.lead.membershipId,attemptId:null,actionId:null,disposition:'retained',observedState:null,observedVia:null,obligations:[],releaseRuling:null});
  const control=stamp('ctl-null','control',{controlId:'ctl-null',targetTaskId:null,targetAttemptId:null,state:'stop-requested',reason:'global hold',outstandingActionIds:[],outstandingResourceIds:[]});
  const append=async row=>f.store.transact(f.repoKey,{repo:f.repo,actorKey:`agent:${f.lead.agentId}`,assignmentId:f.assignmentId,requestId:row.requestId,command:{kind:'fixture-null-row',row:row.entryId}},l=>({ok:true,events:[{kind:'task-entry-appended',payload:{entryId:row.entryId,entityId:row.entityId,entryKind:row.kind,revision:row.revision,entrySha256:row.entrySha256,taskId:row.taskId,actorMembershipId:row.actorMembershipId,briefRevision:row.briefRevision,ownershipRevision:row.ownershipRevision}}],taskEntries:[...l.taskEntries,row]}));
  for(const row of [delivery,resource,control])assert.equal((await append(row)).ok,true);
  const counts=taskQueueCounts(f.ledger(),f.ledger().assignments[0]);assert.equal(counts.pendingAcks,1);assert.equal(counts.resources,1);assert.equal(counts.controls,1);assert.equal(counts.ready,0);
  const view=projectDeskWorkflow(f.ledger(),f.assignmentId,{section:'tasks',expectedLedgerRevision:f.ledger().revision,expectedBriefRevision:null,cursor:null,limit:50});
  assert.equal(view.ok,true,JSON.stringify(view));const recap=buildTaskRecap(view);assert.equal(DeskTaskRecapResult.safeParse(recap).success,true);assert.deepEqual(recap.counts,counts);assert.deepEqual(recap.unresolved.resources,['rsc-null']);
  const oldRevision=f.ledger().revision;
  const dangling={...resource,entryId:'rsc-bad',entityId:'rsc-bad',resourceId:'rsc-bad',requestId:'seed-bad',actionId:'missing'};delete dangling.entrySha256;dangling.entrySha256=canonicalSha256(dangling);
  await assert.rejects(()=>append(dangling),/refusing to commit/);assert.equal(f.ledger().revision,oldRevision);
});

test('v8 rejected command does not migrate; first successful task commit records v9 migration',async t=>{
  const f=await coreFixture(t);const file=deskRepoPaths(join(f.dir,'home','slp-runtime'),f.repoKey).ledgerPath;
  const prior=JSON.parse(readFileSync(file,'utf8'));delete prior.taskEntries;prior.schemaVersion=8;writeFileSync(file,JSON.stringify(prior)+'\n',{mode:0o600});
  const reject=await f.command({operation:'reopen',requestId:'legacy-rejection',taskId:'unknown',expectedTaskRevision:1,reason:'no task'});assert.equal(reject.ok,false);
  const disk=JSON.parse(readFileSync(file,'utf8'));assert.equal(disk.schemaVersion,8);assert.equal('taskEntries' in disk,false);
  await f.define('A');assert.equal(JSON.parse(readFileSync(file,'utf8')).schemaVersion,9);
  const events=readdirSync(deskRepoPaths(join(f.dir,'home','slp-runtime'),f.repoKey).eventsDir).flatMap(name=>readFileSync(join(deskRepoPaths(join(f.dir,'home','slp-runtime'),f.repoKey).eventsDir,name),'utf8').trim().split('\n').map(JSON.parse));assert.ok(events.some(row=>row.kind==='schema-migrated'&&row.payload.from===8&&row.payload.to===9));
});

test('all commit paths preserve request recovery headroom, valid stop still commits at saturated ordinary boundary',async t=>{
  const f=await coreFixture(t);await f.define('A');const reserved=await f.reserve('A');assert.equal(reserved.ok,true,JSON.stringify(reserved));
  const beforeStop=resolveDeskTaskCapacityReserve({taskEntries:f.ledger().taskEntries,memberships:f.ledger().memberships,assignments:f.ledger().assignments,
    scopes:f.ledger().scopes,scopeTransitions:f.ledger().scopeTransitions},{eventPayloadBytes:16_384});
  assert.equal(beforeStop.requests-WIRE_LIMITS.deskTaskRecoveryRequests,7,'stop+terminal+place issue/observe+bind+two releases');
  // Intended place retains one issue row plus its coupled action/attempt receipt.
  assert.equal(beforeStop.taskEntries-WIRE_LIMITS.deskTaskRecoveryEntries,12,'attempt/control/action/resource rows cover the same supported path');
  const file=deskRepoPaths(join(f.dir,'home','slp-runtime'),f.repoKey).ledgerPath;
  const disk=JSON.parse(readFileSync(file,'utf8'));
  // This pre-stop state also funds the next bind and the two resources its
  // atomic bind creates, then later releases; after stop, bind credit is no
  // longer reachable and only terminal plus place-observation remain.
  const target=LEDGER_LIMITS.requests-WIRE_LIMITS.deskTaskRecoveryRequests-4;
  while(disk.requests.length<target){const n=disk.requests.length+1;disk.requests.push({actorKey:'fixture:legacy',assignmentId:'fixture',requestId:`r-${n}`,bodySha256:'a'.repeat(64),canonicalization:'slp-canonical-json/1',receiptId:`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,revision:n,outcome:'rejected',eventSeqs:null,rejection:{ok:false,code:'INVALID_RECORD',message:'fixture saturation',recovery:'fixture'}});}
  disk.revision=target;writeFileSync(file,JSON.stringify(disk)+'\n',{mode:0o600});assert.equal(f.store.read(f.repoKey).state,'ok');
  const before=readFileSync(file);
  const legacy=await f.store.transact(f.repoKey,{repo:f.repo,actorKey:'fixture:legacy',assignmentId:'fixture',requestId:'overflow',command:{kind:'legacy'}},()=>({ok:false,code:'INVALID_RECORD',message:'legacy rejects',recovery:'fixture'}));assert.equal(legacy.ok,false);assert.match(legacy.message,/recovery capacity/);assert.deepEqual(readFileSync(file),before);
  const stop=await f.command({operation:'stop',requestId:'capacity-stop',taskId:'A',attemptId:reserved.attemptId,...f.pins(),reason:'recover at saturation'});assert.equal(stop.ok,true,JSON.stringify(stop));assert.equal(f.ledger().taskEntries.filter(r=>r.kind==='attempt').at(-1).state,'stop-requested');
  const afterStop=resolveDeskTaskCapacityReserve({taskEntries:f.ledger().taskEntries,memberships:f.ledger().memberships,assignments:f.ledger().assignments,
    scopes:f.ledger().scopes,scopeTransitions:f.ledger().scopeTransitions},{eventPayloadBytes:16_384});
  assert.equal(afterStop.requests-WIRE_LIMITS.deskTaskRecoveryRequests,3,'post-stop reserve keeps terminal and outstanding place observation');
  assert.equal(afterStop.taskEntries-WIRE_LIMITS.deskTaskRecoveryEntries,5,'post-stop reserve keeps terminal attempt/control and place outcome');
});

test('repeated non-progress stop receipts cannot consume the reserved terminal settlement headroom',async t=>{
  const f=await coreFixture(t);await f.define('A');const reserved=await f.reserve('A');assert.equal(reserved.ok,true,JSON.stringify(reserved));
  const file=deskRepoPaths(join(f.dir,'home','slp-runtime'),f.repoKey).ledgerPath;
  const disk=JSON.parse(readFileSync(file,'utf8'));
  const boundary=LEDGER_LIMITS.requests-WIRE_LIMITS.deskTaskRecoveryRequests-4;
  while(disk.requests.length<boundary){const n=disk.requests.length+1;disk.requests.push({actorKey:'fixture:legacy',assignmentId:'fixture',requestId:`preexisting-${n}`,bodySha256:'a'.repeat(64),canonicalization:'slp-canonical-json/1',receiptId:`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`,revision:n,outcome:'rejected',eventSeqs:null,rejection:{ok:false,code:'INVALID_RECORD',message:'fixture saturation',recovery:'fixture'}});}
  disk.revision=boundary;writeFileSync(file,JSON.stringify(disk)+'\n',{mode:0o600});assert.equal(f.store.read(f.repoKey).state,'ok');

  const first=await f.command({operation:'stop',requestId:'capacity-first-stop',taskId:'A',attemptId:reserved.attemptId,...f.pins(),reason:'cancel before any worker authority'});
  assert.equal(first.ok,true,JSON.stringify(first));
  const afterFirst=f.ledger().requests.length;
  for(let n=0;n<24;n++){
    const repeated=await f.command({operation:'stop',requestId:`capacity-repeat-stop-${n}`,taskId:'A',attemptId:reserved.attemptId,...f.pins(),reason:'same unresolved stop'});
    assert.equal(repeated.ok,false,`non-progress stop ${n} must not spend another recovery credit`);
  }
  assert.equal(f.ledger().requests.length,afterFirst,'rejected non-progress requests are not allowed to consume reserved receipt slots');
  const current=f.ledger().taskEntries.filter(row=>row.kind==='attempt'&&row.attemptId===reserved.attemptId).at(-1);
  const settled=await f.command({operation:'reconcile',requestId:'capacity-terminal-settlement',attemptIds:[reserved.attemptId],actionIds:[],resourceIds:[],observationTypes:[],
    attemptRulings:[{attemptId:reserved.attemptId,expectedAttemptRevision:current.revision,disposition:'stopped',reason:'never-authorized placement work',evidence:['ledger:no-send-or-create']} ]});
  assert.equal(settled.ok,true,JSON.stringify(settled));
  assert.equal(f.ledger().taskEntries.filter(row=>row.kind==='attempt'&&row.attemptId===reserved.attemptId).at(-1).state,'stopped');
});

test('a retained question can be released by the current owner without rewriting hold history',async t=>{
  const f=await coreFixture(t);await f.define('A');const attemptId=await f.start('A');
  const raised=await runTaskCommand({repoKey:f.repoKey,row:f.worker},{operation:'hold',assignmentId:f.assignmentId,requestId:'hold-raised',taskId:'A',attemptId,holdId:null,...f.pins(),
    hold:{holdKind:'question',question:'Wait for the missing result map',proposition:null,claimRefs:[],resourceIds:[]},ruling:null},f.deps);
  assert.equal(raised.ok,true,JSON.stringify(raised));
  const retained=await f.command({operation:'hold',requestId:'hold-retained',taskId:'A',attemptId,holdId:raised.holdId,...f.pins(),hold:null,ruling:{outcome:'retain',reason:'Keep blocked pending evidence'}});
  assert.equal(retained.ok,true,JSON.stringify(retained));
  let assignment=f.ledger().assignments.find(row=>row.assignmentId===f.assignmentId);
  assert.equal(taskQueueCounts(f.ledger(),assignment).openHolds,1);
  assert.equal(currentTaskReadiness(f.ledger(),assignment,f.ledger().taskEntries.find(row=>row.kind==='task'&&row.taskId==='A')).bucket,'held');
  const retainedHistory=f.ledger().taskEntries.filter(row=>row.kind==='hold'&&row.holdId===raised.holdId);
  const stale=await f.command({operation:'hold',requestId:'hold-stale-release',taskId:'A',attemptId,holdId:raised.holdId,
    expectedLedgerRevision:retained.ledgerRevision-1,expectedBriefRevision:0,expectedOwnershipRevision:0,expectedTaskRevision:1,
    hold:null,ruling:{outcome:'release',reason:'stale snapshot'}});
  assert.equal(stale.ok,false,'the prior ledger pin cannot release a newly retained hold');
  assert.equal(f.ledger().taskEntries.filter(row=>row.kind==='hold'&&row.holdId===raised.holdId).length,2);

  const released=await f.command({operation:'hold',requestId:'hold-released',taskId:'A',attemptId,holdId:raised.holdId,...f.pins(),hold:null,
    ruling:{outcome:'release',reason:'The missing evidence is now present'}});
  assert.equal(released.ok,true,JSON.stringify(released));
  assignment=f.ledger().assignments.find(row=>row.assignmentId===f.assignmentId);
  const history=f.ledger().taskEntries.filter(row=>row.kind==='hold'&&row.holdId===raised.holdId);
  assert.equal(history.length,3);
  assert.equal(history[0].ruling,null);
  assert.equal(history[1].ruling.outcome,'retain');
  assert.equal(history[2].ruling.outcome,'release');
  assert.equal(history[0].question,history[1].question);
  assert.equal(history[1].question,history[2].question);
  assert.equal(retainedHistory[1].ruling.outcome,'retain','the earlier immutable row remains unchanged');
  assert.equal(taskQueueCounts(f.ledger(),assignment).openHolds,0);
  assert.equal(currentTaskReadiness(f.ledger(),assignment,f.ledger().taskEntries.find(row=>row.kind==='task'&&row.taskId==='A')).bucket,'running');
  const reopen=await f.command({operation:'hold',requestId:'hold-cannot-reopen',taskId:'A',attemptId,holdId:raised.holdId,...f.pins(),hold:null,
    ruling:{outcome:'retain',reason:'terminal release cannot reopen'}});
  assert.equal(reopen.ok,false);
  assert.equal(f.ledger().taskEntries.filter(row=>row.kind==='hold'&&row.holdId===raised.holdId).length,3);
});

test('a live former owner replays its exact reconcile receipt after succession without observing or regaining authority',async t=>{
  const f=await coreFixture(t);await f.define('A');const attemptId=await f.start('A');
  const resource=f.ledger().taskEntries.find(row=>row.kind==='resource');assert.ok(resource,'the real bound attempt must retain a resource obligation');
  const registerSeat=async(label,agentId,provider,role)=>{
    const membershipId=crypto.randomUUID(),bindingHandleSha256=canonicalSha256(`auth3:${label}:${membershipId}`);
    const seat=async(suffix,command)=>f.store.transact(f.repoKey,{repo:f.repo,actorKey:'desk:hook',assignmentId:'unassigned',requestId:`auth3-${label}-${suffix}`,command},decideSeatCommand);
    const minted=await seat('mint',{kind:'seat.mint',at:new Date().toISOString(),membershipId,bindingHandleSha256,provider,family:f.lead.family,role,createCwd:f.repository});assert.equal(minted.ok,true,JSON.stringify(minted));
    const bound=await seat('bind',{kind:'seat.bind',at:new Date().toISOString(),bindingHandleSha256,agentId,workspaceId:null,provider,cwd:f.repository});assert.equal(bound.ok,true,JSON.stringify(bound));
    const registered=await seat('register',{kind:'seat.register',at:new Date().toISOString(),agentId,workspaceId:null,provider,cwd:f.repository});assert.equal(registered.ok,true,JSON.stringify(registered));
    return f.ledger().memberships.find(row=>row.membershipId===membershipId);
  };
  let resourceObservations=0;
  f.deps.observe={observeResources:async()=>{resourceObservations++;return {results:[]};}};
  const original={operation:'reconcile',requestId:'reconcile-before-succession',assignmentId:f.assignmentId,taskId:'A',
    expectedLedgerRevision:f.ledger().revision,attemptIds:[attemptId],actionIds:[],resourceIds:[resource.resourceId],observationTypes:['resources']};
  const first=await f.command(original);assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.replayed,false);assert.equal(resourceObservations,1);
  const offer=await runAssignmentOffer(f.ctx,{requestId:'replay-offer',assignmentId:f.assignmentId,expectedOwnershipRevision:0,
    targetAgentId:f.successor.agentId,targetMembershipId:f.successor.membershipId,authorityRef:'human:succession',contextRef:'fixture:replay'},f.deps);
  assert.equal(offer.ok,true,JSON.stringify(offer));
  const accepted=await runAssignmentAccept({repoKey:f.repoKey,row:f.successor},{requestId:'replay-accept',assignmentId:f.assignmentId,offerId:offer.offerId,
    expectedOwnershipRevision:0,expectedLedgerRevision:f.ledger().revision,expectedBriefRevision:0,acknowledgment:'take retained obligations',settlementRef:null,resources:[]},f.deps);
  assert.equal(accepted.ok,true,JSON.stringify(accepted));
  const afterAccept=f.ledger().revision;

  const replay=await runTaskCommand({repoKey:f.repoKey,row:f.lead},original,f.deps);
  assert.equal(replay.ok,true,JSON.stringify(replay));assert.equal(replay.replayed,true);assert.equal(replay.receiptId,first.receiptId);
  assert.equal(replay.ledgerRevision,first.ledgerRevision);assert.equal(resourceObservations,1);assert.equal(f.ledger().revision,afterAccept);

  const changed=await runTaskCommand({repoKey:f.repoKey,row:f.lead},{...original,expectedLedgerRevision:afterAccept},f.deps);
  assert.equal(changed.ok,false);assert.equal(changed.code,'IDEMPOTENCY_CONFLICT');assert.equal(resourceObservations,1);assert.equal(f.ledger().revision,afterAccept);
  const fresh=await runTaskCommand({repoKey:f.repoKey,row:f.lead},{...original,requestId:'former-owner-new-reconcile',expectedLedgerRevision:afterAccept},f.deps);
  assert.equal(fresh.ok,false);assert.equal(fresh.code,'ACTOR_MISMATCH');assert.equal(resourceObservations,1);assert.equal(f.ledger().revision,afterAccept);

  const outsider=await registerSeat('outsider','outsider','slp-codex-peer','peer');assert.ok(outsider);
  const beforeForeignReplay=f.ledger().revision;
  const foreign=await runTaskCommand({repoKey:f.repoKey,row:outsider},original,f.deps);
  assert.equal(foreign.ok,false);assert.equal(resourceObservations,1);assert.equal(f.ledger().revision,beforeForeignReplay);

  const revoked=await f.store.transact(f.repoKey,{repo:f.repo,actorKey:'desk:hook',assignmentId:'unassigned',requestId:'revoke-former-owner',
    command:{kind:'seat.revoke',at:new Date().toISOString(),agentId:f.lead.agentId,reason:'archived'}},decideSeatCommand);
  assert.equal(revoked.ok,true,JSON.stringify(revoked));
  const afterRevoke=f.ledger().revision;
  const revokedReplay=await runTaskCommand({repoKey:f.repoKey,row:f.lead},original,f.deps);
  assert.equal(revokedReplay.ok,false);assert.equal(resourceObservations,1);assert.equal(f.ledger().revision,afterRevoke);
  const rebound=await registerSeat('rebound-owner',f.lead.agentId,f.lead.provider,'lead');assert.ok(rebound);
  const beforeReboundReplay=f.ledger().revision;
  const reboundReplay=await runTaskCommand({repoKey:f.repoKey,row:rebound},original,f.deps);
  assert.equal(reboundReplay.ok,false);assert.equal(resourceObservations,1);assert.equal(f.ledger().revision,beforeReboundReplay);
});

test('LAND cleanup persists one immutable account, authorizes one resource cycle at a time, and retains the target fence',async t=>{
  const f=await coreFixture(t);await f.define('A');const attemptId=await f.start('A');
  const result=await f.result('A',attemptId);await f.rule('A',result.resultId);
  const resultRow=f.ledger().taskEntries.filter(row=>row.kind==='result'&&row.resultId===result.resultId).at(-1);
  const attempt=f.ledger().taskEntries.filter(row=>row.kind==='attempt'&&row.attemptId===attemptId).at(-1);
  assert.ok(attempt.sourceBase);
  const measuredAt='2026-01-01T00:00:00.000Z';
  const sourceBaseBytes=Buffer.from(canonicalJson({kind:'historical-base',snapshot:attempt.sourceBase.snapshotSha256}));
  const sourceResultBytes=Buffer.from(canonicalJson({kind:'retained-result',snapshot:resultRow.snapshotSha256}));
  const sourceBase={...attempt.sourceBase,artifactSha256:sha256Hex(sourceBaseBytes)};
  const sourceResult={...attempt.sourceBase,snapshotSha256:resultRow.snapshotSha256,artifactSha256:sha256Hex(sourceResultBytes)};
  const target={...attempt.sourceBase,snapshotSha256:'d'.repeat(64),root:f.repository,artifactSha256:null};
  const admitted=await f.effect({operation:'integration-admit',requestId:'integrate-admit-A',assignmentId:f.assignmentId,taskId:'A',resultId:result.resultId,
    expectedLedgerRevision:f.ledger().revision,expectedResultRevision:1,expectedAdjudicationRevision:1,
    grant:{authorityRef:'grant:integrate',paths:['out.txt'],target:{cwd:f.repository}},verification:{recipeIds:[]},
    body:{sourceBase,sourceResult,target,sourceCwd:f.repository,targetCwd:f.repository,stageKind:'content-dir',
      sourceBaseSha:sourceBase.snapshotSha256,sourceResultSha:resultRow.snapshotSha256,targetBaseSha:target.snapshotSha256,
      stagedSha:'e'.repeat(64),expectedStageSha:'e'.repeat(64),expectedSha:'f'.repeat(64),changedPaths:['out.txt'],deltaDigest:'c'.repeat(64)}});
  assert.equal(admitted.ok,true,JSON.stringify(admitted));
  const actionId=admitted.actionId,stageDir=join(f.dir,'integrations',actionId,'stage'),actionRoot=join(f.dir,'integrations',actionId);
  const sourceBasePath=join(actionRoot,'source-base.measure.json'),sourceResultPath=join(actionRoot,'source-result.measure.json');
  mkdirSync(actionRoot,{recursive:true,mode:0o700});writeFileSync(sourceBasePath,sourceBaseBytes,{mode:0o600});writeFileSync(sourceResultPath,sourceResultBytes,{mode:0o600});
  const staged=await f.effect({operation:'observe',requestId:'integrate-stage-observe',actionId,actionKind:'integration',receipt:{status:'observed',phase:'stage',
    stageDir,stageKind:'content-dir',stagedSha:'e'.repeat(64),expectedStageSha:'e'.repeat(64),expectedSha:'f'.repeat(64),
    sourceBaseSha:sourceBase.snapshotSha256,sourceResultSha:resultRow.snapshotSha256,targetBaseSha:target.snapshotSha256,
    targetCwd:f.repository,sourceCwd:f.repository,changedPaths:['out.txt'],deltaDigest:'c'.repeat(64)}});
  assert.equal(staged.ok,true,JSON.stringify(staged));
  const recoveryPlan={version:1,stageDir,backupDir:join(actionRoot,'backup'),manifestPath:join(actionRoot,'backup.manifest.json'),
    targetOriginal:{path:join(actionRoot,'original.actual-fs.map.json'),artifactSha256:'1'.repeat(64),bytes:80,mapSha256:target.snapshotSha256,head:target.head},
    expectedCombined:{path:join(actionRoot,'expected-combined.actual-fs.map.json'),artifactSha256:'2'.repeat(64),bytes:90,mapSha256:'f'.repeat(64),head:target.head},
    backupManifest:{artifactSha256:'3'.repeat(64),bytes:120}};
  const pins=()=>({assignmentId:f.assignmentId,taskId:'A',resultId:result.resultId,expectedLedgerRevision:f.ledger().revision,
    expectedResultRevision:1,expectedAdjudicationRevision:1,expectedActionRevision:f.ledger().taskEntries.filter(row=>row.kind==='action'&&row.actionId===actionId).at(-1).revision});
  const assertLandRecoveryReserve=(requests,entries)=>{
    const ledger=f.ledger();
    const reserve=resolveDeskTaskCapacityReserve({taskEntries:ledger.taskEntries,memberships:ledger.memberships,assignments:ledger.assignments,
      scopes:ledger.scopes,scopeTransitions:ledger.scopeTransitions},{eventPayloadBytes:16_384});
    const globalRequests=WIRE_LIMITS.deskTaskRecoveryRequests,globalEntries=WIRE_LIMITS.deskTaskRecoveryEntries,globalBytes=WIRE_LIMITS.deskTaskRecoveryBytes;
    const fixedAttemptRequests=8,fixedAttemptEntries=10;
    assert.equal(reserve.requests-globalRequests-fixedAttemptRequests,requests,`exact future LAND/cleanup request graph; full reserve=${JSON.stringify({...reserve,assignmentSeats:[...reserve.assignmentSeats]})}; heads=${JSON.stringify(ledger.taskEntries.filter(row=>row.revision===1||row.kind==='action').map(row=>({kind:row.kind,id:row.entityId,revision:row.revision,state:row.state,phase:row.phase,actionKind:row.actionKind,step:row.body?.cleanupStep,attemptId:row.attemptId,member:row.member?.membershipId})))}`);
    assert.equal(reserve.taskEntries-globalEntries-fixedAttemptEntries,entries,`exact future LAND/cleanup task-entry graph; full reserve=${JSON.stringify({...reserve,assignmentSeats:[...reserve.assignmentSeats]})}`);
    assert.equal(reserve.bytes-globalBytes-fixedAttemptRequests*4_096-fixedAttemptEntries*(2*32_768+4_096),
      requests*4_096+entries*(2*32_768+4_096),'recovery byte credit is the independently pinned request/entry vector');
  };
  const landControlPins=pins();
  let priorRequests=f.ledger().requests.length,priorTaskEntries=f.ledger().taskEntries.length;
  const landIntent=await f.effect({operation:'intent',requestId:'integrate-land-intent',actionId,actionKind:'integration',body:{phase:'land',controlPins:landControlPins,recoveryPlan}});
  assert.equal(landIntent.ok,true,JSON.stringify(landIntent));
  assert.equal(f.ledger().requests.length-priorRequests,1,'LAND intent is one actual request');
  assert.equal(f.ledger().taskEntries.length-priorTaskEntries,2,'LAND intent appends its action revision and backup resource row');
  assertLandRecoveryReserve(21,23,'LAND intended state also funds its later issue');
  priorRequests=f.ledger().requests.length;priorTaskEntries=f.ledger().taskEntries.length;
  const landIssue=await f.effect({operation:'issue',requestId:'integrate-land-issue',actionId,actionKind:'integration'});
  assert.equal(landIssue.ok,true,JSON.stringify(landIssue));assert.equal(landIssue.perform,true);
  assert.equal(f.ledger().requests.length-priorRequests,1,'LAND issue is one actual request');
  assert.equal(f.ledger().taskEntries.length-priorTaskEntries,1,'LAND issue appends one immutable action revision');
  assertLandRecoveryReserve(20,22,'issued LAND retains normal observe, fresh reconcile and all cleanup credits');
  mkdirSync(stageDir,{recursive:true,mode:0o700});chmodSync(stageDir,0o700);
  mkdirSync(recoveryPlan.backupDir,{recursive:true,mode:0o700});chmodSync(recoveryPlan.backupDir,0o700);
  const finalPin={snapshotSha256:recoveryPlan.expectedCombined.mapSha256,head:recoveryPlan.expectedCombined.head,root:f.repository,
    kind:'git-snapshot',measuredAt,incomplete:[],artifactSha256:null};
  priorRequests=f.ledger().requests.length;priorTaskEntries=f.ledger().taskEntries.length;
  const landed=await f.effect({operation:'observe',requestId:'integrate-land-observe',actionId,actionKind:'integration',receipt:{status:'observed',phase:'land',
    recoveryPlan,controlPins:landControlPins,recoveryClassification:'full-applied',backupIntegrity:true,finalMatchesExpected:true,final:finalPin,target:finalPin}});
  assert.equal(landed.ok,true,JSON.stringify(landed));
  assert.equal(f.ledger().requests.length-priorRequests,1,'normal LAND observation is one actual request');
  assert.equal(f.ledger().taskEntries.length-priorTaskEntries,1,'normal LAND observation appends one immutable action revision');
  assertLandRecoveryReserve(19,21,'observed LAND still funds the fresh reconcile before cleanup');
  let currentAction=f.ledger().taskEntries.filter(row=>row.kind==='action'&&row.actionId===actionId).at(-1);
  assert.deepEqual(currentAction.target,target,'a fresh final measure cannot overwrite the immutable original target admission pin');
  assert.deepEqual(currentAction.landed,finalPin);
  const normalReconcilePins=pins();
  priorRequests=f.ledger().requests.length;priorTaskEntries=f.ledger().taskEntries.length;
  const normalReconcile=await f.effect({operation:'observe',requestId:'integrate-normal-land-reconcile',actionId,actionKind:'integration',receipt:{
    status:'observed',phase:'reconcile',controlPins:normalReconcilePins,recoveryPlan,recoveryClassification:'full-applied',backupIntegrity:true,
    finalMatchesExpected:true,target:finalPin,recoveredLand:finalPin}});
  assert.equal(normalReconcile.ok,true,JSON.stringify(normalReconcile));
  assert.equal(f.ledger().requests.length-priorRequests,1,'fresh LAND reconciliation is one actual request');
  assert.equal(f.ledger().taskEntries.length-priorTaskEntries,1,'fresh LAND reconciliation appends one immutable action revision');
  assertLandRecoveryReserve(18,20,'positive reconcile resolves LAND recovery before verification begins');
  currentAction=f.ledger().taskEntries.filter(row=>row.kind==='action'&&row.actionId===actionId).at(-1);
  assert.deepEqual(currentAction.target,target);assert.deepEqual(currentAction.landed,finalPin);
  const integrationRows=f.ledger().taskEntries.filter(row=>row.kind==='resource'&&row.actionId===actionId);
  let genericResourceReads=0;
  f.deps.observe={observeResources:async request=>{genericResourceReads++;return {results:request.resources.map(resource=>({resourceId:resource.resourceId,kind:resource.kind,positive:true,
    evidence:[{kind:'fixture-presence',ref:'integration-resource'}]}))};}};
  const genericRelease=await f.command({operation:'reconcile',requestId:'generic-integration-resource-release',taskId:'A',expectedLedgerRevision:f.ledger().revision,
    attemptIds:[],actionIds:[],resourceIds:[integrationRows[0].resourceId],observationTypes:['resources'],
    releaseRulings:[{resourceId:integrationRows[0].resourceId,expectedResourceRevision:integrationRows[0].revision,reason:'try generic cleanup',evidence:['fixture:claimed']}]});
  assert.equal(genericRelease.ok,false);assert.equal(genericRelease.code,'EVIDENCE_INCOMPLETE',JSON.stringify(genericRelease));
  assert.equal(genericResourceReads,0,'generic reconciliation cannot probe or release action-owned integration resources');
  assert.equal(f.ledger().taskEntries.filter(row=>row.kind==='resource'&&row.resourceId===integrationRows[0].resourceId).at(-1).disposition,'retained');
  const stageStat=lstatSync(stageDir),backupStat=lstatSync(recoveryPlan.backupDir);
  const rows=()=>{const heads=new Map();for(const row of f.ledger().taskEntries)if(row.kind==='resource'&&row.actionId===actionId)heads.set(row.resourceId,row);return [...heads.values()];};
  const inventory=path=>{try{const stat=lstatSync(path);return [{path:'.',kind:'directory',bytes:0,sha256:null,mode:stat.mode&0o777}];}catch{return [];}};
  const pinsForResources=rows().map((row,index)=>{const path=row.resourceKey,entries=inventory(path);assert.equal(entries.length,1);return {
    role:index===0?'stage':'backup',resourceId:row.resourceId,resourceRevision:row.revision,resourceKey:path,resourceKind:row.resourceKind,
    cleanupRecipe:'owned-directory-remove',inventoryMapSha256:sha256Hex(Buffer.from(canonicalJson(entries))),entryCount:entries.length,contentBytes:0,
    rootMode:entries[0].mode,gitRegistration:null,
  };});
  assert.equal(stageStat.mode&0o777,0o700);assert.equal(backupStat.mode&0o777,0o700);
  const sourceAdmission=f.ledger().taskEntries.find(row=>row.kind==='action'&&row.actionId===actionId&&row.phase==='land'&&row.state==='intended');
  const sourceProof=f.ledger().taskEntries.filter(row=>row.kind==='action'&&row.actionId===actionId&&row.receipt?.recoveryClassification==='full-applied').at(-1);
  const admissionRequest=f.ledger().requests.find(row=>row.actorKey===`agent:${f.lead.agentId}`&&row.assignmentId===f.assignmentId&&row.requestId===sourceAdmission.requestId);
  assert.ok(sourceAdmission&&sourceProof&&admissionRequest);
  const sourceAdmissionRef={entryId:sourceAdmission.entryId,entrySha256:sourceAdmission.entrySha256};
  const sourceProofRef={entryId:sourceProof.entryId,entrySha256:sourceProof.entrySha256};
  const sourceControlSha256=taskIntegrationCleanupSourceControlDigest(sourceAdmission,admissionRequest.bodySha256,'grant:integrate');
  const bundle=DeskTaskIntegrationCleanupBundle.parse({version:1,modeSemantics:'actual-filesystem-bits',actionId,basis:'land-recovery',
    recoveryPlanSha256:canonicalSha256(recoveryPlan),sourceAdmissionRef,sourceProofRef,sourceProofKind:'full-applied',sourceGrantRef:'grant:integrate',
    sourceControlSha256,targetBefore:finalPin,resources:pinsForResources.map(pin=>({pin,entries:inventory(pin.resourceKey)}))});
  const bundleBytes=taskIntegrationCleanupBundleBytes(bundle),artifactPath=taskIntegrationCleanupArtifactPath(stageDir);
  const candidate={version:1,basis:'land-recovery',actionId,recoveryPlanSha256:canonicalSha256(recoveryPlan),sourceAdmissionRef,sourceProofRef,
    sourceProofKind:'full-applied',sourceGrantRef:'grant:integrate',sourceControlSha256,targetBefore:finalPin,
    artifact:{path:artifactPath,artifactSha256:sha256Hex(bundleBytes),bytes:bundleBytes.byteLength,bundleSha256:canonicalSha256(bundle),mode:0o600},resources:pinsForResources};
  assert.equal(f.ledger().taskEntries.filter(row=>row.kind==='action'&&row.actionId===actionId).at(-1).sourceBase.artifactSha256,sourceBase.artifactSha256);
  assert.equal(f.ledger().taskEntries.filter(row=>row.kind==='action'&&row.actionId===actionId).at(-1).sourceResult.artifactSha256,sourceResult.artifactSha256);
  let corruptSourceResult=false,driftTarget=false,observerCalls=0;
  const resourceRowsNow=()=>pinsForResources.map(pin=>{const current=f.ledger().taskEntries.filter(row=>row.kind==='resource'&&row.resourceId===pin.resourceId).at(-1);return {pin,current};});
  const cleanupObserver=async request=>{
    observerCalls++;
    const artifactBytes=readFileSync(artifactPath);
    const sourceBasePin=sha256Hex(readFileSync(sourceBasePath))===sourceBase.artifactSha256?request.sourceBase:null;
    let sourceResultPin=sha256Hex(readFileSync(sourceResultPath))===sourceResult.artifactSha256?request.sourceResult:null;
    if(corruptSourceResult&&sourceResultPin!==null)sourceResultPin={...sourceResultPin,snapshotSha256:'9'.repeat(64)};
    return {version:1,purpose:request.purpose,progressKind:request.progressKind,
      admissionSha256:taskIntegrationCleanupAdmissionSha256(request.admission),
      artifact:{path:artifactPath,kind:'regular',mode:0o600,bytes:new Uint8Array(artifactBytes)},
      target:driftTarget?{...finalPin,snapshotSha256:'9'.repeat(64)}:{...finalPin,measuredAt:'2026-01-01T00:00:01.000Z'},
      sourceBase:sourceBasePin,sourceResult:sourceResultPin,sourceProofRef,sourceProofKind:'full-applied',
      resources:resourceRowsNow().map(({pin,current})=>{const entries=inventory(current.resourceKey);return {
        resourceId:current.resourceId,resourceRevision:current.revision,resourceKey:current.resourceKey,resourceKind:current.resourceKind,
        rootMode:entries.length===0?null:entries[0].mode,entries,gitRegistration:null,
      };}),
    };
  };
  f.deps.observe={observeIntegrationCleanup:cleanupObserver};
  const verifyPins=pins(),verifyPublicId='public-cleanup-verify',verifyPublicSha=canonicalSha256({phase:'discharge',actionId,verifyPublicId});
  let verifyIntent;
  try{verifyIntent=await f.effect({operation:'intent',requestId:'cleanup-verify-intent',actionId,actionKind:'integration',body:{phase:'discharge',cleanupStep:'verify-account',
    cleanupCandidate:candidate,controlPins:verifyPins,grantRef:'grant:integrate',recoveryPlan,publicRequestId:verifyPublicId,publicRequestSha256:verifyPublicSha}});}catch(error){throw new Error(`cleanup verify intent failed: ${String(error)}`);}
  assert.equal(verifyIntent.ok,true,JSON.stringify(verifyIntent));
  const verifyIssue=await f.effect({operation:'issue',requestId:'cleanup-verify-issue',actionId,actionKind:'integration'});
  assert.equal(verifyIssue.ok,true,JSON.stringify(verifyIssue));assert.equal(verifyIssue.perform,true);
  writeFileSync(artifactPath,bundleBytes,{mode:0o600});chmodSync(artifactPath,0o600);
  const verifyIssuedRow=f.ledger().taskEntries.filter(row=>row.kind==='action'&&row.actionId===actionId).at(-1);
  const verifyTrigger={phase:'discharge',cleanupStep:'verify-account',controlPins:verifyPins,publicRequestId:verifyPublicId,publicRequestSha256:verifyPublicSha,
    candidateSha256:canonicalSha256(candidate),verifyIssueRef:{entryId:verifyIssuedRow.entryId,entrySha256:verifyIssuedRow.entrySha256}};
  const verifyRevision=f.ledger().revision;
  f.deps.cleanupArtifactBytes={candidateSha256:canonicalSha256(candidate),bytes:new Uint8Array([1,2,3])};
  const badBytes=await f.effect({operation:'observe',requestId:'cleanup-verify-bad-bytes',actionId,actionKind:'integration',receipt:verifyTrigger});
  assert.equal(badBytes.ok,false);assert.equal(observerCalls,0);assert.equal(f.ledger().revision,verifyRevision);
  f.deps.cleanupArtifactBytes={candidateSha256:canonicalSha256(candidate),bytes:new Uint8Array(bundleBytes)};
  corruptSourceResult=true;
  const sourceDrift=await f.effect({operation:'observe',requestId:'cleanup-verify-source-drift',actionId,actionKind:'integration',receipt:verifyTrigger});
  assert.equal(sourceDrift.ok,false);assert.equal(observerCalls,1);assert.equal(f.ledger().revision,verifyRevision);
  assert.equal(f.ledger().taskEntries.filter(row=>row.kind==='action'&&row.actionId===actionId).at(-1).cleanupVerification,null);
  corruptSourceResult=false;
  driftTarget=true;
  const targetDrift=await f.effect({operation:'observe',requestId:'cleanup-verify-target-drift',actionId,actionKind:'integration',receipt:verifyTrigger});
  assert.equal(targetDrift.ok,false);assert.equal(observerCalls,2);assert.equal(f.ledger().revision,verifyRevision);
  driftTarget=false;
  const verifyObserveId='cleanup-verify-observe-good';
  let verified;try{verified=await f.effect({operation:'observe',requestId:verifyObserveId,actionId,actionKind:'integration',receipt:verifyTrigger});}catch(error){throw new Error(`cleanup verification observe threw: ${String(error)}`);}
  assert.equal(verified.ok,true,JSON.stringify(verified));assert.equal(observerCalls,3);
  const verifyHead=f.ledger().taskEntries.filter(row=>row.kind==='action'&&row.actionId===actionId).at(-1);
  assert.deepEqual(verifyHead.cleanupVerification.candidate,candidate);
  f.deps.cleanupArtifactBytes=undefined;
  const replay=await f.effect({operation:'observe',requestId:verifyObserveId,actionId,actionKind:'integration',receipt:verifyTrigger});
  assert.equal(replay.ok,true,JSON.stringify(replay));assert.equal(replay.replayed,true);assert.equal(observerCalls,3,'historical trigger replay precedes transient bytes and observer IO');
  await f.define('B');
  const blocked=await f.effect({operation:'integration-admit',requestId:'integrate-admit-B',assignmentId:f.assignmentId,taskId:'B',resultId:'missing-result',
    expectedLedgerRevision:f.ledger().revision,expectedResultRevision:0,expectedAdjudicationRevision:0,
    grant:{authorityRef:'grant:integrate',paths:['out.txt'],target:{cwd:f.repository}},verification:{recipeIds:[]},body:{}});
  assert.equal(blocked.ok,false);assert.equal(blocked.code,'SCOPE_CONFLICT','verified resources still reserve the target before supported cleanup');
  assert.equal(f.ledger().taskEntries.some(row=>row.kind==='attempt'&&row.taskId==='B'),false);

  const makeResourceCycle=async(resourceRole,ordinal,label,remove)=>{
    const pin=candidate.resources.find(item=>item.role===resourceRole),current=f.ledger().taskEntries.filter(row=>row.kind==='resource'&&row.resourceId===pin.resourceId).at(-1);
    const verificationEntry=f.ledger().taskEntries.filter(row=>row.kind==='action'&&row.actionId===actionId&&row.cleanupVerification!=null).sort((a,b)=>a.revision-b.revision)[0];
    const verificationRef={entryId:verificationEntry.entryId,entrySha256:verificationEntry.entrySha256};
    const controlPins=pins(),publicRequestId=`public-${label}`,publicRequestSha=canonicalSha256({phase:'discharge',label,controlPins});
    const permit={version:1,cleanupStep:'remove-resource',actionId,verificationRef,resourceId:pin.resourceId,expectedResourceRevision:current.revision,
      resourceKey:pin.resourceKey,inventoryMapSha256:pin.inventoryMapSha256,ordinal,cleanupRecipe:pin.cleanupRecipe};
    let intent;try{intent=await f.effect({operation:'intent',requestId:`${label}-intent`,actionId,actionKind:'integration',body:{phase:'discharge',cleanupStep:'remove-resource',
      permit,verificationRef,controlPins,grantRef:'grant:integrate',recoveryPlan,publicRequestId,publicRequestSha256:publicRequestSha}});}catch(error){throw new Error(`${label} intent threw: ${String(error)}`);}
    assert.equal(intent.ok,true,JSON.stringify(intent));
    let issued;try{issued=await f.effect({operation:'issue',requestId:`${label}-issue`,actionId,actionKind:'integration'});}catch(error){throw new Error(`${label} issue threw: ${String(error)}`);}
    assert.equal(issued.ok,true,JSON.stringify(issued));assert.equal(issued.perform,true);
    if(remove)rmSync(pin.resourceKey,{recursive:true,force:true});
    const issuedRow=f.ledger().taskEntries.filter(row=>row.kind==='action'&&row.actionId===actionId).at(-1);
    const trigger={phase:'discharge',cleanupStep:'remove-resource',controlPins,publicRequestId,publicRequestSha256:publicRequestSha,
      verificationRef,issuedPermitRef:{entryId:issuedRow.entryId,entrySha256:issuedRow.entrySha256}};
    let observed;try{observed=await f.effect({operation:'observe',requestId:`${label}-observe`,actionId,actionKind:'integration',receipt:trigger});}catch(error){throw new Error(`${label} observe threw: ${String(error)}`);}
    assert.equal(observed.ok,true,JSON.stringify(observed));
    return observed;
  };
  const firstStage=await makeResourceCycle('stage',1,'cleanup-stage-cycle1',false);
  assert.equal(firstStage.ok,true);
  let resources=rows();assert.deepEqual(resources.map(row=>row.disposition),['retained','retained']);
  const stillBlocked=await f.effect({operation:'integration-admit',requestId:'integrate-admit-B-held',assignmentId:f.assignmentId,taskId:'B',resultId:'missing-result',
    expectedLedgerRevision:f.ledger().revision,expectedResultRevision:0,expectedAdjudicationRevision:0,
    grant:{authorityRef:'grant:integrate',paths:['out.txt'],target:{cwd:f.repository}},verification:{recipeIds:[]},body:{}});
  assert.equal(stillBlocked.code,'SCOPE_CONFLICT','a held partial/no-progress cleanup cycle retains the target fence');
  await makeResourceCycle('stage',2,'cleanup-stage-cycle2',true);
  resources=rows();assert.deepEqual(resources.map(row=>row.disposition),['released','retained']);
  await makeResourceCycle('backup',1,'cleanup-backup-cycle1',true);
  resources=rows();assert.deepEqual(resources.map(row=>row.disposition),['released','released']);
  assert.equal(f.ledger().taskEntries.filter(row=>row.kind==='action'&&row.actionId===actionId).at(-1).cleanupVerification.candidate.artifact.artifactSha256,candidate.artifact.artifactSha256);
  assert.equal(sha256Hex(readFileSync(sourceBasePath)),sourceBase.artifactSha256,'historical BASE map remains outside both removable resources');
  assert.equal(sha256Hex(readFileSync(sourceResultPath)),sourceResult.artifactSha256,'RESULT map remains outside both removable resources');
  const afterRelease=await f.effect({operation:'integration-admit',requestId:'integrate-admit-B-after-cleanup',assignmentId:f.assignmentId,taskId:'B',resultId:'missing-result',
    expectedLedgerRevision:f.ledger().revision,expectedResultRevision:0,expectedAdjudicationRevision:0,
    grant:{authorityRef:'grant:integrate',paths:['out.txt'],target:{cwd:f.repository}},verification:{recipeIds:[]},body:{}});
  assert.notEqual(afterRelease.code,'SCOPE_CONFLICT','all exact resource rows release the target fence only after both accounted observations');
});

import { runHandbackSubmit,runAssignmentAttach } from '../plugin/server/desk-handback.ts';
import { runScopeReview } from '../plugin/server/desk-scope.ts';
import { runAssignmentAmend } from '../plugin/server/desk-assignment.ts';

test('terminal approved close retains exact task review proof; current owner-reviewer/brief/mandate drift invalidates it',async t=>{
  const f=await coreFixture(t);
  const scope={label:'completed writer',refs:[],ownership:{writerAgentId:'future',writerAuthorityRef:null,paths:['src/task'],resources:[],stateOwners:[],dependsOnScopeIds:[],notifications:[]},reviewPlan:{kind:'required',authorityRef:'human:fixture',ruleRef:'protocol',reason:'selected semantic review',lenses:[{id:'semantic',name:'semantic contract',authorityRef:'human:fixture',ruleRef:'protocol'}],exemptionClass:null}};
  const defined=await f.command({operation:'define',requestId:'scoped',taskId:'A',...f.pins(0),task:{...f.body,scope}});assert.equal(defined.ok,true,JSON.stringify(defined));
  const attemptId=await f.start('A');const attempt=f.ledger().taskEntries.filter(r=>r.kind==='attempt').at(-1);
  const record={version:1,kind:'handback',seat:{role:'peer',disposition:'engineer',agentId:f.worker.agentId},verdict:'APPROVE',candidate:{repository:f.repository,snapshotSha256:'b'.repeat(64)},checks:[{cmd:'fixture',exit:0,sha:sha256Hex('ok'),output:'ok'}]};
  const handback=await runHandbackSubmit({repoKey:f.repoKey,row:f.worker},{requestId:'handback',assignmentId:f.assignmentId,recordV1:record,candidateId:null},{store:f.store,uuid:()=>crypto.randomUUID(),now:()=>new Date('2026-01-01T00:00:00.000Z'),binding:{nodePath:process.execPath,runtimePath:f.dir},capture:async({repository})=>({status:'ok',repository,measuredAt:'2026-01-01T00:00:00.000Z',snapshotSha256:'b'.repeat(64),head:null,incomplete:[]})});assert.equal(handback.ok,true,JSON.stringify(handback));
  const attach=await runAssignmentAttach(f.ctx,{requestId:'reviewer-attach',assignmentId:f.assignmentId,agentId:f.successor.agentId},f.deps);assert.equal(attach.ok,true);
  const transition=async(name)=>{const r=await runScopeTransition(f.ctx,{requestId:name,assignmentId:f.assignmentId,scopeId:attempt.boundScopeId,scopeRevision:1,transition:name,candidateSnapshot:name==='submit-for-review'?'b'.repeat(64):null,candidateHead:null,briefRevision:0},f.deps);assert.equal(r.ok,true,JSON.stringify(r));};
  await transition('submit-for-review');
  const review=await runScopeReview({repoKey:f.repoKey,row:f.successor},{requestId:'semantic-review',assignmentId:f.assignmentId,scopeId:attempt.boundScopeId,scopeRevision:1,candidateSnapshot:'b'.repeat(64),lensId:'semantic',briefRevision:0,verdict:'approve',findingsRef:null},f.deps);assert.equal(review.ok,true,JSON.stringify(review));
  await transition('review-observed');await transition('approve');
  const round=currentScopeReviewQualification(f.ledger(),f.ledger().assignments[0],attempt.boundScopeId).standingApproval;
  const result=await runTaskCommand({repoKey:f.repoKey,row:f.worker},{operation:'result',requestId:'scoped-result',assignmentId:f.assignmentId,taskId:'A',attemptId,...f.pins(),result:{snapshotSha256:'b'.repeat(64),candidate:null,handbackId:handback.handbackId,handbackDigest:null,artifacts:[{key:'out.txt',sha256:'c'.repeat(64)}],scopeId:attempt.boundScopeId,scopeRevision:1,reviewRound:{scopeRevision:1,candidateSnapshot:round.candidateSnapshot,briefRevision:0,mandateSha256:round.mandateSha256},checkRuns:[],findings:[],provenance:'claimed'}},f.deps);assert.equal(result.ok,true,JSON.stringify(result));await f.rule('A',result.resultId);
  assert.equal(currentTaskResultQualification(f.ledger(),f.assignmentId,'A').scopeProof,'standing-approval');
  await transition('close');
  assert.equal(currentScopeReviewQualification(f.ledger(),f.ledger().assignments[0],attempt.boundScopeId).standingApproval,null);
  const qualification=currentTaskResultQualification(f.ledger(),f.assignmentId,'A');assert.equal(qualification.qualified,true,JSON.stringify(qualification));assert.equal(qualification.scopeProof,'terminal-approved-round');
  await f.define('B',[{taskId:'A',availability:'artifact',artifactKey:'out.txt',targetPath:'out.txt',target:null}]);assert.equal(taskQueueCounts(f.ledger(),f.ledger().assignments[0]).ready,1);
  const changed=structuredClone(f.ledger());changed.scopes.at(-1).reviewPlan.reason='different mandate';assert.equal(currentTaskResultQualification(changed,f.assignmentId,'A').qualified,false);
  const rejected=structuredClone(f.ledger());rejected.scopeTransitions.at(-1).from='rejected';assert.equal(currentTaskResultQualification(rejected,f.assignmentId,'A').qualified,false);
  const offer=await runAssignmentOffer(f.ctx,{requestId:'offer',assignmentId:f.assignmentId,expectedOwnershipRevision:0,targetAgentId:f.successor.agentId,targetMembershipId:f.successor.membershipId,authorityRef:'human:succession',contextRef:'fixture:continuity'},f.deps);assert.equal(offer.ok,true,JSON.stringify(offer));
  const accepted=await runAssignmentAccept({repoKey:f.repoKey,row:f.successor},{requestId:'accept',assignmentId:f.assignmentId,offerId:offer.offerId,expectedOwnershipRevision:0,expectedLedgerRevision:f.ledger().revision,expectedBriefRevision:0,acknowledgment:'take retained obligations',settlementRef:null,resources:[]},f.deps);assert.equal(accepted.ok,true,JSON.stringify(accepted));
  assert.equal(currentTaskResultQualification(f.ledger(),f.assignmentId,'A').qualified,false);
  assert.equal(currentScopeReviewQualification(f.ledger(),f.ledger().assignments[0],attempt.boundScopeId,{includeClosedApproval:true}).terminalApproval,null);
  const denied=await f.command({operation:'stop',requestId:'old-owner-stop',taskId:'A',attemptId,...f.pins(),expectedOwnershipRevision:1,reason:'prior owner cannot stop'});assert.equal(denied.code,'ACTOR_MISMATCH');
});

test('under-lock dependency recheck rejects measurement raced by a real unrelated commit',async t=>{
  const f=await coreFixture(t);await f.define('A');const a=await f.start('A');const result=await f.result('A',a);await f.rule('A',result.resultId);
  await f.define('B',[{taskId:'A',availability:'artifact',artifactKey:'out.txt',targetPath:'out.txt',target:null}]);
  f.deps.observe={observeDependencies:async req=>{
    const drift=await f.store.transact(f.repoKey,{repo:f.repo,actorKey:'fixture',assignmentId:'fixture',requestId:'during-measure',command:{kind:'legacy-read-proof'}},()=>({ok:true,events:[]}));assert.equal(drift.ok,true);
    return {consumerBase:{root:f.repository,snapshotSha256:'b'.repeat(64),head:null,kind:'git-snapshot',measuredAt:'2026-01-01T00:00:00.000Z',incomplete:[],artifactSha256:null},reference:null,results:req.pins.map(pin=>({taskId:pin.taskId,resultEntrySha256:pin.resultEntrySha256,adjudicationEntrySha256:pin.adjudicationEntrySha256,available:true,sha256:pin.artifactSha256,actualTargetPin:null,evidence:[{kind:'bytes',ref:'out.txt'}]}))};
  }};
  const rejected=await f.reserve('B');assert.equal(rejected.code,'REVISION_CONFLICT');assert.equal(f.ledger().taskEntries.some(row=>row.kind==='attempt'&&row.taskId==='B'),false);
});

test('full-chain task authority rejects cross-event actor substitution even after recomputed row and event digests',async t=>{
  const f=await coreFixture(t);await f.define('A');const attemptId=await f.start('A');await f.result('A',attemptId);
  const paths=deskRepoPaths(join(f.dir,'home','slp-runtime'),f.repoKey);const disk=JSON.parse(readFileSync(paths.ledgerPath,'utf8'));
  const result=disk.taskEntries.find(row=>row.kind==='result');result.actorAgentId=f.successor.agentId;result.actorMembershipId=f.successor.membershipId;
  const {entrySha256:_sha,...bytes}=result;result.entrySha256=canonicalSha256(bytes);
  let previous=null;
  const segments=readdirSync(paths.eventsDir).sort((a,b)=>Number(a.split('-')[0])-Number(b.split('-')[0]));
  for(const name of segments){const file=join(paths.eventsDir,name);const events=readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
    for(const event of events){if(event.kind==='task-entry-appended'&&event.payload.entryId===result.entryId){event.actorKey=`agent:${f.successor.agentId}`;event.payload.actorMembershipId=f.successor.membershipId;event.payload.entrySha256=result.entrySha256;}event.prevSha256=previous;const {sha256:_drop,...body}=event;event.sha256=canonicalSha256(body);previous=event.sha256;}
    writeFileSync(file,events.map(JSON.stringify).join('\n')+'\n');
  }
  disk.lastEventSha256=previous;writeFileSync(paths.ledgerPath,JSON.stringify(disk)+'\n');assert.equal(f.store.read(f.repoKey).state,'corrupt');
});

test('outstanding attempts reserve membership table room across legacy commits and command-name spoofing',async t=>{
  const f=await coreFixture(t);await f.define('A');const reserved=await f.reserve('A',{reuseTarget:'new',grantRef:'grant:create'});assert.equal(reserved.ok,true,JSON.stringify(reserved));
  const rows=[f.lead,f.worker,f.successor];while(rows.length<LEDGER_LIMITS.memberships){const n=rows.length;rows.push({...f.worker,membershipId:crypto.randomUUID(),bindingHandleSha256:canonicalSha256(`fixture-${n}`),agentId:`fixture-${n}`});}
  const mutate=()=>({ok:true,events:[],memberships:rows});
  const ordinary=await f.store.transact(f.repoKey,{repo:f.repo,actorKey:'fixture',assignmentId:'fixture',requestId:'legacy-overflow',command:{kind:'legacy'}},mutate);assert.equal(ordinary.code,'INVALID_RECORD');assert.match(ordinary.message,/recovery capacity/);
  const spoof=await f.store.transact(f.repoKey,{repo:f.repo,actorKey:'fixture',assignmentId:'fixture',requestId:'spoof-recovery',command:{kind:'task.stop'}},mutate);assert.equal(spoof.code,'INVALID_RECORD');assert.equal(f.ledger().memberships.length,3);
});


test('steering preserves original unbound reservation paths/resources/state owners until supported settlement',async t=>{
  for(const surface of ['paths','resources','stateOwners']) {
    const f=await coreFixture(t);
    const ownership={writerAgentId:'future',writerAuthorityRef:null,paths:[],resources:[],stateOwners:[],dependsOnScopeIds:[],notifications:[]};
    ownership[surface]=surface==='stateOwners'?[{stateRef:'state:domain',moduleRef:'src/domain'}]:surface==='paths'?['src/original']:['resource:exclusive'];
    const scope={label:'original reservation',refs:[],ownership,reviewPlan:{kind:'not-required',authorityRef:'human:fixture',ruleRef:'protocol',reason:'fixture',lenses:[],exemptionClass:null}};
    const defined=await f.command({operation:'define',requestId:'original',taskId:'A',...f.pins(0),task:{...f.body,scope}});assert.equal(defined.ok,true,JSON.stringify(defined));
    const a=await f.reserve('A');assert.equal(a.ok,true,JSON.stringify(a));
    const changed=await f.command({operation:'amend',requestId:'narrow',taskId:'A',expectedTaskRevision:1,task:{scope:null}});assert.equal(changed.ok,true,JSON.stringify(changed));
    const b=await f.command({operation:'define',requestId:'B',taskId:'B',...f.pins(0),task:{...f.body,scope}});assert.equal(b.ok,true,JSON.stringify(b));
    const denied=await f.reserve('B');assert.equal(denied.code,'SCOPE_CONFLICT',surface+': '+JSON.stringify(denied));
    const old=f.ledger().taskEntries.find(row=>row.kind==='attempt');assert.equal(old.taskRevision,1);assert.equal(old.boundScopeId,null);
  }
});
