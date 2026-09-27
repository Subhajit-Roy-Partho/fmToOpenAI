// afm-openai-shim — HTTP proxy: LISTEN (default :1977) -> UPSTREAM http://127.0.0.1:1976/v1
// Translates Apple FM `call:default_api:*` marker syntax into OpenAI tool_calls.
// Node stdlib only (no npm deps). ESM ("type": "module").
//
// Markers seen from `fm serve` (models `system`, `pcc`) when sent `tools`:
//   raw control chars:  \x16 ... \x17  (0x16 = \x16/SYN, 0x17 = \x17/ETB)
//   literal strings in logs: `<ctrl46>`, `<ctrl45>`, `[CTRL..]`
// Examples:
//   <ctrl46>call:default_api:get_time{}<ctrl46>
//   <ctrl46>call:default_api:webfetch{extract_main:true,format:<ctrl46>text<ctrl46>,timeout:30,url:<ctrl46>https://...<ctrl46>}<ctrl46>
//
// Behaviour:
//   - forward /v1/models + /v1/chat/completions (stream:false and SSE stream:true)
//   - on match emit OpenAI tool_calls:[{id,type:function,function:{name,arguments}}],
//     finish_reason=tool_calls, strip residue from content
//   - multiple calls per content supported; malformed input fails open (passthrough)
//   - FM_STRIP_MARKERS=1: strip markers without translating (fm-proxy style)
//   - tool_choice required/named: trivial response_format rewrite attempt, else passthrough

import http from "node:http";
import { randomUUID } from "node:crypto";

export const UPSTREAM_RAW = process.env.AFM_UPSTREAM || "http://127.0.0.1:1976/v1";
// Normalise: upstream may be given with or without the /v1 suffix; request
// paths always arrive as /v1/... so strip a trailing /v1 to avoid /v1/v1/.
export const UPSTREAM_BASE = UPSTREAM_RAW.replace(/\/v1\/?$/, "").replace(/\/$/, "");
export const UPSTREAM = UPSTREAM_BASE + "/v1";
export const LISTEN_PORT = Number(process.env.AFM_SHIM_PORT || process.env.PORT || 1977);
const STRIP_ONLY = process.env.FM_STRIP_MARKERS === "1";

// ---- marker normalisation -------------------------------------------------
// Replace every marker flavour with \x16 (open) / \x17 (close) so one regex
// handles all inputs. Order matters: multi-char literals first.
export function normalizeMarkers(s) {
  if (typeof s !== "string") return s;
  return s
    .replace(/<ctrl46>/gi, "\x16")
    .replace(/<ctrl45>/gi, "\x17")
    .replace(/\[CTRL[^\]]*\]/gi, (m) => (/45|17|ETB|CLOSE/i.test(m) ? "\x17" : "\x16"))
    .replace(/<0x16>|<0x17>|&lt;ctrl4[56]&gt;/gi, (m) => (/17|56/i.test(m) ? "\x17" : "\x16"));
}

export function stripMarkers(s) {
  if (typeof s !== "string") return s;
  return normalizeMarkers(s).replace(/[\x16\x17]/g, "");
}

// ---- call extraction ------------------------------------------------------
// Finds `call:(default_api:)?NAME {balanced braces}` occurrences.
// Returns { calls: [{name, argsText}], cleaned } where cleaned is the input
// with the full call expressions removed.
export function extractCalls(content) {
  const calls = [];
  if (typeof content !== "string" || !content.includes("call:")) {
    return { calls, cleaned: content };
  }
  const text = normalizeMarkers(content);
  const out = [];
  let last = 0;
  const re = /call:(?:default_api:)?([A-Za-z0-9_-]+)\s*(\{)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    const braceStart = m.index + m[0].length - 1; // index of '{'
    // greedy-balance braces from braceStart
    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < text.length; i++) {
      const ch = text[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) continue; // unbalanced -> skip (fail open)
    const argsText = text.slice(braceStart, end + 1);
    calls.push({ name, argsText });
    out.push(text.slice(last, m.index));
    last = end + 1;
    re.lastIndex = last;
  }
  out.push(text.slice(last));
  const cleaned = out.join("").replace(/[\x16\x17]/g, "").trim();
  return { calls, cleaned };
}

