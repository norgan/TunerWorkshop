import {randomUUID} from 'node:crypto';
import {isLocalPage} from './policy.mjs';

export function installBluetoothPicker({contents,session,ipcMain,origin,timeoutMs=60000}){
  let selection=null,pairing=null;
  const send=(channel,data)=>{if(!contents.isDestroyed())contents.send(channel,data);};
  const trusted=event=>event.sender===contents&&event.senderFrame===contents.mainFrame&&isLocalPage(contents.getURL(),origin);
  function finishSelection(id=''){
    if(!selection)return;const pending=selection;selection=null;clearTimeout(pending.timer);
    pending.callback(id);send('workshop:ble-picker-closed',{});
  }
  function finishPairing(response={confirmed:false}){
    if(!pairing)return;const pending=pairing;pairing=null;clearTimeout(pending.timer);
    pending.callback(response);send('workshop:ble-pairing-closed',{});
  }
  const select=(event,devices,callback)=>{
    event.preventDefault();
    if(!isLocalPage(contents.getURL(),origin)){callback('');return;}
    if(!selection){selection={id:randomUUID(),callback,devices:[],timer:setTimeout(()=>finishSelection(),timeoutMs)};}
    else selection.callback=callback;
    selection.devices=devices.filter(device=>typeof device.deviceId==='string'&&device.deviceId.length<=512).slice(0,100).map(device=>({deviceId:device.deviceId,deviceName:String(device.deviceName||'Unnamed BLE device').slice(0,100)}));
    send('workshop:ble-devices',{requestId:selection.id,devices:selection.devices});
  };
  const reply=(event,result)=>{
    if(!trusted(event)||!selection||result?.requestId!==selection.id)return;
    if(result.deviceId===''||selection.devices.some(device=>device.deviceId===result.deviceId))finishSelection(result.deviceId);
  };
  const cancel=event=>{if(trusted(event)){finishSelection();finishPairing();}};
  const pairReply=(event,result)=>{
    if(!trusted(event)||!pairing||result?.requestId!==pairing.id||typeof result.confirmed!=='boolean')return;
    if(!result.confirmed){finishPairing();return;}
    if(pairing.kind==='providePin'&&(typeof result.pin!=='string'||!/^[\x20-\x7e]{1,16}$/.test(result.pin)))return;
    finishPairing({confirmed:true,...(pairing.kind==='providePin'?{pin:result.pin}:{})});
  };
  const pair=(details,callback)=>{
    finishPairing();
    if(!isLocalPage(contents.getURL(),origin)||!['confirm','confirmPin','providePin'].includes(details.pairingKind)){callback({confirmed:false});return;}
    pairing={id:randomUUID(),callback,kind:details.pairingKind,timer:setTimeout(()=>finishPairing(),timeoutMs)};
    send('workshop:ble-pairing',{requestId:pairing.id,kind:pairing.kind,pin:pairing.kind==='confirmPin'?String(details.pin||'').slice(0,16):''});
  };
  const stop=()=>{finishSelection();finishPairing();};
  contents.on('select-bluetooth-device',select);
  contents.on('did-start-navigation',stop);
  session.setBluetoothPairingHandler(pair);
  ipcMain.on('workshop:ble-select',reply);ipcMain.on('workshop:ble-cancel',cancel);ipcMain.on('workshop:ble-pairing-reply',pairReply);
  const dispose=()=>{stop();ipcMain.off('workshop:ble-select',reply);ipcMain.off('workshop:ble-cancel',cancel);ipcMain.off('workshop:ble-pairing-reply',pairReply);contents.off('select-bluetooth-device',select);contents.off('did-start-navigation',stop);session.setBluetoothPairingHandler(null);};
  contents.once('destroyed',dispose);
  return {dispose};
}
