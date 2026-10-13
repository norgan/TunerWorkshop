// Independently authored Fiat 500X actuator workflows. Factual request sequences
// and timing were checked against the installed CCAN29/BHCAN29 executor.
// The cluster self-test return is corroborated by AlfaOBD 2.5.7.0 device 8865.
// Static protocol support does not establish physical operation on a vehicle.
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const rpm = (request = '221000') => ({ key: 'engineRpm', label: 'engine speed', request, bytes: 2 });
const speed = (bytes = 1, request = '221002') => ({ key: 'vehicleSpeed', label: 'vehicle speed', request, bytes });

// Controller-specific field lengths matter: 8GMK speed is two bytes, whereas
// the body computer, cluster and climate controllers report one byte.
export const MODULE_SERVICE_PREFLIGHT = freeze({
  'fiat-8gmk': [rpm(), speed(2)],
  'fiat-engine-lpg': [rpm(), speed()],
  'fiat-instrument': [rpm(), speed()],
  'fiat-service': [rpm(), speed()],
  'fiat-body': [speed()],
  'fiat-abs': [rpm(), speed()],
  'fiat-airbag': [speed()],
  'fiat-parking': [speed(2)],
  'fiat-steering': [speed(2)],
  'fiat-comfort': [],
  'fiat-climate-auto': [rpm(), speed()],
  'fiat-climate-manual': [rpm(), speed()],
  'fiat-awd': [rpm(), speed()],
  'fiat-gearbox-ddct': [rpm('221C11'), speed(2, '221C14')],
  'fiat-gearbox-zf': [rpm('22F40C'), speed(1, '22F40D')],
  'fiat-blindspot-left': [speed()],
  'fiat-blindspot-right': [speed()],
  'fiat-amplifier': [speed()],
  'fiat-radio-5': [],
  'fiat-radio-65': [],
  'fiat-selector': [],
  'fiat-rfhub': [speed()],
  'fiat-rfhub-basic': [speed()],
  'fiat-lane-camera': [speed()],
  'fiat-radar': [speed()],
});

const lamps = 'Observe the selected lamps; the test changes their normal indication temporarily.';
const movement = 'Keep hands, tools and clothing clear of the moving component.';
const heated = 'The selected heater will be energised briefly. Keep the heated surface clear.';
const climate = 'Keep clear of the air flaps and listen for their movement.';
const commonConditions = ['Ignition on, engine stopped.', 'Vehicle stationary and secured against movement.'];
const confirmationsFor = profileId => {
  const reads = MODULE_SERVICE_PREFLIGHT[profileId];
  return [
    ...(!reads.some(item => item.key === 'engineRpm') ? [{ key: 'engineStoppedConfirmed', label: 'I have switched the engine off.', evidence: 'user-confirmed' }] : []),
    ...(!reads.some(item => item.key === 'vehicleSpeed') ? [{ key: 'stationaryConfirmed', label: 'The vehicle is stationary and secured against movement.', evidence: 'user-confirmed' }] : []),
  ];
};

const actuator = (profileId, id, label, requests, note, waitMs = requests.length === 2 ? 6000 : 2000) => ({
  id: `${profileId}-${id}`, profileId, label, category: 'actuator', available: true, unavailableReason: null,
  evidence: 'Recovered fixed request sequence, timing and explicit return of control; not yet vehicle-tested.',
  conditions: [...commonConditions, note], requiredConfirmations: confirmationsFor(profileId),
  steps: requests.map((request, index) => ({ request, waitAfterMs: index < requests.length - 1 ? waitMs : 0 })),
  // Retain every explicit return-control request, including paired lamp DIDs.
  releaseRequests: [...new Set(requests.filter(request => request.startsWith('2F') && request.slice(6, 8) === '00'))],
  durationMs: Math.max(0, requests.length - 1) * waitMs,
  completion: 'The controller acknowledged the test and return of control. Check the component response yourself.',
  requiresDisconnect: false, keyOffSeconds: 0,
});
const unavailable = (profileId, id, label, reason) => ({
  id: `${profileId}-${id}`, profileId, label, category: 'actuator', available: false, unavailableReason: reason,
  evidence: 'Catalogue entry recovered; the complete setup or ending workflow remains unverified.',
  conditions: commonConditions, requiredConfirmations: [], steps: [], releaseRequests: [], durationMs: 0,
});
const toggle = did => [`2F${did}03FF`, `2F${did}0300`, `2F${did}03FF`, `2F${did}00`];
const shortToggle = did => [`2F${did}03FF`, `2F${did}0300`, `2F${did}00`];
const pair = (left, right) => [`2F${left}03FF`, `2F${right}03FF`, `2F${left}0300`, `2F${right}0300`, `2F${left}00`, `2F${right}00`];
const flap = did => [`2F${did}03FF`, `2F${did}0300`, `2F${did}037F`, `2F${did}0300`, `2F${did}00`];

