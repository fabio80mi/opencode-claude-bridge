# OpenCode v2 migration

## Target and compatibility

Bridge 2.0.0 targets OpenCode 2.4.1. Runtime dependencies `@opencode/plugin` and `@opencode/schema` are pinned to that version; `package-lock.json` is shared by repository builds and deployment installs. This is a v2-only cutover. OpenCode v1 requires the previous package.

## Decisions and costs

- Export a v2 `Plugin.define` object with id `opencode-claude-bridge`, and expose `./server` through package exports. The old async-function export and returned hooks are removed.
- Register OAuth, key, and environment methods through the Anthropic integration. Import Claude CLI credentials only when no Anthropic connection is active, so a selected API key is not replaced.
- Let OpenCode resolve, refresh, and persist OAuth credentials through the registered refresh callback. The callback checks valid CLI credentials, the stored refresh token, then the CLI refresh token. HTTP 429 retries re-resolve the active connection; they do not force renewal of an unexpired grant or write a parallel credential store.
- Register provider-scoped native `http.request` and `http.response` hooks for primary, compaction, title, and generate requests. API-key traffic and other providers bypass OAuth rewrites.
- Preserve existing prefill cleanup, thinking-field sanitization, prompt/billing shaping, active-tool selection, bidirectional parameters, and fragment-aware SSE parsing. Stream transformation uses backpressure and forwards cancellation upstream. Error responses remain readable; non-streaming JSON tool calls are translated too.
- Preserve native model definitions and add only missing legacy fallback models. Native provider schemas replace the v1 model-record shape.
- Keep source and deployment separate. Back up the installed package outside plugin-discovery paths before replacing it; rebuild the installed copy. No configuration edit or automatic OpenCode restart is part of deployment.

Costs: the plugin now depends on the v2 SDK runtime dependency tree and must track its contract. Dependency installation reported 24 moderate advisories; no unrelated dependency upgrades or `npm audit fix` were applied. Existing synchronous CLI credential/token helpers remain synchronous.

## Local evidence

- TypeScript compilation against the pinned v2 SDK passed.
- All 110 tests passed, covering tools, prefill, prompts, fragmented SSE, production-path thinking policy, and native transport boundaries.
- An isolated SDK Host resolution/setup smoke scenario with schema validation of model definitions and preservation of an existing API-key connection.
- Registered request/response hooks exercised against a loopback HTTP server for primary, compaction, title, and generate events. Assertions cover OAuth headers, beta URL, prefill cleanup, tool schemas, and streamed tool-call translation.

The smoke scenario uses fixture credentials and a loopback server. It does not prove a live Claude subscription request, browser OAuth, real token refresh, or the running OpenCode UI. Temporary smoke scripts are not part of the package. The live wire validator is separate and sends real requests; it was not run for this migration.

## Manual acceptance after deployment

After deployment, the maintainer reported that the plugin appears to work in OpenCode v2. This records general hands-on feedback, not separate confirmation of every scenario below. Browser OAuth and real token-refresh cases remain unverified.

1. Reload OpenCode and confirm `opencode-claude-bridge` appears in its plugin list.
2. Check the Anthropic connection. An existing API key must remain selected; otherwise confirm Claude CLI import or connect Claude Pro / Max (OAuth).
3. Send a short Claude prompt and confirm streamed text.
4. Ask Claude to read a file and confirm the tool call executes with the right path.
5. Confirm an auxiliary title or compaction request succeeds when it occurs.

Enable `OPENCODE_CLAUDE_BRIDGE_DEBUG=true` before launching OpenCode for `/tmp/opencode-claude-bridge.log`. For a loading failure, inspect OpenCode's plugin error first: bridge logging begins only after initialization reaches the native transport.

## Rollback

The deployment backup path is reported when deployment completes. Stop OpenCode, move the failed installed directory aside, and restore the backup at the configured package path. A v1 backup restores the prior package, not compatibility with OpenCode v2. No configuration or credential-store rollback is needed because deployment does not edit either.
