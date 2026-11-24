import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliverDirectLarkReply } from '../src/mcp/direct-lark-reply.js';
import { installFakeBotmux } from './test-botmux-fixture.mjs';

const root = mkdtempSync(join(tmpdir(), 'data-mcp-direct-reply-test-'));
const pluginHome = join(root, 'plugin-home');
const outbound = join(pluginHome, 'outbound');
const log = join(root, 'botmux.jsonl');
mkdirSync(outbound, { recursive: true });
const fixture = installFakeBotmux(root);
Object.assign(process.env, fixture.env({ FAKE_BOTMUX_LOG: log }));

function caller(turnId, extra = {}) {
  return {
    requestLarkAppId: 'cli_synthetic',
    senderType: 'user',
    turnId,
    ...extra,
  };
}

async function deliver(turnId, delivery = { markdown: `SYNTHETIC_${turnId}` }) {
  return deliverDirectLarkReply(caller(turnId), delivery, pluginHome);
}

for (const [id, scope] of [['om_topic', 'thread'], ['om_group', 'chat'], ['om_p2p', 'chat']]) {
  process.env.FAKE_BOTMUX_SCOPE = scope;
  await deliver(id);
}
let records = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
for (const id of ['om_topic', 'om_group', 'om_p2p']) {
  const send = records.find(row => row.args[0] === 'send' && row.args.includes(id));
  if (!send) throw new Error(`signed turnId was not used for ${id}`);
  if (!send.args.includes('--quote') || !send.args.includes('--response-kind') || !send.args.includes('final')) {
    throw new Error(`direct reply controls missing for ${id}`);
  }
  if (send.args.some(arg => /chat_id|open_id|receive_id/.test(arg))) {
    throw new Error('direct reply accepted an alternate delivery target');
  }
}
const observes = records.filter(row => row.args[0] === 'observe');
if (observes.length !== 3 || observes.some(row => !row.args.includes('session_synthetic'))) {
  throw new Error('session identity was not verified before every direct reply');
}

const workbook = join(outbound, 'synthetic.xlsx');
writeFileSync(workbook, 'SYNTHETIC_WORKBOOK_BYTES', { mode: 0o600 });
const receipt = await deliverDirectLarkReply(caller('om_file'), {
  markdown: 'SYNTHETIC_SUMMARY', files: [{ path: workbook }],
}, pluginHome);
if (!receipt.delivered || receipt.attachmentCount !== 1) throw new Error('attachment receipt mismatch');
records = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
const fileSend = records.find(row => row.args[0] === 'send' && row.args.includes('--files'));
if (!fileSend?.content.includes('SYNTHETIC_SUMMARY')
  || records.filter(row => row.args[0] === 'send' && row.args.includes('om_file')).length !== 1) {
  throw new Error('analysis and attachment must use one combined send');
}
for (const send of [fileSend]) {
  const quoteIndex = send.args.indexOf('--quote');
  if (quoteIndex < 0 || send.args[quoteIndex + 1] !== 'om_file') {
    throw new Error('every attachment delivery send must stay anchored to the signed turnId');
  }
}
if (fileSend.args[fileSend.args.indexOf('--response-kind') + 1] !== 'final') {
  throw new Error('combined delivery must finalize once');
}
const secondWorkbook = join(outbound, 'second.xlsx');
writeFileSync(secondWorkbook, 'SECOND_WORKBOOK');
await deliver('om_two_files', { markdown: '', files: [{ path: workbook }, { path: secondWorkbook }] });
records = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
const twoFiles = records.find(row => row.args[0] === 'send' && row.args.includes('om_two_files'));
if (!twoFiles?.content.trim() || twoFiles.args.filter(arg => arg === '--files').length !== 2) {
  throw new Error('multi-file delivery requires a primary card body');
}

const longReceipt = await deliverDirectLarkReply(caller('om_long'), { markdown: '数'.repeat(30_000) }, pluginHome);
if (!longReceipt.truncated || longReceipt.textBytes > 20_000) throw new Error('UTF-8 truncation limit failed');
const chartSpec = { data: { values: [{ x: 'a', y: 1 }, { x: 'b', y: 2 }] }, mark: 'line' };
const orderedCard = '| 日期 | 数量 |\n| --- | --- |\n| a | 1 |\n| b | 2 |\n\n```vega-lite\n'
  + JSON.stringify(chartSpec) + '\n```\n\n## 分析总结\n\n数量有所上升，建议持续观察。\n\n## 数据口径\n\n仅使用合成数据。';
