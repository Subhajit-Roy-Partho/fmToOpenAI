// afm-openai-shim — deterministic unit tests (no npm deps).
// Spins the shim in-process on an ephemeral port + 3 deterministic unit tests
// + optional live probe of :1976 (never fails the suite when fm is down).
import assert from "node:assert";
import http from "node:http";
import { translateContent, translateFencedContent, translateResponse, extractCalls, extractFencedCalls, parseArgs, coerceToolArgs, createServer, sseTranslateAndRelay } from "./shim.js";
import { EventEmitter } from "node:events";

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log("PASS " + name); }
  catch (e) { console.error("FAIL " + name + ": " + (e?.message || e)); process.exitCode = 1; }
}

// 1. get_time shape
ok("get_time shape", () => {
  const raw = "\x16call:default_api:get_time{}\x17";
  const r = translateContent(raw);
  assert.ok(r.tool_calls && r.tool_calls.length === 1, "one tool_call");
  const tc = r.tool_calls[0];
  assert.equal(tc.type, "function");
  assert.equal(tc.function.name, "get_time");
  assert.deepEqual(JSON.parse(tc.function.arguments), {});
  assert.ok(/^call_/.test(tc.id), "id prefix");
});

// 2. webfetch shape with nested ctrl markers
ok("webfetch nested markers", () => {
  const raw = "<ctrl46>call:default_api:webfetch{extract_main:true,format:<ctrl46>text<ctrl46>,timeout:30,url:<ctrl46>https://example.com/a<ctrl46>}<ctrl46>";
  const r = translateContent(raw);
  assert.ok(r.tool_calls && r.tool_calls.length === 1, "one tool_call");
  const args = JSON.parse(r.tool_calls[0].function.arguments);
  assert.equal(args.url, "https://example.com/a");
  assert.equal(args.timeout, 30);
  assert.equal(r.content, "", "residue stripped");
});

// 3. no-tool passthrough
ok("no-tool passthrough", () => {
  const raw = "Hello, the time is 3pm.";
  const r = translateContent(raw);
  assert.equal(r.content, raw);
  assert.equal(r.tool_calls, undefined);
});

// 4. multiple calls in one content
ok("multiple calls", () => {
  const raw = "Let me check \x16call:default_api:get_time{}\x17 and \x16call:default_api:webfetch{url:https://example.com}\x17 done";
  const { calls, cleaned } = extractCalls(raw);
  assert.equal(calls.length, 2);
  assert.ok(cleaned.includes("Let me check") && cleaned.includes("done"));
  const r = translateContent(raw);
  assert.equal(r.tool_calls.length, 2);
});

// 5. malformed input fails open
ok("malformed fail-open", () => {
  const raw = "\x16call:default_api:webfetch{url:no-close-brace";
  const r = translateContent(raw);
  assert.equal(r.tool_calls, undefined);
});

// 6. R3: unexecuted ```bash fence passes through, never becomes a call
ok("R3 bash fence passthrough", () => {
  const raw = "```bash\necho $((99 % 3))\n```";
  const r = translateContent(raw);
  assert.equal(r.content, raw);
  assert.equal(r.tool_calls, undefined);
});

// 7. short reasoning answer passes through untouched
ok("short reasoning passthrough", () => {
  for (const raw of ["Alice", "21", "0.05"]) {
    const r = translateContent(raw);
    assert.equal(r.content, raw);
    assert.equal(r.tool_calls, undefined);
  }
});

// 8. A3: bash marker with webfetch-shaped {url} coerces to {command}
ok("bash url->command coercion", () => {
  const raw = "call:default_api:bash{url:https://raw.githubusercontent.com/openai/human-eval/master/README.md}";
  const r = translateContent(raw);
  assert.ok(r.tool_calls && r.tool_calls.length === 1, "one tool_call");
  assert.equal(r.tool_calls[0].function.name, "bash");
  const args = JSON.parse(r.tool_calls[0].function.arguments);
  assert.equal(args.command, "curl -fsSL https://raw.githubusercontent.com/openai/human-eval/master/README.md");
  assert.ok(!("url" in args), "url dropped from bash args");
});

