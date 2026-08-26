import * as http from "node:http";
import type {AddressInfo} from "node:net";
import {afterEach, describe, expect, it} from "vitest";

import {
    configurePromptCacheProxy,
    resolvePromptCacheUpstream,
    startPromptCacheProxy,
    type PromptCacheProxy,
} from "../PromptCacheProxy";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
    await Promise.all(closeCallbacks.splice(0).map(close => close()));
});

describe("PromptCacheProxy", () => {
    it("replaces per-session Responses cache keys and streams the response", async () => {
        let forwardedBody: unknown;
        const upstream = await startServer((request, response) => {
            void readJson(request).then(body => {
                forwardedBody = body;
                response.writeHead(200, {"content-type": "text/event-stream"});
                response.end("data: response.completed\n\n");
            });
        });
        const proxy = await startProxy("anvil-agent:v1", `${upstream.baseUrl}/backend-api/codex`);

        const result = await fetch(`${proxy.baseUrl}/responses`, {
            method: "POST",
            headers: {"content-type": "application/json"},
            body: JSON.stringify({model: "gpt-5.6", prompt_cache_key: "session-uuid", input: []}),
        });

        expect(result.status).toBe(200);
        expect(await result.text()).toBe("data: response.completed\n\n");
        expect(forwardedBody).toEqual({
            model: "gpt-5.6",
            prompt_cache_key: "anvil-agent:v1",
            input: [],
        });
        expect(upstream.requests).toEqual(["/backend-api/codex/responses"]);
    });

    it("does not rewrite unrelated JSON requests", async () => {
        let forwardedBody: unknown;
        const upstream = await startServer((request, response) => {
            void readJson(request).then(body => {
                forwardedBody = body;
                response.end("ok");
            });
        });
        const proxy = await startProxy("anvil-agent:v1", upstream.baseUrl);

        await fetch(`${proxy.baseUrl}/models`, {
            method: "POST",
            headers: {"content-type": "application/json"},
            body: JSON.stringify({prompt_cache_key: "session-uuid"}),
        });

        expect(forwardedBody).toEqual({prompt_cache_key: "session-uuid"});
    });

    it("adds a non-WebSocket provider without discarding existing config", () => {
        expect(configurePromptCacheProxy({
            model_reasoning_effort: "low",
            features: {example: true},
            model_providers: {existing: {base_url: "https://example.com"}},
        }, "http://127.0.0.1:1234")).toEqual({
            config: {
                model_reasoning_effort: "low",
                features: {example: true, enable_request_compression: false},
                model_providers: {
                    existing: {base_url: "https://example.com"},
                    "anvil-prompt-cache": {
                        name: "OpenAI",
                        base_url: "http://127.0.0.1:1234",
                        wire_api: "responses",
                        requires_openai_auth: true,
                        supports_websockets: false,
                        supports_standalone_web_search: true,
                    },
                },
            },
            modelProvider: "anvil-prompt-cache",
        });
    });

    it("selects the standard OpenAI upstream for the active auth mode", () => {
        expect(resolvePromptCacheUpstream(undefined, undefined, {})).toBe(
            "https://chatgpt.com/backend-api/codex",
        );
        expect(resolvePromptCacheUpstream(undefined, undefined, {CODEX_API_KEY: "secret"})).toBe(
            "https://api.openai.com/v1",
        );
        expect(resolvePromptCacheUpstream({openai_base_url: "https://proxy.example/v1"}, "openai", {})).toBe(
            "https://proxy.example/v1",
        );
        expect(resolvePromptCacheUpstream(undefined, "custom-provider", {})).toBeNull();
    });
});

async function startProxy(key: string, upstreamBaseUrl: string): Promise<PromptCacheProxy> {
    const proxy = await startPromptCacheProxy(key, upstreamBaseUrl);
    closeCallbacks.push(proxy.close);
    return proxy;
}

async function startServer(handler: http.RequestListener): Promise<{
    baseUrl: string;
    requests: string[];
}> {
    const requests: string[] = [];
    const server = http.createServer((request, response) => {
        requests.push(request.url ?? "");
        handler(request, response);
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    closeCallbacks.push(() => new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    }));
    const address = server.address() as AddressInfo;
    return {baseUrl: `http://127.0.0.1:${address.port}`, requests};
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
