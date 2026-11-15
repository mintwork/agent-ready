#!/usr/bin/env node
import { main } from './cli.js';

// `agent-ready | head` closes stdout early; exit quietly instead of crashing on EPIPE.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EPIPE') process.stderr.write(`agent-ready: ${err.message}\n`);
  process.exit(err.code === 'EPIPE' ? 0 : 1);
});

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(
      `agent-ready crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exitCode = 2;
  },
);
