import {Emitter} from './sensor-events.mjs';
import {SENSOR_DEFINITIONS,INITIALIZE,ALLOWED,cleanLines,adapterError,parseProtocolNumber,parseObdFrames,supportedPids,decodeSensor} from './elm-protocol.mjs';
import {FIAT_8GMK_DEFINITIONS,getDiagnosticProfile,selectProfileChannels,decodeFiatParameter} from './fiat-8gmk.mjs';
import {decodeElmCanReplies,decodeReadDataEnvelope} from './can-diagnostics.mjs';
import {DiagnosticError,validateDiagnosticAction} from './diagnostic-actions.mjs';
import {OBD_DIAGNOSTIC_REQUESTS,obdReply,obdCode,decodeObdFaults,decodeReadiness,decodeObdVin,decodeObdFreeze} from './obd-diagnostics.mjs';
import {FIAT_DIAGNOSTIC_REQUESTS,FIAT_IDENTIFICATION_DEFINITIONS,buildFiatSnapshotRequest,decodeFiatDtcResponse,decodeFiatClearResponse,decodeFiatSnapshotResponse,decodeFiatIdentificationResponse} from './fiat-diagnostics.mjs';
import {getServiceTool,serviceToolRequests,runServiceTool,serviceWait} from './service-tools.mjs';
import {INSTRUMENT_SERVICE_PROFILE,INSTRUMENT_SERVICE_CONNECTION,decodeInstrumentIdentity,decodeInstrumentParameter,resetInstrumentService} from './instrument-service.mjs';
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
// Standard ELM protocol 7 is ISO15765 29-bit / 500k. TP with memory off
// selects it without saving a default. Variable DLC and timing match the
// recovered CCAN29 setup; fixed DLC is retried only after no session data.
const FIAT_SETUP=Object.freeze([...INITIALIZE.slice(0,-1),'ATV1','ATTP7','ATCP18','ATCRA18DAF110','ATSHDA10F1','ATCFC1','ATAT1','ATST99']);
const FIAT_IDENTIFIERS=Object.freeze(['22F1A5','22F192','22F194']);
const FIAT_ALLOWED=new Set([...FIAT_SETUP,'ATV0','1003','1092','3E00',...FIAT_IDENTIFIERS,...FIAT_8GMK_DEFINITIONS.map(d=>d.request)]);
const SERVICE_SETUP=Object.freeze(FIAT_SETUP.map(command=>command==='ATCRA18DAF110'?'ATCRA18DAF160':command==='ATSHDA10F1'?'ATSHDA60F1':command));
const SERVICE_ALLOWED=new Set([...SERVICE_SETUP,'ATV0','1003','1092','3E00','22F1A5',...INSTRUMENT_SERVICE_PROFILE.channels.map(d=>d.request)]);

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
  #queue = Promise.resolve();
  #diagnosticAllowed = new Set();
  #diagnosticPromise = null;
  #serviceAbort = null;
  #diagnosticBusy = false;
  #exclusive(task) { const result=this.#queue.then(task);this.#queue=result.catch(()=>{});return result; }
  #progress(update) { this.#state.diagnosticOperation={...this.#state.diagnosticOperation,...update};this.emit('status',this.snapshot()); }

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
    const selected=selectProfileChannels(profileId,options.channels),instrument=profileId==='fiat-service',manufacturer=profileId!=='generic-obd';
    this.#validateConnection({...options,transport,baudRate,port:tcpPort});
    this.#allowed=instrument?SERVICE_ALLOWED:manufacturer?FIAT_ALLOWED:ALLOWED;
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
      for (const command of instrument?SERVICE_SETUP:manufacturer?FIAT_SETUP:INITIALIZE) {
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
    assert(this.#allowed.has(command)||this.#diagnosticAllowed.has(command), 'ELM327 command is not allowed.');
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
        await this.#exclusive(async()=>{
        this.#check(generation);
        const response = await this.#command(`01${sensor.pid}`); this.#check(generation);
        const frame = parseObdFrames(response, sensor.pid, this.#state.protocol).find(item => item.ecu === this.#state.ecu);
        assert(frame, `No PID ${sensor.pid} reply from the selected ECU ${this.#state.ecu}.`);
        const value = decodeSensor(sensor.pid, frame.data), timestamp = new Date().toISOString();
        this.#state.values[sensor.key] = value; this.#state.sampleTimes[sensor.key] = timestamp; this.#state.lastSampleAt = timestamp; this.#state.quality[sensor.key]='valid';
        this.emit('sample', { timestamp, values: { [sensor.key]: value }, quality:{[sensor.key]:'valid'}, ecu: this.#state.ecu,profileId:this.#state.profileId,sessionId:this.#state.sessionId });
        });
      }
    } catch (error) { if (generation === this.#generation) this.#fail(error); }
  }
  async #fiatMessage(request,generation){
    // ELM 2.1+ can wait five seconds after NRC78 before its next prompt.
    // Keep this bounded and leave the generic OBD command timeout unchanged.
    const response=await this.#command(request,Math.max(6500,this.#timeout));this.#check(generation);
    const lines=cleanLines(response,request);
    if(lines.length===1&&lines[0]==='NO DATA')return [];
    return decodeElmCanReplies(response,{request,responseId:this.#state.ecu}).map(reply=>reply.payload);
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
    const instrument=this.#state.profileId==='fiat-service';
    this.#state.protocol='7';this.#state.ecu=instrument?INSTRUMENT_SERVICE_CONNECTION.responseId:'18DAF110';
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
    assert(start&&[2,6].includes(start.length)&&start[0]===0x50&&start[1]===sessionType,'The selected controller did not start its diagnostic session. Check ignition, direct OBD connection and the selected vehicle profile.');
    const iso=await this.#fiatRead('22F1A5',generation,5);
    if(instrument){
      assert(iso.status==='positive','The instrument panel did not identify itself. No parameter polling was started.');
      this.#state.identity=decodeInstrumentIdentity(iso.data);
    }else{
    assert(iso.status==='positive'&&Array.from(iso.data.slice(0,5)).map(v=>v.toString(16).padStart(2,'0')).join('')==='000150a815','ECU identity does not match this Fiat 500X 8GMK profile. No parameter polling was started.');
    const hardware=await this.#fiatRead('22F192',generation,11),software=await this.#fiatRead('22F194',generation,8);
    assert(hardware.status==='positive'&&software.status==='positive','The ECU did not return its hardware and software identifiers. No parameter polling was started.');
    const identityText=data=>new TextDecoder('ascii').decode(data).replace(/[\0 ]+$/g,'');
    const hardwareNumber=identityText(hardware.data),softwareNumber=identityText(software.data);
    assert(hardwareNumber==='MM8GMKHW670'&&/^[A-Z0-9]{1,24}$/.test(softwareNumber),'The connected ECU hardware is not verified for this 500X profile. No parameter polling was started.');
    this.#state.identity={source:'live-manufacturer',ecuIsoCode:'00 01 50 A8 15',hardwareNumber,softwareNumber};
    }
    this.#state.supportedSensors=selected.map(d=>d.key);
    this.#state.channels=selected.map(d=>({...d,staleAfterMs:Math.max(15000,Math.min(30000,selected.length*(this.#interval+500)*2))}));
    this.#lastKeepalive=Date.now();this.#status('streaming');
    const definitions=instrument?INSTRUMENT_SERVICE_PROFILE.channels:FIAT_8GMK_DEFINITIONS;
    void this.#pollFiat(generation,selected.map(channel=>definitions.find(d=>d.key===channel.key)));
  }
  async #pollFiat(generation,sensors){
    const groups=new Map();for(const sensor of sensors){if(!groups.has(sensor.request))groups.set(sensor.request,[]);groups.get(sensor.request).push(sensor);}
    try{
      while(generation===this.#generation)for(const [request,group]of groups){
        this.#check(generation);
        await new Promise(resolve=>{this.#resumePoll=resolve;this.#pollTimer=setTimeout(resolve,this.#interval);});
        this.#check(generation);this.#pollTimer=null;this.#resumePoll=null;
        await this.#exclusive(async()=>{
        this.#check(generation);
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
            values[sensor.key]=(this.#state.profileId==='fiat-service'?decodeInstrumentParameter:decodeFiatParameter)(sensor.key,result.data);quality[sensor.key]='valid';
            delete this.#state.parameterErrors[sensor.key];
          }else{values[sensor.key]=null;quality[sensor.key]='unavailable';parameterErrors[sensor.key]=result.reason;this.#state.parameterErrors[sensor.key]=result.reason;}
          this.#state.sampleTimes[sensor.key]=timestamp;
        }
        Object.assign(this.#state.values,values);Object.assign(this.#state.quality,quality);this.#state.lastSampleAt=timestamp;
        this.emit('sample',{timestamp,values,quality,parameterErrors,ecu:this.#state.ecu,profileId:this.#state.profileId,sessionId:this.#state.sessionId});
        });
      }
    }catch(error){if(generation===this.#generation)this.#fail(error);}
  }
  async #diagnosticPayload(request,generation){
    this.#check(generation);
    const response=await this.#command(request,Math.max(6500,this.#timeout));this.#check(generation);
    const lines=cleanLines(response,request);
    if(lines.length===1&&lines[0]==='NO DATA')throw new DiagnosticError('The ECU did not report data for this request.','unavailable');
    const replies=decodeElmCanReplies(response,{request,responseId:this.#state.ecu,maxPayloadBytes:4095}).map(r=>r.payload);
    const {reply}=terminalAcknowledgement(replies,parseInt(request.slice(0,2),16));
    if(!reply)throw new DiagnosticError('The ECU has not completed this request. No modifying request was retried.','response_pending');
    return reply;
  }
  async #stoppedConditions(generation){
    const rpm=await this.#fiatRead('221000',generation,2),speed=await this.#fiatRead('221002',generation,2);
    if(rpm.status!=='positive'||speed.status!=='positive')throw new DiagnosticError('Engine speed and vehicle speed could not be checked. The action was not started.','precondition');
    const engineRpm=decodeFiatParameter('mes-10500',rpm.data),vehicleSpeed=decodeFiatParameter('mes-11711',speed.data);
    if(engineRpm!==0||vehicleSpeed!==0||[...rpm.data,...speed.data].some(byte=>byte!==0))throw new DiagnosticError('Stop the engine and keep the vehicle stationary before starting this action.','precondition');
    return {engineRpm,vehicleSpeed,sampleAt:Date.now()};
  }
  async #serviceDelay(ms,{signal},generation){
    const end=Date.now()+ms;
    while(Date.now()<end){
      await serviceWait(Math.min(1000,end-Date.now()),{signal});this.#check(generation);
      if(Date.now()-this.#lastKeepalive>=1500){
        const reply=await this.#diagnosticPayload('3E00',generation);
        assert(reply.length===2&&reply[0]===0x7e&&reply[1]===0,'The ECU did not acknowledge its service-session keepalive.');
        this.#lastKeepalive=Date.now();
      }
    }
  }
  async diagnose(input){
    const options=validateDiagnosticAction(input),generation=this.#generation;
    if(this.#state.status!=='streaming'||options.sessionId!==this.#state.sessionId)throw new DiagnosticError('The vehicle connection changed. Connect and review the action again.','session_changed');
    if(this.#diagnosticBusy)throw new DiagnosticError('A diagnostic action is already running.','busy');
    if(this.#state.profileId==='generic-obd'&&!['6','7','8','9'].includes(this.#state.protocol))throw new DiagnosticError('These diagnostic tools require a CAN connection. Sensor reading remains available.','unsupported');
    const instrument=this.#state.profileId==='fiat-service',manufacturer=this.#state.profileId!=='generic-obd';
    if(!manufacturer&&['clear-faults','run-service'].includes(options.action))throw new DiagnosticError('Select the Fiat engine profile for this action.','unsupported');
    if(instrument&&!['read-identification','run-service'].includes(options.action))throw new DiagnosticError('Fault tools are not available for the service-reminder profile. Select the engine profile to read engine faults.','unsupported');
    if(instrument&&options.action==='run-service'&&options.toolId!=='service-interval-reset')throw new DiagnosticError('This procedure does not belong to the connected service controller.','unsupported');
    if(!instrument&&options.action==='run-service'){
      let tool;try{tool=getServiceTool(options.toolId);}catch{throw new DiagnosticError('Choose a known procedure for this engine.','invalid_request');}
      if(!tool.available)throw new DiagnosticError(tool.unavailableReason,'unsupported');
    }
    this.#diagnosticBusy=true;
    const controller=options.action==='run-service'?new AbortController():null;
    this.#serviceAbort=controller;
    this.#progress({action:options.action,message:'Waiting for the current sensor request…'});
    const task=this.#exclusive(async()=>{
      this.#check(generation);
      controller?.signal.throwIfAborted();
      this.#progress({message:'Reading from the connected ECU…'});
      const common={profileId:this.#state.profileId,ecu:this.#state.ecu,sessionId:this.#state.sessionId,capturedAt:new Date().toISOString()};
      this.#diagnosticAllowed=new Set(instrument?['2F556901']:manufacturer?[...Object.values(FIAT_DIAGNOSTIC_REQUESTS),...FIAT_IDENTIFICATION_DEFINITIONS.map(d=>d.request)]:OBD_DIAGNOSTIC_REQUESTS);
      const terminal=result=>{if(result.status!=='positive')throw new DiagnosticError(result.message||'The ECU did not complete this request.','ecu_response');return result;};
      if(instrument){
        if(options.action==='read-identification'){
          const iso=await this.#fiatRead('22F1A5',generation,5);
          if(iso.status!=='positive')throw new DiagnosticError('The instrument panel did not identify itself.','unavailable');
          const identity=decodeInstrumentIdentity(iso.data);
          return {...common,kind:'identity',fields:[{label:'Controller',value:'Fiat 500X service interval'},{label:'ECU ISO code',value:identity.ecuIsoCode},{label:'ECU response address',value:this.#state.ecu}]};
        }
        this.#progress({message:'Checking identity, service counters and stopped vehicle…'});
        const result=await resetInstrumentService({
          command:request=>{controller.signal.throwIfAborted();if(request==='2F556901')this.#progress({message:'Resetting the service reminder; waiting for counter readback…'});return this.#diagnosticPayload(request,generation);},
          context:{...common,confirmed:true,serviceCompleted:options.acknowledged},
          sleep:ms=>this.#serviceDelay(ms,{signal:controller.signal},generation),
        });
        return {...common,kind:'service',result,success:result.status==='verified',message:result.message};
      }
      if(!manufacturer){
        const read=async request=>obdReply(await this.#command(request,Math.max(6500,this.#timeout)),request,this.#state.ecu);
        if(options.action==='read-identification'){
          const result=await read('0902');this.#check(generation);
          return {...common,kind:'identity',fields:[{label:'ECU response address',value:this.#state.ecu},{label:'OBD protocol',value:this.#state.protocol},{label:'VIN',...(result.status==='positive'?{value:decodeObdVin(result.payload)}:result)}]};
        }
        if(options.action==='read-faults'){
          const groups=[];for(const [request,name]of [['03','Stored faults'],['07','Pending faults'],['0A','Permanent faults']]){
            const result=await read(request);this.#check(generation);
            groups.push({name,...(result.status==='positive'?{status:'positive',faults:decodeObdFaults(result.payload,parseInt(request,16)).map(code=>({code}))}:result)});
          }
          const status=await read('0101');this.#check(generation);
          return {...common,kind:'faults',groups,...(status.status==='positive'?{readiness:decodeReadiness(status.payload)}:{readinessUnavailable:status.message})};
        }
        const origin=await read('020200');this.#check(generation);
        if(origin.status!=='positive')return {...common,kind:'snapshot',fields:[],complete:false,message:origin.message};
        assert(origin.payload.length===5,'Invalid freeze-frame fault response.');
        const fields=[];for(const sensor of SENSOR_DEFINITIONS){const result=await read(`02${sensor.pid}00`);this.#check(generation);fields.push(result.status==='positive'?decodeObdFreeze(result.payload,sensor.pid):{label:sensor.label,...result});}
        return {...common,kind:'snapshot',code:obdCode(origin.payload[3],origin.payload[4]),complete:true,fields};
      }
      if(options.action==='read-identification'){
        const fields=[];for(const definition of FIAT_IDENTIFICATION_DEFINITIONS){
          try{const parsed=decodeFiatIdentificationResponse(await this.#diagnosticPayload(definition.request,generation),definition.key);fields.push(parsed.status==='positive'?parsed:{label:definition.label,status:'unavailable',message:parsed.message});}
          catch(error){this.#check(generation);if(error.code!=='unavailable')throw error;fields.push({label:definition.label,status:'unavailable',message:error.message});}
        }return {...common,kind:'identity',fields};
      }
      if(options.action==='read-faults'){
        const result=terminal(decodeFiatDtcResponse(await this.#diagnosticPayload(FIAT_DIAGNOSTIC_REQUESTS.readDtc,generation)));
        return {...common,kind:'faults',groups:[{name:'Engine faults',status:'positive',faults:result.dtcs}],availabilityMask:result.availabilityMask};
      }
      if(options.action==='read-freeze-frame'){
        const id=options.dtcId?.toUpperCase(),request=buildFiatSnapshotRequest(id);this.#diagnosticAllowed.add(request);
        return {...common,kind:'snapshot',...terminal(decodeFiatSnapshotResponse(await this.#diagnosticPayload(request,generation),id))};
      }
      const conditions=await this.#stoppedConditions(generation);this.#check(generation);
      controller?.signal.throwIfAborted();
      if(options.action==='clear-faults'){
        try{terminal(decodeFiatClearResponse(await this.#diagnosticPayload(FIAT_DIAGNOSTIC_REQUESTS.clearDtc,generation)));}
        catch(error){throw new DiagnosticError('Fault clearing was not confirmed. It may already have taken effect; read faults again before retrying. '+error.message,'outcome_unknown');}
        return {...common,kind:'cleared',acknowledged:true};
      }
      serviceToolRequests(options.toolId).forEach(request=>this.#diagnosticAllowed.add(request));
      const result=await runServiceTool(options.toolId,{
        command:(request,{cleanup}={})=>{if(!cleanup)controller.signal.throwIfAborted();return this.#diagnosticPayload(request,generation);},
        signal:controller.signal,wait:(ms,opts)=>this.#serviceDelay(ms,opts,generation),onProgress:progress=>this.#progress(progress),
        context:{profileId:'fiat-8gmk',status:'connected',ecu:this.#state.ecu,acknowledged:options.acknowledged,...conditions},
      });
      return {...common,kind:'service',result,success:result.status==='completed',message:result.message,instructions:result.aftercare,requiresDisconnect:result.requiresDisconnect};
    });
    this.#diagnosticPromise=task;
    let result;
    try{result=await task;}
    catch(error){throw error instanceof DiagnosticError?error:new DiagnosticError(error.message);}
    finally{this.#serviceAbort=null;this.#diagnosticPromise=null;this.#diagnosticBusy=false;this.#diagnosticAllowed.clear();delete this.#state.diagnosticOperation;this.emit('status',this.snapshot());}
    if(result?.requiresDisconnect)await this.disconnect();
    return result;
  }
  stopService({sessionId}={}){
    if(sessionId!==this.#state.sessionId)throw new DiagnosticError('The vehicle connection changed.','session_changed');
    if(!this.#serviceAbort)throw new DiagnosticError('No service operation is running.','not_running');
    this.#serviceAbort.abort();return {stopping:true};
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
  async disconnect() { if(this.#serviceAbort){this.#serviceAbort.abort();await this.#diagnosticPromise?.catch(()=>{});} const port = this.#stop(); this.#status('disconnected'); await this.#close(port); return this.snapshot(); }
}
