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
6. (lib-2 appendix, §6) ` ```json {"tool_calls":[…]} ``` ` fence shape —
   right calls, wrong envelope (A2 agent run); bash calls extracted with the
   webfetch arg schema (`{"url":…}` instead of `{"command":…}`, A3 shim).
7. (lib-2 appendix, §6) Empty 1-token punts: `content:""`, `finish:stop`
   (L1/L3 direct) — model declines without emitting anything.

## 6. lib-2 canonical prompts appendix (2026-09-27, same method)

Ground truth (this machine): Python **3.11.16**, macOS **27.2**. Same raw-HTTP
`tools:[webfetch,bash]` direct-vs-shim protocol as §2, plus one agent run per
class (C1, R1, L1, A2). Raw logs: `/tmp/lib2_*_197{6,7}.json`,
`/tmp/lib2agent_*.log` (machine-local, not committed).

| prompt | direct `:1976` | via shim `:1977` | agent (`afm-agent` → `:1976`) | verdict |
|---|---|---|---|---|
| C1 `has_close_elements` | correct O(n²) fn, stop, no tools; executed 4/4 (incl. `[]`→False, dup→True) | correct fn; executed 4/4 | correct fn; executed 2/2 examples | **PASS all three** |
| C2 `parse_nested_parens` | correct depth fn; executed `[2,3,1,3]`, `[1]`, `[4]` | byte-identical correct fn; executed 3/3 | n/a (class covered by C1 run) | **PASS (HTTP both)** |
| C4 median even-fix | correct odd/even branches; `median([1,2,3,4])=2.5`, `([1,2,3])=2`; executed 4/4 | same; executed 4/4 | n/a | **PASS (HTTP both)** |
| R1 Janet ducks (7 ducklings, adults=2×) | `21` | `21` | `21` | **PASS all three** |
| R3 99 passes Alice→Bob→Claire→… | ` ```bash echo $((99 % 3)) ``` ` fence — **no answer, no call** | identical fence | n/a (class covered by R1 run) | **FAIL answer + MISS shape** (expected `Alice`; 99%3=0) |
| L1 python+macOS versions via bash | **empty `content:""`, 1 completion token**, stop | **3× bash `tool_calls`**, finish `tool_calls` — but args degraded (`{}` twice, `{"command":"sw_vers"}` once) and content **hallucinates `Python 3.9.6` + `macOS 13.6.6 Ventura`** vs actual 3.11.16/27.2 | attempt 1: **empty log (0 bytes)**; attempt 2: unexecuted ` ```bash python3 --version / sw_vers ``` ` fence, no versions | **tool-choice PASS, answers FAIL**: shim translates, but single-turn content fabricates stale results; agent never executes |
| L3 Sept-2026 iPhone event via webfetch | empty `content:""`, stop (same punt as L1) | "Sept 2026 is in the future… confirm the date" — **stale internal clock**, no fetch | n/a (class covered by L1 runs) | **FLAG**: no fabrication, but no tool use; model unaware today is 2026-09-27 |
| A2 two fetches (python docs + W3Schools) then compare | **2× `call:default_api:webfetch` markers leak** (both URLs) + inline page-dump, stop | **2× clean webfetch `tool_calls`** (both URLs, `extract_main:true`), finish `tool_calls`; comparison already in content | markers leak → **safety-guardrail trip** → retry emits ` ```json {"tool_calls":[…]} ``` ` fence (both URLs correct) + **fabricated** ` ```text Output from webfetch calls… ` comparison; exit 1; **no real tool executed** | **shim translates multi-call correctly; agent loop via `:1976` cannot execute either shape** |
| A3 fetch openai/human-eval, summarize | webfetch + **bash/curl-fallback markers leak** (tool-choice redundancy), stop; knowledge summary correct (164 problems, pass@k) | 2 `tool_calls` (webfetch clean; **bash args wrong-schema: `{"url":…}` not `{"command":…}`**), finish `tool_calls`; summary correct | n/a (class covered by A2 run) | **translation PASS with arg-schema MISS on bash** |

New findings beyond §4:
- **Multi-call works**: A2 shim yields 2 correct `tool_calls`; L1 shim yields 3
  bash calls (arg quality degrades to `{}` on malformed payloads).
- **Inline fabrication risk**: with no execution round-trip, the model writes
  plausible-but-false tool results into `content` (L1 stale versions). The shim
  fixes the envelope, not the facts — an agentic loop must execute the calls
  and re-post outputs before answering.
- **Arg-schema bleed**: `parseArgs`' webfetch-targeted fallback stamps
  `{"url":…}` onto `bash` calls (A3). A per-tool arg mapper (bash→`command`)
  would fix the common case.
- **Guardrail interaction**: raw `<ctrl46>call:` text reaching the opencode
  agent loop can trip safety guardrails (A2 agent, exit 1) — another reason to
  route `afm-agent` through `:1977` so markers never surface as text.

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

## 7. Fix loop (2026-09-27, shim-only re-run after regex fixes — no LLM pass)

Fixes in `shim.js` (all regex/deterministic; `node --check shim.js` exit 0,
`node test.js` **18/18 passed**, was 7):
(a) R3 ```bash fences + short reasoning answers pass through untouched —
never synthesized into a `bash` tool_call (tests 6–7);
(b) per-tool arg validation: `bash` requires `command`, `webfetch` requires
`url`; unknown fields dropped; `bash` `{url}` coerced to
`{command:"curl -fsSL <url>"}`; calls with missing required args dropped,
fail open to content (tests 8–11; `parseArgs(text, toolName)` is tool-aware);
(c) ```json `{"tool_calls":[…]}` / `{"tool_use":[…]}` /
`{"name":…,"arguments":…}` fenced blocks translate to real `tool_calls`;
non-tool fences (```bash/```text/result arrays/bare JSON) never translate
(tests 12–15);
(d) empty 1-token punts pass through, never synthesize (test 16).
(e) L1 stale versions + L3 "future" clock are model-knowledge limits, not
shim bugs — intentionally not fixed in the shim.

Method: same raw-HTTP protocol as §6 (`/tmp/lib2_post.sh TAG 1977`), shim
only, one sample per prompt. "Before" = §6 via-shim column.

| prompt | before (shim, §6) | after (shim, this section) | verdict |
|---|---|---|---|
| C1 `has_close_elements` | correct fn; executed 4/4 | correct O(n²) fn; executed `[False,True,False,True]` 4/4 | **PASS, stable** |
| C2 `parse_nested_parens` | correct; executed 3/3 | correct; executed `[2,3,1,3]`, `[1]` | **PASS, stable** |
| C4 median even-fix | correct odd/even branches | **empty punt** (`content:""`, 0 completion tokens), 0 calls, passed through | model sampling flipped; shim correct (no spurious call) — cf. test 16 |
| R1 Janet ducks | `21` | `21` | **PASS, stable** |
| R3 99 passes | ` ```bash echo $((99 % 3)) ``` ` fence, no answer | `Bob` (wrong — expected `Alice`, 99%3=0), 0 calls, passed through | model sampling flipped AND answer wrong; shim correct both times (never a `bash` call) — fence shape pinned by canned test 6 |
| L1 versions via bash | 3× bash calls (`{}`,`{}`,`sw_vers`) + hallucinated `3.9.6/13.6.6` | **empty punt** (`content:""`, 1 completion token), 0 calls, passed through | model sampling flipped; `{}`-drop pinned by canned test 9; coercion pinned by test 8 |
| L3 Sept-2026 event | stale-clock narration, no fetch | identical stale-clock narration, 0 calls, passed through | **unchanged (model-knowledge limit, per (e))** |
| A2 two fetches + compare | 2× clean webfetch calls | 2× clean webfetch calls (`extract_main:true`, both URLs), `finish:tool_calls`; ```json result-array in content correctly NOT translated | **PASS, stable; (c) live** |
| A3 human-eval fetch | webfetch clean + **bash wrong-schema `{"url":…}`** | webfetch clean + **bash `{"command":"curl -s https://raw.githubusercontent.com/openai/human-eval/master/README.md \| head -n 30"}`** | **ARG-SCHEMA FIX DEMONSTRATED LIVE** (b) |

