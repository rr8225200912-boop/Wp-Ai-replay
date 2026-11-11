// OpenRouter-compatible replacement for the existing Gemini module.
// Keeps the same exported API so ai.js and the rest of the project do not need changes.

const MODEL = String(process.env.OPENROUTER_MODEL || 'openrouter/free').trim();
const API_URL = 'https://openrouter.ai/api/v1/chat/completions';

function convertContents(contents = []) {
  return contents.map((item) => {
    const role = item.role === 'model' ? 'assistant' : 'user';
    const text = (item.parts || []).map((part) => part.text || '').join('');
    return { role, content: text };
  }).filter((item) => item.content.trim());
}

async function gemini({ system, contents, json = false }) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY Railway Variables-এ সেট করা নেই');

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push(...convertContents(contents));
  if (!messages.length) throw new Error('AI-তে পাঠানোর মতো কোনো মেসেজ নেই');

  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'https://railway.app',
        'X-Title': process.env.OPENROUTER_APP_NAME || 'Personal WhatsApp AI',
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.7,
        max_tokens: 1200,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(60000),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error('OpenRouter request ৬০ সেকেন্ডে উত্তর দেয়নি (timeout)');
    }
    throw new Error(`OpenRouter network error: ${error?.message || error}`);
  }

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 900);
    throw new Error(`OpenRouter ${response.status} (${MODEL}): ${detail}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error(`OpenRouter খালি উত্তর দিয়েছে (${MODEL})`);
  }
  return text.trim();
}

module.exports = { gemini, MODEL };
