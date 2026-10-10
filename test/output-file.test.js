import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { prepareOutput, resolveFilePath, writeOutput } from '../src/output-file.js';
import { readConfigValue } from '../src/config-file.js';

const error = () => Object.assign(new Error('private-path-and-secret'), { code: 'EIO' });
const rejected = code => e => { assert.equal(e.code, code); assert.ok(!e.message.includes('private-')); return true; };
async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(tmpdir() + '/radar-output-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = dir + '/config.json', output = dir + '/report';
  await fs.writeFile(config, '{"repositories":["demo/one"]}');
  const input = await resolveFilePath(config);
  await readConfigValue(input.path, undefined, identity => { input.identity = identity; });
  const plan = options => prepareOutput(output, { input, ...options });
  return { dir, config, output, input, plan };
}
async function onlyInputAndReport(f) {
  assert.deepEqual((await fs.readdir(f.dir)).sort(), ['config.json', 'report']);
}

test('atomic new and overwrite output preserve full UTF-8 bytes, private mode, and old hardlink contents', async t => {
  const f = await fixture(t), bytes = 'é🚀\r\n"csv",\\json\n';
  await writeOutput(await f.plan(), bytes);
  assert.equal(await fs.readFile(f.output, 'utf8'), bytes);
  assert.equal((await fs.stat(f.output)).mode & 0o777, 0o600);
  const before = await fs.stat(f.output);
  await assert.rejects(f.plan(), rejected('output_exists'));
  await fs.link(f.output, f.dir + '/old-report');
  await writeOutput(await f.plan({ overwrite: true }), 'replacement\n');
  assert.equal(await fs.readFile(f.output, 'utf8'), 'replacement\n');
  assert.equal(await fs.readFile(f.dir + '/old-report', 'utf8'), bytes);
  assert.notEqual((await fs.stat(f.output)).ino, before.ino);
  assert.equal((await fs.stat(f.output)).mode & 0o777, 0o600);
  await fs.unlink(f.dir + '/old-report'); await onlyInputAndReport(f);
});

test('missing/non-directory parents are rejected read-only; no mkdir is attempted', async t => {
  const f = await fixture(t);
  const io = { ...fs, mkdir() { assert.fail('Never create directories'); }, open() { assert.fail('Preparation cannot create a file'); } };
  for (const path of [f.dir + '/missing/child/report', f.config + '/report']) {
    await assert.rejects(prepareOutput(path, { input: f.input, io }), rejected('output_path'));
  }
  assert.deepEqual(await fs.readdir(f.dir), ['config.json']);
  for (const operation of ['realpath', 'lstat']) {
    await assert.rejects(f.plan({ io: { ...fs, [operation]: async () => { throw error(); } } }), rejected('output_path'));
  }
});

test('no destination directory, final symlink (including dangling), FIFO or device is opened for writing', async t => {
  const f = await fixture(t);
  for (const kind of ['directory', 'symlink', 'dangling', 'fifo']) {
    if (kind === 'directory') await fs.mkdir(f.output);
    else if (kind === 'fifo') assert.equal(spawnSync('mkfifo', [f.output]).status, 0);
    else await fs.symlink(kind === 'dangling' ? f.dir + '/absent' : f.config, f.output);
    for (const overwrite of [false, true]) await assert.rejects(f.plan({ overwrite }), rejected('output_type'));
    if (kind === 'directory') await fs.rmdir(f.output); else await fs.unlink(f.output);
  }
  await assert.rejects(prepareOutput('/dev/null', { input: f.input, overwrite: true }), rejected('output_type'));
});

