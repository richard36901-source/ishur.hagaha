import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInboundReply } from '../whatsapp.js';

const t = (text) => parseInboundReply({ type: 'text', text: { body: text } });

test('bare "טעות" is a wrong number', () => {
  assert.equal(t('טעות').kind, 'mistake');
  assert.equal(t('הגיע בטעות').kind, 'mistake');
  assert.equal(t('טעות, לא מכיר').kind, 'mistake');
});

test('"טעות" followed by a correction is NOT a wrong number (02/11)', () => {
  assert.notEqual(t('טעות 2 מגיעים').kind, 'mistake');
  assert.notEqual(t('טעות, 3').kind, 'mistake');
  assert.notEqual(t('טעות - לא מגיעים').kind, 'mistake');
  assert.notEqual(t('זו טעות, כן מגיעים').kind, 'mistake');
});
