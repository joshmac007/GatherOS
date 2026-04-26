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

// Auto-analyze a save's image — title + 1-sentence description in one
// vision call. The description feeds the embedding, so semantic search
// has richer signal than tags alone.
async function analyzeImage(apiKey, filePath) {
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
          'You write designer-friendly metadata for visual inspiration. ' +
          'Return JSON: {"title": "...", "description": "...", "text": "..."}. ' +
          'title: 2-6 words, Title Case, capture subject/style/mood. ' +
          'description: ONE sentence packed with concrete searchable nouns ' +
          'and adjectives. Cover (a) every notable object or subject visible ' +
          '(e.g. statue, mountain, person, button, logo, sky, clouds, water, ' +
          'building, chart), (b) the visual style or art movement (e.g. ' +
          'minimalist, brutalist, Renaissance, illustration, photograph, 3D ' +
          'render, vaporwave), (c) the dominant colors, (d) the mood, and ' +
          '(e) the likely use case ("landing page", "poster", "UI screenshot"). ' +
          'Prefer concrete nouns over abstract framing. No quotes, no emoji. ' +
          'text: every word that appears IN the image — UI labels, headlines, ' +
          'body copy, button text, signage, captions. Preserve original wording ' +
          'and capitalization. Separate distinct lines with " | ". Empty string ' +
          'if no text is visible.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze this image.' },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
        ],
      },
    ],
    response_format: { type: 'json_object' },
    // Bumped to fit OCR'd text. Long text-heavy screenshots can produce
    // a few hundred tokens of OCR; this gives enough headroom while
    // still being inexpensive.
    max_tokens: 800,
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

  const title = typeof parsed.title === 'string'
    ? parsed.title.trim().replace(/^["'`]+|["'`]+$/g, '').slice(0, 80)
    : '';
  const description = typeof parsed.description === 'string'
    ? parsed.description.trim().replace(/^["'`]+|["'`]+$/g, '').slice(0, 600)
    : '';
  const text = typeof parsed.text === 'string'
    ? parsed.text.trim().slice(0, 4000)
    : '';
  return {
    title: title || null,
    description: description || null,
    text: text || null,
  };
}

// text-embedding-3-small returns a 1536-dim Float32 vector. Returns
// the raw array; caller is responsible for serializing to a Buffer.
async function embedText(apiKey, text) {
  if (!apiKey) throw new Error('Missing OpenAI key');
  const trimmed = (text || '').trim();
  if (!trimmed) throw new Error('Cannot embed empty text');

  const res = await fetch(`${API_BASE}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: trimmed.slice(0, 8000),
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    if (res.status === 401) throw new Error('Invalid OpenAI key');
    throw new Error(`OpenAI embed ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await res.json();
  const vec = data.data?.[0]?.embedding;
  if (!Array.isArray(vec)) throw new Error('No embedding in response');
  return vec;
}

// Cheap LLM-driven query expansion. Turns "mountain" into
// "mountain, mountains, peaks, summit, alpine, hiking, landscape"
// before the embedding lookup, which dramatically improves recall on
// short single-noun queries. Original wording is preserved so literal
// matches still rank high. Caller falls back to the raw query on any
// failure.
async function expandQuery(apiKey, query) {
  const trimmed = (query || '').trim();
  // Skip expansion for very short or very long queries — short ones are
  // commonly already exact (e.g. brand names), long ones don't need it.
  if (!apiKey || trimmed.length < 2 || trimmed.length > 60) return trimmed;

  try {
    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'You expand short visual-search queries with closely-related ' +
              'concepts and synonyms to improve embedding recall. Return ' +
              'JSON: {"expanded": "..."}. Comma-separated, 5-8 related ' +
              'terms. Keep it tight — only terms a designer would consider ' +
              'genuinely related to the query. No quotes around items.',
          },
          { role: 'user', content: trimmed },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 80,
      }),
    });
    if (!res.ok) return trimmed;
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return trimmed;
    const parsed = JSON.parse(content);
    const expanded = (parsed.expanded || '').trim();
    if (!expanded) return trimmed;
    // Original query stays at the front so its embedding gets the most
    // weight when text-embedding-3-small averages the tokens.
    return `${trimmed}, ${expanded}`;
  } catch {
    return trimmed;
  }
}

