"use client";

import "./globals.css";
import { useEffect } from "react";

const REPO = "https://github.com/Subhajit-Roy-Partho/fmToOpenAI";

function useReveal() {
  useEffect(() => {
    const els = document.querySelectorAll(".rv");
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        }),
      { threshold: 0.12 }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

function Eyebrow({ children }) {
  return <span className="eyebrow">{children}</span>;
}

export default function Page() {
  useReveal();

  return (
    <>
      <div className="grid-bg" />
      <div className="blob blob-a" />
      <div className="blob blob-b" />
      <div className="blob blob-c" />

      <nav className="top">
        <div className="nav-in">
          <a className="brand" href="#top">
            <span className="dot" />
            fmToOpenAI
          </a>
          <div className="nav-links">
            <a href="#problem">Problem</a>
            <a href="#how">How it works</a>
            <a href="#quickstart">Quickstart</a>
            <a href="#eval">Eval</a>
            <a href="#arch">Architecture</a>
            <a className="nav-cta" href={REPO} target="_blank" rel="noreferrer">
              GitHub ↗
            </a>
          </div>
        </div>
      </nav>

      <div className="wrap" id="top">
        {/* ---------------- HERO ---------------- */}
        <header className="hero">
          <div className="hero-load">
            <Eyebrow>Node-stdlib-only · OpenAI-compatible proxy · :1977 → :1976</Eyebrow>
          </div>
          <h1 className="hero-load-2">
            Real <span className="grad">tool_calls</span>
            <br />
            from Apple Foundation Models.
          </h1>
          <p className="sub hero-load-3">
            <code>fm serve</code> answers tool requests with a proprietary marker
            syntax instead of OpenAI-style <code>tool_calls</code>. fmToOpenAI
            sits on <code>:1977</code>, translates those markers deterministically
            — no second model pass — and hands standard{" "}
            <code>tool_calls</code> to your client.
          </p>
          <div className="hero-cta hero-load-3">
            <a className="btn btn-primary" href="#quickstart">
              Get running in 2 minutes
            </a>
            <a className="btn btn-ghost" href={REPO} target="_blank" rel="noreferrer">
              Read the code ↗
            </a>
          </div>
          <div className="badges hero-load-3">
            <span className="badge">
              deterministic suite <b>27/27</b>
            </span>
            <span className="badge">
              load probe <b>13/13</b>
            </span>
            <span className="badge">
              deps <b>zero</b> — Node stdlib only
            </span>
            <span className="badge warn">
              local only — <b>do not expose :1977</b>
            </span>
          </div>

          {/* before / after terminal */}
          <div className="demo hero-load-3">
            <div className="demo-bar">
              <span className="dot-r" style={{ background: "#fb7185" }} />
              <span className="dot-r" style={{ background: "#fbbf24" }} />
              <span className="dot-r" style={{ background: "#5eead4" }} />
              <span style={{ marginLeft: 8 }}>
                POST /v1/chat/completions · tools: [webfetch] · “Fetch https://example.com”
              </span>
            </div>
            <div className="demo-grid">
              <div className="demo-pane">
                <h4>What fm serve returns (:1976)</h4>
                <div>
                  <span className="mk">&lt;ctrl46&gt;</span>
                  call:default_api:<span className="fn-name">webfetch</span>
                  {"{extract_main:true,url:"}
                  <span className="mk">&lt;ctrl46&gt;</span>
                  https://example.com
                  <span className="mk">&lt;ctrl46&gt;</span>
                  {"}"}
                  <span className="mk">&lt;ctrl46&gt;</span>
                  <span className="cursor-blink" />
                </div>
                <div style={{ marginTop: 14, color: "#5b6b85" }}>
                  finish_reason: "stop" · tool_calls: — (none)
                </div>
              </div>
              <div className="demo-mid">
                <span className="arrow-pulse">→</span>
              </div>
              <div className="demo-pane">
                <h4>What the shim hands your client (:1977)</h4>
                <div>
                  <span className="tc">"tool_calls"</span>: [{"{"}
                  <br />
                  &nbsp;&nbsp;<span className="tc">"id"</span>: "call_…",&nbsp;
                  <span className="tc">"type"</span>: "function",
                  <br />
                  &nbsp;&nbsp;<span className="tc">"function"</span>: {"{"}
                  <span className="tc">"name"</span>:{" "}
                  <span className="fn-name">"webfetch"</span>,<br />
                  &nbsp;&nbsp;&nbsp;&nbsp;<span className="tc">"arguments"</span>:{" "}
                  '{"{"}"extract_main":true,"url":"https://example.com"{"}"}'{"}"}
                  <br />
                  {"}"}]
                </div>
                <div style={{ marginTop: 14 }} className="tc">
                  finish_reason: "tool_calls" · content: ""
                </div>
              </div>
            </div>
          </div>
        </header>

        {/* ---------------- PROBLEM ---------------- */}
        <section id="problem">
          <div className="rv">
            <Eyebrow>The problem</Eyebrow>
            <h2 className="sec">The model wants to call tools. The format is wrong.</h2>
            <p className="lead">
              Send <code>tools</code> with <code>tool_choice:auto</code> to{" "}
              <code>fm serve</code> and you get zero <code>tool_calls</code> back.
              Instead, the model emits its intent as marker text inside{" "}
              <code>content</code> — raw control characters (
              <code>\x16</code>/<code>\x17</code>, shown as{" "}
              <code>&lt;ctrl46&gt;</code>/<code>&lt;ctrl45&gt;</code> in logs)
              wrapping expressions like{" "}
              <code>call:default_api:webfetch{"{…}"}</code>. Forced{" "}
              <code>tool_choice</code> is rejected outright. Agents built on the
              OpenAI shape either print raw markers to the user or trip safety
              guardrails on them — either way, no tool ever executes.
            </p>
          </div>
          <div className="cards">
            <div className="card rv">
              <div className="n">01</div>
              <h3>Markers leak to users</h3>
              <p>
                Raw <code>&lt;ctrl46&gt;call:…</code> text shows up verbatim in
                answers when clients talk to <code>:1976</code> directly.
              </p>
            </div>
            <div className="card rv rv-d1">
              <div className="n">02</div>
              <h3>Nothing executes</h3>
              <p>
                No <code>tool_calls</code> envelope means no client round-trip:
                no fetch runs, no file gets written, results get fabricated from
                knowledge instead.
              </p>
            </div>
            <div className="card rv rv-d2">
              <div className="n">03</div>
              <h3>Stripping is not enough</h3>
              <p>
                Existing proxies delete the markers. That hides the leak but the
                tool call is still lost. This shim translates it.
              </p>
            </div>
          </div>
        </section>

        {/* ---------------- HOW IT WORKS ---------------- */}
        <section id="how">
          <div className="rv">
            <Eyebrow>How it works</Eyebrow>
            <h2 className="sec">Marker in, tool_calls out.</h2>
            <p className="lead">
              A deterministic regex plus a brace-balancer — no second model pass,
              so no extra round-trip on a small on-device model, no hallucination
              risk, no extra context pressure. Malformed input fails open and
              passes through untouched.
            </p>
          </div>
          <div className="cards">
            <div className="card rv">
              <div className="n">STEP 1 — NORMALISE</div>
              <h3>Unify marker flavours</h3>
              <p>
                Raw <code>\x16…\x17</code>, <code>&lt;ctrl46&gt;</code> text, and{" "}
                <code>[CTRL…]</code> forms are all normalised before matching.
              </p>
            </div>
            <div className="card rv rv-d1">
              <div className="n">STEP 2 — MATCH</div>
              <h3>Balanced-brace extraction</h3>
              <p>
                <code>call:(default_api:)?NAME {"{…}"}</code> is matched with
                balanced braces; args go through <code>JSON.parse</code> with a
                lenient fallback, validated per tool (<code>bash</code> needs{" "}
                <code>command</code>, <code>webfetch</code> needs <code>url</code>
                ).
              </p>
            </div>
            <div className="card rv rv-d2">
              <div className="n">STEP 3 — EMIT</div>
              <h3>Standard OpenAI framing</h3>
              <p>
                Emits <code>tool_calls:[{"{id, type, function}"}]</code> with{" "}
                <code>finish_reason: "tool_calls"</code> and empty content.
                Multiple calls per message supported.
              </p>
            </div>
          </div>

          <p className="code-label rv">TRANSLATED RESPONSE — REAL SHAPE FROM EVAL (TRIMMED)</p>
          <pre className="code rv">
{`{
  "model": "pcc",
  "choices": [{
    "finish_reason": "tool_calls",
    "message": {
      "role": "assistant",
      "content": "",
      "tool_calls": [{
        "id": "call_0c082f8884f7_1",
        "type": "function",
        "function": {
          "name": "webfetch",
          "arguments": "{\\"extract_main\\":true,\\"url\\":\\"https://example.com\\"}"
        }
      }]
    }
  }]
}`}
          </pre>
          <p className="code-label rv">ALSO HANDLED — JSON FENCE ENVELOPES THE MODEL SOMETIMES EMITS</p>
          <pre className="code rv">
{`// \`\`\`json {"tool_calls": [...]} / {"tool_use": [...]} / {"tool_name": ...}\`\`\`
//  → translated the same way.  \`\`\`bash / \`\`\`text / narration-only
//  answers pass through untouched — never synthesized into calls.`}
          </pre>
        </section>

        {/* ---------------- QUICKSTART ---------------- */}
        <section id="quickstart">
          <div className="rv">
            <Eyebrow>Quickstart</Eyebrow>
            <h2 className="sec">Two minutes, two terminals.</h2>
            <p className="lead">
              Prerequisites: macOS with the <code>fm</code> CLI installed and{" "}
              <code>node ≥ 18</code>. No <code>npm install</code> — there are no
              dependencies.
            </p>
          </div>
          <p className="code-label rv">1 · START APPLE'S SERVER, THEN THE SHIM</p>
          <pre className="code rv">
{`$ fm serve &                                  # upstream on 127.0.0.1:1976
$ git clone ${REPO.replace("https://github.com/", "")}.git && cd fmToOpenAI
$ ./shim.sh start                             # :1977 → :1976, 3 workers
up (pid 61313, workers 3, listeners 1)
$ curl -s localhost:1977/health
{"status":"ok","upstream":"http://127.0.0.1:1976/v1"}`}
          </pre>
          <p className="code-label rv">2 · POINT YOUR CLIENT AT :1977 (OPENCODE EXAMPLE)</p>
          <pre className="code rv">
{`// ~/.config/opencode/opencode.jsonc — only this hunk changes:
"provider": {
  "apple-fm": {
    "npm": "@ai-sdk/openai-compatible",
    "name": "Apple Foundation Models",
    "options": { "baseURL": "http://127.0.0.1:1977/v1" }
  }
}`}
          </pre>
          <p className="code-label rv">3 · VERIFY (NO FM HARDWARE NEEDED FOR THE UNIT SUITE)</p>
          <pre className="code rv">
{`$ node test.js        # deterministic suite — 27/27
$ node loadtest.js    # stub-upstream load probe on :1987 — 13/13
$ ./shim.sh status    # workers N, single shared listener
$ ./shim.sh stop      # frees :1977`}
          </pre>
        </section>

        {/* ---------------- EVAL ---------------- */}
        <section id="eval">
          <div className="rv">
            <Eyebrow>Eval highlights</Eyebrow>
            <h2 className="sec">Measured, not promised.</h2>
            <p className="lead">
              Full matrix in <code>EVAL.md</code>: raw-HTTP prompts sent
              identical to <code>:1976</code> (direct) and <code>:1977</code>{" "}
              (via shim), plus agent runs. Coding and reasoning pass identically
              on both paths — the shim is transparent when there are no markers.
              Context: <code>pcc</code> 32k, <code>system</code> 8k.
            </p>
          </div>
          <div className="stat-row">
            <div className="card stat rv">
              <div className="big">27/27</div>
              <div className="cap">
                deterministic unit checks — markers, fence envelopes, arg
                validation, SSE framing, worker-count parsing
              </div>
            </div>
            <div className="card stat rv rv-d1">
              <div className="big">13/13</div>
              <div className="cap">
                load probe — 8 concurrent /v1/models + 4 concurrent POSTs in
                ~16&nbsp;ms wall, plus 1 SSE check, 3 workers, no cross-talk
              </div>
            </div>
            <div className="card stat rv rv-d2">
              <div className="big">3</div>
              <div className="cap">
                cluster workers at go-live, one shared <code>:1977</code>{" "}
                listener, per-request state kept in-request
              </div>
            </div>
          </div>
          <div className="tbl-wrap rv">
            <table className="eval">
              <thead>
                <tr>
                  <th>Prompt</th>
                  <th>Direct :1976</th>
                  <th>Via shim :1977</th>
                  <th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Fetch example.com via webfetch + summarize</td>
                  <td>Raw markers leak in content, finish stop, no calls</td>
                  <td>Real tool_calls, finish tool_calls</td>
                  <td>
                    <span className="pill pass">SHIM WINS</span>
                  </td>
                </tr>
                <tr>
                  <td>Two fetches, then compare (multi-call)</td>
                  <td>Both markers leak + page dump</td>
                  <td>2 clean webfetch calls, finish tool_calls</td>
                  <td>
                    <span className="pill pass">PASS</span>
                  </td>
                </tr>
                <tr>
                  <td>Fetch human-eval README (bash fallback)</td>
                  <td>webfetch + bash/curl markers leak</td>
                  <td>
                    webfetch clean + bash coerced to{" "}
                    <code>curl -fsSL …</code>
                  </td>
                  <td>
                    <span className="pill pass">PASS · arg fix live</span>
                  </td>
                </tr>
                <tr>
                  <td>Coding (fib, has_close_elements, median) · reasoning (226, ducks=21)</td>
                  <td>Correct, knowledge-only</td>
                  <td>Byte-identical, passthrough correct</td>
                  <td>
                    <span className="pill pass">PASS · transparent</span>
                  </td>
                </tr>
                <tr>
                  <td>Live versions / Sept-2026 event</td>
                  <td>Empty punt or stale-clock narration</td>
                  <td>Same — passed through, zero synthesized calls</td>
                  <td>
                    <span className="pill flag">MODEL LIMIT · not a shim bug</span>
                  </td>
                </tr>
                <tr>
                  <td>```bash fences · narration-only · empty punts</td>
                  <td>n/a</td>
                  <td>Pass through, never synthesized into calls</td>
                  <td>
                    <span className="pill flag">FAIL OPEN by design</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="lead rv" style={{ marginTop: 22, fontSize: 15 }}>
            Honest limits: end-to-end agent tool execution is still unproven live
            — blocked first by upstream quota, then by the model sampling
            narration instead of markers. The framing bug that previously broke
            the streaming path (content after finish reason) is fixed and proven
            live: the identical command went from exit 1 to exit 0.
          </p>
        </section>

        {/* ---------------- ARCHITECTURE ---------------- */}
        <section id="arch">
          <div className="rv">
            <Eyebrow>Architecture</Eyebrow>
            <h2 className="sec">Small surface, strict framing.</h2>
            <p className="lead">
              One file (<code>shim.js</code>), Node standard library only. It
              forwards <code>/v1/models</code> and{" "}
              <code>/v1/chat/completions</code> (plain and SSE), rewrites{" "}
              <code>tool_choice: "required"</code> to <code>"auto"</code>, and
              translates on the way back.
            </p>
          </div>
          <div className="flow rv">
            <div className="fnode">
              <h4>
                <span>CLIENT</span>opencode / curl
              </h4>
              <p>Speaks plain OpenAI against :1977.</p>
            </div>
            <div className="farrow">→</div>
            <div className="fnode">
              <h4>
                <span>SHIM · CLUSTER</span>3 workers, 1 listener
              </h4>
              <p>
                stdlib cluster shares :PORT. All translation state lives
                in-request — workers never cross-talk.
              </p>
            </div>
            <div className="farrow">→</div>
            <div className="fnode">
              <h4>
                <span>TRANSLATE</span>regex + brace match
              </h4>
              <p>
                Markers and fenced envelopes become tool_calls; residue prose is
                split out; malformed input passes through.
              </p>
            </div>
            <div className="farrow">→</div>
            <div className="fnode">
              <h4>
                <span>UPSTREAM</span>fm serve :1976
              </h4>
              <p>Models system and pcc. Local only — never expose publicly.</p>
            </div>
          </div>
          <div className="cards">
            <div className="card rv">
              <div className="n">SSE BUFFERING</div>
              <h3>Split markers still match</h3>
              <p>
                A <code>call:</code> marker can split mid-name or mid-URL across
                stream chunks. The relay buffers full content per choice, holds
                finish frames, and translates once at <code>[DONE]</code> —
                then re-emits canonical OpenAI SSE.
              </p>
            </div>
            <div className="card rv rv-d1">
              <div className="n">FRAMING RULES</div>
              <h3>Never text + calls together</h3>
              <p>
                A message carrying <code>tool_calls</code> always has{" "}
                <code>content: ""</code>; residue prose goes in a separate
                preceding chunk. Finish arrives in a dedicated terminal chunk —
                content never follows a finish reason.
              </p>
            </div>
            <div className="card rv rv-d2">
              <div className="n">LIFECYCLE</div>
              <h3>shim.sh owns the port</h3>
              <p>
                <code>start | stop | restart | status</code> with a pidfile,
                orphan reaping, and single-listener verification.{" "}
                <code>FM_WORKERS</code> overrides per call (0 = auto, max 4).
              </p>
            </div>
          </div>
        </section>

        <footer>
          <div className="foot-in" style={{ padding: 0 }}>
            <span>
              <b style={{ color: "var(--text)" }}>fmToOpenAI</b> · MIT · Node
              stdlib only · local use — do not expose :1977 publicly.
            </span>
            <span className="right">
              <a href={REPO} target="_blank" rel="noreferrer">
                Repo ↗
              </a>
              <a href={`${REPO}/blob/main/EVAL.md`} target="_blank" rel="noreferrer">
                EVAL.md ↗
              </a>
              <a href={`${REPO}/blob/main/README.md`} target="_blank" rel="noreferrer">
                README ↗
              </a>
            </span>
          </div>
        </footer>
      </div>
    </>
  );
}
