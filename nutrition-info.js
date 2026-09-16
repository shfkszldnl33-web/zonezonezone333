// api/nutrition-info.js
//
// Vercel serverless function dedicated to food nutrition lookups (as opposed to
// api/analyze-food.js, which handles food-PHOTO analysis and the diet-logging text search).
// This is the ONLY place in the project that reads NUTRITION_API_KEY - the browser (index.html)
// never sees, stores, sends, or has any way to read it. The key lives exclusively in this
// server's NUTRITION_API_KEY environment variable (set in the Vercel dashboard, never committed
// to source control). See README.md "영양정보 API 설정" for how to set it.
//
// Route: POST /api/nutrition-info
// (Vercel maps this file to that path automatically - no routing config needed.)
//
// Request body (JSON): { "query": "음식 이름, 예: 김치찌개 1인분" }
//
// Response:
//   success: { "ok": true, "food": { name, baseAmount, unit, kcal, protein, carbs, fat, sugar, sodium, desc } }
//   failure: { "ok": false, "code": "<CODE>", "message": "<generic Korean message>" }
//
// IMPORTANT: the failure `message` is always one of a small set of fixed, generic, user-safe
// strings defined below. The real error is only ever written to this function's own server-side
// logs via console.error() - never included in the response body, so nothing about the request,
// the key, or the upstream provider's raw error text can leak to a visitor's screen.
//
// NOTE ON PROVIDER: this endpoint calls the Gemini API (the same upstream api/analyze-food.js
// uses) but reads its key from a SEPARATE env var, NUTRITION_API_KEY, as requested - so the
// food-nutrition-lookup feature can be configured/rotated independently of the food-PHOTO-
// analysis key (GEMINI_API_KEY) even though both currently point at the same provider. If this
// project ever switches to a dedicated nutrition database API instead, only buildNutritionPrompt()
// and callNutritionProvider() below need to change - everything else (env var name, request/
// response shape, error handling) stays the same.

const NUTRITION_MODEL = process.env.NUTRITION_MODEL || 'gemini-3.6-flash';
const NUTRITION_TIMEOUT_MS = 20000;
const MAX_QUERY_CHARS = 200;

function resolveCorsOrigin(req) {
  const configured = (process.env.ALLOWED_ORIGIN || '*').trim();
  if (configured === '*') return '*';
  const allowed = configured.split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) return origin;
  return allowed[0] || 'null';
}

