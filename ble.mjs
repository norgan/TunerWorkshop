import {Emitter} from './sensor-events.mjs';
import {BaseSensorSession} from './sensor-session.mjs';

export function bluetoothUuid(value){
  if(typeof value!=='string')throw new Error('Enter a Bluetooth service or characteristic UUID.');
  const id=value.trim().toLowerCase();
  if(/^[a-f0-9]{4}$/.test(id))return `0000${id}-0000-1000-8000-00805f9b34fb`;
  if(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))return id;
  throw new Error('Use a four-digit UUID such as FFF0 or a full Bluetooth UUID.');
}
// Candidate UART layouts, not claims of adapter compatibility. Discovery checks
// actual notification/write properties and ELM identification before polling.
export const BLE_PROFILES=Object.freeze([
  {service:'ffe0',write:'ffe1',notify:'ffe1'},
  {service:'fff0',write:'fff2',notify:'fff1'},
  {service:'6e400001-b5a3-f393-e0a9-e50e24dcca9e',write:'6e400002-b5a3-f393-e0a9-e50e24dcca9e',notify:'6e400003-b5a3-f393-e0a9-e50e24dcca9e'},
].map(profile=>Object.freeze(Object.fromEntries(Object.entries(profile).map(([key,value])=>[key,bluetoothUuid(value)])))));
function profilesFor(options){
  if(options.profile===undefined||options.profile==='auto')return BLE_PROFILES;
  if(options.profile!=='custom')throw new Error('Choose automatic or custom BLE services.');
  return [{service:bluetoothUuid(options.service),write:bluetoothUuid(options.write),notify:bluetoothUuid(options.notify)}];
}
const canWrite=characteristic=>characteristic?.properties?.write||characteristic?.properties?.writeWithoutResponse;
const canNotify=characteristic=>characteristic?.properties?.notify||characteristic?.properties?.indicate;

class BleElmPort extends Emitter {
  #bluetooth;#profiles;#custom;#cancelPicker;#device;#write;#notify;#closed=false;#opening;#notifyListener;#disconnectListener;
  #writeQueue=Promise.resolve();
  isOpen=false;deviceName='BLE adapter';
  constructor(bluetooth,options,cancelPicker){super();this.#bluetooth=bluetooth;this.#profiles=profilesFor(options);this.#custom=options.profile==='custom';this.#cancelPicker=cancelPicker;}
  #check(){if(this.#closed)throw new Error('BLE connection was cancelled.');}
  #finish(error){const callback=this.#opening;this.#opening=null;callback?.(error);}
  open(callback){
    this.#opening=callback;
    // Called directly from the Connect button so requestDevice retains the gesture.
    void this.#open().then(()=>this.#finish(null),error=>{
      this.#cleanup();this.#finish(new Error(error?.name==='NotFoundError'?'No BLE adapter selected. Turn on the adapter and choose it from the device list.':error?.message||'Unable to connect to the BLE adapter.'));
    });
  }
  async #open(){
    const device=await this.#bluetooth.requestDevice({acceptAllDevices:true,optionalServices:this.#profiles.map(p=>p.service)});
    this.#device=device;this.#check();
    this.deviceName=String(device.name||'Unnamed BLE adapter').slice(0,100);
    if(!device.gatt)throw new Error('This device does not provide a BLE GATT connection.');
    this.#disconnectListener=()=>{if(!this.#closed){this.isOpen=false;this.emit('error',new Error('BLE adapter disconnected. Reconnect it to resume readings.'));}};
    device.addEventListener('gattserverdisconnected',this.#disconnectListener);
    const server=await device.gatt.connect();this.#check();
    let found=false;
    for(const profile of this.#profiles){
      let service;
      try{service=await server.getPrimaryService(profile.service);}catch(error){this.#check();if(error?.name==='NetworkError')throw error;continue;}
      this.#check();const characteristics=await service.getCharacteristics();this.#check();
      let write=characteristics.find(c=>c.uuid.toLowerCase()===profile.write),notify=characteristics.find(c=>c.uuid.toLowerCase()===profile.notify);
      if(!this.#custom&&(!canWrite(write)||!canNotify(notify))){
        const writers=characteristics.filter(canWrite),readers=characteristics.filter(canNotify);
        if(writers.length===1&&readers.length===1){[write]=writers;[notify]=readers;}
      }
      if(!canWrite(write)||!canNotify(notify))continue;
      this.#write=write;this.#notify=notify;found=true;break;
    }
    if(!found)throw new Error('No supported BLE serial service was found. Choose Custom services and enter the service, write and notification UUIDs from the adapter supplier.');
    this.#notifyListener=event=>{
      if(!this.isOpen||this.#closed)return;
      const value=event.target.value;
      if(value?.buffer)this.emit('data',new Uint8Array(value.buffer,value.byteOffset,value.byteLength));
    };
    this.#notify.addEventListener('characteristicvaluechanged',this.#notifyListener);
    await this.#notify.startNotifications();this.#check();this.isOpen=true;
  }
  write(text,callback){
    if(!this.isOpen||this.#closed){callback?.(new Error('BLE adapter is not connected.'));return;}
    const bytes=new TextEncoder().encode(text);
    // The shared session only submits short, allowlisted ELM read/setup commands.
    const method=this.#write.properties.write?'writeValueWithResponse':'writeValueWithoutResponse';
    const writing=this.#writeQueue.then(()=>{this.#check();return this.#write[method](bytes);});
    this.#writeQueue=writing.catch(()=>{});
    writing.then(()=>callback?.(null),error=>callback?.(error));
  }
  #cleanup(){
    this.isOpen=false;
    if(this.#notify&&this.#notifyListener)this.#notify.removeEventListener('characteristicvaluechanged',this.#notifyListener);
    if(this.#device&&this.#disconnectListener)this.#device.removeEventListener('gattserverdisconnected',this.#disconnectListener);
    if(this.#device?.gatt?.connected)this.#device.gatt.disconnect();
  }
  cancelOpen(){this.#closed=true;this.#cancelPicker?.();this.#cleanup();this.#finish(new Error('BLE connection was cancelled.'));}
  close(callback){this.#closed=true;this.#cleanup();this.#finish(new Error('BLE connection was cancelled.'));callback?.(null);}
  destroy(){this.cancelOpen();}
}
export class BleSensorSession extends BaseSensorSession {
  constructor({bluetooth=globalThis.navigator?.bluetooth,cancelPicker,...timing}={}){
    super({...timing,validateConnection(options){
      if(options.transport!=='ble')throw new Error('Select Bluetooth Low Energy.');
      if(!bluetooth?.requestDevice)throw new Error('BLE is unavailable here. Use the Windows desktop app with Bluetooth enabled.');
      profilesFor(options);
    },createPort:options=>new BleElmPort(bluetooth,options,cancelPicker)});
  }
}
