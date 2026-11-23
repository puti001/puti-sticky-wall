/**
 * Puti-AI 萬用現場便利貼牆 — GAS 雙向共創＋Gemini 安全代理後端
 * 使用 PropertiesService + LockService，免額外試算表授權即可支援多人發文與按讚同步
 */

const DEFAULT_MODEL = "gemini-2.5-flash";
const MAX_PROMPT_LENGTH = 15000;
const CHUNK_SIZE = 7000;

function jsonOutput(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function getMeta(props) {
  try {
    const raw = props.getProperty("WALL_META");
    if (raw) {
      const m = JSON.parse(raw);
      return { round: Number(m.round) || 1, topic: String(m.topic || "") };
    }
  } catch (e) {}
  return { round: 1, topic: "" };
}

function saveMeta(props, meta) {
  props.setProperty("WALL_META", JSON.stringify({
    round: Number(meta.round) || 1,
    topic: String(meta.topic || "")
  }));
}

function readRoundNotes(props, round) {
  const prefix = "WALL_NOTES_R" + round;
  const countStr = props.getProperty(prefix + "_CHUNKS");
  if (countStr) {
    const count = Number(countStr) || 0;
    let joined = "";
    for (let i = 0; i < count; i++) {
      joined += props.getProperty(prefix + "_" + i) || "";
    }
    try { return JSON.parse(joined || "[]"); } catch (e) { return []; }
  }
  const single = props.getProperty(prefix);
  if (!single) return [];
  try { return JSON.parse(single); } catch (e) { return []; }
}

function writeRoundNotes(props, round, notes) {
  const prefix = "WALL_NOTES_R" + round;
  const json = JSON.stringify(notes || []);
  const oldChunks = Number(props.getProperty(prefix + "_CHUNKS") || 0);
  for (let i = 0; i < oldChunks; i++) {
    props.deleteProperty(prefix + "_" + i);
  }
  props.deleteProperty(prefix);

  if (json.length <= CHUNK_SIZE) {
    props.deleteProperty(prefix + "_CHUNKS");
    props.setProperty(prefix, json);
    return;
  }
  const chunks = Math.ceil(json.length / CHUNK_SIZE);
  props.setProperty(prefix + "_CHUNKS", String(chunks));
  for (let i = 0; i < chunks; i++) {
    props.setProperty(prefix + "_" + i, json.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
  }
}

function doGet() {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty("GEMINI_API_KEY");
  const meta = getMeta(props);
  const notes = readRoundNotes(props, meta.round);
  return jsonOutput({
    ok: true,
    service: "Puti-AI Sticky Wall Gemini Proxy",
    hasKey: Boolean(key && key.trim()),
    round: meta.round,
    topic: meta.topic,
    notes: notes
  });
}

function callGemini(props, body) {
  const apiKey = (props.getProperty("GEMINI_API_KEY") || "").trim();
  if (!apiKey) {
    return jsonOutput({
      ok: false,
      error: "GAS 後端尚未設定 GEMINI_API_KEY（請至 GAS 專案設定 → 指令碼屬性新增 GEMINI_API_KEY）"
    });
  }
  const prompt = String(body.prompt || "").trim();
  if (!prompt) return jsonOutput({ ok: false, error: "缺少 prompt 內容" });
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return jsonOutput({ ok: false, error: "內容過長，超過單次整理上限" });
  }

  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(DEFAULT_MODEL) +
    ":generateContent?key=" +
    encodeURIComponent(apiKey);

  const resp = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    muteHttpExceptions: true
  });

  const code = resp.getResponseCode();
  const data = JSON.parse(resp.getContentText() || "{}");
  if (code < 200 || code >= 300) {
    return jsonOutput({ ok: false, error: (data.error && data.error.message) || ("HTTP " + code) });
  }

  const text =
    (data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text) || "";

  return text
    ? jsonOutput({ ok: true, text: text.trim() })
    : jsonOutput({ ok: false, error: "Gemini 未回傳文字內容" });
}

function doPost(e) {
  const props = PropertiesService.getScriptProperties();
  try {
    const raw = (e && e.postData && e.postData.contents) ? e.postData.contents : "{}";
    const body = JSON.parse(raw);

    const requiredPin = (props.getProperty("PROXY_PIN") || "").trim();
    if (requiredPin && String(body.pin || "").trim() !== requiredPin) {
      return jsonOutput({ ok: false, error: "代理通行碼 (PIN) 不正確" });
    }

    const action = body.action || (body.prompt ? "ai" : "wall");
    if (action === "ai") {
      return callGemini(props, body);
    }

    const lock = LockService.getScriptLock();
    lock.waitLock(8000);
    try {
      const meta = getMeta(props);
      let notes = readRoundNotes(props, meta.round);

      if (action === "add") {
        const text = String(body.text || "").trim().slice(0, 600);
        if (!text) return jsonOutput({ ok: false, error: "請輸入便利貼內容" });
        const author = String(body.author || "現場老師").trim().slice(0, 40) || "現場老師";
        const note = {
          id: "w-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
          author: author,
          text: text,
          votes: 1,
          starred: false,
          colorIdx: (notes.length % 4) + 1,
          ts: Date.now()
        };
        notes.unshift(note);
        writeRoundNotes(props, meta.round, notes);
        return jsonOutput({ ok: true, note: note, round: meta.round, topic: meta.topic, notes: notes });
      }

      if (action === "vote") {
        const id = String(body.id || "");
        const delta = Number(body.delta) === -1 ? -1 : 1;
        notes = notes.map((n) => {
          if (n.id !== id) return n;
          return Object.assign({}, n, { votes: Math.max(0, (Number(n.votes) || 0) + delta) });
        });
        writeRoundNotes(props, meta.round, notes);
        return jsonOutput({ ok: true, round: meta.round, topic: meta.topic, notes: notes });
      }

      if (action === "star") {
        const id = String(body.id || "");
        notes = notes.map((n) => n.id === id ? Object.assign({}, n, { starred: !n.starred }) : n);
        writeRoundNotes(props, meta.round, notes);
        return jsonOutput({ ok: true, round: meta.round, topic: meta.topic, notes: notes });
      }

      if (action === "delete") {
        const id = String(body.id || "");
        notes = notes.filter((n) => n.id !== id);
        writeRoundNotes(props, meta.round, notes);
        return jsonOutput({ ok: true, round: meta.round, topic: meta.topic, notes: notes });
      }

      if (action === "set_topic") {
        meta.topic = String(body.topic || "").trim().slice(0, 200);
        saveMeta(props, meta);
        return jsonOutput({ ok: true, round: meta.round, topic: meta.topic, notes: notes });
      }

      if (action === "new_round") {
        meta.round = (Number(meta.round) || 1) + 1;
        meta.topic = String(body.topic || "").trim().slice(0, 200);
        saveMeta(props, meta);
        writeRoundNotes(props, meta.round, []);
        return jsonOutput({ ok: true, round: meta.round, topic: meta.topic, notes: [] });
      }

      return jsonOutput({ ok: true, round: meta.round, topic: meta.topic, notes: notes });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return jsonOutput({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}
