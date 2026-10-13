import test from 'node:test';
import assert from 'node:assert/strict';
import { identifyMap } from '../map-identification.mjs';

test('saved ALFA reference names classify boost, ignition and lambda with their source evidence', () => {
  const examples = [
    ['PQAV', 'Base spark advance in Homogeneous mode', 'ignition', 'target'],
    ['PQAV_CNG', 'Base spark advance in Homogeneous mode for CNG', 'ignition', 'target'],
    ['TBDPREUTHDYN', 'Upstream Throttle Pressure static target', 'boost', 'target'],
    ['TBDUTYNQAHRP', 'Nominal percentage opening wastegate Table on RP and QAH of compressor.', 'boost', 'target'],
    ['TBRPCOMPLIM', 'Compressor pressure ratio limit for pumping and speed', 'boost', 'limiter'],
    ['TBDPTURBO', 'Table for Turbo base delta pressure close to oxygen sensor', 'boost', 'unknown'],
    ['KFILTRPBST', 'RP compressor target low pass filter gain.', 'boost', 'unknown'],
    ['TBACLOAD', 'compressor load interpolation table', 'boost', 'unknown'],
    ['PQLAMMP', 'Table for Base Hot Lambda ', 'fuel', 'target'],
    ['PQLAMMPC', 'Table for Base Cold Lambda', 'fuel', 'target'],
    ['PQLAM_MIN', 'Minimum Lambda Table', 'fuel', 'limiter'],
  ];
  for (const [symbol, name, category, role] of examples) {
    const result = identifyMap({ name, symbol, unit: category === 'ignition' ? 'deg' : '' });
    assert.equal(result.category, category, symbol); assert.equal(result.role, role, symbol);
    assert.equal(result.confidence, 'source-labelled'); assert.match(result.reason, /Saved name/);
    assert.equal(result.name, name); assert.equal(result.symbol, symbol); assert.ok(result.displayName);
  }
});

test('Italian descriptions use explicit control terms and preserve accents in display and evidence', () => {
  for (const [name, category, role] of [
    ['Pressione sovralimentazione richiesta', 'boost', 'target'],
    ['Limitatore pressione turbo', 'boost', 'limiter'],
    ['Correzione anticipo accensione per temperatura', 'ignition', 'correction'],
    ['Anticipo accensione massimo', 'ignition', 'limiter'],
    ['Lambda obiettivo a pieno carico', 'fuel', 'target'],
    ['Correzione quantità iniezione', 'fuel', 'correction'],
    ['Tempo d’iniezione benzina', 'fuel', 'unknown'],
    ['Anticipo iniezione', 'fuel', 'unknown'],
    ['Fase e anticipo valvole', 'other', 'unknown'],
  ]) {
    const result = identifyMap({ name });
    assert.equal(result.category, category, name); assert.equal(result.role, role, name);
    assert.equal(result.displayName, name); assert.equal(result.name, name);
  }
});

test('generic pressure, timing and units do not masquerade as boost or ignition', () => {
  for (const name of ['Pressure target', 'Manifold pressure', 'Timing correction', 'Valve timing target',
    'Camshaft advance', 'Boostrap table', 'Brake Boost Depression Switch Diagnosis Enable Flag',
    'Brake Boost Pressure Switch Check1 Fault Confirmed Threshold', 'Air conditioning compressor pressure target',
    'A/C compressor load', 'Pressione servofreno', 'Compressor']) {
    const result = identifyMap({ name, unit: 'mBar', symbol: 'RAW_123' });
    assert.equal(result.category, 'other', name); assert.equal(result.confidence, 'unclassified', name);
  }
  assert.equal(identifyMap({ name: 'Injection timing correction' }).category, 'fuel');
  assert.equal(identifyMap({ name: 'Fuel rail pressure target' }).category, 'fuel');
  assert.equal(identifyMap({ name: 'Spark advance correction' }).category, 'ignition');
  for (const unit of ['deg', 'rpm', 'mBar', 'lambda', 'AFR', 'Nm', '%']) {
    assert.equal(identifyMap({ name: 'Raw table 0x15358C', unit }).category, 'other');
  }
});

