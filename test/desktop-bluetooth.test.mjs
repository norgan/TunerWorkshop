import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {installBluetoothPicker} from '../desktop/bluetooth.mjs';
function fixture(timeoutMs=1000){
  const contents=new EventEmitter(),ipcMain=new EventEmitter(),messages=[],selected=[],paired=[],frame={};let pairingHandler;
  Object.assign(contents,{mainFrame:frame,isDestroyed:()=>false,getURL:()=> 'http://127.0.0.1:12345/',send:(channel,data)=>messages.push({channel,data})});
  const session={setBluetoothPairingHandler:handler=>{pairingHandler=handler;}};
  const installed=installBluetoothPicker({contents,ipcMain,session,origin:'http://127.0.0.1:12345',timeoutMs});
  const event={sender:contents,senderFrame:frame};
  return {contents,ipcMain,messages,selected,paired,event,dispose:installed.dispose,select(){contents.emit('select-bluetooth-device',{preventDefault(){}},[{deviceId:'test-device',deviceName:'Test ELM'}],id=>selected.push(id));return messages.at(-1).data;},pair(kind){pairingHandler({pairingKind:kind,pin:'123456'},response=>paired.push(response));return messages.at(-1).data;}};
}
test('desktop BLE picker requires an explicit current-device choice from its own main frame',()=>{
  const f=fixture();try{
    const request=f.select();assert.equal(f.selected.length,0);
    for(const [event,deviceId,requestId]of [[{...f.event,sender:{}},'test-device',request.requestId],[{...f.event,senderFrame:{}},'test-device',request.requestId],[f.event,'unknown-device',request.requestId],[f.event,'test-device','stale']])f.ipcMain.emit('workshop:ble-select',event,{deviceId,requestId});
    assert.equal(f.selected.length,0);
    f.ipcMain.emit('workshop:ble-select',f.event,{requestId:request.requestId,deviceId:'test-device'});assert.deepEqual(f.selected,['test-device']);
  }finally{f.dispose();}
});
test('desktop BLE cancellation and expiry release the pending native picker',async()=>{
  const f=fixture(15);try{f.select();f.ipcMain.emit('workshop:ble-cancel',f.event);assert.deepEqual(f.selected,['']);f.select();await new Promise(resolve=>setTimeout(resolve,30));assert.deepEqual(f.selected,['','']);}finally{f.dispose();}
});
test('desktop BLE PIN requests do not approve pairing until a valid user response',()=>{
  const f=fixture();try{
    const request=f.pair('providePin');assert.equal(f.paired.length,0);
    f.ipcMain.emit('workshop:ble-pairing-reply',f.event,{requestId:request.requestId,confirmed:true,pin:''});assert.equal(f.paired.length,0);
    f.ipcMain.emit('workshop:ble-pairing-reply',f.event,{requestId:request.requestId,confirmed:true,pin:'1234'});assert.deepEqual(f.paired,[{confirmed:true,pin:'1234'}]);
    f.pair('confirmPin');f.ipcMain.emit('workshop:ble-cancel',f.event);assert.deepEqual(f.paired.at(-1),{confirmed:false});
  }finally{f.dispose();}
});