test('input protection covers normalized spellings, parent symlinks, hardlinks and OS symlink/.. traversal', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.dir + '/other');
  await fs.mkdir(f.dir + '/other/inside');
  await fs.symlink(f.dir + '/other/inside', f.dir + '/redirect');
  await fs.symlink(f.dir, f.dir + '/alias');
  await fs.link(f.config, f.output);
  for (const path of [f.config, f.dir + '/CONFIG.JSON', f.dir + '/./config.json', f.dir + '/other/../config.json', f.dir + '/alias/config.json', f.output]) {
    await assert.rejects(prepareOutput(path, { input: f.input, overwrite: true }), rejected('output_input'));
  }
  // Lexical resolution says dir/config.json; the OS reads other/config.json.
  await fs.link(f.config, f.dir + '/other/config.json');
  const tricky = f.dir + '/redirect/../config.json';
  const actual = await resolveFilePath(tricky);
  assert.equal(actual.path, f.dir + '/other/config.json');
  await assert.rejects(prepareOutput(tricky, { input: f.input, overwrite: true }), rejected('output_input'));
  await fs.unlink(f.dir + '/other/config.json');
  const plan = await prepareOutput(f.dir + '/redirect/../new-report', { input: f.input });
  await writeOutput(plan, 'actual parent\n');
  assert.equal(await fs.readFile(f.dir + '/other/new-report', 'utf8'), 'actual parent\n');
  await assert.rejects(fs.stat(f.dir + '/new-report'), { code: 'ENOENT' });
});

test('protection retains actual opened input inode after path replacement during reading and protects its new occupant too', async t => {
  const f = await fixture(t);
  let replaced = false;
  const original = await fs.readFile(f.config, 'utf8');
  const io = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    return { stat: (...a) => handle.stat(...a), close: () => handle.close(), read: async (...a) => {
      if (!replaced) {
        replaced = true;
        await fs.rename(f.config, f.output);
        await fs.writeFile(f.config, '{"repositories":["demo/replaced"]}');
      }
      return handle.read(...a);
    } };
  } };
  const input = await resolveFilePath(f.config);
  const value = await readConfigValue(input.path, io, identity => { input.identity = identity; });
  assert.deepEqual(value, JSON.parse(original));
  assert.notEqual(input.identity.ino, (await fs.stat(f.config, { bigint: true })).ino);
  await assert.rejects(prepareOutput(f.output, { input, overwrite: true }), rejected('output_input'));
  await fs.link(f.config, f.dir + '/new-alias');
  await assert.rejects(prepareOutput(f.dir + '/new-alias', { input, overwrite: true }), rejected('output_input'));
  await assert.rejects(prepareOutput(f.config, { input, overwrite: true }), rejected('output_input'));
  assert.equal(await fs.readFile(f.output, 'utf8'), original);
});

test('short writes use exact byte offsets and fsync/close finish before atomic publication', async t => {
  const f = await fixture(t), events = [], contents = '🚀'.repeat(10) + '\r\n';
  const io = { ...fs, open: async (path, flags, mode) => {
    assert.ok(flags & constants.O_EXCL); assert.ok(flags & constants.O_NOFOLLOW);
    assert.ok(!(flags & constants.O_TRUNC)); assert.equal(mode, 0o600);
    const handle = await fs.open(path, flags, mode);
    let offset = 0;
    return { stat: (...a) => handle.stat(...a), chmod: (...a) => handle.chmod(...a),
      write: async (buffer, start, length, position) => {
        assert.equal(start, offset); assert.equal(position, offset); assert.equal(length, buffer.length - offset);
        const result = await handle.write(buffer, start, Math.min(3, length), position);
        offset += result.bytesWritten; events.push('write'); return result;
      }, sync: async () => { events.push('sync'); await handle.sync(); },
      close: async () => { events.push('close'); await handle.close(); },
    };
  }, link: async (...args) => { assert.deepEqual(events.slice(-2), ['sync', 'close']); events.push('link'); return fs.link(...args); } };
  await writeOutput(await f.plan({ io }), contents);
  assert.equal(await fs.readFile(f.output, 'utf8'), contents);
  assert.equal(events.filter(x => x === 'write').length, 14); await onlyInputAndReport(f);
});