const body = [
  ...[
    ['low-beam', 'Low beam lamps', '5110', '5210'],
    ['high-beam', 'High beam lamps', '5111', '5211'],
    ['fog-lamps', 'Front fog lamps', '5112', '5212'],
    ['left-indicators', 'Left indicators', '5109', '5119'],
    ['right-indicators', 'Right indicators', '510A', '511A'],
    ['brake-lamps', 'Brake lamps', '5409', '540A'],
    ['rear-interior-lamps', 'Rear interior lamps', '5114', '5214'],
  ].map(([id, label, a, b]) => actuator('fiat-body', id, label, pair(a, b), lamps)),
  ...[
    ['rear-fog', 'Rear fog lamps', '5007'], ['left-daylight', 'Left daytime lamp', '5036'],
    ['right-daylight', 'Right daytime lamp', '5035'], ['side-lamps', 'Side lamps', '501C'],
    ['reversing-lamps', 'Reversing lamps', '500F'], ['left-parking-lamps', 'Left parking lamps', '5309'],
    ['right-parking-lamps', 'Right parking lamps', '530A'], ['number-plate-lamps', 'Number plate lamps', '500B'],
    ['centre-brake-lamp', 'Centre brake lamp', '500E'], ['front-interior-lamp', 'Front interior lamp', '5013'],
    ['night-lamps', 'Night lighting', '501D'],
  ].map(([id, label, did]) => actuator('fiat-body', id, label, toggle(did), lamps)),
  actuator('fiat-body', 'rear-window-heater', 'Rear window heater', toggle('5024'), heated),
  actuator('fiat-body', 'boot-release', 'Boot release', ['2F502203FF', '2F50220000'], 'Keep the boot clear. The latch may release; returning control does not close it.', 1000),
  actuator('fiat-body', 'door-lock', 'Lock doors', ['2F502103FF', '2F50210000'], 'Keep the key outside the vehicle and keep people clear of the locks. Returning control does not unlock the doors.', 500),
  actuator('fiat-body', 'door-unlock', 'Unlock doors', ['2F502003FF', '2F50200000'], 'Keep the key with you. Returning control does not relock the doors.', 500),
  actuator('fiat-body', 'front-wiper-low', 'Front wipers · low speed', ['2F50300301', '2F50300300', '2F503000'], `${movement} Wet the glass before testing.`),
  actuator('fiat-body', 'front-wiper-high', 'Front wipers · high speed', ['2F50300302', '2F50300300', '2F503000'], `${movement} Wet the glass before testing.`),
  actuator('fiat-body', 'rear-wiper', 'Rear wiper', shortToggle('5031'), `${movement} Wet the glass before testing.`),
  actuator('fiat-body', 'front-washer', 'Front washer pump', shortToggle('5032'), 'Check washer fluid and keep people clear of the spray.'),
  actuator('fiat-body', 'rear-washer', 'Rear washer pump', shortToggle('5033'), 'Check washer fluid and keep people clear of the spray.'),
  actuator('fiat-body', 'horn', 'Horn', shortToggle('5028'), 'The horn will sound briefly. Keep people clear of its outlet.', 500),
];
const instrument = [
  ...[
    ['engine-warning', 'Engine warning lamp', '558B'], ['airbag-warning', 'Airbag warning lamp', '557D'],
    ['steering-warning', 'Steering warning lamp', '5544'], ['tyre-warning', 'Tyre pressure warning lamp', '5545'],
    ['seatbelt-warning', 'Seat belt warning lamp', '559F'], ['glow-plug-warning', 'Glow plug lamp', '5554'],
    ['abs-warning', 'ABS warning lamp', '5551'], ['parking-brake-warning', 'Parking brake warning lamp', '5550'],
    ['engine-temperature-warning', 'Engine temperature lamp', '5588'], ['low-fuel-warning', 'Low fuel lamp', '5584'],
    ['high-beam-indicator', 'High beam indicator', '5558'], ['front-fog-indicator', 'Front fog indicator', '5556'],
    ['rear-fog-indicator', 'Rear fog indicator', '5555'], ['parking-lamp-indicator', 'Parking lamp indicator', '5557'],
    ['left-indicator', 'Left turn indicator', '5559'], ['right-indicator', 'Right turn indicator', '555A'],
  ].map(([id, label, did]) => actuator('fiat-instrument', id, label, toggle(did), lamps)),
  ...[['rpm-gauge', 'RPM gauge', '558F'], ['speedometer', 'Speedometer', '556A']].map(([id, label, did]) =>
    actuator('fiat-instrument', id, label, [`2F${did}03FF`, `2F${did}037F`, `2F${did}033F`, `2F${did}03FF`, `2F${did}0300`, `2F${did}00`], 'The gauge will move through test positions. Its indication is not a vehicle measurement during this test.')),
  actuator('fiat-instrument', 'beeper', 'Instrument warning beeper', ['2F557303FF', '2F55730000'], 'The instrument warning sound will play briefly.'),
  actuator('fiat-instrument', 'illumination', 'Instrument illumination', ['2F55720308', '2F55720304', '2F55720302', '2F55720300', '2F557200'], 'The instrument brightness will change during this test.'),
  // Both accepted DASHX1 ISO codes map to AlfaOBD device 8865. Its Autocheck
  // selector 0x7B starts for ten seconds and stops with explicit return control.
  actuator('fiat-instrument', 'self-test', 'Instrument self-test', ['2F557B03FF', '2F557B00'], 'The instrument panel will run its self-test for ten seconds. Its indications are test outputs during this operation.', 10000),
];
const climateTools = profileId => [
  actuator(profileId, 'left-mixer', profileId === 'fiat-climate-auto' ? 'Left temperature flap' : 'Temperature flap', flap('56BE'), climate, 20000),
  ...(profileId === 'fiat-climate-auto' ? [actuator(profileId, 'right-mixer', 'Right temperature flap', flap('56BF'), climate, 20000)] : []),
  actuator(profileId, 'air-distributor', 'Air distribution flap', flap('56C0'), climate, 50000),
  actuator(profileId, 'recirculation', 'Recirculation flap', shortToggle('56C2'), climate, 20000),
  actuator(profileId, 'fan', 'Cabin fan', ['2F56C303FF', '2F56C3037F', '2F56C30300', '2F56C300'], movement),
  actuator(profileId, 'compressor-relay', 'A/C compressor relay', shortToggle('56CA'), 'Listen for the compressor relay or clutch; A/C may need to be selected.'),
  actuator(profileId, 'heater-relay-1', 'Additional heater relay 1', shortToggle('56CE'), heated),
  actuator(profileId, 'heater-relay-2', 'Additional heater relay 2', shortToggle('56CF'), heated),
  ...(profileId === 'fiat-climate-auto' ? [
    actuator(profileId, 'display', 'Climate display segments', shortToggle('56C7'), 'Observe each segment of the climate display.'),
    actuator(profileId, 'display-backlight', 'Climate display backlight', shortToggle('56C8'), lamps),
  ] : []),
  actuator(profileId, 'button-lamps', 'Climate button lamps', shortToggle('56C4'), lamps),
];
const hydraulicReason = 'The hydraulic test setup and vehicle-restraint checks are not implemented. The request sequence alone does not establish a complete brake procedure.';
const abs = [
  ...[
    ['abs-warning', 'ABS warning lamp', '5AAC'], ['ebd-warning', 'EBD warning lamp', '5AAB'],
    ['asr-button', 'ASR button lamp', '5AAE'], ['stability-warning', 'Stability/traction warning lamp', '5AAD'],
    ['hill-holder-warning', 'Hill holder warning lamp', '5ABE'],
  ].map(([id, label, did]) => actuator('fiat-abs', id, label, shortToggle(did), lamps)),
  ...[
    ['front-left-load-valve', 'Front left brake load valve'], ['front-right-load-valve', 'Front right brake load valve'],
    ['rear-left-load-valve', 'Rear left brake load valve'], ['rear-right-load-valve', 'Rear right brake load valve'],
    ['front-left-drain-valve', 'Front left brake drain valve'], ['front-right-drain-valve', 'Front right brake drain valve'],
    ['rear-left-drain-valve', 'Rear left brake drain valve'], ['rear-right-drain-valve', 'Rear right brake drain valve'],
    ['primary-valve-1', 'Traction primary valve 1'], ['primary-valve-2', 'Traction primary valve 2'],
    ['pilot-valve-1', 'Traction pilot valve 1'], ['pilot-valve-2', 'Traction pilot valve 2'], ['pump', 'ABS hydraulic pump'],
  ].map(([id, label]) => unavailable('fiat-abs', id, label, hydraulicReason)),
  ...[['parking-brake', 'Electronic parking brake'], ['left-parking-brake', 'Left parking brake motor'], ['right-parking-brake', 'Right parking brake motor']].map(([id, label]) =>
    unavailable('fiat-abs', id, label, 'Apply/release commands are known, but verified motor completion and the vehicle-restraint workflow are not implemented.')),
];

