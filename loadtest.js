// loadtest.js — parallel load probe for the clustered shim (Phase 2).
// NOT part of the default `node test.js` run. Usage: `node loadtest.js`.
// Spins a stub upstream (no :1976 needed) + the real shim as a child
// process on :1987 with FM_WORKERS=3, then fires 8 concurrent
// GET /v1/models + 4 concurrent canned-translation POST
// /v1/chat/completions (non-stream, `<ctrl46>call:` fixture from the
// deterministic suite), plus 1 SSE streaming translation check for
// cross-talk. Asserts all correct, then kills the test instance.
// Node stdlib only (no npm deps). Exits nonzero on any failure.
import assert from "node:assert";
import http from "node:http";
import { spawn } from "node:child_process";

const SHIM_PORT = Number(process.env.LOADTEST_PORT || 1987);
const WORKERS = process.env.FM_WORKERS || "3";
const TIMEOUT_MS = 15000;

const CANNED_MARKER =
  "<ctrl46>call:default_api:webfetch{extract_main:true,format:<ctrl46>text<ctrl46>,timeout:30,url:<ctrl46>https://example.com<ctrl46>}<ctrl46>";

function req(opts, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") })
      );
    });
    r.on("error", reject);
    r.setTimeout(TIMEOUT_MS, () => r.destroy(new Error("request timeout")));
    if (body !== undefined) r.end(body);
    else r.end();
  });
}

// ---- stub upstream: serves /v1/models + canned marker completions ---------
function startStub() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/v1/models") {
      const data = JSON.stringify({
        object: "list",
        data: [
          { id: "system", object: "model", created: 1, owned_by: "stub" },
          { id: "pcc", object: "model", created: 1, owned_by: "stub" },
        ],
      });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
      res.end(data);
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let stream = false;
        try { stream = JSON.parse(raw).stream === true; } catch {}
        if (!stream) {
          const obj = {
            id: "stub-1", object: "chat.completion", created: 1, model: "pcc",
            choices: [{ index: 0, message: { role: "assistant", content: CANNED_MARKER }, finish_reason: "stop" }],
          };
          const data = JSON.stringify(obj);
          res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
          res.end(data);
          return;
        }
        // SSE: same marker, split mid-name across two deltas + [DONE].
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const ev = (o) => "data: " + JSON.stringify(o) + "\n\n";
        const half = Math.floor(CANNED_MARKER.length / 2);
        res.write(ev({ id: "s", object: "chat.completion.chunk", created: 1, model: "pcc", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }));
        res.write(ev({ id: "s", object: "chat.completion.chunk", created: 1, model: "pcc", choices: [{ index: 0, delta: { content: CANNED_MARKER.slice(0, half) }, finish_reason: null }] }));
        res.write(ev({ id: "s", object: "chat.completion.chunk", created: 1, model: "pcc", choices: [{ index: 0, delta: { content: CANNED_MARKER.slice(half) }, finish_reason: null }] }));
        res.write(ev({ id: "s", object: "chat.completion.chunk", created: 1, model: "pcc", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
        res.write("data: [DONE]\n\n");
        res.end();
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"stub: not found"}');
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function waitForHealth(port, child) {
  const t0 = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error("shim child exited early (code " + child.exitCode + ")");
    try {
      const r = await req({ hostname: "127.0.0.1", port, path: "/health", method: "GET" });
      if (r.status === 200) return;
    } catch {}
    if (Date.now() - t0 > TIMEOUT_MS) throw new Error("shim :"+port+" never became healthy");
    await new Promise((r) => setTimeout(r, 200));
  }
}

let pass = 0;
const childState = { child: null, stub: null };
async function cleanup() {
  if (childState.child && childState.child.exitCode === null) {
    childState.child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 800));
    if (childState.child.exitCode === null) childState.child.kill("SIGKILL");
  }
  if (childState.stub) await new Promise((r) => childState.stub.close(r));
}
process.on("SIGINT", async () => { await cleanup(); process.exit(130); });

