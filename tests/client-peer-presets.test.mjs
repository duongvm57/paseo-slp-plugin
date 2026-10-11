import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { act, deferredRpc, loadHooks } from './helpers/client-hooks-harness.mjs';

const colors=Object.fromEntries(['foreground','foregroundMuted','statusDanger','statusWarning','statusSuccess','surface0','surface1','surface2','border','accent','accentForeground'].map(k=>[k,'#123456']));
const SHA='a'.repeat(64);
const result=pool=>({schemaVersion:1,pool,sha256:pool?SHA:null,error:null,legacy:null,legacyError:null});
const oldPool=()=>({version:1,policy:'Keep my policy',extension:{owner:'Human'},quotaFallback:{enabled:true,optionId:'fast'},
 options:[{id:'fast',provider:'codex',model:'old',thinkingOptionId:'high',roles:['supervisor'],enabled:true,availability:'unavailable',
 suitableFor:['settled work'],avoidFor:[],notes:'PRIVATE',extension:'old entry only'}]});
const rendered=f=>JSON.stringify(f.renderer.toJSON());
async function setup(t,initial=null) {
 const mod=await loadHooks(t);mod.primitiveState.tree=true;
 const read=deferredRpc(),write=deferredRpc(),state={};
 function Harness({home}) {
  const target={hostId:'fixture',daemonHome:home};
  const pool=mod.usePeerPoolCard({target,targetKey:mod.targetKey(target),isCurrentKey:()=>true,
   callGetPeerPool:read.rpc,callSetPeerPool:write.rpc,catalogs:{},featureSets:{},featuresLoadingFor:null,scrollFocusNode:()=>{},update:()=>{}});
  state.pool=pool;
  return React.createElement(mod.PeerPoolCard,{colors,target,compact:false,statusView:null,jev:{view:null},pool,
   availableFamilies:['codex'],catalogs:{},catalogLoadingFor:null,retryCatalog:async()=>{},retryFeatureSet:async()=>{},scrollFocusNode:()=>{}});
 }
 let renderer;await act(async()=>{renderer=TestRenderer.create(React.createElement(Harness,{home:'/a'}));});
 t.after(async()=>{await act(async()=>renderer.unmount());});
 await act(async()=>read.calls[0].resolve(result(initial)));
 const button=label=>renderer.root.findAllByType('Pressable').find(n=>n.props.accessibilityLabel===label);
 const field=label=>renderer.root.findAllByType('TextInput').find(n=>n.props.accessibilityLabel===label);
 const press=async label=>{const node=button(label);assert.ok(node,`button ${label}`);assert.ok(!node.props.disabled,`${label} enabled`);await act(async()=>node.props.onPress());};
 return {state,renderer,read,write,button,field,press,mod,update:async home=>{await act(async()=>renderer.update(React.createElement(Harness,{home})));}};
}

test('real preset UI adds/edit custom entries and saves five defaults plus custom through the shared CAS controller',async t=>{
 const f=await setup(t);assert.equal(f.write.calls.length,0,'opening never saves defaults');
 assert.equal(f.state.pool.poolForm.seats.length,5);assert.equal(f.state.pool.poolForm.version,2);
 await f.press('Add preset');assert.equal(f.state.pool.poolForm.seats.length,6);
 await act(async()=>{f.field('Preset name').props.onChangeText('Ý kiến riêng');f.field('When to use').props.onChangeText('Phản biện giả định bằng ví dụ.');});
 assert.equal(f.state.pool.poolBuild.pool.options[5].displayName,'Ý kiến riêng');
 assert.equal(f.state.pool.poolBuild.pool.options[5].description,'Phản biện giả định bằng ví dụ.');
 await f.press('Save pool');assert.equal(f.write.calls.length,1);
 const input=f.write.calls[0].input;assert.equal(input.pool.version,2);assert.equal(input.expectedSha256,null);
 assert.equal(input.pool.options.length,6);assert.equal(input.pool.options[5].enabled,false);
 await act(async()=>f.write.calls[0].resolve({...result(input.pool),sha256:SHA}));
 assert.equal(f.state.pool.poolSaved,true);assert.equal(f.state.pool.poolDirty,false);
});

