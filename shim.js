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
//     finish_reason=tool_calls; the tool_calls message/delta ALWAYS carries
//     content "" (framing rule §10 — opencode's OpenAI-Chat converter rejects
//     content bundled with tool_calls), residue prose goes out as a SEPARATE
//     preceding content-only chunk (SSE) or is dropped from the wire with a
//     log line (non-stream, which has no preceding-chunk slot)
//   - multiple calls per content supported; malformed input fails open (passthrough)
//   - FM_STRIP_MARKERS=1: strip markers without translating (fm-proxy style)
//   - tool_choice required/named: trivial response_format rewrite attempt, else passthrough

import http from "node:http";
import { randomUUID } from "node:crypto";
import cluster from "node:cluster";
import os from "node:os";

export const UPSTREAM_RAW = process.env.AFM_UPSTREAM || "http://127.0.0.1:1976/v1";
// Normalise: upstream may be given with or without the /v1 suffix; request
// paths always arrive as /v1/... so strip a trailing /v1 to avoid /v1/v1/.
export const UPSTREAM_BASE = UPSTREAM_RAW.replace(/\/v1\/?$/, "").replace(/\/$/, "");
export const UPSTREAM = UPSTREAM_BASE + "/v1";
export const LISTEN_PORT = Number(process.env.AFM_SHIM_PORT || process.env.PORT || 1977);
const STRIP_ONLY = process.env.FM_STRIP_MARKERS === "1";

// ---- multicore (Phase 1): Node cluster, stdlib only --------------------------
// Flag-gated: FM_WORKERS=N (default 1 = single-process, current behaviour).
// N=0 means auto: min(os.cpus().length, 4). N>1 forks N workers sharing
// :LISTEN_PORT via the cluster scheduler. N<=0 (other than the 0=auto
// special case), NaN, and unset all fall back to 1.
// Concurrency safety: per-request state stays in-request — the buffered SSE
// accumulation (buf/template/accum/order in sseTranslateAndRelay) is all
// allocated inside the per-request closure, and the only module-level mutable
// state is `callSeq` (a per-process id counter; each worker has isolated
// memory, and ids also embed a randomUUID prefix, so no cross-worker
// collision). Everything else module-level is a constant.
export function resolveWorkerCount(envVal, cpuCount) {
  if (envVal === undefined || envVal === null || String(envVal).trim() === "") return 1;
  const n = Number.parseInt(String(envVal).trim(), 10);
  if (!Number.isFinite(n) || n < 0) return 1;
  if (n === 0) return Math.max(1, Math.min(cpuCount || 1, 4));
  return n;
}
export const WORKER_COUNT = resolveWorkerCount(
  process.env.FM_WORKERS,
  (os.cpus() || []).length || 1
);

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
    // Stray-brace skip (§4 miss #5): FM double-wraps the close as
    // `...}<ctrl46>}<ctrl45>`, i.e. normalised `...}\x16}\x17`. The balanced
    // scan above stops at the payload's own `}`, leaving a marker-wrapped
    // stray `}` that would otherwise leak into residue (visible as a
    // leading `}` in SSE content chunks). Skip one immediately-following
    // `}` ONLY when it is marker-adjacent (the skipped span contains
    // \x16/\x17) — bare `}` prose without markers is never consumed.
    const tail = text.slice(last).match(/^[\s\x16\x17]*\}[\s\x16\x17]*/);
    if (tail && /[\x16\x17]/.test(tail[0])) last += tail[0].length;
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
    // Framing rule (§10): a message/delta carrying tool_calls MUST have
    // content "" — opencode's OpenAI-Chat converter rejects content bundled
    // with tool_calls ("received content after the finish reason"). Surrounding
    // prose survives in `residue` so callers can re-emit it as a SEPARATE
    // preceding content-only chunk; never inline it with the calls.
    return { content: "", residue: cleaned || "", tool_calls, finish_reason: "tool_calls" };
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
    // Same framing rule as above: content "" + residue split out.
    return { content: "", residue: cleaned || "", tool_calls, finish_reason: "tool_calls" };
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
    // Framing rule (§10): the tool_calls message carries content "" (r.content
    // is already ""). Non-stream has no preceding-chunk slot, so residue prose
    // is dropped from the wire here (one log line, below) — never inlined
    // with the calls.
    msg.content = "";
    msg.tool_calls = r.tool_calls;
    if (r.finish_reason) choice.finish_reason = r.finish_reason;
    if (r.residue) console.error("[shim] residue prose kept out of tool_calls message: " + JSON.stringify(r.residue.slice(0, 120)));
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

