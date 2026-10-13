const clean=value=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,200):'';

// Windows reports Bluetooth Classic SPP as BTHENUM serial devices. These hints
// identify the connection type, not the remote adapter or its COM-port direction.
export function describeSerialPorts(ports){
  if(!Array.isArray(ports))throw new Error('Serial port enumeration failed.');
  return ports.filter(port=>port&&typeof port.path==='string'&&port.path.length>0&&port.path.length<512&&!/[\r\n\u0000]/.test(port.path)).map(port=>{
    const pnp=typeof port.pnpId==='string'?port.pnpId:'',name=clean(port.friendlyName);
    const kind=/^BTH(?:ENUM|MODEM)\\/i.test(pnp)||/bluetooth/i.test(name)?'bluetooth':/^USB\\/i.test(pnp)||port.vendorId&&port.productId?'usb':'unknown';
    const result={path:port.path,kind};
    if(name)result.friendlyName=name;
    for(const key of ['manufacturer','vendorId','productId']){const value=clean(port[key]);if(value)result[key]=value;}
    return result;
  });
}
export function portsForTransport(ports,transport){
  const kind=transport==='bluetooth'?'bluetooth':'usb';
  return ports.filter(port=>port.kind===kind||!port.kind||port.kind==='unknown').sort((a,b)=>Number(b.kind===kind)-Number(a.kind===kind)||a.path.localeCompare(b.path,undefined,{numeric:true}));
}
export function serialPortLabel(port){
  const kind=port.kind==='bluetooth'?'Bluetooth':port.kind==='usb'?'USB':'Type not identified';
  return [port.path,kind,port.friendlyName||port.manufacturer].filter(Boolean).join(' · ');
}
