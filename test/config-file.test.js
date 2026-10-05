import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { appendFile, lstat, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { MAX_CONFIG_BYTES, MAX_CONFIG_DEPTH, readConfigValue } from '../src/config-file.js';
import { readConfig, validateConfig } from '../src/config.js';
import { maximumDefinitions } from '../test-support/config-corpus.js';

const basic = '{"repositories":["a/b"]}';
const bin = fileURLToPath(new URL('../bin/crypto-release-radar.js', import.meta.url));
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'radar-bounds-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, 'private-sentinel.json') };
}
const hasCode = code => error => {
  assert.equal(error.code, code);
  assert.ok(!error.message.includes('private-sentinel'));
  return true;
};
const pad = (text, bytes = MAX_CONFIG_BYTES) => text + ' '.repeat(bytes - Buffer.byteLength(text));

test('file byte boundary includes whitespace and UTF-8 bytes; exactly 128 KiB passes the reader', async t => {
  const { path } = await fixture(t);
  assert.equal(MAX_CONFIG_BYTES, 131072);
  const exact = pad('\r\n' + basic + '\t\r\n');
  await writeFile(path, exact);
  assert.deepEqual(await readConfig(path), validateConfig(JSON.parse(basic)));
  await appendFile(path, ' ');
  await assert.rejects(readConfig(path), hasCode('config_size'));
  const unicode = pad('{"repositories":["a/b"],"private-sentinel":"é🚀"}');
  assert.ok(unicode.length < MAX_CONFIG_BYTES);
  await writeFile(path, unicode);
  assert.equal((await readConfigValue(path))['private-sentinel'], 'é🚀');
  await assert.rejects(readConfig(path), hasCode('invalid_config'));
  await appendFile(path, '\n');
  await assert.rejects(readConfig(path), hasCode('config_size'));
});

test('both examples and 220 maximum-length entries with policies fit, including mixed lists', async t => {
  const { path } = await fixture(t);
  for (const name of ['repos', 'groups']) await readConfig(new URL(`../examples/${name}.json`, import.meta.url));
  const mixed = structuredClone(maximumDefinitions);
  for (const list of [mixed.repositories, ...Object.values(mixed.groups)]) {
    for (let i = 0; i < list.length; i += 2) list[i] = list[i].slug;
  }
  for (const value of [maximumDefinitions, mixed]) {
    const text = JSON.stringify(value, null, 4) + '\n';
    assert.ok(Buffer.byteLength(text) < MAX_CONFIG_BYTES);
    await writeFile(path, text);
    assert.deepEqual(await readConfig(path), validateConfig(value));
  }
});

test('size checks reject metadata overflow before allocating/reading or immediately after open', async () => {
  let opens = 0, reads = 0, closes = 0;
  const regular = size => ({ isFile: () => true, size });
  const io = {
    lstat: async () => regular(MAX_CONFIG_BYTES + 1),
    open: async () => { opens++; return {
      stat: async () => regular(MAX_CONFIG_BYTES + 1),
      read: async () => { reads++; throw new Error('private-sentinel'); },
      close: async () => { closes++; },
    }; },
  };
  await assert.rejects(readConfigValue('private-sentinel', io), hasCode('config_size'));
  assert.equal(opens, 0); assert.equal(reads, 0); assert.equal(closes, 0);
  io.lstat = async () => regular(0);
  await assert.rejects(readConfigValue('private-sentinel', io), hasCode('config_size'));
  assert.equal(opens, 1); assert.equal(reads, 0); assert.equal(closes, 1);
});

test('actual reads remain bounded with stale stat sizes and repeated short reads', async () => {
  for (const extra of [0, 1, 10000]) {
    const data = Buffer.from(pad(basic, MAX_CONFIG_BYTES + extra));
    let consumed = 0, closes = 0, firstBuffer;
    const regular = () => ({ isFile: () => true, size: 0 });
    const io = { lstat: async () => regular(), open: async (_path, flags) => {
      assert.ok(flags & constants.O_NONBLOCK); assert.ok(flags & constants.O_NOFOLLOW);
      assert.equal(flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC), 0);
      return {
        stat: async () => regular(),
        read: async (buffer, offset, length, position) => {
          firstBuffer ??= buffer;
          assert.equal(buffer, firstBuffer); assert.equal(buffer.length, MAX_CONFIG_BYTES + 1);
          assert.equal(position, consumed); assert.equal(offset, consumed);
          assert.ok(length <= MAX_CONFIG_BYTES + 1 - consumed);
          const bytesRead = Math.min(113, length, data.length - position);
          data.copy(buffer, offset, position, position + bytesRead);
          consumed += bytesRead;
          return { bytesRead, buffer };
        },
        close: async () => { closes++; },
      };
    } };
    if (extra) await assert.rejects(readConfigValue('private-sentinel', io), hasCode('config_size'));
    else assert.deepEqual(await readConfigValue('private-sentinel', io), JSON.parse(basic));
    assert.equal(consumed, MAX_CONFIG_BYTES + Math.min(extra, 1));
    assert.equal(closes, 1);
  }
});

