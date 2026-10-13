// These labels come from the supplied ALFA 8GMF reference catalogue. Matching a
// symbol identifies its saved reference meaning, not its location in another ECU.
const REFERENCE_SYMBOLS = new Map([
  ['PQAV', ['ignition', 'target', 'Base spark advance in Homogeneous mode']],
  ['PQAV_CNG', ['ignition', 'target', 'Base spark advance in Homogeneous mode for CNG']],
  ['PQLAMMP', ['fuel', 'target', 'Table for Base Hot Lambda']],
  ['PQLAMMPC', ['fuel', 'target', 'Table for Base Cold Lambda']],
  ['PQLAMMP_CNG', ['fuel', 'target', 'Table for Base Hot Lambda for CNG']],
  ['PQLAMMP_VVA', ['fuel', 'target', 'Table for Base Hot Lambda for VVA actuation mode']],
  ['PQLAM_MIN', ['fuel', 'limiter', 'Minimum Lambda Table']],
  ['TBDPREUTHDYN', ['boost', 'target', 'Upstream Throttle Pressure static target']],
  ['TBDUTYNQAHRP', ['boost', 'target', 'Nominal percentage opening wastegate Table on RP and QAH of compressor.']],
  ['TBDUTYNQAHRPCNG', ['boost', 'target', 'Nominal percentage opening wastegate Table on RP and QAH of compressor in event of CNG operation.']],
  ['TBRPCOMPLIM', ['boost', 'limiter', 'Compressor pressure ratio limit for pumping and speed']],
  ['TBDPTURBO', ['boost', 'unknown', 'Table for Turbo base delta pressure close to oxygen sensor']],
  ['KFILTRPBST', ['boost', 'unknown', 'RP compressor target low pass filter gain.']],
  ['TBACLOAD', ['boost', 'unknown', 'compressor load interpolation table']],
]);

const REFERENCE_DISPLAY_NAMES = new Map([
  ['TBDPREUTHDYN', 'Boost pressure target'],
  ['PQAV', 'Base ignition timing'],
  ['PQAV_CNG', 'Base ignition timing (CNG)'],
  ['PQLAMMP', 'Fuel mixture target — warm engine (lambda)'],
  ['PQLAMMPC', 'Fuel mixture target — cold engine (lambda)'],
  ['PQLAMMP_CNG', 'Fuel mixture target — warm engine (CNG, lambda)'],
  ['PQLAMMP_VVA', 'Fuel mixture target — warm engine (VVA, lambda)'],
  ['PQLAM_MIN', 'Minimum lambda'],
  ['TBDUTYNQAHRP', 'Wastegate opening target'],
  ['TBDUTYNQAHRPCNG', 'Wastegate opening target (CNG)'],
  ['TBRPCOMPLIM', 'Compressor pressure ratio limit'],
]);

const text = value => typeof value === 'string' ? value : '';
const normalized = value => value.slice(0, 8192).normalize('NFKD')
  .replace(/\p{M}/gu, '').toLowerCase().replace(/[_/\u2010-\u2015-]+/g, ' ').replace(/\s+/g, ' ').trim();

const ROLE_BLOCKERS = /\b(?:diagnosis|diagnostics?|diagnostica|faults?|errors?|enabl(?:e[ds]?|ing)|disabl(?:e[ds]?|ing)|flags?|switch(?:es)?|filter(?:ed|ing)?|filtro|gains?|guadagno|sensors?|sensore|thresholds?|sogli[ae]|tests?|testing|monitor(?:ing)?|counters?|hysteresis|isteresi|coefficients?|coefficienti?)\b/;
function namesDifferentSystem(value) {
  const source = normalized(value);
  return /\b(?:brake\s+boost(?:er)?|braking\s+boost|servofreno)\b/.test(source)
    || (/\bcompressor(?:e)?\b/.test(source) && /\b(?:air condition(?:ing|er)|aircon|a\s*[./]?\s*c|climatizzatore|condizionatore)\b/.test(source))
    || /\b(?:valve\s+timing|camshaft\s+(?:timing|advance)|(?:fase|anticipo).*\b(?:valvole|camme|distribuzione))\b/.test(source)
    || (/\b(?:upshift|downshift)\b/.test(source) && /\bfuel consumption\b/.test(source));
}

