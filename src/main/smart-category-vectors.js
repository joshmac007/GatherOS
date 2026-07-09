function toFloat32Array(value) {
  if (!value) return null;
  if (value instanceof Float32Array) return new Float32Array(value);
  if (Buffer.isBuffer(value)) {
    if (value.byteLength === 0 || value.byteLength % 4 !== 0) return null;
    return new Float32Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (Array.isArray(value)) {
    const nums = value.map(Number);
    if (nums.length === 0 || nums.some((n) => !Number.isFinite(n))) return null;
    return new Float32Array(nums);
  }
  return null;
}

function vectorToBuffer(value) {
  const vec = toFloat32Array(value);
  if (!vec) return null;
  return Buffer.from(vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength));
}

function bufferToVector(value) {
  return toFloat32Array(value);
}

function normalizeVector(value) {
  const vec = toFloat32Array(value);
  if (!vec) return null;
  let norm = 0;
  for (let i = 0; i < vec.length; i += 1) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (!norm) return null;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i += 1) out[i] = vec[i] / norm;
  return out;
}

function cosineSimilarity(a, b) {
  const va = normalizeVector(a);
  const vb = normalizeVector(b);
  if (!va || !vb || va.length !== vb.length) return null;
  let score = 0;
  for (let i = 0; i < va.length; i += 1) score += va[i] * vb[i];
  return score;
}

function meanEmbedding(vectors = []) {
  const normalized = vectors.map(normalizeVector).filter(Boolean);
  if (normalized.length === 0) return null;
  const dim = normalized[0].length;
  if (!dim || normalized.some((vec) => vec.length !== dim)) return null;
  const sum = new Float32Array(dim);
  for (const vec of normalized) {
    for (let i = 0; i < dim; i += 1) sum[i] += vec[i];
  }
  for (let i = 0; i < dim; i += 1) sum[i] /= normalized.length;
  return normalizeVector(sum);
}

module.exports = {
  vectorToBuffer,
  bufferToVector,
  normalizeVector,
  cosineSimilarity,
  meanEmbedding,
};
