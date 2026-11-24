import { Credential, Integration, type Plugin } from "@opencode/plugin";
import { getClaudeTokens, readClaudeCredentials } from "./keychain.js";
import { createAuthorizationRequest, exchangeCodeForTokens, parseAuthCode, refreshTokens, startOAuthCallbackServer, type OAuthCallbackServer, type OAuthTokens, } from "./oauth.js";
const METHOD_ID = Integration.MethodID.make("oauth");
export interface ClaudeAuth {
    resolve(): Promise<OAuthTokens | undefined>;
    refresh(): Promise<OAuthTokens>;
    dispose(): void;
}
function credential(tokens: OAuthTokens): Credential.OAuth {
    return { type: "oauth", methodID: METHOD_ID, ...tokens };
}
function renew(previous: Credential.OAuth): Credential.OAuth {
    const cli = getClaudeTokens({ refreshExpired: false });
    if (cli)
        return credential(cli);
    const candidates = new Set([previous.refresh, readClaudeCredentials()?.claudeAiOauth.refreshToken]);
    let failure: unknown;
    for (const refresh of candidates) {
        if (!refresh)
            continue;
        try {
            return credential(refreshTokens(refresh));
        }
        catch (error) {
            failure = error;
        }
    }
    throw failure ?? new Error("No usable Claude OAuth refresh token. Run `claude login` or reconnect Claude Pro / Max.");
}
export async function registerClaudeAuth(ctx: Plugin.Context): Promise<ClaudeAuth> {
    const pending = new Set<OAuthCallbackServer>();
    await ctx.integration.transform((editor) => {
        if (!editor.get("anthropic"))
            throw new Error("Claude bridge requires OpenCode's Anthropic integration.");
        editor.method.update({
            integrationID: "anthropic",
            method: { id: METHOD_ID, type: "oauth", label: "Claude Pro / Max (OAuth)" },
            refresh: async (previous) => renew(previous),
            authorize: async () => {
                const cli = getClaudeTokens();
                if (cli)
                    return {
                        url: "https://claude.ai",
                        instructions: "Claude CLI credentials found. Complete the connection without entering a code.",
                        mode: "code" as const,
                        callback: async () => credential(cli),
                    };
                let server: OAuthCallbackServer;
                try {
                    server = await startOAuthCallbackServer();
                }
                catch {
                    const flow = createAuthorizationRequest();
                    return {
                        url: flow.url, instructions: "Authorize Claude, then paste the authorization code.",
                        mode: "code" as const,
                        callback: async (raw: string) => {
                            const code = parseAuthCode(raw);
                            if (!code)
                                throw new Error("No authorization code received.");
                            return credential(exchangeCodeForTokens(code, flow.verifier));
                        },
                    };
                }
                pending.add(server);
                const manual = Promise.withResolvers<OAuthTokens>();
                const automatic = server.waitForCode().then((code) => exchangeCodeForTokens(code, server.verifier, `http://localhost:${server.port}/callback`));
                const callback = Promise.race([automatic, manual.promise]).then(credential).finally(() => {
                    server.close();
                    pending.delete(server);
                });
                return {
                    url: server.url,
                    instructions: `Authorize Claude in your browser. If the callback cannot reach this machine, use ${server.manualUrl} and paste the redirect URL.`,
                    mode: "auto" as const, callback,
                    submit: async (redirect: string) => {
                        const url = new URL(redirect);
                        if (url.searchParams.get("state") !== server.state)
                            throw new Error("OAuth state mismatch.");
                        const code = url.searchParams.get("code");
                        if (!code)
                            throw new Error("No authorization code received.");
                        const manualRedirect = new URL(server.manualUrl).searchParams.get("redirect_uri")!;
                        manual.resolve(exchangeCodeForTokens(code, server.verifier, manualRedirect));
                    },
                };
            },
        });
        const methods = editor.method.list("anthropic");
        if (!methods.some((method) => method.type === "key"))
            editor.method.update({ integrationID: "anthropic", method: { type: "key", label: "Claude API Key" } });
        if (!methods.some((method) => method.type === "env"))
            editor.method.update({ integrationID: "anthropic", method: { type: "env", names: ["ANTHROPIC_API_KEY"] } });
    });
    if (!await ctx.integration.connection.active("anthropic") && getClaudeTokens()) {
        const attempt = await ctx.integration.oauth.connect({ integrationID: "anthropic", methodID: METHOD_ID });
        await ctx.integration.oauth.complete({ integrationID: "anthropic", attemptID: attempt.data.attemptID, code: "" });
    }
    const resolve = async (): Promise<OAuthTokens | undefined> => {
        const connection = await ctx.integration.connection.active("anthropic");
        if (!connection)
            return undefined;
        const value = await ctx.integration.connection.resolve(connection);
        if (value?.type !== "oauth")
            return undefined;
        return { access: value.access, refresh: value.refresh, expires: value.expires };
    };
    return {
        resolve,
        // OpenCode refreshes and durably stores OAuth grants while resolving connections.
        async refresh() {
            const value = await resolve();
            if (!value)
                throw new Error("Claude OAuth connection is no longer active.");
            return value;
        },
        dispose() { for (const server of pending)
            server.close(); pending.clear(); },
    };
}
