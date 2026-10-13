import test from 'node:test';
import assert from 'node:assert/strict';
import {describeSerialPorts,portsForTransport,serialPortLabel} from '../ports.mjs';
test('serial enumeration identifies Bluetooth without exposing hardware IDs or serial numbers',()=>{
  const ports=describeSerialPorts([{path:'COM6',pnpId:'BTHENUM\\private-device-id',serialNumber:'private-serial',friendlyName:'Standard Serial over Bluetooth link'},{path:'COM4',pnpId:'USB\\private-device-id',vendorId:'1234',productId:'5678'},{path:'COM10'},null,{path:'COM1\n'}]);
  assert.deepEqual(ports.map(port=>port.kind),['bluetooth','usb','unknown']);assert.doesNotMatch(JSON.stringify(ports),/private|pnpId|serialNumber/);
  assert.deepEqual(portsForTransport(ports,'bluetooth').map(port=>port.path),['COM6','COM10']);assert.deepEqual(portsForTransport(ports,'serial').map(port=>port.path),['COM4','COM10']);assert.match(serialPortLabel(ports[0]),/Bluetooth/);
});
