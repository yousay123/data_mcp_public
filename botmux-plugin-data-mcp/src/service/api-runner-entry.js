import { runApiService } from './api-runner.js';

// PM2 fork mode imports the configured script from ProcessContainerFork.js,
// so process.argv[1] points at PM2's container rather than this file. Keep the
// executable entry separate from the import-safe runner module and invoke it
// unconditionally when PM2 loads this entry.
runApiService()
  .then(code => {
    // PM2 keeps an IPC channel open in fork mode. Merely assigning exitCode
    // leaves the runner alive and prevents autorestart after the API exits.
    process.exit(code);
  })
  .catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[data-mcp-api-runner] ${message}\n`, () => process.exit(1));
  });
