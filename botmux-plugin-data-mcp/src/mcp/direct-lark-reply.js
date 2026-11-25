import { spawn } from 'node:child_process';
import {
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_DIRECT_REPLY_TEXT_BYTES = 20_000;
const BOTMUX_TIMEOUT_MS = 60_000;
const TURN_ID_PATTERN = /^om_[A-Za-z0-9_-]{3,200}$/;
const APP_ID_PATTERN = /^cli_[A-Za-z0-9_-]{3,200}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,200}$/;

export class DirectReplyError extends Error {
  constructor(code, receipt = {}) {
    super(code);
    this.name = 'DirectReplyError';
    this.code = code;
    this.receipt = receipt;
  }
}

function fixedError(code, receipt = {}) {
  return new DirectReplyError(code, receipt);
}

export function assertDirectReplyCaller(caller) {
  if (
    caller?.senderType !== 'user'
    || caller.callerSource
    || caller.taskId
    || !APP_ID_PATTERN.test(caller.requestLarkAppId || '')
    || !TURN_ID_PATTERN.test(caller.turnId || '')
  ) {
    throw fixedError('direct_reply_identity_rejected');
  }
  return {
    appId: caller.requestLarkAppId,
    turnId: caller.turnId,
  };
}

function runBotmux(args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = '';
    let settled = false;
    const child = spawn('botmux', args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      if (!settled) {
        settled = true;
        rejectPromise(fixedError('direct_reply_transport_failed'));
      }
    }, BOTMUX_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.setEncoding('utf8');
    child.stderr.resume();
    child.stdout.on('data', chunk => {
      if (stdout.length < 1_000_000) stdout += chunk;
    });
    child.once('error', () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        rejectPromise(fixedError('direct_reply_transport_failed'));
      }
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        rejectPromise(fixedError('direct_reply_transport_failed'));
        return;
      }
      try {
        resolvePromise(stdout.trim() ? JSON.parse(stdout) : {});
      } catch {
        rejectPromise(fixedError('direct_reply_transport_failed'));
      }
    });
  });
}

async function verifyBoundSession(appId) {
  const sessionId = process.env.BOTMUX_SESSION_ID;
  if (!SESSION_ID_PATTERN.test(sessionId || '')) throw fixedError('direct_reply_session_unavailable');
  let observed;
  try {
    observed = await runBotmux(['observe', '--session', sessionId]);
  } catch {
    throw fixedError('direct_reply_session_unavailable');
  }
  if (
    observed?.probe?.status !== 'ok'
    || observed?.identity?.sessionId !== sessionId
    || observed?.identity?.larkAppId !== appId
  ) {
    throw fixedError('direct_reply_bot_identity_mismatch');
  }
  return sessionId;
}

export function assertOutboundFile(path, pluginHome) {
  if (typeof path !== 'string' || !path || typeof pluginHome !== 'string' || !pluginHome) {
    throw fixedError('direct_reply_attachment_failed');
  }
  try {
    const outboundRoot = realpathSync(resolve(pluginHome, 'outbound'));
    const linkStat = lstatSync(path);
    const real = realpathSync(path);
    const rel = relative(outboundRoot, real);
    if (
      linkStat.isSymbolicLink()
      || !statSync(real).isFile()
      || isAbsolute(rel)
      || rel === '..'
      || rel.startsWith(`..${sep}`)
    ) {
      throw fixedError('direct_reply_attachment_failed');
    }
    return real;
  } catch (error) {
    if (error instanceof DirectReplyError) throw error;
    throw fixedError('direct_reply_attachment_failed');
  }
}

