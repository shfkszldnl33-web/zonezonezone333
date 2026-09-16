// api/analyze-food.js
//
// Vercel serverless function. This is the ONLY place in the whole project that ever talks to
// Google's Gemini API - the browser (index.html) never sees, stores, sends, or has any way to
// read the Gemini key. The key lives exclusively in this server's GEMINI_API_KEY environment
// variable (set in the Vercel dashboard, never committed to source control).
//
// Route: POST /api/analyze-food
// (Vercel maps this file to that path automatically - no routing config needed.)
//
// Accepts two request shapes, both as a JSON body:
//   1) Food-photo analysis:    { "imageBase64": "<base64, no \"data:...,\" prefix>", "mimeType": "image/jpeg" }
//   2) Text-based food lookup: { "text": "김치찌개 1인분" }
// (Both are handled by this single file/endpoint on purpose, so there is exactly one Gemini
// integration point to secure and reason about.)
//
// NOTE: index.html's food-search screen no longer calls the text-lookup shape (2) above - it
// now calls the dedicated api/nutrition-info.js endpoint (NUTRITION_API_KEY) instead, so that
// feature's key can be configured/rotated independently of this file's GEMINI_API_KEY. The
// text-lookup handler below is left in place (same request/response shape) in case anything
// else still depends on POST /api/analyze-food with { text }.
//
// Always responds with JSON:
//   success (photo): { "ok": true, "foods": [ { name, estimated_amount_g, calories_kcal, ... } ] }
//   success (text):  { "ok": true, "food": { name, baseAmount, unit, kcal, protein, carbs, fat, sugar, sodium, desc } }
//   failure:         { "ok": false, "code": "<CODE>", "message": "<generic Korean message>" }
//
// IMPORTANT: the failure `message` is always one of a small set of fixed, generic, user-safe
// strings defined below. The real error from Gemini (or a network failure) is only ever written
// to this function's own server-side logs via console.error() - it is never included in the
// response body, so nothing about the request, the key, or Google's raw error text can leak to
// a visitor's screen.

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GEMINI_TIMEOUT_MS = 25000;

// Safety net against oversized requests. The frontend already resizes photos before sending
// (see resizeImageDataUrl() in index.html), so real-world payloads should be far under this -
// this just makes sure an unexpectedly huge request fails with a clear, friendly error instead
// of an obscure timeout or platform-level rejection. Also keeps us comfortably under Vercel's
// own request body size limit for serverless functions.
const MAX_IMAGE_BASE64_CHARS = 5_500_000; // ~5.5MB of base64 (~4MB decoded image)
const MAX_TEXT_QUERY_CHARS = 200;

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

// Comma-separated list of allowed origins in the ALLOWED_ORIGIN env var, or "*" (the default)
// to allow any origin. This only matters if the frontend is ever served from a different origin
// than this API (e.g. the site stays on GitHub Pages while just this backend moves to Vercel) -
// a same-origin deployment (frontend + /api together on one Vercel project, as this repo is
// structured) works regardless of this setting.
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

  // Preflight for cross-origin POST requests with a JSON content type.
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    fail(res, 405, 'METHOD_NOT_ALLOWED', '허용되지 않는 요청 방식이에요.');
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // A deployment/setup gap on the site owner's side, not something a visitor can act on -
    // never say more than "not configured yet" to the client.
    console.error('[analyze-food] GEMINI_API_KEY is not set in the environment');
    fail(res, 500, 'SERVER_NOT_CONFIGURED', 'AI 분석 기능이 아직 설정되지 않았어요.');
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || typeof body !== 'object') {
    fail(res, 400, 'INVALID_REQUEST', '요청 형식이 올바르지 않아요.');
    return;
  }

  try {
    if (typeof body.text === 'string' && body.text.trim()) {
      await handleTextLookup(body, apiKey, res);
      return;
    }
    if (typeof body.imageBase64 === 'string' && body.imageBase64.trim()) {
      await handlePhotoAnalysis(body, apiKey, res);
      return;
    }
    fail(res, 400, 'INVALID_REQUEST', '분석할 사진 또는 검색어가 필요해요.');
  } catch (err) {
    // handlePhotoAnalysis/handleTextLookup already turn every expected failure into their own
    // fail() response, so reaching here means something genuinely unexpected happened.
    console.error('[analyze-food] unexpected error', err);
    fail(res, 500, 'SERVER_ERROR', '서버에서 일시적인 문제가 발생했어요. 잠시 후 다시 시도해주세요.');
  }
};

