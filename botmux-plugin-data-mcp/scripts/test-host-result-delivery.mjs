import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareHostResultDelivery, useProtectedHostDelivery } from '../src/mcp/host-result-delivery.js';
import { ResultStore } from '../src/mcp/result-store.js';

const home = mkdtempSync(join(tmpdir(), 'host-result-envelope-'));
const before = process.env.PATH;
const caller = { source: 'gateway_meta', requestLarkAppId: 'cli_fixture', requestUserUnionId: 'on_fixture',
  senderType: 'user', turnId: 'om_fixture', hostCapabilities: ['result_delivery_receipt_only_v1'] };
try {
  mkdirSync(join(home, 'outbound'));
  // A protected handoff must not need any sending executable or credentials.
  process.env.PATH = join(home, 'no-executables');
  const file = join(home, 'outbound', 'result.xlsx'); writeFileSync(file, 'SYNTHETIC_EXCEL');
  const delivery = { deliveryId: `data-result-${randomUUID()}`, markdown: 'SYNTHETIC_PRIVATE_BODY', files: [{ path: file }] };
  const result = prepareHostResultDelivery(caller, delivery, home);
  assert.equal(result._meta.botmuxHostDelivery.readPolicy, 'receipt-only');
  assert.equal(result._meta.botmuxHostDelivery.files[0].path, realpathSync(file));
  assert.equal(result._meta.botmuxHostDelivery.markdown, delivery.markdown);
  assert(!JSON.stringify(result.content).includes(delivery.markdown));
  assert(!JSON.stringify(result.content).includes(home));
  assert(existsSync(file), 'source belongs to host custody transfer, not early plugin cleanup');
  assert.equal(prepareHostResultDelivery(caller, { ...delivery, responseKind: 'auxiliary' }, home)._meta.botmuxHostDelivery.responseKind, 'auxiliary');
  assert.equal(useProtectedHostDelivery(caller), true);
  assert.equal(useProtectedHostDelivery({ ...caller, hostCapabilities: [] }), false);
  assert.equal(useProtectedHostDelivery(caller, 'legacy'), false);
  assert.throws(() => useProtectedHostDelivery({ ...caller, hostCapabilities: [] }, 'receipt-only'), /host_required/);
  assert.throws(() => useProtectedHostDelivery(caller, 'other'), /invalid_result_delivery_policy/);
  for (const change of [{ senderType: 'bot' }, { source: 'prompt' }, { requestUserUnionId: '' }, { taskId: 'schedule' }, { turnId: '../other' }]) {
    assert.throws(() => prepareHostResultDelivery({ ...caller, ...change }, delivery, home), /identity_rejected/);
  }
  assert.throws(() => prepareHostResultDelivery(caller, { ...delivery, files: [{ path: '/etc/passwd' }] }, home), /attachment_failed/);
  assert.throws(() => prepareHostResultDelivery(caller, { ...delivery, deliveryId: 'wrong' }, home), /delivery_id/);
  console.log('protected host envelope contract passed');
} finally { process.env.PATH = before; rmSync(home, { recursive: true, force: true }); }
