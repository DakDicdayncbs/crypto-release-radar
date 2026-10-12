import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import test from 'node:test';
import { prepareOutput, resolveFilePath } from '../src/output-file.js';
import { readConfigValue } from '../src/config-file.js';
import { writeSnapshot, serializeSnapshot } from '../src/snapshot.js';
import { fixtures, changed } from '../test-support/report-corpus.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const options = { synthetic: false };
const error = () => new Error('private-sentinel');
const rejected = code => e => { assert.equal(e.code, code); assert.ok(!e.message.includes('private-sentinel')); return true; };
async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(tmpdir() + '/radar-snapshot-file-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = dir + '/config.json', output = dir + '/report.radar-snapshot.json';
  await fs.writeFile(config, '{"repositories":["example/one"]}');
  const input = await resolveFilePath(config);
  await readConfigValue(input.path, undefined, identity => { input.identity = identity; });
  return { dir, config, output, plan: value => prepareOutput(output, { input, ...value }) };
}
const tempNames = async dir => (await fs.readdir(dir)).filter(name => name.startsWith('.radar-output-'));

test('writer rejects secrets/raw fields/fatal/version failures before opening a temp or modifying prior output', async t => {
  const f = await fixture(t); await fs.writeFile(f.output, 'OLD');
  let opens = 0;
  const plan = await f.plan({ overwrite: true, io: { ...fs, open() { opens++; assert.fail('No temp on invalid snapshot'); } } });
  for (const [report, opts, code] of [
    [changed(fixtures.current, 'releases.0.name', 'private-sentinel'), { ...options, token: 'private-sentinel' }, 'snapshot_secret'],
    [fixtures.current, { ...options, token: '"snapshotVersion"' }, 'snapshot_secret'],
    [changed(fixtures.current, 'raw', { token: 'private-sentinel' }), options, 'snapshot_invalid'],
    [fixtures.fatal, options, 'snapshot_invalid'], [changed(fixtures.current, 'schemaVersion', 2), options, 'snapshot_invalid'],
  ]) await assert.rejects(writeSnapshot(plan, report, opts), rejected(code));
  assert.equal(opens, 0); assert.equal(await fs.readFile(f.output, 'utf8'), 'OLD'); assert.deepEqual(await tempNames(f.dir), []);
});

test('snapshot short writes advance exact byte offsets and sync/close precede publication; caller mutation cannot change stored bytes', async t => {
  const f = await fixture(t), events = [], report = structuredClone(fixtures.current), expected = serializeSnapshot(report, options);
  const io = { ...fs, open: async (path, flags, mode) => {
    assert.ok(flags & constants.O_EXCL); assert.ok(flags & constants.O_NOFOLLOW); assert.ok(!(flags & constants.O_TRUNC)); assert.equal(mode, 0o600);
    report.releases[0].name = 'MUTATED AFTER VALIDATION'; // Writer has already made immutable text.
    const handle = await fs.open(path, flags, mode); let written = 0;
    return { stat: (...a) => handle.stat(...a), chmod: (...a) => handle.chmod(...a),
      write: async (bytes, offset, length, position) => {
        assert.equal(offset, written); assert.equal(position, written); assert.equal(length, bytes.length - written);
        const result = await handle.write(bytes, offset, Math.min(13, length), position);
        written += result.bytesWritten; events.push('write'); return result;
      }, sync: async () => { events.push('sync'); await handle.sync(); },
      close: async () => { events.push('close'); await handle.close(); },
    };
  }, link: async (...a) => { assert.deepEqual(events.slice(-2), ['sync', 'close']); return fs.link(...a); } };
  await writeSnapshot(await f.plan({ io }), report, options);
  assert.equal(await fs.readFile(f.output, 'utf8'), expected);
  assert.equal((await fs.stat(f.output)).mode & 0o777, 0o600); assert.deepEqual(await tempNames(f.dir), []);
});

for (const failure of ['write', 'zero-write', 'sync', 'close', 'link', 'rename']) {
  test(`snapshot ${failure} failure preserves old file/no publication and closes/removes the owned temp`, async t => {
    const f = await fixture(t), overwrite = failure !== 'link', handles = [];
    if (overwrite) await fs.writeFile(f.output, 'OLD');
    const io = { ...fs, open: async (...args) => {
      const handle = await fs.open(...args); handles.push(handle);
      return { stat: (...a) => handle.stat(...a), chmod: (...a) => handle.chmod(...a),
        write: async (...a) => {
          if (failure === 'zero-write') return { bytesWritten: 0 };
          if (failure === 'write') { await handle.write(a[0], a[1], 1, a[3]); throw error(); }
          return handle.write(...a);
        }, sync: async () => { if (failure === 'sync') throw error(); await handle.sync(); },
        close: async () => { await handle.close(); if (failure === 'close') throw error(); },
      };
    }, link: async (...a) => { if (failure === 'link') throw error(); return fs.link(...a); },
    rename: async (...a) => { if (failure === 'rename') throw error(); return fs.rename(...a); } };
    await assert.rejects(writeSnapshot(await f.plan({ overwrite, io }), fixtures.current, options), rejected('output_write'));
    assert.ok(handles.every(h => h.fd === -1)); assert.deepEqual(await tempNames(f.dir), []);
    if (overwrite) assert.equal(await fs.readFile(f.output, 'utf8'), 'OLD');
    else await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
  });
}

