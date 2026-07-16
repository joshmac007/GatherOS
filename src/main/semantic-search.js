'use strict';

const { parseSearchQuery } = require('./searchQuery');
const { validateVector } = require('./smart-category-vectors');

const MIN_SEARCH_SCORE = 0.26;
const RELATIVE_SEARCH_CUTOFF = 0.72;
const MIN_SIMILAR_SCORE = 0.30;

function vectorArray(value, dimension) {
  let vector;
  if (Buffer.isBuffer(value)) {
    if (value.byteLength !== dimension * Float32Array.BYTES_PER_ELEMENT) throw new Error('Semantic vector dimension mismatch');
    vector = Array.from({ length: dimension }, (_, index) => value.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT));
  } else if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    vector = Array.from(value);
  } else {
    throw new Error('Semantic vector payload is invalid');
  }
  return validateVector(vector, dimension);
}

function cosineSimilarity(left, right) {
  if (!left || !right || left.length !== right.length) throw new Error('Semantic vector dimension mismatch');
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('Semantic vector contains non-finite values');
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (!leftNorm || !rightNorm) throw new Error('Semantic vector norm is zero');
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function structuralSearch(rawSearch) {
  const tokens = String(rawSearch || '').match(/(\w+:"[^"]*"|\w+:\S+|\S+)/g) || [];
  return tokens.filter((token) => /^\w+:/.test(token)).join(' ');
}

function createSemanticSearch({ repository, embeddingProvider } = {}) {
  if (!repository || typeof repository !== 'object') throw new TypeError('Semantic search requires a repository');
  if (typeof embeddingProvider?.embed !== 'function' || !embeddingProvider.model) {
    throw new TypeError('Semantic search requires an embedding provider with a model');
  }

  function literalFallback(rawSearch, options, reason, error = null) {
    return { results: repository.getAllSaves({ ...options, search: rawSearch }), semanticAvailable: false, fallback: true, reason, error };
  }

  function paletteFallback(saveId, limit, reason) {
    const results = typeof repository.findSimilarByPalette === 'function'
      ? repository.findSimilarByPalette(saveId, limit)
      : [];
    return { results, semanticAvailable: false, fallback: true, reason };
  }

  function activeIdentity() {
    const state = repository.getSemanticIndexState();
    if (!state.active_generation_id) return { ok: false, reason: 'index_unavailable', state };
    const vectors = repository.getActiveSemanticVectors();
    if (!Array.isArray(vectors) || vectors.length === 0) return { ok: false, reason: 'index_empty', state };
    const { dimension, model } = vectors[0];
    const valid = typeof model === 'string' && model
      && Number.isInteger(dimension) && dimension > 0
      && vectors.every((row) => row.generation_id === state.active_generation_id && row.model === model && row.dimension === dimension);
    if (!valid) return { ok: false, reason: 'vector_identity_mismatch', state };
    try { for (const row of vectors) vectorArray(row.vector, dimension); } catch { return { ok: false, reason: 'vector_identity_mismatch', state }; }
    return { ok: true, state, vectors, model, dimension };
  }

  async function search(rawSearch, options = {}) {
    const input = String(rawSearch || '').trim();
    const query = parseSearchQuery(input).text;
    if (!query) {
      return { results: repository.getAllSaves({ ...options, search: input }), semanticAvailable: false, fallback: false, reason: 'no_semantic_query' };
    }
    const identity = activeIdentity();
    if (!identity.ok) return literalFallback(input, options, identity.reason);
    if (identity.model !== embeddingProvider.model) return literalFallback(input, options, 'active_model_unavailable');
    let queryVector;
    try {
      const result = await embeddingProvider.embed({ text: query, expectedDimension: identity.dimension });
      queryVector = validateVector(result?.vector, identity.dimension);
    } catch (error) {
      return literalFallback(input, options, error?.code || 'query_embedding_unavailable', error);
    }
    const scored = identity.vectors.map((row) => ({
      id: row.save_id,
      score: cosineSimilarity(queryVector, vectorArray(row.vector, identity.dimension)),
    })).filter((row) => row.score >= MIN_SEARCH_SCORE)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const relativeFloor = scored.length ? scored[0].score * RELATIVE_SEARCH_CUTOFF : Infinity;
    const semanticIds = scored.filter((row) => row.score >= relativeFloor).slice(0, 80).map((row) => row.id);
    const byId = new Map(repository.getSavesByIds(semanticIds).map((row) => [row.id, row]));
    const ranked = semanticIds.map((id) => byId.get(id)).filter(Boolean);
    const literal = repository.getAllSaves({ ...options, search: input });
    const allowedIds = new Set(repository.getAllSaves({ ...options, search: structuralSearch(input) }).map((row) => row.id));
    const seen = new Set();
    const results = [];
    for (const row of [...ranked, ...literal]) {
      if (!allowedIds.has(row.id) || seen.has(row.id)) continue;
      seen.add(row.id);
      results.push(row);
    }
    return { results, semanticAvailable: true, fallback: false, reason: null };
  }

  function findSimilar(saveId, { limit = 24 } = {}) {
    const cap = Math.max(1, Math.min(Number(limit) || 24, 60));
    const identity = activeIdentity();
    if (!identity.ok) return paletteFallback(saveId, cap, identity.reason);
    if (identity.model !== embeddingProvider.model) return paletteFallback(saveId, cap, 'active_model_unavailable');
    const anchor = repository.getSemanticVector(saveId);
    if (!anchor || anchor.generation_id !== identity.state.active_generation_id || anchor.model !== identity.model || anchor.dimension !== identity.dimension) {
      return paletteFallback(saveId, cap, 'anchor_not_indexed');
    }
    let anchorVector;
    try { anchorVector = vectorArray(anchor.vector, identity.dimension); } catch { return paletteFallback(saveId, cap, 'anchor_vector_invalid'); }
    const scored = identity.vectors.filter((row) => row.save_id !== saveId).map((row) => ({
      id: row.save_id,
      score: cosineSimilarity(anchorVector, vectorArray(row.vector, identity.dimension)),
    })).filter((row) => row.score >= MIN_SIMILAR_SCORE)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, cap);
    const ids = scored.map((row) => row.id);
    const byId = new Map(repository.getSavesByIds(ids).filter((row) => !row.deleted_at).map((row) => [row.id, row]));
    return { results: ids.map((id) => byId.get(id)).filter(Boolean), semanticAvailable: true, fallback: false, reason: null };
  }

  return { search, findSimilar };
}

module.exports = { createSemanticSearch, cosineSimilarity };
