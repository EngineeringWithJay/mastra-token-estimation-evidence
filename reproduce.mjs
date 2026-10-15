// SPDX-License-Identifier: Apache-2.0
// Only built-ins are statically imported. Third-party imports occur after guards.
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import cp from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dgram from 'node:dgram';
import workers from 'node:worker_threads';

const here = dirname(fileURLToPath(import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const read = name => readFileSync(join(here, name));
const keys = ['stable', 'alpha', 'legacy', 'comparator'];
const envKeys = ['HOME', 'LANG', 'LC_ALL', 'NO_COLOR', 'TMPDIR', 'TZ', 'XDG_CONFIG_HOME'];
class PacketError extends Error {}
const fail = code => { throw new PacketError(code); };

export function minimalEnvironment(home) {
  return { HOME: home, TMPDIR: home, XDG_CONFIG_HOME: home,
    LANG: 'C', LC_ALL: 'C', TZ: 'UTC', NO_COLOR: '1' };
}
function checkEnvironment() {
  if (JSON.stringify(Object.keys(process.env).sort()) !== JSON.stringify(envKeys)) fail('environment_not_minimal');
  const expected = minimalEnvironment(process.env.HOME);
  if (envKeys.some(k => process.env[k] !== expected[k]) || readdirSync(process.env.HOME).length) fail('environment_not_empty');
}

export function installGuards() {
  const attempts = { imports: 0, cases: 0, selftest: 0 };
  let phase = 'imports';
  function deny() {
    attempts[phase]++;
    if (phase !== 'selftest') process.exitCode = 1;
    fail('guarded_api_blocked');
  }
  const patch = (object, names) => { for (const name of names) if (typeof object?.[name] === 'function') object[name] = deny; };
  globalThis.fetch = deny;
  for (const mod of [http, https]) {
    patch(mod, ['request', 'get']);
    patch(mod.Agent.prototype, ['createConnection']);
  }
  patch(http2, ['connect']);
  patch(net, ['connect', 'createConnection']);
  patch(net.Socket.prototype, ['connect']);
  patch(tls, ['connect']);
  patch(tls.TLSSocket.prototype, ['connect']);
  patch(dgram, ['createSocket']);
  patch(dgram.Socket.prototype, ['connect', 'send']);
  for (const object of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
    patch(object, Object.getOwnPropertyNames(object).filter(k => /^(lookup|resolve|reverse)/.test(k)));
  }
  patch(cp, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
  patch(workers, ['Worker']);
  syncBuiltinESMExports();
  return { attempts, setPhase: value => { phase = value; } };
}

export function expandFixture(fixture) {
  if (!fixture || !/^[a-z][a-z0-9-]*$/.test(fixture.id) || !/^[a-z][a-z0-9-]*$/.test(fixture.category)) fail('invalid_fixture_label');
  const hasInput = Object.hasOwn(fixture, 'input');
  if (hasInput === Object.hasOwn(fixture, 'generator')) fail('invalid_fixture_source');
  let input = fixture.input;
  if (!hasInput) {
    const g = fixture.generator;
    if (!g || g.kind !== 'repeat' || typeof g.text !== 'string' || !g.text.length ||
        !Number.isSafeInteger(g.count) || g.count < 1 || g.count > 28000 || g.text.length * g.count > 28000) fail('invalid_generator');
    input = g.text.repeat(g.count);
  }
  if (typeof input !== 'string' || input.length > 28000) fail('invalid_fixture_input');
  return input;
}
export function validateCounts(counts) {
  if (keys.some(key => !Number.isSafeInteger(counts[key]) || counts[key] < 0)) fail('invalid_count');
}
export function toCSV(report) {
  const columns = ['id', 'category', 'utf8_bytes', 'code_points', 'utf16_units', 'input_sha256',
    ...keys, 'ascii_digit_heuristic_ceil_n_over_3', 'comparator_over_stable'];
  const rows = report.cases.map(c => [c.id, c.category, c.utf8_bytes, c.code_points, c.utf16_units,
    c.input_sha256, ...keys.map(k => c.counts[k]), c.ascii_digit_heuristic_ceil_n_over_3, c.comparator_over_stable]);
  // Labels are validated; no raw strings/digit identifiers reach spreadsheet cells.
  return [columns, ...rows].map(row => row.map(v => v === null ? '' : String(v)).join(',')).join('\n') + '\n';
}

function provenance() {
  const lockBytes = read('package-lock.json');
  const lock = JSON.parse(lockBytes);
  const manifest = JSON.parse(read('package.json'));
  if (Object.values(lock.packages).some(p => p.resolved && !p.resolved.startsWith('https://registry.npmjs.org/'))) fail('non_registry_dependency');
  const entries = [
    ['@mastra/memory', '@mastra/memory/processors'],
    ['mastra-memory-alpha', 'mastra-memory-alpha/processors'],
    ['@mastra/core', '@mastra/core'], ['tokenx-legacy', 'tokenx-legacy'],
    ['tokenx', 'tokenx'], ['zod', 'zod'],
  ].map(([installation, specifier]) => {
    const packagePath = `node_modules/${installation}/package.json`;
    const actual = JSON.parse(read(packagePath));
    const locked = lock.packages[`node_modules/${installation}`];
    if (!locked?.integrity || actual.version !== locked.version) fail('package_lock_mismatch');
    const resolved = fileURLToPath(import.meta.resolve(specifier));
    const entry = relative(here, resolved).split('\\').join('/');
    if (!entry.startsWith('node_modules/') || entry.includes('../')) fail('entry_outside_packet');
    return { installation, name: actual.name, version: actual.version, declared: manifest.dependencies[installation],
      lock_integrity: locked.integrity, esm_specifier: specifier, esm_entry: entry,
      esm_entry_sha256: hash(readFileSync(resolved)), package_json_sha256: hash(read(packagePath)) };
  });
  return { package_lock_sha256: hash(lockBytes), fixtures_sha256: hash(read('fixtures.json')), packages: entries };
}

async function selfTest(guard) {
  guard.setPhase('selftest');
  const probes = [
    () => fetch('https://example.invalid'), () => http.request('http://example.invalid'),
    () => https.get('https://example.invalid'), () => new http.Agent().createConnection({}),
    () => http2.connect('https://example.invalid'), () => net.connect(1),
    () => new net.Socket().connect(1), () => tls.connect(1), () => dgram.createSocket('udp4'),
    () => dns.lookup('example.invalid'), () => dns.resolve4('example.invalid'),
    () => dns.promises.lookup('example.invalid'), () => new dns.Resolver().resolveTxt('example.invalid'),
    () => new dns.promises.Resolver().resolve6('example.invalid'),
    () => cp.spawn('never-run'), () => cp.exec('never-run'), () => cp.execFile('never-run'),
    () => cp.spawnSync('never-run'), () => cp.execSync('never-run'), () => cp.execFileSync('never-run'),
    () => cp.fork('never-run'), () => new workers.Worker('never-run'),
    async () => (await import('node:net')).connect(1),
  ];
  for (const probe of probes) {
    let blocked = false;
    try { await probe(); } catch (e) { blocked = e.message === 'guarded_api_blocked'; }
    if (!blocked) fail('guard_selftest_failed');
  }
  return { selftest: 'passed', probes: probes.length, guarded_attempts: guard.attempts, environment: 'minimal-empty-home' };
}

async function measure(guard) {
  const fixtures = JSON.parse(read('fixtures.json'));
  if (fixtures.schema_version !== 1 || !Array.isArray(fixtures.cases) || !fixtures.cases.length || fixtures.cases.length > 100) fail('invalid_fixtures');
  const inputs = fixtures.cases.map(expandFixture);
  if (new Set(fixtures.cases.map(f => f.id)).size !== inputs.length) fail('duplicate_fixture');
  const evidence = provenance();
  // No third-party module is imported before environment validation and guards.
  const stable = await import('@mastra/memory/processors');
  const alpha = await import('mastra-memory-alpha/processors');
  const legacy = await import('tokenx-legacy');
  const comparator = await import('tokenx');
  checkEnvironment();
  const a = new stable.TokenCounter();
  const b = new alpha.TokenCounter();
  evidence.function_sha256 = {
    stable_countString: hash(stable.TokenCounter.prototype.countString.toString()),
    alpha_countString: hash(alpha.TokenCounter.prototype.countString.toString()),
    legacy_estimateTokenCount: hash(legacy.estimateTokenCount.toString()),
    comparator_estimateTokenCount: hash(comparator.estimateTokenCount.toString()),
  };
  guard.setPhase('cases');
  const cases = fixtures.cases.map((fixture, i) => {
    const input = inputs[i];
    const counts = { stable: a.countString(input), alpha: b.countString(input),
      legacy: legacy.estimateTokenCount(input), comparator: comparator.estimateTokenCount(input) };
    validateCounts(counts);
    return { ...fixture, utf8_bytes: Buffer.byteLength(input), code_points: [...input].length,
      utf16_units: input.length, input_sha256: hash(input), counts,
      ascii_digit_heuristic_ceil_n_over_3: /^[0-9]+$/.test(input) ? Math.ceil(input.length / 3) : null,
      comparator_over_stable: counts.stable === 0 ? null : counts.comparator / counts.stable };
  });
  return { schema_version: 1, interpretation: 'Versioned estimator comparison, not model-token ground truth; one coexisting installation, not an upgrade intervention.',
    runtime: { node: process.version, icu: process.versions.icu, unicode: process.versions.unicode,
      intl_locale: new Intl.NumberFormat().resolvedOptions().locale,
      segmenter_locale: new Intl.Segmenter().resolvedOptions().locale, platform: process.platform, arch: process.arch },
    safety: { scope: 'Process-local guarded APIs, not an OS sandbox.', environment: 'minimal-empty-home',
      guarded_attempts: guard.attempts }, provenance: evidence, cases };
}

async function worker(isSelfTest) {
  let guard;
  try {
    // macOS may inject this native per-user key even when spawn receives env={...}.
    delete process.env.__CF_USER_TEXT_ENCODING;
    checkEnvironment();
    guard = installGuards();
    const result = await (isSelfTest ? selfTest(guard) : measure(guard));
    // beforeExit listeners may schedule more work; report synchronously at exit.
    // Any denial in a later exit listener still sets failure status in deny().
    process.once('exit', () => {
      if (!isSelfTest && Object.values(guard.attempts).some(Boolean)) {
        writeSync(1, JSON.stringify({ error: 'guarded_attempts_detected', guarded_attempts: guard.attempts }) + '\n');
        process.exitCode = 1;
      } else writeSync(1, JSON.stringify(result, null, 2) + '\n');
    });
  } catch (error) {
    // Do not serialize third-party errors: messages/stacks can contain private paths or input.
    process.stdout.write(JSON.stringify({ error: error instanceof PacketError ? error.message : 'reproduction_failed', guarded_attempts: guard?.attempts ?? null }) + '\n');
    process.exitCode = 1;
  }
}

function launch(args) {
  if (args.some(a => !['--csv', '--self-test'].includes(a)) || (args.includes('--csv') && args.includes('--self-test'))) fail('invalid_arguments');
  const home = mkdtempSync(join(tmpdir(), 'mastra-evidence-'));
  try {
    const child = cp.spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--worker', ...args.filter(a => a !== '--csv')],
      { cwd: here, env: minimalEnvironment(home), encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
    if (child.error || child.stderr) fail('worker_failed');
    const report = JSON.parse(child.stdout);
    if (child.status !== 0) {
      process.stdout.write(JSON.stringify(report) + '\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write(args.includes('--csv') ? toCSV(report) : JSON.stringify(report, null, 2) + '\n');
  } finally { rmSync(home, { recursive: true, force: true }); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args[0] === '--worker') await worker(args[1] === '--self-test');
  else try { launch(args); } catch {
    process.stdout.write('{"error":"reproduction_failed"}\n');
    process.exitCode = 1;
  }
}
