import test from 'node:test';
import assert from 'node:assert/strict';
import { keyParameters, typeOptions } from '../extension/input.js';

test('type validation distinguishes control keys from length and type errors', () => {
  for (const text of ['a\nb', 'a\n\nb', 'a\rb', 'a\tb']) {
    assert.throws(() => typeOptions({ text }), /printable characters only.*press_key.*Enter.*Tab/);
  }
  assert.throws(() => typeOptions({ text: 3 }), /must be a string/);
  assert.throws(() => typeOptions({ text: 'x'.repeat(10001) }), /at most 10000/);
  typeOptions({ text: 'Hello' });
});

test('function and editing/navigation keys map to native keycodes without text insertion', () => {
  for (let n = 1; n <= 12; n++) {
    const result = keyParameters(`F${n}`);
    assert.equal(result.params.code, `F${n}`);
    assert.equal(result.params.windowsVirtualKeyCode, 111 + n);
    assert.equal(result.text, undefined);
  }
  for (const [key, vk] of Object.entries({ Insert:45, Delete:46, Home:36, End:35, PageUp:33, PageDown:34,
    ArrowLeft:37, ArrowRight:39, ArrowUp:38, ArrowDown:40 })) {
    const result = keyParameters(`Control+${key}`);
    assert.equal(result.params.key, key); assert.equal(result.params.windowsVirtualKeyCode, vk);
    assert.equal(result.params.modifiers, 2); assert.equal(result.text, undefined);
  }
});

test('US punctuation generates the correct key, physical code, Shift mask and text', () => {
  for (const [chord, key, code, mask] of [
    [';', ';', 'Semicolon', 0], [':', ':', 'Semicolon', 8], ['Shift+/', '?', 'Slash', 8],
    ['Shift+1', '!', 'Digit1', 8], ['+', '+', 'Equal', 8], ['Plus', '+', 'Equal', 8],
    ['Control++', '+', 'Equal', 10], ['Control+Shift++', '+', 'Equal', 10],
    ['Control+;', ';', 'Semicolon', 2], ['Control+Shift+;', ':', 'Semicolon', 10],
    ['[', '[', 'BracketLeft', 0], ['}', '}', 'BracketRight', 8], ['\\', '\\', 'Backslash', 0],
    ['|', '|', 'Backslash', 8], ['"', '"', 'Quote', 8], ['~', '~', 'Backquote', 8],
    ['Space', ' ', 'Space', 0], ['Shift+Space', ' ', 'Space', 8], ['Shift+A','A','KeyA',8],
  ]) {
    const result = keyParameters(chord);
    assert.equal(result.params.key, key, chord); assert.equal(result.params.code, code, chord);
    assert.equal(result.params.modifiers, mask, chord);
    assert.equal(result.text, mask & ~8 ? undefined : key, chord);
  }
  assert.equal(keyParameters('Shift+Tab').text, undefined);
  assert.equal(keyParameters('Shift+Enter').text, '\r');
});

test('all ASCII printable characters are accepted; malformed chords fail before dispatch', () => {
  for (let code = 32; code <= 126; code++) assert.ok(keyParameters(String.fromCharCode(code)).params.code);
  for (const key of ['', 'F0', 'F13', 'Control+', 'Control+++', 'Unknown+A', 'constructor', 'é']) {
    assert.throws(() => keyParameters(key), undefined, key);
  }
});