async function handlePhotoAnalysis(body, apiKey, res) {
  const imageBase64 = body.imageBase64.trim();
  const mimeType = typeof body.mimeType === 'string' && body.mimeType ? body.mimeType : 'image/jpeg';

  if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
    fail(res, 400, 'INVALID_IMAGE_TYPE', '지원하지 않는 이미지 형식이에요. JPG, PNG, WEBP 사진으로 다시 시도해주세요.');
    return;
  }
  if (imageBase64.length > MAX_IMAGE_BASE64_CHARS) {
    fail(res, 413, 'PAYLOAD_TOO_LARGE', '사진 용량이 너무 커요. 더 작은 사진으로 다시 시도해주세요.');
    return;
  }

  const prompt = [
    '이 사진 속 음식을 분석해줘. 사진에 여러 음식이 있으면 각각 구분해서 인식해.',
    '반드시 아래 JSON 형식으로만, 다른 설명 문장 없이 답변해:',
    '{"foods":[{"name":"","main_ingredients":["",""],"estimated_amount":"예: 1공기, 중간 크기 1개","estimated_amount_g":100,"calories_kcal":0,"carbohydrates_g":0,"protein_g":0,"fat_g":0,"fiber_g":0,"sugar_g":0,"sodium_mg":0,"confidence":"high|medium|low"}]}',
    '- name: 음식 이름',
    '- main_ingredients: 눈에 보이는 주요 식재료 목록 (배열, 최대 5개)',
    '- estimated_amount: 사람이 이해하기 쉬운 예상 섭취량 설명 (예: "1공기", "중간 크기 1개", "약 2조각")',
    '- estimated_amount_g: 예상 중량(g), 숫자만',
    '- 사진만으로는 정확한 중량/칼로리를 알 수 없으니 합리적인 추정값을 넣고 confidence로 확신 정도를 표시해.',
    '- 포장 제품이고 영양성분표가 사진에 보이면 그 표시값을 우선적으로 사용해.',
    '- 음식이 아니거나 전혀 인식할 수 없으면 foods를 빈 배열로 반환해.',
  ].join('\n');

  let text;
  try {
    text = await callGeminiGenerateContent(
      [{ text: prompt }, { inline_data: { mime_type: mimeType, data: imageBase64 } }],
      apiKey,
    );
  } catch (err) {
    respondGeminiError(res, err);
    return;
  }

  const rawFoods = extractJsonFoods(text);
  if (!rawFoods) {
    fail(res, 502, 'BAD_SHAPE', 'AI 응답을 이해하지 못했어요. 사진을 다시 찍거나 검색으로 직접 추가해주세요.');
    return;
  }
  if (!rawFoods.length) {
    fail(res, 200, 'NO_FOOD_RECOGNIZED', '사진에서 음식을 인식하지 못했어요. 더 밝은 곳에서, 음식이 잘 보이도록 다시 찍어주세요.');
    return;
  }
  res.status(200).json({ ok: true, foods: rawFoods });
}

async function handleTextLookup(body, apiKey, res) {
  const query = body.text.trim().slice(0, MAX_TEXT_QUERY_CHARS);
  if (!query) {
    fail(res, 400, 'INVALID_REQUEST', '검색어를 입력해주세요.');
    return;
  }

  const prompt = `"${query}"의 100g(또는 1인분) 기준 영양정보를 JSON으로만 답하세요. 형식: {"name":"","baseAmount":100,"unit":"g","kcal":0,"protein":0,"carbs":0,"fat":0,"sugar":0,"sodium":0,"desc":"한줄설명"}`;

  let text;
  try {
    text = await callGeminiGenerateContent([{ text: prompt }], apiKey);
  } catch (err) {
    respondGeminiError(res, err);
    return;
  }

  const food = extractJsonObject(text);
  if (!food || !food.name) {
    fail(res, 502, 'BAD_SHAPE', 'AI 응답을 이해하지 못했어요. 다시 시도해주세요.');
    return;
  }
  res.status(200).json({ ok: true, food });
}

