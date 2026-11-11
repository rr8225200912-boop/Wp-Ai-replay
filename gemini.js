// Groq-powered replacement for the existing Gemini module.
// Keeps the same exported API so ai.js and the rest of the project stay unchanged.
// Railway variable required: GROQ_API_KEY

const API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const PRIMARY_MODEL = 'openai/gpt-oss-120b';
const FALLBACK_MODEL = 'openai/gpt-oss-20b';

function convertContents(contents = []) {
  return contents.map((item) => {
    const role = item.role === 'model' || item.role === 'assistant' ? 'assistant' : 'user';
    const text = (item.parts || []).map((part) => part.text || '').join('');
    return { role, content: text };
  }).filter((item) => item.content.trim());
}

function isRetryable(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function requestModel({ key, model, messages, json }) {
  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.7,
        max_completion_tokens: 1200,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    const detail = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      ? 'request timed out after 30 seconds'
      : (error?.message || String(error));
    throw new Error(`Groq network error (${model}): ${detail}`);
  }

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 700);
    const error = new Error(`Groq ${response.status} (${model}): ${detail}`);
    error.status = response.status;
    throw error;
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error(`Groq returned an empty response (${model})`);
  }
  return text.trim();
}

async function gemini({ system, contents, json = false }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY Railway Variables-এ সেট করা নেই');

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push(...convertContents(contents));
  if (!messages.length) throw new Error('AI-তে পাঠানোর মতো কোনো মেসেজ নেই');

  try {
    return await requestModel({ key, model: PRIMARY_MODEL, messages, json });
  } catch (primaryError) {
    // Fall back only for temporary capacity/rate-limit/server errors.
    if (primaryError.status && !isRetryable(primaryError.status)) throw primaryError;
    try {
      return await requestModel({ key, model: FALLBACK_MODEL, messages, json });
    } catch (fallbackError) {
      throw new Error(
        `Groq primary model failed: ${primaryError.message}\nGroq fallback model failed: ${fallbackError.message}`
      );
    }
  }
}

module.exports = {
  gemini,
  MODEL: PRIMARY_MODEL,
  FALLBACK_MODEL,
};
