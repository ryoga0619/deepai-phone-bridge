// スマホ側 PWA ロジック
const chat = document.getElementById("chat");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const dot = document.getElementById("conn-dot");
const brandSub = document.getElementById("brand-sub");
const drawer = document.getElementById("drawer");
const drawerBody = document.getElementById("drawer-body");
const preview = document.getElementById("preview");
const previewFrame = document.getElementById("preview-frame");
const previewTitle = document.getElementById("preview-title");
const previewOpen = document.getElementById("preview-open");

let currentThread = null;
let lastState = null;
let knownItems = new Map();
const optimisticUserTexts = new Set();
let busy = false;

// 軽量PWAは /mobile 配下で配信されるため、API パスにも prefix を付ける
const API_BASE = location.pathname.startsWith("/mobile") ? "/mobile" : "";

/* ---------------- utils ---------------- */
function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

function api(path, options = {}) {
  const url = new URL(path, location.origin);
  const key = new URLSearchParams(location.search).get("k");
  if (key) url.searchParams.set("k", key);
  return fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
}

async function apiJson(path, options) {
  const res = await api(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function scrollBottom() {
  requestAnimationFrame(() => { chat.scrollTop = chat.scrollHeight; });
}

/* ---------------- 会話描画 ---------------- */
function addUserMessage(text) {
  const welcome = document.getElementById("welcome");
  if (welcome) welcome.remove();
  const wrap = document.createElement("div");
  wrap.className = "msg user";
  const b = document.createElement("div");
  b.className = "bubble";
  b.textContent = text;
  wrap.appendChild(b);
  chat.appendChild(wrap);
  scrollBottom();
  optimisticUserTexts.add(text);
  return wrap;
}

function addAgentMessage(text) {
  const wrap = document.createElement("div");
  wrap.className = "msg agent";
  const b = document.createElement("div");
  b.className = "bubble";
  b.textContent = text;
  wrap.appendChild(b);
  chat.appendChild(wrap);
  scrollBottom();
  return b;
}

function addTool(kind, title, body) {
  const el = document.createElement("div");
  el.className = `tool ${kind}`;
  el.innerHTML = `<div class="tool-head"><span class="tag"></span><span class="ttl"></span></div><div class="tool-body"></div>`;
  const TAG = { file: "FILE", reason: "THINK", tool: "TOOL", command: "CMD" };
  el.querySelector(".tag").textContent = TAG[kind] ?? "CMD";
  el.querySelector(".ttl").textContent = title;
  el.querySelector(".tool-body").textContent = body || "";
  const head = el.querySelector(".tool-head");
  head.addEventListener("click", () => {
    el.classList.toggle("open");
    if (el.dataset.needOutput === "1" && el.classList.contains("open")) {
      const item = knownItems.get(el.dataset.itemId)?.item;
      if (item) loadToolOutput(item, el);
    }
  });
  chat.appendChild(el);
  scrollBottom();
  return el;
}

function addStatus(text) {
  const el = document.createElement("div");
  el.className = "status-line";
  el.innerHTML = `<span class="spinner"></span><span class="txt"></span>`;
  el.querySelector(".txt").textContent = text;
  chat.appendChild(el);
  scrollBottom();
  return el;
}

function setBusy(v) {
  busy = v;
  sendBtn.disabled = v;
  dot.className = `dot ${v ? "busy" : "live"}`;
}

/* ---------------- 状態適用 ---------------- */
const KIND_LABEL = {
  user: "あなた",
  assistant: "DeepAI",
};

function applyState(state) {
  const prevState = lastState;
  lastState = state;
  const items = state.turnItems || [];
  const status = state.status;

  for (const item of items) {
    const key = item.id;
    const prev = knownItems.get(key);
    const sig = JSON.stringify([item.status, item.text, item.exitCode]);
    if (prev && prev.sig === sig) continue;

    if (item.kind === "user") {
      // 送信直後は Optimistic 表示済みなので、サーバ側の user_message は初回のみ追加する
      if (!prev) {
        if (optimisticUserTexts.has(item.text)) {
          optimisticUserTexts.delete(item.text);
        } else {
          addUserMessage(item.text);
        }
      }
      knownItems.set(key, { sig, item });
      continue;
    }
    if (item.kind === "assistant") {
      let el = prev?.el;
      if (!el) {
        const wrap = document.createElement("div");
        wrap.className = "msg agent";
        const b = document.createElement("div");
        b.className = "bubble";
        wrap.appendChild(b);
        chat.appendChild(wrap);
        el = b;
      }
      el.textContent = item.text || (item.streaming ? "…" : "");
      scrollBottom();
      knownItems.set(key, { el, sig, item });
      continue;
    }
    if (item.kind === "reasoning") {
      if (!prev) {
        const el = addTool("reason", item.title || "推論", item.text || "");
        knownItems.set(key, { el, sig, item });
      } else {
        prev.el.querySelector(".tool-body").textContent = item.text || "";
        knownItems.set(key, { el: prev.el, sig, item });
      }
      continue;
    }
    if (item.kind === "command" || item.kind === "tool") {
      const body = [item.input, item.output].filter(Boolean).join("\n");
      const label = item.title || item.command || "コマンド";
      if (!prev) {
        const el = addTool(item.kind === "tool" ? "tool" : "command", label, body || "");
        knownItems.set(key, { el, sig, item });
      } else {
        prev.el.querySelector(".tool-body").textContent = body;
        knownItems.set(key, { el: prev.el, sig, item });
      }
      // 出力省略時はタップで詳細取得
      const el = knownItems.get(key).el;
      el.dataset.itemId = key;
      if (item.outputOmitted) el.dataset.needOutput = "1";
      continue;
    }
    if (item.kind === "file") {
      if (!prev) {
        const name = (item.fileName || "").split(/[\\/]/).pop();
        const el = addTool("file", `${item.changeType}: ${name}`, item.fileName || "");
        knownItems.set(key, { el, sig, item });
      }
      continue;
    }
    if (item.kind === "notification") {
      if (!prev) {
        const el = addTool("command", "通知", item.text || "");
        knownItems.set(key, { el, sig, item });
      }
      continue;
    }
    if (!prev) {
      const el = addTool("command", item.type, item.text || "");
      knownItems.set(key, { el, sig, item });
    } else {
      knownItems.set(key, { el: prev.el, sig, item });
    }
  }

  // 完了表示
  const done = status === "completed" || status === "idle";
  const STATUS_LABEL = {
    running: "実行中…",
    waiting: "入力待ち…",
    queued: "待機中…",
    completed: "完了",
    idle: "完了",
    failed: "失敗",
    cancelled: "中断",
  };
  setBusy(!done && status !== "unknown");
  brandSub.textContent = STATUS_LABEL[status] ?? status;
  if (done) {
    const el = document.getElementById("status-line");
    if (el) el.remove();
    // 完了に変わったタイミングで成果物一覧を最新化
    if (prevState?.status !== "completed") loadFiles();
  } else {
    const label =
      status === "waiting"
        ? "追加の指示を待っています…"
        : status === "queued"
          ? "順番を待っています…"
          : "DeepAI が作業中…";
    let el = document.getElementById("status-line");
    if (!el) {
      el = addStatus(label);
      el.id = "status-line";
    } else {
      el.querySelector(".txt").textContent = label;
    }
  }
}

/* ---------------- 送信 ---------------- */
async function send(text) {
  if (!text.trim()) return;
  input.value = "";
  input.style.height = "auto";
  setBusy(true);
  try {
    if (currentThread) {
      await apiJson(`${API_BASE}/api/tasks/${encodeURIComponent(currentThread)}/follow`, {
        method: "POST",
        body: JSON.stringify({ text }),
      });
    } else {
      const r = await apiJson(API_BASE + "/api/tasks", { method: "POST", body: JSON.stringify({ text }) });
      currentThread = r.threadId;
      history.replaceState(null, "", `?t=${currentThread}`);
      loadFiles();
    }
  } catch (err) {
    setBusy(false);
    toast(err.message);
  }
}

sendBtn.addEventListener("click", () => send(input.value));
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send(input.value);
  }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 132) + "px";
});
for (const b of document.querySelectorAll(".sample")) {
  b.addEventListener("click", () => { input.value = b.textContent.trim(); input.focus(); });
}

