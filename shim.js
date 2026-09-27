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

// Parse the brace payload into an args object (tool-aware when toolName known).
// 1) try JSON.parse after stripping control chars
// 2) fallback: lenient quote-bare-keys retry
// 3) tool-targeted extraction: bash -> {command}, else webfetch -> {url,...}
// 4) otherwise {}
export function parseArgs(argsText, toolName) {
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
  // tool-targeted extraction (bash -> command, else webfetch shape)
  if (toolName === "bash") return extractBashArgs(clean);
  return extractWebfetchArgs(clean);
}

// bash-targeted extraction: prefer an explicit command key; else wrap a bare
// URL in a curl fallback command; else {} (coerceToolArgs drops it later).
export function extractBashArgs(clean) {
  try {
    const cmd = String(clean).match(/command\s*[:=]\s*"?([^"\n}]+)"?/i);
    if (cmd && cmd[1].trim()) return { command: cmd[1].trim() };
    const url = String(clean).match(/https?:\/\/[^\s"'\\}]+/);
    if (url) return { command: "curl -fsSL " + url[0] };
  } catch {}
  return {};
}

// webfetch-targeted extraction (url/format/timeout/extract_main keys).
export function extractWebfetchArgs(clean) {
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

// ---- per-tool arg validation ------------------------------------------------
// Known schemas; unknown tool names pass through untouched. Returns the
// coerced args object, or null when required fields are missing (the caller
// drops the call and fails open to content — never emits a broken call).
export const TOOL_SCHEMAS = {
  webfetch: { required: ["url"], optional: ["extract_main", "format", "timeout", "max_chars"] },
  bash: { required: ["command"], optional: ["timeout", "workdir", "cwd", "env"] },
  get_time: { required: [], optional: [] },
};

export function coerceToolArgs(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const schema = TOOL_SCHEMAS[name];
  if (!schema) return args; // unknown tool: pass through
  const out = {};
  // bash url->command coercion (the old webfetch-targeted fallback stamped
  // {url} onto bash calls, e.g. curl-fallback markers — A3 miss).
  if (name === "bash" && typeof args.command !== "string" && typeof args.url === "string" && args.url) {
    out.command = "curl -fsSL " + args.url;
  }
  for (const k of [...schema.required, ...schema.optional]) {
    if (k in args && args[k] !== undefined) out[k] = args[k];
  }
  for (const k of schema.required) {
    if (typeof out[k] !== "string" || !out[k].trim()) return null;
  }
  return out;
}

// ---- fenced-JSON tool-call extraction ---------------------------------------
// Translates ```json {"tool_calls":[{name,arguments}...]} ``` and the
// {"tool_use":[...]} / {"name":...,"arguments":...} variants into real
// tool_calls. ONLY json fences with a tool envelope translate — ```bash,
// ```sh, ```text and other fences always pass through as content (R3: an
// unexecuted ```bash echo ... ``` fence is narration, never a call).
// Returns { calls: [{name, args}], cleaned } like extractCalls.
export function extractFencedCalls(content) {
  const calls = [];
  if (typeof content !== "string" || !content.includes("```")) return { calls, cleaned: content };
  const out = [];
  let last = 0;
  const re = /```(?:json)?\s*\n?([\s\S]*?)\n?```/g;
  let m;
  let strippedAny = false;
  while ((m = re.exec(content)) !== null) {
    const inner = m[1].trim();
    const entries = parseFenceEnvelope(inner);
    if (!entries) continue; // not a tool envelope: leave fence in place
    for (const e of entries) {
      const norm = normalizeFenceEntry(e);
      if (norm) calls.push(norm);
    }
    if (calls.length > 0 || entries.length > 0) {
      out.push(content.slice(last, m.index));
      last = m.index + m[0].length;
      strippedAny = true;
    }
  }
  if (!strippedAny) return { calls, cleaned: content };
  out.push(content.slice(last));
  return { calls, cleaned: out.join("").trim() };
}

// Parse one fence body; return an entry array, or null when the body is not
// a tool-call envelope (plain code, prose, tool output — never a call).
function parseFenceEnvelope(inner) {
  let o;
  try { o = JSON.parse(inner); } catch { return null; }
  if (o && typeof o === "object" && !Array.isArray(o)) {
    if (Array.isArray(o.tool_calls)) return o.tool_calls;
    if (Array.isArray(o.tool_use)) return o.tool_use;
    // single-call envelope: {"name":...} or {"tool_name":...} + arguments/input
    const nm = typeof o.name === "string" ? o.name
      : (typeof o.tool_name === "string" ? o.tool_name : null);
    if (nm && ("arguments" in o || "input" in o)) {
      return [{ name: nm, arguments: ("arguments" in o) ? o.arguments : o.input }];
    }
    if (o.function && typeof o.function.name === "string") return [o];
    return null;
  }
  if (Array.isArray(o) && o.every((e) => e && typeof e.name === "string")) return o;
  return null;
}

// Normalise one fence entry -> {name, args} or null (skipped).
function normalizeFenceEntry(e) {
  try {
    if (!e || typeof e !== "object") return null;
    if (e.function && typeof e.function.name === "string") {
      return { name: e.function.name, args: coerceFenceArgs(e.function.arguments), id: e.id };
    }
    if (typeof e.name === "string") {
      const raw = ("arguments" in e) ? e.arguments : e.input;
      return { name: e.name, args: coerceFenceArgs(raw) };
    }
  } catch {}
  return null;
}

function coerceFenceArgs(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try { const o = JSON.parse(raw); if (o && typeof o === "object") return o; } catch {}
    return {};
  }
  return {};
}

