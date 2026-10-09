import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFormationPlanner, runSeatCreate } from '../../plugin/server/desk-formation.ts';
import { createFormationPlacement } from '../../plugin/server/desk-placement.ts';
import { install } from '../../plugin/server/runtime/cli/package.ts';
import { selectionFixture } from './seat-selection-fixture.mjs';
import { memberRow } from './desk-bridge-fixture.mjs';

export const fixtureGit = (cwd, ...args) => execFileSync('git', ['-C',cwd,...args], {encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
export function committedRepository(cwd) {
 mkdirSync(cwd,{recursive:true});fixtureGit(cwd,'init','-q');
 fixtureGit(cwd,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','fixture base');
 return realpathSync(join(cwd,'.git'));
}
export function placementFixture(t,{mode='off',count=1,registration='ready',budgets,role='peer'}={}) {
 const f=selectionFixture(t,{mode,count});
 const commonDir=committedRepository(f.repository),target=join(f.dir,'target');
 // Fixture prerequisite only; the product never calls Git worktree add or host setup.
 fixtureGit(f.repository,'worktree','add','--detach',target,'HEAD');
 const foreign=join(f.dir,'foreign'),nested=join(f.repository,'nested');
 committedRepository(foreign);committedRepository(nested);
 const candidate=join(f.dir,'candidate');install(fileURLToPath(new URL('../..',import.meta.url)),candidate);
 writeFileSync(join(f.home,'config.json'),JSON.stringify({daemon:{agentProfiles:[{id:'slp-lead',provider:'slp-codex-lead',
  model:'model/variant',modeId:'full-access',thinkingOptionId:'high',featureValues:{fast_mode:true}}]}}));
 const at='2026-01-01T00:00:00.000Z',row=memberRow('parent',{provider:'slp-codex-lead',at},
  {agentId:'parent',role:'lead',createCwd:f.repository,workspaceId:'caller'});
 const workspaces=new Map([['caller',{id:'caller',workspaceDirectory:f.repository,status:'done',archivingAt:null}],
  ['target',{id:'target',workspaceDirectory:target,status:'done',archivingAt:null}]]);
 const calls=[],members=[],snapshots=new Map();
 let currentRole=role,registrationState=registration,refreshFault=null,openFault=null,afterCreate=null,providerHook=null;
 const create=async (id,options)=>{
  calls.push({kind:'create',workspaceId:id,options});
  const provider=options.config.provider.slice(0,options.config.provider.indexOf('/'));
  const childId=snapshots.has('child')?'grandchild':'child';
  const snapshot={id:childId,provider,model:options.config.provider.slice(options.config.provider.indexOf('/')+1),
   cwd:workspaces.get(id).workspaceDirectory,workspaceId:id,archivedAt:null,
   labels:{...options.labels,'paseo.parent-agent-id':options.parent},currentModeId:options.config.modeId,
   thinkingOptionId:options.config.thinkingOptionId,features:Object.entries(options.config.featureValues??{}).map(([id,value])=>({id,value}))};
  snapshots.set(childId,snapshot);
  if(registrationState!=='missing')members.push(memberRow(childId,{provider,at},{agentId:childId,role:currentRole,
   createCwd:snapshot.cwd,workspaceId:id,...(registrationState==='unregistered'?{registeredAt:null}:{}),
   ...(registrationState==='revoked'?{revokedAt:at,revokeReason:'fixture'}:{})}));
  await afterCreate?.();return {id:childId};
 };
 const ref=id=>({id,refresh:async options=>{calls.push({kind:'refresh',id,options});
  if(refreshFault)return refreshFault(id);return workspaces.get(id)??null;},agents:{create:options=>create(id,options)}});
 const workspaceApi={workspaces:{ref,open:async input=>{
  calls.push({kind:'open',input});if(openFault)return openFault(input);
  workspaces.set('opened',{id:'opened',workspaceDirectory:input.cwd,status:'done',archivingAt:null});return ref('opened');
 },create:async()=>{calls.push({kind:'forbidden-workspace-create'});throw new Error('host setup must not run');}}};
 const host={workspaces:{ref},agents:{ref:id=>({refresh:async()=>({agent:snapshots.get(id)??null,project:null}),
  send:async(text,options)=>{calls.push({kind:'send',id,text,options});},timeline:{refetch:async()=>({entries:[]})}})},
  providers:{snapshot:async({cwd})=>{calls.push({kind:'providers',cwd});await providerHook?.(cwd);
   return {entries:[{provider:'slp-codex-'+currentRole,enabled:true,status:'ready',modes:[{id:'full-access'}]}]};}}};
 const planner=createFormationPlanner({runtimePath:candidate,daemonHome:f.home,host:()=>host,
  importModule:async spec=>{const launch=await import(spec);return {...launch,
   selectPeerSeat:(request,deps)=>launch.selectPeerSeat(request,{...deps,decide:f.decide})};}});
 const placement=createFormationPlacement({repo:{gitCommonDir:commonDir},host:()=>workspaceApi,budgets});
 const deps={stableRoot:join(f.home,'slp-runtime'),repoKey:'repo',host:()=>host,plan:planner,
  placement,placementCapability:planner.placementCapability,preflightPeer:planner.preflightPeer,selectPeer:planner.selectPeer,
  readMemberships:()=>members,membershipWaitMs:30,guard:async()=>null};
 const input={requestId:'placement',role,taskLabel:'bounded',assignment:f.request.assignment,grantRef:'human:fixture'};
 return {...f,candidate,row,commonDir,target,foreign,nested,workspaces,workspaceApi,host,planner,placement,
  deps,input,members,snapshots,hostCalls:calls,run:request=>{currentRole=(request??input).role;return runSeatCreate(row,request??input,deps);},
  setRegistration:value=>{registrationState=value;},setRefreshFault:value=>{refreshFault=value;},setOpenFault:value=>{openFault=value;},
  setAfterCreate:value=>{afterCreate=value;},setProviderHook:value=>{providerHook=value;}};
}