/* ---------------- SSE ---------------- */
function connectStream() {
  const es = new EventSource(API_BASE + "/api/stream");
  es.addEventListener("ready", () => {
    dot.className = "dot live";
    brandSub.textContent = "接続済み";
  });
  es.addEventListener("task", (e) => {
    const data = JSON.parse(e.data);
    if (currentThread && data.threadId !== currentThread) return;
    applyState(data.state);
  });
  es.addEventListener("warn", (e) => {
    const data = JSON.parse(e.data);
    toast(data.message);
  });
  es.onerror = () => {
    dot.className = "dot";
    brandSub.textContent = "再接続中…";
  };
}

/* ---------------- コマンド出力の取得 ---------------- */
async function loadToolOutput(item, el) {
  const body = el.querySelector(".tool-body");
  if (!body || body.dataset.loaded === "1") return;
  body.dataset.loaded = "1";
  body.textContent = "出力を読み込み中…";
  try {
    const detail = await apiJson(
      `${API_BASE}/api/tasks/${encodeURIComponent(currentThread)}/item?id=${encodeURIComponent(item.id)}`,
    );
    const text = [detail.input, detail.output].filter(Boolean).join("\n");
    body.textContent = text || "（出力なし）";
  } catch (err) {
    body.textContent = `出力を取得できません: ${err.message}`;
  }
}

