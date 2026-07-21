'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  IMAGE_ANALYSIS_OUTPUT_SCHEMA,
  IMAGE_PROMPT_OUTPUT_SCHEMA,
  createSchemaRegistry,
} = require('../src/main/gatherlocal/ai/schema-registry');
const { TOPIC_PROFILE_OUTPUT_SCHEMA } = require('../src/main/save-topic-profiles');
const { SMART_CATEGORY_DISCOVERY_OUTPUT_SCHEMA } = require('../src/main/smart-category-discovery');
const { SMART_CATEGORY_MEMBERSHIP_OUTPUT_SCHEMA } = require('../src/main/smart-category-memberships');
const { SMART_CATEGORY_TAXONOMY_OUTPUT_SCHEMA } = require('../src/main/smart-category-taxonomy-refresh');
const { VIDEO_SUGGESTIONS_OUTPUT_SCHEMA } = require('../src/main/video-analysis');

test('schema registry rejects unknown keywords in strict mode', () => {
  const registry = createSchemaRegistry();
  assert.throws(() => registry.validator({
    type: 'object', additionalProperties: false, typoKeyword: true, properties: {}, required: [],
  }), /strict mode: unknown keyword/);
});

test('Writer B image schemas are strict and pre-compilable', () => {
  const registry = createSchemaRegistry();
  assert.equal(typeof registry.validator(IMAGE_ANALYSIS_OUTPUT_SCHEMA), 'function');
  assert.equal(typeof registry.validator(IMAGE_PROMPT_OUTPUT_SCHEMA), 'function');
});

test('all owned production completeJson schemas compile in strict mode', () => {
  const registry = createSchemaRegistry();
  for (const schema of [
    TOPIC_PROFILE_OUTPUT_SCHEMA,
    SMART_CATEGORY_DISCOVERY_OUTPUT_SCHEMA,
    SMART_CATEGORY_MEMBERSHIP_OUTPUT_SCHEMA,
    SMART_CATEGORY_TAXONOMY_OUTPUT_SCHEMA,
    VIDEO_SUGGESTIONS_OUTPUT_SCHEMA,
  ]) assert.equal(typeof registry.validator(schema), 'function');
});

test('schema registry exposes only sanitized Ajv errors', () => {
  const registry = createSchemaRegistry();
  const schema = {
    type: 'object', additionalProperties: false,
    properties: { name: { type: 'string' } }, required: ['name'],
  };
  const result = registry.validate(schema, { secret: 'do-not-echo' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
  for (const error of result.errors) {
    assert.deepEqual(Object.keys(error).sort(), ['instancePath', 'keyword', 'message']);
    assert.doesNotMatch(JSON.stringify(error), /do-not-echo/);
  }
});
