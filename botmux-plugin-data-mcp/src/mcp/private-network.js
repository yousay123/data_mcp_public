import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export function isPrivateModelAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    return octets[0] === 127
      || octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168);
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd');
  }
  return false;
}

export async function resolvePrivateModelAddress(hostname, lookup = dnsLookup) {
  const results = await lookup(hostname, { all: true, verbatim: true });
  if (!results.length || results.some(result => !isPrivateModelAddress(result.address))) {
    throw new Error('result_model_network_not_private');
  }
  return results[0];
}
