import { targetOptions, frameOptions } from './locator.js';
import { clickOptions } from './click.js';
import { inputMode, fillOptions, keyParameters, selectOptions, typeOptions } from './input.js';
import { scrollOptions } from './scroll.js';
import { waitOptions } from './wait.js';
import { offsetOption } from './motion.js';

export function validateSteps(steps, startAt = 0) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 20) throw new Error('steps must contain 1..20 actions');
  if (!Number.isInteger(startAt) || startAt < 0 || startAt >= steps.length) throw new Error('start_at must be an existing zero-based step index');
  for (const step of steps) {
    if (!step || !['click', 'fill', 'type', 'press_key', 'hover', 'scroll', 'select_option', 'wait'].includes(step.action)) throw new Error('Unsupported batch action');
    if (step.timeout_ms != null && (!Number.isInteger(step.timeout_ms) || step.timeout_ms < 100 || step.timeout_ms > 30000)) throw new Error('step timeout_ms must be 100..30000');
    if (step.dialog_policy != null && !['ask', 'accept', 'dismiss'].includes(step.dialog_policy)) throw new Error('dialog_policy must be ask, accept or dismiss');
    if (step.action === 'press_key') keyParameters(step.key);
    else if (step.action === 'wait') waitOptions(step);
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