// LLM-based reranker over the cosine-ranked candidate set. The cosine
// pass produces a relevance-ordered list, but it can't actually reason
// — the reranker reads each candidate's title/description/OCR and
// drops anything tangential, then orders the survivors by judgment.
// This is what fixes the "semantic-near but actually-unrelated" cases.
async function rerankCandidates(apiKey, query, candidates) {
  if (!apiKey || candidates.length <= 1) return candidates;

  // Compact each candidate to keep the rerank prompt small and fast.
  const items = candidates.slice(0, 30).map((c, i) => {
    const title = (c.title || '').slice(0, 80);
    const desc = (c.ai_description || '').slice(0, 250);
    const ocr = (c.ocr_text || '').slice(0, 150);
    return `[${i}] title: ${title} | desc: ${desc}${ocr ? ` | text: ${ocr}` : ''}`;
  });

  try {
    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'You rerank visual-search candidates by genuine relevance to ' +
              'the user query. Return JSON: {"ids": [n, n, ...]}. The "ids" ' +
              'array contains the [n] indexes of candidates that are ' +
              'actually relevant, ordered most-relevant first. Drop ' +
              'candidates that are tangential, off-topic, or share only ' +
              'incidental visual elements. Be inclusive about loosely ' +
              'related matches; be strict about unrelated ones.',
          },
          {
            role: 'user',
            content: `Query: ${query}\n\nCandidates:\n${items.join('\n')}`,
          },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 200,
      }),
    });
    if (!res.ok) return candidates;
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return candidates;
    const parsed = JSON.parse(content);
    const orderedIds = Array.isArray(parsed.ids) ? parsed.ids : [];
    if (orderedIds.length === 0) return candidates;
    return orderedIds
      .map((n) => candidates[n])
      .filter(Boolean);
  } catch {
    return candidates;
  }
}

// Generate an image-generation prompt that recreates the visual style
// and content of the input image. Designed to be model-agnostic — works
// for Midjourney, DALL-E, Stable Diffusion, etc. — so we don't include
// tool-specific parameter syntax (--ar, /imagine, etc.). Returns a
// single descriptive paragraph the user can paste into any of them.
async function generateImagePrompt(apiKey, filePath) {
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
          'You write image-generation prompts that recreate the visual ' +
          'style and content of a reference image. The prompts are used ' +
          'with Midjourney, DALL-E, Stable Diffusion, and similar tools.\n\n' +
          'Return JSON: {"prompt": "..."}.\n\n' +
          'The prompt must:\n' +
          '- Be a single paragraph, 35-75 words\n' +
          '- Describe subjects, composition, camera framing, lighting, ' +
          'color palette, texture, style/medium, and mood\n' +
          '- Use flowing natural language, not comma-stuffed keyword lists\n' +
          '- Not include tool-specific parameter syntax (--ar, --v, /imagine)\n' +
          '- Not name copyrighted characters, real people, or real brands\n' +
          '- Not start with "An image of" or "A picture of" — describe directly',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Write a prompt that recreates this image.' },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
        ],
      },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 280,
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
  try { parsed = JSON.parse(content); }
  catch { throw new Error('OpenAI response was not valid JSON'); }

  const prompt = typeof parsed.prompt === 'string'
    ? parsed.prompt.trim().replace(/^["'`]+|["'`]+$/g, '')
    : '';
  return prompt || null;
}

module.exports = {
  testApiKey, autoTagImage, analyzeImage, embedText, expandQuery,
  rerankCandidates, generateImagePrompt,
};