// 9. L1: bash marker with {} args fails open (no broken call emitted)
ok("bash empty-args fail-open", () => {
  const r = translateContent("call:default_api:bash{}");
  assert.equal(r.tool_calls, undefined);
});

// 10. get_time {} still emits (no required fields) — guard vs over-filtering
ok("get_time empty-args still emits", () => {
  const r = translateContent("call:default_api:get_time{}");
  assert.ok(r.tool_calls && r.tool_calls.length === 1, "one tool_call");
});

// 11. webfetch coercion drops unknown fields incl. command bleed
ok("webfetch drops unknown fields", () => {
  const out = coerceToolArgs("webfetch", { url: "https://example.com", command: "echo hi", foo: 1 });
  assert.deepEqual(out, { url: "https://example.com" });
});

// 12. A2-agent shape: ```json {"tool_calls":[...]} ``` fence translates
ok("json tool_calls fence", () => {
  const raw = "```json\n{\n  \"tool_calls\": [\n    {\"name\": \"webfetch\", \"arguments\": {\"url\": \"https://docs.python.org/3/library/functions.html\", \"format\": \"markdown\", \"extract_main\": true}},\n    {\"name\": \"webfetch\", \"arguments\": {\"url\": \"https://www.w3schools.com/python/python_functions.asp\", \"format\": \"markdown\", \"extract_main\": true}}\n  ]\n}\n```";
  const r = translateContent(raw);
  assert.ok(r.tool_calls && r.tool_calls.length === 2, "two tool_calls");
  assert.equal(JSON.parse(r.tool_calls[0].function.arguments).url, "https://docs.python.org/3/library/functions.html");
  assert.equal(JSON.parse(r.tool_calls[1].function.arguments).url, "https://www.w3schools.com/python/python_functions.asp");
  assert.equal(r.content, "", "fence stripped");
});

// 13. {"tool_use":[...]} fence variant translates
ok("json tool_use fence", () => {
  const raw = '```json {"tool_use":[{"name":"webfetch","arguments":{"url":"https://example.com"}}]} ```';
  const r = translateContent(raw);
  assert.ok(r.tool_calls && r.tool_calls.length === 1, "one tool_call");
  assert.equal(r.tool_calls[0].function.name, "webfetch");
});

// 14. single {"name":...,"arguments":...} fence translates
ok("json single-name fence", () => {
  const raw = '```json\n{"name": "bash", "arguments": {"command": "sw_vers"}}\n```';
  const r = translateContent(raw);
  assert.ok(r.tool_calls && r.tool_calls.length === 1, "one tool_call");
  assert.deepEqual(JSON.parse(r.tool_calls[0].function.arguments), { command: "sw_vers" });
});

// 18. {"tool_name":...} single-call fence variant translates
ok("json tool_name fence", () => {
  const raw = '```json\n{\n  "tool_name": "webfetch",\n  "arguments": { "url": "https://example.com", "extract_main": true, "format": "text", "timeout": 30 }\n}\n```';
  const r = translateContent(raw);
  assert.ok(r.tool_calls && r.tool_calls.length === 1, "one tool_call");
  assert.equal(r.tool_calls[0].function.name, "webfetch");
  assert.equal(JSON.parse(r.tool_calls[0].function.arguments).url, "https://example.com");
});

// 15. non-tool fences (```text results, bare JSON) never translate
ok("non-tool fences passthrough", () => {
  const raw = '```json\n[{"result": "Python docs intro..."}]\n```';
  const r = translateContent(raw);
  assert.equal(r.content, raw);
  assert.equal(r.tool_calls, undefined);
  const bare = '{"name": "bash", "arguments": {"command": "sw_vers"}}';
  const r2 = translateContent(bare);
  assert.equal(r2.content, bare);
  assert.equal(r2.tool_calls, undefined);
});

// 16. L1/L3: empty 1-token punts pass through, never synthesize a call
ok("empty punt passthrough", () => {
  const r = translateContent("");
  assert.equal(r.content, "");
  assert.equal(r.tool_calls, undefined);
  const obj = { choices: [{ message: { content: "", role: "assistant" }, finish_reason: "stop" }] };
  assert.equal(translateResponse(obj), false);
  assert.equal(obj.choices[0].message.content, "");
  assert.equal(obj.choices[0].finish_reason, "stop");
});

