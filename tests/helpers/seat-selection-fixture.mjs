import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCatalog } from '../../plugin/server/runtime/cli/routing.ts';
import { routeDecide } from '../../plugin/server/runtime/cli/jev-routing.ts';
export function selectionFixture(t, { mode = 'off', count = 2 } = {}) {
 const dir=mkdtempSync(join(tmpdir(),'slp-seat-selection-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true,maxRetries:3}));
 const repository=join(dir,'repo'),home=join(dir,'home');
 mkdirSync(join(repository,'.paseo-slp'),{recursive:true});mkdirSync(join(home,'slp-runtime/state'),{recursive:true});
 const options=Array.from({length:count},(_,i)=>({id:i===0?'first':i===1?'second':'option-'+i,provider:'codex',
  model:'model/variant',roles:['peer'],enabled:true,availability:'ready',modeId:'full-access',thinkingOptionId:'high',
  features:{fast_mode:true},suitableFor:['coding'],avoidFor:[],notes:'fixture'}));
 const catalog={version:1,policy:'Fixture pool',quotaFallback:{enabled:false,optionId:null},options};
 const poolPath=join(repository,'.paseo-slp/slp-routing.json'),configPath=join(home,'slp-runtime/state/jev.json'),keyPath=join(home,'slp-runtime/state/jev-openrouter.key');
 const savePool=()=>writeFileSync(poolPath,JSON.stringify(catalog));savePool();
 const configure=value=>{
  if(value==='unconfigured')rmSync(configPath,{force:true});
  else if(value==='error')writeFileSync(configPath,'{invalid');
  else writeFileSync(configPath,JSON.stringify({schemaVersion:1,enabled:value!=='off',capabilities:{routing:value==='armed'},
   provider:{kind:'openrouter',model:'typesafe/jev-1.13'}}));
 };
 configure(mode);writeFileSync(keyPath,'fixture-key\n',{mode:0o600});
 const request={repository,assignment:'Read the bounded code and report evidence.',paseoHome:home};
 const providers=[{id:'slp-codex-peer',enabled:true,status:'available'}];
 const phases=[],calls={logical:0,fetch:0};let choice='second',failure=null;
 const fetchImpl=async(_url,init)=>{
  calls.fetch++;const body=JSON.parse(init.body);assert.equal(body.state.task,request.assignment);
  if(failure==='network')throw new TypeError('fixture fetch failed');
  if(failure==='timeout'){const e=new Error('fixture timeout');e.name='TimeoutError';throw e;}
  if(failure==='schema')return {ok:true,json:async()=>({answers:{}})};
  const picked=failure==='out-of-set'?'unknown-option':choice;
  return {ok:true,json:async()=>({model:'typesafe/jev-1.13',answers:{route_option:{type:'choice',choice:picked}}})};
 };
 const decide=async req=>{calls.logical++;return routeDecide(req,{fetchImpl});};
 const deps={providers,phase:(name,value)=>phases.push({name,value}),decide};
 return {dir,repository,home,poolPath,configPath,keyPath,catalog,options,savePool,configure,request,providers,phases,calls,fetchImpl,decide,deps,
  sha:()=>readCatalog(repository,home).sha256,setChoice:value=>{choice=value;},setFailure:value=>{failure=value;}};
}
