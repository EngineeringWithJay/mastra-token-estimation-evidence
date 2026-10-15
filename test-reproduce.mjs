// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expandFixture, minimalEnvironment, toCSV, validateCounts } from './reproduce.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const fake = 'SYNTHETIC_SECRET_DO_NOT_PROPAGATE_27148';
const run = (...args) => spawnSync(process.execPath, ['reproduce.mjs', ...args], {
  cwd: here, encoding: 'utf8', timeout: 60000,
  env: { ...process.env, OPENAI_API_KEY: fake, HTTPS_PROXY: fake, OTEL_EXPORTER_OTLP_HEADERS: fake,
    HOME: '/nonexistent-synthetic-home', XDG_CONFIG_HOME: '/nonexistent-synthetic-config' },
});

test('minimal child environment drops fake credentials, proxies and configuration', () => {
  const env = minimalEnvironment('/synthetic-empty-home');
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'LC_ALL', 'NO_COLOR', 'TMPDIR', 'TZ', 'XDG_CONFIG_HOME']);
  assert.equal(JSON.stringify(env).includes(fake), false);
  const direct = run('--worker');
  assert.equal(direct.status, 1); // Internal entry cannot import dependencies with inherited ENV.
  assert.equal(direct.stdout.includes(fake), false);
});

test('deliberate network and subprocess guard self-tests are isolated from observations', () => {
  const child = run('--self-test');
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.selftest, 'passed');
  assert.equal(result.probes, 23);
  assert.deepEqual(result.guarded_attempts, { imports: 0, cases: 0, selftest: 23 });
  assert.equal(child.stdout.includes(fake), false);
});

test('fresh real API matrices and CSV are byte-identical; original four are confirmed', () => {
  const first = run();
  const second = run();
  for (const child of [first, second]) {
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.equal(child.stderr, '');
    assert.equal(child.stdout.includes(fake), false);
    assert.equal(child.stdout.includes(here), false);
  }
  assert.equal(first.stdout, second.stdout);
  const report = JSON.parse(first.stdout);
  assert.equal(report.cases.length, 16);
  assert.deepEqual(report.safety.guarded_attempts, { imports: 0, cases: 0, selftest: 0 });
  for (const key of ['stable', 'alpha', 'legacy']) assert.deepEqual(report.cases.slice(0, 4).map(c => c.counts[key]), [1, 1, 1, 5]);
  assert.deepEqual(report.cases.slice(0, 4).map(c => c.counts.comparator), [9334, 7, 5, 5]);
  for (const c of report.cases) {
    const input = expandFixture(c);
    assert.equal(c.input_sha256, createHash('sha256').update(input).digest('hex'));
    assert.equal(c.utf8_bytes, Buffer.byteLength(input));
    assert.equal(c.code_points, [...input].length);
    assert.equal(c.ascii_digit_heuristic_ceil_n_over_3, /^[0-9]+$/.test(input) ? Math.ceil(input.length / 3) : null);
    validateCounts(c.counts);
  }
  assert.equal(report.cases.find(c => c.id === 'leading-zero-20').input, '00001234567890123456');
  assert.equal(report.cases.find(c => c.id === 'empty').comparator_over_stable, null);
  const csv1 = run('--csv');
  const csv2 = run('--csv');
  assert.equal(csv1.status, 0, csv1.stdout + csv1.stderr);
  assert.equal(csv2.status, 0, csv2.stdout + csv2.stderr);
  assert.equal(csv1.stdout, csv2.stdout);
  assert.equal(csv1.stdout, toCSV(report));
  assert.equal(csv1.stdout.includes('12345678901234567890'), false);
  const recorded = JSON.parse(read('observed.json'));
  assert.deepEqual(report.cases, recorded.cases);
  assert.deepEqual(report.provenance, recorded.provenance);
  if (JSON.stringify(report.runtime) === JSON.stringify(recorded.runtime)) assert.equal(first.stdout, read('observed.json'));
  assert.equal(csv1.stdout, read('observed.csv'));
});

test('caught attempts remain counted during dynamic import and case execution', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { installGuards } from './reproduce.mjs';
    const guard = installGuards();
    await import('data:text/javascript,' + encodeURIComponent('try { fetch("https://example.invalid"); } catch {}'));
    guard.setPhase('cases');
    try { (await import('node:child_process')).execSync('never-run'); } catch {}
    console.log(JSON.stringify(guard.attempts));
  `], { cwd: here, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 1, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { imports: 1, cases: 1, selftest: 0 });
});

const dataURL = source => 'data:text/javascript,' + encodeURIComponent(source);
function runPreloaded(preload, launcher = false) {
  const home = mkdtempSync(join(tmpdir(), 'mastra-late-guard-'));
  try {
    return spawnSync(process.execPath, ['--import', dataURL(preload), 'reproduce.mjs', ...(launcher ? [] : ['--worker'])],
      { cwd: here, env: minimalEnvironment(home), encoding: 'utf8', timeout: 60000 });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test('actual worker rejects caught guard attempts deferred by beforeExit, without stderr markers', () => {
  const preload = `process.once('beforeExit', () => setImmediate(() => {
    try { fetch('https://example.invalid'); } catch {}
  }));`;
  for (let i = 0; i < 2; i++) {
    const child = runPreloaded(preload);
    assert.equal(child.status, 1, child.stdout + child.stderr);
    assert.equal(child.stderr, '');
    assert.deepEqual(JSON.parse(child.stdout), { error: 'guarded_attempts_detected',
      guarded_attempts: { imports: 0, cases: 1, selftest: 0 } });
  }
});

test('denial after the exit report is still unsuccessful, including through the launcher', () => {
  const lateExit = `process.once('beforeExit', () => process.once('exit', () => {
    try { fetch('https://example.invalid'); } catch {}
  }));`;
  // Register after the worker's finalizer: stdout cannot be revised, but status must fail.
  const child = runPreloaded(lateExit);
  assert.equal(child.status, 1, child.stdout + child.stderr);
  assert.equal(child.stderr, '');
  assert.deepEqual(JSON.parse(child.stdout).safety.guarded_attempts, { imports: 0, cases: 0, selftest: 0 });
  // Built-in-only test preload injects the same worker regression through real launch().
  const launcher = runPreloaded(`
    import cp from 'node:child_process';
    const spawn = cp.spawnSync;
    cp.spawnSync = (exe, args, options) => spawn(exe, ['--import', ${JSON.stringify(dataURL(lateExit))}, ...args], options);
  `, true);
  assert.equal(launcher.status, 1, launcher.stdout + launcher.stderr);
  assert.equal(launcher.stderr, '');
  assert.equal(JSON.parse(launcher.stdout).cases.length, 16);
});

test('invalid fixtures/counts/CLI arguments fail, without coercing numeric input', () => {
  const f = { id: 'valid', category: 'digits', input: '0001' };
  assert.equal(expandFixture(f), '0001');
  for (const input of [1, null, {}, [], 'x'.repeat(28001)]) assert.throws(() => expandFixture({ ...f, input }));
  assert.throws(() => expandFixture({ ...f, id: '=formula' }));
  assert.throws(() => expandFixture({ ...f, generator: { kind: 'repeat', text: '0', count: 1 } }));
  for (const count of [0, -1, 28001, 1.5, '28000']) assert.throws(() => expandFixture({ id: 'a', category: 'digits', generator: { kind: 'repeat', text: '0', count } }));
  for (const invalid of [-1, NaN, Infinity, 1.5, '1']) assert.throws(() => validateCounts({ stable: invalid, alpha: 1, legacy: 1, comparator: 1 }));
  assert.equal(run('--unknown').status, 1);
});
