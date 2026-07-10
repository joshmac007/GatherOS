const fs = require('node:fs');

async function imageToDataUrl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('Image file not found');
  }
  const sharp = require('sharp');
  const resized = await sharp(filePath)
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return `data:image/jpeg;base64,${resized.toString('base64')}`;
}

function extractJsonObject(text) {
  const raw = (text || '').trim();
  if (!raw) throw new Error('Local model returned empty response');
  try { return JSON.parse(raw); } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1]);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
  throw new Error('Local model response was not valid JSON');
}

function authHeaders(config) {
  return config.token ? { Authorization: `Bearer ${config.token}` } : {};
}

async function postJson(config, path, body) {
  const res = await fetch(`${config.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(config),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message || data.error || `local_ai_http_${res.status}`);
    err.code = 'local_ai_error';
    throw err;
  }
  return data;
}

async function visionJson(config, filePath, system, user, maxTokens) {
  const dataUrl = await imageToDataUrl(filePath);
  const data = await postJson(config, '/chat/completions', {
    model: config.chatModel,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          { type: 'text', text: user },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
        ],
      },
    ],
    response_format: { type: 'json_object' },
    max_tokens: maxTokens,
  });
  const content = data.choices?.[0]?.message?.content;
  return extractJsonObject(content);
}

async function textJson(config, system, user, maxTokens) {
  const data = await postJson(config, '/chat/completions', {
    model: config.chatModel,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' },
    max_tokens: maxTokens,
  });
  const content = data.choices?.[0]?.message?.content;
  return extractJsonObject(content);
}

function createLocalProvider(config) {
  return {
    name: 'local',
    hasSession() {
      return true;
    },
    async analyzeImage(filePath) {
      const parsed = await visionJson(
        config,
        filePath,
        'Return JSON only: {"title": "...", "description": "...", "text": "..."}. title is 2-6 Title Case words. description is one concrete searchable sentence. text is every visible word in the image, or empty string.',
        'Analyze this image for a visual inspiration library.',
        800,
      );
      return {
        title: typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 80) || null : null,
        description: typeof parsed.description === 'string' ? parsed.description.trim().slice(0, 600) || null : null,
        text: typeof parsed.text === 'string' ? parsed.text.trim().slice(0, 4000) || null : null,
      };
    },
    async autoTagImage(filePath) {
      const parsed = await visionJson(
        config,
        filePath,
        'Return JSON only: {"tags": ["tag1", "tag2"]}. Provide 3-6 lowercase, concrete tags. Use single words or hyphenated phrases. Avoid generic words like image, design, art.',
        'Tag this image.',
        160,
      );
      const tags = Array.isArray(parsed.tags) ? parsed.tags : [];
      return tags
        .filter((tag) => typeof tag === 'string')
        .map((tag) => tag.trim().toLowerCase().replace(/^#+/, ''))
        .filter(Boolean)
        .slice(0, 6);
    },
    async generateImagePrompt(filePath) {
      const parsed = await visionJson(
        config,
        filePath,
        'Return JSON only: {"prompt": "..."}. The prompt is one paragraph, 35-75 words, describing subject, composition, lighting, color, texture, style, and mood. No tool-specific parameters.',
        'Write a prompt that recreates this image.',
        320,
      );
      return typeof parsed.prompt === 'string'
        ? parsed.prompt.trim().replace(/^["'`]+|["'`]+$/g, '') || null
        : null;
    },
    async generateSaveTopicProfile(input, { imagePath = null } = {}) {
      const system =
        'You are categorizing one saved item for a personal visual/reference library.\n\n' +
        'Return JSON only: {"summary":"one concrete sentence","concepts":["3-8 normalized concepts"],"content_type":"tweet|product-screenshot|article|diagram|moodboard|code|other","intent":"tool-reference|tutorial|inspiration|opinion|research|quote|other","visible_text":"important OCR text or empty","confidence":0.0}.\n\n' +
        'Use all supplied evidence. If image evidence conflicts with tweet text, prefer the image for visual/content category. Avoid generic concepts like "design", "image", "post", "tool" unless qualified.';
      const user = `Inputs:\n${JSON.stringify(input || {}, null, 2)}`;
      return imagePath
        ? visionJson(config, imagePath, system, user, 700)
        : textJson(config, system, user, 700);
    },
    async generateImage() {
      const err = new Error('Local image generation is not configured for GatherLocal yet');
      err.code = 'image_generation_unavailable';
      throw err;
    },
    async getUsage() {
      return null;
    },
  };
}

module.exports = {
  createLocalProvider,
  extractJsonObject,
};
