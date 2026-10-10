import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute } from 'node:path';
import { RadarError } from './errors.js';

const fail = (code, message) => new RadarError(code, message);
const changed = () => fail('output_changed', 'Output or input paths changed; report was not published.');
const protectedInput = () => fail('output_input', 'Output must not replace an input file or its aliases.');
const exists = () => fail('output_exists', 'Output already exists. Use --overwrite only for an ordinary report file.');
const same = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;
const samePath = (a, b) => a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase();
const version = (a, b) => same(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const missingStat = async (path, io) => {
  try { return await io.lstat(path, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

export function validateOutputPath(path) {
  if (typeof path !== 'string' || !path.trim() || /[\x00-\x1f\x7f]/u.test(path)
    || path.endsWith('/') || ['.', '..'].includes(basename(path))) {
    throw fail('usage', '--output requires a file path without control characters or a trailing directory component.');
  }
}

// Preserve the original component traversal. path.resolve() would collapse
// symlink/.. before the OS resolves the symlink, potentially choosing another file.
export async function resolveFilePath(path, io = fs) {
  const absolute = isAbsolute(path) ? path : process.cwd() + '/' + path;
  const rawParent = dirname(absolute), name = basename(absolute);
  const parent = await io.realpath(rawParent);
  const parentIdentity = await io.lstat(parent, { bigint: true });
  if (!parentIdentity.isDirectory() || ['.', '..', ''].includes(name)) {
    throw fail('output_path', 'Cannot prepare output. Its parent must be an existing accessible directory.');
  }
  return { rawParent, parent, parentIdentity, path: parent + '/' + name };
}

async function checkParent(file, io) {
  if (await io.realpath(file.rawParent) !== file.parent
    || !same(await io.lstat(file.parent, { bigint: true }), file.parentIdentity)) throw changed();
}

async function checkTarget(target, input, overwrite, io) {
  await checkParent(target, io);
  await checkParent(input, io);
  if (samePath(target.path, input.path)) throw protectedInput();
  const currentInput = await missingStat(input.path, io);
  if (currentInput && !currentInput.isFile()) throw changed();
  const destination = await missingStat(target.path, io);
  if (destination) {
    if (!destination.isFile()) throw fail('output_type', 'Output must be an ordinary file, never a symlink, directory or special file.');
    if (same(destination, input.identity) || same(destination, currentInput)) throw protectedInput();
    if (!overwrite) throw exists();
  }
  return destination;
}

// Read-only preparation happens before credentials or requests. io/name are
// internal deterministic test seams, not CLI options or alternate FS backends.
export async function prepareOutput(path, { overwrite = false, input, io = fs, name = randomUUID } = {}) {
  try {
    validateOutputPath(path);
    if (!['linux', 'darwin'].includes(process.platform) || !constants.O_NOFOLLOW || !constants.O_NONBLOCK) {
      throw fail('output_platform', 'Atomic file output requires supported Linux or macOS filesystem operations.');
    }
    const target = await resolveFilePath(path, io);
    if (input?.identity?.dev === undefined || input?.identity?.ino === undefined) throw protectedInput();
    const initial = await checkTarget(target, input, overwrite, io);
    return { target, input, initial, overwrite, io, name };
  } catch (error) {
    if (error instanceof RadarError) throw error;
    throw fail('output_path', 'Cannot prepare output. Its parent must be an existing accessible directory.');
  }
}

export async function writeOutput(plan, text) {
  const { target, input, initial, overwrite, io, name } = plan;
  const bytes = Buffer.from(text, 'utf8');
  let temp, handle, identity, closed = false, published = false, renamed = false, failure;
  const checkUnchanged = async () => {
    const current = await checkTarget(target, input, overwrite, io);
    if (initial ? !version(initial, current) : current !== null) throw changed();
  };
  const ownTemp = async () => {
    await checkParent(target, io);
    const current = await missingStat(temp, io);
    if (!current?.isFile() || !same(current, identity)) throw changed();
    return current;
  };
  try {
    await checkUnchanged();
    for (let attempt = 0; attempt < 8; attempt++) {
      const suffix = name();
      if (!/^[a-zA-Z0-9-]{1,64}$/u.test(suffix)) throw changed();
      const candidate = target.parent + '/.radar-output-' + suffix + '.tmp';
      // Also avoid a case-insensitive collision with the destination itself.
      if ([target.path, input.path].some(path => samePath(path, candidate))) continue;
      try {
        handle = await io.open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
        temp = candidate; // Only a successful exclusive open establishes ownership.
        break;
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    if (!handle) throw new Error();
    identity = await handle.stat({ bigint: true });
    if (!identity.isFile()) throw changed();
    await handle.chmod(0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > bytes.length - offset) throw new Error();
      offset += bytesWritten;
    }
    await handle.sync();
    closed = true; // Never retry an ambiguous close on a possibly reused descriptor.
    await handle.close();
    const ready = await ownTemp();
    if (ready.size !== BigInt(bytes.length) || ready.nlink !== 1n || (ready.mode & 0o777n) !== 0o600n) throw changed();
    await checkUnchanged();
    if (initial) {
      await io.rename(temp, target.path);
      renamed = published = true;
    } else {
      // link is atomic no-clobber, including when another writer wins after our
      // final check. Never fall back to a copy, truncation, or unlink-then-rename.
      await io.link(temp, target.path);
      published = true;
    }
  } catch (error) {
    failure = error instanceof RadarError ? error
      : fail('output_write', 'Cannot write or publish report; existing output was not replaced.');
  } finally {
    if (handle && !closed) {
      try { closed = true; await handle.close(); }
      catch { failure = fail('output_write', 'Cannot close temporary report; existing output was not replaced.'); }
    }
    if (temp && !renamed) {
      try { await ownTemp(); await io.unlink(temp); }
      catch {
        failure = fail('output_cleanup', published
          ? 'Report was published, but temporary-file cleanup failed. Output was not rolled back.'
          : 'Report was not published; temporary-file cleanup failed. Existing output was not replaced.');
      }
    }
  }
  if (failure) throw failure;
}
