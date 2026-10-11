import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { act, deferredRpc, loadHooks } from './helpers/client-hooks-harness.mjs';

const colors=Object.fromEntries(['foreground','foregroundMuted','statusDanger','statusWarning','statusSuccess','surface0','surface1','surface2','border','accent','accentForeground'].map(k=>[k,'#123456']));
const SHA='a'.repeat(64);
const result=pool=>({schemaVersion:1,pool,sha256:pool?SHA:null,error:null,legacy:null,legacyError:null});
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
