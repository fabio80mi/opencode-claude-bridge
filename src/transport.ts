import { createHash, randomUUID } from "node:crypto";
import { readFileSync, appendFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { BETA_FLAGS, CLI_VERSION, OAUTH_BETA_FLAG, ANTHROPIC_VERSION, BILLING_CCH, STAINLESS_HEADERS, USER_AGENT, PROFILE_URL, CLI_BUILD_ID, ENTRYPOINT, DEFAULT_EFFORT, CLEAR_THINKING_TYPE, SESSION_ID, } from "./constants.js";
import { type ToolDefinition, getClaudeTools, translateArgsOpencodeToClaude, translateToolArgsJsonString, computeFingerprint, extractFirstUserMessageText, shouldUseClaudeToolSchemas, } from "./claude-tools.js";
import { createSseProcessor } from "./stream.js";
const BRIDGE_LOG = "/tmp/opencode-claude-bridge.log";
const BRIDGE_DEBUG = process.env["OPENCODE_CLAUDE_BRIDGE_DEBUG"] === "true";
function writeBridgeLog(message: string) {
    if (!BRIDGE_DEBUG)
        return;
    try {
        appendFileSync(BRIDGE_LOG, `${new Date().toISOString()} ${message}\n`);
    }
    catch { }
}
import { setTimeout as delay } from "node:timers/promises";
import type { ClaudeAuth } from "./auth.js";
type OAuthProfile = {
    account?: {
        uuid?: string;
    };
};
type ClaudeSystemPromptCache = {
    system?: Array<{
        type?: string;
        text?: string;
        cache_control?: unknown;
    }>;
    billing?: {
        ccVersion?: string;
        ccVersionSuffix?: string;
        ccEntrypoint?: string;
    };
};
const OUTBOUND_TOOL_NAME_MAP: Record<string, string> = {
    bash: "Bash",
    read: "Read",
    glob: "Glob",
    grep: "Grep",
    edit: "Edit",
    write: "Write",
    task: "Agent",
    webfetch: "WebFetch",
    todowrite: "TodoWrite",
    skill: "Skill",
    mcp_bash: "Bash",
    mcp_read: "Read",
    mcp_glob: "Glob",
    mcp_grep: "Grep",
    mcp_edit: "Edit",
    mcp_write: "Write",
    mcp_task: "Agent",
    mcp_webfetch: "WebFetch",
    mcp_todowrite: "TodoWrite",
    mcp_skill: "Skill",
    question: "AskUserQuestion",
    mcp_question: "AskUserQuestion",
    plan_enter: "EnterPlanMode",
    plan_exit: "ExitPlanMode",
};
const INBOUND_TOOL_NAME_MAP: Record<string, string> = {
    Bash: "bash",
    Read: "read",
    Glob: "glob",
    Grep: "grep",
    Edit: "edit",
    Write: "write",
    Agent: "task",
    WebFetch: "webfetch",
    TodoWrite: "todowrite",
    Skill: "skill",
    AskUserQuestion: "question",
    EnterPlanMode: "plan_enter",
    ExitPlanMode: "plan_exit",
};
const CLAUDE_PREFIX = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
/**
 * Derive a human-readable display name from a Claude model ID.
 *
 * Matches `claude-{family}-{major}-{minor}[-{date}]` (the convention used
 * for every Claude model family to date) and renders e.g.
 *   claude-opus-4-7            -> "Opus 4.7"
 *   claude-haiku-4-5-20251001  -> "Haiku 4.5"
 *   claude-sonnet-4-6          -> "Sonnet 4.6"
 *
 * Falls back to the raw model ID if the convention doesn't match, so future
 * naming changes are surfaced truthfully instead of silently wrong.
 */
type ModelIdentity = string | {
    id?: unknown;
    modelID?: unknown;
    providerID?: unknown;
};
function normalizeModelId(model: ModelIdentity | undefined): string | undefined {
    if (typeof model === "string")
        return model;
    if (!model || typeof model !== "object")
        return undefined;
    if (typeof model.id === "string")
        return model.id;
    if (typeof model.modelID === "string")
        return model.modelID;
    return undefined;
}
export function deriveModelDisplayName(model: ModelIdentity): string {
    const modelId = normalizeModelId(model);
    if (!modelId)
        return "";
    const m = modelId.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d+)?$/i);
    if (!m)
        return modelId;
    const [, family, major, minor] = m;
    const capitalized = family.charAt(0).toUpperCase() + family.slice(1).toLowerCase();
    return minor ? `${capitalized} ${major}.${minor}` : `${capitalized} ${major}`;
}
/**
 * Rewrite model-identity lines inside the cached Claude Code system prompt
 * so they reflect the model actually being requested. Without this, every
 * request (regardless of selected model) gets a system prompt claiming
 * "You are powered by the model named Sonnet 4.6", which can bias behavior.
 */
