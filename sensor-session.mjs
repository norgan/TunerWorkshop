import {Emitter} from './sensor-events.mjs';
import {SENSOR_DEFINITIONS,INITIALIZE,ALLOWED,cleanLines,adapterError,parseProtocolNumber,parseObdFrames,supportedPids,decodeSensor} from './elm-protocol.mjs';
import {FIAT_8GMK_DEFINITIONS,getDiagnosticProfile,selectProfileChannels,decodeFiatParameter} from './fiat-8gmk.mjs';
import {decodeElmCanReplies,decodeReadDataEnvelope} from './can-diagnostics.mjs';
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
// Standard ELM protocol 7 is ISO15765 29-bit / 500k. TP with memory off
// selects it without saving a default. Variable DLC and timing match the
// recovered CCAN29 setup; fixed DLC is retried only after no session data.
const FIAT_SETUP=Object.freeze([...INITIALIZE.slice(0,-1),'ATV1','ATTP7','ATCP18','ATCRA18DAF110','ATSHDA10F1','ATCFC1','ATAT1','ATST99']);
const FIAT_IDENTIFIERS=Object.freeze(['22F1A5','22F192','22F194']);
const FIAT_ALLOWED=new Set([...FIAT_SETUP,'ATV0','1003','1092','3E00',...FIAT_IDENTIFIERS,...FIAT_8GMK_DEFINITIONS.map(d=>d.request)]);

function terminalAcknowledgement(replies,service){
  let reply=null;
  for(const candidate of replies){
    assert(!reply,'The ECU returned conflicting diagnostic acknowledgements.');
    if(candidate[0]===0x7f){
      assert(candidate.length===3&&candidate[1]===service,'Negative acknowledgement belongs to a different request.');
      if(candidate[2]===0x78)continue;
    }
    reply=candidate;
  }
  // Pending alone is not NO DATA and must not trigger the fixed-DLC retry.
  return {reply,noData:replies.length===0};
}

export class BaseSensorSession extends Emitter {
  #createPort;
  #validateConnection;
  #port = null;
  #pending = null;
  #buffer = '';
  #generation = 0;
  #pollTimer = null;
  #resumePoll = null;
  #timeout;
  #searchTimeout;
  #bluetoothOpenTimeout;
  #bleOpenTimeout;
  #interval;
  #allowed = ALLOWED;
  #lastKeepalive = 0;
  #state = { status: 'disconnected', transport: 'serial', path: null, baudRate: null, host: null, port: null, protocol: null, ecu: null, supportedSensors: [], values: {}, sampleTimes: {}, lastSampleAt: null, error: null, readOnly: true };