// Parse the brace payload into an args object.
// 1) try JSON.parse after stripping control chars
// 2) fallback: extract url/format/timeout keys (webfetch shape)
// 3) otherwise {}
export function parseArgs(argsText) {
  const clean = String(argsText).replace(/[\x16\x17]/g, "");
  try {
    const o = JSON.parse(clean);
    if (o && typeof o === "object") return o;
  } catch {}
  // lenient fallback: quote bare keys/values then retry once
  try {
    const lenient = clean
      .replace(/([{,]\s*)([A-Za-z0-9_.-]+)\s*:/g, '$1"$2":')
      .replace(/:\s*([A-Za-z][A-Za-z0-9_./:+-]*)/g, (mm, v) => {
        if (/^(true|false|null|-?\d+(\.\d+)?)$/.test(v)) return ": " + v;
        if (/^".*"$/.test(v)) return ": " + v;
        return ': "' + v + '"';
      });
    const o = JSON.parse(lenient);
    if (o && typeof o === "object") return o;
  } catch {}
  // webfetch-targeted extraction
  const out = {};
  try {
    const url = clean.match(/https?:\/\/[^\s"'\\}]+/);
    if (url) out.url = url[0];
    const fmt = clean.match(/format\s*:\s*"?([A-Za-z]+)"?/i);
    if (fmt) out.format = fmt[1];
    const to = clean.match(/timeout\s*:\s*(\d+)/i);
    if (to) out.timeout = Number(to[1]);
    const em = clean.match(/extract_main\s*:\s*(true|false)/i);
    if (em) out.extract_main = em[1] === "true";
  } catch {}
  return out;
}

let callSeq = 0;
export function toToolCall(name, argsObj) {
  callSeq += 1;
  const id = "call_" + randomUUID().replace(/-/g, "").slice(0, 12) + "_" + String(callSeq);
  return { id, type: "function", function: { name, arguments: JSON.stringify(argsObj ?? {}) } };
}

// Translate assistant message content -> { content, tool_calls, finish_reason }
// Never throws: fails open to { content: original }.
export function translateContent(content) {
  try {
    if (typeof content !== "string" || !content.includes("call:")) {
      if (STRIP_ONLY && typeof content === "string" && /[\x16\x17]|<ctrl4[56]>|\[CTRL/i.test(content)) {
        return { content: stripMarkers(content), tool_calls: undefined };
      }
      return { content };
    }
    if (STRIP_ONLY) return { content: stripMarkers(content), tool_calls: undefined };
    const { calls, cleaned } = extractCalls(content);
    if (calls.length === 0) {
      // no balanced match: optionally strip stray markers, else passthrough
      if (/[\x16\x17]|<ctrl4[56]>|\[CTRL/i.test(content)) {
        const stripped = stripMarkers(content);
        if (stripped !== content) return { content: stripped };
      }
      return { content };
    }
    const tool_calls = calls.map((c) => toToolCall(c.name, parseArgs(c.argsText)));
    return { content: cleaned || "", tool_calls, finish_reason: "tool_calls" };
  } catch {
    return { content };
  }
}

// Apply translation to a non-streaming chat.completion response object.
export function translateResponse(obj) {
  try {
    const choice = obj?.choices?.[0];
    const msg = choice?.message;
    if (!msg || typeof msg.content !== "string") return false;
    const before = msg.content;
    const r = translateContent(before);
    if (!r.tool_calls) {
      if (typeof r.content === "string" && r.content !== before) { msg.content = r.content; return true; }
      return false;
    }
    msg.content = r.content;
    msg.tool_calls = r.tool_calls;
    if (r.finish_reason) choice.finish_reason = r.finish_reason;
    return true;
  } catch {
    return false;
  }
}

// ---- request pre-processing: tool_choice ----------------------------------
// `fm serve` rejects forced tool_choice. Trivial rewrite (fm-proxy idea):
// required/named -> auto + response_format json hint. Everything else passes
// through untouched.
export function rewriteRequestBody(body) {
  try {
    if (!body || typeof body !== "object") return body;
    const tc = body.tool_choice;
    if (tc === "required") {
      return { ...body, tool_choice: "auto" };
    }
    if (tc && typeof tc === "object" && (tc.type === "function" || tc.function)) {
      const out = { ...body, tool_choice: "auto" };
      if (!out.response_format) out.response_format = { type: "json_object" };
      return out;
    }
    return body;
  } catch {
    return body;
  }
}

// ---- proxy ----------------------------------------------------------------
function sendJson(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

function forwardUpstream(res, status, data, headers) {
  // passthrough with original status; strip hop-by-hop + content-length (recomputed)
  const h = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const lk = k.toLowerCase();
    if (["content-length", "transfer-encoding", "connection"].includes(lk)) continue;
    if (lk.startsWith("access-control-")) continue;
    h[k] = v;
  }
  res.writeHead(status, h);
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function sseTranslateAndRelay(upstreamRes, clientRes) {
  clientRes.writeHead(upstreamRes.statusCode || 200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  let buf = "";
  upstreamRes.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const event = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = event.split("\n");
      const dataLines = lines.filter((l) => l.startsWith("data:"));
      if (dataLines.length === 0) { clientRes.write(event + "\n\n"); continue; }
      const payload = dataLines.map((l) => l.slice(5).trimStart()).join("\n");
      if (payload === "[DONE]") { clientRes.write("data: [DONE]\n\n"); continue; }
      try {
        const obj = JSON.parse(payload);
        let touched = false;
        for (const ch of obj?.choices || []) {
          const delta = ch?.delta;
          if (delta && typeof delta.content === "string" && delta.content.includes("call:")) {
            const r = translateContent(delta.content);
            if (r.tool_calls) {
              delta.content = r.content || "";
              delta.tool_calls = r.tool_calls;
              if (r.finish_reason) ch.finish_reason = r.finish_reason;
              touched = true;
            } else if (r.content !== delta.content) {
              delta.content = r.content;
              touched = true;
            }
          }
        }
        clientRes.write("data: " + JSON.stringify(obj) + "\n\n");
        void touched;
      } catch {
        clientRes.write(event + "\n\n"); // fail open
      }
    }
  });
  upstreamRes.on("end", () => {
    if (buf.trim()) clientRes.write(buf);
    clientRes.end();
  });
  upstreamRes.on("error", () => { try { clientRes.end(); } catch {} });
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const path = url.pathname;
      // health
      if (req.method === "GET" && (path === "/" || path === "/health")) {
        return sendJson(res, 200, { status: "ok", upstream: UPSTREAM });
      }
      if (!path.startsWith("/v1/")) return sendJson(res, 404, { error: "not found (shim serves /v1/*)" });
      const target = UPSTREAM_BASE + path + url.search;
      if (req.method === "GET") {
        // models passthrough (also add shim marker header)
        http.get(target, (up) => {
          const chunks = [];
          up.on("data", (c) => chunks.push(c));
          up.on("end", () => {
            const data = Buffer.concat(chunks);
            res.setHeader("x-afm-shim", "1");
            forwardUpstream(res, up.statusCode || 200, data, up.headers);
          });
        }).on("error", (e) => sendJson(res, 502, { error: "upstream unreachable: " + e.message }));
        return;
      }
      if (req.method === "POST" && path === "/v1/chat/completions") {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw); } catch { return sendJson(res, 400, { error: "invalid JSON" }); }
        const stream = body.stream === true;
        body = rewriteRequestBody(body);
        const payload = JSON.stringify(body);
        const u = new URL(target);
        const upReq = http.request(
          { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: "POST",
            headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
          (up) => {
            if (stream) return sseTranslateAndRelay(up, res);
            const chunks = [];
            up.on("data", (c) => chunks.push(c));
            up.on("end", () => {
              const data = Buffer.concat(chunks).toString("utf8");
              try {
                const obj = JSON.parse(data);
                translateResponse(obj);
                res.setHeader("x-afm-shim", "1");
                return sendJson(res, up.statusCode || 200, obj);
              } catch {
                res.setHeader("x-afm-shim", "1");
                return forwardUpstream(res, up.statusCode || 200, Buffer.from(data), up.headers);
              }
            });
          }
        );
        upReq.on("error", (e) => sendJson(res, 502, { error: "upstream unreachable: " + e.message }));
        upReq.end(payload);
        return;
      }
      return sendJson(res, 404, { error: "not found" });
    } catch (e) {
      try { return sendJson(res, 500, { error: String(e?.message || e) }); } catch {}
    }
  });
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  const server = createServer();
  server.listen(LISTEN_PORT, "127.0.0.1", () => {
    console.log(`[afm-openai-shim] listening :${LISTEN_PORT} -> ${UPSTREAM}`);
  });
}
