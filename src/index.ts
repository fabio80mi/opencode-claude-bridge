import { Model, Plugin, Provider } from "@opencode/plugin";
import { Money } from "@opencode/schema/money";
import { registerClaudeAuth } from "./auth.js";
import { createClaudeTransport } from "./transport.js";
const FALLBACK_MODELS = [
    { id: "claude-opus-4-6", name: "Claude Opus 4.6", output: 32000, temperature: false, input: 15, price: 75, read: 1.5, write: 18.75 },
    { id: "claude-opus-4-5", name: "Claude Opus 4.5", output: 32000, temperature: false, input: 15, price: 75, read: 1.5, write: 18.75 },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", output: 64000, temperature: false, input: 3, price: 15, read: 0.3, write: 3.75 },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", output: 8192, temperature: false, input: 3, price: 15, read: 0.3, write: 3.75 },
    { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", output: 8192, temperature: true, input: 0.8, price: 4, read: 0.08, write: 1 },
];
export default Plugin.define({
    id: "opencode-claude-bridge",
    async setup(ctx) {
        await ctx.provider.transform((editor) => {
            const source = editor.get("anthropic");
            if (!source)
                throw new Error("Claude bridge requires OpenCode's built-in Anthropic provider.");
            const models = [...source.models.values()];
            for (const definition of FALLBACK_MODELS) {
                if (source.models.has(definition.id))
                    continue;
                models.push({
                    ...Model.Info.default(Provider.ID.anthropic, Model.ID.make(definition.id)),
                    name: definition.name,
                    capabilities: { tools: true, input: ["text", "image"], output: ["text"], temperature: definition.temperature },
                    limit: { context: 200000, output: definition.output },
                    cost: [{
                            input: Money.USDPerMillionTokens.make(definition.input),
                            output: Money.USDPerMillionTokens.make(definition.price),
                            cache: {
                                read: Money.USDPerMillionTokens.make(definition.read),
                                write: Money.USDPerMillionTokens.make(definition.write),
                            },
                        }],
                });
            }
            editor.models.set("anthropic", models);
        });
        const auth = await registerClaudeAuth(ctx);
        const transport = createClaudeTransport(auth);
        await ctx.session.hook("http.request", async (event) => {
            event.request = await transport.request(event.request);
        }, { providerID: "anthropic" });
        await ctx.session.hook("http.response", async (event) => {
            event.response = await transport.response(event.request, event.response);
        }, { providerID: "anthropic" });
        return () => auth.dispose();
    },
});
