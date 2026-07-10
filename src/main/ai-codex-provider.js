const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');

function codexAvailable(bin) {
  const result = spawnSync(bin, ['--version'], {
    encoding: 'utf8',
    timeout: 3000,
  });
  return !result.error && result.status === 0;
}

function extractJsonObject(text) {
  const raw = (text || '').trim();
  if (!raw) throw new Error('Codex returned empty response');
  try { return JSON.parse(raw); } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1]);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
  throw new Error('Codex response was not valid JSON');
}

function runCodexTurn(config, { prompt, imagePath }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.bin, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    let nextId = 1;
    let threadId = null;
    let output = '';
    let sawDelta = false;
    let stderr = '';
    const pending = new Map();
    let settled = false;

    const timeout = setTimeout(() => {
      finish(new Error('Codex timed out while processing image metadata'));
    }, config.timeoutMs);

    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { proc.kill(); } catch {}
      if (err) reject(err);
      else resolve(value);
    }

    function request(method, params = {}) {
      const id = nextId++;
      proc.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
      return new Promise((res, rej) => {
        pending.set(id, { res, rej });
      });
    }

    function notify(method, params = {}) {
      proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
    }

    async function start() {
      await request('initialize', {
        clientInfo: {
          name: 'gatherlocal',
          title: 'GatherLocal',
          version: '0.1.0',
        },
      });
      notify('initialized');
      const threadParams = {
        cwd: process.cwd(),
        approvalPolicy: 'never',
        sandbox: 'read-only',
        serviceName: 'gatherlocal',
      };
      if (config.model) threadParams.model = config.model;
      const thread = await request('thread/start', threadParams);
      threadId = thread.thread?.id;
      if (!threadId) throw new Error('Codex did not return a thread id');
      await request('turn/start', {
        threadId,
        input: [
          { type: 'text', text: prompt },
          ...(imagePath ? [{ type: 'localImage', path: imagePath }] : []),
        ],
      });
    }

    proc.on('error', (err) => finish(err));
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('exit', (code) => {
      if (!settled && code !== 0) {
        finish(new Error(stderr.trim() || `Codex exited with code ${code}`));
      }
    });

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (typeof msg.id === 'number') {
        const waiter = pending.get(msg.id);
        if (!waiter) return;
        pending.delete(msg.id);
        if (msg.error) waiter.rej(new Error(msg.error.message || 'Codex RPC error'));
        else waiter.res(msg.result || {});
        return;
      }
      if (msg.method === 'item/agentMessage/delta' && msg.params?.delta) {
        sawDelta = true;
        output += msg.params.delta;
      }
      if (msg.method === 'item/completed') {
        const text = msg.params?.item?.text || msg.params?.item?.message?.content || '';
        if (!sawDelta && typeof text === 'string') output += text;
      }
      if (msg.method === 'turn/completed' && (!threadId || msg.params?.turn?.threadId === threadId || msg.params?.threadId === threadId)) {
        const status = msg.params?.turn?.status;
        if (status === 'failed') {
          finish(new Error(msg.params?.turn?.error?.message || 'Codex turn failed'));
        } else {
          finish(null, output);
        }
      }
    });

    start().catch(finish);
  });
}

async function codexJson(config, imagePath, instructions) {
  const text = await runCodexTurn(config, {
    imagePath,
    prompt:
      `${instructions}\n\n` +
      'Return JSON only. Do not write Markdown. Do not inspect unrelated files. Do not run commands.',
  });
  return extractJsonObject(text);
}

