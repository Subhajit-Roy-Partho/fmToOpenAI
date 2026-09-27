# fmToOpenAI

OpenAI-compatible `tool_calls` shim for **Apple Foundation Models** (`fm serve`).

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
departures (and forced-mode via a `response_format` rewrite) but only **strips**
these markers — it does not translate `call:default_api:*` into `tool_calls`.
This shim does that translation with a **deterministic regex + brace-balancer**
(no second model pass: no extra round-trip on a tiny on-device model, no
hallucination risk, no extra context pressure).

## fm version tested

`fm` has no `--version` flag (`fm --version` → `Error: Unknown option
'--version'`). Tested against the `fm` CLI installed 2026-09-27
(`fm --help` shows `chat/config/count-tokens/license/models/quota-usage/respond`
subcommands) with `fm serve` on `http://127.0.0.1:1976/v1`.

## Usage

```bash
node shim.js                 # LISTEN :1977 -> UPSTREAM http://127.0.0.1:1976/v1
AFM_SHIM_PORT=1977 AFM_UPSTREAM=http://127.0.0.1:1976/v1 node shim.js
FM_STRIP_MARKERS=1 node shim.js   # strip markers without translating (fm-proxy style)
node test.js                 # deterministic suite (no fm required)
node loadtest.js             # parallel load probe: stub upstream + shim :1987 @ FM_WORKERS=3
                             # (8 concurrent /v1/models + 4 concurrent canned POSTs + 1 SSE check)
```

## Cluster workers (go-live: 3)

`shim.js` uses stdlib-only Node `cluster`, flag-gated by `FM_WORKERS`
(default 1 = single-process). `N=0` means auto (`min(cpus, 4)`); bad or
negative values fall back to 1. Workers share one `:PORT` listener via the
cluster scheduler — per-request state stays in-request, so concurrent
translations never cross-talk (proven by `node loadtest.js`).

Go-live default is **3 workers**, persisted in `shim.sh`
(`: "${FM_WORKERS:=3}"`, exported on `start`); override per-call, e.g.
`FM_WORKERS=1 ./shim.sh restart`. `./shim.sh status` reports the count
(`workers N`, single `listeners 1` in both modes).

## opencode.jsonc snippet

Point the provider at the shim instead of `fm serve` directly:

```jsonc
"provider": {
  "apple-fm": {
    "npm": "@ai-sdk/openai-compatible",
    "name": "Apple Foundation Models",
    "options": { "baseURL": "http://127.0.0.1:1977/v1" }
  }
}
```

## How it works

- Forwards `/v1/models` and `/v1/chat/completions` (`stream:false` and SSE `stream:true`).
- Normalises all marker flavours (`\x16…\x17`, `<ctrl46>`/`<ctrl45>`, `[CTRL…]`) then matches
  `call:(?:default_api:)?NAME {balanced-braces}`; args via `JSON.parse` with a
  lenient fallback (bare-key quoting, then `url`/`format`/`timeout` extraction for
  `webfetch`, `{}` otherwise).
- On match: emits `tool_calls:[{id: call_…, type: "function",
  function: {name, arguments: JSON-string}}]`, sets `finish_reason: "tool_calls"`,
  strips the call expression from `content` (remaining text kept, else `""`).
- Multiple calls per message supported. Malformed input fails open (passthrough).
- `tool_choice: "required"` → rewritten to `"auto"`; named `tool_choice` objects →
  `"auto"` + `response_format: {type: "json_object"}` hint (same idea as fm-proxy).
  Anything else passes through.

## Limitations

- `tool_choice: "auto"` + FM: the model still usually returns zero `tool_calls`
  unless it emits the marker syntax — the shim can only translate what FM emits.
- Only `call:…{…}` with balanced braces is translated; unbalanced/truncated
  markers pass through (fail open).
- SSE streaming: translation applies per `delta.content` chunk containing `call:`;
  a call split across chunk boundaries may pass through untranslated.
- Optional LLM second-pass translator: deliberately **not** included (regex is
  faster/cheaper/deterministic); add flag-gated only if a no-match case needs it.
- FM1 license note: local-only. `fm serve` and this shim are for on-device /
  Private Cloud Compute use from this machine; do not expose `:1977` publicly.