let callSeq = 0;
export function toToolCall(name, argsObj, opts) {
  callSeq += 1;
  const id = (opts && typeof opts.id === "string" && opts.id) ||
    "call_" + randomUUID().replace(/-/g, "").slice(0, 12) + "_" + String(callSeq);
  return { id, type: "function", function: { name, arguments: JSON.stringify(argsObj ?? {}) } };
}

export function translateContent(content) {
// Paths: (1) call:default_api markers; (2) ```json tool_calls/tool_use/name
// fences. Everything else — ```bash fences, narration, empty punts — passes
// through untouched (never synthesize a call).
// Never throws: fails open to { content: original }.
  try {
    if (typeof content !== "string" || content === "") return { content };
    const HAS_MARKER_RE = new RegExp("[\\x16\\x17]|<ctrl4[56]>|\\[CTRL", "i");
    if (!content.includes("call:")) {
      if (STRIP_ONLY && HAS_MARKER_RE.test(content)) {
        return { content: stripMarkers(content), tool_calls: undefined };
      }
      return translateFencedContent(content);
    }
    if (STRIP_ONLY) return { content: stripMarkers(content), tool_calls: undefined };
    const { calls, cleaned } = extractCalls(content);
    if (calls.length === 0) {
      // no balanced match: optionally strip stray markers, else try fences
      if (HAS_MARKER_RE.test(content)) {
        const stripped = stripMarkers(content);
        if (stripped !== content) return { content: stripped };
      }
      return translateFencedContent(content);
    }
    // Per-tool validation: coerce/drop unknown fields; drop calls whose
    // required args are missing (fail open) instead of emitting broken calls.
    const tool_calls = [];
    for (const c of calls) {
      const coerced = coerceToolArgs(c.name, parseArgs(c.argsText, c.name));
      if (coerced === null) continue;
      tool_calls.push(toToolCall(c.name, coerced));
    }
    if (tool_calls.length === 0) return { content };
    return { content: cleaned || "", tool_calls, finish_reason: "tool_calls" };
  } catch {
    return { content };
  }
}

