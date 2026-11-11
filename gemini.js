// Gemini API configuration.
// Older accounts may not be allowed to call gemini-2.5-flash anymore.
const FALLBACK_MODEL = 'gemini-3.8-flash';
const configuredModel = String(process.env.GEMINI_MODEL || '').trim().replace(/^models\//, '');
const MODEL = !configuredModel || configuredModel === 'gemini-2.5-flash'
  ? FALLBACK_MODEL
  : configuredModel;

async function gemini({ system, contents, json = false }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY সেট করা নেই');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const body = {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
    // Gemini 3.8 Flash-এর default sampling settings ব্যবহার করা হচ্ছে।
    generationConfig: {
      maxOutputTokens: 1200,
      ...(json ? { responseMimeType: 'application/json' } : {}),
    },
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error('Gemini request ৯০ সেকেন্ডেও উত্তর দেয়নি। Railway-এর নেটওয়ার্ক বা API status পরীক্ষা করুন।');
    }
    throw new Error(`Gemini network error: ${error?.message || error}`);
  }

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 700);
    throw new Error(`Gemini ${res.status} (${MODEL}): ${detail}`);
  }

  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text || '')
    .join('');

  if (!text.trim()) {
    const reason = data.promptFeedback?.blockReason || 'সম্ভবত সেফটি ফিল্টার বা খালি response';
    throw new Error(`Gemini খালি উত্তর পাঠিয়েছে: ${reason}`);
  }
  return text;
}

module.exports = { gemini, MODEL };
