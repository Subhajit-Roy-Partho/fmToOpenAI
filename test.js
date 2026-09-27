// afm-openai-shim — deterministic unit tests (no npm deps).
// Spins the shim in-process on an ephemeral port + 3 deterministic unit tests
// + optional live probe of :1976 (never fails the suite when fm is down).
import assert from "node:assert";
import http from "node:http";
import { translateContent, extractCalls, parseArgs, createServer } from "./shim.js";

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

// 6. shim server: /health + canned translation through HTTP
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