// Fence path: translate ```json tool envelopes; pass everything else through.
export function translateFencedContent(content) {
  try {
    const { calls, cleaned } = extractFencedCalls(content);
    if (calls.length === 0) return { content };
    const tool_calls = [];
    for (const c of calls) {
      const coerced = coerceToolArgs(c.name, c.args);
      if (coerced === null) continue;
      tool_calls.push(toToolCall(c.name, coerced, { id: c.id }));
    }
    if (tool_calls.length === 0) return { content };
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

export function sseTranslateAndRelay(upstreamRes, clientRes) {
  // Buffered SSE translation (fixes §4 miss #4: split-chunk markers).
  // Upstream FM SSE deltas arrive in arbitrary TCP/SSE fragments, so a
  // `<ctrl46>call:…` marker is routinely split mid-name or mid-JSON across
  // chunks and per-chunk translateContent() can never fire. Instead we
  // accumulate the full delta.content per choice index, forward only
  // non-content frames immediately (role, keep-alives), and run the existing
  // translateContent() ONCE over the assembled content at [DONE]/end. The
  // translated result is re-emitted as final SSE chunk(s) before [DONE], so
  // SSE event framing to the client is always valid.
  clientRes.writeHead(upstreamRes.statusCode || 200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  let buf = "";
  let template = null; // {id, object, created, model} from first chunk
  const accum = new Map(); // index -> { content, role, finish }
  const order = []; // choice indices in first-seen order
  const ensure = (idx) => {
    if (!accum.has(idx)) { accum.set(idx, { content: "", role: "assistant", finish: null }); order.push(idx); }
    return accum.get(idx);
  };
  const noteTemplate = (obj) => {
    if (!template && obj && typeof obj === "object") {
      template = {
        id: obj.id || ("chatcmpl-" + randomUUID().replace(/-/g, "").slice(0, 8)),
        object: "chat.completion.chunk",
        created: obj.created || Math.floor(Date.now() / 1000),
        model: obj.model || "pcc",
      };
    }
  };
  const flushTranslated = () => {
    const tpl = template || {
      id: "chatcmpl-" + randomUUID().replace(/-/g, "").slice(0, 8),
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "pcc",
    };
    if (order.length === 0) return; // nothing buffered (empty punt etc.)
    for (const idx of order) {
      const a = accum.get(idx);
      const full = a.content;
      if (!full) {
        if (a.finish) {
          clientRes.write("data: " + JSON.stringify({ ...tpl, choices: [{ index: idx, delta: {}, finish_reason: a.finish }] }) + "\n\n");
        }
        continue;
      }
      let r;
      try { r = translateContent(full); } catch { r = { content: full }; }
      if (r && r.tool_calls) {
        clientRes.write("data: " + JSON.stringify({
          ...tpl,
          choices: [{ index: idx, delta: { role: a.role || "assistant", content: r.content || "", tool_calls: r.tool_calls }, finish_reason: r.finish_reason || "tool_calls" }],
        }) + "\n\n");
        // Log line matches the non-streaming path's `[shim] translated N
        // tool_call(s):` prefix so one grep covers both (suffix notes SSE).
        console.error("[shim] translated " + r.tool_calls.length + " tool_call(s): " + r.tool_calls.map((t) => (t && t.function && t.function.name) || "?").join(",") + " (sse, buffered)");
      } else if (typeof r.content === "string" && r.content !== full) {
        clientRes.write("data: " + JSON.stringify({
          ...tpl, choices: [{ index: idx, delta: { role: a.role || "assistant", content: r.content }, finish_reason: a.finish || null }],
        }) + "\n\n");
      } else {
        // No translation: re-emit the assembled content verbatim as one chunk.
        clientRes.write("data: " + JSON.stringify({
          ...tpl, choices: [{ index: idx, delta: { role: a.role || "assistant", content: full }, finish_reason: a.finish || null }],
        }) + "\n\n");
      }
    }
  };
  let doneSeen = false;
  const handleEvent = (event) => {
    const lines = event.split("\n");
    const dataLines = lines.filter((l) => l.startsWith("data:"));
    if (dataLines.length === 0) { clientRes.write(event + "\n\n"); return; } // comment/keep-alive
    const payload = dataLines.map((l) => l.slice(5).trimStart()).join("\n");
    if (payload === "[DONE]") { doneSeen = true; flushTranslated(); clientRes.write("data: [DONE]\n\n"); return; }
    let obj;
    try { obj = JSON.parse(payload); } catch { clientRes.write(event + "\n\n"); return; } // fail open
    try {
      noteTemplate(obj);
      let hasContent = false;
      for (const ch of obj?.choices || []) {
        const idx = (ch && typeof ch.index === "number") ? ch.index : 0;
        const a = ensure(idx);
        const delta = ch?.delta;
        if (delta) {
          if (typeof delta.role === "string" && delta.role) a.role = delta.role;
          if (typeof delta.content === "string") { a.content += delta.content; hasContent = true; }
        }
        if (ch && ch.finish_reason !== undefined && ch.finish_reason !== null) a.finish = ch.finish_reason;
      }
      if (!hasContent) clientRes.write("data: " + JSON.stringify(obj) + "\n\n"); // role/finish-only frames pass through
      // content-bearing frames are held for the buffered re-emit at [DONE]
    } catch { clientRes.write(event + "\n\n"); }
  };
  upstreamRes.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const event = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      handleEvent(event);
    }
  });
  upstreamRes.on("end", () => {
    try {
      // Leftover partial frame (no trailing \n\n): parse if it holds data.
      if (buf.trim()) handleEvent(buf);
      if (!doneSeen) { flushTranslated(); clientRes.write("data: [DONE]\n\n"); }
    } catch {}
    buf = "";
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
                if (obj?.choices?.[0]?.message?.tool_calls) {
                  const tcs = obj.choices[0].message.tool_calls;
                  console.error("[shim] translated " + tcs.length + " tool_call(s): " + tcs.map((t) => (t && t.function && t.function.name) || "?").join(","));
                }
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
