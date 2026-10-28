# Cross-site recipes

Examples use original MCP tool names with JSON arguments. Replace sample selectors and values with facts observed on the task's page; call the host's actual tools.

## Signed-in form

Claim the intended existing tab, then inspect fields:

```json
{"tab_handle":"HANDLE","profile":"fields"}
```

Use actual labels, placeholders or stable selectors. A short sequence of known edits can use `browser_batch`:

```json
{"tab_handle":"HANDLE","steps":[
  {"action":"fill","selector_type":"label","selector":"Company","text":"Example Ltd"},
  {"action":"select_option","selector":"select[name=country]","value":"GB"},
  {"action":"press_key","key":"Tab"}
]}
```

Tab explicitly requests blur; omit it when the page does not need it. Read validation and selected state before the task's submit/save step. After saving, verify a concrete application result, such as a success message or the saved record. `value_verified` establishes retained text, not persistence.

For a custom combobox, open/fill the filter, use `browser_read_control` on the control, then click the intended option ref. It reports the current active and selected items separately from the bounded option list. Add `observe` with an explicit control/display-container locator to the click or guarded `browser_press_key` to read the displayed result in the same call; observation failure does not undo input delivery. Use `browser_wait` when the next step requires an asserted state.

When no usable relation is exposed, provide a unique `popup_selector` instead of guessing which floating list belongs to the control. Existing `controls`/`owns` IDs can also scope a portal; they are DOM IDs, not refs. For a popup ID `company-options`, an option selector could be:

```json
{"tab_handle":"HANDLE","selector_type":"xpath","selector":"//*[@id='company-options']//*[@role='option' and normalize-space(.)='Example Ltd']"}
```

Confirm the selected item. Filtering alone does not commit it. Context text near a field is a hint, not an HTML label association.

For attachments, pass task-intended absolute paths to `browser_upload_file` using the observed file input/label. Alternatively click the site's upload control; when `file_chooser.pending=true`, omit the target to use the intercepted input. Wait for the site's processing indicator or attachment state, then re-observe fields if parsing rebuilt the form.

If the task needs an XHR/fetch response as evidence, enable `browser_logs(kind="network", capture={"enabled":true})` before the action, then inspect the relevant events. Capture covers subsequent requests, is bounded, and redacts named secrets; a response is evidence only for the request it describes.

## Iframe target

A snapshot reports frame coverage and observed frame IDs. With a ref, use it directly: frame/session identity is already attached. With selectors, choose `frame_id` from the current page or a uniquely resolvable iframe path:

```json
{"tab_handle":"HANDLE","frame":{"path":["iframe[title='Account']","iframe[title='Address']"]},"selector_type":"label","selector":"City","text":"London"}
```

The example is a `browser_fill` call. `frame.url` and `frame.title` are exact matches; `path` resolves nested CSS iframe elements. Use either `frame` or `frame_id`, and omit both with ref. Cross-origin frames use the same tool flow when available; inspect `omitted_frames` rather than treating missing coverage as missing content. Re-observe after frame replacement/navigation.

## Shadow DOM target

Start with a snapshot ref or AX role/name; CSS, XPath, label and placeholder locators do not pierce shadow roots. For an inspected open shadow root without a useful AX target, `browser_evaluate(result_type="element")` can return one element as a ref:

```json
{"tab_handle":"HANDLE","result_type":"element","expression":"() => document.querySelector('account-card').shadowRoot.querySelector('button.save')"}
```

Use the returned ref in `browser_click`, then verify the page result. This expression only locates the element; native input remains a separate tool operation. Closed roots are not exposed through `.shadowRoot`; use available AX/ref observation rather than inventing a JavaScript access path. For visual fallback, use screenshot metadata to map image points to viewport CSS coordinates, and account for any subsequent scroll.

## Virtual scrolling list

Identify the actual scrolling container, then call `browser_scroll` with a scoped text search:

```json
{"tab_handle":"HANDLE","selector":"#results","until":{"text":"Invoice 0487","selector":"button"},"delta_y":200,"max_steps":100,"timeout_ms":15000}
```

On success, inspect the match and use its returned ref; the search does not click it. `until` uses text substrings over rendered DOM candidates, so narrow `until.selector` when several items match. DOM mode is required; wheel mode does not support this search.

On a stopped search, inspect `stop_reason`, `scroll_steps`, `scroll_pending` and current content. A no-movement boundary can precede asynchronous growth. Do not report absence from unrendered data based on one snapshot or an exhausted search budget.