function labels(value) {
  const source = normalized(value), found = [];
  const brake = /\b(?:brak(?:e|ing)|servofreno|fren[oi])\b/.test(source);
  const airConditioning = /\b(?:air condition(?:ing|er)|aircon|a\s*[./]?\s*c|climatizzatore|condizionatore)\b/.test(source);
  const explicitTurbo = /\b(?:turbo(?:charger|charged)?|waste\s*gate|sovralimentazione|sovralimentato|turbocompressore)\b/.test(source);
  const boost = !brake && /\bboost\b/.test(source);
  const compressor = !airConditioning && /\bcompressor(?:e)?\b/.test(source)
    && /\b(?:ratio|rapporto|target|air\s*flow|load|carico|speed|velocita|pumping|pressure|pressione)\b/.test(source);
  const upstream = /\bupstream throttle pressure\b/.test(source) && !brake;
  if (explicitTurbo || boost || compressor || upstream) found.push({ category: 'boost', cue: 'turbo, boost or compressor control' });

  // Consumption is an outcome named by shift-advice and economy strategies; it
  // does not by itself identify fuel metering, injection or mixture calibration.
  const fuelSource = source.replace(/\bfuel consumption(?: reduction)?\b/g, '');
  const fuel = /\b(?:fuel|fuelling|fueling|lambda|afr|gasoline|petrol|benzina|carburante|iniezione|iniettori?|injection|injectors?)\b/.test(fuelSource)
    || /\b(?:air\s+fuel|fuel\s+air|aria\s+(?:benzina|carburante)|titolo\s+miscela)\b/.test(source);
  if (fuel) found.push({ category: 'fuel', cue: 'fuel, injection or mixture control' });

  const otherTiming = /\b(?:injection|injector|iniezione|iniettori?|valve|valvole|camshaft|camme|distribuzione)\b/.test(source);
  const ignition = /\b(?:spark|ignition|accensione|scintilla|detonazione)\b/.test(source)
    || /\bknock\s+(?:retard|control|correction)\b/.test(source)
    || (!otherTiming && /\banticipo\b/.test(source));
  if (ignition) found.push({ category: 'ignition', cue: 'spark or ignition control' });
  return found;
}

function roleFromLabel(value) {
  const source = normalized(value);
  // Filters, diagnostic thresholds and enable flags are not calibration targets
  // merely because their descriptions mention a target elsewhere in the system.
  if (ROLE_BLOCKERS.test(source)) return 'unknown';
  if (/\b(?:limiter|limit|limits|maximum|minimum|max|min|limitatore|limitatori|limite|massim[oa]|minim[oa])\b/.test(source)) return 'limiter';
  if (/\b(?:correction|compensation|compensazione|correzione|correzioni|reduction|riduzione|offset)\b/.test(source)) return 'correction';
  if (/\b(?:target|set\s*point|desired|requested|request|obiettivo|richiesta|richiesto|desiderata|desiderato)\b/.test(source)) return 'target';
  return 'unknown';
}

/** Organize existing source labels only; never identify a function from bytes or units. */
export function identifyMap(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const name = text(source.name), symbol = text(source.symbol);
  const key = symbol.trim().toUpperCase(), reference = REFERENCE_SYMBOLS.get(key);
  const displayName = name.trim() || (reference ? `${reference[2]} (${symbol.trim()})` : symbol.trim()) || 'Unnamed map';
  const base = { name, symbol, displayName };
  const unclassified = reason => ({ ...base, category: 'other', role: 'unknown', confidence: 'unclassified', reason });
  const identified = (category, role, reason) => ({ ...base,
    displayName: REFERENCE_DISPLAY_NAMES.get(key) ?? base.displayName,
    category, role, confidence: 'source-labelled', reason });
  const named = labels(name);

  if (!named.length && namesDifferentSystem(name))
    return unclassified('Saved name identifies a different system, such as brakes, air conditioning or valve timing; broad context does not override it.');

  if (named.length === 1) {
    if (reference && reference[0] !== named[0].category)
      return unclassified(`Saved name and known reference symbol ${key} identify different functions.`);
    const labelledRole = roleFromLabel(name);
    const role = ROLE_BLOCKERS.test(normalized(name)) ? 'unknown' : labelledRole !== 'unknown' ? labelledRole : reference?.[1] ?? 'unknown';
    return identified(named[0].category, role,
      `Saved name “${name.trim().slice(0, 220)}” identifies ${named[0].cue}${reference ? `; reference symbol ${key} agrees` : ''}.`);
  }
  if (named.length > 1 && (!reference || !named.some(item => item.category === reference[0])))
    return unclassified(`Saved name mentions multiple functions (${named.map(item => item.category).join(', ')}); no single map function is established.`);

  if (reference) return identified(reference[0], reference[1],
    `Known reference symbol ${key} labels “${reference[2]}”. This identifies reference metadata, not an ECU address match.`);

  // A non-semantic name can acquire context from a saved comment or folder. A
  // semantic name above always wins over broad folders or incidental comments.
  for (const field of ['comment', 'folder']) {
    const value = text(source[field]), matches = labels(value);
    if (matches.length > 1) return unclassified(`Saved ${field} mentions multiple functions; no single map function is established.`);
    if (matches.length === 1) return identified(matches[0].category, roleFromLabel(value),
      `Saved ${field} “${value.trim().slice(0, 220)}” identifies ${matches[0].cue}.`);
  }
  return unclassified('No specific boost, spark/ignition or fuel label was found. Units and raw values do not establish a map function.');
}