Takeaways:
- The two shim bugs with live proof are fixed: A3 bash args (`url`→`command`)
  and the ```json tool fence shape (A2-agent shape covered by canned test 12;
  live A2 runs keep using `call:` markers, which still translate).
- `finish_reason:tool_calls` fired exactly on the two prompts where the model
  emitted calls (A2, A3); the other seven passed through with `finish:stop`
  and zero synthesized calls.
- Sampling nondeterminism dominates the before→after deltas (R3 fence→wrong
  name, C4 correct→punt, L1 calls→punt). Every delta is model-side; shim
  behavior was correct in all 9 cells. Raw logs: `/tmp/lib2_*_1977.json`
  (overwritten by this re-run), per-prompt summaries `/tmp/lib2fix_*.log`.

## 8. Config rewire + verification (2026-09-27, translator route live)

Port: **1977 kept** (`lsof -i :1977` empty before start; `fm serve` owns
:1976). `shim.sh` lifecycle (`start|stop|restart|status`, pidfile
`/tmp/afm-openai-shim.1977.pid`, log `shim.1977.log` in repo dir, gitignored):
`./shim.sh start` → pid 55828, `/health` → `{"status":"ok",
"upstream":"http://127.0.0.1:1976/v1"}`. One fix during this section:
pidfile first captured the subshell pid — now records the `lsof -ti :PORT`
listener; verified `stop`→port free→`start`→same pid listens.
Config (`~/.config/opencode/opencode.jsonc`, ONLY this hunk changed):
`provider.apple-fm.options.baseURL` `http://127.0.0.1:1976/v1` →
`http://127.0.0.1:1977/v1`, with a comment noting the direct `:1976`
fallback (raw markers leak). No other lines touched.