test('growth during actual file reads cannot evade the byte limit and closes the handle', async t => {
  const { path } = await fixture(t);
  await writeFile(path, pad(basic, 16384));
  let handle, reads = 0, consumed = 0;
  const io = { lstat, open: async (...args) => {
    handle = await open(...args);
    return {
      stat: () => handle.stat(), close: () => handle.close(),
      read: async (buffer, offset, length, position) => {
        const result = await handle.read(buffer, offset, Math.min(length, 4096), position);
        consumed += result.bytesRead;
        if (++reads === 1) await appendFile(path, ' '.repeat(MAX_CONFIG_BYTES));
        return result;
      },
    };
  } };
  await assert.rejects(readConfigValue(path, io), hasCode('config_size'));
  assert.equal(consumed, MAX_CONFIG_BYTES + 1);
  assert.equal(handle.fd, -1);
});

test('post-read stat catches growth observed after EOF, without another unbounded read', async () => {
  let stats = 0, reads = 0, closes = 0;
  const io = {
    lstat: async () => ({ isFile: () => true, size: 0 }),
    open: async () => ({
      stat: async () => ({ isFile: () => true, size: ++stats === 1 ? 0 : MAX_CONFIG_BYTES + 1 }),
      read: async () => { reads++; return { bytesRead: 0 }; },
      close: async () => { closes++; },
    }),
  };
  await assert.rejects(readConfigValue('private-sentinel', io), hasCode('config_size'));
  assert.equal(reads, 1); assert.equal(closes, 1);
});

test('depth guard runs before JSON.parse, counts containers inclusively and handles malformed deep input', async t => {
  const { path } = await fixture(t);
  assert.equal(MAX_CONFIG_DEPTH, 8);
  for (const [prefix, suffix] of [['[', ']'], ['{"x":', '}']]) {
    const exact = prefix.repeat(8) + '0' + suffix.repeat(8);
    await writeFile(path, exact);
    assert.deepEqual(await readConfigValue(path), JSON.parse(exact));
    await assert.rejects(readConfig(path), hasCode('invalid_config'));
    for (const depth of [9, 10000]) {
      for (const end of [suffix.repeat(depth), '']) {
        await writeFile(path, prefix.repeat(depth) + '0' + end);
        let parses = 0;
        const mock = t.mock.method(JSON, 'parse', () => { parses++; throw new Error('should not parse'); });
        try { await assert.rejects(readConfigValue(path), hasCode('config_depth')); }
        finally { mock.mock.restore(); }
        assert.equal(parses, 0);
      }
    }
  }
});

test('quoted delimiters, escaped quotes/backslashes and Unicode escapes do not count as containers', async t => {
  const { path } = await fixture(t);
  for (const value of ['[{'.repeat(10000), ']}'.repeat(10000), '\\"[{}]\\\\', 'é🚀\r\n\u2028', '"\\'.repeat(30)]) {
    const text = JSON.stringify({ 'private-sentinel': value });
    await writeFile(path, text);
    assert.deepEqual(await readConfigValue(path), JSON.parse(text));
    await assert.rejects(readConfig(path), hasCode('invalid_config'));
  }
  const escaped = '{"repositories":["a\\u002fb"],"\\u006cimit":1}';
  await writeFile(path, escaped);
  assert.deepEqual(await readConfig(path), validateConfig({ repositories: ['a/b'], limit: 1 }));
  for (const text of ['', ' ', '{]', '[}', '][', '[', '{"x":"unfinished\\', '{"x":"[[]]', '{"x":"\\q"}', '{"x":"raw\nnewline"}', '{}{}', '{"private-sentinel":}', '[1,]', '{"x":01}']) {
    await writeFile(path, text);
    await assert.rejects(readConfigValue(path), hasCode('config_syntax'));
  }
});

test('strict UTF-8 rejects bad encodings and a leading BOM without replacement or stripping', async t => {
  const { path } = await fixture(t);
  for (const bytes of [
    Buffer.from([0xc0, 0xaf]), Buffer.from([0x80]), Buffer.from([0xe2, 0x82]),
    Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xf4, 0x90, 0x80, 0x80]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(basic)]),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(basic, 'utf16le')]),
    Buffer.concat([Buffer.from('{"private-sentinel":"'), Buffer.from([0xff]), Buffer.from('"}')]),
  ]) {
    await writeFile(path, bytes);
    await assert.rejects(readConfig(path), hasCode('config_encoding'));
    assert.deepEqual(await readFile(path), bytes);
  }
});

