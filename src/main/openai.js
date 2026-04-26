// Thin OpenAI REST wrapper. Uses Node's built-in fetch (Electron 41
// ships modern Node). All calls accept an explicit apiKey so the
// caller (ipc.js) decides where the key comes from — keeps this
// module decoupled from settings storage.

const fs = require('node:fs');

const API_BASE = 'https://api.openai.com/v1';

async function testApiKey(apiKey) {
  if (!apiKey) return { ok: false, reason: 'no-key' };
  try {
    const res = await fetch(`${API_BASE}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) return { ok: true };
    if (res.status === 401) return { ok: false, reason: 'invalid' };
    return { ok: false, reason: `http-${res.status}` };
  } catch (err) {
    return { ok: false, reason: 'network', detail: err.message };
  }
}

// Auto-tag a save's image. Resizes via sharp before sending so token
// usage is predictable, asks the model for a JSON object so we can
// parse without prose-handling, and uses gpt-4o-mini + detail:'low'
// to keep cost bounded (~$0.001 per call as of this writing).
async function autoTagImage(apiKey, filePath) {
  if (!apiKey) throw new Error('Missing OpenAI key');
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('Image file not found');
  }

  const sharp = require('sharp');
  const resized = await sharp(filePath)
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  const dataUrl = `data:image/jpeg;base64,${resized.toString('base64')}`;

  const body = {
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'You suggest short, useful tags for visual inspiration. Return JSON only: ' +
          '{"tags": ["tag1", "tag2", ...]}. Provide 3-6 lowercase tags. ' +
          'Use single words or hyphenated phrases. Focus on style, content, ' +
          'mood, or use case. Avoid generic words like "image", "design", "art".',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Tag this image.' },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
        ],
      },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 120,
  };

  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    if (res.status === 401) throw new Error('Invalid OpenAI key');
    throw new Error(`OpenAI API ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('No content in OpenAI response');

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('OpenAI response was not valid JSON');
  }

  const raw = Array.isArray(parsed.tags) ? parsed.tags : [];
  return raw
    .filter((t) => typeof t === 'string')
    .map((t) => t.trim().toLowerCase().replace(/^#+/, ''))
    .filter(Boolean)
    .slice(0, 6);
}

// Auto-name a save's image with a short, descriptive title (2-6 words).
// Same pipeline shape as autoTagImage — resize → JSON-mode chat call.
async function autoNameImage(apiKey, filePath) {
  if (!apiKey) throw new Error('Missing OpenAI key');
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('Image file not found');
  }

  const sharp = require('sharp');
  const resized = await sharp(filePath)
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  const dataUrl = `data:image/jpeg;base64,${resized.toString('base64')}`;

  const body = {
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'You write short, useful titles for visual inspiration. ' +
          'Return JSON only: {"title": "..."}. The title must be 2-6 words, ' +
          'use Title Case, capture the subject / style / mood, and read like a ' +
          'designer\'s label. No quotes, no trailing punctuation, no emoji.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Title this image.' },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
        ],
      },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 60,
  };

  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    if (res.status === 401) throw new Error('Invalid OpenAI key');
    throw new Error(`OpenAI API ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('No content in OpenAI response');

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('OpenAI response was not valid JSON');
  }

  const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  // Strip wrapping quotes the model sometimes adds despite instructions.
  return title.replace(/^["'`]+|["'`]+$/g, '').slice(0, 80) || null;
}

module.exports = { testApiKey, autoTagImage, autoNameImage };
