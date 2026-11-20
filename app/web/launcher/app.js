// DeepAI ダッシュボード: 複数 PC のブリッジを 1 画面から切り替える
(() => {
  const STORE = "deepai.phone.entries.v1";
  const listEl = document.getElementById("list");
  const noteEl = document.getElementById("note");
  const formEl = document.getElementById("addForm");
  const nameEl = document.getElementById("name");
  const urlEl = document.getElementById("url");

  const params = new URLSearchParams(location.search);
  const selfKey = params.get("k") || "";

  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(STORE) || "[]");
    } catch {
      return [];
    }
  };
  const write = (entries) => localStorage.setItem(STORE, JSON.stringify(entries));

  // URL から 名前・キー・ベースURL を分離する
  function parseEntry(raw, fallbackName) {
    const text = String(raw || "").trim();
    if (!text) return null;
    let u;
    try {
      u = new URL(text.startsWith("http") ? text : `http://${text}`);
    } catch {
      return null;
    }
    const key = u.searchParams.get("k") || "";
    u.search = "";
    u.hash = "";
    const host = u.host;
    const name = fallbackName?.trim() || u.searchParams.get("name") || host;
    return { id: `${host}|${key}`, name, base: `${u.origin}`, host, key };
  }

  function selfEntry() {
    const base = location.origin;
    return { id: `${base}|${selfKey}`, name: "この PC", base, host: location.host, key: selfKey };
  }

  function merge(entries) {
    const map = new Map();
    for (const e of entries) if (e && e.base && e.key) map.set(e.id, e);
    return [...map.values()];
  }

  function entries() {
    const list = merge(read());
    if (selfKey) {
      const me = selfEntry();
      const i = list.findIndex((e) => e.id === me.id);
      if (i >= 0) list[i] = me;
      else list.unshift(me);
    }
    return list;
  }

  async function probe(entry) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2500);
      const res = await fetch(`${entry.base}/api/ping?k=${encodeURIComponent(entry.key)}`, {
        signal: ctl.signal,
        cache: "no-store",
      });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  function card(entry) {
    const el = document.createElement("div");
    el.className = "card";

    const row = document.createElement("div");
    row.className = "row";
    const dot = document.createElement("span");
    dot.className = "dot";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = entry.name;
    const state = document.createElement("span");
    state.className = "state";
    state.textContent = "確認中";
    row.append(dot, name, state);

    const addr = document.createElement("p");
    addr.className = "addr";
    addr.textContent = entry.base;

    const actions = document.createElement("div");
    actions.className = "actions";
    const go = document.createElement("a");
    go.className = "go";
    go.href = `${entry.base}/?k=${encodeURIComponent(entry.key)}`;
    go.textContent = "この PC を開く";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "URL コピー";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(go.href);
        copy.textContent = "コピーしました";
        setTimeout(() => (copy.textContent = "URL コピー"), 1500);
      } catch {
        copy.textContent = "コピー失敗";
      }
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "del";
    del.textContent = "削除";
    del.addEventListener("click", () => {
      const rest = read().filter((e) => e.id !== entry.id);
      write(rest);
      render();
    });
    actions.append(go, copy, del);

    el.append(row, addr, actions);
    el._state = { dot, state };
    return el;
  }

  function render() {
    const list = entries();
    listEl.textContent = "";
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "PC が登録されていません。下から追加してください。";
      listEl.append(empty);
      return;
    }
    for (const entry of list) {
      const el = card(entry);
      listEl.append(el);
      probe(entry).then((ok) => {
        el._state.dot.className = `dot ${ok ? "ok" : "bad"}`;
        el._state.state.className = `state ${ok ? "ok" : "bad"}`;
        el._state.state.textContent = ok ? "オンライン" : "オフライン";
      });
    }
  }

  formEl.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const parsed = parseEntry(urlEl.value, nameEl.value);
    if (!parsed) {
      noteEl.textContent = "URL を正しく入力してください（例: http://192.168.0.6:8787/?k=xxxxxxxx）";
      return;
    }
    if (!parsed.key) {
      noteEl.textContent = "URL にキー（?k=...）が含まれていません。キーのある URL を貼り付けてください。";
      return;
    }
    const list = merge(read());
    const i = list.findIndex((e) => e.id === parsed.id);
    if (i >= 0) list[i] = parsed;
    else list.push(parsed);
    write(list);
    nameEl.value = "";
    urlEl.value = "";
    noteEl.textContent = `${parsed.name} を追加しました`;
    render();
  });

  noteEl.textContent =
    "ヒント: 各 PC で起動したターミナルに表示される URL（キー付き）を貼り込むと、"+
    " スマホの名前に複数 PC の DeepAI Code を並べ替えられます。";

  render();
  setInterval(render, 30000);
})();
