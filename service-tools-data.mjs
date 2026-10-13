// Independently authored IAW 8GMK CF6 service definitions. Requests and timing
// were corroborated against the installed application's CCAN29 sequence path.
// Descriptions below are original UI copy, not exported database documentation.
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

const engineOff = ['Ignition on, engine stopped.', 'Vehicle stationary; secure it against movement.'];
const actuator = (id, label, requests, note, waitMs = requests.length === 2 ? 6000 : 2000) => ({
  id, label, category: 'actuator', available: true, unavailableReason: null,
  evidence: 'Recovered request sequence and CCAN29 timing; physical operation not yet vehicle-tested.',
  engineState: 'stopped', conditions: [...engineOff, note],
  steps: requests.map((request, index) => ({ request, waitAfterMs: index < requests.length - 1 ? waitMs : 0 })),
  stopRequest: requests.at(-1), requiresDisconnect: false, keyOffSeconds: 0,
  completion: 'The ECU acknowledged the test and return of control. Confirm the component response yourself.'
});
const adjustment = (id, label, requests, options = {}) => ({
  id, label, category: 'adjustment', available: true, unavailableReason: null,
  evidence: 'Recovered request sequence and CCAN29 timing; physical outcome not yet vehicle-tested.',
  engineState: 'stopped', conditions: [...engineOff, ...(options.conditions || [])],
  steps: requests.map((request, index) => ({ request, waitAfterMs: index < requests.length - 1 || requests.length === 1 ? (requests.length === 1 ? 8000 : requests.length === 2 ? 6000 : 2000) : 0 })),
  stopRequest: null, requiresDisconnect: false, keyOffSeconds: 0,
  completion: 'The ECU acknowledged the adjustment request.', ...options,
  conditions: [...engineOff, ...(options.conditions || [])]
});
const keyOff = {
  requiresDisconnect: true, keyOffSeconds: 60,
  aftercare: 'Switch the ignition off and wait at least 60 seconds before starting the engine or reconnecting.'
};
const unavailable = (id, label, reason, conditions = []) => ({
  id, label, category: 'adjustment', available: false, unavailableReason: reason,
  evidence: 'Listed in the installed IAW 8GMK CF6 catalogue; complete execution workflow is not established.',
  engineState: null, conditions, steps: [], stopRequest: null, requiresDisconnect: false, keyOffSeconds: 0
});