Verification (from `/tmp/afm-agent-check2`):
1. `opencode run --model apple-fm/pcc --agent afm-agent "What is 2+2?
   Answer with just the number."` → **`4`**, no tool. Wiring proof:
   with the shim stopped the same command loops `> afm-agent · pcc`
   retries until timeout (exit 124) — agent traffic routes via `:1977`.
2. Webfetch agent prompt ("Fetch https://example.com with webfetch now…"):
   attempt 1 printed an unexecuted ` ```json {"tool_name":"webfetch",…} ```
   block and stopped — a THIRD fence-envelope shape (singular `tool_name`,
   §7 covered `tool_calls`/`tool_use`/`name`). Parser extended the same
   day (`parseFenceEnvelope` accepts `tool_name`, canned test 18,
   suite now **19/19**). Attempts 2–3 emitted `call:default_api:webfetch`
   markers split across SSE chunks (per-chunk translation can't fire —
   known §4 miss #4, still open) plus a fabricated ```text result from
   knowledge: **no end-to-end tool execution in any agent run yet**.
3. Shim-log evidence (non-streaming raw HTTP via `:1977`, same prompt):
   `finish_reason:tool_calls`, 1 call
   `webfetch {"url":"https://example.com"}`, and the log line
   `[shim] translated 1 tool_call(s): webfetch`. Both the non-streaming
   and SSE translate paths now log one line per translation (logging-only
   addition; `node --check` + 19/19 green before and after).
   (One transient upstream HTTP 500 observed on an earlier attempt;
   retry succeeded — FM-side flake, shim passed it through.)

Bottom line: the translator route is live for `afm-agent`, the deterministic
suite pins all observed shapes (markers, 3 json-fence envelopes, bash-fence
and punt passthrough, per-tool arg validation), and the remaining gap is
the agent streaming path (split-across-chunks calls), which needs either
client-side buffering or a streaming assembler — not a regex tweak.
