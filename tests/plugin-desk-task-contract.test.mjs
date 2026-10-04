import test from 'node:test';
import assert from 'node:assert/strict';
import * as wire from '../plugin/shared/enforcement.ts';

const common = {requestId:'r',assignmentId:'a',expectedLedgerRevision:1,expectedBriefRevision:0,expectedOwnershipRevision:0,taskId:'t',expectedTaskRevision:1};
test('bootstrap accepts pinned intent and excludes a writable initial prompt', () => {
  assert.ok(wire.DeskTaskDispatchInput, 'native dispatch schema must be exported');
  const input={...common,phase:'bootstrap',attemptId:null,expectedAttemptRevision:0,grantRef:'grant:create',runtime:{optionId:'seat',catalogSha256:'a'.repeat(64)},placement:{kind:'shared-checkout',cwd:'/fixture'}};
  assert.equal(wire.DeskTaskDispatchInput.safeParse(input).success,true);
  assert.equal(wire.DeskTaskDispatchInput.safeParse({...input,prompt:'write now'}).success,false);
  assert.equal(wire.DeskTaskDispatchInput.safeParse({...input,phase:'kill'}).success,false);
});
test('owner-pinned proof recipes reject shells, late argv and unbounded limits', () => {
  assert.ok(wire.DeskTaskProofPolicy, 'native proof policy must be exported');
  const recipe={recipeId:'verify',argv:['node','--test','tests/core.test.mjs'],cwd:'.',authorityRef:'grant:proof',ruleRef:'protocol:proof',timeoutMs:1000,maxOutputBytes:4096,required:true};
  const policy={kind:'declared',authorityRef:'grant:proof',ruleRef:'protocol:proof',reason:'repo checks',requiredChecks:[],requiredEvidence:[],verificationRecipes:[recipe],availability:'artifact',reviewRequired:true};
  assert.equal(wire.DeskTaskProofPolicy.safeParse(policy).success,true);
  assert.equal(wire.DeskTaskProofPolicy.safeParse({...policy,verificationRecipes:[{...recipe,shell:true}]}).success,false);
  assert.equal(wire.DeskTaskProofPolicy.safeParse({...policy,verificationRecipes:[{...recipe,timeoutMs:0}]}).success,false);
  assert.equal(wire.DeskTaskIntegrateInput.safeParse({...common,resultId:'result',phase:'check',integrationActionId:'action',expectedActionRevision:1,expectedResultRevision:1,expectedAdjudicationRevision:1,argv:['echo','late command']}).success,false);
});
test('task section is supported while existing page/history budgets remain bounded', () => {
  assert.equal(wire.DeskWorkflowSection.safeParse('tasks').success,true);
  assert.equal(wire.WIRE_LIMITS.deskWorkflowSections,6);
  assert.equal(wire.WIRE_LIMITS.deskWorkflowPage,50);
  assert.equal(wire.WIRE_LIMITS.deskWorkflowHistory,16384);
});

