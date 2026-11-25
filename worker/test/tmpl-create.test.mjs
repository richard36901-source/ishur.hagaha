import test from 'node:test';
import assert from 'node:assert/strict';
import { templatePayload } from '../tmpl-create.js';
test('template payload: name, variables and examples are checked before Meta sees it', () => {
  const ok = templatePayload({ name: 'noa_tried_reach', category: 'utility', body: 'היי {{1}}, ניסינו להשיג אותך', example: ['דנה'] });
  assert.deepEqual(ok.payload, { name: 'noa_tried_reach', category: 'UTILITY', language: 'he', components: [{ type: 'BODY', text: 'היי {{1}}, ניסינו להשיג אותך', example: { body_text: [['דנה']] } }] });
  assert.equal(templatePayload({ name: 'Bad Name', body: 'x' }).error, 'bad-name');
  assert.equal(templatePayload({ name: 'abc', body: 'a {{2}}', example: ['x'] }).error, 'bad-variables');
  assert.equal(templatePayload({ name: 'abc', body: 'a {{1}}', example: [] }).error, 'bad-example');
  assert.equal(templatePayload({ name: 'abc', category: 'AUTH', body: 'a' }).error, 'bad-category');
});