export const MODULE_SERVICE_TOOLS = freeze([
  ...body, ...instrument, ...climateTools('fiat-climate-auto'), ...climateTools('fiat-climate-manual'), ...abs,
  ...[['driver-seat', 'Driver seat heater', '5003', '04'], ['passenger-seat', 'Passenger seat heater', '5004', '04'], ['steering-wheel', 'Steering wheel heater', '5009', '03']].map(([id, label, did, high]) =>
    actuator('fiat-comfort', id, label, [`2F${did}03${high}`, `2F${did}0300`, `2F${did}0301`, `2F${did}00`], heated)),
  actuator('fiat-radar', 'buzzer', 'Forward warning buzzer', ['2F5AF00301', '2F5AF00300', '2F5AF00302', '2F5AF000'], 'The forward warning sounds will play briefly.'),
  actuator('fiat-radar', 'forward-warning', 'Forward collision warning lamp', toggle('5AF1'), lamps),
  actuator('fiat-radar', 'cruise-warning', 'Cruise control lamp', ['2F5AF203FF00', '2F5AF20300FF', '2F5AF2030000', '2F5AF200'], lamps),
  ...['fiat-blindspot-left', 'fiat-blindspot-right'].map(profileId => actuator(profileId, 'mirror-lamp', 'Mirror warning lamp', toggle('5000'), lamps)),
  ...['fiat-rfhub', 'fiat-rfhub-basic'].map(profileId => actuator(profileId, 'tyre-warning', 'Tyre pressure warning lamps', ['2F5C6F03FF', '2F5C6F00', '2F5C6E03FF', '2F5C6E00'], lamps)),
  ...[
    ['pump', 'Gearbox hydraulic pump'], ['even-clutch', 'Even-gear clutch valve'], ['odd-clutch', 'Odd-gear clutch valve'],
    ['range-valve', 'Gear range valve'], ['engagement-1456', 'Gear engagement valve · 1/4/5/6'],
    ['engagement-32r', 'Gear engagement valve · 3/2/reverse'], ['lockup', 'Lock-up valve'],
  ].map(([id, label]) => unavailable('fiat-gearbox-ddct', id, label, 'Gear position, clutch state and hydraulic setup checks are not implemented for this mechanical gearbox test.')),
]);

export function getModuleServiceTools(profileId) { return MODULE_SERVICE_TOOLS.filter(tool => tool.profileId === profileId); }
