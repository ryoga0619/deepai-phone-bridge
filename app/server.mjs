// スマホ → PC ブリッジ HTTP サーバ
//
//  メイン (/)
//    DeepAI Code サーバ (127.0.0.1:3773) の **本物の Web クライアント** を
//    リバースプロキシしてスマホに配信する。認証はサーバー側で Bearer を注入。
//
//  サブ (/mobile)
//    軽量な専用 PWA（会話 UI / 成果物プレビュー）。.vercel の代替用。
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Bridge } from "./lib/bridge.mjs";
import { qrToText, qrToSvg } from "./lib/qr.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, "web");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const DEEPAI_BASE = process.env.DEEPAI_BASE_URL || "http://127.0.0.1:3773";
const KEY_FILE = path.join(os.homedir() || ".", ".deepai-code", "phone-bridge.key");

/** アクセスキーは再利用（起動のたびに変わらない） */
function loadOrCreateAccessKey() {
  if (process.env.ACCESS_KEY) return process.env.ACCESS_KEY;
  try {
    const saved = fs.readFileSync(KEY_FILE, "utf8").trim();
    if (saved) return saved;
  } catch {
    /* 未保存なら新規に作る */
  }
  const key = crypto.randomBytes(8).toString("hex");
  try {
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    fs.writeFileSync(KEY_FILE, key);
  } catch {
    /* 保存できなくても動作はする */
  }
  return key;
}

let DEEPAI_TOKEN = process.env.DEEPAI_TOKEN || "";
const ACCESS_KEY = loadOrCreateAccessKey();
const ALLOW_ANONYMOUS = process.env.ALLOW_ANONYMOUS === "1";

const UPSTREAM = new URL(DEEPAI_BASE);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function mimeFor(p) {
  return MIME[path.extname(p).toLowerCase()] || "application/octet-stream";
}

function lanAddress() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const [name, addrs] of Object.entries(nets)) {
    for (const a of addrs || []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const score = /以太网|Ethernet|Wi-Fi|WLAN|Wireless/i.test(name) ? 2 : 1;
      candidates.push({ address: a.address, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.address || "127.0.0.1";
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error("リクエストが大きすぎます"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("JSON の解析に失敗しました"));
      }
    });
    req.on("error", reject);
  });
}

function authorized(req, url) {
  if (ALLOW_ANONYMOUS) return true;
  const key = url.searchParams.get("k") || req.headers["x-access-key"];
  if (key && key === ACCESS_KEY) return true;
  const cookie = req.headers.cookie || "";
  return cookie.split(";").some((c) => c.trim() === `dcp_key=${ACCESS_KEY}`);
}

/** QR のリンク (?k=) で初めてアクセスしたブラウザに Cookie を払い出す */
function grantCookie(req, res, url) {
  if (ALLOW_ANONYMOUS) return;
  const key = url.searchParams.get("k");
  if (!key || key !== ACCESS_KEY) return;
  const cookie = req.headers.cookie || "";
  if (cookie.split(";").some((c) => c.trim() === `dcp_key=${ACCESS_KEY}`)) return;
  const dcpCookie = `dcp_key=${ACCESS_KEY}; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax`;
  const existing = res.getHeader("set-cookie");
  res.setHeader(
    "set-cookie",
    existing ? [...(Array.isArray(existing) ? existing : [existing]), dcpCookie] : [dcpCookie],
  );
}

/** パストラバーサル対策: 許可されたルート配下であることを確認する */
function safeJoin(root, relative) {
  const rootResolved = path.resolve(root);
  const cleaned = String(relative || "").replace(/^[/\\]+/, "");
  const target = path.resolve(rootResolved, cleaned);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) return null;
  return target;
}

/* ========================================================================
   本物の DeepAI Code Web クライアントへのリバースプロキシ
   ======================================================================== */

/**
 * CLI (`deepai auth session issue`) で新しいアクセストークンを発行する。
 * 発行できなかった場合は後続の処理で失敗する。
 */
