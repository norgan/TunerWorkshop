export function installBluetoothDialogs(bridge=window.workshopDesktop){
  if(!bridge?.onBluetoothDevices)return;
  const $=selector=>document.querySelector(selector);
  let pairing=null;
  bridge.onBluetoothDevices(result=>{
    const list=$('#ble-device-list'),focused=document.activeElement?.dataset?.device;
    list.replaceChildren();
    for(const device of result.devices){
      const button=document.createElement('button');button.textContent=device.deviceName;button.dataset.device=device.deviceId;
      button.addEventListener('click',()=>bridge.selectBluetoothDevice({requestId:result.requestId,deviceId:device.deviceId}));list.append(button);
      if(focused===device.deviceId)button.focus();
    }
    $('#ble-scan-status').textContent=result.devices.length?'Choose your adapter from the devices below.':'Looking for nearby devices…';
    if(!$('#ble-device-dialog').open)$('#ble-device-dialog').showModal();
  });
  bridge.onBluetoothPickerClosed(()=>$('#ble-device-dialog').close());
  const cancel=()=>bridge.cancelBluetoothRequest();
  $('#ble-device-cancel').addEventListener('click',cancel);
  $('#ble-device-dialog').addEventListener('cancel',event=>{event.preventDefault();cancel();});
  bridge.onBluetoothPairing(result=>{
    pairing=result;$('#ble-pin').value='';$('#ble-pin-field').hidden=result.kind!=='providePin';
    $('#ble-pair-description').textContent=result.kind==='providePin'?'Enter the PIN supplied with your adapter.':result.kind==='confirmPin'?`Confirm that the adapter’s pairing code matches ${result.pin}.`:'Allow pairing with the BLE adapter you selected?';
    if(!$('#ble-pair-dialog').open)$('#ble-pair-dialog').showModal();
    if(result.kind==='providePin')$('#ble-pin').focus();
  });
  bridge.onBluetoothPairingClosed(()=>{pairing=null;$('#ble-pin').value='';$('#ble-pair-dialog').close();});
  $('#ble-pair-form').addEventListener('submit',event=>{event.preventDefault();if(pairing)bridge.respondBluetoothPairing({requestId:pairing.requestId,confirmed:true,...(pairing.kind==='providePin'?{pin:$('#ble-pin').value}:{})});});
  $('#ble-pair-cancel').addEventListener('click',cancel);
  $('#ble-pair-dialog').addEventListener('cancel',event=>{event.preventDefault();cancel();});
}
