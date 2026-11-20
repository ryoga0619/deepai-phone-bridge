// DeepAI Code サーバーとの通信クライアント
// - HTTP: /api/projects, /api/auth/websocket-ticket
// - WS  : Effect RPC (JSON フレーム) でスレッド起動・購読・成果物取得

import { EventEmitter } from "node:events";

const DEFAULT_BASE = process.env.DEEPAI_BASE_URL || "http://127.0.0.1:3773";

function wsUrlFrom(base, ticket) {
  const u = new URL(base);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/ws";
  u.searchParams.set("wsTicket", ticket);
  u.searchParams.set("orchestrationProtocol", "2");
  return u.toString();
}

export class DeepAIClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl ローカル DeepAI Code サーバー
   * @param {string} opts.token   Bearer トークン
   */
  constructor({ baseUrl = DEFAULT_BASE, token }) {
    super();
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map(); // requestId -> {resolve, reject}
    this.streams = new Map(); // requestId -> handler
  }

  async http(path, init = {}) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${path}: ${text.slice(0, 300)}`);
    }
    const ct = res.headers.get("content-type") || "";
    return ct.includes("application/json") ? res.json() : res.text();
  }

  async listProjects() {
    const data = await this.http("/api/projects");
    return data.projects || [];
  }

  async connect() {
    if (this.ws && this.ws.readyState === 1) return;
    const { ticket } = await this.http("/api/auth/websocket-ticket", { method: "POST", body: "{}" });
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrlFrom(this.baseUrl, ticket));
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error("WebSocket 接続がタイムアウトしました")), 15000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        this.emit("open");
        resolve();
      });
      ws.addEventListener("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`WebSocket 接続エラー: ${e.message || "unknown"}`));
      });
      ws.addEventListener("close", () => {
        this.emit("close");
        this.ws = null;
      });
      ws.addEventListener("message", (ev) => this.#onMessage(ev.data));
    });
  }

  #onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      return;
    }
    if (msg._tag === "Exit") {
      const p = this.pending.get(msg.requestId);
      if (p) {
        this.pending.delete(msg.requestId);
        if (msg.exit._tag === "Success") p.resolve(msg.exit.value);
        else p.reject(new Error(`RPC 失敗: ${JSON.stringify(msg.exit).slice(0, 400)}`));
      }
      return;
    }
    if (msg._tag === "Chunk") {
      const h = this.streams.get(msg.requestId);
      if (h) {
        for (const v of msg.values || []) {
          try {
            h(v);
          } catch (err) {
            this.emit("error", err);
          }
        }
      }
      return;
    }
    if (msg._tag === "Defect") {
      this.emit("error", new Error(`RPC Defect: ${JSON.stringify(msg.defect).slice(0, 300)}`));
    }
  }

  /** Unary RPC を実行する */
  async call(tag, payload) {
    await this.connect();
    const id = String(++this.nextId);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
  }

  /** ストリーミング RPC を実行する（handler は各チャンクを受け取る） */
  async stream(tag, payload, handler) {
    await this.connect();
    const id = String(++this.nextId);
    this.streams.set(id, handler);
    this.ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    return id;
  }

  closeStream(id) {
    this.streams.delete(id);
  }

  /**
   * 指示を投げてスレッドを起動する。
   * @returns {Promise<{threadId: string, projection: object}>}
   */
  async launchThread({ projectId, text, title, model, runtimeMode = "full-access", interactionMode = "default" }) {
    const result = await this.call("orchestration.launchThread", {
      commandId: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      projectId,
      title: title || text.slice(0, 60) || "phone task",
      generateTitle: true,
      modelSelection: { instanceId: "deepai", model: model || "deepai/minimax-m3.1-flash" },
      runtimeMode,
      interactionMode,
      workspaceStrategy: { type: "root" },
      initialMessage: { text, attachments: [] },
    });
    return result;
  }

  /** 既存スレッドに追記の指示を送る */
  async dispatchMessage({ threadId, text }) {
    return this.call("orchestration.dispatchCommand", {
      type: "message.dispatch",
      commandId: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdBy: "user",
      creationSource: "web",
      threadId,
      messageId: `message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    });
  }

  /** スレッドの更新を購読する */
  subscribeThread(threadId, handler, opts = {}) {
    return this.stream(
      "orchestration.subscribeThread",
      { threadId, ...opts },
      handler,
    );
  }

  async getThreadProjection(threadId) {
    return this.call("orchestration.getThreadProjection", { threadId });
  }

  /** 作業ディレクトリの一覧 */
  async listEntries(cwd, directoryPath) {
    const payload = { cwd };
    if (directoryPath) payload.directoryPath = directoryPath;
    return this.call("projects.listEntries", payload);
  }

  /** ファイルを読み取る */
  async readFile(cwd, relativePath) {
    return this.call("projects.readFile", { cwd, relativePath });
  }

  async close() {
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
  }
}