async function reissueDeepAIToken() {
  const cmd = path.join(os.homedir() || "", ".deepai-code", "bin", "deepai.cmd");
  if (!fs.existsSync(cmd)) throw new Error("deepai.cmd が見つかりません");
  const raw = await new Promise((resolve, reject) => {
    execFile(
      "cmd",
      ["/c", cmd, "auth", "session", "issue", "--token-only", "--ttl", "90d", "--label", "phone-bridge"],
      { windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
  const token = String(raw).trim();
  if (!token) throw new Error("アクセストークンの再発行に失敗しました");
  DEEPAI_TOKEN = token;
  try {
    fs.writeFileSync(path.join(os.homedir() || ".", ".deepai-code", "phone-bridge.token"), token);
  } catch {
    /* 保存できなくても動作する */
  }
  console.log("  新しいアクセストークンを発行しました。");
}

/**
 * DeepAI Code の「ブラウザセッション」を用意する。
 *
 * 1. ペアリング資格情報 (POST /api/auth/pairing-token) を発行する
 * 2. その資格情報でブラウザセッション (POST /api/auth/browser-session) を作り、
 *    返る Cookie (`t3_session_<port>`) をスマホに配る
 *
 * これにより、スマホのブラウザは「既にサインイン済みのセッション」を持ち、
 * 本物の Web クライアントのログイン画面を出さずにそのまま使える。
 */
const SESSION_COOKIE_NAME = `t3_session_${UPSTREAM.port || 80}`;
let browserSession = null; // { cookieValue, expiresAt }

async function ensureBrowserSession(force = false) {
  if (!force && browserSession && browserSession.expiresAt > Date.now() + 60_000) {
    return browserSession;
  }
  const base = `${UPSTREAM.protocol}//${UPSTREAM.hostname}:${UPSTREAM.port || 80}`;
  let credentialRes = await fetch(`${base}/api/auth/pairing-token`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${DEEPAI_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ label: "phone-bridge" }),
  });
  if (credentialRes.status === 401) {
    // アクセストークンが切れている → CLI で再発行して再試行
    console.log("  アクセストークンが無効です。再発行します...");
    await reissueDeepAIToken();
    credentialRes = await fetch(`${base}/api/auth/pairing-token`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${DEEPAI_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ label: "phone-bridge" }),
    });
  }
  if (!credentialRes.ok) {
    throw new Error(`ペアリング資格情報の発行に失敗: HTTP ${credentialRes.status}`);
  }
  const { credential } = await credentialRes.json();

  const sessionRes = await fetch(`${base}/api/auth/browser-session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential }),
  });
  if (!sessionRes.ok) {
    throw new Error(`ブラウザセッションの作成に失敗: HTTP ${sessionRes.status}`);
  }
  const setCookie = sessionRes.headers.get("set-cookie") || "";
  const match = setCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  if (!match) throw new Error("セッション Cookie を取得できませんでした");

  const expires = sessionRes.headers.get("set-cookie")?.match(/Expires=([^;]+)/)?.[1];
  browserSession = {
    cookieValue: match[1],
    expiresAt: expires ? Date.parse(expires) : Date.now() + 24 * 3600 * 1000,
  };
  return browserSession;
}

function proxyToDeepAI(req, res, url) {
  const clientCookie = req.headers.cookie || "";
  const hasSession = clientCookie.includes(`${SESSION_COOKIE_NAME}=`);
  const headers = {
    ...req.headers,
    host: `${UPSTREAM.hostname}:${UPSTREAM.port || 80}`,
  };
  delete headers["x-access-key"];
  if (hasSession) {
    // 手机的ブラウザセッションで認証済み → Cookie をそのまま転送する
  } else {
    delete headers.cookie;
    headers.authorization = `Bearer ${DEEPAI_TOKEN}`;
  }

  const options = {
    host: UPSTREAM.hostname,
    port: UPSTREAM.port || (UPSTREAM.protocol === "https:" ? 443 : 80),
    method: req.method,
    path: req.url,
    headers,
  };

  // HTML を返すとき、ブラウザセッション Cookie を付け加える
  const upstreamReq = http.request(options, (upstreamRes) => {
    const contentType = String(upstreamRes.headers["content-type"] || "");
    const cookies = [];
    if (contentType.includes("text/html") && browserSession) {
      cookies.push(
        `${SESSION_COOKIE_NAME}=${browserSession.cookieValue}; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax`,
      );
    }
    const outHeaders = { ...upstreamRes.headers };
    const upstreamCookies = outHeaders["set-cookie"];
    const ownCookies = res.getHeader("set-cookie");
    const allCookies = [
      ...(ownCookies ? (Array.isArray(ownCookies) ? ownCookies : [ownCookies]) : []),
      ...(upstreamCookies ? (Array.isArray(upstreamCookies) ? upstreamCookies : [upstreamCookies]) : []),
      ...cookies,
    ];
    if (allCookies.length) outHeaders["set-cookie"] = allCookies;
    res.writeHead(upstreamRes.statusCode || 502, outHeaders);
    upstreamRes.pipe(res);
  });
  upstreamReq.on("error", (err) => {
    if (!res.headersSent) json(res, 502, { error: `DeepAI サーバへの接続に失敗: ${err.message}` });
    else res.end();
  });
  req.on("aborted", () => upstreamReq.destroy());
  req.pipe(upstreamReq);
}

/** WebSocket (/ws) のアップグレードをそのまま中継する */
function proxyWebSocket(req, socket) {
  const port = UPSTREAM.port || (UPSTREAM.protocol === "https:" ? 443 : 80);
  const upstream = net.connect(port, UPSTREAM.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.toLowerCase() === "host") {
        lines.push(`Host: ${UPSTREAM.hostname}:${port}`);
      } else {
        lines.push(`${key}: ${value}`);
      }
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  const kill = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", kill);
  socket.on("error", kill);
}

/* ========================================================================
   軽量モバイル PWA (/mobile)
   ======================================================================== */
async function serveMobileStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const file = safeJoin(WEB_DIR, rel);
  if (!file) return json(res, 400, { error: "不正なパスです" });
  let data;
  try {
    data = await fsp.readFile(file);
  } catch {
    return json(res, 404, { error: "ファイルが見つかりません" });
  }
  const ext = path.extname(file).toLowerCase();
  if (ext === ".html" || ext === ".htm") {
    const key = url.searchParams.get("k");
    if (key && key === ACCESS_KEY) {
      let html = data.toString("utf8");
      html = html.replace(/(src|href)=["'](\/[^"']*?)["']/g, (m, attr, p) => {
        if (p.includes("?")) return m;
        return `${attr}="/mobile${p}?k=${encodeURIComponent(key)}"`;
      });
      data = Buffer.from(html, "utf8");
    }
  }
  res.writeHead(200, {
    "content-type": mimeFor(file),
    "content-length": data.length,
    "cache-control": "no-cache",
  });
  res.end(data);
}

async function servePreview(req, res, url) {
  const cwd = url.searchParams.get("cwd") || "";
  const rel = url.searchParams.get("path") || "";
  if (!cwd || !rel) return json(res, 400, { error: "cwd と path が必要です" });
  const target = safeJoin(cwd, rel);
  if (!target) return json(res, 400, { error: "不正なパスです" });
  let data;
  try {
    data = await fsp.readFile(target);
  } catch {
    return json(res, 404, { error: "ファイルが見つかりません" });
  }
  res.writeHead(200, {
    "content-type": mimeFor(target),
    "content-length": data.length,
    "cache-control": "no-store",
  });
  res.end(data);
}

/* ========================================================================
   ブリッジ本体
   ======================================================================== */
const bridge = new Bridge({ token: DEEPAI_TOKEN, baseUrl: DEEPAI_BASE });
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

async function resolveCwd(threadId, session, explicit) {
  if (explicit) return explicit;
  if (session?.cwd) return session.cwd;
  try {
    const projection = await bridge.client.getThreadProjection(threadId);
    return projection?.thread?.worktreePath ?? null;
  } catch {
    return null;
  }
}

function handleSse(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  sseClients.add(res);
  const keep = setInterval(() => res.write(": ping\n\n"), 20000);
  req.on("close", () => {
    clearInterval(keep);
    sseClients.delete(res);
  });
}

/** /mobile/api/* を処理して結果を返す */
async function handleMobileApi(req, res, url, pathname) {
  if (pathname === "/api/session" && req.method === "GET") {
    return json(res, 200, {
      url: localUrl(),
      accessKey: ACCESS_KEY,
      deepaiBase: DEEPAI_BASE,
      projects: bridge.projects.map((p) => ({ id: p.id, title: p.title })),
    });
  }

  if (pathname === "/api/tasks" && req.method === "POST") {
    const body = await readBody(req);
    const text = String(body.text ?? "").trim();
    if (!text) return json(res, 400, { error: "指示が空です" });
    try {
      const session = await bridge.startTask({ text, projectId: body.projectId, title: body.title });
      session.on("update", (state) => broadcast("task", { threadId: session.threadId, state }));
      session.on("warn", (msg) => broadcast("warn", { threadId: session.threadId, message: msg }));
      return json(res, 200, { threadId: session.threadId, title: text.slice(0, 60) });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)(\/[a-z]+)?$/);
  if (taskMatch) {
    const threadId = decodeURIComponent(taskMatch[1]);
    const action = taskMatch[2] || "";
    let session = bridge.getSession(threadId);

    if (action === "/follow" && req.method === "POST") {
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "指示が空です" });
      try {
        const s = await bridge.continueTask(threadId, text);
        s.on("update", (state) => broadcast("task", { threadId: s.threadId, state }));
        return json(res, 200, { ok: true });
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }

    if (action === "/files" && req.method === "GET") {
      const cwd = await resolveCwd(threadId, session, url.searchParams.get("cwd"));
      if (!cwd) return json(res, 400, { error: "成果物ディレクトリが不明です" });
      try {
        const entries = await bridge.listFiles(cwd, url.searchParams.get("dir") || undefined);
        return json(res, 200, { cwd, entries });
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }

    if (action === "/file" && req.method === "GET") {
      const cwd = await resolveCwd(threadId, session, url.searchParams.get("cwd"));
      const rel = url.searchParams.get("path");
      if (!cwd || !rel) return json(res, 400, { error: "cwd と path が必要です" });
      try {
        return json(res, 200, await bridge.readFile(cwd, rel));
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }

    if (action === "/item" && req.method === "GET") {
      const itemId = url.searchParams.get("id");
      if (!itemId) return json(res, 400, { error: "id が必要です" });
      try {
        return json(res, 200, await bridge.getTurnItem(threadId, itemId));
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }

    if (!session) {
      try {
        const s = bridge.ensureSession(threadId);
        s.on("update", (state) => broadcast("task", { threadId: s.threadId, state }));
        await new Promise((r) => setTimeout(r, 300));
        return json(res, 200, s.state);
      } catch (err) {
        return json(res, 404, { error: "スレッドが見つかりません" });
      }
    }
    return json(res, 200, session.state);
  }

  if (pathname === "/api/stream") return handleSse(req, res);
  if (pathname === "/preview") return servePreview(req, res, url);
  return json(res, 404, { error: "API が見つかりません" });
}

/* ========================================================================
   リクエスト処理
   ======================================================================== */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/api/ping") return json(res, 200, { ok: true });

    if (url.pathname === "/qr.svg") {
      const svg = qrToSvg(localUrl(), { size: 260 });
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" });
      return res.end(svg);
    }

    if (url.pathname === "/login" && req.method === "POST") {
      const body = await readBody(req);
      if (!ALLOW_ANONYMOUS && body.key !== ACCESS_KEY) {
        return json(res, 401, { error: "アクセスキーが違います" });
      }
      res.setHeader(
        "set-cookie",
        `dcp_key=${ACCESS_KEY}; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax`,
      );
      return json(res, 200, { ok: true });
    }

    if (!authorized(req, url)) {
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/mobile/api/")) {
        return json(res, 401, { error: "認証が必要です" });
      }
      // 本物の Web クライアントはログイン画面を持たないので-fundamentalsな案内のみ
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      return res.end(
        "認証が必要です。URL に ?k=" + ACCESS_KEY + " を付けてアクセスするか、ログイン画面からキーを入力してください。",
      );
    }
    grantCookie(req, res, url);

    // --- 軽量モバイル PWA (/mobile) ---
    if (url.pathname === "/mobile" || url.pathname.startsWith("/mobile/")) {
      const rest = url.pathname.slice("/mobile".length) || "/";
      if (rest.startsWith("/api/")) {
        return handleMobileApi(req, res, url, rest.replace(/\/+$/, "") || "/api");
      }
      const sub = new URL(rest + url.search, url);
      return serveMobileStatic(req, res, sub);
    }

    // --- それ以外は本物の DeepAI Code Web クライアントを中継 ---
    return proxyToDeepAI(req, res, url);
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (!authorized(req, url)) {
    socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return;
  }
  proxyWebSocket(req, socket);
});

function localUrl() {
  const host = lanAddress();
  const key = ALLOW_ANONYMOUS ? "" : `?k=${ACCESS_KEY}`;
  return `http://${host}:${PORT}/${key}`;
}

async function main() {
  if (!DEEPAI_TOKEN) {
    console.error(
      "DEEPAI_TOKEN が設定されていません。`deepai auth session issue --token-only --ttl 30d` の出力を使ってください。",
    );
    process.exit(1);
  }
  try {
    await bridge.init();
  } catch (err) {
    console.error(`DeepAI Code サーバに接続できません: ${err.message}`);
    process.exit(1);
  }

  try {
    const session = await ensureBrowserSession(true);
    console.log("  ブラウザセッションを準備しました (期限: " + new Date(session.expiresAt).toLocaleString() + ")");
  } catch (err) {
    console.error(`  警告: ブラウザセッションを準備できません: ${err.message}`);
  }

  server.listen(PORT, HOST, () => {
    const url = localUrl();
    console.log("");
    console.log("  DeepAI スマホブリッジ 起動しました");
    console.log("  ---------------------------------------------------");
    console.log(`  URL          : ${url}`);
    console.log(`  アクセスキー : ${ACCESS_KEY}`);
    console.log("");
    console.log("  スマホから開くと DeepAI Code 本体の画面（ログイン済み）が出ます。");
    console.log("  軽量版アプリが必要な場合は /mobile を開いてください。");
    console.log("  ---------------------------------------------------");
    console.log(qrToText(url));
    console.log("");
    console.log("  同じ Wi-Fi に接続したスマホから、QR を読み取って開いてください。");
    console.log("  Ctrl+C で停止します。");
  });
}

process.on("SIGINT", async () => {
  await bridge.close();
  process.exit(0);
});

main();
