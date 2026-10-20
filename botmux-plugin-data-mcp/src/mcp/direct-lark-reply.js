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

function truncateUtf8(text, maxBytes = MAX_DIRECT_REPLY_TEXT_BYTES) {
  const encoded = Buffer.from(text);
  if (encoded.length <= maxBytes) return { text, bytes: encoded.length, truncated: false };
  const suffix = '\n\n[结果过长，已截断]';
  const suffixBytes = Buffer.byteLength(suffix);
  const budget = Math.max(0, maxBytes - suffixBytes);
  let end = budget;
  let prefix = '';
  while (end > 0) {
    try {
      prefix = new TextDecoder('utf-8', { fatal: true }).decode(encoded.subarray(0, end));
      break;
    } catch {
      end -= 1;
    }
  }
  const truncated = `${prefix}${suffix}`;
  return { text: truncated, bytes: Buffer.byteLength(truncated), truncated: true };
}

function assertOutboundFile(path, pluginHome) {
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

function successfulSend(result) {
  return result?.success === true && typeof result?.messageId === 'string';
}

export async function deliverDirectLarkReply(caller, delivery, pluginHome) {
  const identity = assertDirectReplyCaller(caller);
  await verifyBoundSession(identity.appId);
  const files = Array.isArray(delivery?.files)
    ? delivery.files.map(file => assertOutboundFile(file?.path, pluginHome))
    : [];
  if (files.length > 1) throw fixedError('direct_reply_attachment_failed');
  const baseText = typeof delivery?.markdown === 'string' ? delivery.markdown.trim() : '';
  const temporary = mkdtempSync(join(tmpdir(), 'data-mcp-direct-reply-'));
  let attachmentCount = 0;
  try {
    const bodyPath = join(temporary, 'reply.md');
    if (files.length === 1) {
      writeFileSync(bodyPath, '', { mode: 0o600 });
      let fileResult;
      try {
        fileResult = await runBotmux([
          'send', '--content-file', bodyPath, '--files', files[0],
          '--no-mention', '--response-kind', 'auxiliary',
          '--quote', identity.turnId,
        ]);
      } catch {
        throw fixedError('direct_reply_attachment_failed');
      }
      const failed = Array.isArray(fileResult.failedAttachments) ? fileResult.failedAttachments.length : 0;
      const sent = Array.isArray(fileResult.attachmentMessageIds) ? fileResult.attachmentMessageIds.length : 0;
      if (!successfulSend(fileResult) || failed > 0 || sent !== 1) {
        throw fixedError('direct_reply_attachment_failed');
      }
      attachmentCount = 1;
    }

    const withAttachmentNotice = attachmentCount > 0
      ? `${baseText}${baseText ? '\n\n' : ''}完整结果见附件。`
      : baseText;
    const prepared = truncateUtf8(withAttachmentNotice);
    writeFileSync(bodyPath, prepared.text, { mode: 0o600 });
    let textResult;
    try {
      textResult = await runBotmux([
        'send', '--content-file', bodyPath,
        '--no-mention', '--response-kind', attachmentCount > 0 ? 'progress' : 'auxiliary',
        '--quote', identity.turnId,
      ]);
    } catch {
      throw fixedError(
        attachmentCount > 0 ? 'direct_reply_partial_delivery' : 'direct_reply_transport_failed',
        { delivered: false, textBytes: 0, attachmentCount, truncated: prepared.truncated },
      );
    }
    if (!successfulSend(textResult)) {
      throw fixedError(
        attachmentCount > 0 ? 'direct_reply_partial_delivery' : 'direct_reply_transport_failed',
        { delivered: false, textBytes: 0, attachmentCount, truncated: prepared.truncated },
      );
    }
    return {
      delivered: true,
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
