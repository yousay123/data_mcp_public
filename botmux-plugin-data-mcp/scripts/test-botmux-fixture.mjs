import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export function installFakeBotmux(root) {
  const bin = join(root, 'fake-botmux-bin');
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, 'botmux');
  writeFileSync(executable, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const fail = process.env.FAKE_BOTMUX_FAIL || '';
const log = process.env.FAKE_BOTMUX_LOG;
const record = { args };
const contentIndex = args.indexOf('--content-file');
if (contentIndex >= 0) record.content = readFileSync(args[contentIndex + 1], 'utf8');
if (log) appendFileSync(log, JSON.stringify(record) + '\\n');
if (args[0] === 'observe') {
  if (fail === 'observe') process.exit(2);
  const sessionIndex = args.indexOf('--session');
  const sessionId = args[sessionIndex + 1];
  console.log(JSON.stringify({
    probe: { status: 'ok' },
    identity: {
      sessionId,
      larkAppId: process.env.FAKE_BOTMUX_APP_ID,
      scope: process.env.FAKE_BOTMUX_SCOPE || 'chat',
    },
  }));
} else if (args[0] === 'send') {
  const requestedFiles = args.filter(arg => arg === '--files').length;
  if (fail === 'send' || (fail === 'file' && requestedFiles > 0) || (fail === 'text' && requestedFiles === 0)) process.exit(2);
  console.log(JSON.stringify({
    success: true,
    messageId: 'om_fixture_reply',
    attachmentMessageIds: Array.from({ length: requestedFiles }, (_, i) => 'om_file_' + i),
    failedAttachments: [],
  }));
} else {
  process.exit(2);
}
`, { mode: 0o700 });
  chmodSync(executable, 0o700);
  return {
    bin,
    env(extra = {}) {
      return {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH || ''}`,
        BOTMUX_SESSION_ID: 'session_synthetic',
        FAKE_BOTMUX_APP_ID: 'cli_synthetic',
        ...extra,
      };
    },
  };
}
