# fmToOpenAI

OpenAI-compatible `tool_calls` shim for **Apple Foundation Models** (`fm serve`).
Stdlib-only Node + shell — no npm dependencies.

## What / why

`fm serve` (http://127.0.0.1:1976/v1, models `system`, `pcc`) does **not** return
OpenAI-style `tool_calls`. When sent `tools`, the model instead emits marker
syntax inside `content`:

```
<ctrl46>call:default_api:get_time{}<ctrl46>
<ctrl46>call:default_api:webfetch{extract_main:true,format:<ctrl46>text<ctrl46>,timeout:30,url:<ctrl46>https://…<ctrl46>}<ctrl46>
```

(`<ctrl46>`/`<ctrl45>` are the log-visible forms of raw control chars
`\x16`/`\x17`.) Direct `tools` + `tool_choice:auto` yields zero `tool_calls`;
forced `tool_choice` is rejected by `fm serve`.

The closest existing project, `gregbarbosa/fm-proxy`, fixes other spec
departures but only **strips** these markers. This shim translates
`call:default_api:*` into real `tool_calls` with a **deterministic regex +
brace-balancer** — no second model pass (no extra round-trip on a tiny
on-device model, no hallucination risk, no extra context pressure).

## Quickstart

Prerequisites: Node ≥ 18 and the `fm` CLI installed.
(`fm` has no `--version` flag; tested 2026-09-27 against the `fm` CLI with
`chat/config/count-tokens/license/models/quota-usage/respond` subcommands.)

```bash
./shim.sh start          # upstream :1976 auto-started if down, shim on :1977 (FM_WORKERS=3)
./shim.sh status         # shim + upstream state
curl -s http://127.0.0.1:1977/v1/models          # smoke test through the chain
./shim.sh stop           # stops shim; tears down only shim-started `fm serve`
```

Point your client at the shim instead of `fm serve` directly:

```jsonc
// opencode.jsonc
"provider": {
  "apple-fm": {
    "npm": "@ai-sdk/openai-compatible",
    "name": "Apple Foundation Models",
    "options": { "baseURL": "http://127.0.0.1:1977/v1" }
  }
}
```

Or run the pieces by hand:

```bash
node shim.js                 # LISTEN :1977 -> UPSTREAM http://127.0.0.1:1976/v1
FM_STRIP_MARKERS=1 node shim.js   # strip markers without translating (fm-proxy style)
```

## Configuration reference

All behaviour is driven by environment variables (defaults = go-live values):

| Variable | Default | Used by | Effect |
|---|---|---|---|
| `AFM_SHIM_PORT` (`PORT` fallback) | `1977` | shim.js, shim.sh | Port the shim listens on |
| `AFM_UPSTREAM` | `http://127.0.0.1:<AFM_UPSTREAM_PORT>/v1` | shim.js, shim.sh | Upstream `fm serve` base URL |
| `AFM_UPSTREAM_PORT` | `1976` | shim.sh | Upstream port (health probe, `--port` when auto-starting) |
| `FM_WORKERS` | `3` via shim.sh (`1` if running `node shim.js` directly) | shim.js | Cluster workers; `0` = auto (`min(cpus, 4)`); bad/negative → `1` |
| `FM_STRIP_MARKERS` | unset | shim.js | `=1` strips markers without translating to `tool_calls` |
| `LOADTEST_PORT` | `1987` | loadtest.js | Shim port for the load probe |

Runtime files:

| Path | Purpose |
|---|---|
| `/tmp/afm-openai-shim.<PORT>.pid` | Shim listener pid (survives repo moves) |
| `/tmp/afm-openai-shim.fm-managed` | Owner pid of shim-started `fm serve`; absent = user-owned upstream |
| `shim.<PORT>.log` | Shim stdout/stderr (`nohup`) |
| `fm-serve.log` | Auto-started `fm serve` output |

## Lifecycle (`shim.sh` manages `fm serve` too)

`./shim.sh {start|stop|restart|status} [port]` manages the shim **and** the
upstream:

- `start` probes `:1976` (`GET /v1/models`). If down, it launches `fm serve`
  in the background, waits up to ~60s for health (fails clearly otherwise —
  no orphaned shim without a backend), and records ownership in the
  managed-flag. If `:1976` is already healthy (your own `fm serve`), the shim
  attaches and records nothing. Orphan-reaping from §10 is preserved: extra
  listeners on the port are reaped, single listener verified.
- `stop` stops the shim and — only if the managed-flag exists — stops the
  shim-started `fm serve` (stored pid verified by command line / held
  listener before signalling, so pid reuse can't kill a stranger). A
  user-owned `fm serve` is never touched.
- `status` reports both sides: shim (`up` + workers/listeners, or `down`)
  and upstream (`up (managed, pid …)` / `up (user-owned)` / `down`).

Exercise the managed lifecycle without touching live `:1976` via
`AFM_UPSTREAM_PORT` plus a stub `fm` earlier in `PATH`, e.g.
`AFM_UPSTREAM_PORT=19760 ./shim.sh start 19779`.

## Testing

```bash
node test.js        # deterministic suite, no fm required (27 checks: translation
                    # shapes, arg coercion, SSE framing, worker-count parsing,
                    # live :1976 probe that never fails the suite when fm is down)
node loadtest.js    # parallel load probe: stub upstream + real shim on :1987
                    # @ FM_WORKERS=3 — 8 concurrent /v1/models + 4 concurrent
                    # canned POSTs + 1 SSE check, asserting no cross-talk
bash -n shim.sh     # syntax check after any shim.sh edit
```

`loadtest.js` is stdlib-only and spins up / tears down its own stub upstream
and shim child process; it never touches live `:1976`/`:1977`.

## How it works

- Forwards `/v1/models` and `/v1/chat/completions` (`stream:false` and SSE `stream:true`).
- Normalises all marker flavours (`\x16…\x17`, `<ctrl46>`/`<ctrl45>`, `[CTRL…]`)
  then matches `call:(?:default_api:)?NAME {balanced-braces}`; args via
  `JSON.parse` with a lenient fallback (bare-key quoting, then
  `url`/`format`/`timeout` extraction for `webfetch`, `{}` otherwise).
- On match: emits `tool_calls:[{id: call_…, type: "function",
  function: {name, arguments: JSON-string}}]`, sets `finish_reason: "tool_calls"`,
  strips the call expression from `content` (remaining text kept, else `""`).
- Multiple calls per message supported. Malformed input fails open (passthrough).
- `tool_choice: "required"` → rewritten to `"auto"`; named `tool_choice` objects →
  `"auto"` + `response_format: {type: "json_object"}` hint. Anything else passes through.
- Cluster (`FM_WORKERS>1`): one shared `:PORT` listener via the Node cluster
  scheduler; per-request state stays in-request, so concurrent translations
  never cross-talk. `status` shows `workers N` with a single `listeners 1`.

## Layout

| File | Role |
|---|---|
| `shim.js` | The shim: translator + forwarder + cluster (importable: `translateContent`, `extractCalls`, `createServer`, …) |
| `shim.sh` | Lifecycle: start/stop/restart/status for shim + managed `fm serve` |
| `test.js` | Deterministic unit suite (also the regression record: 27/27) |
| `loadtest.js` | Parallel load probe (13/13: 8 models + 4 POST + 1 SSE) |
| `EVAL.md` | Evaluation log: shim-vs-direct matrices, phase history (§1–§11) |
| `package.json` | `npm start` / `npm test`, Node ≥ 18, bin `afm-openai-shim` |

## Limitations

- The shim can only translate what FM emits: with `tool_choice:auto` the model
  usually returns zero `tool_calls` unless it emits marker syntax.
- Only `call:…{…}` with balanced braces is translated; unbalanced/truncated
  markers pass through (fail open).
- SSE streaming translates per `delta.content` chunk containing `call:`; a call
  split across chunk boundaries may pass through untranslated.
- No LLM second-pass translator by design (regex is faster/cheaper/deterministic);
  add flag-gated only if a no-match case needs it.
- Local-only: `fm serve` and this shim are for on-device / Private Cloud
  Compute use from this machine; do not expose `:1977` publicly.

## License

Apache License 2.0 — see [LICENSE](./LICENSE).
</summary>
</changes>
<verification>
- Performed: `bash -n shim.sh` (unchanged) + `node test.js` rerun after README-only change
- Result: [fill in]
</verification>
