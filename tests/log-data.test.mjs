import test from 'node:test';
import assert from 'node:assert/strict';
import { redactHeaders, boundedBody } from '../extension/log-data.js';

test('credential names redact vendor prefixes, separators and casing across headers and structured bodies', () => {
  const keys = ['Authorization', 'Proxy-Authorization', 'Cookie', 'Set-Cookie', 'password', 'passwd', 'access_token', 'refreshToken',
    'x-csrf-token', 'csrf_token', 'lark_oapi_csrf_token', 'X-XSRF-TOKEN', 'csrf', 'xsrf', 'x-api-key', 'apiKey', 'client_secret', 'X-Auth-Token'];
  const secrets = Object.fromEntries(keys.map(key => [key, 'synthetic-secret']));
  const safe = { 'X-Request-Id': 'request', tokenizer_count: 10, token_count: 20, token_type: 'Bearer', field: 'kept' };
  const headers = redactHeaders({ ...secrets, ...safe });
  for (const key of keys) assert.equal(headers[key], '[REDACTED]', key);
  assert.equal(headers['X-Request-Id'], 'request'); assert.equal(headers.token_count, '20');
  const json = JSON.parse(boundedBody(JSON.stringify({ rows: [{ ...secrets, ...safe }] }), 10000).text);
  for (const key of keys) assert.equal(json.rows[0][key], '[REDACTED]', key);
  for (const [key, value] of Object.entries(safe)) assert.equal(json.rows[0][key], value);
  const form = new URLSearchParams(boundedBody(new URLSearchParams({ ...secrets, field: 'kept' }).toString(), 10000).text);
  for (const key of keys) assert.equal(form.get(key), '[REDACTED]', key);
  assert.equal(form.get('field'), 'kept');
});

test('plain header text scrubs compound credentials before truncation while preserving ordinary lines', () => {
  const result = boundedBody('X-CSRF-Token: synthetic-secret\r\nX-API-Key: another-secret\nX-Request-Id: kept\nCookie: session=hidden', 1024);
  assert.doesNotMatch(result.text, /synthetic-secret|another-secret|session=hidden/);
  assert.match(result.text, /X-Request-Id: kept/);
  assert.equal(result.format, 'text');
  const bounded = boundedBody(JSON.stringify({ csrfToken: 's'.repeat(5000), field: '中'.repeat(500) }), 1024);
  assert.equal(bounded.truncated, true); assert.ok(bounded.bytes <= 1024); assert.doesNotMatch(bounded.text, /sss|�/);
});
