# Mastra #27148: small local regression-data packet

Target: [Mastra issue #27148](https://github.com/mastra-ai/mastra/issues/27148).

Free, synthetic reproduction data, not a source fix or an upstream PR. The packet
adds boundary and non-digit controls to the four reported strings. No accounts,
API keys, providers, storage, model calls, or customer data are needed.

## Replay

Use **Node 24.14.1** (`.node-version`); do not update your global Node installation.
The manifest requires >=22.22.0 because of a locked transitive dependency, but the
recorded run is Node 24.14.1 / ICU 78.2 / Unicode 17.0, Darwin arm64, en-US Intl.
Other Node/ICU/platform combinations have not been qualified.

Run from this directory. Set `NODE_BIN` to the directory containing your isolated
Node 24.14.1 `node` and `npm` binaries. Installation needs public npm-registry
network access. Lifecycle scripts, audit and funding requests are disabled:

```sh
NODE_BIN="/path/to/node-24.14.1/bin"
SETUP_HOME="$(mktemp -d)"
env -i PATH="$NODE_BIN:/usr/bin:/bin" HOME="$SETUP_HOME" \
  TMPDIR="$SETUP_HOME" XDG_CONFIG_HOME="$SETUP_HOME" \
  NPM_CONFIG_USERCONFIG="$SETUP_HOME/user.conf" \
  NPM_CONFIG_GLOBALCONFIG="$SETUP_HOME/global.conf" \
  NPM_CONFIG_CACHE="$SETUP_HOME/cache" LANG=C LC_ALL=C TZ=UTC NO_COLOR=1 \
  "$NODE_BIN/npm" ci --ignore-scripts --no-audit --no-fund
rm -rf "$SETUP_HOME"

env -i PATH="$NODE_BIN:/usr/bin:/bin" LANG=C LC_ALL=C TZ=UTC \
  "$NODE_BIN/node" reproduce.mjs > observed.actual.json
env -i PATH="$NODE_BIN:/usr/bin:/bin" LANG=C LC_ALL=C TZ=UTC \
  "$NODE_BIN/node" reproduce.mjs --csv > observed.actual.csv
env -i PATH="$NODE_BIN:/usr/bin:/bin" LANG=C LC_ALL=C TZ=UTC \
  "$NODE_BIN/node" --test test-reproduce.mjs
```

Check each command's exit status; do not treat a created output file as success.
`node reproduce.mjs` emits stable JSON by default; `--csv` emits CSV, and
`--self-test` runs deliberate guard probes **in a separate process**, not the
measurement. Errors, invalid fixtures/counts, failed imports, guarded attempts,
or a worker timeout produce nonzero exit status. Use the explicit `env -i`
commands above: unlike `npm run`, they also exclude inherited startup options
such as `NODE_OPTIONS` before Node launches.

## What was observed

The real published `@mastra/memory/processors` and alias
`mastra-memory-alpha/processors` exports are each instantiated with
`new TokenCounter()` and called through **`countString(string)`**. Direct tokenx
calls use `estimateTokenCount`. No wrapper implementation substitutes for the SDK.

| Input | memory 1.37.1 | memory 1.38.0-alpha.0 | tokenx 1.3.0 | tokenx 1.6.0 |
|---|---:|---:|---:|---:|
| `"0".repeat(28000)` | 1 | 1 | 1 | 9334 |
| `"12345678901234567890"` | 1 | 1 | 1 | 7 |
| `"1700000000000"` | 1 | 1 | 1 | 5 |
| `"hello world this is text"` | 5 | 5 | 5 | 5 |
| spaced numbers | 3 | 3 | 3 | 12 |
| mixed JSON text | 17 | 17 | 17 | 20 |
| decimal text | 3 | 3 | 3 | 9 |
| CJK control | 13 | 13 | 13 | 12 |
| emoji control | 3 | 3 | 3 | 8 |

All **16 cases / 64 estimates** are in `observed.json` and `observed.csv`.
Controls are observations, not assumptions that non-digit behavior is unchanged.
The tests compare two fresh JSON runs and two fresh CSV runs byte-for-byte,
confirm the original four counts, check fixture hashes/lengths, and compare the
case matrix with the checked-in observations. Recorded results came after a
fresh `npm ci --ignore-scripts --no-audit --no-fund` (172 installed packages).

## Interpretation and boundaries

- **One installation, not a before/after experiment.** Root tokenx 1.6.0 coexists
  with the SDK counts above. This does not prove that adding/upgrading it had no
  effect, nor identify which tokenx version/code a published SDK bundles. Equal
  output or equal `countString` function hashes are not proof of bundled identity.
- tokenx 1.6.0 is only a **versioned estimator comparator**, never model-token
  ground truth. `ascii_digit_heuristic_ceil_n_over_3` is the issue's heuristic for
  nonempty ASCII-digit-only strings. It is null for all other strings, not a
  claim about all models or all text. No actual model usage is measured.
- `comparator_over_stable` is an estimator-count ratio; a zero denominator is
  JSON null / an empty CSV cell. It is not an accuracy or billing metric.
- No claims about OM triggers, buffers, heap/OOM, context limits, end-to-end
  memory behavior, or the full Mastra test suite. No proposed fix is evaluated.
- The previously inspected current-main source at
  `03646c587b915ced4c9fad3189391909a296f441` is an API reference only, **not** the
  executed npm build. `observed.json` records actual installed package versions,
  lock integrities, selected **ESM** entry paths resolved with `import.meta.resolve`,
  entry/package/function SHA-256s, lock/fixture hashes, and runtime details.
  Entry hashes do not represent a complete transitive module graph.

## Isolation and data handling

The launcher creates a temporary empty HOME and starts the measurement child with
only HOME, TMPDIR, XDG_CONFIG_HOME, LANG, LC_ALL, TZ, and NO_COLOR. macOS's injected
`__CF_USER_TEXT_ENCODING` is removed before validation/imports. Tests add fake API
keys, proxy and OTEL headers to the launcher environment and verify the child
rejects inherited ENV and does not report those sentinels. No real HOME/config is
passed to third-party imports.

Before **any dynamic third-party import**, the child guards native fetch,
HTTP(S), HTTP/2 connection, net/socket, TLS, datagram, DNS (including promises and
resolvers), subprocess and worker APIs. Attempts are counted before throwing;
every non-self-test denial immediately sets a failing process exit status even
if caught. Reports are written synchronously at `exit`, after ordinary deferred
`beforeExit` work. A denial in a later exit listener cannot revise already-written
stdout but still fails the process, and the launcher propagates that failure:
**exit status is required for acceptance**, not just a zero-attempt JSON snapshot.
Lifecycle regressions exercise both listener orderings with the actual worker.
The measured runs recorded **zero
attempts through guarded APIs** during imports and cases; 23 deliberate self-test
probes were separately blocked. This is process-local instrumentation, **not an
OS sandbox or comprehensive proof of offline enforcement**. Native addons,
uncovered APIs, or malicious code are not a supported threat model. Runtime
counting requires no registry access; setup does.

`fixtures.json` and the JSON observation are authoritative. Inputs remain strings:
leading zeros and long numeric identifiers are never converted to Number. The
28,000-zero input uses a bounded declarative repeat generator. Every expanded
input has UTF-8 byte length, Unicode code-point length, UTF-16 length and SHA-256.
CSV contains only validated labels, lengths, hashes and numeric observations—not
raw identifiers/inputs that spreadsheets could round or interpret as formulas.
Reports contain no timestamps, absolute paths, headers or private-trace content.

## Independent verification

A fresh whitelist-only installation completed `npm ci --ignore-scripts --no-audit
--no-fund` with 172 packages and no engine warning on the recorded Node runtime.
After a focused runner correction, an independent recheck in that same locked
installation passed **7 tests**, reproduced two identical JSON runs and two
identical CSV runs, and confirmed all 16 inputs / 64 estimates. The 23 deliberate guard
probes remain separate from normal observations with zero guarded attempts.

The recheck also exercised caught calls deferred by `beforeExit` and calls in a
later `exit` listener: those processes and the launcher return nonzero, even when
stdout was already written. **Exit status is authoritative.** These checks do not
make the process-local guard an OS sandbox.

Recorded SHA-256 values:

```text
observed.json  8a2d202728389fe5322547e3da76991b0208813567d6b1ae58534f89778d4537
observed.csv   21dae204914173075c8163b0051cc8cfaf164646695f3d43eaf7daf85e8efdb8
```

## Reuse

Original probe code and synthetic data: **Apache-2.0**, see `LICENSE`.
Installed third-party packages retain their own licenses (including Apache-2.0
and MIT); this packet does not relicense or redistribute `node_modules`.
The issue workflow requires waiting for triage labels before opening a source PR;
this standalone data packet is not a source fix or a claim of upstream approval.
Development environments, dependencies, internal handoff drafts and private
verification records are not part of the reusable delivery.