export const SERVICE_TOOLS = freeze([
  actuator('fan-low', 'Cooling fan · low speed', ['3101020B01', '3101020B00'], 'Keep hands, tools and clothing clear of the fan.'),
  actuator('fan-high', 'Cooling fan · high speed', ['3101020B02', '3101020B00'], 'Keep hands, tools and clothing clear of the fan.'),
  actuator('ac-relay', 'A/C compressor relay', ['2F500103', '2F500100'], 'Listen for the compressor clutch or relay. A/C may need to be selected.'),
  actuator('fuel-pump', 'Fuel pump relay', ['2F502103FF', '2F50210300', '2F502103FF', '2F502100'], 'Check that the fuel system is intact. The pump will run during this test.'),
  actuator('evap-valve', 'Evaporation control valve', ['2F500F03FF', '2F500F0300', '2F500F03FF', '2F500F00'], 'Listen for the valve clicking.'),
  actuator('turbo-vacuum', 'Turbo vacuum valve', ['2F500B03FF', '2F500B0300', '2F500B03FF', '2F500B00'], 'Listen for the valve clicking.'),
  actuator('wastegate', 'Wastegate solenoid', ['2F500A03', '2F500A00'], 'Listen for the solenoid clicking.'),
  actuator('lambda-pre-heater', 'Pre-catalyst lambda heater', ['2F514003', '2F514000'], 'The oxygen sensor heater will be energised.'),
  actuator('lambda-post-heater', 'Post-catalyst lambda heater', ['2F514103', '2F514100'], 'The oxygen sensor heater will be energised.'),
  ...Array.from({ length: 4 }, (_, index) => actuator(`injector-${index + 1}`, `Injector ${index + 1}`, [`2F510${index}03`, `2F510${index}00`], 'This short electrical test may inject fuel. Avoid repeating it unnecessarily.', 500)),
  ...Array.from({ length: 4 }, (_, index) => actuator(`coil-${index + 1}`, `Ignition coil ${index + 1}`, [`2F511${index}03`, `2F511${index}00`], 'Prepare a suitable grounded spark tester before starting; do not handle ignition leads during the test.', 500)),
  ...Array.from({ length: 4 }, (_, index) => actuator(`uniair-${index + 1}`, `UniAir valve · cylinder ${index + 1}`, [`2F512${index}03`, `2F512${index}00`], 'Listen for the selected valve clicking.')),
  adjustment('self-adaptation-reset', 'Reset engine self-adaptations', ['2F500301'], {
    conditions: ['Use after the repair or diagnostic procedure that calls for clearing engine adaptations.']
  }),
  adjustment('oil-change', 'Engine oil change · reset UniAir adaptations', ['221302', '2F504001', '2F506001'], {
    ...keyOff,
    conditions: ['Complete the engine oil change before running this reset.'],
    steps: [{ request: '221302', waitAfterMs: 2000, optionalRead: true }, { request: '2F504001', waitAfterMs: 2000 }, { request: '2F506001', waitAfterMs: 0 }],
    completion: 'The ECU acknowledged both UniAir oil-change resets. This does not reset the instrument-panel service interval.'
  }),
  adjustment('phonic-reset', 'Reset phonic wheel learning', ['2F502201', '2F502401'], {
    ...keyOff, conditions: ['Use when replacing the phonic wheel and follow the vehicle-specific relearning procedure afterwards.'],
    aftercare: `${keyOff.aftercare} Phonic-wheel relearning and the appropriate UniAir correction procedure remain required.`
  }),
  adjustment('throttle-learning', 'Learn throttle position', ['2F500301', '2F501003'], {
    conditions: ['Keep clear of the throttle mechanism; this clears engine self-adaptations before starting throttle learning.'],
    verificationRequest: '221860', completion: 'The ECU accepted the throttle-learning requests.'
  }),
  adjustment('uniair-replacement', 'UniAir module replacement reset', ['2F504001', '2F504101', '2F506001', '2F507001'], {
    ...keyOff, conditions: ['Use after replacing the UniAir module. The appropriate actuator correction procedure may also be needed.']
  }),
  adjustment('timing-sensor-replacement', 'Timing sensor or cam replacement reset', ['2F502401'], {
    ...keyOff, conditions: ['Use after replacing the timing sensor or cam. The appropriate UniAir correction procedure may also be needed.']
  }),
  adjustment('rpm-sensor-replacement', 'RPM sensor or timing-belt replacement reset', ['2F502201'], {
    ...keyOff, conditions: ['Use after replacing the RPM sensor or timing belt and follow the vehicle-specific relearning procedure.'],
    aftercare: `${keyOff.aftercare} Phonic-wheel relearning and the appropriate UniAir correction procedure remain required.`
  }),
  adjustment('oil-temperature-sensor-replacement', 'Oil-temperature sensor replacement reset', ['2F504001', '2F504101', '2F506001'], {
    ...keyOff, conditions: ['Use after replacing the oil-temperature sensor. The appropriate UniAir correction procedure may also be needed.']
  }),
  unavailable('alternator-replacement', 'Intelligent alternator replacement reset', 'Routine result values and completion handling still need to be established.'),
  adjustment('overboost-reset', 'Reset overboost counter', ['2F502701'], { conditions: ['Use after turbocharger replacement. This does not increase the boost target.'] }),
  unavailable('clutch-learning', 'Learn clutch pedal', 'The engine-running, clutch-position, fault-check and learning-result workflow is not implemented yet.'),
  unavailable('neutral-learning', 'Learn neutral and first-gear positions', 'This needs a timed clutch and gear-change workflow with confirmed routine-result interpretation.'),
  unavailable('performance-limit-deactivation', 'Deactivate performance limit', 'This is a one-time irreversible change; its complete result and recovery workflow is not established.')
].map(tool => ({ ...tool, profileId: 'fiat-8gmk', durationMs: tool.steps.reduce((total, step) => total + step.waitAfterMs, 0) })));

export const FIAT_SERVICE_TOOLS = SERVICE_TOOLS;