test('integration cleanup has one strict shared inferred contract for proof, permits and observations', () => {
  for (const name of [
    'DeskTaskIntegrationControlPins', 'DeskTaskIntegrationEntryRef', 'DeskTaskIntegrationCleanupInventoryEntry',
    'DeskTaskIntegrationCleanupResourcePin', 'DeskTaskIntegrationCleanupCandidate', 'DeskTaskIntegrationCleanupVerification',
    'DeskTaskIntegrationCleanupPermit', 'DeskTaskIntegrationCleanupObservation',
  ]) assert.equal(typeof wire[name], 'object', `${name} must be the canonical shared Zod contract`);

  const ref={entryId:'entry',entrySha256:'a'.repeat(64)};
  const artifact={path:'/repo/.slp/integrations/action/cleanup.bundle',artifactSha256:'b'.repeat(64),bytes:32,bundleSha256:'c'.repeat(64),mode:0o600};
  const target={snapshotSha256:'d'.repeat(64),head:null,root:'/repo',kind:'git-snapshot',measuredAt:'2026-01-01T00:00:00.000Z',incomplete:[],artifactSha256:null};
  const resource={role:'stage',resourceId:'stage-resource',resourceRevision:1,resourceKey:'/repo/.slp/integrations/action/stage',
    resourceKind:'scratch',cleanupRecipe:'owned-directory-remove',inventoryMapSha256:'e'.repeat(64),entryCount:1,contentBytes:0,rootMode:0o700,gitRegistration:null};
  const candidate={version:1,basis:'stage-only',actionId:'integration-action',recoveryPlanSha256:null,sourceAdmissionRef:ref,sourceProofRef:ref,
    sourceProofKind:'stage-observed',sourceGrantRef:'grant:integration',sourceControlSha256:'f'.repeat(64),targetBefore:target,artifact,resources:[resource]};
  assert.equal(wire.DeskTaskIntegrationCleanupCandidate.safeParse(candidate).success,true);
  assert.equal(wire.DeskTaskIntegrationCleanupCandidate.safeParse({...candidate,unreviewed:true}).success,false,'unknown candidate authority fields are rejected');
  assert.equal(wire.DeskTaskIntegrationCleanupCandidate.safeParse({...candidate,resources:[{...resource,resourceKey:'../outside'}]}).success,false);
  const verification={candidate,verifyIssueRef:{entryId:'verify-issue',entrySha256:'1'.repeat(64)},observerResponseSha256:'2'.repeat(64)};
  assert.equal(wire.DeskTaskIntegrationCleanupVerification.safeParse(verification).success,true);
  const permit={version:1,cleanupStep:'remove-resource',actionId:candidate.actionId,verificationRef:ref,resourceId:resource.resourceId,
    expectedResourceRevision:1,resourceKey:resource.resourceKey,inventoryMapSha256:resource.inventoryMapSha256,ordinal:1,cleanupRecipe:resource.cleanupRecipe};
  assert.equal(wire.DeskTaskIntegrationCleanupPermit.safeParse(permit).success,true);
  assert.equal(wire.DeskTaskIntegrationCleanupPermit.safeParse({...permit,ordinal:3}).success,false,'the resource permit has two total cycles');
  const observation={phase:'discharge',cleanupStep:'verify-account',status:'observed',candidateSha256:'3'.repeat(64),verifyIssueRef:verification.verifyIssueRef,
    artifact,sourceProofRef:ref,target,resources:[{resourceId:resource.resourceId,resourceRevision:1,resourceKey:resource.resourceKey,
      expectedInventoryMapSha256:resource.inventoryMapSha256,observedInventoryMapSha256:resource.inventoryMapSha256,expectedEntryCount:1,
      observedEntryCount:1,missingPathsSha256:null,missingPathCount:0,survivorMapSha256:resource.inventoryMapSha256,survivorEntryCount:1,
      rootMode:0o700,gitRegistration:'not-applicable'}],observerResponseSha256:'4'.repeat(64)};
  assert.equal(wire.DeskTaskIntegrationCleanupObservation.safeParse(observation).success,true);
  assert.equal(wire.DeskTaskIntegrationCleanupObservation.safeParse({...observation,recoveryClassification:'full-applied'}).success,false,
    'cleanup observations cannot create a landing classification');
});

test('cleanup inventory entry parser accepts each bounded kind without discriminator construction errors', () => {
  const entry=wire.DeskTaskIntegrationCleanupInventoryEntry;
  const sha='a'.repeat(64);
  const values=[
    {path:'.',kind:'directory',bytes:0,sha256:null,mode:0o700},
    {path:'nested',kind:'directory',bytes:0,sha256:null,mode:0o755},
    {path:'nested/file',kind:'file',bytes:1,sha256:sha,mode:0o600},
    {path:'nested/link',kind:'symlink',bytes:4,sha256:sha,mode:0o777},
  ];
  for(const value of values) assert.equal(entry.safeParse(value).success,true,JSON.stringify(value));
  for(const value of [
    {...values[2],path:'.'},
    {...values[3],path:'.'},
    {...values[0],path:'../outside'},
    {...values[1],extra:true},
    {...values[0],kind:'socket'},
  ]) assert.equal(entry.safeParse(value).success,false,JSON.stringify(value));
});

test('cleanup effect triggers are strict, status-free internal receipts while legacy receipts remain accepted', () => {
  const pins={assignmentId:'a',taskId:'t',resultId:'result',expectedLedgerRevision:8,expectedResultRevision:2,expectedAdjudicationRevision:3,expectedActionRevision:5};
  const ref={entryId:'entry',entrySha256:'a'.repeat(64)};
  const trigger={phase:'discharge',cleanupStep:'verify-account',controlPins:pins,publicRequestId:'public-verify',publicRequestSha256:'b'.repeat(64),candidateSha256:'c'.repeat(64),verifyIssueRef:ref};
  const input={operation:'observe',requestId:'effect-observe',actionId:'action',actionKind:'integration',receipt:trigger};
  assert.equal(wire.DeskTaskEffectInput.safeParse(input).success,true);
  assert.equal(wire.DeskTaskEffectInput.safeParse({...input,receipt:{...trigger,status:'observed'}}).success,false,
    'recognized cleanup trigger cannot fall through the flexible legacy receipt parser');
  assert.equal(wire.DeskTaskEffectInput.safeParse({...input,receipt:{...trigger,unreviewed:true}}).success,false);
  assert.equal(wire.DeskTaskEffectInput.safeParse({...input,receipt:{status:'observed',phase:'land',final:{snapshotSha256:'d'.repeat(64)}}}).success,true,
    'ordinary historical/legacy observation receipt shape remains unchanged');
});
