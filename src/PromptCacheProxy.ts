import * as http from "node:http";
import * as https from "node:https";
import type {AddressInfo} from "node:net";

const PROXY_PROVIDER_ID = "anvil-prompt-cache";
const OPENAI_PROVIDER_ID = "openai";
const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const HOP_BY_HOP_HEADERS = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
]);

export interface PromptCacheProxy {
    baseUrl: string;
    close(): Promise<void>;
}

export interface PromptCacheProxyConfig {
    config: Record<string, unknown>;
    modelProvider: string;
}

export function resolvePromptCacheUpstream(
    config: Record<string, unknown> | undefined,
    modelProvider: string | undefined,
    env: NodeJS.ProcessEnv,
): string | null {
    const configuredProvider = modelProvider ?? (
        typeof config?.["model_provider"] === "string" ? config["model_provider"] : OPENAI_PROVIDER_ID
    );
    if (configuredProvider !== OPENAI_PROVIDER_ID) {
        return null;
    }
    if (typeof config?.["openai_base_url"] === "string") {
        return config["openai_base_url"];
    }
    return env["CODEX_API_KEY"] || env["OPENAI_API_KEY"]
        ? OPENAI_API_BASE_URL
        : CHATGPT_CODEX_BASE_URL;
}

export function configurePromptCacheProxy(
    config: Record<string, unknown> | undefined,
    proxyBaseUrl: string,
): PromptCacheProxyConfig {
    const sourceConfig = config ?? {};
    const configuredProviders = isRecord(sourceConfig["model_providers"])
        ? sourceConfig["model_providers"]
        : {};
    const features = isRecord(sourceConfig["features"]) ? sourceConfig["features"] : {};

    return {
        config: {
            ...sourceConfig,
            features: {
                ...features,
                enable_request_compression: false,
            },
            model_providers: {
                ...configuredProviders,
                [PROXY_PROVIDER_ID]: {
                    name: "OpenAI",
                    base_url: proxyBaseUrl,
                    wire_api: "responses",
                    requires_openai_auth: true,
                    supports_websockets: false,
                    supports_standalone_web_search: true,
                },
            },
        },
        modelProvider: PROXY_PROVIDER_ID,
    };
}

export async function startPromptCacheProxy(
    promptCacheKey: string,
    upstreamBaseUrl: string,
): Promise<PromptCacheProxy> {
    if (promptCacheKey.length === 0) {
        throw new Error("Prompt cache key must not be empty");
    }
    const upstream = new URL(upstreamBaseUrl);
    if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
        throw new Error(`Unsupported prompt cache upstream protocol: ${upstream.protocol}`);
    }

    const server = http.createServer((request, response) => {
        void forwardRequest(request, response, upstream, promptCacheKey);
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address() as AddressInfo;

    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        }),
    };
}

async function forwardRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    upstreamBaseUrl: URL,
    promptCacheKey: string,
): Promise<void> {
    try {
        const requestBody = await readBody(request);
        const target = targetUrl(upstreamBaseUrl, request.url ?? "/");
        const body = rewritePromptCacheKey(requestBody, request.headers["content-type"], target.pathname, promptCacheKey);
        const headers = forwardedHeaders(request.headers);
        headers.host = target.host;
        headers["content-length"] = String(body.byteLength);

        const transport = target.protocol === "https:" ? https : http;
        const upstreamRequest = transport.request(target, {
            method: request.method,
            headers,
        }, upstreamResponse => {
            response.writeHead(
                upstreamResponse.statusCode ?? 502,
                forwardedHeaders(upstreamResponse.headers),
            );
            upstreamResponse.pipe(response);
        });
        upstreamRequest.on("error", error => {
            if (!response.headersSent) {
                response.writeHead(502, {"content-type": "text/plain; charset=utf-8"});
            }
            response.end(`Prompt cache proxy upstream error: ${error.message}`);
        });
        upstreamRequest.end(body);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        response.writeHead(400, {"content-type": "text/plain; charset=utf-8"});
        response.end(`Prompt cache proxy request error: ${message}`);
    }
}

function targetUrl(upstreamBaseUrl: URL, requestUrl: string): URL {
    const incoming = new URL(requestUrl, "http://localhost");
    const target = new URL(upstreamBaseUrl);
    target.pathname = `${target.pathname.replace(/\/$/, "")}/${incoming.pathname.replace(/^\//, "")}`;
    target.search = incoming.search;
    return target;
}

function rewritePromptCacheKey(
    body: Buffer,
    contentType: string | undefined,
    pathname: string,
    promptCacheKey: string,
): Buffer {
    if (!contentType?.toLowerCase().includes("application/json") || !/\/responses(?:\/compact)?$/.test(pathname)) {
        return body;
    }
    const parsed = JSON.parse(body.toString("utf8"));
    if (!isRecord(parsed)) {
        throw new Error("Responses request body must be a JSON object");
    }
    parsed["prompt_cache_key"] = promptCacheKey;
    return Buffer.from(JSON.stringify(parsed));
}

function readBody(request: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        request.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        request.on("end", () => resolve(Buffer.concat(chunks)));
        request.on("error", reject);
    });
}

function forwardedHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
    return Object.fromEntries(
        Object.entries(headers).filter(([name]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase())),
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
