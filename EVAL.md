# EVAL — fmToOpenAI shim (`:1977 → :1976`) + afm-agent, deterministic regex path only

Date (UTC): 2026-09-27. Model: `pcc` via `fm serve` (`http://127.0.0.1:1976/v1`).
Shim: `node shim.js` (default `LISTEN :1977 → UPSTREAM http://127.0.0.1:1976/v1`),
**no LLM second-pass translator** — translation is `normalizeMarkers` +
`extractCalls` (balanced-brace) + `parseArgs` only.
Method: raw HTTP `POST /v1/chat/completions` with
`tools:[webfetch, bash]` + `tool_choice:auto` against `:1976` (direct) and
`:1977` (via shim), same prompt each side; plus
`timeout 170 opencode run --model apple-fm/pcc --agent afm-agent "<prompt>"`
from `/tmp/afm-agent-check2` (provider `apple-fm` points at `:1976`, so agent
runs are direct-model evidence). Agent tool firing judged by answer content
(no `tool.execute.before` evidence observable; no tool-result blocks appeared).

## 1. Baseline

- `node --check shim.js` → exit 0.
- `node test.js` → **7 checks passed** (`get_time` shape, webfetch nested
  markers, no-tool passthrough, multiple calls, malformed fail-open,
  shim `/health`, live `:1976` reachable probe).
- `curl -s localhost:1977/v1/models` →
  `{"object":"list","data":[{...,"id":"system",...},{...,"id":"pcc",...}]}` —
  shim forwards to `:1976` correctly (`x-afm-shim: 1` set on relayed replies).

## 2. Matrix

| prompt | direct `:1976` | via shim `:1977` | agent (`afm-agent` → `:1976`) | verdict |
|---|---|---|---|---|
| coding: `fib(n)`, `fib(0)=0,fib(1)=1`, `ValueError` on neg | correct fn, `finish:stop`, no tools; executed: `fib(0,1,10)=(0,1,55)` + neg-raises | correct fn, `finish:stop`, no tools; executed: same | correct fn; executed `fib(0,1,10)=(0,1,55)` + neg-raises | **PASS all three** |
| reasoning: `(17·23+41·7)/3`, steps | 226, all steps correct (`391+287=678`) | 226, identical | 226 with sub-steps | **PASS all three** |
| reasoning: bat+ball=$1.10, bat=$1 more | `0.05` | `0.05` | n/a (one agent run per class; used math item) | **PASS (HTTP both)** |
| recent-fetch: Tempe weather, asked to use webfetch | narrates intent ("Let me attempt…"), **zero markers**, `finish:stop`, no `tool_calls` | same narration, no `tool_calls` | refuses live data ("I don't have access…"), knowledge-only | **FLAG staleness-avoided-by-refusal**: no fabrication, but no live data either |
| recent-fetch: Russia–Ukraine war news via webfetch | ` ```json {"tool_use":[{"name":"webfetch","arguments":{url news.google.com RSS…}}]} ``` ` — **not** `call:` syntax, `finish:stop`, no `tool_calls` | different sample: asks clarifying question (BBC vs Reuters), no call | n/a (class covered by weather run) | **MISS (shape not handled)** — see §4 |
| agentic: fetch `https://example.com` via webfetch, 1-sentence summary | **raw markers leak in `content`**, `finish:stop`, no `tool_calls`: `<ctrl46>call:default_api:webfetch{extract_main:true,url:<ctrl46>https://example.com<ctrl46>}<ctrl46>}<ctrl45>…` + knowledge summary | **`tool_calls` + `finish_reason:tool_calls`** (see §3) | **marker leaks into user-visible answer** (`<ctrl46>call:default_api:webfetch{…}<ctrl46>}<ctrl45>` + knowledge summary); **no `tool.execute.before` fired** anywhere | **SHIM WINS**: direct/agent leak markers; shim translates |
| agentic: bash write `hello-agentic` → `/tmp/afm_probe.txt` | ` ```bash bash -c 'echo …' ``` ` fence, no call; file **not** written | narration only ("Sure thing — here's how…"), no call; file **not** written | n/a (class covered by example.com run) | **MISS (shape not handled)** — see §4 |