export function prepareCardText(text) {
  if (Buffer.byteLength(text) <= MAX_DIRECT_REPLY_TEXT_BYTES) {
    return { text, bytes: Buffer.byteLength(text), truncated: false };
  }
  const charts = [...text.matchAll(/```(?:vega-lite|vegalite)[ \t]*\r?\n[\s\S]*?\n```/gu)].map(match => match[0]);
  const chartText = `\n\n${charts.join('\n\n')}`;
  const chartBytes = Buffer.byteLength(chartText);
  // Never cut a JSON fence in half: a malformed fence loses the native chart.
  if (chartBytes > MAX_DIRECT_REPLY_TEXT_BYTES - 128) throw fixedError('direct_reply_text_too_large');
  const footerIndex = Math.max(text.lastIndexOf('\n## 数据口径\n'), text.lastIndexOf('\n---\n\n**数据口径**：'));
  const footer = footerIndex < 0 ? '' : text.slice(footerIndex);
  const footerBytes = Buffer.byteLength(footer);
  if (chartBytes + footerBytes > MAX_DIRECT_REPLY_TEXT_BYTES - 128) throw fixedError('direct_reply_text_too_large');
  const body = footerIndex < 0 ? text : text.slice(0, footerIndex);
  const protectedBlock = /(```(?:vega-lite|vegalite)[ \t]*\r?\n[\s\S]*?\n```)/gu;
  const budget = MAX_DIRECT_REPLY_TEXT_BYTES - chartBytes - footerBytes - Buffer.byteLength('\n\n[正文较长，部分段落未展示]');
  let remaining = budget; let omitted = false;
  const parts = body.split(protectedBlock).map(part => {
    if (/^```(?:vega-lite|vegalite)/u.test(part)) return part;
    return part.split(/\n\s*\n/u).filter(paragraph => {
      const bytes = Buffer.byteLength(paragraph) + 4;
      if (bytes > remaining) { omitted = true; return false; }
      remaining -= bytes; return true;
    }).join('\n\n');
  }).filter(Boolean);
  const prepared = parts.join('\n\n') + (omitted ? '\n\n[正文较长，部分段落未展示]' : '') + footer;
  return { text: prepared, bytes: Buffer.byteLength(prepared), truncated: omitted };
}

function successfulSend(result) {
  return result?.success === true && typeof result?.messageId === 'string';
}

export async function deliverDirectLarkReply(caller, delivery, pluginHome) {
  const identity = assertDirectReplyCaller(caller);
  await verifyBoundSession(identity.appId);
  const files = Array.isArray(delivery?.files)
    ? delivery.files.map(file => assertOutboundFile(file?.path, pluginHome))
    : [];
  if (files.length > 6) throw fixedError('direct_reply_attachment_failed');
  const baseText = typeof delivery?.markdown === 'string' ? delivery.markdown.trim() : '';
  const temporary = mkdtempSync(join(tmpdir(), 'data-mcp-direct-reply-'));
  try {
    const bodyPath = join(temporary, 'reply.md');
    // The host requires a primary card body when multiple files accompany a reply.
    // One send also keeps analysis and native charts in the same card.
    const prepared = prepareCardText(baseText || (files.length ? '查询结果文件见附件。' : '查询结果为空。'));
    writeFileSync(bodyPath, prepared.text, { mode: 0o600 });
    let textResult;
    try {
      textResult = await runBotmux([
        'send', '--content-file', bodyPath,
        ...files.flatMap(file => ['--files', file]),
        '--no-mention', '--response-kind', delivery?.responseKind === 'auxiliary' ? 'auxiliary' : 'final',
        '--quote', identity.turnId,
      ]);
    } catch {
      throw fixedError(
        files.length > 0 ? 'direct_reply_attachment_failed' : 'direct_reply_transport_failed',
        { delivered: false, textBytes: 0, attachmentCount: 0, truncated: prepared.truncated },
      );
    }
    if (!successfulSend(textResult)) {
      throw fixedError(
        'direct_reply_transport_failed',
        { delivered: false, textBytes: 0, attachmentCount: 0, truncated: prepared.truncated },
      );
    }
    const attachmentCount = Array.isArray(textResult.attachmentMessageIds) ? textResult.attachmentMessageIds.length : 0;
    if (attachmentCount !== files.length || textResult.failedAttachments?.length > 0) {
      throw fixedError('direct_reply_partial_delivery', {
        delivered: false, textBytes: prepared.bytes, attachmentCount, truncated: prepared.truncated,
        messageId: textResult.messageId,
        attachmentMessageIds: Array.isArray(textResult.attachmentMessageIds) ? textResult.attachmentMessageIds : [],
      });
    }
    return {
      delivered: true,
      deliveryId: delivery?.deliveryId,
      messageId: textResult.messageId,
      attachmentMessageIds: Array.isArray(textResult.attachmentMessageIds)
        ? textResult.attachmentMessageIds.filter(id => /^om_[A-Za-z0-9_-]+$/.test(id)) : [],
      textBytes: prepared.bytes,
      attachmentCount,
      truncated: prepared.truncated,
    };
  } catch (error) {
    if (error instanceof DirectReplyError) throw error;
    throw fixedError('direct_reply_transport_failed');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
