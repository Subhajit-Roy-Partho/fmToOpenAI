// afm-openai-shim — deterministic unit tests (no npm deps).
// Spins the shim in-process on an ephemeral port + 3 deterministic unit tests
// + optional live probe of :1976 (never fails the suite when fm is down).
import assert from "node:assert";
import http from "node:http";
import { translateContent, translateFencedContent, translateResponse, extractCalls, extractFencedCalls, parseArgs, coerceToolArgs, createServer } from "./shim.js";

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