function setCorsHeaders(req, res) {
  res.setHeader('Access-Control-Allow-Origin', resolveCorsOrigin(req));
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function fail(res, status, code, message) {
  res.status(status).json({ ok: false, code, message });
}

module.exports = async function handler(req, res) {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    fail(res, 405, 'METHOD_NOT_ALLOWED', '허용되지 않는 요청 방식이에요.');
    return;
  }

  const apiKey = process.env.NUTRITION_API_KEY;
  if (!apiKey) {
    // A deployment/setup gap on the site owner's side, not something a visitor can act on.
    console.error('[nutrition-info] NUTRITION_API_KEY is not set in the environment');
    fail(res, 500, 'SERVER_NOT_CONFIGURED', '영양정보 조회 기능이 아직 설정되지 않았어요.');
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  const query = body && typeof body.query === 'string' ? body.query.trim().slice(0, MAX_QUERY_CHARS) : '';
  if (!query) {
    fail(res, 400, 'INVALID_REQUEST', '조회할 음식 이름을 입력해주세요.');
    return;
  }

  try {
    const text = await callNutritionProvider(buildNutritionPrompt(query), apiKey);
    const food = extractJsonObject(text);
    if (!food || !food.name) {
      fail(res, 502, 'BAD_SHAPE', '영양정보 응답을 이해하지 못했어요. 다시 시도해주세요.');
      return;
    }
    res.status(200).json({ ok: true, food });
  } catch (err) {
    if (err && err.code) {
      respondProviderError(res, err);
      return;
    }
    console.error('[nutrition-info] unexpected error', err);
    fail(res, 500, 'SERVER_ERROR', '서버에서 일시적인 문제가 발생했어요. 잠시 후 다시 시도해주세요.');
  }
};

function buildNutritionPrompt(query) {
  return `"${query}"의 100g(또는 1인분) 기준 영양정보를 JSON으로만 답하세요. 형식: {"name":"","baseAmount":100,"unit":"g","kcal":0,"protein":0,"carbs":0,"fat":0,"sugar":0,"sodium":0,"desc":"한줄설명"}`;
}

// Low-level provider call. Throws an Error whose `.code` is one of the short codes
// respondProviderError() understands - never returns or throws anything containing the API key,
// and never lets the provider's raw response body reach the caller (only console.error() sees
// it, for the site owner's benefit).
async function callNutritionProvider(promptText, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(NUTRITION_MODEL)}:generateContent`;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), NUTRITION_TIMEOUT_MS) : null;

  try {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }] }),
        signal: controller ? controller.signal : undefined,
      });
    } catch (networkErr) {
      if (networkErr && networkErr.name === 'AbortError') throw makeCodedError('TIMEOUT', 'nutrition provider request timed out');
      throw makeCodedError('NETWORK', 'network error reaching nutrition provider');
    }

    if (res.status === 429) {
      console.error('[nutrition-info] provider rate limited:', await safeReadErrorMessage(res));
      throw makeCodedError('RATE_LIMITED', 'nutrition provider rate limited');
    }
    if (!res.ok) {
      console.error(`[nutrition-info] provider HTTP ${res.status}:`, await safeReadErrorMessage(res));
      throw makeCodedError('UPSTREAM_ERROR', `nutrition provider HTTP ${res.status}`);
    }

    let json;
    try {
      json = await res.json();
    } catch (parseErr) {
      throw makeCodedError('BAD_RESPONSE', 'nutrition provider response was not JSON');
    }

    const text = json && json.candidates && json.candidates[0] && json.candidates[0].content &&
      json.candidates[0].content.parts && json.candidates[0].content.parts[0] &&
      json.candidates[0].content.parts[0].text;
    if (!text) throw makeCodedError('EMPTY_RESPONSE', 'nutrition provider returned an empty response');
    return text;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function makeCodedError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// Best-effort extraction of the provider's own error message, for server-side logs ONLY - this
// return value must never be sent in an HTTP response to the client.
async function safeReadErrorMessage(res) {
  try {
    const body = await res.json();
    return (body && body.error && body.error.message) || `HTTP ${res.status}`;
  } catch (e) {
    return `HTTP ${res.status}`;
  }
}

function respondProviderError(res, err) {
  const code = (err && err.code) || 'SERVER_ERROR';
  const table = {
    TIMEOUT: [504, '영양정보 조회가 너무 오래 걸려 중단했어요. 잠시 후 다시 시도해주세요.'],
    NETWORK: [502, '영양정보 서버에 연결하지 못했어요. 잠시 후 다시 시도해주세요.'],
    RATE_LIMITED: [429, '요청이 많아요. 잠시 후 다시 시도해주세요.'],
    UPSTREAM_ERROR: [502, '영양정보 조회 중 문제가 발생했어요. 잠시 후 다시 시도해주세요.'],
    BAD_RESPONSE: [502, '영양정보 응답을 이해하지 못했어요. 다시 시도해주세요.'],
    EMPTY_RESPONSE: [502, '영양정보 응답을 이해하지 못했어요. 다시 시도해주세요.'],
  };
  const [status, message] = table[code] || [500, '서버에서 일시적인 문제가 발생했어요. 잠시 후 다시 시도해주세요.'];
  fail(res, status, code, message);
}

// The model is asked for pure JSON but may still wrap it in prose or code fences - pull out the
// first {...} block before parsing, and never trust the shape blindly.
function extractJsonObject(text) {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch (e) {
    return null;
  }
}
