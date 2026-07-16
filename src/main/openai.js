'use strict';

// Product-facing AI facade. Existing main-process and IPC callers stay on
// this module; transport, provider selection, and entitlement enforcement
// live behind the capability runtime.

const { getAiRuntime } = require('./ai/bootstrap');
const { CAPABILITIES } = require('./ai/runtime');
const { providerAccess } = require('./gatherlocal/ai/authorization');

function createOpenAiFacade({ runtime = getAiRuntime() } = {}) {
  function hasSession() {
    // Compatibility name: callers use this as "AI can be used", while
    // account-session state remains owned by licensing:has-session.
    return runtime.isConfigured(CAPABILITIES.STRUCTURED_JSON);
  }

  function capabilityAccess(capability) {
    const provider = runtime.providerFor(capability);
    return {
      capability,
      provider,
      configured: runtime.isConfigured(capability),
      ...providerAccess(provider),
    };
  }

  function getAccess() {
    return {
      structuredJson: capabilityAccess(CAPABILITIES.STRUCTURED_JSON),
      embedding: capabilityAccess(CAPABILITIES.EMBEDDING),
      imageGeneration: capabilityAccess(CAPABILITIES.IMAGE_GENERATION),
    };
  }

  async function autoTagImage(filePath, { signal } = {}) {
    const parsed = await runtime.completeJson({
      system:
        'You suggest short, useful tags for visual inspiration. Return JSON only: ' +
        '{"tags": ["tag1", "tag2", ...]}. Provide 3-6 lowercase tags. ' +
        'Use single words or hyphenated phrases. Focus on style, content, ' +
        'mood, or use case. Avoid generic words like "image", "design", "art".',
      input: 'Tag this image.',
      imagePath: filePath,
      maxOutputTokens: 120,
      signal,
    });
    const raw = Array.isArray(parsed?.tags) ? parsed.tags : [];
    return raw
      .filter((tag) => typeof tag === 'string')
      .map((tag) => tag.trim().toLowerCase().replace(/^#+/, ''))
      .filter(Boolean)
      .slice(0, 6);
  }

  async function analyzeImage(filePath, { signal } = {}) {
    const parsed = await runtime.completeJson({
      system:
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
      input: 'Analyze this image.',
      imagePath: filePath,
      maxOutputTokens: 800,
      signal,
    });

    const title = typeof parsed?.title === 'string'
      ? parsed.title.trim().replace(/^["'`]+|["'`]+$/g, '').slice(0, 80)
      : '';
    const description = typeof parsed?.description === 'string'
      ? parsed.description.trim().replace(/^["'`]+|["'`]+$/g, '').slice(0, 600)
      : '';
    const text = typeof parsed?.text === 'string'
      ? parsed.text.trim().slice(0, 4000)
      : '';
    return {
      title: title || null,
      description: description || null,
      text: text || null,
    };
  }

  async function generateImagePrompt(filePath, { signal } = {}) {
    const parsed = await runtime.completeJson({
      system:
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
      input: 'Write a prompt that recreates this image.',
      imagePath: filePath,
      maxOutputTokens: 280,
      signal,
    });
    const prompt = typeof parsed?.prompt === 'string'
      ? parsed.prompt.trim().replace(/^["'`]+|["'`]+$/g, '')
      : '';
    return prompt || null;
  }

  async function embedText(text, { expectedDimension = null, signal } = {}) {
    const trimmed = (text || '').trim();
    if (!trimmed) throw new Error('Cannot embed empty text');
    const result = await runtime.embed({
      text: trimmed.slice(0, 8000),
      expectedDimension,
      signal,
    });
    return result.vector;
  }

  async function getUsage({ signal } = {}) {
    return runtime.getUsage(CAPABILITIES.STRUCTURED_JSON, { signal });
  }

  return {
    hasSession,
    getAccess,
    autoTagImage,
    analyzeImage,
    generateImagePrompt,
    embedText,
    getUsage,
  };
}

const facade = createOpenAiFacade();

module.exports = {
  ...facade,
  createOpenAiFacade,
};
