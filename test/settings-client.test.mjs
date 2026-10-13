import test from 'node:test';
import assert from 'node:assert/strict';
import {createSettingsController} from '../settings-client.mjs';
import {SETTINGS_DEFAULTS} from '../settings-schema.mjs';
import {isChatSubmitKey} from '../chat-keyboard.mjs';

test('simultaneous preferences merge with latest saved state and survive a new client',async()=>{
  let disk=structuredClone(SETTINGS_DEFAULTS);
  const io={read:async()=>disk,write:async next=>{await new Promise(r=>setTimeout(r,5));disk=next;return disk;}};
  const client=createSettingsController(io);
  await Promise.all([client.save({preferredModel:'synthetic-model'}),client.save({sendOnEnter:false}),client.save({chatTextSize:18})]);
  const restarted=createSettingsController(io);await restarted.ready;
  assert.equal(restarted.get().preferredModel,'synthetic-model');assert.equal(restarted.get().sendOnEnter,false);assert.equal(restarted.get().chatTextSize,18);
  const copy=client.get();copy.connection.host='changed';assert.equal(client.get().connection.host,'');
});
test('storage failure preserves applied settings, reports an error, and permits retry',async()=>{
  let fail=true;
  const client=createSettingsController({read:async()=>{throw new Error('private path');},write:async next=>{if(fail)throw new Error('private path');return next;}});
  await client.ready;assert.match(client.error(),/could not be loaded/);
  await assert.rejects(client.save({sendOnEnter:false}),/could not be saved/);assert.equal(client.get().sendOnEnter,true);
  fail=false;await client.save({sendOnEnter:false});assert.equal(client.get().sendOnEnter,false);assert.equal(client.error(),'');
});
test('invalid updates and disabled remembering cannot persist hidden preferences',async()=>{
  let writes=0;
  const client=createSettingsController({read:()=>SETTINGS_DEFAULTS,write:next=>{writes++;return next;}});
  await assert.rejects(client.save({unexpected:true}));assert.equal(writes,0);
  await client.save({preferredModel:'synthetic-model',rememberModel:false});assert.equal(client.get().preferredModel,'');
});
test('chat shortcuts distinguish newline, submit, composition and held keys',()=>{
  const event={key:'Enter'};
  assert.equal(isChatSubmitKey(event,true),true);assert.equal(isChatSubmitKey(event,false),false);
  for(const key of ['ctrlKey','metaKey'])assert.equal(isChatSubmitKey({...event,[key]:true},false),true);
  for(const key of ['shiftKey','altKey','isComposing','repeat'])assert.equal(isChatSubmitKey({...event,[key]:true},true),false);
  assert.equal(isChatSubmitKey({...event,keyCode:229},true),false);assert.equal(isChatSubmitKey({key:'x'},true),false);
});