test('legacy UI stays v1 until explicit preview; backup/cancel/save preserve the source and fixed effort',async t=>{
 const old={version:1,policy:'Original',quotaFallback:{enabled:false,optionId:null},options:[{id:'old-custom',provider:'codex',model:'old',thinkingOptionId:'high',roles:['peer'],enabled:true,availability:'ready',suitableFor:['settled work'],avoidFor:[],notes:'PRIVATE'}]};
 const f=await setup(t,old);assert.equal(f.state.pool.poolForm.version,undefined);assert.equal(f.write.calls.length,0);
 await f.press('Preview preset migration');assert.equal(f.state.pool.poolForm.version,2);
 assert.deepEqual(f.state.pool.poolBuild.pool.options[0].effortPolicy,{kind:'fixed',thinkingOptionId:'high'});
 let copied;f.mod.clipboardState.copy=async text=>{copied=text;};
 await f.press('Copy original v1 backup');assert.deepEqual(JSON.parse(copied),old);
 await f.press('Cancel migration preview');assert.equal(f.state.pool.poolForm.version,undefined);assert.equal(f.state.pool.poolDirty,false);
 assert.equal(f.write.calls.length,0);
 await f.press('Preview preset migration');await f.press('Save conversion to v2');
 assert.equal(f.write.calls[0].input.expectedSha256,SHA);assert.equal(f.write.calls[0].input.pool.options[0].id,'old-custom');
 assert.equal(f.write.calls[0].input.pool.options[0].notes,'PRIVATE');
 await act(async()=>f.write.calls[0].resolve({...result(f.write.calls[0].input.pool),sha256:'b'.repeat(64)}));
 assert.equal(f.state.pool.poolData.pool.version,2);
});

test('v2 preset save failure and stale completion preserve draft/target isolation',async t=>{
 const f=await setup(t);await f.press('Add preset');await f.press('Save pool');
 await act(async()=>f.write.calls[0].reject(new Error('peer pool changed since it was read')));
 assert.equal(f.state.pool.poolError.cas,true);assert.equal(f.state.pool.poolForm.seats.length,6);assert.equal(f.state.pool.poolSaved,false);
 await f.press('Save pool');await f.update('/b');
 await act(async()=>f.read.calls[1].resolve(result(null)));
 assert.equal(f.state.pool.poolForm.seats.length,5);
 await act(async()=>f.write.calls[1].resolve({...result(f.write.calls[1].input.pool),sha256:SHA}));
 assert.equal(f.state.pool.poolForm.seats.length,5);assert.equal(f.state.pool.poolSaved,false);assert.equal(f.state.pool.poolError,null);
});

test('legacy detection recommends upgrading; confirmed defaults stay a draft and never inherit matching old IDs',async t=>{
 const old=oldPool(),f=await setup(t,old);
 assert.match(rendered(f),/Legacy Peer pool — upgrade recommended/);
 assert.match(rendered(f),/support is planned to end in a future release/);
 assert.equal(f.write.calls.length,0);
 await f.press('Use 5 default presets');
 assert.equal(f.state.pool.poolForm.version,undefined);assert.equal(f.state.pool.poolForm.seats.length,1);
 let copied;f.mod.clipboardState.copy=async text=>{copied=text;};
 await f.press('Copy saved pool backup');assert.deepEqual(JSON.parse(copied),old);
 await f.press('Keep current draft');assert.equal(f.state.pool.poolDefaultsConfirm,false);
 assert.equal(f.state.pool.poolDirty,false);assert.equal(f.write.calls.length,0);
 await f.press('Use 5 default presets');await f.press('Replace draft with 5 presets');
 const p=f.state.pool.poolBuild.pool;
 assert.equal(p.version,2);assert.equal(p.policy,old.policy);assert.deepEqual(p.extension,old.extension);
 assert.deepEqual(p.options.map(o=>o.displayName),['Fast','Balanced','Advanced','Frontier','Cross-provider']);
 assert.ok(p.options.every(o=>!o.enabled && o.provider==='' && o.model==='' && o.notes==='' && !o.extension));
 assert.ok(p.options.every(o=>o.roles.length===1 && o.roles[0]==='peer' && o.availability==='ready'));
 assert.ok(p.options.every(o=>o.effortPolicy.kind==='select' && !o.thinkingOptionId));
 assert.equal(p.options[4].runtimeRule,'different-model-provider');
 assert.deepEqual(p.quotaFallback,{enabled:false,optionId:null});
 assert.equal(f.state.pool.poolDefaultsDraft,true);assert.equal(f.write.calls.length,0);
 assert.match(rendered(f),/Legacy Peer pool — upgrade recommended/,'saved v1 remains deprecated while only the draft is v2');
 assert.doesNotMatch(rendered(f),/IDs, settings, fallback and private notes are preserved/,'replacement copy must not claim old entries are preserved');
 await f.press('Cancel migration preview');
 assert.equal(f.state.pool.poolForm.version,undefined);assert.equal(f.state.pool.poolForm.seats.length,1);
 assert.equal(f.state.pool.poolDefaultsDraft,false);assert.equal(f.write.calls.length,0);
});

