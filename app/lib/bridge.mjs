// DeepAI ブリッジ: スマホ → PC の DeepAI Code サーバ を中継する中核ロジック
//
// -phone から来た指示を DeepAI Code の WS RPC に変換し、
//- 実行状況（turn items）をポーリングで取得して正規化し、:
//-SSE で ):phone に配信する。
import { EventEmitter } from "node:events";
import { DeepAIClient } from "./deepai-client.mjs";

const POLL_INTERVAL_MS = 700;

/** turn item をスマホ表示用の軽量オブジェクトに正規化する */
function normalizeTurnItem(item) {
  const base = {
    id: item.id,
    type: item.type,
    status: item.status,
    startedAt: item.startedAt,
    completedAt: item.completedAt,
    title: item.title ?? null,
  };
  switch (item.type) {
    case "user_message":
      return { ...base, kind: "user", text: item.text ?? "" };
    case "assistant_message":
      return { ...base, kind: "assistant", text: item.text ?? "", streaming: item.streaming === true };
    case "reasoning":
      return { ...base, kind: "reasoning", text: item.text ?? "", streaming: item.streaming === true };
    case "command_execution":
      return {
        ...base,
        kind: "command",
        input: item.input ?? "",
        output: item.output ?? "",
        outputOmitted: item.outputOmitted === true,
        exitCode: item.exitCode ?? null,
        command: item.command ?? item.title ?? "",
      };
    case "file_change":
      return {
        ...base,
        kind: "file",
        fileName: item.fileName ?? "",
        changeType: item.title ?? "write",
      };
    case "todo_list":
      return { ...base, kind: "todo", items: item.items ?? [] };
    case "dynamic_tool":
      return {
        ...base,
        kind: "tool",
        title: item.title ?? "tool",
        input: item.input ?? "",
        output: item.output ?? "",
      };
    case "notification":
      return { ...base, kind: "notification", text: item.text ?? item.message ?? "" };
    case "proposed_plan":
      return { ...base, kind: "plan", text: item.text ?? item.plan ?? "" };
    case "user_input_request":
      return { ...base, kind: "input_request", text: item.text ?? item.prompt ?? "" };
    default:
      return { ...base, kind: "other", text: item.text ?? "" };
  }
}

/** スレッドの状態（表示用） */
export function normalizeProjection(projection) {
  const turnItems = (projection.turnItems || []).map(normalizeTurnItem);
  const runs = projection.runs || [];
  // 実行中（active）な run を優先する。複数 queued 排在 latest だと状態を誤表示するため。
  const active =
    runs.find((r) => r.status === "running" || r.status === "waiting") ??
    runs.filter((r) => r.status !== "completed" && r.status !== "failed" && r.status !== "cancelled").at(-1) ??
    runs.at(-1);
  const run = active;
  return {
    threadId: projection.thread?.id ?? null,
    title: projection.thread?.title ?? "",
    worktreePath: projection.thread?.worktreePath ?? null,
    projectId: projection.thread?.projectId ?? null,
    status: run?.status ?? "unknown",
    updatedAt: projection.updatedAt ?? null,
    turnItems,
  };
}

export class ThreadSession extends EventEmitter {
  constructor(bridge, threadId, { cwd = null } = {}) {
    super();
    this.bridge = bridge;
    this.threadId = threadId;
    this.cwd = cwd;
    this.state = normalizeProjection({ runs: [], turnItems: [], thread: {} });
    this.threadIds = new Set();
    this.lastSignature = "";
    this.timer = null;
    this.busy = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.#tick(), POLL_INTERVAL_MS);
    this.#tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async #tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const projection = await this.bridge.client.getThreadProjection(this.threadId);
      const next = normalizeProjection(projection);
      // worktreePath が分かったら記録（成果物一覧用）
      if (next.worktreePath && !this.cwd) this.cwd = next.worktreePath;
      const signature = JSON.stringify([
        next.status,
        next.turnItems.map((i) => [i.id, i.status, i.text, i.exitCode, i.completedAt]),
      ]);
      if (signature !== this.lastSignature) {
        this.lastSignature = signature;
        this.state = next;
        this.emit("update", next);
      }
    } catch (err) {
      this.emit("warn", `スレッド状態の取得に失敗: ${err.message}`);
    } finally {
      this.busy = false;
    }
  }
}

export class Bridge extends EventEmitter {
  constructor({ token, baseUrl }) {
    super();
    this.client = new DeepAIClient({ token, baseUrl });
    this.sessions = new Map(); // threadId -> ThreadSession
    this.projects = [];
  }

  async init() {
    await this.client.connect();
    this.projects = await this.client.listProjects();
    return this.projects;
  }

  get defaultProject() {
    return this.projects[0] ?? null;
  }

  /** 新しいタスク（スレッド）を開始する */
  async startTask({ text, projectId, title }) {
    const project = this.projects.find((p) => p.id === projectId) ?? this.defaultProject;
    if (!project) throw new Error("利用可能なプロジェクトがありません");
    const result = await this.client.launchThread({
      projectId: project.id,
      text,
      title: title || text.slice(0, 40),
    });
    const threadId = result.threadId ?? result?.thread?.id;
    if (!threadId) throw new Error("スレッドIDを取得できませんでした");
    const session = new ThreadSession(this, threadId);
    this.sessions.set(threadId, session);
    session.start();
    return session;
  }

  /** 既存スレッドに追記の指示を送る */
  async continueTask(threadId, text) {
    const session = this.ensureSession(threadId);
    await this.client.dispatchMessage({ threadId, text });
    // ポーリングは既に走っているので追加処理は不要
    return session;
  }

  /** セッションを確保する（スマホのリロード後にスレッドを再開する場合に使う） */
  ensureSession(threadId) {
    let session = this.sessions.get(threadId);
    if (!session) {
      session = new ThreadSession(this, threadId);
      this.sessions.set(threadId, session);
      session.start();
    }
    return session;
  }

  getSession(threadId) {
    return this.sessions.get(threadId) ?? null;
  }

  /** 成果物ファイル一覧 */
  async listFiles(cwd, directoryPath) {
    const res = await this.client.listEntries(cwd, directoryPath);
    return res.entries ?? [];
  }

  /**
   * turn item の詳細（省略されたコマンド出力など）を取得する。
   * 投影では output が省略されるため、必要時だけ呼ぶ。
   */
  async getTurnItem(threadId, itemId) {
    const res = await this.client.call("orchestration.getTurnItem", { threadId, itemId });
    return res.item ?? res;
  }

  async readFile(cwd, relativePath) {
    return this.client.readFile(cwd, relativePath);
  }

  async close() {
    for (const s of this.sessions.values()) s.stop();
    this.sessions.clear();
    await this.client.close();
  }
}