Notes:
- FM sampling is nondeterministic: the two Russia runs (direct vs shim) returned
  different shapes for the identical prompt; identical coding/reasoning prompts
  returned near-identical text. One sample per cell — treat shapes as observed,
  not exhaustive.
- No `tool.execute.before` fired in any of the 4 agent runs; no tool-result
  blocks in any agent log. All agent answers are knowledge-only.

## 3. Translated `tool_calls` example (agentic webfetch via `:1977`, full JSON)

Request: `POST http://127.0.0.1:1977/v1/chat/completions`,
`model:pcc`, `tools:[webfetch,bash]`, `tool_choice:auto`,
prompt `Fetch https://example.com with webfetch now and summarize it in one sentence.`

```json
{
  "usage": {
    "completion_tokens_details": { "reasoning_tokens": 0 },
    "prompt_tokens": 181,
    "completion_tokens": 39,
    "prompt_tokens_details": { "cached_tokens": 41 },
    "total_tokens": 220
  },
  "object": "chat.completion",
  "created": 1790510467,
  "id": "chatcmpl-21BE80AF-667E-44BE-8592-064D4BBC1B94",
  "choices": [
    {
      "finish_reason": "tool_calls",
      "index": 0,
      "message": {
        "refusal": null,
        "role": "assistant",
        "content": "}",
        "tool_calls": [
          {
            "id": "call_0c082f8884f7_1",
            "type": "function",
            "function": {
              "name": "webfetch",
              "arguments": "{\"extract_main\":true,\"url\":\"https://example.com\"}"
            }
          }
        ]
      }
    }
  ],
  "model": "pcc"
}
```

Direct `:1976` for the same prompt returned the untranslated marker string in
`content` with `finish_reason:stop` and no `tool_calls` (§2 agentic row).
Caveat: residue `content:"}"` — FM's raw output double-wraps
(`…}<ctrl46>}<ctrl45>`), so one stray brace survives stripping (cosmetic;
`finish_reason:tool_calls` still signals the client correctly).

## 4. What the regex path handles vs misses

Handles (demonstrated):
- `call:default_api:NAME{…}` with `\x16/\x17`, `<ctrl46>/<ctrl45>`, `[CTRL…]`
  marker flavours → `tool_calls:[{id:call_…,type:function,function:{name,arguments}}]`,
  `finish_reason:tool_calls`, residue stripped; multiple calls per message;
  malformed/unbalanced input fails open (passthrough); `stream:false` and SSE
  per-chunk translation; `tool_choice:required`/named rewrite to `auto`.

Misses (observed live, all fail open — never translated, never error):
1. ` ```json {"tool_use":[{name,arguments}]} ``` ` code-fence shape (Russia run) —
   no `call:` substring, passes through untouched.
2. ` ```bash … ``` ` code-fence shape (bash run) — same, untouched.
3. Narration-only answers ("Let me attempt…", "Sure thing — here's how…",
   clarifying questions) that emit no markers at all — nothing to translate.
4. Split-across-chunks calls in SSE streams (per README; not exercised here).
5. Residue edge: malformed double-wrapped markers leave a stray `}` in `content`.

## 5. Conclusion

- Coding + reasoning: model is correct knowledge-only; shim is transparent
  (identical answers, `finish:stop`).
- Live-data/agentic: model emits at least three shapes; the regex path
  translates exactly one (`call:default_api:*`). The other two
  (```json `tool_use` fences, ```bash fences) and narration-only answers pass
  through, so **end-to-end tool chaining never completed in any run**.
- Strongest finding: the `example.com` agent run prints the raw
  `<ctrl46>call:…` marker to the user. Routing `afm-agent`'s provider at
  `:1977` instead of `:1976` would convert that leak into a real `tool_calls`
  round-trip (client executes `webfetch`, re-posts the result). Recommend the
  one-line `baseURL` switch plus a re-run of this matrix.
- Raw logs kept at `/tmp/eval_*_197{6,7}.json`, `/tmp/agent_*.log`,
  `/tmp/toolcalls_example.json` (machine-local, not committed).