for (const operation of ['open', 'stat', 'chmod', 'write', 'zero-write', 'negative-write', 'large-write', 'fractional-write', 'sync', 'close', 'link', 'rename']) {
  test(`${operation} failure does not publish or damage prior output and removes only owned temp`, async t => {
    const f = await fixture(t), replacing = operation !== 'link';
    if (replacing) await fs.writeFile(f.output, 'OLD');
    const handles = [];
    const io = { ...fs, open: async (...args) => {
      if (operation === 'open') throw error();
      const handle = await fs.open(...args); handles.push(handle);
      return { stat: async (...a) => { if (operation === 'stat') throw error(); return handle.stat(...a); },
        chmod: async (...a) => { if (operation === 'chmod') throw error(); return handle.chmod(...a); },
        write: async (buffer, offset, length, position) => {
          if (operation === 'write') { await handle.write(buffer, offset, 1, position); throw error(); }
          if (operation.endsWith('-write')) return { bytesWritten: { 'zero-write': 0, 'negative-write': -1, 'large-write': length + 1, 'fractional-write': 0.5 }[operation] };
          return handle.write(buffer, offset, length, position);
        }, sync: async () => { if (operation === 'sync') throw error(); return handle.sync(); },
        close: async () => { await handle.close(); if (operation === 'close') throw error(); },
      };
    }, link: async (...a) => { if (operation === 'link') throw error(); return fs.link(...a); },
    rename: async (...a) => { if (operation === 'rename') throw error(); return fs.rename(...a); } };
    await assert.rejects(writeOutput(await f.plan({ overwrite: replacing, io }), 'NEW'), rejected(operation === 'stat' ? 'output_cleanup' : 'output_write'));
    assert.ok(handles.every(h => h.fd === -1));
    if (replacing) assert.equal(await fs.readFile(f.output, 'utf8'), 'OLD');
    else await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
    const files = await fs.readdir(f.dir);
    // If fstat itself failed, ownership cannot be reverified safely for unlink.
    assert.equal(files.filter(p => p.startsWith('.radar-output-')).length, operation === 'stat' ? 1 : 0);
  });
}

test('exclusive temp collisions are bounded, never unlinked, and a later unique name can succeed', async t => {
  const f = await fixture(t), collision = f.dir + '/.radar-output-collision.tmp';
  await fs.writeFile(collision, 'FOREIGN');
  let calls = 0;
  await assert.rejects(writeOutput(await f.plan({ name: () => { calls++; return 'collision'; } }), 'NEW'), rejected('output_write'));
  assert.equal(calls, 8); assert.equal(await fs.readFile(collision, 'utf8'), 'FOREIGN');
  calls = 0;
  await writeOutput(await f.plan({ name: () => ++calls === 1 ? 'collision' : 'unique' }), 'NEW');
  assert.equal(calls, 2); assert.equal(await fs.readFile(collision, 'utf8'), 'FOREIGN');
  assert.equal(await fs.readFile(f.output, 'utf8'), 'NEW');
  await fs.unlink(collision); await onlyInputAndReport(f);
});

test('a temp name equal to the requested destination is skipped before open', async t => {
  const f = await fixture(t), path = f.dir + '/.radar-output-collision.tmp';
  let calls = 0;
  const plan = await prepareOutput(path, { input: f.input, name: () => ++calls === 1 ? 'collision' : 'unique' });
  await writeOutput(plan, 'NEW');
  assert.equal(calls, 2); assert.equal(await fs.readFile(path, 'utf8'), 'NEW');
});

