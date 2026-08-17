# OpenCode model identity and assistant-prefill fix

## Why this fork exists

OpenCode sends Anthropic requests through this bridge. The bridge rewrites request headers, system blocks, tools, and message content so Claude OAuth traffic matches the expected Claude Code wire format.

OpenCode can represent the selected model in more than one shape:

- String: `"anthropic/claude-opus-5"` or `"claude-opus-5"`
- Current object: `{ id: "claude-opus-5", providerID: "anthropic" }`
- Legacy object: `{ modelID: "claude-opus-5", providerID: "anthropic" }`

The bridge previously treated the value as a string in model-identity handling. Calling `modelId.match(...)` on an object throws:

```text
modelId.match is not a function
```

That exception occurs while the plugin initializes or intercepts a request. If initialization fails, the bridge's fetch interceptor is not registered. The downstream Anthropic request then bypasses bridge cleanup.

## Related Anthropic error

At a configured step limit, OpenCode can append a synthetic assistant message containing `MAX_STEPS_PROMPT`. Anthropic interprets a final assistant message as response prefill and may reject it with:

```text
This model does not support assistant message prefill
```

The bridge already contains logic to remove recognized synthetic maximum-step prefills. That logic is effective only when the bridge loads successfully. The practical failure chain was:

```text
model identity object
  -> bridge throws on modelId.match
  -> fetch interceptor never registers
  -> synthetic assistant prefill is not removed
  -> Anthropic rejects the request
```

## Changes in this fork

### Model identity normalization

`src/index.ts` now normalizes model identity at the boundary before parsing or interpolating it:

- accepts string model IDs;
- accepts current `{ id }` objects;
- accepts legacy `{ modelID }` objects;
- returns the original system blocks for invalid identities instead of throwing;
- uses the normalized string in the rewritten system-prompt identity line.

### Regression coverage

`src/index.test.ts` covers:

- current object model identity;
- legacy object model identity;
- invalid object identity without an exception;
- model identity rewriting for normal string input.

## Local build and verification

From repository root:

```bash
npm install
npm test
```

Current verification baseline for this fork:

- TypeScript build passed;
- 113 tests passed;
- 0 tests failed;
- `git diff --check` passed.

## OpenCode deployment

Build output is `dist/index.js`. OpenCode is configured to load a local runtime copy:

```jsonc
{
  "plugin": [
    "./plugins/opencode-claude-bridge/dist/index.js"
  ]
}
```

The source repository and runtime deployment are intentionally separate:

```text
/home/ubuntu/projects/opencode-claude-bridge                  source and GitHub checkout
/home/ubuntu/.config/opencode/plugins/opencode-claude-bridge  local runtime deployment
```

After building, copy the artifact to the configured runtime location and restart OpenCode. Verify logs before retrying Anthropic:

```text
modelId.match is not a function
```

must not appear during plugin loading. Do not edit `dist/index.js` by hand; rebuild it from `src/`.

## Scope and limitations

This fork does not change OpenCode's step-limit behavior. It makes the bridge tolerate model identity payload shapes and allows its existing prefill cleanup to execute. Anthropic may still change OAuth or request validation behavior independently.
