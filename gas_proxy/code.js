/**
 * Puti-AI 萬用現場便利貼牆 — Gemini API 安全代理後端
 *
 * 【首次使用設定（只需做 1 次）】
 * 1. 開啟本 GAS 專案：https://script.google.com
 * 2. 點左側「專案設定（齒輪）」→ 最下方「指令碼屬性」→ 新增屬性：
 *    - 屬性名稱：GEMINI_API_KEY
 *    - 值：貼上你的 Gemini API Key（AIzaSy...）
 * （或直接在編輯器執行一次下方的 setupKeyDemo 函式並記得刪除 Key 字串）
 */

const DEFAULT_MODEL = "gemini-2.5-flash";
const MAX_PROMPT_LENGTH = 15000;

function jsonOutput(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  const key = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  return jsonOutput({
    ok: true,
    service: "Puti-AI Sticky Wall Gemini Proxy",
    hasKey: Boolean(key && key.trim())
  });
}

function doPost(e) {
  try {
    const props = PropertiesService.getScriptProperties();
    const apiKey = (props.getProperty("GEMINI_API_KEY") || "").trim();
    if (!apiKey) {
      return jsonOutput({
        ok: false,
        error: "GAS 後端尚未設定 GEMINI_API_KEY（請至 GAS 專案設定 → 指令碼屬性新增 GEMINI_API_KEY）"
      });
    }

    const raw = (e && e.postData && e.postData.contents) ? e.postData.contents : "{}";
    const body = JSON.parse(raw);

    const requiredPin = (props.getProperty("PROXY_PIN") || "").trim();
    if (requiredPin && String(body.pin || "").trim() !== requiredPin) {
      return jsonOutput({ ok: false, error: "代理通行碼 (PIN) 不正確" });
    }

    const prompt = String(body.prompt || "").trim();
    if (!prompt) {
      return jsonOutput({ ok: false, error: "缺少 prompt 內容" });
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
      return jsonOutput({ ok: false, error: "內容過長，超過單次整理上限" });
    }

    const model = DEFAULT_MODEL;
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model) +
      ":generateContent?key=" +
      encodeURIComponent(apiKey);

    const resp = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      }),
      muteHttpExceptions: true
    });

    const code = resp.getResponseCode();
    const data = JSON.parse(resp.getContentText() || "{}");
    if (code < 200 || code >= 300) {
      const msg = (data.error && data.error.message) ? data.error.message : ("HTTP " + code);
      return jsonOutput({ ok: false, error: msg });
    }

    const text =
      (data.candidates &&
        data.candidates[0] &&
        data.candidates[0].content &&
        data.candidates[0].content.parts &&
        data.candidates[0].content.parts[0] &&
        data.candidates[0].content.parts[0].text) || "";

    if (!text) {
      return jsonOutput({ ok: false, error: "Gemini 未回傳文字內容" });
    }

    return jsonOutput({ ok: true, text: text.trim() });
  } catch (err) {
    return jsonOutput({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}