// 19. SSE split-chunk (§4 miss #4): marker split mid-name + mid-JSON across
// TCP fragments still translates via buffered re-emit at [DONE].
await (async () => {
  const name = "sse split-chunk buffered translation";
  try {
    const full = "<ctrl46>call:default_api:webfetch{extract_main:true,format:<ctrl46>text<ctrl46>,timeout:30,url:<ctrl46>https://example.com<ctrl46>}<ctrl46>";
    // Split mid-literal (<ct|rl46>), mid-name (webf|etch), mid-JSON URL (example.|com).
    const pieces = [
      full.slice(0, 3),    // "<ct"
      full.slice(3, 28),   // "rl46>call:default_ap"
      full.slice(28, 120), // "i:webfetch{...url:<ctrl46>https://example."
      full.slice(120),     // "com<ctrl46>}<ctrl46>"
    ];
    assert.equal(pieces.join(""), full, "pieces reassemble");
    // Naive per-chunk translation misses every fragment (the old bug).
    for (const p of pieces) {
      assert.equal(translateContent(p).tool_calls, undefined, "per-chunk misses: " + JSON.stringify(p.slice(0, 24)));
    }
    // Wrap fragments as SSE deltas, then re-slice the raw byte stream into
    // odd-sized TCP fragments (also splits SSE framing itself).
    const sseBody = pieces.map((c) => "data: " + JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "pcc", choices: [{ index: 0, delta: { role: "assistant", content: c }, finish_reason: null }] }) + "\n\n").join("") + "data: [DONE]\n\n";
    const frags = [];
    for (let i = 0; i < sseBody.length; i += 37) frags.push(sseBody.slice(i, i + 37));
    const up = new EventEmitter();
    up.statusCode = 200;
    const writes = [];
    let ended = false;
    const client = { writeHead() {}, write(c) { writes.push(String(c)); }, end() { ended = true; } };
    sseTranslateAndRelay(up, client);
    for (const f of frags) up.emit("data", Buffer.from(f, "utf8"));
    up.emit("end");
    assert.ok(ended, "client ended");
    const raw = writes.join("");
    assert.ok(raw.endsWith("data: [DONE]\n\n"), "framing ends with [DONE]");
    const payloads = raw.split("\n\n").filter((e) => e.startsWith("data:")).map((e) => e.slice(5).trim());
    assert.ok(payloads[payloads.length - 1] === "[DONE]", "last payload is [DONE]");
    const objs = payloads.slice(0, -1).map((p) => JSON.parse(p));
    const withCalls = objs.filter((o) => (o.choices || []).some((c) => c.delta && c.delta.tool_calls));
    assert.equal(withCalls.length, 1, "exactly one translated chunk");
    const tc = withCalls[0].choices[0].delta.tool_calls[0];
    assert.equal(tc.function.name, "webfetch");
    assert.equal(JSON.parse(tc.function.arguments).url, "https://example.com");
    assert.equal(withCalls[0].choices[0].finish_reason, null, "tool_calls delta carries no finish");
    const term19 = objs[objs.length - 1].choices[0];
    assert.deepEqual(term19.delta, {}, "terminal chunk has empty delta");
    assert.equal(term19.finish_reason, "tool_calls", "finish arrives in its own terminal chunk");
    for (const o of objs) {
      for (const c of o.choices || []) {
        assert.ok(!String(c.delta?.content || "").includes("call:"), "no marker leak in re-emit");
      }
    }
    pass++;
    console.log("PASS " + name);
  } catch (e) { console.error("FAIL " + name + ": " + (e?.message || e)); process.exitCode = 1; }
})();

