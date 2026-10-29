import { controlOptions } from './control.js';
import { validateSnapshotRequest } from './snapshot.js';

const SNAPSHOT_OBSERVATION_KEYS = new Set(['diff_since', 'max_nodes', 'max_chars', 'verbose', 'timeout_ms']);

export function actionObservationOptions(args) {
  if (args && typeof args === 'object' && !Array.isArray(args) && 'diff_since' in args) {
    for (const key of Object.keys(args)) if (!SNAPSHOT_OBSERVATION_KEYS.has(key)) throw new Error(`Snapshot observe does not accept ${key}; use a separate snapshot to change its view`);
    if (typeof args.diff_since !== 'string') throw new Error('Snapshot observe requires diff_since');
    validateSnapshotRequest(args);
    const timeout = args.timeout_ms ?? 5000;
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30000) throw new Error('observation timeout_ms must be 100..30000');
    return 'snapshot';
  }
  controlOptions(args);
  return 'control';
}
