# opencode-claude-bridge

## This fork

Maintained at [fabio80mi/opencode-claude-bridge](https://github.com/fabio80mi/opencode-claude-bridge). It connects OpenCode to Claude using Claude Code credentials or a Claude Pro/Max OAuth login, and translates requests and tool calls between the two clients.

Version 2.0.0 targets OpenCode v2.4.1. It uses native v2 integration, provider, and HTTP hooks. It does not support OpenCode v1. Migration decisions and verification boundaries: [docs/OPENCODE-V2-MIGRATION.md](docs/OPENCODE-V2-MIGRATION.md). Earlier prefill-fix history: [docs/OPENCODE-PREFILL-FIX.md](docs/OPENCODE-PREFILL-FIX.md).

## Changes in 2.0.0

- Fix package discovery with an explicit server export and replace the v1 initialization function with a v2 plugin definition.
- Register authentication through native Anthropic integration methods. OpenCode owns credential persistence and refresh; an existing API-key connection stays selected.
- Register model additions and request/response hooks through v2 APIs, covering primary, compaction, title, and generate requests.
- Retain assistant-prefill removal, message cleanup, active-tool schemas, and tool argument translation. Add non-streaming response translation and propagate stream cancellation upstream.
- Split initialization, authentication, and wire translation into `index.ts`, `auth.ts`, and `transport.ts`; pin SDK dependencies to 2.4.1 and update the live validator to load the package directory.

Verification: the TypeScript build and all 110 tests passed. Isolated SDK and loopback HTTP checks covered initialization and all four request kinds. After deployment, the maintainer reported that the plugin appears to work in OpenCode v2. Browser-login and real token-refresh cases were not separately verified.

## Install from this repository

```bash
git clone https://github.com/fabio80mi/opencode-claude-bridge.git ~/opencode-claude-bridge
cd ~/opencode-claude-bridge
npm ci
npm test
```

Set the package directory in `~/.config/opencode/opencode.jsonc`, not `dist/index.js`:

```json
{
  "plugins": ["/absolute/path/to/opencode-claude-bridge"]
}
```

For a separate installed copy, deploy the updated source, package metadata, and lockfile there, then run `npm ci` and `npm run build` in that directory. Keep a backup outside OpenCode's plugin-discovery directories. The source repository and deployed copy are separate; editing one does not update the other.

Reload OpenCode after deployment. An existing API-key or environment-variable connection stays selected. If no Anthropic connection is active and Claude CLI credentials are available, the bridge imports them through OpenCode's OAuth connection flow. Otherwise select Claude Pro / Max (OAuth) in the Anthropic integration to connect.

This fork's local version does not imply an npm publication. Do not install the upstream npm package expecting these v2 changes.

## How the bridge works

The plugin sits between OpenCode and the Anthropic API:

> **OpenCode** -> **opencode-claude-bridge** -> **Anthropic API**

### Authentication

Supports both OAuth and API key authentication:

- OAuth credentials come from Claude CLI on macOS Keychain or Linux `~/.claude/.credentials.json`, with browser PKCE and manual-code fallback when needed.
- OpenCode v2 owns credential persistence and invokes the bridge's refresh callback for expired OAuth grants. Refresh checks valid CLI credentials, the stored refresh token, then the CLI refresh token.
- API-key and environment-variable connections use OpenCode's native authentication. Their requests and responses bypass the OAuth wire transformations. No process-wide API key is overwritten.

### Wire-level request matching

Every outbound OAuth request is rewritten to match what Claude Code sends on the wire:

- **Headers** — `user-agent`, `anthropic-beta`, `anthropic-version`, `x-stainless-*`, `x-claude-code-version`, `x-claude-code-session-id`, and all billing metadata (`cc_version`, `cc_entrypoint`, `cch`).
- **Body fields** — `thinking` (with effort and `clear_thinking`), `context_management`, `output_config`, `metadata` (session ID, billing info), and `?beta=true` URL parameter.
- **System prompt** — Claude Code's real system prompt is captured via the validator and cached at `~/.cache/opencode-claude-bridge/claude-system-prompt.json`. The bridge injects this as the system prompt for all requests. OpenCode's default system prompt is sanitized out.
- **MCP tool prefixing** — OpenCode's MCP tools are prefixed with `mcp_` to match Claude Code's convention.

### Tool schemas

The bridge retains the captured Claude Code tool definitions but sends only tools enabled in the current OpenCode request. It maps shared tool names and parameters, preserves custom tools with their original schemas, and does not advertise unavailable Claude-only stub tools. Requests without tools remain tool-less.

These wire transformations run for OAuth requests to the built-in Anthropic provider. API-key connections and other providers retain their native behavior.

### Bidirectional parameter translation

Claude Code and OpenCode use different parameter naming conventions. The bridge translates in both directions on the fly:

**Inbound (API response -> OpenCode)** — translated on assembled SSE `input_json_delta` payloads after buffering per-tool fragments, so chunk boundary splits do not corrupt name or argument mapping:

| Claude Code sends | OpenCode expects |
|---|---|
| `file_path` | `filePath` |
| `old_string` | `oldString` |
| `new_string` | `newString` |
| `replace_all` | `replaceAll` |
| `glob` (in Grep) | `include` |
| `activeForm` (in TodoWrite) | `priority` |

**Outbound (OpenCode -> API request)** — translated in historical `tool_use` message blocks:

| OpenCode sends | Bridge converts to |
|---|---|
| `filePath` | `file_path` |
| `oldString` | `old_string` |
| `newString` | `new_string` |
| `replaceAll` | `replace_all` |
| `include` (in Grep) | `glob` |
| `priority` (in TodoWrite) | `activeForm` |

Additional shared-tool bridging handled by the bridge:

- `Agent` / `task` — defaults missing `subagent_type` to `general`, strips unsupported Claude-only fields inbound, and strips OpenCode-only history fields outbound
- `AskUserQuestion` / `question` — maps `multiSelect` <-> `multiple`
- `Skill` — maps `skill` <-> `name`
- `WebFetch` — best-effort bridge between Claude's `prompt` and OpenCode's `format` by using `markdown` inbound and synthesizing a Claude prompt outbound

### Agent type translation

Claude Code uses different agent/subagent types than OpenCode:

| Claude Code | OpenCode |
|---|---|
| `general-purpose` | `general` |
| `Explore` | `explore` |
| `Plan` | `plan` |
| `statusline-setup` | `build` |

These are mapped in both directions — inbound responses and outbound historical messages.

### TodoWrite status mapping

Claude Code has 3 todo statuses; OpenCode has 4. The outbound direction maps `cancelled` -> `completed` since Claude Code doesn't have a cancelled state.

### Dynamic fingerprint computation

The `cc_version` billing metadata suffix (a 3-character hex string like `df0` or `e0a`) is computed dynamically per request using the same algorithm as Claude Code:

```
SHA256(salt + message[4] + message[7] + message[20] + CLI_VERSION).slice(0, 3)
```

The salt is hardcoded in Claude Code's source. This changes per conversation because the user's message text changes.

## Requirements

- [OpenCode](https://opencode.ai) v2.4.1, matching the pinned `@opencode/plugin` and `@opencode/schema` dependencies.
- For local builds: Node.js 22.15 or newer and npm.
- For OAuth: Claude CLI installed and logged in (`claude login`), or browser OAuth.
- macOS Keychain or Linux credential-file support for CLI credential import.

## Environment overrides

All OAuth and header parameters can be overridden via environment variables:

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_CLIENT_ID` | `9d1c250a-...` | OAuth client ID |
| `ANTHROPIC_TOKEN_URL` | `https://platform.claude.com/v1/oauth/token` | Token endpoint |
| `ANTHROPIC_AUTHORIZE_URL` | `https://claude.ai/oauth/authorize` | Authorization endpoint |
| `ANTHROPIC_CLI_VERSION` | Auto-detected from `claude --version` or `2.1.98` | Claude CLI version string |
| `ANTHROPIC_CLI_BUILD_ID` | `835` | Build ID for headers |
| `ANTHROPIC_ENTRYPOINT` | `sdk-cli` | Entrypoint value for billing |
| `ANTHROPIC_SDK_VERSION` | `0.94.0` | Stainless SDK version |
| `ANTHROPIC_BETA_FLAGS` | Current Claude Code beta flags | Comma-separated beta feature flags |
| `ANTHROPIC_BILLING_CCH` | (computed) | Client attestation hash override |
| `ANTHROPIC_SYSTEM_PROMPT_PATH` | `~/.cache/opencode-claude-bridge/claude-system-prompt.json` | Path to cached system prompt |
| `ANTHROPIC_DEFAULT_EFFORT` | `medium` | Thinking effort level |
| `ANTHROPIC_SESSION_ID` | (generated) | Override session ID |

Most users won't need to change these — the bridge auto-detects the installed Claude CLI version and uses matching defaults.

## Recent fixes

This fork includes several fixes discovered during debugging sessions:

- Plugin loading uses the package directory and its explicit `./server` export. The default export is a v2 plugin definition with id `opencode-claude-bridge`.
- **Assistant prefill stripping** — The bridge strips OpenCode's synthetic maximum-steps assistant prefill before requests reach Anthropic, preventing `This model does not support assistant message prefill` errors.
- **Message sanitization** — Before sending to Anthropic, the bridge removes OpenCode-specific message content blocks that Anthropic rejects: `thinking` blocks, `caller` metadata on `tool_use` blocks, and empty/whitespace-only `text` blocks.
- **Thinking config sanitization** — Strips OpenCode-only `block_binding` from the `thinking` config object to prevent `thinking.adaptive.block_binding: Extra inputs are not permitted` errors. Thinking functionality is preserved.
- Debug logging is opt-in through `OPENCODE_CLAUDE_BRIDGE_DEBUG=true` and writes to `/tmp/opencode-claude-bridge.log`.

## Debugging

Set `OPENCODE_CLAUDE_BRIDGE_DEBUG=true` to enable verbose bridge logging. When enabled, the plugin writes detailed request/response diagnostics to `/tmp/opencode-claude-bridge.log`.

```bash
OPENCODE_CLAUDE_BRIDGE_DEBUG=true opencode
```

Or add it to your shell profile for persistent debugging:

```bash
export OPENCODE_CLAUDE_BRIDGE_DEBUG=true
```

When disabled or unset (the default), the bridge does not write debug log entries.

Log entries include:

- Plugin initialization
- Native HTTP request and response transformation
- Request model, message count, and last message role before and after prefill stripping
- Message sanitization counts (`thinking`, `caller`, `emptyText` removed)
- Thinking config sanitization (`block_binding` removal)
- Final request state sent to Anthropic
- HTTP response status

If you're reporting an issue, attach `/tmp/opencode-claude-bridge.log` — it lets developers trace exactly what the bridge saw and sent without relying on OpenCode's own log output.

## Local validation

To validate how local OpenCode traffic is being classified and how closely it matches Claude Code on the wire:

```bash
npm run validate:oauth -- --model claude-sonnet-4-6 --prompt "Reply with exactly VALIDATE."
```

The validator will:

- Query the OAuth usage endpoint before and after each run
- Capture an official Claude Code request through a local proxy
- Capture an OpenCode request using this repository's package directory
- Write Claude Code's captured system prompt to `~/.cache/opencode-claude-bridge/claude-system-prompt.json`
- Save request and response artifacts under `tmp/validate-*`
- Write a `report.json` with request diffs, body hashes, and usage snapshots

After the first successful validator run, the bridge will automatically reuse that cached Claude Code system prompt. This is currently the key step that makes OpenCode traffic behave like standard Claude Code usage.

If OpenCode is being treated as an OAuth app / extra-usage flow, the report will usually show it in one of two ways:

- The OpenCode run fails with an extra-usage style API error
- The usage buckets diverge from the Claude Code run even when the headers look similar

## Updating for new Claude CLI versions

When Claude Code updates, the required headers or body fields may change. To capture exactly what the latest Claude CLI sends:

```bash
./scripts/intercept-claude.sh claude-sonnet-4-6
```

This starts a local proxy, runs Claude CLI through it with OAuth, and saves the full request headers and body to `/tmp/claude-intercept-*`. Compare against the plugin's constants and fetch wrapper to spot differences.

Key things that have changed across versions:

- `anthropic-beta` flags (required set changes)
- Body fields (`thinking`, `metadata`, `context_management`)
- `user-agent` version string
- `x-stainless-package-version`
- `x-claude-code-session-id`
- Billing header shape (`cc_version`, `cc_entrypoint`, `cch`)
- Tool definitions and parameter schemas

## Architecture

```text
src/
  index.ts          V2 plugin definition, model inventory, native HTTP hooks
  auth.ts           V2 integration methods, CLI import, OAuth refresh ownership
  transport.ts      OAuth headers, body cleanup, tool translation, response streams
  claude-tools.ts   Captured Claude tool definitions and argument maps
  constants.ts      Versions, URLs, environment overrides, headers
  keychain.ts       Claude CLI credentials on macOS and Linux
  oauth.ts          PKCE, token exchange, local callback server
  stream.ts         Fragment-safe SSE tool translation
scripts/
  validate-opencode-oauth.js  Live side-by-side wire comparison
  intercept-claude.sh        Claude CLI request capture
```

## Important limitation

Anthropic's own Claude Code docs say third-party integrations should use API key authentication. This bridge can make OAuth requests look much closer to current Claude Code traffic, but Anthropic may still apply server-side classification that a bridge cannot fully control.

## Credits

Combines approaches from [shahidshabbir-se/opencode-anthropic-oauth](https://github.com/shahidshabbir-se/opencode-anthropic-oauth), [ex-machina-co/opencode-anthropic-auth](https://github.com/ex-machina-co/opencode-anthropic-auth), [vinzabe/PERMANENT-opencode-anthropic-oauth-fix](https://github.com/vinzabe/PERMANENT-opencode-anthropic-oauth-fix), and [lehdqlsl/opencode-claude-auth-sync](https://github.com/lehdqlsl/opencode-claude-auth-sync).

## License

MIT