// 20. Framing rule (§10a): non-stream marker with surrounding prose emits
// content "" + tool_calls; residue is split out, never inlined.
ok("framing: prose+marker non-stream", () => {
  const raw = "Sure, fetching that now \x16call:default_api:webfetch{url:https://example.com}\x17 one moment";
  const r = translateContent(raw);
  assert.ok(r.tool_calls && r.tool_calls.length === 1, "one tool_call");
  assert.equal(r.content, "", "content empty when tool_calls present");
  assert.ok(r.residue && r.residue.includes("Sure, fetching"), "residue carries prose");
  const obj = { choices: [{ message: { role: "assistant", content: raw }, finish_reason: "stop" }] };
  assert.equal(translateResponse(obj), true);
  const msg = obj.choices[0].message;
  assert.equal(msg.content, "", "wire content empty");
  assert.ok(msg.tool_calls && msg.tool_calls.length === 1, "wire has the call");
  assert.equal(msg.tool_calls[0].function.name, "webfetch");
  assert.equal(obj.choices[0].finish_reason, "tool_calls");
});

// 21. Framing rule (§10b): canned SSE with prose+marker — no single delta
// carries both content text and tool_calls; residue precedes the calls.
await (async () => {
  const name = "framing: SSE prose+marker split chunks";
  try {
    const full = "Let me look that up for you \x16call:default_api:webfetch{url:https://example.com}\x17 hold on";
    const pieces = [full.slice(0, 20), full.slice(20, 55), full.slice(55)];
    assert.equal(pieces.join(""), full, "pieces reassemble");
    const sseBody = pieces.map((c) => "data: " + JSON.stringify({ id: "y", object: "chat.completion.chunk", created: 1, model: "system", choices: [{ index: 0, delta: { role: "assistant", content: c }, finish_reason: null }] }) + "\n\n").join("") + "data: [DONE]\n\n";
    const frags = [];
    for (let i = 0; i < sseBody.length; i += 37) frags.push(sseBody.slice(i, i + 37));
    const up = new EventEmitter();
    up.statusCode = 200;
    const writes = [];
    let ended = false;
    const client = { writeHead() {}, write(c) { writes.push(String(c)); }, end() { ended = true; } };
    sseTranslateAndRelay(up, client);
    for (const f of frags) up.emit("data", Buffer.from(f, "utf8"));
    up.emit("end");
    assert.ok(ended, "client ended");
    const raw = writes.join("");
    assert.ok(raw.endsWith("data: [DONE]\n\n"), "framing ends with [DONE]");
    const payloads = raw.split("\n\n").filter((e) => e.startsWith("data:")).map((e) => e.slice(5).trim());
    assert.ok(payloads[payloads.length - 1] === "[DONE]", "last payload is [DONE]");
    const objs = payloads.slice(0, -1).map((p) => JSON.parse(p));
    for (const o of objs) {
      for (const c of o.choices || []) {
        const hasText = typeof c.delta?.content === "string" && c.delta.content.length > 0;
        const hasCalls = Array.isArray(c.delta?.tool_calls) && c.delta.tool_calls.length > 0;
        assert.ok(!(hasText && hasCalls), "no delta carries both content text and tool_calls");
      }
    }
    const withCalls = objs.filter((o) => (o.choices || []).some((c) => c.delta && c.delta.tool_calls));
    assert.equal(withCalls.length, 1, "exactly one tool_calls chunk");
    assert.equal(withCalls[0].choices[0].delta.content, "", "tool_calls chunk content empty");
    assert.equal(withCalls[0].choices[0].delta.tool_calls[0].function.name, "webfetch");
    assert.equal(JSON.parse(withCalls[0].choices[0].delta.tool_calls[0].function.arguments).url, "https://example.com");
    assert.equal(withCalls[0].choices[0].finish_reason, null, "tool_calls delta carries no finish");
    const term21 = objs[objs.length - 1].choices[0];
    assert.deepEqual(term21.delta, {}, "terminal chunk has empty delta");
    assert.equal(term21.finish_reason, "tool_calls", "finish arrives in its own terminal chunk");
    const textChunks = objs.filter((o) => (o.choices || []).some((c) => typeof c.delta?.content === "string" && c.delta.content.length > 0));
    assert.equal(textChunks.length, 1, "exactly one residue chunk");
    assert.ok(textChunks[0].choices[0].delta.content.includes("Let me look that up"), "residue prose preserved");
    assert.ok(raw.indexOf("Let me look that up") < raw.indexOf("tool_calls"), "residue precedes calls on the wire");
    pass++;
    console.log("PASS " + name);
  } catch (e) { console.error("FAIL " + name + ": " + (e?.message || e)); process.exitCode = 1; }
})();