export function rewriteSystemBlocksForModel(blocks: Array<{
    type?: string;
    text?: string;
}>, modelId: ModelIdentity | undefined): Array<{
    type?: string;
    text?: string;
}> {
    const normalizedModelId = normalizeModelId(modelId);
    if (!normalizedModelId)
        return blocks;
    const display = deriveModelDisplayName(normalizedModelId);
    return blocks.map((block) => {
        if (block?.type !== "text" || typeof block.text !== "string")
            return block;
        let text = block.text;
        text = text.replace(/You are powered by the model named [^\n]+? The exact model ID is [a-z0-9.-]+\./g, `You are powered by the model named ${display}. The exact model ID is ${normalizedModelId}.`);
        return { ...block, text };
    });
}
export function stripSystemCacheControl(system: Array<{
    type?: string;
    text?: string;
    cache_control?: unknown;
}>): Array<{
    type?: string;
    text?: string;
}> {
    return system.map((block) => {
        if (!("cache_control" in block))
            return block;
        const { cache_control, ...rest } = block;
        return rest;
    });
}
export function shouldInjectClaudeTools(input: {
    model?: string;
    requestUrl?: string;
    tools?: unknown;
}): boolean {
    if (!shouldUseClaudeToolSchemas({
        model: input.model,
        requestUrl: input.requestUrl,
    })) {
        return false;
    }
    return Array.isArray(input.tools) && input.tools.length > 0;
}
export function getClaudeToolsForActiveOpenCodeTools(tools: unknown): ToolDefinition[] {
    if (!Array.isArray(tools))
        return [];
    const mapped = (tool: unknown): string | undefined => {
        if (!tool || typeof tool !== "object")
            return undefined;
        const name = (tool as {
            name?: unknown;
        }).name;
        if (typeof name !== "string")
            return undefined;
        return OUTBOUND_TOOL_NAME_MAP[name] || name;
    };
    const active = new Set(tools
        .map(mapped)
        .filter((name): name is string => typeof name === "string"));
    const claude = getClaudeTools().filter((tool) => active.has(tool.name));
    const claudeNames = new Set(claude.map((tool) => tool.name));
    // shortcut: plugin/MCP tools keep OpenCode's schema; drop this if Anthropic rejects non-Claude-Code tools
    const passthrough = tools.filter((tool) => {
        const name = mapped(tool);
        return typeof name === "string" && !claudeNames.has(name);
    });
    return [...claude, ...passthrough] as ToolDefinition[];
}
const oauthProfileCache = new Map<string, Promise<OAuthProfile | null>>();
const SYSTEM_PROMPT_CACHE_PATH = process.env.ANTHROPIC_SYSTEM_PROMPT_PATH ||
    join(process.env.HOME || "", ".cache", "opencode-claude-bridge", "claude-system-prompt.json");