  constructor({ createPort, validateConnection, commandTimeoutMs = 4000, searchTimeoutMs = 30000, pollIntervalMs = 150, bluetoothOpenTimeoutMs = 15000, bleOpenTimeoutMs = 60000 } = {}) {
    super();
    assert(typeof createPort === 'function' && typeof validateConnection === 'function', 'A validated adapter factory is required.');
    for (const value of [commandTimeoutMs, searchTimeoutMs, pollIntervalMs, bluetoothOpenTimeoutMs, bleOpenTimeoutMs]) assert(Number.isFinite(value) && value >= 1 && value <= 60000, 'Invalid serial timing.');
    this.#bluetoothOpenTimeout=bluetoothOpenTimeoutMs;this.#bleOpenTimeout=bleOpenTimeoutMs;
    this.#createPort=createPort;this.#validateConnection=validateConnection; this.#timeout = commandTimeoutMs; this.#searchTimeout = searchTimeoutMs; this.#interval = Math.max(100, pollIntervalMs);
  }
  snapshot() { return structuredClone(this.#state); }
  #status(status, error = null) { this.#state.status = status; this.#state.error = error; this.emit('status', this.snapshot()); }
  #check(generation) { assert(generation === this.#generation && this.#port, 'Sensor connection was cancelled.'); }

  async connect(options = {}) {
    const {transport='serial',path,baudRate=38400,host,port:tcpPort=35000,profileId='generic-obd'}=options;
    assert(['disconnected', 'error'].includes(this.#state.status) && !this.#port, 'A sensor connection is already active.');
    const selected=selectProfileChannels(profileId,options.channels),manufacturer=profileId==='fiat-8gmk';
    this.#validateConnection({...options,transport,baudRate,port:tcpPort});
    this.#allowed=manufacturer?FIAT_ALLOWED:ALLOWED;
    const generation = ++this.#generation;
    this.#state = { status: 'connecting', transport, path: ['serial','bluetooth'].includes(transport) ? path : null, baudRate: ['serial','bluetooth'].includes(transport) ? baudRate : null, host: transport === 'wifi' ? host : null, port: transport === 'wifi' ? tcpPort : null, protocol: null, ecu: null, supportedSensors: [], values: {}, sampleTimes: {}, lastSampleAt: null, error: null, readOnly: true };
    Object.assign(this.#state,{profileId,selectedSensors:selected.map(d=>d.key),channels:selected,quality:{},parameterErrors:{},sessionId:globalThis.crypto.randomUUID()});
    this.#status('connecting');
    try {
      assert(generation === this.#generation, 'Sensor connection was cancelled.');
      const creating=this.#createPort({...options,transport,path,baudRate,host,port:tcpPort},()=>generation===this.#generation);
      const port=creating?.then?await creating:creating;
      assert(generation===this.#generation,'Sensor connection was cancelled.');
      this.#port = port; this.#buffer = '';
      port.on('data', data => { if (this.#port === port) this.#receive(data); });
      port.on('error', error => { if (this.#port === port) this.#fail(error); });
      port.on('close', () => { if (this.#port === port) this.#fail(new Error('ELM327 adapter disconnected.')); });
      await this.#open(port, generation);
      if(transport==='ble')this.#state.deviceName=port.deviceName||'BLE adapter';
      this.#check(generation);
      for (const command of manufacturer?FIAT_SETUP:INITIALIZE) {
        const response = await this.#command(command, command === 'ATZ' ? Math.max(5000, this.#timeout) : this.#timeout);
        this.#check(generation);
        const lines = cleanLines(response, command); adapterError(lines);
        if (command === 'ATZ') assert(lines.some(line => /ELM327|STN[0-9]|OBDLINK/.test(line)), 'Adapter did not identify as ELM327-compatible.');
        else assert(lines.includes('OK'), `Adapter did not accept required setup ${command}.`);
      }
      if(manufacturer){await this.#connectFiat(generation,selected);return this.snapshot();}
      const firstResponse = await this.#command('0100', this.#searchTimeout);
      this.#check(generation);
      const discoveryLines = cleanLines(firstResponse, '0100');
      const noVehicle = discoveryLines.find(line => /^(?:UNABLE TO CONNECT|NO DATA)$/.test(line));
      if (noVehicle) throw new Error(`No vehicle connection detected. Connect the adapter to the car and switch the ignition on, then retry. Adapter reported: ${noVehicle}.`);
      adapterError(discoveryLines);
      const protocol = parseProtocolNumber(await this.#command('ATDPN')); this.#state.protocol = protocol;
      const frames = parseObdFrames(firstResponse, '00', protocol);
      // Prefer an RPM-capable ECU and retain that same source throughout the session.
      frames.sort((a, b) => Number(supportedPids(b.data).includes(12)) - Number(supportedPids(a.data).includes(12)) || a.ecu.localeCompare(b.ecu));
      const source = frames[0]; this.#state.ecu = source.ecu;
      const supported = new Set(supportedPids(source.data));
      for (const base of [32, 64]) if (supported.has(base)) {
        const pid = base.toString(16).toUpperCase().padStart(2, '0');
        const frame = parseObdFrames(await this.#command(`01${pid}`), pid, protocol).find(item => item.ecu === source.ecu);
        assert(frame, 'The selected ECU did not return its supported-PID page.');
        supportedPids(frame.data, base).forEach(pidNumber => supported.add(pidNumber));
      }
      this.#check(generation);
      const sensors = SENSOR_DEFINITIONS.filter(sensor => selected.some(item=>item.key===sensor.key)&&supported.has(parseInt(sensor.pid, 16)));
      assert(sensors.length, 'The selected ECU reports none of the supported generic sensors.');
      this.#state.supportedSensors = sensors.map(sensor => sensor.key); this.#status('streaming');
      // A separate loop owns all subsequent requests; no external command interface exists.
      void this.#poll(generation, sensors);
      return this.snapshot();
    } catch (error) {
      if (generation === this.#generation) this.#fail(error);
      throw error;
    }
  }

  #open(port, generation) {
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = error => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolve(); };
      const bluetooth=this.#state.transport==='bluetooth';
      const timer = setTimeout(() => finish(new Error(bluetooth?'Timed out opening Bluetooth. Check pairing, select the adapter’s outgoing COM port and close other apps using it.':'Timed out opening the adapter connection.')), this.#state.transport==='ble'?this.#bleOpenTimeout:bluetooth?this.#bluetoothOpenTimeout:this.#timeout);
      try { port.open(error => {
        if (generation !== this.#generation || this.#port !== port || finished) {
          if (port.isOpen) { try { port.close(() => {}); } catch {} }
          finish(error ?? new Error('Sensor connection was cancelled.')); return;
        }
        finish(error);
      }); } catch (error) { finish(error); }
    });
  }

  #command(command, timeout = this.#timeout) {
    assert(this.#allowed.has(command), 'ELM327 command is not allowed.');
    assert(this.#port?.isOpen && !this.#pending, 'Adapter connection is not ready.');
    assert(!this.#buffer.trim(), 'Unexpected trailing adapter data. Reconnect the adapter.');
    this.#buffer = '';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(new Error(`ELM327 response timed out for ${command}. Session stopped.`)), timeout);
      this.#pending = { command, resolve, reject, timer };
      try { this.#port.write(`${command}\r`, error => { if (error) this.#fail(error); }); }
      catch (error) { this.#fail(error); }
    });
  }
  #receive(chunk) {
    const data = ArrayBuffer.isView(chunk)?new TextDecoder('ascii').decode(new Uint8Array(chunk.buffer,chunk.byteOffset,chunk.byteLength)):String(chunk);
    this.#buffer += data.replace(/\0/g, '');
    if (this.#buffer.length > 16384) { this.#fail(new Error('ELM327 response exceeded the buffer limit.')); return; }
    const end = this.#buffer.indexOf('>');
    if (end < 0) return;
    const response = this.#buffer.slice(0, end); this.#buffer = this.#buffer.slice(end + 1);
    const pending = this.#pending;
    if (!pending) { this.#buffer = ''; return; }
    this.#pending = null; clearTimeout(pending.timer);
    // A second prompt cannot silently become the reply to the next request.
    if (this.#buffer.trim()) { pending.reject(new Error('Unexpected extra adapter response.')); this.#fail(new Error('Unexpected extra adapter response.')); return; }
    this.#buffer = ''; pending.resolve(response);
  }
  async #poll(generation, sensors) {
    try {
      while (generation === this.#generation) for (const sensor of sensors) {
        this.#check(generation);
        await new Promise(resolve => { this.#resumePoll = resolve; this.#pollTimer = setTimeout(resolve, this.#interval); });
        this.#check(generation); this.#pollTimer = null; this.#resumePoll = null;
        const response = await this.#command(`01${sensor.pid}`); this.#check(generation);
        const frame = parseObdFrames(response, sensor.pid, this.#state.protocol).find(item => item.ecu === this.#state.ecu);
        assert(frame, `No PID ${sensor.pid} reply from the selected ECU ${this.#state.ecu}.`);
        const value = decodeSensor(sensor.pid, frame.data), timestamp = new Date().toISOString();
        this.#state.values[sensor.key] = value; this.#state.sampleTimes[sensor.key] = timestamp; this.#state.lastSampleAt = timestamp; this.#state.quality[sensor.key]='valid';
        this.emit('sample', { timestamp, values: { [sensor.key]: value }, quality:{[sensor.key]:'valid'}, ecu: this.#state.ecu,profileId:this.#state.profileId,sessionId:this.#state.sessionId });
      }
    } catch (error) { if (generation === this.#generation) this.#fail(error); }
  }
  async #fiatMessage(request,generation){
    // ELM 2.1+ can wait five seconds after NRC78 before its next prompt.
    // Keep this bounded and leave the generic OBD command timeout unchanged.
    const response=await this.#command(request,Math.max(6500,this.#timeout));this.#check(generation);
    const lines=cleanLines(response,request);
    if(lines.length===1&&lines[0]==='NO DATA')return [];
    return decodeElmCanReplies(response,{request,responseId:'18DAF110'}).map(reply=>reply.payload);
  }
  async #fiatRead(request,generation,minimum=1){
    const replies=await this.#fiatMessage(request,generation);
    let result={status:'unavailable',reason:'No data reported'},completed=false;
    for(const reply of replies){
      assert(!completed,'The ECU returned conflicting responses after a completed request.');
      const parsed=decodeReadDataEnvelope(reply,Number.parseInt(request.slice(2),16),{minimum,maximum:509});
      if(parsed.status==='positive'){
        result=parsed;completed=true;
      }else{
        result={status:'unavailable',reason:`ECU response 0x${parsed.code.toString(16).toUpperCase().padStart(2,'0')}`};
        completed=parsed.code!==0x78;
      }
    }
    return result;
  }
  async #connectFiat(generation,selected){
    this.#state.protocol='7';this.#state.ecu='18DAF110';
    const startSession=async()=>{
      let sessionType=0x03,result=terminalAcknowledgement(await this.#fiatMessage('1003',generation),0x10);
      // This fallback is present in the recovered transport, only for NRC12.
      if(result.reply?.[0]===0x7f&&result.reply[2]===0x12){sessionType=0x92;result=terminalAcknowledgement(await this.#fiatMessage('1092',generation),0x10);}
      return {sessionType,...result};
    };
    let {sessionType,reply:start,noData}=await startSession();
    if(noData){
      const response=await this.#command('ATV0');this.#check(generation);
      const lines=cleanLines(response,'ATV0');adapterError(lines);
      assert(lines.includes('OK'),'Adapter did not accept fixed-length CAN fallback.');
      ({sessionType,reply:start}=await startSession());
    }
    assert(start&&[2,6].includes(start.length)&&start[0]===0x50&&start[1]===sessionType,'The engine ECU did not start its diagnostic session. Check ignition, direct OBD connection and the selected vehicle profile.');
    const iso=await this.#fiatRead('22F1A5',generation,5);
    assert(iso.status==='positive'&&Array.from(iso.data.slice(0,5)).map(v=>v.toString(16).padStart(2,'0')).join('')==='000150a815','ECU identity does not match this Fiat 500X 8GMK profile. No parameter polling was started.');
    const hardware=await this.#fiatRead('22F192',generation,11),software=await this.#fiatRead('22F194',generation,8);
    assert(hardware.status==='positive'&&software.status==='positive','The ECU did not return its hardware and software identifiers. No parameter polling was started.');
    const identityText=data=>new TextDecoder('ascii').decode(data).replace(/[\0 ]+$/g,'');
    const hardwareNumber=identityText(hardware.data),softwareNumber=identityText(software.data);
    assert(hardwareNumber==='MM8GMKHW670'&&/^[A-Z0-9]{1,24}$/.test(softwareNumber),'The connected ECU hardware is not verified for this 500X profile. No parameter polling was started.');
    this.#state.identity={source:'live-manufacturer',ecuIsoCode:'00 01 50 A8 15',hardwareNumber,softwareNumber};
    this.#state.supportedSensors=selected.map(d=>d.key);
    this.#state.channels=selected.map(d=>({...d,staleAfterMs:Math.max(15000,Math.min(30000,selected.length*(this.#interval+500)*2))}));
    this.#lastKeepalive=Date.now();this.#status('streaming');
    void this.#pollFiat(generation,selected.map(channel=>FIAT_8GMK_DEFINITIONS.find(d=>d.key===channel.key)));
  }
  async #pollFiat(generation,sensors){
    const groups=new Map();for(const sensor of sensors){if(!groups.has(sensor.request))groups.set(sensor.request,[]);groups.get(sensor.request).push(sensor);}
    try{
      while(generation===this.#generation)for(const [request,group]of groups){
        this.#check(generation);
        await new Promise(resolve=>{this.#resumePoll=resolve;this.#pollTimer=setTimeout(resolve,this.#interval);});
        this.#check(generation);this.#pollTimer=null;this.#resumePoll=null;
        if(Date.now()-this.#lastKeepalive>=1500){
          const {reply}=terminalAcknowledgement(await this.#fiatMessage('3E00',generation),0x3e);
          assert(reply&&reply.length===2&&reply[0]===0x7e&&reply[1]===0,'The ECU diagnostic session did not respond to its keepalive.');
          this.#lastKeepalive=Date.now();
        }
        const result=await this.#fiatRead(request,generation,Math.max(...group.map(d=>d.startByte+d.bytes)));
        this.#check(generation);
        const timestamp=new Date().toISOString(),values={},quality={},parameterErrors={};
        for(const sensor of group){
          if(result.status==='positive'){
            values[sensor.key]=decodeFiatParameter(sensor.key,result.data);quality[sensor.key]='valid';
            delete this.#state.parameterErrors[sensor.key];
          }else{values[sensor.key]=null;quality[sensor.key]='unavailable';parameterErrors[sensor.key]=result.reason;this.#state.parameterErrors[sensor.key]=result.reason;}
          this.#state.sampleTimes[sensor.key]=timestamp;
        }
        Object.assign(this.#state.values,values);Object.assign(this.#state.quality,quality);this.#state.lastSampleAt=timestamp;
        this.emit('sample',{timestamp,values,quality,parameterErrors,ecu:this.#state.ecu,profileId:this.#state.profileId,sessionId:this.#state.sessionId});
      }
    }catch(error){if(generation===this.#generation)this.#fail(error);}
  }
  #stop(reason = new Error('Sensor session stopped.')) {
    ++this.#generation;
    clearTimeout(this.#pollTimer); this.#pollTimer = null; this.#resumePoll?.(); this.#resumePoll = null;
    if (this.#pending) { clearTimeout(this.#pending.timer); this.#pending.reject(reason); this.#pending = null; }
    const port = this.#port; this.#port = null; this.#buffer = '';
    return port;
  }
  #close(port) {
    if (!port?.isOpen) { port?.cancelOpen?.(); return Promise.resolve(); }
    return new Promise(resolve => {
      const timer = setTimeout(() => { try { port.destroy?.(); } catch {} resolve(); }, 2000);
      try { port.close(() => { clearTimeout(timer); resolve(); }); }
      catch { clearTimeout(timer); try { port.destroy?.(); } catch {} resolve(); }
    });
  }
  #fail(error) {
    if (!this.#port && this.#state.status === 'error') return;
    const message = (error?.message || String(error)).slice(0, 300), port = this.#stop(new Error(message));
    this.#status('error', message); this.emit('fault', { message, timestamp: new Date().toISOString() });
    void this.#close(port);
  }
  async disconnect() { const port = this.#stop(); this.#status('disconnected'); await this.#close(port); return this.snapshot(); }
}
