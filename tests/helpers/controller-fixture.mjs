import { createController } from '../../extension/controller.js';

function event() { const callbacks = []; return { addListener(fn) { callbacks.push(fn); }, emit(...args) { for (const fn of callbacks) fn(...args); } }; }
export function fixture() {
  const calls = [];
  const notices = [];
  const tabs = new Map([[9, { id: 9, windowId: 1, groupId: -1, title: 'Demo', url: 'http://localhost:8000/', active: true }]]);
  const groups = new Map();
  let groupSerial = 100;
  let stored = {};
  let blocked = false;
  let modalOnClick = false;
  let customNodes;
  const axTrees = [];
  let binding;
  let fileCount = 0;
  const api = { extension: { isAllowedFileSchemeAccess: async () => true },
    storage: { session: { get: async () => structuredClone(stored), set: async value => { stored = structuredClone(value); } } },
    tabGroups: { get: async id => { if (!groups.has(id)) throw new Error('Unknown group'); return groups.get(id); },
      update: async (id, args) => { Object.assign(groups.get(id), args); calls.push({ method: 'tabGroups.update', id, args }); } },
    action: {
      setBadgeText: async args => { calls.push({ method: 'badge', args }); },
      setBadgeBackgroundColor: async () => {}, setTitle: async () => {},
    }, tabs: { get: async id => tabs.get(id), query: async () => [...tabs.values()], onRemoved: event(), onUpdated: event(),
      create: async args => { calls.push({ method: 'tabs.create', args }); const tab = { id: 10, windowId: 1, title: '', ...args }; tabs.set(tab.id, tab); return tab; },
      update: async (id, args) => { calls.push({ method: 'tabs.update', id, args }); Object.assign(tabs.get(id), args); return tabs.get(id); },
      remove: async id => { calls.push({ method: 'tabs.remove', id }); tabs.delete(id); api.tabs.onRemoved.emit(id); },
      group: async ({ tabIds, groupId = ++groupSerial }) => { for (const id of tabIds) tabs.get(id).groupId = groupId;
        if (!groups.has(groupId)) groups.set(groupId, { id: groupId, windowId: 1 });
        calls.push({ method: 'tabs.group', tabIds, groupId }); return groupId; },
      ungroup: async id => { if (tabs.has(id)) tabs.get(id).groupId = -1; calls.push({ method: 'tabs.ungroup', id }); },
    }, windows: { get: async id => ({ id, focused: true, state: 'normal' }), update: async (id, args) => { calls.push({ method: 'windows.update', id, args }); } },
    debugger: { onDetach: event(), onEvent: event(),
      attach: async (target, version) => { calls.push({ method: 'attach', target, version }); },
      detach: async target => { calls.push({ method: 'detach', target }); api.debugger.onDetach.emit(target); },
      sendCommand: async (target, method, args) => {
        calls.push({ method, args, target });
        if (method === 'Runtime.addBinding') binding = args.name;
        if (method === 'Input.dispatchKeyEvent' && ['rawKeyDown', 'keyDown'].includes(args.type)) {
          api.debugger.onEvent.emit(target, 'Runtime.bindingCalled', { name: binding, executionContextId: 42, payload: '{"delivered":true}' });
        }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 };
        if (method === 'Page.navigate') {
          tabs.get(target.tabId).url = args.url; tabs.get(target.tabId).title = 'Destination';
          api.debugger.onEvent.emit(target, 'Page.frameNavigated', { frame: { id: 'main' } });
          api.debugger.onEvent.emit(target, 'Page.lifecycleEvent', { frameId: 'main', loaderId: 'new', name: 'DOMContentLoaded' });
          api.debugger.onEvent.emit(target, 'Page.lifecycleEvent', { frameId: 'main', loaderId: 'new', name: 'load' });
          return { frameId: 'main', loaderId: 'new' };
        }
        if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased' && !modalOnClick) {
          api.debugger.onEvent.emit(target, 'Runtime.bindingCalled', { name: binding, executionContextId: 42, payload: JSON.stringify({ matched: true }) });
        }
        if (modalOnClick && method === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased') {
          api.debugger.onEvent.emit(target, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Modal' });
          return await new Promise(() => {});
        }
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', url: tabs.get(9).url } } };
        if (method === 'Accessibility.getFullAXTree' && args.frameId === 'remote') throw new Error('Frame is in another process');
        if (method === 'Accessibility.getPartialAXTree') return { nodes: axTrees.filter(tree => tree.sessionId === target.sessionId).flatMap(tree => tree.result.nodes).filter(node => node.backendDOMNodeId === args.backendNodeId).slice(-1) };
        if (method === 'Accessibility.getFullAXTree') { const result = { nodes: customNodes || [
          { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Demo' }, childIds: ['2', '3'] },
          { nodeId: '2', backendDOMNodeId: 12, role: { value: 'button' }, name: { value: 'Submit' } },
          { nodeId: '3', backendDOMNodeId: 13, role: { value: 'textbox' }, name: { value: 'Name' } },
        ] }; axTrees.push({ sessionId: target.sessionId, result }); return result; }
        if (method === 'Runtime.evaluate' && args.expression.startsWith('(function queryElement')) return { result: { objectId: 'selector-node' } };
        if (method === 'DOM.describeNode' && args.objectId === 'selector-node') return { node: { backendNodeId: 12 } };
        if (method === 'DOM.describeNode' && args.objectId === 'focused') return { node: {} };
        if (method === 'Runtime.evaluate' && args.expression.includes('function activeElement')) return { result: { objectId: 'focused' } };
        if (method === 'DOM.describeNode') return { node: { frameId: 'remote', attributes: ['src', 'https://frame.test/'] } };
        if (method === 'DOM.resolveNode') return { object: { objectId: `object-${args.backendNodeId}` } };
        if (method === 'DOM.getContentQuads') return { quads: [[10, 10, 100, 10, 100, 50, 10, 50]] };
        if (method === 'DOM.getNodeForLocation') return { backendNodeId: 12, frameId: 'main' };
        if (method === 'DOM.setFileInputFiles') fileCount = args.files.length;
        if (method === 'Runtime.evaluate' && args.expression.includes('function installKeyReceipt')) return { result: { objectId: 'key-guard' } };
        if (method === 'Runtime.evaluate' && args.expression.includes('visibility_state: document.visibilityState')) return { result: { value: { visibility_state: 'visible', has_focus: true } } };
        if (method === 'Runtime.evaluate' && args.expression.includes('title: document.title')) return { result: { value: { title: tabs.get(9).title, url: tabs.get(9).url } } };
        if (method === 'Runtime.evaluate') return { result: { value: { width: 1024, height: 768, scroll_x: 0, scroll_y: 0, device_pixel_ratio: 1 } } };
        if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function installGuard')) return { result: { objectId: 'guard' } };
        if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function inspectTarget')) return { result: { value: { ready: true, x: 10, y: 10, width: 90, height: 40 } } };
        if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('function hitRelation')) return { result: { value: blocked ? null : 'same_node' } };
        if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes("input.type !== 'file'")) return { result: { objectId: 'file-input' } };
        if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes("this.value = '';")) fileCount = 0;
        if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('this.files?.length')) return { result: { value: fileCount } };
        if (method === 'Runtime.callFunctionOn') return { result: { value: !blocked } };
        if (method === 'Page.getLayoutMetrics') return { cssContentSize: { width: 1024, height: 1800 } };
        if (method === 'Page.captureScreenshot') return { data: 'image-data' };
        return {};
      } } };
  const controller = createController(api, data => notices.push(data));
  const exec = (command, args = {}, owner = 'one') => controller.execute(owner, command, { tab_id: 9, tab_handle: 'handle-one', ...args });
  const claim = () => exec('claim_tab', { expected_title: 'Demo', expected_url: 'http://localhost:8000/' });
  const ref = snapshot => snapshot.snapshot.match(/\[([^\]]+)\] button/)[1];
  return { controller, exec, claim, ref, calls, api, notices, tabs, block: () => { blocked = true; }, modal: () => { modalOnClick = true; }, nodes: value => { customNodes = value; } };
}
export function withChildFrames(f) {
  const send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    const result = await send(target, method, args);
    if (method === 'Page.getFrameTree') result.frameTree.childFrames = [{
      frame: { id: 'ad', parentId: 'main', url: 'http://localhost:8000/ad' },
      childFrames: [{ frame: { id: 'nested', parentId: 'ad', url: 'http://localhost:8000/nested' } }],
    }];
    if (method === 'Accessibility.getFullAXTree' && args.frameId !== 'main') result.nodes = [
      { nodeId: args.frameId, backendDOMNodeId: args.frameId === 'ad' ? 70 : 71,
        role: { value: 'button' }, name: { value: args.frameId } },
    ];
    return result;
  };
}

export function fetchFixture() {
  const f = fixture(), send = f.api.debugger.sendCommand;
  f.api.debugger.sendCommand = async (target, method, args) => {
    if (method === 'Page.navigate') {
      const result = await send(target, method, args);
      f.api.debugger.onEvent.emit(target, 'Network.responseReceived', { requestId: 'document', type: 'Document', frameId: 'main', loaderId: 'new', response: { status: 200, url: args.url } });
      f.api.debugger.onEvent.emit(target, 'Page.frameNavigated', { frame: { id: 'main', loaderId: 'new', url: args.url } });
      return result;
    }
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'new', url: f.tabs.get(target.tabId).url } } };
    if (method === 'Runtime.evaluate' && args.expression.startsWith('(function capturePage')) {
      f.calls.push({ method: 'capture', target, args });
      return { result: { value: { url: f.tabs.get(target.tabId).url, title: 'Fetched', contentType: 'text/html', body: 'abcdef', ready_state: 'complete', body_source: 'rendered_document', capture_truncated: false } } };
    }
    return send(target, method, args);
  };
  return f;
}