test('cleanup errors distinguish publication from failure and never roll back a published report', async t => {
  for (const failWrite of [false, true]) {
    const f = await fixture(t);
    const io = { ...fs, unlink: async () => { throw error(); }, open: async (...a) => {
      const handle = await fs.open(...a);
      return { stat: (...a) => handle.stat(...a), chmod: (...a) => handle.chmod(...a), sync: () => handle.sync(), close: () => handle.close(),
        write: (...a) => { if (failWrite) throw error(); return handle.write(...a); } };
    } };
    await assert.rejects(writeOutput(await f.plan({ io }), 'NEW'), e => {
      assert.equal(e.code, 'output_cleanup'); assert.match(e.message, failWrite ? /was not published/ : /was published/); return true;
    });
    if (failWrite) await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
    else assert.equal(await fs.readFile(f.output, 'utf8'), 'NEW');
    assert.equal((await fs.readdir(f.dir)).filter(p => p.startsWith('.radar-output-')).length, 1);
  }
});

test('destination replacement, mutation, symlink, directory and input alias races are refused before publication', async t => {
  for (const change of ['new-file', 'replace', 'mutate', 'symlink', 'directory', 'hardlink']) {
    const f = await fixture(t), overwrite = change !== 'new-file';
    if (overwrite) await fs.writeFile(f.output, 'OLD');
    const io = { ...fs, open: async (...args) => {
      const handle = await fs.open(...args);
      return { stat: (...a) => handle.stat(...a), chmod: (...a) => handle.chmod(...a), write: (...a) => handle.write(...a), sync: () => handle.sync(), close: async () => {
        await handle.close();
        if (change === 'mutate') return fs.appendFile(f.output, 'USER');
        if (overwrite) await fs.unlink(f.output);
        if (change === 'symlink') await fs.symlink(f.config, f.output);
        else if (change === 'directory') await fs.mkdir(f.output);
        else if (change === 'hardlink') await fs.link(f.config, f.output);
        else await fs.writeFile(f.output, 'OTHER');
      } };
    } };
    const expected = { 'new-file': 'output_exists', replace: 'output_changed', mutate: 'output_changed',
      symlink: 'output_type', directory: 'output_type', hardlink: 'output_input' }[change];
    await assert.rejects(writeOutput(await f.plan({ overwrite, io }), 'NEW'), rejected(expected));
    assert.equal(await fs.readFile(f.config, 'utf8'), '{"repositories":["demo/one"]}');
    if (['new-file', 'replace'].includes(change)) assert.equal(await fs.readFile(f.output, 'utf8'), 'OTHER');
    if (change === 'mutate') assert.equal(await fs.readFile(f.output, 'utf8'), 'OLDUSER');
    assert.equal((await fs.readdir(f.dir)).filter(p => p.startsWith('.radar-output-')).length, 0);
  }
});

test('no-clobber is enforced by link even if a competing file appears after the final check', async t => {
  const f = await fixture(t);
  const io = { ...fs, link: async (temp, output) => { await fs.writeFile(output, 'WINNER', { flag: 'wx' }); return fs.link(temp, output); } };
  await assert.rejects(writeOutput(await f.plan({ io }), 'LOSER'), rejected('output_write'));
  assert.equal(await fs.readFile(f.output, 'utf8'), 'WINNER'); await onlyInputAndReport(f);
});

test('foreign temp replacement is never published or unlinked during cleanup', async t => {
  const f = await fixture(t);
  let temp;
  const io = { ...fs, open: async (...args) => {
    temp = args[0]; const handle = await fs.open(...args);
    return { stat: (...a) => handle.stat(...a), chmod: (...a) => handle.chmod(...a), write: (...a) => handle.write(...a), sync: () => handle.sync(), close: async () => {
      await handle.close(); await fs.rename(temp, temp + '-owned'); await fs.writeFile(temp, 'FOREIGN');
    } };
  } };
  await assert.rejects(writeOutput(await f.plan({ io }), 'NEW'), rejected('output_cleanup'));
  assert.equal(await fs.readFile(temp, 'utf8'), 'FOREIGN');
  await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
});

