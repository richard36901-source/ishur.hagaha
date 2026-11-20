// node --test worker/test/fcm.test.mjs — Android push through FCM HTTP v1 (fcm.js). Google is stubbed.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../fcm.js';

let keys, env, calls;
const pem = der => '-----BEGIN PRIVATE KEY-----\n' + Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END PRIVATE KEY-----\n';
beforeEach(async () => {
  F.resetFcmCache(); calls = [];
  keys = keys || await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  env = { FCM_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'ishur-test', client_email: 'push@ishur-test.iam.gserviceaccount.com', private_key: pem(await crypto.subtle.exportKey('pkcs8', keys.privateKey)) }) };
});
const google = (send = { status: 200, json: { name: 'projects/x/messages/1' } }) => async (url, init) => {
  calls.push({ url, init });
  if (/oauth2/.test(url)) return new Response(JSON.stringify({ access_token: 'ya29.test', expires_in: 3599 }), { status: 200 });
  return new Response(JSON.stringify(send.json), { status: send.status });
};
const b64 = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

test('not configured → nothing is sent', async () => {
  assert.deepEqual(await F.sendFcm({}, { device: 't', platform: 'android' }, { title: 'a', body: 'b' }, { fetchFn: google() }), { status: 0, error: 'fcm-not-configured' });
  assert.equal(calls.length, 0);
});
test('the OAuth assertion is a valid RS256 JWT for the FCM scope, and the token is reused', async () => {
  const r = await F.sendFcm(env, { device: 'tok1', platform: 'android' }, { title: 'דנה אישרה', body: '3 מגיעים', data: { token: 'abc', n: 3 } }, { fetchFn: google() });
  assert.deepEqual(r, { status: 200, reason: '' });
  const body = new URLSearchParams(calls[0].init.body); const [h, c, s] = body.get('assertion').split('.');
  assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const claims = JSON.parse(b64(c)); assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging'); assert.equal(claims.aud, 'https://oauth2.googleapis.com/token'); assert.equal(claims.exp - claims.iat, 3600);
  assert.equal(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', keys.publicKey, b64(s), new TextEncoder().encode(h + '.' + c)), true);
  assert.equal(calls[1].url, 'https://fcm.googleapis.com/v1/projects/ishur-test/messages:send');
  assert.equal(calls[1].init.headers.authorization, 'Bearer ya29.test');
  const msg = JSON.parse(calls[1].init.body).message;
  assert.deepEqual(msg, { token: 'tok1', notification: { title: 'דנה אישרה', body: '3 מגיעים' }, data: { token: 'abc', n: '3' }, android: { priority: 'high' } });
  await F.sendFcm(env, { device: 'tok2', platform: 'android' }, { title: 'x', body: 'y' }, { fetchFn: google() });
  assert.equal(calls.filter(x => /oauth2/.test(x.url)).length, 1, 'one token exchange for two sends');
});
test('a device Firebase no longer knows reads as 410 (removed), other errors pass through', async () => {
  const gone = { status: 404, json: { error: { status: 'NOT_FOUND', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } } };
  assert.deepEqual(await F.sendFcm(env, { device: 't' }, { title: 'a', body: 'b' }, { fetchFn: google(gone) }), { status: 410, reason: 'Unregistered' });
  const quota = { status: 429, json: { error: { status: 'RESOURCE_EXHAUSTED', details: [{ errorCode: 'QUOTA_EXCEEDED' }] } } };
  assert.deepEqual(await F.sendFcm(env, { device: 't' }, { title: 'a', body: 'b' }, { fetchFn: google(quota) }), { status: 429, reason: 'QUOTA_EXCEEDED' });
});
