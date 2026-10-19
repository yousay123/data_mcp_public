import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const TEST_EXCEPTION_PATTERN = /^host=([^;]+);ip=([^;]+);expires=(\d{4}-\d{2}-\d{2})$/;

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

export function isProxyFakeIpAddress(address) {
  if (isIP(address) !== 4) return false;
  const octets = address.split('.').map(Number);
  return octets[0] === 198 && (octets[1] === 18 || octets[1] === 19);
}

export function parseResultModelTestException(value, now = Date.now()) {
  if (typeof value !== 'string' || !value) return null;
  const match = value.match(TEST_EXCEPTION_PATTERN);
  if (!match) return null;
  const [, hostname, address, expires] = match;
  if (
    hostname !== hostname.toLowerCase()
    || hostname.includes('*')
    || hostname.includes('/')
    || isIP(hostname)
    || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)
    || !isIP(address)
    || isPrivateModelAddress(address)
    || isProxyFakeIpAddress(address)
  ) {
    return null;
  }
  const [year, month, day] = expires.split('-').map(Number);
  const expiresAt = Date.UTC(year, month - 1, day + 1);
  const normalized = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
  if (normalized !== expires || !Number.isFinite(expiresAt) || now >= expiresAt) return null;
  return { hostname, address, expiresAt };
}

export async function resolvePrivateModelAddress(hostname, lookup = dnsLookup, options = {}) {
  const results = await lookup(hostname, { all: true, verbatim: true });
  if (results.length && results.every(result => isPrivateModelAddress(result.address))) {
    return { ...results[0], testExceptionUsed: false };
  }
  const exception = parseResultModelTestException(options.testException, options.now ?? Date.now());
  if (
    exception
    && hostname === exception.hostname
    && results.length === 1
    && results[0].address === exception.address
    && !isPrivateModelAddress(results[0].address)
    && !isProxyFakeIpAddress(results[0].address)
  ) {
    await options.onTestExceptionUsed?.(hostname);
    return { ...results[0], testExceptionUsed: true };
  }
  throw new Error('result_model_network_not_private');
}