test('changed parent symlinks are detected without publishing through the new parent', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.dir + '/first'); await fs.mkdir(f.dir + '/second');
  await fs.symlink(f.dir + '/first', f.dir + '/alias');
  const plan = await prepareOutput(f.dir + '/alias/report', { input: f.input });
  await fs.unlink(f.dir + '/alias'); await fs.symlink(f.dir + '/second', f.dir + '/alias');
  await assert.rejects(writeOutput(plan, 'NEW'), rejected('output_changed'));
  assert.deepEqual(await fs.readdir(f.dir + '/first'), []); assert.deepEqual(await fs.readdir(f.dir + '/second'), []);
});

test('concurrent no-clobber writers publish exactly one whole report with no temporary remnants', async t => {
  const f = await fixture(t), plans = await Promise.all([f.plan(), f.plan()]);
  const contents = ['🚀'.repeat(10000), 'OTHER'.repeat(10000)];
  const results = await Promise.allSettled(plans.map((plan, i) => writeOutput(plan, contents[i])));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const winner = results.findIndex(r => r.status === 'fulfilled');
  assert.equal(await fs.readFile(f.output, 'utf8'), contents[winner]); await onlyInputAndReport(f);
});

test('concurrent overwrite writers leave one whole report, never interleaved bytes', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.output, 'OLD');
  const plans = await Promise.all([f.plan({ overwrite: true }), f.plan({ overwrite: true })]);
  const contents = ['FIRST'.repeat(10000), 'SECOND'.repeat(10000)];
  const results = await Promise.allSettled(plans.map((plan, i) => writeOutput(plan, contents[i])));
  assert.ok(results.some(r => r.status === 'fulfilled'));
  assert.ok(contents.includes(await fs.readFile(f.output, 'utf8')));
  for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.code, 'output_changed');
  await onlyInputAndReport(f);
});

test('late input inode replacement protects both old and new input identities at publication', async t => {
  for (const selectOriginal of [false, true]) {
    const f = await fixture(t);
    await fs.writeFile(f.output, 'OLD');
    const io = { ...fs, open: async (...args) => {
      const handle = await fs.open(...args);
      return { stat: (...a) => handle.stat(...a), chmod: (...a) => handle.chmod(...a), write: (...a) => handle.write(...a), sync: () => handle.sync(), close: async () => {
        await handle.close(); await fs.rename(f.config, f.dir + '/original-input');
        await fs.writeFile(f.config, '{"repositories":["demo/new"]}');
        await fs.unlink(f.output); await fs.link(selectOriginal ? f.dir + '/original-input' : f.config, f.output);
      } };
    } };
    await assert.rejects(writeOutput(await f.plan({ overwrite: true, io }), 'REPORT'), rejected('output_input'));
    assert.equal(await fs.readFile(f.config, 'utf8'), '{"repositories":["demo/new"]}');
    assert.equal(await fs.readFile(f.dir + '/original-input', 'utf8'), '{"repositories":["demo/one"]}');
  }
});

test('a parent retargeted after temp close leaves foreign paths untouched and reports retained temp cleanup', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.dir + '/first'); await fs.mkdir(f.dir + '/second');
  await fs.symlink(f.dir + '/first', f.dir + '/alias');
  const io = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    return { stat: (...a) => handle.stat(...a), chmod: (...a) => handle.chmod(...a), write: (...a) => handle.write(...a), sync: () => handle.sync(), close: async () => {
      await handle.close(); await fs.unlink(f.dir + '/alias'); await fs.symlink(f.dir + '/second', f.dir + '/alias');
    } };
  } };
  const plan = await prepareOutput(f.dir + '/alias/report', { input: f.input, io });
  await assert.rejects(writeOutput(plan, 'REPORT'), rejected('output_cleanup'));
  assert.deepEqual(await fs.readdir(f.dir + '/second'), []);
  assert.equal((await fs.readdir(f.dir + '/first')).filter(p => p.startsWith('.radar-output-')).length, 1);
});