test('missing files, directories, devices and final symlinks fail; parent-directory symlinks may resolve', async t => {
  const { path, dir } = await fixture(t);
  await assert.rejects(readConfig(path), hasCode('config_read'));
  await assert.rejects(readConfig(dir), hasCode('config_read'));
  await assert.rejects(readConfig('/dev/null'), hasCode('config_read'));
  await writeFile(path, basic);
  const link = join(dir, 'private-sentinel-link');
  await symlink(path, link);
  await assert.rejects(readConfig(link), hasCode('config_read'));
  await symlink(join(dir, 'missing'), join(dir, 'dangling'));
  await assert.rejects(readConfig(join(dir, 'dangling')), hasCode('config_read'));
  await symlink(dir, join(dir, 'parent'));
  assert.deepEqual(await readConfig(join(dir, 'parent', 'private-sentinel.json')), validateConfig(JSON.parse(basic)));
  assert.equal(await readFile(path, 'utf8'), basic);
});

test('FIFO is rejected promptly in scan and validation mode without a writer', async t => {
  const { path } = await fixture(t);
  const fifo = spawnSync('mkfifo', [path], { encoding: 'utf8', timeout: 3000 });
  assert.equal(fifo.status, 0, fifo.stderr);
  for (const options of [[], ['--validate-config'], ['--format', 'json']]) {
    const result = spawnSync(process.execPath, [bin, '--config', path, ...options], {
      encoding: 'utf8', timeout: 3000, env: { ...process.env, GITHUB_TOKEN: 'invalid\nprivate-sentinel' },
    });
    assert.equal(result.error, undefined, 'must not hang opening FIFO');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^config_read:/);
    assert.ok(!result.stderr.includes('private-sentinel'));
  }
});

test('open races to a FIFO or symlink are rejected without blocking or reading the replacement', async t => {
  const { path, dir } = await fixture(t);
  const target = join(dir, 'replacement');
  await writeFile(target, basic);
  for (const replacement of ['fifo', 'symlink']) {
    await writeFile(path, basic);
    // Bound the subprocess so a regression in open flags cannot hang the suite.
    const script = `
      import assert from 'node:assert/strict';
      import { lstat, open, rm, symlink } from 'node:fs/promises';
      import { spawnSync } from 'node:child_process';
      import { readConfigValue } from ${JSON.stringify(new URL('../src/config-file.js', import.meta.url).href)};
      const [path, target, replacement] = process.argv.slice(1);
      let handle;
      const io = { lstat, open: async (...args) => {
        await rm(path);
        if (replacement === 'fifo') assert.equal(spawnSync('mkfifo', [path]).status, 0);
        else await symlink(target, path);
        handle = await open(...args);
        return handle;
      } };
      await assert.rejects(readConfigValue(path, io), { code: 'config_read' });
      if (handle) assert.equal(handle.fd, -1);
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, path, target, replacement], { timeout: 3000, encoding: 'utf8' });
    assert.equal(result.error, undefined, 'raced open must not block');
    assert.equal(result.status, 0, result.stderr);
    await rm(path);
  }
});

test('every opened descriptor closes on success, decoding, syntax and semantic failure; input is unchanged', async t => {
  const { path, dir } = await fixture(t);
  for (const content of [basic, '{"limit":1}', '[', '[['.repeat(10), Buffer.from([0xff])]) {
    await writeFile(path, content, { mode: 0o600 });
    const before = await stat(path), bytes = await readFile(path);
    let handle;
    const io = { lstat, open: async (...args) => { handle = await open(...args); return handle; } };
    try { validateConfig(await readConfigValue(path, io)); }
    catch (error) { assert.ok(['invalid_config', 'config_syntax', 'config_depth', 'config_encoding'].includes(error.code)); }
    assert.equal(handle.fd, -1);
    const after = await stat(path);
    assert.equal(after.mode, before.mode); assert.equal(after.mtimeMs, before.mtimeMs);
    assert.deepEqual(await readFile(path), bytes);
    assert.deepEqual(await readdir(dir), ['private-sentinel.json']);
  }
});

test('lstat/open/stat/read/close failures stay safe and opened descriptors receive close', async () => {
  for (const failure of ['lstat', 'open', 'stat', 'read', 'final-stat', 'close']) {
    let closes = 0, stats = 0;
    const fail = () => { throw new Error('private-sentinel path/token/system detail'); };
    const regular = { isFile: () => true, size: 0 };
    const io = {
      lstat: async () => failure === 'lstat' ? fail() : regular,
      open: async () => failure === 'open' ? fail() : {
        stat: async () => failure === 'stat' || (failure === 'final-stat' && ++stats === 2) ? fail() : regular,
        read: async () => failure === 'read' ? fail() : { bytesRead: 0 },
        close: async () => { closes++; if (failure === 'close') fail(); },
      },
    };
    await assert.rejects(readConfigValue('private-sentinel', io), hasCode('config_read'));
    assert.equal(closes, ['lstat', 'open'].includes(failure) ? 0 : 1);
  }
});