// ---- quota-error detection --------------------------------------------------
// Upstream FM surfaces quota exhaustion two ways:
//   1) HTTP 429 JSON: {"error":{"message":"Your quota has been reached. ...",
//      "code":"429","type":"insufficient_quota"}}
//   2) the SAME error object as an SSE `data:` event inside an HTTP 200
//      stream (direct :1976 vs shim :1977 A/B must match status).
// isQuotaError(objOrString) is true when the value indicates 429 /
// insufficient_quota / "quota has been reached". Stdlib only.
export function isQuotaError(objOrString) {
  try {
    let obj = objOrString;
    if (typeof obj === "string") {
      const s = obj;
      if (/insufficient_quota/i.test(s) || /quota has been reached/i.test(s)) return true;
      const t = s.trim();
      // Bare "429" code inside an error-looking payload still counts.
      if (/\"code\"\s*:\s*\"?429\"?/.test(t) && /error/i.test(t)) return true;
      try { obj = JSON.parse(s); } catch { return false; }
    }
    if (!obj || typeof obj !== "object") return false;
    const err = obj.error && typeof obj.error === "object" ? obj.error : null;
    const candidates = [];
    if (err) candidates.push(err);
    candidates.push(obj);
    for (const c of candidates) {
      if (c.code === 429 || c.code === "429") return true;
      if (typeof c.type === "string" && /quota/i.test(c.type)) return true;
      if (typeof c.message === "string" &&
        (/insufficient_quota/i.test(c.message) || /quota has been reached/i.test(c.message))) return true;
    }
    return false;
  } catch {
    return false;
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
  // accumulate the full delta.content per choice index, HOLD role-only /
  // keep-alive bytes unsent (headers deferred so an early error frame can
  // still upgrade the response to 429), and
  // run the existing
  // translateContent() ONCE over the assembled content at [DONE]/end. The
  // translated result is re-emitted as final SSE chunk(s) before [DONE], so
  // SSE event framing to the client is always valid.
  // Quota errors may arrive as SSE `data:` JSON inside an HTTP 200, so the
  // 200 SSE headers MUST NOT go out before the first data frame is
  // inspected — otherwise the status can never be upgraded to 429. All
  // SSE writes go through ensureSseHead() (lazy); a quota frame seen
  // before any SSE byte upgrades the whole response to a single 429 JSON.
  let sseHeadSent = false;
  let quotaDone = false;
  const ensureSseHead = () => {
    if (sseHeadSent || quotaDone) return;
    sseHeadSent = true;
    clientRes.writeHead(upstreamRes.statusCode || 200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
  };
  // Live quota shape is role-only frame(s) THEN `event: error` + error
  // JSON — all inside HTTP 200. So role-only/keep-alive/fail-open bytes
  // are HELD in `pending` (headers unsent) and only released once a later
  // frame proves the stream is healthy (content/finish arrives) or the
  // stream closes ([DONE]/end). An error frame seen while held upgrades
  // the whole response to a single 429 JSON instead of a 200 stream.
  const pending = [];
  const flushPending = () => {
    if (quotaDone) return;
    ensureSseHead();
    for (const w of pending) clientRes.write(w);
    pending.length = 0;
  };
  const sendQuotaError = (obj) => {
    if (sseHeadSent || quotaDone) return false;
    quotaDone = true;
    pending.length = 0; // drop held role/keep-alive bytes: 429 replaces the stream
    let data;
    try { data = JSON.stringify(obj); } catch { data = '{"error":{"message":"quota exceeded","code":"429","type":"insufficient_quota"}}'; }
    console.error("[shim] quota exceeded — surfacing 429 (sse)");
    try {
      clientRes.writeHead(429, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(data),
        "x-afm-shim": "1",
      });
    } catch {}
    try { clientRes.end(data); } catch {}
    try { if (typeof upstreamRes.destroy === "function") upstreamRes.destroy(); } catch {}
    return true;
  };
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
    // Canonical OpenAI SSE shape (§10): content/tool_calls deltas always carry
    // finish_reason null; finish arrives in a DEDICATED terminal chunk with an
    // empty delta. Never co-locate content text and a finish reason, and never
    // emit anything (except [DONE]) after the finish chunk.
    const emit = (idx, delta, finish) => {
      ensureSseHead();
      clientRes.write("data: " + JSON.stringify({ ...tpl, choices: [{ index: idx, delta, finish_reason: finish }] }) + "\n\n");
    };
    for (const idx of order) {
      const a = accum.get(idx);
      const role = a.role || "assistant";
      const full = a.content;
      if (!full) {
        if (a.finish) emit(idx, {}, a.finish);
        continue;
      }
      let r;
      try { r = translateContent(full); } catch { r = { content: full }; }
      if (r && r.tool_calls) {
        // Framing rule (§10): never emit content text + tool_calls in one
        // delta (opencode's converter rejects it). Residue prose (if any) goes
        // out FIRST as its own content-only chunk; the tool_calls delta always
        // carries content "".
        if (r.residue) emit(idx, { role, content: r.residue }, null);
        emit(idx, { role, content: "", tool_calls: r.tool_calls }, null);
        emit(idx, {}, r.finish_reason || "tool_calls");
        // Log line matches the non-streaming path's `[shim] translated N
        // tool_call(s):` prefix so one grep covers both (suffix notes SSE).
        console.error("[shim] translated " + r.tool_calls.length + " tool_call(s): " + r.tool_calls.map((t) => (t && t.function && t.function.name) || "?").join(",") + " (sse, buffered)");
      } else if (typeof r.content === "string" && r.content !== full) {
        emit(idx, { role, content: r.content }, null);
        if (a.finish) emit(idx, {}, a.finish);
      } else {
        // No translation: re-emit the assembled content verbatim, then the
        // held finish in its own terminal chunk.
        emit(idx, { role, content: full }, null);
        if (a.finish) emit(idx, {}, a.finish);
      }
    }
  };
  let doneSeen = false;
  const handleEvent = (event) => {
    if (quotaDone) return;
    const lines = event.split("\n");
    const dataLines = lines.filter((l) => l.startsWith("data:"));
    if (dataLines.length === 0) { pending.push(event + "\n\n"); return; } // comment/keep-alive (held)
    const payload = dataLines.map((l) => l.slice(5).trimStart()).join("\n");
    if (payload === "[DONE]") { doneSeen = true; flushPending(); flushTranslated(); clientRes.write("data: [DONE]\n\n"); return; }
    let obj;
    try { obj = JSON.parse(payload); } catch {
      // Fail open — but a quota message split as raw text still counts.
      if (isQuotaError(payload)) {
        if (!sendQuotaError({ error: { message: payload.slice(0, 500), code: "429", type: "insufficient_quota" } })) { flushPending(); clientRes.write(event + "\n\n"); }
        return;
      }
      pending.push(event + "\n\n"); return;
    }
    // Quota error inside the stream upgrades the whole response to 429
    // JSON (possible while headers+bytes are still held). Past that point
    // the error is forwarded verbatim (fail open) so it is never dropped.
    if (isQuotaError(obj) || isQuotaError(payload)) {
      if (!sendQuotaError(obj)) { flushPending(); clientRes.write(event + "\n\n"); }
      return;
    }
    try {
      noteTemplate(obj);
      let hasContent = false;
      // Ordering rule (§10): a finish_reason frame MUST NOT go out before the
      // buffered content re-emit — strict OpenAI-Chat converters reject
      // content arriving after a finish reason. So finish frames are held
      // (recorded in accum, applied at flush) like content; role-only /
      // keep-alive frames are HELD unsent (headers deferred for the quota
      // upgrade) and released once content/finish proves the stream healthy.
      let hasFinish = false;
      for (const ch of obj?.choices || []) {
        const idx = (ch && typeof ch.index === "number") ? ch.index : 0;
        const a = ensure(idx);
        const delta = ch?.delta;
        if (delta) {
          if (typeof delta.role === "string" && delta.role) a.role = delta.role;
          if (typeof delta.content === "string") { a.content += delta.content; hasContent = true; }
        }
        if (ch && ch.finish_reason !== undefined && ch.finish_reason !== null) { a.finish = ch.finish_reason; hasFinish = true; }
      }
      if (!hasContent && !hasFinish) { pending.push("data: " + JSON.stringify(obj) + "\n\n"); }
      else flushPending(); // stream proven healthy: release held role bytes
      // content- and finish-bearing frames are held for the buffered re-emit
      // at [DONE], where finish lands on/after the final content chunk
    } catch { pending.push(event + "\n\n"); }
  };
  upstreamRes.on("data", (chunk) => {
    if (quotaDone) return;
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const event = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      handleEvent(event);
      if (quotaDone) { buf = ""; return; }
    }
  });
  upstreamRes.on("end", () => {
    if (quotaDone) return;
    try {
      // Leftover partial frame (no trailing \n\n): parse if it holds data.
      // A non-SSE JSON error body on a stream request (e.g. upstream 429
      // with content-type json) lands here whole — still upgrade to 429.
      if (buf.trim()) {
        const tail = buf.trim();
        let tailHandled = false;
        if (!tail.startsWith("data:") && !sseHeadSent) {
          try {
            const bare = JSON.parse(tail);
            if (isQuotaError(bare)) { sendQuotaError(bare); buf = ""; return; }
          } catch {
            if (isQuotaError(tail)) { sendQuotaError({ error: { message: tail.slice(0, 500), code: "429", type: "insufficient_quota" } }); buf = ""; return; }
          }
        }
        if (!tailHandled) handleEvent(buf);
        if (quotaDone) { buf = ""; return; }
      }
      if (!doneSeen) { flushPending(); flushTranslated(); clientRes.write("data: [DONE]\n\n"); }
    } catch {}
    buf = "";
    try { clientRes.end(); } catch {}
  });
  upstreamRes.on("error", () => { if (quotaDone) return; try { clientRes.end(); } catch {} });
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
                // Quota error inside HTTP 200 still surfaces as 429 so direct
                // :1976 vs shim :1977 A/B match status.
                if (isQuotaError(obj)) {
                  console.error("[shim] quota exceeded — surfacing 429 (non-stream)");
                  res.setHeader("x-afm-shim", "1");
                  return sendJson(res, 429, obj);
                }
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
  if (cluster.isPrimary && WORKER_COUNT > 1) {
    console.log(`[afm-openai-shim] primary ${process.pid} starting ${WORKER_COUNT} workers -> :${LISTEN_PORT} (upstream ${UPSTREAM})`);
    for (let i = 0; i < WORKER_COUNT; i++) cluster.fork();
    cluster.on("exit", (worker, code, signal) => {
      console.error(`[shim] worker ${worker.process.pid} died (code=${code} signal=${signal || "-"}) — respawning`);
      cluster.fork();
    });
  } else {
    const server = createServer();
    server.listen(LISTEN_PORT, "127.0.0.1", () => {
      console.log(`[afm-openai-shim] listening :${LISTEN_PORT} -> ${UPSTREAM} (pid ${process.pid}${cluster.isWorker ? ", worker" : ""})`);
    });
  }
}
