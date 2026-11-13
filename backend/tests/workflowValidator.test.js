'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { validateDefinition } = require('../src/utils/workflowValidator');

const dir = path.join(__dirname, '..', 'config', 'workflows');
const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));

test.each(files)('%s is a valid workflow definition', (file) => {
  expect(validateDefinition(yaml.load(fs.readFileSync(path.join(dir, file), 'utf8')))).toEqual([]);
});

test('catches unknown stages, services and bad expressions', () => {
  const def = {
    workflow: 'x', version: 1, schema: { type: 'object' }, start: 'a',
    stages: {
      a: { type: 'rules', rules: [{ id: 'r', expr: 'a +', on_fail: 'ghost' }], next: 'b' },
      b: { type: 'external_call', service: 'nope', next: 'c', on_exhausted: 'c' },
      c: { type: 'terminal', outcome: 'APPROVED' },
    },
  };
  const errors = validateDefinition(def).join(' | ');
  expect(errors).toMatch(/ghost/);
  expect(errors).toMatch(/unknown service/);
  expect(errors).toMatch(/Unexpected/);
});