await deliver('om_ordered_chart', { markdown: orderedCard });
records = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
if (records.find(row => row.args[0] === 'send' && row.args.includes('om_ordered_chart')).content !== orderedCard) {
  throw new Error('transport must preserve detail/chart/summary/scope order');
}
await deliver('om_long_chart', { markdown: '数'.repeat(30_000) + '\n\n```vega-lite\n' + JSON.stringify(chartSpec) + '\n```' });
records = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
const longChart = records.find(row => row.args[0] === 'send' && row.args.includes('om_long_chart'));
const preservedSpec = longChart.content.match(/```vega-lite\n([^]*?)\n```/u)?.[1];
if (!preservedSpec || JSON.parse(preservedSpec).data.values.length !== 2 || Buffer.byteLength(longChart.content) > 20_000) {
  throw new Error('truncation corrupted the native chart');
}
await deliver('om_oversize_scope', { markdown: '长'.repeat(30_000) + '\n\n' + orderedCard });
records = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
const scoped = records.find(row => row.args[0] === 'send' && row.args.includes('om_oversize_scope')).content;
if (!scoped.endsWith('仅使用合成数据。') || !scoped.includes('数量有所上升，建议持续观察。')
  || scoped.includes('长长长') || scoped.indexOf('```vega-lite') > scoped.indexOf('## 分析总结')) {
  throw new Error('oversized card must preserve complete paragraphs and keep scope last');
}

for (const rejected of [
  caller('turn_synthetic'),
  caller('om_bot', { senderType: 'bot' }),
  caller('om_schedule_source', { callerSource: 'schedule_creator' }),
  caller('om_recovery_source', { callerSource: 'failed_turn_recovery' }),
  caller('om_schedule_task', { taskId: 'task_1' }),
]) {
  let code;
  try { await deliverDirectLarkReply(rejected, { markdown: 'MUST_NOT_SEND' }, pluginHome); }
  catch (error) { code = error.code; }
  if (code !== 'direct_reply_identity_rejected') throw new Error('untrusted caller was not rejected');
}

process.env.FAKE_BOTMUX_APP_ID = 'cli_other';
let mismatch;
try { await deliver('om_identity'); } catch (error) { mismatch = error.code; }
if (mismatch !== 'direct_reply_bot_identity_mismatch') throw new Error('wrong bot identity did not fail closed');
process.env.FAKE_BOTMUX_APP_ID = 'cli_synthetic';

process.env.FAKE_BOTMUX_FAIL = 'observe';
let observeFailure;
try { await deliver('om_observe'); } catch (error) { observeFailure = error.code; }
delete process.env.FAKE_BOTMUX_FAIL;
if (observeFailure !== 'direct_reply_session_unavailable') throw new Error('session lookup failure did not fail closed');

process.env.FAKE_BOTMUX_FAIL = 'file';
let attachmentFailure;
try {
  await deliverDirectLarkReply(caller('om_partial'), {
    markdown: 'NO_FALSE_NOTICE', files: [{ path: workbook }],
  }, pluginHome);
} catch (error) { attachmentFailure = error.code; }
delete process.env.FAKE_BOTMUX_FAIL;
if (attachmentFailure !== 'direct_reply_attachment_failed') throw new Error('attachment failure code mismatch');
records = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
if (records.filter(row => row.content?.includes('NO_FALSE_NOTICE')).length !== 1) {
  throw new Error('failed combined send must not trigger an automatic resend');
}

for (const fileResult of ['failed-attachment', 'missing-message-id']) {
  process.env.FAKE_BOTMUX_FILE_RESULT = fileResult;
  let partialAttachmentFailure;
  try {
    await deliverDirectLarkReply(caller(`om_${fileResult.replaceAll('-', '_')}`), {
      markdown: `NO_FALSE_NOTICE_${fileResult}`,
      files: [{ path: workbook }],
    }, pluginHome);
  } catch (error) { partialAttachmentFailure = error.code; }
  delete process.env.FAKE_BOTMUX_FILE_RESULT;
  if (partialAttachmentFailure !== 'direct_reply_partial_delivery') {
    throw new Error(`partial attachment failure was accepted: ${fileResult}`);
  }
}
records = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
if (records.filter(row => row.content?.includes('NO_FALSE_NOTICE_failed-attachment')).length !== 1
  || records.filter(row => row.content?.includes('NO_FALSE_NOTICE_missing-message-id')).length !== 1) {
  throw new Error('partial attachment delivery must not automatically resend the card');
}

const outsideWorkbook = join(root, 'outside.xlsx');
writeFileSync(outsideWorkbook, 'OUTSIDE_OUTBOUND_BYTES', { mode: 0o600 });
let outsideFailure;
try {
  await deliverDirectLarkReply(caller('om_outside_file'), {
    markdown: 'MUST_NOT_SEND_OUTSIDE_FILE', files: [{ path: outsideWorkbook }],
  }, pluginHome);
} catch (error) { outsideFailure = error.code; }
if (outsideFailure !== 'direct_reply_attachment_failed') {
  throw new Error('regular file outside outbound was not rejected');
}

process.env.FAKE_BOTMUX_FAIL = 'send';
let partial;
try {
  await deliverDirectLarkReply(caller('om_partial_text'), {
    markdown: 'TEXT_FAILS_AFTER_FILE', files: [{ path: workbook }],
  }, pluginHome);
} catch (error) { partial = error.code; }
delete process.env.FAKE_BOTMUX_FAIL;
if (partial !== 'direct_reply_attachment_failed') throw new Error('unconfirmed delivery code mismatch');

console.log('direct Feishu reply tests passed');