test('snapshot cleanup failures explicitly distinguish already-published output from unpublished failure', async t => {
  for (const failWrite of [true, false]) {
    const f = await fixture(t);
    const io = { ...fs, unlink: async () => { throw error(); }, open: async (...args) => {
      const h = await fs.open(...args);
      return { stat: (...a) => h.stat(...a), chmod: (...a) => h.chmod(...a), sync: () => h.sync(), close: () => h.close(),
        write: (...a) => { if (failWrite) throw error(); return h.write(...a); } };
    } };
    await assert.rejects(writeSnapshot(await f.plan({ io }), fixtures.partial, options), e => {
      assert.equal(e.code, 'output_cleanup'); assert.match(e.message, failWrite ? /was not published/ : /was published/); return true;
    });
    if (failWrite) await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
    else assert.deepEqual(JSON.parse(await fs.readFile(f.output, 'utf8')).report, fixtures.partial);
    assert.equal((await tempNames(f.dir)).length, 1);
  }
});

test('snapshot no-clobber publication loses safely to a late competitor, including --overwrite with initially absent destination', async t => {
  for (const overwrite of [false, true]) {
    const f = await fixture(t);
    const io = { ...fs, link: async (temp, output) => { await fs.writeFile(output, 'WINNER', { flag: 'wx' }); return fs.link(temp, output); } };
    await assert.rejects(writeSnapshot(await f.plan({ io, overwrite }), fixtures.current, options), rejected('output_write'));
    assert.equal(await fs.readFile(f.output, 'utf8'), 'WINNER'); assert.deepEqual(await tempNames(f.dir), []);
  }
});

test('snapshot cleanup never unlinks a substituted foreign temp', async t => {
  const f = await fixture(t); let temp;
  const io = { ...fs, open: async (...a) => {
    temp = a[0]; const h = await fs.open(...a);
    return { stat: (...a) => h.stat(...a), chmod: (...a) => h.chmod(...a), write: (...a) => h.write(...a), sync: () => h.sync(), close: async () => {
      await h.close(); await fs.rename(temp, temp + '-owned'); await fs.writeFile(temp, 'FOREIGN');
    } };
  } };
  await assert.rejects(writeSnapshot(await f.plan({ io }), fixtures.current, options), rejected('output_cleanup'));
  assert.equal(await fs.readFile(temp, 'utf8'), 'FOREIGN'); await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
});

test('concurrent snapshot writers leave one complete document and no temporary remnants', async t => {
  const f = await fixture(t), plans = await Promise.all([f.plan(), f.plan()]);
  const reports = [fixtures.current, fixtures.partial];
  const results = await Promise.allSettled(plans.map((plan, i) => writeSnapshot(plan, reports[i], options)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(f.output, 'utf8')).report, reports[results.findIndex(r => r.status === 'fulfilled')]);
  assert.deepEqual(await tempNames(f.dir), []);
});

test('process interruption during a partial snapshot write leaves old output intact and only a private unpromoted temp', async t => {
  for (const overwrite of [false, true]) {
    const f = await fixture(t); if (overwrite) await fs.writeFile(f.output, 'OLD');
    const script = `
      import * as fs from 'node:fs/promises';
      import { prepareOutput, resolveFilePath } from './src/output-file.js';
      import { readConfigValue } from './src/config-file.js';
      import { writeSnapshot } from './src/snapshot.js';
      const [config, output, replacing] = process.argv.slice(1);
      const input = await resolveFilePath(config);
      await readConfigValue(config, undefined, identity => { input.identity = identity; });
      const report = JSON.parse(await fs.readFile('examples/json-v1/current.json', 'utf8'));
      const io = {...fs, open: async (...a) => {
        const h = await fs.open(...a);
        return {stat: (...a)=>h.stat(...a), chmod:(...a)=>h.chmod(...a), sync:()=>h.sync(), close:()=>h.close(),
          write:async (b,o,n,p)=>{await h.write(b,o,10,p); process.send('partial'); setInterval(()=>{},1000); await new Promise(()=>{});}};
      }};
      await writeSnapshot(await prepareOutput(output,{input,overwrite:replacing==='yes',io}),report,{synthetic:false});
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, f.config, f.output, overwrite ? 'yes' : 'no'],
      { cwd: root, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
    try { assert.deepEqual(await once(child, 'message', { signal: controller.signal }), ['partial', undefined]); }
    finally { clearTimeout(timer); }
    const exit = once(child, 'exit'); child.kill('SIGKILL');
    assert.deepEqual(await exit, [null, 'SIGKILL']);
    if (overwrite) assert.equal(await fs.readFile(f.output, 'utf8'), 'OLD');
    else await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
    const temps = await tempNames(f.dir); assert.equal(temps.length, 1);
    const stat = await fs.stat(f.dir + '/' + temps[0]); assert.equal(stat.mode & 0o777, 0o600); assert.equal(stat.size, 10);
  }
});
