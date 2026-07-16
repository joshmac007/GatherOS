'use strict';

function toFloat32Array(value) {
  if (!value) return null;
  if (value instanceof Float32Array) return new Float32Array(value);
  if (Buffer.isBuffer(value)) {
    if (value.byteLength === 0 || value.byteLength % 4 !== 0) return null;
    const bytes = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    return new Float32Array(bytes);
  }
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    const nums = Array.from(value, Number);
    if (nums.length === 0 || nums.some((number) => !Number.isFinite(number))) return null;
    return new Float32Array(nums);
  }
  return null;
}

function vectorToBuffer(value) {
  const vector = toFloat32Array(value);
  if (!vector) return null;
  return Buffer.from(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

function normalizeVector(value) {
  const vector = toFloat32Array(value);
  if (!vector) return null;
  let norm = 0;
  for (const number of vector) norm += number * number;
  norm = Math.sqrt(norm);
  if (!norm) return null;
  return Float32Array.from(vector, (number) => number / norm);
}

function cosineSimilarity(left, right) {
  const a = normalizeVector(left);
  const b = normalizeVector(right);
  if (!a || !b || a.length !== b.length) return null;
  let score = 0;
  for (let index = 0; index < a.length; index += 1) score += a[index] * b[index];
  return score;
}

function meanEmbedding(vectors = []) {
  const normalized = vectors.map(normalizeVector).filter(Boolean);
  if (normalized.length === 0) return null;
  const dimension = normalized[0].length;
  if (!dimension || normalized.some((vector) => vector.length !== dimension)) return null;
  const sum = new Float32Array(dimension);
  for (const vector of normalized) {
    for (let index = 0; index < dimension; index += 1) sum[index] += vector[index];
  }
  for (let index = 0; index < dimension; index += 1) sum[index] /= normalized.length;
  return normalizeVector(sum);
}

function validateVector(value, expectedDimension = null) {
  const vector = toFloat32Array(value);
  if (!vector || vector.length === 0) throw new TypeError('Embedding vector is invalid');
  if (expectedDimension != null && vector.length !== expectedDimension) {
    throw new TypeError('Embedding vector dimension mismatch');
  }
  return Array.from(vector);
}

module.exports = {
  toFloat32Array,
  vectorToBuffer,
  bufferToVector: toFloat32Array,
  normalizeVector,
  cosineSimilarity,
  meanEmbedding,
  validateVector,
};
