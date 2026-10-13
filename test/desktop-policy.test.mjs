import test from 'node:test';
import assert from 'node:assert/strict';
import {allowExternalLink,isLocalPage} from '../desktop/policy.mjs';
test('desktop opens only documented account sites in the external browser',()=>{
  for(const value of ['https://auth.openai.com/oauth/authorize?client_id=example','https://chatgpt.com/settings/usage'])assert.equal(allowExternalLink(value),true);
  for(const value of ['file:///C:/test.exe','http://auth.openai.com/','https://auth.openai.com.example.org/','https://auth.openai.com@evil.example/','https://user:pass@auth.openai.com/','https://auth.openai.com:1234/','https://chatgpt.com/other','javascript:alert(1)'])assert.equal(allowExternalLink(value),false);
});
test('desktop navigation remains within the actual private app origin',()=>{
  assert.equal(isLocalPage('http://127.0.0.1:12345/#test','http://127.0.0.1:12345'),true);
  for(const value of ['http://127.0.0.1:12346/','http://127.0.0.1:12345/api/status','https://example.org/'])assert.equal(isLocalPage(value,'http://127.0.0.1:12345'),false);
});

test('desktop settings link permits only the fixed Bluetooth settings page',()=>{
  assert.equal(allowExternalLink('ms-settings:bluetooth'),true);
  for(const url of ['ms-settings:','ms-settings:appsfeatures','ms-settings:bluetooth?anything','ms-settings:bluetooth#anything','ms-settings://bluetooth'])assert.equal(allowExternalLink(url),false);
});
