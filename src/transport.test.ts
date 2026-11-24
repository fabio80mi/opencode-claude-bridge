import { it } from "node:test";
import assert from "node:assert/strict";
import { createClaudeTransport } from "./transport.js";

function request() {
	return new Request("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": "native-key" },
		body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hello" }] }),
	});
}

function oauthTransport(t: import("node:test").TestContext) {
	t.mock.method(globalThis, "fetch", async () => new Response("{}", { headers: { "content-type": "application/json" } }));
	return createClaudeTransport({
		resolve: async () => ({ access: "transport-fixture", refresh: "fixture-refresh", expires: Date.now() + 3600000 }),
		refresh: async () => { throw new Error("Unexpected token refresh"); },
		dispose() {},
	});
}

it("leaves API-key authentication and response bodies unchanged", async () => {
	const transport = createClaudeTransport({
		resolve: async () => undefined,
		refresh: async () => { throw new Error("API-key traffic must not refresh OAuth"); },
		dispose() {},
	});
	const input = request();
	assert.equal(await transport.request(input), input);
	assert.equal(input.headers.get("x-api-key"), "native-key");
	const response = new Response("native response", { status: 200 });
	assert.equal(await transport.response(input, response), response);
	assert.equal(await response.text(), "native response");
});

it("rejects malformed OAuth JSON instead of forwarding a partial rewrite", async (t) => {
	const transport = oauthTransport(t);
	await assert.rejects(transport.request(new Request("https://api.anthropic.com/v1/messages", {
		method: "POST", body: "{invalid", headers: { "content-type": "application/json" },
	})));
});

it("preserves native Anthropic error bodies instead of parsing them as SSE", async (t) => {
	const transport = oauthTransport(t);
	const prepared = await transport.request(request());
	const body = JSON.stringify({ error: { type: "invalid_request_error", message: "Rejected fixture" } });
	const response = new Response(body, { status: 400, headers: { "content-type": "application/json" } });
	const output = await transport.response(prepared, response);
	assert.equal(output.status, 400);
	assert.equal(await output.text(), body);
});

it("translates tool calls in non-streaming Anthropic responses", async (t) => {
	const transport = oauthTransport(t);
	const prepared = await transport.request(request());
	const response = await transport.response(prepared, new Response(JSON.stringify({
		content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/fixture.txt" } }],
	}), { headers: { "content-type": "application/json" } }));
	const body = await response.json();
	assert.equal(body.content[0].name, "read");
	assert.deepEqual(body.content[0].input, { filePath: "/fixture.txt" });
});

it("cancels the upstream SSE stream when the consumer cancels", async (t) => {
	const transport = oauthTransport(t);
	const prepared = await transport.request(request());
	let cancelled: unknown;
	const response = await transport.response(prepared, new Response(new ReadableStream({
		cancel(reason) { cancelled = reason; },
	}), { headers: { "content-type": "text/event-stream" } }));
	await response.body!.cancel("user interrupted");
	assert.equal(cancelled, "user interrupted");
});