try {
  // Pre-check: test port must be free (never touch the live :1977).
  assert.notEqual(SHIM_PORT, 1977, "load probe must not use the live :1977 port");
  try {
    await req({ hostname: "127.0.0.1", port: SHIM_PORT, path: "/health", method: "GET" });
    throw new Error("port :" + SHIM_PORT + " already in use — aborting");
  } catch (e) {
    if (!/ECONNREFUSED|already in use/.test(e.message)) throw e;
    if (/already in use/.test(e.message)) throw e;
  }

  const stub = await startStub();
  childState.stub = stub;
  const stubPort = stub.address().port;
  console.log("stub upstream on :" + stubPort);

  const child = spawn("node", ["shim.js"], {
    cwd: new URL(".", import.meta.url).pathname,
    env: { ...process.env, AFM_SHIM_PORT: String(SHIM_PORT), AFM_UPSTREAM: "http://127.0.0.1:" + stubPort + "/v1", FM_WORKERS: WORKERS },
    stdio: ["ignore", "pipe", "pipe"],
  });
  childState.child = child;
  child.stderr.on("data", (c) => process.stderr.write("[shim-test] " + c));
  child.on("error", (e) => { throw e; });
  await waitForHealth(SHIM_PORT, child);
  console.log(`shim test instance healthy :${SHIM_PORT} (FM_WORKERS=${WORKERS})`);

  // Phase A: 8 concurrent /v1/models + 4 concurrent canned POSTs.
  const t0 = Date.now();
  const modelCalls = Array.from({ length: 8 }, () =>
    req({ hostname: "127.0.0.1", port: SHIM_PORT, path: "/v1/models", method: "GET" })
  );
  const chatPayload = JSON.stringify({ model: "pcc", messages: [{ role: "user", content: "probe" }], stream: false });
  const chatCalls = Array.from({ length: 4 }, () =>
    req(
      { hostname: "127.0.0.1", port: SHIM_PORT, path: "/v1/chat/completions", method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(chatPayload) } },
      chatPayload
    )
  );
  const [modelRes, chatRes] = await Promise.all([
    Promise.all(modelCalls),
    Promise.all(chatCalls),
  ]);
  const dtMs = Date.now() - t0;

  for (const [i, r] of modelRes.entries()) {
    assert.equal(r.status, 200, "models[" + i + "] status");
    const obj = JSON.parse(r.body);
    const ids = (obj.data || []).map((m) => m.id).sort();
    assert.deepEqual(ids, ["pcc", "system"], "models[" + i + "] ids");
    assert.equal(r.headers["x-afm-shim"], "1", "models[" + i + "] shim header");
  }
  pass += modelRes.length;
  console.log(`PASS 8 concurrent /v1/models (all correct, ids [pcc,system])`);

  for (const [i, r] of chatRes.entries()) {
    assert.equal(r.status, 200, "chat[" + i + "] status");
    const obj = JSON.parse(r.body);
    const msg = obj.choices[0].message;
    assert.ok(msg.tool_calls && msg.tool_calls.length === 1, "chat[" + i + "] one tool_call");
    assert.equal(msg.tool_calls[0].function.name, "webfetch", "chat[" + i + "] name");
    assert.equal(JSON.parse(msg.tool_calls[0].function.arguments).url, "https://example.com", "chat[" + i + "] url");
    assert.equal(msg.content, "", "chat[" + i + "] content empty");
    assert.equal(obj.choices[0].finish_reason, "tool_calls", "chat[" + i + "] finish");
  }
  pass += chatRes.length;
  console.log(`PASS 4 concurrent canned-translation POSTs (webfetch https://example.com, finish tool_calls)`);
  console.log(`Phase A wall time: ${dtMs} ms for 12 concurrent requests`);

  // Phase B: 1 SSE streaming translation check (cross-talk).
  const ssePayload = JSON.stringify({ model: "pcc", messages: [{ role: "user", content: "probe" }], stream: true });
  const sse = await req(
    { hostname: "127.0.0.1", port: SHIM_PORT, path: "/v1/chat/completions", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(ssePayload), accept: "text/event-stream" } },
    ssePayload
  );
  assert.equal(sse.status, 200, "sse status");
  assert.ok(sse.body.endsWith("data: [DONE]\n\n"), "sse ends with [DONE]");
  const payloads = sse.body.split("\n\n").filter((e) => e.startsWith("data:")).map((e) => e.slice(5).trim());
  assert.equal(payloads[payloads.length - 1], "[DONE]", "sse last payload [DONE]");
  const objs = payloads.slice(0, -1).map((p) => JSON.parse(p));
  const withCalls = objs.filter((o) => (o.choices || []).some((c) => c.delta && c.delta.tool_calls));
  assert.equal(withCalls.length, 1, "exactly one tool_calls chunk");
  assert.equal(withCalls[0].choices[0].delta.tool_calls[0].function.name, "webfetch", "sse name");
  assert.equal(JSON.parse(withCalls[0].choices[0].delta.tool_calls[0].function.arguments).url, "https://example.com", "sse url");
  for (const o of objs)
    for (const c of o.choices || [])
      assert.ok(!String(c.delta?.content || "").includes("call:"), "no marker leak in SSE re-emit");
  pass += 1;
  console.log("PASS 1 SSE streaming translation (split-marker buffered, no leak, ends [DONE])");

  await cleanup();
  console.log(`\nload probe: ${pass}/13 checks passed (8 models + 4 POST + 1 SSE), test instance killed`);
} catch (e) {
  console.error("FAIL load probe: " + (e?.message || e));
  await cleanup();
  process.exitCode = 1;
}
