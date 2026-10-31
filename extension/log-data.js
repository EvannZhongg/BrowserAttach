export const clip = (value, limit = 2000) => {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit - 13)}…[truncated]` : text;
};

// Credential names commonly carry vendor prefixes and mixed separators/casing.
const SECRET = /(?:authorization|cookie|password|passwd|token|secret|apikey|csrf|xsrf)$/;
const sensitiveName = name => SECRET.test(name.replace(/[^a-z0-9]/gi, '').toLowerCase());
export function redactHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).slice(0, 200).map(([key, value]) => [key, sensitiveName(key) ? '[REDACTED]' : clip(value, 2000)]));
}
export function boundedBody(body, maxBytes) {
  let text = String(body ?? ''), format = 'text';
  function scrub(value, depth = 0) {
    if (depth > 16) return '[DEPTH LIMIT]';
    if (Array.isArray(value)) return value.map(item => scrub(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitiveName(key) ? '[REDACTED]' : scrub(item, depth + 1)]));
    return value;
  }
  try { text = JSON.stringify(scrub(JSON.parse(text))); format = 'json'; }
  catch {
    if (/^[^=\s&]+=/.test(text)) {
      const params = new URLSearchParams(text);
      for (const key of [...params.keys()]) if (sensitiveName(key)) params.set(key, '[REDACTED]');
      text = params.toString(); format = 'form';
    } else text = text.replace(/\b([a-z][a-z0-9_-]*)[ \t]*:[^\r\n]*/gi,
      (line, name) => sensitiveName(name) ? `${name}: [REDACTED]` : line);
  }
  const bytes = new TextEncoder().encode(text), truncated = bytes.length > maxBytes;
  const output = new TextDecoder().decode(bytes.slice(0, maxBytes), { stream: true });
  return { text: output, format, truncated, bytes: new TextEncoder().encode(output).length };
}