test('known symbols are exact reference labels, retain variants and expose conflicting labels', () => {
  const result = identifyMap({ symbol: ' pqav_cng ' });
  assert.equal(result.category, 'ignition'); assert.equal(result.symbol, ' pqav_cng ');
  assert.equal(result.displayName, 'Base ignition timing (CNG)'); assert.match(result.reason, /reference metadata, not an ECU address match/);
  assert.equal(identifyMap({ symbol: 'PQLAMMP_VVA' }).category, 'fuel');
  assert.equal(identifyMap({ symbol: 'PQAV_UNKNOWN' }).category, 'other');
  assert.equal(identifyMap({ symbol: 'PQLAM' }).category, 'other');
  const conflict = identifyMap({ name: 'Fuel pressure target', symbol: 'PQAV' });
  assert.equal(conflict.category, 'other'); assert.match(conflict.reason, /different functions/);
  assert.equal(identifyMap({ name: 'Boost and fuel correction' }).category, 'other');
});

test('known nonconflicting symbols provide friendly headings without replacing original evidence', () => {
  for (const [symbol, name, displayName] of [
    ['TBDPREUTHDYN', 'Upstream Throttle Pressure static target', 'Boost pressure target'],
    ['PQAV', 'Base spark advance in Homogeneous mode', 'Base ignition timing'],
    ['PQAV_CNG', 'Base spark advance in Homogeneous mode for CNG', 'Base ignition timing (CNG)'],
    ['PQLAMMP', 'Table for Base Hot Lambda ', 'Fuel mixture target — warm engine (lambda)'],
    ['PQLAMMPC', 'Table for Base Cold Lambda', 'Fuel mixture target — cold engine (lambda)'],
    ['PQLAM_MIN', 'Minimum Lambda Table', 'Minimum lambda'],
    ['TBDUTYNQAHRP', 'Nominal percentage opening wastegate Table on RP and QAH of compressor.', 'Wastegate opening target'],
    ['TBDUTYNQAHRPCNG', '', 'Wastegate opening target (CNG)'],
    ['TBRPCOMPLIM', 'Compressor pressure ratio limit for pumping and speed', 'Compressor pressure ratio limit'],
  ]) {
    const result = identifyMap({ name, symbol });
    assert.equal(result.displayName, displayName); assert.equal(result.name, name); assert.equal(result.symbol, symbol);
    assert.equal(result.confidence, 'source-labelled'); assert.match(result.reason, new RegExp(symbol));
  }
  const conflict = identifyMap({ name: 'Fuel pressure target', symbol: 'PQAV' });
  assert.equal(conflict.category, 'other'); assert.equal(conflict.displayName, 'Fuel pressure target');
  assert.equal(conflict.name, 'Fuel pressure target'); assert.equal(conflict.symbol, 'PQAV');
  assert.equal(identifyMap({ name: 'Valve timing target', symbol: 'PQAV' }).displayName, 'Valve timing target');
  assert.equal(identifyMap({ name: 'Custom spark advance', symbol: 'CUSTOM' }).displayName, 'Custom spark advance');
  assert.equal(identifyMap({ name: 'compressor load interpolation table', symbol: 'TBACLOAD' }).displayName, 'compressor load interpolation table');
});