test('default replacement saves only explicitly, preserves CAS failure, and retires the legacy notice after successful v2 save',async t=>{
 const f=await setup(t,oldPool());
 await f.press('Use 5 default presets');await f.press('Replace draft with 5 presets');
 await act(async()=>f.state.pool.setSeatFamily(0)('codex'));
 await act(async()=>f.state.pool.setSeatField(0,'model')('chosen-model'));
 await act(async()=>f.state.pool.setSeatEnabled(0)(true));
 await f.press('Save conversion to v2');
 assert.equal(f.write.calls[0].input.expectedSha256,SHA);
 assert.equal(f.write.calls[0].input.pool.options[0].model,'chosen-model');
 await act(async()=>f.write.calls[0].reject(new Error('peer pool changed since it was read')));
 assert.equal(f.state.pool.poolError.cas,true);assert.equal(f.state.pool.poolDefaultsDraft,true);
 assert.match(rendered(f),/Legacy Peer pool — upgrade recommended/);
 await f.press('Save conversion to v2');
 await act(async()=>f.write.calls[1].resolve({...result(f.write.calls[1].input.pool),sha256:'b'.repeat(64)}));
 assert.equal(f.state.pool.poolDefaultsDraft,false);assert.equal(f.state.pool.poolDirty,false);
 assert.doesNotMatch(rendered(f),/Legacy Peer pool — upgrade recommended/);
});

test('v2 pools can replace a dirty draft with defaults; saved empty pools never reseed automatically',async t=>{
 const v2={version:2,policy:'Intentional empty',quotaFallback:{enabled:false,optionId:null},options:[]};
 const f=await setup(t,v2);assert.equal(f.state.pool.poolForm.seats.length,0);
 assert.doesNotMatch(rendered(f),/Legacy Peer pool — upgrade recommended/);
 await f.press('Add preset');
 await act(async()=>f.field('Preset name').props.onChangeText('Unsaved custom'));
 await f.press('Use 5 default presets');await f.press('Keep current draft');
 assert.equal(f.state.pool.poolForm.seats[0].displayName,'Unsaved custom');
 await f.press('Use 5 default presets');await f.press('Replace draft with 5 presets');
 assert.equal(f.state.pool.poolForm.seats.length,5);assert.equal(f.state.pool.poolForm.policy,'Intentional empty');
 assert.equal(f.write.calls.length,0);
 await f.press('Reload');await f.press('Discard changes and Reload');
 await act(async()=>f.read.calls[1].resolve(result(v2)));
 assert.equal(f.state.pool.poolForm.seats.length,0);assert.equal(f.state.pool.poolDefaultsDraft,false);
});

test('replacement confirmations clear on edits, reload and target changes; failed reads keep replacement locked',async t=>{
 const f=await setup(t,oldPool());await f.press('Use 5 default presets');
 await act(async()=>f.state.pool.updatePool(form=>({...form,policy:'Edited policy'})));
 assert.equal(f.state.pool.poolDefaultsConfirm,false);
 await f.press('Use 5 default presets');await f.update('/b');
 assert.equal(f.state.pool.poolDefaultsConfirm,false);assert.equal(f.state.pool.poolDefaultsDraft,false);
 await act(async()=>{f.state.pool.requestDefaultPresets();f.state.pool.useDefaultPresets();});
 assert.equal(f.state.pool.poolDefaultsConfirm,false);
 await act(async()=>f.read.calls[1].reject(new Error('read unavailable')));
 assert.equal(f.state.pool.poolLocked,true);
 await act(async()=>f.state.pool.requestDefaultPresets());assert.equal(f.state.pool.poolDefaultsConfirm,false);
 assert.equal(f.write.calls.length,0);
 await f.update('/a');await act(async()=>f.read.calls[2].resolve(result(oldPool())));
 await f.press('Use 5 default presets');await f.press('Reload');
 await act(async()=>f.read.calls[3].resolve(result(oldPool())));
 assert.equal(f.state.pool.poolDefaultsConfirm,false);assert.equal(f.state.pool.poolDefaultsDraft,false);
 assert.equal(f.state.pool.poolForm.seats.length,1);assert.equal(f.write.calls.length,0);
});