/** Build deduplicated beta flags string. */
function buildBetaFlags(): string {
    const required = BETA_FLAGS.split(",")
        .map((b) => b.trim())
        .filter(Boolean);
    const withoutSpecials = required.filter((beta) => beta !== "claude-code-20250219" && beta !== OAUTH_BETA_FLAG);
    return ["claude-code-20250219", OAUTH_BETA_FLAG, ...withoutSpecials].join(",");
}
/** Deduplicate repeated Claude Code prefix in a text block. */
function deduplicatePrefix(text: string): string {
    const doubled = `${CLAUDE_PREFIX}\n\n${CLAUDE_PREFIX}`;
    while (text.includes(doubled)) {
        text = text.replace(doubled, CLAUDE_PREFIX);
    }
    return text;
}
function mapOutboundToolName(name: string | undefined): string | undefined {
    if (!name)
        return name;
    return OUTBOUND_TOOL_NAME_MAP[name] || name;
}
function maybeUnquoteText(text: string): string {
    const trimmed = text.trim();
    if (!trimmed.startsWith('"'))
        return text;
    try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === "string")
            return parsed;
    }
    catch {
        // Expected for non-JSON text — don't log.
    }
    return text;
}
function assistantText(content: unknown): string | undefined {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return undefined;
    const textParts = content.filter((part): part is {
        text?: unknown;
    } => part !== null && typeof part === "object" && "text" in part);
    if (textParts.length === 0)
        return undefined;
    const joined = textParts.map((part) => String(part.text ?? "")).join("");
    return joined || undefined;
}
type ClaudeMessage = {
    role?: string;
    content?: unknown;
};
function sanitizeMessageContent(content: Array<Record<string, unknown>>, thinkingConfig: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
    let removedThinking = 0;
    let removedCaller = 0;
    let removedEmptyText = 0;
    const sanitized: Array<Record<string, unknown>> = [];
    for (const block of content) {
        // Drop OpenCode thinking blocks when Anthropic thinking is not enabled.
        if (block.type === "thinking") {
            if (!thinkingConfig) {
                removedThinking++;
                continue;
            }
            sanitized.push(block);
            continue;
        }
        // Drop empty/whitespace-only text blocks.
        if (block.type === "text" &&
            typeof block.text === "string" &&
            !block.text.trim()) {
            removedEmptyText++;
            continue;
        }
        // Strip OpenCode-only metadata from tool_use blocks.
        if (block.type === "tool_use" && block.caller) {
            removedCaller++;
            const { caller, ...rest } = block;
            sanitized.push(rest as Record<string, unknown>);
            continue;
        }
        sanitized.push(block);
    }
    if (removedThinking > 0 || removedCaller > 0 || removedEmptyText > 0) {
        writeBridgeLog(`sanitizeMessageContent: removed thinking=${removedThinking} caller=${removedCaller} emptyText=${removedEmptyText} resultCount=${sanitized.length}`);
    }
    return sanitized;
}
export function stripAssistantPrefillForClaude(messages: ClaudeMessage[]) {
    if (!Array.isArray(messages))
        return messages;
    const last = messages.at(-1);
    if (last?.role !== "assistant") {
        writeBridgeLog(`stripAssistantPrefillForClaude: skip role=${last?.role} contentLength=${typeof last?.content === "string"
            ? (last.content as string).length
            : Array.isArray(last?.content)
                ? last.content.length
                : "N/A"}`);
        return messages;
    }
    const text = assistantText(last.content)?.trim();
    if (!text) {
        writeBridgeLog(`stripAssistantPrefillForClaude: empty text role=${last.role} contentType=${typeof last.content}`);
        return messages;
    }
    writeBridgeLog(`stripAssistantPrefillForClaude: assistant text=${JSON.stringify(text).slice(0, 500)}`);
    const isPrefill = text === "Continue with your tasks." ||
        text.startsWith("CRITICAL - MAXIMUM STEPS REACHED");
    return isPrefill ? messages.slice(0, -1) : messages;
}
function normalizeSystemBlocks(system: Array<{
    type?: string;
    text?: string;
}>): Array<{
    type?: string;
    text?: string;
}> {
    const normalized = system.map((item) => {
        if (item.type === "text" && item.text) {
            return {
                ...item,
                text: deduplicatePrefix(item.text
                    .replace(/OpenCode/g, "Claude Code")
                    .replace(/opencode/gi, "Claude")),
            };
        }
        return item;
    });
    const billing = normalized[0];
    const prompt = normalized[1];
    if (billing?.type === "text" &&
        billing.text?.startsWith("x-anthropic-billing-header:") &&
        prompt?.type === "text" &&
        prompt.text?.startsWith(`${CLAUDE_PREFIX}\n\n`)) {
        const rest = prompt.text.slice(`${CLAUDE_PREFIX}\n\n`.length);
        return [
            billing,
            { ...prompt, text: CLAUDE_PREFIX },
            { ...prompt, text: rest },
            ...normalized.slice(2),
        ];
    }
    return normalized;
}
function readCachedClaudePromptCache(): ClaudeSystemPromptCache | null {
    try {
        const raw = readFileSync(SYSTEM_PROMPT_CACHE_PATH, "utf8");
        const parsed = JSON.parse(raw) as ClaudeSystemPromptCache;
        if (!Array.isArray(parsed.system) || parsed.system.length === 0)
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
function getStableDeviceId(): string {
    let who = "unknown";
    try {
        who = `${userInfo().username}@${hostname()}`;
    }
    catch {
        try {
            who = `${process.env.USER || process.env.USERNAME || "unknown"}@${hostname()}`;
        }
        catch { }
    }
    return createHash("sha256").update(who).digest("hex");
}
function buildBillingHeader(sessionId: string, cachedClaudePromptCache: ClaudeSystemPromptCache | null, dynamicFingerprint?: string): string {
    const cch = BILLING_CCH ||
        createHash("sha256").update(sessionId).digest("hex").slice(0, 5);
    // Prefer dynamic fingerprint (computed per-request from first user message)
    // over static cached value, matching Claude Code's actual behavior.
    const suffix = dynamicFingerprint ||
        cachedClaudePromptCache?.billing?.ccVersionSuffix ||
        CLI_BUILD_ID;
    const ccVersion = cachedClaudePromptCache?.billing?.ccVersion || `${CLI_VERSION}.${suffix}`;
    const ccEntrypoint = cachedClaudePromptCache?.billing?.ccEntrypoint || ENTRYPOINT;
    return `x-anthropic-billing-header: cc_version=${ccVersion}; cc_entrypoint=${ccEntrypoint}; cch=${cch};`;
}
async function fetchOAuthProfile(accessToken: string): Promise<OAuthProfile | null> {
    const cached = oauthProfileCache.get(accessToken);
    if (cached)
        return cached;
    const pending = (async () => {
        try {
            const response = await globalThis.fetch(PROFILE_URL, {
                headers: {
                    authorization: `Bearer ${accessToken}`,
                    "content-type": "application/json",
                    "user-agent": USER_AGENT,
                    "anthropic-beta": OAUTH_BETA_FLAG,
                },
            });
            if (!response.ok)
                return null;
            return (await response.json()) as OAuthProfile;
        }
        catch {
            return null;
        }
    })();
    oauthProfileCache.set(accessToken, pending);
    return pending;
}
export function createClaudeTransport(auth: ClaudeAuth) {
    const sessionId = SESSION_ID || randomUUID();
    const deviceId = getStableDeviceId();
    const cachedClaudePromptCache = readCachedClaudePromptCache();
    const cachedClaudeSystem = cachedClaudePromptCache?.system || null;
    const requests = new WeakMap<Request, string>();
    writeBridgeLog("plugin initialized (OpenCode v2 native HTTP)");
    return {
        async request(request: Request): Promise<Request> {
            const authTokens = await auth.resolve();
            if (!authTokens)
                return request;
            let body = await request.clone().text();
            // ── Headers ──
            const headers = new Headers(request.headers);
            headers.set("authorization", `Bearer ${authTokens.access}`);
            headers.delete("x-api-key");
            headers.delete("x-session-affinity");
            headers.delete("x-session-id");
            if (!headers.has("accept"))
                headers.set("accept", "application/json");
            headers.set("user-agent", USER_AGENT);
            headers.set("x-app", "cli");
            headers.set("x-claude-code-session-id", sessionId);
            headers.set("anthropic-version", ANTHROPIC_VERSION);
            headers.set("anthropic-dangerous-direct-browser-access", "true");
            for (const [k, v] of Object.entries(STAINLESS_HEADERS))
                headers.set(k, v);
            if (!headers.has("x-stainless-retry-count"))
                headers.set("x-stainless-retry-count", "0");
            if (!headers.has("x-stainless-timeout"))
                headers.set("x-stainless-timeout", "600");
            headers.set("anthropic-beta", buildBetaFlags());
            const parsed = JSON.parse(body);
            writeBridgeLog(`fetch request model=${parsed.model} messagesCount=${Array.isArray(parsed.messages)
                ? parsed.messages.length
                : "N/A"} lastRole=${parsed.messages &&
                Array.isArray(parsed.messages) &&
                parsed.messages.length > 0
                ? parsed.messages[parsed.messages.length - 1].role
                : "N/A"}`);
            const requestUrl = request.url;
            // Only inject adaptive thinking for models that support it.
            // Use an explicit allowlist — haiku and older sonnet variants
            // (e.g. claude-sonnet-4-5) reject the field entirely.
            // claude-sonnet-4-6 and claude-opus-4-x are confirmed to support
            // interleaved-thinking-2025-05-14.
            const THINKING_MODELS = ["claude-opus-4", "claude-sonnet-4-6"];
            const supportsThinking = parsed.model &&
                THINKING_MODELS.some((m: string) => parsed.model.includes(m));
            if (!parsed.thinking && supportsThinking) {
                parsed.thinking = { type: "adaptive" };
            }
            // Strip OpenCode-only thinking fields that Anthropic rejects.
            if (parsed.thinking && typeof parsed.thinking === "object") {
                const { block_binding, ...anthropicThinking } = parsed.thinking as Record<string, unknown>;
                if (block_binding) {
                    writeBridgeLog(`stripThinkingBlockBinding: removed block_binding=${JSON.stringify(block_binding)} thinkingType=${anthropicThinking.type}`);
                }
                parsed.thinking = anthropicThinking;
            }
            // Anthropic requires temperature=1 when thinking is enabled/adaptive
            const thinkingType = parsed.thinking?.type;
            if ((thinkingType === "enabled" || thinkingType === "adaptive") &&
                parsed.temperature !== undefined &&
                parsed.temperature !== 1) {
                parsed.temperature = 1;
            }
            if (typeof parsed.system === "string")
                parsed.system = [{ type: "text", text: parsed.system }];
            if (!Array.isArray(parsed.system))
                parsed.system = [];
            if (!parsed.system.some((block: {
                text?: string;
            }) => block.text?.includes(CLAUDE_PREFIX))) {
                parsed.system.unshift({ type: "text", text: CLAUDE_PREFIX });
            }
            if (Array.isArray(parsed.messages)) {
                writeBridgeLog(`pre-strip messages count=${parsed.messages.length} lastRole=${parsed.messages[parsed.messages.length - 1]?.role}`);
                parsed.messages = stripAssistantPrefillForClaude(parsed.messages);
                writeBridgeLog(`post-strip messages count=${parsed.messages.length} lastRole=${parsed.messages[parsed.messages.length - 1]?.role}`);
            }
            // context_management and output_config.effort are only
            // supported by thinking-capable models. Sending them to
            // haiku (used for title generation) produces a 400.
            if (supportsThinking) {
                if (!parsed.context_management) {
                    parsed.context_management = {
                        edits: [{ type: CLEAR_THINKING_TYPE, keep: "all" }],
                    };
                }
                if (!parsed.output_config) {
                    parsed.output_config = { effort: DEFAULT_EFFORT };
                }
            }
            const profile = authTokens.access
                ? await fetchOAuthProfile(authTokens.access)
                : null;
            if (!parsed.metadata)
                parsed.metadata = {};
            if (!parsed.metadata.user_id && profile?.account?.uuid) {
                parsed.metadata.user_id = JSON.stringify({
                    device_id: deviceId,
                    account_uuid: profile.account.uuid,
                    session_id: sessionId,
                });
            }
            // Compute dynamic fingerprint from the first user message
            // (matches Claude Code's per-request fingerprint behavior).
            let dynamicFingerprint: string | undefined;
            if (parsed.messages && Array.isArray(parsed.messages)) {
                const firstText = extractFirstUserMessageText(parsed.messages);
                if (firstText) {
                    dynamicFingerprint = computeFingerprint(firstText);
                }
            }
            // Inject billing header as first system block (required for OAuth).
            const hasBilling = parsed.system.some((s: {
                text?: string;
            }) => s.text?.startsWith("x-anthropic-billing-header:"));
            let billingHeader = buildBillingHeader(sessionId, cachedClaudePromptCache, dynamicFingerprint);
            if (!hasBilling) {
                parsed.system.unshift({
                    type: "text",
                    text: billingHeader,
                });
            }
            else {
                billingHeader = parsed.system[0]?.text || billingHeader;
            }
            // If we have a locally captured Claude Code system prompt, prefer it.
            if (cachedClaudeSystem) {
                const rewritten = rewriteSystemBlocksForModel(cachedClaudeSystem, typeof parsed.model === "string" ? parsed.model : undefined);
                parsed.system = [
                    { type: "text", text: billingHeader },
                    ...rewritten,
                ];
            }
            else if (parsed.system && Array.isArray(parsed.system)) {
                // Otherwise keep the existing prompt but shape it closer to Claude Code.
                parsed.system = normalizeSystemBlocks(parsed.system);
                parsed.system = stripSystemCacheControl(parsed.system);
            }
            // Keep OpenCode's default tool schemas for non-Claude targets.
            // Claude wire schemas are only useful for Anthropic-native
            // requests or Claude-family models on Anthropic-compatible
            // routers such as OpenRouter.
            if (shouldInjectClaudeTools({
                model: parsed.model,
                requestUrl,
                tools: parsed.tools,
            })) {
                parsed.tools = getClaudeToolsForActiveOpenCodeTools(parsed.tools);
            }
            delete parsed.tool_choice;
            // Normalize message content blocks:
            // - Translate tool names (OpenCode → Claude Code)
            // - Translate tool_use input arguments (camelCase → snake_case)
            // - Clean up text blocks
            // - Strip OpenCode-specific fields that Anthropic rejects
            if (parsed.messages && Array.isArray(parsed.messages)) {
                for (const msg of parsed.messages) {
                    if (!Array.isArray(msg.content))
                        continue;
                    for (const block of msg.content) {
                        if (block.type === "text" &&
                            typeof block.text === "string") {
                            block.text = maybeUnquoteText(block.text);
                            delete block.cache_control;
                        }
                        if (block.type === "tool_use" && block.name) {
                            block.name = mapOutboundToolName(block.name);
                            if (block.input && typeof block.input === "object") {
                                block.input = translateArgsOpencodeToClaude(block.name, block.input as Record<string, unknown>);
                            }
                        }
                    }
                    // Second pass: strip OpenCode-only metadata after
                    // normalization so logging reflects final payload.
                    msg.content = sanitizeMessageContent(msg.content, parsed.thinking);
                }
            }
            // ── DEBUG: dump last message before fetch ──
            if (BRIDGE_DEBUG) {
                const last = Array.isArray(parsed.messages)
                    ? parsed.messages[parsed.messages.length - 1]
                    : null;
                const roleChain = Array.isArray(parsed.messages)
                    ? parsed.messages
                        .map((m: {
                        role: string;
                    }) => m.role)
                        .join("->")
                    : "<no messages>";
                writeBridgeLog(`DEBUG request model=${parsed.model} messagesCount=${Array.isArray(parsed.messages)
                    ? parsed.messages.length
                    : 0} lastRole=${last?.role} roleChain=${roleChain}`);
                if (last) {
                    const contentStr = typeof last.content === "string"
                        ? last.content
                        : JSON.stringify(last.content);
                    writeBridgeLog(`DEBUG lastMessage role=${last.role} contentType=${typeof last.content} content=${JSON.stringify(contentStr).slice(0, 1000)}`);
                }
                writeBridgeLog(`DEBUG thinking=${JSON.stringify(parsed.thinking)} context_management=${JSON.stringify(parsed.context_management)} output_config=${JSON.stringify(parsed.output_config)}`);
                writeBridgeLog(`DEBUG fullRequestBody=${JSON.stringify(parsed)}`);
            }
            body = JSON.stringify(parsed);
            writeBridgeLog(`fetch final model=${parsed.model} messagesCount=${Array.isArray(parsed.messages)
                ? parsed.messages.length
                : "N/A"} lastRole=${parsed.messages &&
                Array.isArray(parsed.messages) &&
                parsed.messages.length > 0
                ? parsed.messages[parsed.messages.length - 1].role
                : "N/A"}`);
            const url = new URL(request.url);
            if (url.pathname === "/messages")
                url.pathname = "/v1/messages";
            if (url.pathname === "/v1/messages" && !url.searchParams.has("beta"))
                url.searchParams.set("beta", "true");
            headers.delete("content-length");
            const prepared = new Request(request, { body, headers });
            const output = url.href === prepared.url ? prepared : new Request(url, prepared);
            requests.set(output, body);
            return output;
        },
        async response(request: Request, original: Response): Promise<Response> {
            const body = requests.get(request);
            if (body === undefined)
                return original;
            requests.delete(request);
            let response = original;
            for (let retry = 0; response.status === 429 && retry < 2; retry++) {
                const tokens = await auth.refresh();
                const headers = new Headers(request.headers);
                headers.set("authorization", `Bearer ${tokens.access}`);
                await response.body?.cancel();
                await delay(1000 * (retry + 1), undefined, { signal: request.signal });
                response = await globalThis.fetch(request.url, { method: request.method, headers, body, signal: request.signal });
            }
            writeBridgeLog(`fetch response status=${response.status} statusText=${response.statusText}`);
            if (!response.ok || !response.body)
                return response;
            const type = response.headers.get("content-type") || "";
            if (!type.includes("text/event-stream") && !type.includes("application/json"))
                return response;
            const headers = new Headers(response.headers);
            headers.delete("content-length");
            headers.delete("content-encoding");
            if (type.includes("application/json")) {
                const parsed = await response.json();
                if (Array.isArray(parsed.content)) {
                    for (const block of parsed.content) {
                        if (block.type !== "tool_use" || typeof block.name !== "string")
                            continue;
                        const name = block.name;
                        block.name = INBOUND_TOOL_NAME_MAP[name] || name;
                        if (block.input && typeof block.input === "object")
                            block.input = JSON.parse(translateToolArgsJsonString(JSON.stringify(block.input), name));
                    }
                }
                return new Response(JSON.stringify(parsed), { status: response.status, statusText: response.statusText, headers });
            }
            const processor = createSseProcessor({ inboundToolNameMap: INBOUND_TOOL_NAME_MAP, translateToolArgs: translateToolArgsJsonString });
            const decoder = new TextDecoder();
            const encoder = new TextEncoder();
            const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                    const output = processor.feedChunk(decoder.decode(chunk, { stream: true }));
                    if (output)
                        controller.enqueue(encoder.encode(output));
                },
                flush(controller) {
                    const output = processor.feedChunk(decoder.decode()) + processor.flush();
                    if (output)
                        controller.enqueue(encoder.encode(output));
                },
            }));
            return new Response(stream, { status: response.status, statusText: response.statusText, headers });
        },
    };
}
