import { targetOptions } from './locator.js';
import { deadline } from './actionability.js';
import { framePoint } from './pointer.js';

export function createScreenshots(cdp, value, viewport, sessions, clickVisuals, resolveNode) {
  // One bounded mapping per claimed tab; no image bytes or separate DOM history.
  const captures = new Map();
  const sameViewport = (a, b) => ['width', 'height', 'scroll_x', 'scroll_y', 'device_pixel_ratio'].every(key => a[key] === b[key]);
  const failure = (message, reason = 'stale_screenshot') => Object.assign(new Error(`${message}. Take a fresh browser_screenshot. No input was dispatched.`), {
    input_dispatched: false, diagnostics: { reason },
  });
  async function capture(tabId, args) {
    const pending = {};
    captures.set(tabId, pending);
    const view = await viewport(tabId);
    const hasTarget = args.ref != null || args.selector != null;
    if (!hasTarget && (args.frame || args.frame_id || args.nth != null || args.selector_type || args.name != null || args.text_match != null || args.scope != null)) throw new Error('Element screenshot frame/nth/type/name requires an element selector');
    if (hasTarget && args.full_page) throw new Error('Element target and full_page are mutually exclusive');
    const clip = hasTarget ? await elementClip(tabId, args, view) : args.full_page ? await fullPageClip(tabId) : null;
    const includeIndicators = args.include_indicators === true;
    const hiddenError = includeIndicators ? null : await clickVisuals.visible(tabId, false);
    if (hiddenError) throw new Error(`Could not hide click feedback for a clean screenshot: ${hiddenError}`);
    try {
      // Render an explicit target surface without activating its tab or window.
      const captureClip = clip || { x: view.scroll_x, y: view.scroll_y, width: view.width, height: view.height, scale: 1 };
      let timer;
      let result;
      try {
        result = await Promise.race([
          cdp(tabId, 'Page.captureScreenshot', { format: 'png', fromSurface: true,
            captureBeyondViewport: true, optimizeForSpeed: true, clip: captureClip }),
          new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(
            'Screenshot did not finish within 5 seconds. An inactive or occluded Chromium page may not render. Use browser_tab_control action=activate before requesting another screenshot, or use DOM/AX.'
          )), 5000); }),
        ]);
      } finally { clearTimeout(timer); }
      if (captures.get(tabId) !== pending || !sameViewport(view, await viewport(tabId))) throw failure('Screenshot source or viewport changed during capture');
      const image = pngSize(result.data);
      const metadata = { screenshot_id: crypto.randomUUID(), scope: hasTarget ? 'element' : clip ? 'full_page' : 'viewport', viewport: view,
        css_width: clip?.width ?? view.width, css_height: clip?.height ?? view.height,
        image_origin_css: { x: clip?.x ?? view.scroll_x, y: clip?.y ?? view.scroll_y },
        click_coordinate_space: 'viewport_css_pixels', agent_indicators_included: includeIndicators, image };
      metadata.image_to_viewport_css = { scale_x: metadata.css_width / image.width, scale_y: metadata.css_height / image.height,
        offset_x: metadata.image_origin_css.x - view.scroll_x, offset_y: metadata.image_origin_css.y - view.scroll_y };
      // Viewport reads can yield to navigation/detach. Never resurrect a mapping.
      if (captures.get(tabId) !== pending) throw failure('Screenshot source changed during capture');
      captures.set(tabId, metadata);
      return { ...result, capture: metadata };
    } finally { await clickVisuals.visible(tabId, true); }
  }

  async function elementClip(tabId, args, view) {
    targetOptions(args);
    const budget = deadline(5000);
    const node = await resolveNode(tabId, args, budget);
    const { model } = await budget.run(() => cdp(node.target, 'DOM.getBoxModel', { backendNodeId: node.backendNodeId }));
    if (!model?.border) throw new Error('Element has no rendered box');
    let points = Array.from({ length: 4 }, (_, i) => ({ x: model.border[i * 2], y: model.border[i * 2 + 1] })), target = node.target;
    while (target.sessionId) {
      const parent = sessions.parent(tabId, target.sessionId);
      const owner = await budget.run(() => cdp(parent.target, 'DOM.getFrameOwner', { frameId: parent.frameId }));
      const box = await budget.run(() => cdp(parent.target, 'DOM.getBoxModel', { backendNodeId: owner.backendNodeId }));
      const childView = await budget.run(() => viewport(target));
      points = points.map(p => framePoint(p, box.model.content, childView));
      target = parent.target;
    }
    const x = Math.min(...points.map(p => p.x)) + view.scroll_x, y = Math.min(...points.map(p => p.y)) + view.scroll_y;
    const width = Math.max(...points.map(p => p.x)) + view.scroll_x - x, height = Math.max(...points.map(p => p.y)) + view.scroll_y - y;
    if (width <= 0 || height <= 0 || width * height > 40000000 || x < 0 || y < 0) throw new Error('Element capture requires a positive box within the document and at most 40 million pixels');
    return { x, y, width, height, scale: 1 };
  }

  async function fullPageClip(tabId) {
    const { cssContentSize } = await cdp(tabId, 'Page.getLayoutMetrics');
    if (cssContentSize.width * cssContentSize.height > 40000000) throw new Error('Full-page capture exceeds 40 million pixels; use viewport capture');
    return { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 };
  }

  function imagePoint(tabId, args, view) {
    const capture = captures.get(tabId);
    if (!capture?.screenshot_id || capture.screenshot_id !== args.screenshot_id) throw failure('Screenshot is stale or belongs to another tab');
    if (!sameViewport(capture.viewport, view)) { captures.delete(tabId); throw failure('Screenshot viewport changed'); }
    if (![args.x, args.y].every(Number.isFinite) || args.x < 0 || args.y < 0 || args.x >= capture.image.width || args.y >= capture.image.height) throw failure('Image coordinates are outside the original PNG', 'image_point_out_of_bounds');
    const map = capture.image_to_viewport_css;
    const point = { x: args.x * map.scale_x + map.offset_x, y: args.y * map.scale_y + map.offset_y };
    if (point.x < 0 || point.y < 0 || point.x >= view.width || point.y >= view.height) throw failure('Image point is outside the current viewport; scroll explicitly and recapture', 'image_point_out_of_viewport');
    return { point, async assertCurrent(budget) {
      const current = await budget.run(() => viewport(tabId));
      if (captures.get(tabId) !== capture) throw failure('Screenshot source changed before input');
      if (!sameViewport(capture.viewport, current)) { captures.delete(tabId); throw failure('Screenshot viewport changed before input'); }
    } };
  }
  return { capture, imagePoint, forget: tabId => captures.delete(tabId) };
}

export function pngSize(data) {
  let header;
  try { header = Uint8Array.from(atob(data.slice(0, 32)), char => char.charCodeAt(0)); }
  catch { throw new Error('Browser returned an invalid PNG'); }
  if (header.length < 24 || ![137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82].every((byte, index) => header[index] === byte)) throw new Error('Browser returned an invalid PNG');
  const view = new DataView(header.buffer), width = view.getUint32(16), height = view.getUint32(20);
  if (!width || !height) throw new Error('Browser returned an invalid PNG size');
  return { width, height, mime_type: 'image/png' };
}
