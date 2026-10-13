import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverCalibrationCandidates } from '../calibration-discovery.mjs';

function imageWithSeries(values, littleEndian = false, offset = 16) {
  const bytes = new Uint8Array(offset + values.length * 2 + 32).fill(255);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint16(offset + index * 2, value, littleEndian));
  return bytes;
}

test('raw-series discovery finds observed structured bytes without assigning tuning semantics', () => {
  const values = [750,850,1000,1200,1400,1600,1800,2000,2200,2400,2700,3000,3300,3600,4000,4400,4700,5000,5300,5500,5700,6000,6300,6600];
  const bytes = imageWithSeries(values);
  const untouched = bytes.slice();
  const result = discoverCalibrationCandidates(bytes);
  const candidate = result.candidates.find(value => value.offset === 16 && value.endian === 'big');
  assert.ok(candidate);
  assert.deepEqual(candidate.values, values);
  assert.equal(candidate.rows, 1); assert.equal(candidate.cols, 24);
  assert.equal(candidate.kind, 'axis-or-curve'); assert.equal(candidate.verified, false);
  assert.equal(candidate.confidence, 'heuristic'); assert.equal(candidate.type, 'uint16');
  assert.equal(candidate.unit, undefined); assert.equal(candidate.xAxis, undefined);
  assert.deepEqual(bytes, untouched);
  assert.match(result.warning, /not identified tuning maps/);
});

test('raw-series discovery respects Uint8Array offsets and supports little endian and descending sequences', () => {
  const ascending = [160,320,480,640,800,960,1120,1280,1440,1600];
  const backing = new Uint8Array(200).fill(254);
  const fixture = imageWithSeries(ascending, true);
  backing.set(fixture, 13);
  const sliced = backing.subarray(13, 13 + fixture.length);
  const found = discoverCalibrationCandidates(sliced).candidates.find(value => value.offset === 16 && value.endian === 'little');
  assert.deepEqual(found?.values, ascending);
  const descending = ascending.slice().reverse();
  const descendingFound = discoverCalibrationCandidates(imageWithSeries(descending)).candidates.find(value => value.offset === 16 && value.endian === 'big');
  assert.deepEqual(descendingFound?.values, descending);
});

test('empty images, uniform fill and oversized counter runs produce no candidates', () => {
  for (const bytes of [new Uint8Array(), new Uint8Array(1024), new Uint8Array(1024).fill(255), imageWithSeries(Array.from({length:100},(_,i)=>i*100))]) {
    assert.equal(discoverCalibrationCandidates(bytes).candidates.length, 0);
  }
});

test('scan bounds exclude complete candidates and never offer clipped monotonic runs', () => {
  const values = Array.from({length:16},(_,index)=>(index+1)*400);
  const bytes = imageWithSeries(values);
  assert.equal(discoverCalibrationCandidates(bytes,{end:16}).candidates.length,0);
  assert.equal(discoverCalibrationCandidates(bytes,{start:20,end:40}).candidates.length,0);
  assert.equal(discoverCalibrationCandidates(bytes,{start:16,end:36}).candidates.length,0);
  const result=discoverCalibrationCandidates(bytes,{maxScanBytes:16});
  assert.equal(result.scanLimited,true); assert.equal(result.scannedRange.bytes,16);
  assert.equal(result.requestedRange.endExclusive,bytes.length);
});

test('result limits are explicit and duplicate runs are not emitted within one interpretation', () => {
  const bytes=new Uint8Array(4000).fill(255); const view=new DataView(bytes.buffer);
  for(let n=0;n<20;n++) for(let i=0;i<12;i++)view.setUint16(n*100+16+i*2,(i+1)*400+n,false);
  const result=discoverCalibrationCandidates(bytes,{maxResults:3});
  assert.equal(result.candidates.length,3); assert.equal(result.truncated,true);
  assert.ok(result.totalCandidates>=20);
  assert.equal(new Set(result.candidates.map(value=>value.id)).size,result.candidates.length);
  for(const candidate of result.candidates)assert.ok(candidate.offset+candidate.count*2<=bytes.length);
});

test('invalid ranges and budgets fail before reading bytes', () => {
  const bytes=new Uint8Array(100);
  for(const options of [{start:-1},{start:NaN},{start:101},{end:101},{start:80,end:20},{maxResults:0},{maxResults:201},{maxScanBytes:0},{maxScanBytes:16*1024*1024+1},{maxScanBytes:1.5}])assert.throws(()=>discoverCalibrationCandidates(bytes,options),RangeError);
  assert.throws(()=>discoverCalibrationCandidates([1,2,3]),TypeError);
  assert.throws(()=>discoverCalibrationCandidates(bytes,null),TypeError);
});

test('a matching length word is excluded from the raw values with unverified prefix evidence', () => {
  const values = [750,850,1000,1200,1400,1600,1800,2000,2200,2400,2700,3000,3300,3600,4000,4400,4700,5000,5300,5500,5700,6000,6300,6600];
  for (const littleEndian of [false, true]) {
    const bytes = imageWithSeries(values, littleEndian);
    new DataView(bytes.buffer).setUint16(14, values.length, littleEndian);
    const result = discoverCalibrationCandidates(bytes);
    const endian = littleEndian ? 'little' : 'big';
    const candidate = result.candidates.find(value => value.offset === 16 && value.endian === endian);
    assert.deepEqual(candidate?.values, values);
    assert.equal(candidate.count, 24); assert.equal(candidate.cols, 24);
    assert.equal(candidate.verified, false);
    assert.ok(candidate.evidence.some(line => /preceding word equals the series length; its meaning is unverified/.test(line)));
    assert.ok(!result.candidates.some(value => value.offset === 14 && value.endian === endian));
  }
});

test('a nonmatching preceding word is retained as raw data without length evidence', () => {
  const values = [750,850,1000,1200,1400,1600,1800,2000,2200,2400,2700,3000,3300,3600,4000,4400,4700,5000,5300,5500,5700,6000,6300,6600];
  const bytes = imageWithSeries(values);
  new DataView(bytes.buffer).setUint16(14, 13, false);
  const result = discoverCalibrationCandidates(bytes);
  const candidate = result.candidates.find(value => value.offset === 14 && value.endian === 'big');
  assert.deepEqual(candidate?.values, [13, ...values]);
  assert.ok(!candidate.evidence.some(line => /preceding word equals/.test(line)));
  assert.ok(!result.candidates.some(value => value.offset === 16 && value.endian === 'big'));
});

test('length-prefix handling accepts 64 values and never converts clipped or oversized runs', () => {
  const values = Array.from({length:64}, (_, index) => (index+1)*400);
  const bytes = imageWithSeries(values);
  new DataView(bytes.buffer).setUint16(14, values.length, false);
  const candidate = discoverCalibrationCandidates(bytes).candidates.find(value => value.offset === 16 && value.endian === 'big');
  assert.deepEqual(candidate?.values, values);
  assert.equal(candidate.count,64);
  for (const options of [{start:16}, {end:16+60*2}, {maxScanBytes:16+60*2}]) {
    const clipped = discoverCalibrationCandidates(bytes, options);
    assert.ok(!clipped.candidates.some(value => value.endian === 'big' && (value.offset === 14 || value.offset === 16)));
  }
  const tooLong = imageWithSeries(Array.from({length:65}, (_,index)=>(index+1)*400));
  new DataView(tooLong.buffer).setUint16(14,65,false);
  assert.ok(!discoverCalibrationCandidates(tooLong).candidates.some(value => value.endian === 'big' && (value.offset===14 || value.offset===16)));
});
