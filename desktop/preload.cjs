const {contextBridge,ipcRenderer}=require('electron');
const pending=new Map();
ipcRenderer.on('workshop:download-finished',(_event,result)=>{
  if(!result||typeof result.url!=='string')return;
  const entry=pending.get(result.url);if(!entry)return;
  pending.delete(result.url);clearTimeout(entry.timer);
  entry.resolve(result.state==='completed');
});
const subscribe=(channel,callback)=>{
  if(typeof callback!=='function')return()=>{};
  const listener=(_event,value)=>callback(value);ipcRenderer.on(channel,listener);
  return()=>ipcRenderer.removeListener(channel,listener);
};
// Fixed preference, download and Bluetooth operations; no filesystem/command API.
contextBridge.exposeInMainWorld('workshopDesktop',Object.freeze({
  readSettings:()=>ipcRenderer.invoke('workshop:settings-read'),
  saveSettings:settings=>ipcRenderer.invoke('workshop:settings-save',settings),
  onOpenSettings:callback=>subscribe('workshop:open-settings',callback),
  setServiceActive:active=>ipcRenderer.invoke('workshop:service-active',active),
  onServiceCloseBlocked:callback=>subscribe('workshop:service-close-blocked',callback),
  onBluetoothDevices:callback=>subscribe('workshop:ble-devices',callback),
  onBluetoothPickerClosed:callback=>subscribe('workshop:ble-picker-closed',callback),
  onBluetoothPairing:callback=>subscribe('workshop:ble-pairing',callback),
  onBluetoothPairingClosed:callback=>subscribe('workshop:ble-pairing-closed',callback),
  selectBluetoothDevice:result=>ipcRenderer.send('workshop:ble-select',result),
  cancelBluetoothRequest:()=>ipcRenderer.send('workshop:ble-cancel'),
  respondBluetoothPairing:result=>ipcRenderer.send('workshop:ble-pairing-reply',result),
  waitForDownload(url){
    if(typeof url!=='string'||!url.startsWith('blob:'+location.origin+'/')||pending.has(url)||pending.size>=64)return Promise.resolve(false);
    return new Promise(resolve=>{
      const timer=setTimeout(()=>{pending.delete(url);resolve(false);},30*60*1000);
      pending.set(url,{resolve,timer});
    });
  }
}));
