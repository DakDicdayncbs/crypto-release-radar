#!/usr/bin/env node
import { runCli } from '../src/cli.js';

// A closed downstream pipe (e.g. `... | head`) is a normal CLI termination.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error.code === 'EPIPE') process.exit(0);
    process.exit(2);
  });
}
process.exitCode = await runCli(process.argv.slice(2));
