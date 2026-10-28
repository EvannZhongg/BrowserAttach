# Recover from a failed or incomplete operation

MCP tool failures use `isError` with JSON containing `error` and available `diagnostics`, `input_dispatched`, `post_action` or `open_tab` evidence. Schema validation can fail before that envelope exists. An error does not by itself establish whether an action took effect.

## Classify before continuing

| Evidence | Next step |
| --- | --- |
| Invalid or incompatible arguments | Correct the arguments against the connected tool schema. |
| Target not found | Inspect the current page/frame and actual role/name. Wait for a concrete condition if the target is still loading. |
| Multiple targets match | Scope the target using observed container/frame identity; use an observed index only when it identifies the intended match. |
| Invalid locator | Use the connected tool's locator description and returned diagnostics to correct the query. |
| Expired element reference | Observe the affected page/frame again and use its new ref or a fresh selector. This alone does not require a new claim. |
| Action failure with `input_dispatched:false` | Resolve the reported readiness, targeting or permission issue, then retry the still-needed action. Activation must be requested explicitly. |
| `input_dispatched:true`, or a write with no reliable dispatch evidence | Inspect the current result before deciding what to do. Do not automatically repeat the action or resend in another mode. |
| Field value was not retained | Read current field/application state. Use the fill tool's verification options only for a known expected result. |
| Observation interrupted by navigation or timeout | A fresh read-only observation may be retried when useful. Failed snapshot refs are unusable. |
| An unhandled JS dialog | Read its message with snapshot and choose `browser_handle_dialog` according to the task; logs remain readable. |

Pure observations such as snapshot, read_text and log reads can be repeated as needed. A fresh observation describes the current page, not necessarily the state that existed before the failure. `browser_evaluate` can write, and `browser_fetch` visits a live URL with scripts and redirects; neither is categorically safe to replay.

Use returned diagnostics and the connected tool descriptions for exact error and evidence fields. Post-action observations can show page changes, but absence of observed changes does not establish non-delivery or absence of server-side effects. A successful activation also says nothing about an earlier action's outcome. Use Escape only when an actual open browser menu needs dismissing.

## Keep or reacquire control

Keep the handle for ordinary selector, readiness or value errors while the claim remains valid. Reconnect if necessary, then discover profiles and tabs and claim again after:

- MCP/Hub disconnection, browser restart or extension reload;
- explicit release, or debugger detachment that ended control;
- a Hub operation timeout that closed the client connection and released its claims.

Handles belong to one connection. Another owner's claim is a control conflict; wait for release or ask the user to resolve it. Do not force a takeover. If release/detach failed and the error supplies `control_retained` and a recovery handle, resolve the fault and release that handle; do not assume ownership was transferred.

If a claimed tab navigates to `about:blank` while its handle remains valid, use an explicit `browser_navigate` URL or valid back/forward history entry to recover the same tab. Ordinary page operations and new claims remain unavailable on blank pages. Navigation does not restore lost unsaved state; do not automatically revisit the old URL or open a replacement tab. For an unclaimed blank tab, navigate it in the browser before discovering and claiming it.

## Preserve completed work

**New tab creation:** `browser_open_tab(claim=true)` can create a page and then fail to claim it. Inspect `error.open_tab` for the known `browser_id`/`tab_id`, `opened`, `claimed` and recovery handle. Discover tabs to locate the existing creation; do not automatically create another. Creation and claim are separate phases.

**Batch:** inspect `results`, `failed_step`, `next_unattempted_step` and `retry_failed_step_safe`. Prior completed steps remain applied. Observe the failed step, then explicitly choose a continuation with `start_at`; the next unattempted step is an index, not proof that skipping the failed step is correct. A failed read-only wait can be retried without replaying the earlier click.

**Navigation:** `observation_error` can mean the navigation completed but its follow-up snapshot failed. Observe the destination; do not resend navigation just to obtain a snapshot. Timed-out navigation or asynchronous JavaScript can continue.

**Upload:** `assignment_acknowledged:true` establishes file assignment only. A false or unavailable `count_verified` can follow the site's consumption or replacement of the input. Inspect the resulting attachment/processing state before assigning files again.

**Virtual scrolling:** review the tool's reported progress, stop reason and any pending scroll. A boundary or exhausted budget does not establish that all data loaded or that the item does not exist. Observe the current container before planning further search.

## Continue large reads

Use each result's continuation mechanism rather than repeating the initial operation:

| Source | Continuation |
| --- | --- |
| Snapshot | Pass `next_cursor` as `cursor` while that captured observation remains valid. |
| Fetch | Pass `browser_id`, `cursor` and optional `max_chars`; reads immutable capture without revisiting. |
| Evaluate JSON | Pass `tab_handle`, `cursor` and optional `max_chars`; omit expression and frame to avoid re-execution. |
| Text | Use `next_offset`; this rereads live text, which may change. |
| Logs | Use `next_seq` as `after_seq` for the same claim and kind; restart at 0 when changing filters. |

For an evaluate item that exceeds the page budget, use `required_chars` or `next_item.required_chars` if within the tool limit. If it exceeds the maximum, extract a smaller result only after considering whether re-execution can have effects. `capture_truncated` marks source loss that pagination cannot recover. Host artifact truncation is separate from BrowserAttach pagination.
