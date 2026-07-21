'use strict';

const Ajv = require('ajv');

const IMAGE_ANALYSIS_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', maxLength: 80 },
    description: { type: 'string', maxLength: 600 },
    text: { type: 'string', maxLength: 4000 },
  },
  required: ['title', 'description', 'text'],
});

const IMAGE_PROMPT_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: { prompt: { type: 'string', minLength: 1, maxLength: 1200 } },
  required: ['prompt'],
});

function createSchemaRegistry({ AjvImpl = Ajv } = {}) {
  const ajv = new AjvImpl({ allErrors: true, strict: true, allowUnionTypes: true });
  const compiled = new WeakMap();

  function validator(schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      throw new TypeError('Structured JSON request requires outputSchema');
    }
    let validate = compiled.get(schema);
    if (!validate) {
      validate = ajv.compile(schema);
      compiled.set(schema, validate);
    }
    return validate;
  }

  return {
    validate(schema, value) {
      const validate = validator(schema);
      return {
        ok: Boolean(validate(value)),
        errors: (validate.errors || []).map(({ keyword, instancePath, message }) => ({
          keyword,
          instancePath,
          message,
        })),
      };
    },
    validator,
  };
}

const defaultSchemaRegistry = createSchemaRegistry();

module.exports = {
  IMAGE_ANALYSIS_OUTPUT_SCHEMA,
  IMAGE_PROMPT_OUTPUT_SCHEMA,
  createSchemaRegistry,
  defaultSchemaRegistry,
};
