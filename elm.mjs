import {BaseSensorSession} from './sensor-session.mjs';
export {SENSOR_DEFINITIONS,parseObdFrames,supportedPids,decodeSensor} from './elm-protocol.mjs';
import { EventEmitter } from 'node:events';
import { Socket, isIPv4 } from 'node:net';
import { describeSerialPorts } from './ports.mjs';

// Protocol references: ELM327 v2.3 datasheet (ELM327DSL, Elm Electronics),
// https://serialport.io/docs/api-stream/ and CSS Electronics' J1979 PID table.
// This module intentionally exposes no arbitrary command or calibration-write API.
export const SERIALPORT_VERSION = '13.0.0';
const BAUD_RATES = new Set([9600, 19200, 38400, 57600, 115200]);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const loadSerialPort = async () => (await import('serialport')).SerialPort;

export async function availability() {
  try { await loadSerialPort(); return { available: true, transport: 'serialport', version: SERIALPORT_VERSION }; }
  catch { return { available: false, transport: 'serialport', version: SERIALPORT_VERSION, reason: 'USB and Bluetooth serial support is unavailable. Install the optional serialport 13.0.0 dependency and restart the app.' }; }
}

export async function listSerialPorts() { const SerialPort = await loadSerialPort(); return describeSerialPorts(await SerialPort.list()); }

function validateWifiAddress(host, port) {
  assert(typeof host === 'string' && isIPv4(host), 'Enter the adapter’s private IPv4 address. Hostnames and IPv6 are not supported.');
  const [a, b] = host.split('.').map(Number);
  assert(a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168, 'Wi-Fi adapters must use an RFC1918 private address (10.x.x.x, 172.16–31.x.x or 192.168.x.x).');
  assert(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Wi-Fi TCP port must be an integer from 1024 to 65535.');
}

// A TCP stream presents the same small transport contract as SerialPort. Creating
// this object performs no network activity; only the user-requested open() connects.
class WifiElmPort extends EventEmitter {
  #host;
  #port;
  #createSocket;
  #socket = null;
  #openCallback = null;
  #closed = false;
  isOpen = false;
  constructor(host, port, createSocket) { super(); this.#host = host; this.#port = port; this.#createSocket = createSocket; }
  #finishOpen(error) { const callback = this.#openCallback; this.#openCallback = null; callback?.(error); }
  open(callback) {
    this.#openCallback = callback;
    try {
      const socket = this.#createSocket(); this.#socket = socket;
      socket.on('data', data => { if (!this.#closed) this.emit('data', data); });
      socket.on('error', error => { this.#finishOpen(error); if (!this.#closed) this.emit('error', error); });
      socket.on('close', () => { this.isOpen = false; this.#finishOpen(new Error('Wi-Fi adapter connection closed.')); this.emit('close'); });
      socket.on('end', () => { if (!this.#closed) this.emit('error', new Error('Wi-Fi adapter ended its TCP stream.')); socket.destroy(); });
      socket.once('connect', () => {
        if (this.#closed || socket.destroyed) { socket.destroy(); return; }
        this.isOpen = true; socket.setNoDelay?.(true); this.#finishOpen(null);
      });
      // Numeric private IPv4, explicit TCP port, and fixed IPv4 family: no DNS or scanning.
      socket.connect({ host: this.#host, port: this.#port, family: 4 });
    } catch (error) { this.#finishOpen(error); }
  }
  write(data, callback) { assert(this.isOpen && !this.#closed, 'Wi-Fi adapter is not connected.'); return this.#socket.write(data, callback); }
  cancelOpen() { this.#closed = true; this.#finishOpen(new Error('Sensor connection was cancelled.')); this.#socket?.destroy(); }
  close(callback) {
    this.#closed = true; this.isOpen = false;
    this.#finishOpen(new Error('Sensor connection was cancelled.'));
    if (!this.#socket || this.#socket.destroyed) { callback?.(null); return; }
    this.#socket.once('close', () => callback?.(null)); this.#socket.destroy();
  }
  destroy() { this.#closed = true; this.isOpen = false; this.#finishOpen(new Error('Sensor connection was cancelled.')); this.#socket?.destroy(); }
}

export class SensorSession extends BaseSensorSession {
  constructor({loadDriver=loadSerialPort,createSocket=()=>new Socket(),...timing}={}){
    assert(typeof loadDriver==='function'&&typeof createSocket==='function','Adapter factories must be functions.');
    super({...timing,validateConnection(options){
      assert(['serial','bluetooth','wifi'].includes(options.transport),'Choose USB serial, Bluetooth Classic or Wi-Fi TCP transport.');
      if(options.transport==='wifi')validateWifiAddress(options.host,options.port);
      else{assert(typeof options.path==='string'&&options.path.length>0&&options.path.length<512,'Choose an enumerated serial port.');assert(BAUD_RATES.has(options.baudRate),'Choose a supported adapter baud rate.');}
    },createPort(options,current){
      if(options.transport==='wifi')return new WifiElmPort(options.host,options.port,createSocket);
      return (async()=>{
      const Driver=await loadDriver();assert(current(),'Sensor connection was cancelled.');
      const ports=describeSerialPorts(await Driver.list());assert(current(),'Sensor connection was cancelled.');
      assert(ports.some(port=>port.path===options.path),options.transport==='bluetooth'?'The paired Bluetooth COM port is no longer available. Check Windows pairing and refresh the port list.':'The selected serial port is no longer available. Refresh the port list.');
      return new Driver({path:options.path,baudRate:options.baudRate,autoOpen:false,dataBits:8,stopBits:1,parity:'none',rtscts:false});
      })();
    }});
  }
}