/* ---------------- 成果物 ---------------- */
async function loadFiles() {
  if (!currentThread) return;
  try {
    const r = await apiJson(`${API_BASE}/api/tasks/${encodeURIComponent(currentThread)}/files`);
    renderFiles(r.cwd, r.entries || []);
    window.__cwd = r.cwd;
  } catch {
    /* まだ成果物が無い可能性 */
  }
}

function renderFiles(cwd, entries) {
  drawerBody.innerHTML = "";
  const files = entries.filter((e) => e.kind === "file");
  if (!files.length) {
    drawerBody.innerHTML = `<div class="empty">まだファイルがありません</div>`;
    return;
  }
  const box = document.createElement("div");
  box.className = "files";
  box.innerHTML = `<div class="files-head">${files.length} 件のファイル（タップでプレビュー）</div>`;
  for (const f of files) {
    const row = document.createElement("button");
    row.className = "file-row";
    row.innerHTML = `<span class="fname"></span><span class="fopen">開く</span>`;
    row.querySelector(".fname").textContent = f.path;
    row.addEventListener("click", () => openPreview(cwd, f.path));
    box.appendChild(row);
  }
  drawerBody.appendChild(box);
}

function openPreview(cwd, rel) {
  const url = `${API_BASE}/preview?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(rel)}`;
  const u = new URL(url, location.origin);
  const key = new URLSearchParams(location.search).get("k");
  if (key) u.searchParams.set("k", key);
  previewFrame.src = u.toString();
  previewOpen.href = u.toString();
  previewTitle.textContent = rel;
  preview.hidden = false;
}

document.getElementById("btn-files").addEventListener("click", async () => {
  if (!currentThread) { toast("まず指示を送ってください"); return; }
  drawer.hidden = false;
  await loadFiles();
});
document.getElementById("drawer-close").addEventListener("click", () => { drawer.hidden = true; });
document.getElementById("preview-close").addEventListener("click", () => {
  preview.hidden = true;
  previewFrame.src = "about:blank";
});

/* ---------------- 起動 ---------------- */
connectStream();
(async () => {
  try {
    const s = await apiJson(API_BASE + "/api/session");
    brandSub.textContent = "接続済み";
    dot.className = "dot live";
    const t = new URLSearchParams(location.search).get("t");
    if (t) {
      currentThread = t;
      try {
        const state = await apiJson(`${API_BASE}/api/tasks/${encodeURIComponent(t)}`);
        // 履歴を復元（既知の optimistic メッセージは二重表示しない）
        applyState(state);
        loadFiles();
      } catch (err) {
        toast(err.message);
      }
    }
  } catch (err) {
    brandSub.textContent = err.message;
  }
})();
