/**
 * Puti-AI 萬用現場便利貼牆 — GAS 雙向共創＋安全鎖＋Gemini 代理後端
 * - 支援手機單機限讚 1 票（clientId 伺服器端去重）
 * - 支援講師管理密碼（HOST_PIN）保護刪除、標星、改題目、開新回合與 AI 呼叫
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

function readChunkedJson(props, prefix, fallback) {
  const countStr = props.getProperty(prefix + "_CHUNKS");
  if (countStr) {
    const count = Number(countStr) || 0;
    let joined = "";
    for (let i = 0; i < count; i++) {
      joined += props.getProperty(prefix + "_" + i) || "";
    }
    try { return JSON.parse(joined || "null") || fallback; } catch (e) { return fallback; }
  }
  const single = props.getProperty(prefix);
  if (!single) return fallback;
  try { return JSON.parse(single); } catch (e) { return fallback; }
}

function writeChunkedJson(props, prefix, value) {
  const json = JSON.stringify(value);
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

function readRoundNotes(props, round) {
  return readChunkedJson(props, "WALL_NOTES_R" + round, []);
}

function writeRoundNotes(props, round, notes) {
  writeChunkedJson(props, "WALL_NOTES_R" + round, notes || []);
}

function readRoundVotes(props, round) {
  return readChunkedJson(props, "WALL_VOTES_R" + round, {});
}

function writeRoundVotes(props, round, votesMap) {
  writeChunkedJson(props, "WALL_VOTES_R" + round, votesMap || {});
}

function verifyHostPin(props, body) {
  const savedPin = (props.getProperty("HOST_PIN") || "").trim();
  if (!savedPin) return true; // 尚未設定密碼前允許首次管理，建議設定一次即鎖定
  return String(body.hostPin || "").trim() === savedPin;
}

function doGet() {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty("GEMINI_API_KEY");
  const savedPin = (props.getProperty("HOST_PIN") || "").trim();
  const meta = getMeta(props);
  const notes = readRoundNotes(props, meta.round);
  return jsonOutput({
    ok: true,
    service: "Puti-AI Sticky Wall Gemini Proxy",
    hasKey: Boolean(key && key.trim()),
    hasHostPin: Boolean(savedPin),
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
    const action = body.action || (body.prompt ? "ai" : "wall");

    if (action === "ai") {
      if (!verifyHostPin(props, body)) {
        return jsonOutput({ ok: false, error: "需要講師密碼才能執行 AI 整理" });
      }
      return callGemini(props, body);
    }

    const lock = LockService.getScriptLock();
    lock.waitLock(8000);
    try {
      const meta = getMeta(props);
      let notes = readRoundNotes(props, meta.round);
      const savedPin = (props.getProperty("HOST_PIN") || "").trim();

      // 驗證或首次設定講師管理密碼
      if (action === "check_host_pin") {
        if (!savedPin) return jsonOutput({ ok: true, valid: true, hasHostPin: false });
        const okPin = String(body.hostPin || "").trim() === savedPin;
        return jsonOutput({ ok: true, valid: okPin, hasHostPin: true });
      }

      if (action === "set_host_pin") {
        const newPin = String(body.newPin || "").trim();
        if (!newPin || newPin.length < 3) {
          return jsonOutput({ ok: false, error: "密碼至少需要 3 個字元" });
        }
        if (savedPin && String(body.hostPin || "").trim() !== savedPin) {
          return jsonOutput({ ok: false, error: "舊密碼不正確，無法更改講師密碼" });
        }
        props.setProperty("HOST_PIN", newPin);
        return jsonOutput({ ok: true, hasHostPin: true });
      }

      // 學員與老師共用的安全動作：新增便利貼
      if (action === "add") {
        const text = String(body.text || "").trim().slice(0, 600);
        if (!text) return jsonOutput({ ok: false, error: "請輸入便利貼內容" });
        const author = String(body.author || "現場老師").trim().slice(0, 40) || "現場老師";
        const note = {
          id: "w-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
          author: author,
          text: text,
          votes: 0,
          starred: false,
          colorIdx: (notes.length % 4) + 1,
          ts: Date.now()
        };
        notes.unshift(note);
        writeRoundNotes(props, meta.round, notes);
        return jsonOutput({ ok: true, note: note, hasHostPin: Boolean(savedPin), round: meta.round, topic: meta.topic, notes: notes });
      }

      // 伺服器端限單一裝置（clientId）每張便利貼最多讚 1 票（再按收回）
      if (action === "vote") {
        const id = String(body.id || "");
        const clientId = String(body.clientId || "").trim().slice(0, 64);
        if (!clientId) return jsonOutput({ ok: false, error: "缺少裝置識別碼" });

        const votesMap = readRoundVotes(props, meta.round);
        const list = Array.isArray(votesMap[id]) ? votesMap[id] : [];
        const idx = list.indexOf(clientId);
        let liked = false;
        if (idx >= 0) {
          list.splice(idx, 1);
          liked = false;
        } else {
          list.push(clientId);
          liked = true;
        }
        votesMap[id] = list;
        writeRoundVotes(props, meta.round, votesMap);

        notes = notes.map((n) => n.id === id ? Object.assign({}, n, { votes: list.length }) : n);
        writeRoundNotes(props, meta.round, notes);
        return jsonOutput({ ok: true, liked: liked, hasHostPin: Boolean(savedPin), round: meta.round, topic: meta.topic, notes: notes });
      }

      // 以下為講師專屬管理操作，必須通過 HOST_PIN
      if (!verifyHostPin(props, body)) {
        return jsonOutput({ ok: false, error: "需要講師密碼才能執行管理操作" });
      }

      if (action === "star") {
        const id = String(body.id || "");
        notes = notes.map((n) => n.id === id ? Object.assign({}, n, { starred: !n.starred }) : n);
        writeRoundNotes(props, meta.round, notes);
        return jsonOutput({ ok: true, hasHostPin: Boolean(savedPin), round: meta.round, topic: meta.topic, notes: notes });
      }

      if (action === "delete") {
        const id = String(body.id || "");
        notes = notes.filter((n) => n.id !== id);
        writeRoundNotes(props, meta.round, notes);
        return jsonOutput({ ok: true, hasHostPin: Boolean(savedPin), round: meta.round, topic: meta.topic, notes: notes });
      }

      if (action === "set_topic") {
        meta.topic = String(body.topic || "").trim().slice(0, 200);
        saveMeta(props, meta);
        return jsonOutput({ ok: true, hasHostPin: Boolean(savedPin), round: meta.round, topic: meta.topic, notes: notes });
      }

      if (action === "new_round") {
        meta.round = (Number(meta.round) || 1) + 1;
        meta.topic = String(body.topic || "").trim().slice(0, 200);
        saveMeta(props, meta);
        writeRoundNotes(props, meta.round, []);
        writeRoundVotes(props, meta.round, {});
        return jsonOutput({ ok: true, hasHostPin: Boolean(savedPin), round: meta.round, topic: meta.topic, notes: [] });
      }

      return jsonOutput({ ok: true, hasHostPin: Boolean(savedPin), round: meta.round, topic: meta.topic, notes: notes });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return jsonOutput({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}