test('map labels outrank broad context; comments and folders can explicitly label an otherwise raw map', () => {
  const direct = identifyMap({ name: 'Boost pressure target', comment: 'Fuel compensation context', folder: 'Ignition' });
  assert.equal(direct.category, 'boost'); assert.match(direct.reason, /Saved name/);
  const comment = identifyMap({ name: 'Raw table', comment: 'Spark advance correction', folder: 'All maps' });
  assert.equal(comment.category, 'ignition'); assert.equal(comment.role, 'correction'); assert.match(comment.reason, /Saved comment/);
  const folder = identifyMap({ name: 'Table 01', folder: 'Fuel / Lambda' });
  assert.equal(folder.category, 'fuel'); assert.equal(folder.role, 'unknown'); assert.match(folder.reason, /Saved folder/);
  assert.equal(identifyMap({ name: 'Table', folder: 'Boost and fuel' }).category, 'other');
  for (const name of ['Brake booster pressure', 'A/C compressor load', 'Valve timing target']) {
    assert.equal(identifyMap({ name, folder: 'Boost', comment: 'Ignition', symbol: 'PQAV' }).category, 'other', name);
  }
});

test('role inference distinguishes limits, corrections, targets and descriptive subsystem entries', () => {
  for (const [name, role] of [
    ['Maximum boost pressure target', 'limiter'], ['Boost pressure correction', 'correction'],
    ['Lambda set-point', 'target'], ['Spark advance reduction', 'correction'],
    ['Compressor pressure ratio limit', 'limiter'], ['Boost target low pass filter gain', 'unknown'],
    ['Lambda sensor fault maximum threshold', 'unknown'], ['Ignition enable flag', 'unknown'],
    ['Turbo speed', 'unknown'], ['Injector duration', 'unknown'],
  ]) assert.equal(identifyMap({ name }).role, role, name);
  assert.equal(identifyMap({ name: 'Spark advance diagnostic threshold', symbol: 'PQAV' }).role, 'unknown');
});

test('actual diagnostic, threshold, test-mode and filtering records do not acquire tuning roles', () => {
  for (const name of [
    'Post Catalyst Lambda Probe Correction Filtering Coefficient',
    'Programming Test Mode - calibration for engine speed target in fixed-time ignition mode',
    'Programming Test Mode - calibration for minimum ignition advance',
    'Maximum battery voltage for enabling spark coils test',
    'Hysteresis Air temp threshold for Max Spark Advance Correction',
    'Boost Pressure Target Threshold',
    'Max value for counter(PUMPACTENGSTP2) of fuel pump activation/deactivation cycles during engine automatic stopping',
    'Enabled Mega Knock correction',
    'Air temperature max threshold for waste gate adaptation enabling..',
    'Maximum boost pressure diagnostics',
  ]) {
    const result = identifyMap({ name });
    assert.notEqual(result.category, 'other', name);
    assert.equal(result.role, 'unknown', name);
  }
  for (const name of [
    'RPM Vector Threshold for Immediate Downshift Suggestion in Normal driving mode(Fuel Consumption Reduction)',
    'Mean Indicated Torque Vector Threshold for Upshift Steady State in Sport driving mode(Fuel Consumption Reduction)',
    'Downshift Suggestion Torque Threshold for Fuel Consumption Reduction in Normal driving mode',
    'Engine Speed Threshold Max to disable Fuel Consumption Reduction in Sport driving mode',
  ]) {
    const result = identifyMap({ name });
    assert.equal(result.category, 'other', name); assert.equal(result.role, 'unknown', name);
  }
});

test('classification is nonmutating and tolerates missing or malformed metadata without inventing labels', () => {
  const source = Object.freeze({ name: '  Spark advance  ', symbol: 'CUSTOM', unit: 'deg', comment: 'keep unchanged', folder: '' });
  const first = identifyMap(source); first.name = 'changed';
  assert.equal(identifyMap(source).name, source.name); assert.equal(source.name, '  Spark advance  ');
  for (const value of [undefined, null, 42, 'Boost', {}, { name: null, symbol: {}, folder: ['Fuel'], unit: 'AFR' }]) {
    const result = identifyMap(value);
    assert.equal(result.category, 'other'); assert.equal(result.displayName, 'Unnamed map');
  }
  assert.equal(identifyMap({ name: 'x'.repeat(100000) }).category, 'other');
});