function createCodexProvider(config, { codexJson: codexJsonImpl = codexJson } = {}) {
  return {
    name: 'codex',
    hasSession() {
      return codexAvailable(config.bin);
    },
    async analyzeImage(filePath) {
      const parsed = await codexJson(
        config,
        filePath,
        'Analyze this image for a visual inspiration library. Return {"title": "...", "description": "...", "text": "..."}. title: 2-6 Title Case words. description: one concrete searchable sentence. text: every visible word in the image, or empty string.',
      );
      return {
        title: typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 80) || null : null,
        description: typeof parsed.description === 'string' ? parsed.description.trim().slice(0, 600) || null : null,
        text: typeof parsed.text === 'string' ? parsed.text.trim().slice(0, 4000) || null : null,
      };
    },
    async autoTagImage(filePath) {
      const parsed = await codexJson(
        config,
        filePath,
        'Tag this image. Return {"tags": ["tag1", "tag2"]}. Provide 3-6 lowercase, concrete tags. Use single words or hyphenated phrases. Avoid generic words like image, design, art.',
      );
      const tags = Array.isArray(parsed.tags) ? parsed.tags : [];
      return tags
        .filter((tag) => typeof tag === 'string')
        .map((tag) => tag.trim().toLowerCase().replace(/^#+/, ''))
        .filter(Boolean)
        .slice(0, 6);
    },
    async generateImagePrompt(filePath) {
      const parsed = await codexJson(
        config,
        filePath,
        'Write a prompt that recreates this image. Return {"prompt": "..."}. The prompt is one paragraph, 35-75 words, describing subject, composition, lighting, color, texture, style, and mood. No tool-specific parameters.',
      );
      return typeof parsed.prompt === 'string'
        ? parsed.prompt.trim().replace(/^["'`]+|["'`]+$/g, '') || null
        : null;
    },
    async generateSaveTopicProfile(input, { imagePath = null } = {}) {
      return codexJson(
        config,
        imagePath,
        'You are categorizing one saved item for a personal visual/reference library.\n\n' +
        'Return JSON only:\n' +
        '{\n' +
        '  "summary": "one concrete sentence",\n' +
        '  "concepts": ["3-8 normalized concepts"],\n' +
        '  "content_type": "tweet|product-screenshot|article|diagram|moodboard|code|other",\n' +
        '  "intent": "tool-reference|tutorial|inspiration|opinion|research|quote|other",\n' +
        '  "visible_text": "important OCR text or empty",\n' +
        '  "confidence": 0.0\n' +
        '}\n\n' +
        'Use all supplied evidence. If image evidence conflicts with tweet text, prefer the image for visual/content category. Avoid generic concepts like "design", "image", "post", "tool" unless qualified.\n\n' +
        `Inputs:\n${JSON.stringify(input || {}, null, 2)}`,
      );
    },
    async generateSmartCategoryMemberships(input) {
      return codexJson(
        config,
        null,
        'Given one save topic profile and candidate smart categories, assign weighted memberships.\n\n' +
        'Return JSON only:\n' +
        '{\n' +
        '  "memberships": [\n' +
        '    {\n' +
        '      "category_id": "cat_123",\n' +
        '      "weight": 0.0,\n' +
        '      "evidence": "short reason"\n' +
        '    }\n' +
        '  ],\n' +
        '  "needs_new_category": true,\n' +
        '  "new_category_hint": "short topic label or null"\n' +
        '}\n\n' +
        'Rules:\n' +
        '- A save may belong to multiple categories.\n' +
        '- Use 0.75+ for strong primary fit.\n' +
        '- Use 0.45-0.74 for secondary fit.\n' +
        '- Below 0.45 omit.\n' +
        '- Do not force a category if evidence is weak.\n\n' +
        `Inputs:\n${JSON.stringify(input || {}, null, 2)}`,
      );
    },
    async generateSmartCategoryTaxonomyRefresh(input) {
      return codexJson(
        config,
        null,
        'Review existing smart categories for a personal visual/reference library.\n\n' +
        'Return JSON only:\n' +
        '{\n' +
        '  "renames": [\n' +
        '    {\n' +
        '      "category_id": "cat_123",\n' +
        '      "new_name": "2-4 word category name",\n' +
        '      "old_name_alias": "previous name",\n' +
        '      "confidence": 0.0,\n' +
        '      "reason": "specific evidence from category meaning"\n' +
        '    }\n' +
        '  ],\n' +
        '  "aliases": [\n' +
        '    {\n' +
        '      "category_id": "cat_123",\n' +
        '      "alias": "search phrase",\n' +
        '      "confidence": 0.0,\n' +
        '      "reason": "why this helps search"\n' +
        '    }\n' +
        '  ],\n' +
        '  "merges": [\n' +
        '    {\n' +
        '      "category_ids": ["cat_123", "cat_456"],\n' +
        '      "proposed_name": "merged category name",\n' +
        '      "confidence": 0.0,\n' +
        '      "reason": "strong repeated overlap evidence"\n' +
        '    }\n' +
        '  ],\n' +
        '  "splits": [\n' +
        '    {\n' +
        '      "category_id": "cat_123",\n' +
        '      "proposed_names": ["child topic one", "child topic two"],\n' +
        '      "confidence": 0.0,\n' +
        '      "reason": "strong repeated subcluster evidence"\n' +
        '    }\n' +
        '  ]\n' +
        '}\n\n' +
        'Rules:\n' +
        '- Be conservative.\n' +
        '- Prefer aliases over renames unless the current name is clearly stale.\n' +
        '- Never rename for casing, punctuation, pluralization, word order, or other cosmetic cleanup.\n' +
        '- Do not propose a rename for frozen_name categories.\n' +
        '- Do not merge/split without strong repeated evidence.\n' +
        '- Merge/split proposals are advisory only; application code will defer them.\n\n' +
        `Inputs:\n${JSON.stringify(input || {}, null, 2)}`,
      );
    },
    async generateVideoTagSuggestions(input, { imagePath } = {}) {
      if (!imagePath) throw new Error('Video tag suggestions require a contact sheet or poster image');
      return codexJsonImpl(
        config,
        imagePath,
        'Analyze this visual evidence from one saved video and suggest specific tags.\n\n' +
        'Return JSON only:\n' +
        '{\n' +
        '  "tags": [\n' +
        '    {\n' +
        '      "name": "concise normalized tag",\n' +
        '      "confidence": "high",\n' +
        '      "evidence": ["visual", "post_context"],\n' +
        '      "conflict": false\n' +
        '    }\n' +
        '  ],\n' +
        '  "warnings": []\n' +
        '}\n\n' +
        'Rules:\n' +
        '- Return at most 6 tags.\n' +
        '- Return only high-confidence tags supported by visual evidence.\n' +
        '- Evidence values may only be "visual" or "post_context".\n' +
        '- Include "visual" in evidence for every returned tag.\n' +
        '- Use post context only when it agrees with the visual evidence.\n' +
        '- Mark conflict true and omit the tag when text and visual evidence conflict.\n' +
        '- Never infer a tag from text alone.\n' +
        '- Do not repeat accepted tags listed in Inputs.context.acceptedTags.\n' +
        '- Use plain words or hyphenated phrases; never return internal names, control characters, or punctuation-only names.\n' +
        '- Avoid generic tags such as video, clip, bookmark, image, design, or content.\n\n' +
        `Inputs:\n${JSON.stringify(input || {}, null, 2)}`,
      );
    },
    async embedText() {
      const err = new Error('Codex provider does not expose embeddings. Use GATHERLOCAL_AI_PROVIDER=local with a local embedding model.');
      err.code = 'embeddings_unavailable';
      throw err;
    },
    async generateImage() {
      const err = new Error('Codex provider does not expose image generation bytes. Use a local image model integration.');
      err.code = 'image_generation_unavailable';
      throw err;
    },
    async getUsage() {
      return null;
    },
  };
}

module.exports = {
  createCodexProvider,
  codexAvailable,
  extractJsonObject,
};
