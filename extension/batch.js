import { targetOptions, frameOptions } from './locator.js';
import { clickOptions } from './click.js';
import { inputMode, fillOptions, keyParameters, selectOptions, typeOptions } from './input.js';
import { scrollOptions } from './scroll.js';
import { waitOptions, actionWaitOptions } from './wait.js';
import { offsetOption } from './motion.js';
import { controlOptions } from './control.js';

export const MAX_BATCH_STEPS = 30;

export function validateSteps(steps, startAt = 0, dialogPolicy = 'ask') {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_BATCH_STEPS) throw new Error(`steps must contain 1..${MAX_BATCH_STEPS} actions`);
  if (!Number.isInteger(startAt) || startAt < 0 || startAt >= steps.length) throw new Error('start_at must be an existing zero-based step index');
  for (const step of steps) {
    if (!step || !['click', 'fill', 'type', 'press_key', 'hover', 'scroll', 'select_option', 'wait'].includes(step.action)) throw new Error('Unsupported batch action');
    if (step.timeout_ms != null && (!Number.isInteger(step.timeout_ms) || step.timeout_ms < 100 || step.timeout_ms > 30000)) throw new Error('step timeout_ms must be 100..30000');
    if (step.dialog_policy != null && !['ask', 'accept', 'dismiss'].includes(step.dialog_policy)) throw new Error('dialog_policy must be ask, accept or dismiss');
    if (step.wait_for != null) {
      if (step.action === 'wait') throw new Error('wait steps do not accept wait_for');
      actionWaitOptions(step.wait_for);
    }
    if (step.observe != null) {
      controlOptions(step.observe);
      if (step.observe.ref != null) throw new Error('Batch observation uses a fresh selector, not ref');
    }
    if (step.action === 'press_key') {
      keyParameters(step.key);
      if (step.ref != null) throw new Error('Batch keyboard targets use a fresh selector, not ref');
      if (['selector', 'selector_type', 'name', 'frame', 'frame_id', 'nth'].some(key => step[key] != null)) targetOptions(step);
    }
    else if (step.action === 'wait') waitOptions({ ...step, dialog_policy: step.dialog_policy ?? dialogPolicy });
    else if (step.action === 'scroll') {
      if (step.ref != null) throw new Error('Batch scroll uses a fresh selector, not ref');
      if (step.selector != null) targetOptions(step);
      else if (step.frame || step.frame_id) throw new Error('scroll frame scope requires selector');
      frameOptions(step);
      scrollOptions(step);
    } else {
      if ((!step.selector && !(step.action === 'type' && step.focused === true)) || step.ref != null) throw new Error('Batch element actions require selector; type also accepts focused=true');
      targetOptions(step, { focused: step.action === 'type' });
      if (step.action === 'click') inputMode(step);
      if (step.action === 'click') clickOptions(step);
      if (step.action === 'hover') offsetOption(step);
      if (step.action === 'fill') fillOptions(step);
      if (step.action === 'type') typeOptions(step);
      if (step.action === 'select_option') selectOptions(step);
    }
  }
}
