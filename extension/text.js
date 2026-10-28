import { queryElement, targetOptions } from './locator.js';
import { checkedValue } from './errors.js';

export async function readText(cdp, value, tabId, args) {
  const max = args.max_chars ?? 20000, offset = args.offset ?? 0, mode = args.mode ?? 'visible';
  if (!Number.isInteger(max) || max < 1 || max > 100000) throw new Error('max_chars must be 1..100000');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be 0..9007199254740991');
  if (!['visible', 'text_content', 'value', 'editor'].includes(mode)) throw new Error('read_text mode must be visible, text_content, value or editor');
  if (args.selector != null || args.selector_type != null || args.name != null || args.nth != null) targetOptions(args);
  if (mode === 'value' || mode === 'editor') {
    if (!args.selector) throw new Error(`${mode} requires selector to identify exactly one field/editor`);
  }
  const options = { selector: args.selector, selector_type: args.selector_type, nth: args.nth, mode, offset, max_chars: max };
  const send = (method, params) => cdp(tabId, method, params);
  if (args.node) return await checkedValue(await send('Runtime.callFunctionOn', { objectId: args.node.objectId, returnByValue: true,
    functionDeclaration: `function(args) { return (${extractText.toString()})(args, () => this); }`, arguments: [{ value: options }] }), send, value);
  return await checkedValue(await send('Runtime.evaluate', { returnByValue: true, ...(args.context_id != null ? { contextId: args.context_id } : {}),
    expression: `(${extractText.toString()})(${JSON.stringify(options)},${queryElement.toString()})` }), send, value);
}

export function extractText(args, query) {
  const element = args.selector ? query(args.selector, args.selector_type ?? 'css', args.nth) : document.body;
  let text, source = args.mode, complete = true;
  if (args.mode === 'visible') { text = element?.innerText ?? ''; complete = false; }
  else if (args.mode === 'text_content') { text = element?.textContent ?? ''; complete = false; }
  else if (args.mode === 'value') {
    if (['INPUT', 'TEXTAREA'].includes(element.tagName)) text = element.value;
    else if (element.isContentEditable) { text = element.innerText; complete = false; }
    else throw new Error('value mode requires input, textarea or contenteditable');
  } else {
    const hint = 'Use browser_evaluate with a known site-specific model API to read the editor text. DOM text and proxy textarea values cannot guarantee virtualized editor completeness; DOM presence alone does not expose a model. Do not retry fill on the proxy input or automatically switch to typing/paste.';
    const fail = (detail, reason = 'editor_model_unavailable', matched) => Object.assign(new Error(`${detail} ${hint}`), {
      diagnostics: { reason, ...(matched != null ? { matched } : {}), hint },
    });
    let matches;
    try {
      const api = globalThis.monaco?.editor;
      const editors = typeof api?.getEditors === 'function' ? api.getEditors() : [];
      if (!Array.isArray(editors)) throw new Error('Invalid editor list');
      matches = editors.filter(editor => {
        if (typeof editor?.getDomNode !== 'function') return false;
        const dom = editor.getDomNode();
        return dom && (dom === element || element.contains(dom) || dom.contains(element));
      });
    } catch { throw fail('No supported editor model found: the exposed Monaco editor list could not be read.'); }
    if (matches.length > 1) throw fail('Editor selector matches multiple Monaco editors; scope the selector to one editor.', 'editor_model_ambiguous', matches.length);
    try {
      if (matches.length === 1) {
        const model = typeof matches[0].getModel === 'function' ? matches[0].getModel() : null;
        if (typeof model?.getValue === 'function') { text = model.getValue(); source = 'monaco_model'; }
      } else if (typeof element.CodeMirror?.getValue === 'function') { text = element.CodeMirror.getValue(); source = 'codemirror5_model'; }
    } catch { throw fail('No supported editor model found: the exposed editor model could not be read.'); }
    if (typeof text !== 'string') throw fail('No supported editor model found. Select a container with an exposed Monaco getEditors() model or a CodeMirror 5 instance.');
  }
  const end = Math.min(text.length, args.offset + args.max_chars);
  return { title: document.title, url: location.href, text: text.slice(args.offset, end), returned_chars: Math.max(0, end - args.offset),
    total_chars: text.length, truncated: end < text.length, next_offset: end < text.length ? end : null,
    source, complete_source: complete, scope: 'main_frame' };
}
