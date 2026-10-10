import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import { RadarError } from './errors.js';

export const MAX_CONFIG_BYTES = 128 * 1024;
export const MAX_CONFIG_DEPTH = 8;
const readFailure = () => new RadarError('config_read', 'Cannot read config file. Pass --config with a readable JSON file.');
const sizeFailure = () => new RadarError('config_size', 'Config exceeds the 131072-byte limit.');
const syntaxFailure = () => new RadarError('config_syntax', 'Config is not valid JSON.');

async function readBoundedBytes(path, io, onOpened) {
  let handle;
  try {
    // Fail closed if the platform cannot protect open against symlink/FIFO races.
    if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK) throw readFailure();
    const before = await io.lstat(path);
    if (!before.isFile()) throw readFailure();
    if (before.size > MAX_CONFIG_BYTES) throw sizeFailure();
    handle = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (constants.O_NOCTTY ?? 0));
    const opened = await handle.stat(onOpened ? { bigint: true } : undefined);
    if (!opened.isFile()) throw readFailure();
    if (opened.size > MAX_CONFIG_BYTES) throw sizeFailure();
    onOpened?.({ dev: opened.dev, ino: opened.ino });
    // The extra byte detects overflow even if stat was stale or the file grows.
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > MAX_CONFIG_BYTES) throw sizeFailure();
    }
    if ((await handle.stat()).size > MAX_CONFIG_BYTES) throw sizeFailure();
    return buffer.subarray(0, length);
  } catch (error) {
    if (error instanceof RadarError) throw error;
    throw readFailure();
  } finally {
    if (handle) {
      try { await handle.close(); }
      catch { throw readFailure(); }
    }
  }
}

// Lexical guard only; JSON.parse still checks the complete JSON grammar. The
// stack never exceeds the depth limit, and quoted/escaped delimiters are ignored.
function checkNesting(text) {
  const stack = [];
  let quoted = false, escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') {
      if (stack.length === MAX_CONFIG_DEPTH) {
        throw new RadarError('config_depth', 'Config exceeds the maximum nesting depth of 8.');
      }
      stack.push(char);
    } else if (char === '}' || char === ']') {
      if (stack.pop() !== (char === '}' ? '{' : '[')) throw syntaxFailure();
    }
  }
  if (quoted || stack.length) throw syntaxFailure();
}

// The injected file operations are an internal test seam, never a CLI option.
export async function readConfigValue(path, io = { lstat, open }, onOpened) {
  const bytes = await readBoundedBytes(path, io, onOpened);
  let text;
  try {
    // Do not silently strip a leading UTF-8 BOM or replace malformed sequences.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.startsWith('\ufeff')) throw new Error();
  } catch {
    throw new RadarError('config_encoding', 'Config must be UTF-8 without a byte-order mark.');
  }
  checkNesting(text);
  try { return JSON.parse(text); }
  catch { throw syntaxFailure(); }
}
