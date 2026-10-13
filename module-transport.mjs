import {INITIALIZE} from './elm-protocol.mjs';

// MES CCAN29/BHCAN29 use ISO-TP with physical 29-bit addresses. ELM's
// runtime PB command avoids modifying the adapter's stored PP defaults.
// BHCAN29: protocol B options 01 (29-bit, ISO15765), divisor 04 (125 kbit/s).
export function buildModuleTransport(connection, channels) {
  if (!connection?.available || !['CCAN29','BHCAN29'].includes(connection.protocol)) throw new Error('This controller connection has not been verified.');
  if (!/^18DA[0-9A-F]{4}$/.test(connection.requestId) || !/^18DA[0-9A-F]{4}$/.test(connection.responseId)) throw new Error('Invalid controller address.');
  const body = connection.protocol === 'BHCAN29';
  const setup = [...INITIALIZE.slice(0,-1), ...(body ? ['ATPB0104'] : []), 'ATV1', body ? 'ATTPB' : 'ATTP7', 'ATAL',
    'ATCP18', `ATCRA${connection.responseId}`, `ATSH${connection.requestId.slice(2)}`, 'ATCFC1', 'ATAT1', 'ATST99'];
  const allowed = new Set([...setup, 'ATV0', connection.session, ...(connection.fallbackSession ? [connection.fallbackSession] : []),
    '3E00', connection.identityRequest, ...(connection.variantIdentityRequest?[connection.variantIdentityRequest]:[]), ...channels.filter(c=>c.available!==false).map(c=>c.request)]);
  return {setup, allowed, protocol:body ? 'B' : '7'};
}