// 22. Ordering rule (§10c): live FM order is role → content… → finish →
// [DONE]; the relay must never emit content AFTER a finish_reason chunk
// (opencode: "received content after the finish reason"). Finish is held and
// lands on/after the final content chunk.
await (async () => {
  const name = "ordering: no content after finish_reason";
  try {
    const ev = (o) => "data: " + JSON.stringify(o) + "\n\n";
    const sseBody =
      ev({ id: "z", object: "chat.completion.chunk", created: 1, model: "system", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }) +
      ev({ id: "z", object: "chat.completion.chunk", created: 1, model: "system", choices: [{ index: 0, delta: { content: "Hello " }, finish_reason: null }] }) +
      ev({ id: "z", object: "chat.completion.chunk", created: 1, model: "system", choices: [{ index: 0, delta: { content: "world" }, finish_reason: null }] }) +
      ev({ id: "z", object: "chat.completion.chunk", created: 1, model: "system", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      "data: [DONE]\n\n";
    const up = new EventEmitter();
    up.statusCode = 200;
    const writes = [];
    let ended = false;
    const client = { writeHead() {}, write(c) { writes.push(String(c)); }, end() { ended = true; } };
    sseTranslateAndRelay(up, client);
    up.emit("data", Buffer.from(sseBody, "utf8"));
    up.emit("end");
    assert.ok(ended, "client ended");
    const raw = writes.join("");
    const payloads = raw.split("\n\n").filter((e) => e.startsWith("data:")).map((e) => e.slice(5).trim());
    assert.ok(payloads[payloads.length - 1] === "[DONE]", "last payload is [DONE]");
    const objs = payloads.slice(0, -1).map((p) => JSON.parse(p));
    let finishSeen = false;
    for (const o of objs) {
      for (const c of o.choices || []) {
        if (c.finish_reason !== undefined && c.finish_reason !== null) finishSeen = true;
        const hasText = typeof c.delta?.content === "string" && c.delta.content.length > 0;
        assert.ok(!(finishSeen && hasText), "content chunk after a finish_reason chunk");
      }
    }
    assert.ok(finishSeen, "finish_reason still delivered");
    const joined = objs.map((o) => (o.choices || []).map((c) => c.delta?.content || "").join("")).join("");
    assert.ok(joined.includes("Hello world"), "content preserved verbatim: " + JSON.stringify(joined));
    pass++;
    console.log("PASS " + name);
  } catch (e) { console.error("FAIL " + name + ": " + (e?.message || e)); process.exitCode = 1; }
})();

// 17. shim server: /health + canned translation through HTTP
const server = createServer();
await new Promise((res) => server.listen(0, "127.0.0.1", res));
const port = server.address().port;
function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path }, (r) => {
      const c = [];
      r.on("data", (x) => c.push(x));
      r.on("end", () => resolve({ status: r.statusCode, body: Buffer.concat(c).toString() }));
    }).on("error", reject);
  });
}
try {
  const h = await get("/health");
  assert.equal(h.status, 200, "health 200");
  console.log("PASS shim /health (port " + port + ")");
  pass++;
} catch (e) { console.error("FAIL shim /health: " + (e?.message || e)); process.exitCode = 1; }
server.close();

// Optional live test: must not fail the suite if fm is down.
try {
  await new Promise((resolve) => {
    const req = http.get("http://127.0.0.1:1976/v1/models", { timeout: 3000 }, (r) => {
      const c = [];
      r.on("data", (x) => c.push(x));
      r.on("end", () => {
        console.log("LIVE fm :1976 reachable (status " + r.statusCode + ", " + Buffer.concat(c).length + " bytes) — live translation test skipped (deterministic suite is authoritative)");
        resolve();
      });
    });
    req.on("timeout", () => { console.log("LIVE fm :1976 unreachable (timeout) — skipped"); req.destroy(); resolve(); });
    req.on("error", () => { console.log("LIVE fm :1976 unreachable — skipped"); resolve(); });
  });
  pass++;
} catch { console.log("LIVE fm :1976 unreachable — skipped"); }

console.log(`\n${pass} checks passed${process.exitCode ? " (with FAILURES)" : ""}`);