// Low-level Gemini REST call, shared by both request shapes above. Throws an Error whose
// `.code` is one of the short codes respondGeminiError() understands - it never returns or
// throws anything containing the API key, and never lets Google's raw response body reach the
// caller (only this function's own console.error() calls see it, for the site owner's benefit).
async function callGeminiGenerateContent(parts, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS) : null;

  try {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ contents: [{ parts }] }),
        signal: controller ? controller.signal : undefined,
      });
    } catch (networkErr) {
      if (networkErr && networkErr.name === 'AbortError') {
        throw makeCodedError('TIMEOUT', 'Gemini request timed out');
      }
      throw makeCodedError('NETWORK', 'Network error reaching Gemini');
    }

    if (res.status === 429) {
      console.error('[analyze-food] Gemini rate limited:', await safeReadErrorMessage(res));
      throw makeCodedError('RATE_LIMITED', 'Gemini rate limited');
    }
    if (!res.ok) {
      console.error(`[analyze-food] Gemini HTTP ${res.status}:`, await safeReadErrorMessage(res));
      throw makeCodedError('UPSTREAM_ERROR', `Gemini HTTP ${res.status}`);
    }

    let json;
    try {
      json = await res.json();
    } catch (parseErr) {
      throw makeCodedError('BAD_RESPONSE', 'Gemini response was not JSON');
    }

    const text = json && json.candidates && json.candidates[0] && json.candidates[0].content &&
      json.candidates[0].content.parts && json.candidates[0].content.parts[0] &&
      json.candidates[0].content.parts[0].text;
    if (!text) throw makeCodedError('EMPTY_RESPONSE', 'Gemini returned an empty response');
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

// Best-effort extraction of Google's own error message, for our server-side logs ONLY - this
// return value must never be sent in an HTTP response to the client.
async function safeReadErrorMessage(res) {
  try {
    const body = await res.json();
    return (body && body.error && body.error.message) || `HTTP ${res.status}`;
  } catch (e) {
    return `HTTP ${res.status}`;
  }
}

function respondGeminiError(res, err) {
  const code = (err && err.code) || 'SERVER_ERROR';
  const table = {
    TIMEOUT: [504, '분석이 너무 오래 걸려 중단했어요. 잠시 후 다시 시도해주세요.'],
    NETWORK: [502, 'AI 서버에 연결하지 못했어요. 잠시 후 다시 시도해주세요.'],
    RATE_LIMITED: [429, '요청이 많아요. 잠시 후 다시 시도해주세요.'],
    UPSTREAM_ERROR: [502, 'AI 분석 중 문제가 발생했어요. 잠시 후 다시 시도해주세요.'],
    BAD_RESPONSE: [502, 'AI 응답을 이해하지 못했어요. 다시 시도해주세요.'],
    EMPTY_RESPONSE: [502, 'AI 응답을 이해하지 못했어요. 다시 시도해주세요.'],
  };
  const [status, message] = table[code] || [500, '서버에서 일시적인 문제가 발생했어요. 잠시 후 다시 시도해주세요.'];
  fail(res, status, code, message);
}

// The model is asked for pure JSON but may still wrap it in prose or code fences - pull out the
// first {...} or [...] block before parsing, and never trust the shape blindly.
function extractJsonFoods(text) {
  try {
    const objMatch = text.match(/\{[\s\S]*\}/);
    const arrMatch = text.match(/\[[\s\S]*\]/);
    const jsonText = objMatch ? objMatch[0] : (arrMatch ? arrMatch[0] : null);
    if (!jsonText) return null;
    const parsed = JSON.parse(jsonText);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.foods)) return parsed.foods;
    return null;
  } catch (e) {
    return null;
  }
}

function extractJsonObject(text) {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch (e) {
    return null;
  }
}
