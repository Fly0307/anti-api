import consola from "consola"
import https from "https"
import { authStore } from "~/services/auth/store"
import { UpstreamError } from "~/lib/error"
import type { ProviderAccount } from "~/services/auth/types"
import type { ClaudeMessage, ClaudeTool } from "~/lib/translator"
import { toOpenAIMessages, toOpenAITools } from "~/services/providers/openai-adapter"

const COPILOT_INSECURE_TLS = process.env.ANTI_API_COPILOT_INSECURE_TLS === "1"
const COPILOT_INSECURE_AGENT = COPILOT_INSECURE_TLS ? new https.Agent({ rejectUnauthorized: false }) : undefined

export function isCopilotInsecureTlsEnabled(): boolean {
    return COPILOT_INSECURE_TLS
}

const COPILOT_COMPLETIONS_URL = "https://api.githubcopilot.com/chat/completions"
const COPILOT_RESPONSES_URL = "https://api.githubcopilot.com/responses"
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token"
const COPILOT_MODELS_URL = "https://api.githubcopilot.com/models"

interface CopilotTokenResponse {
    token: string
    expires_at?: number
}

export interface CopilotModelInfo {
    id: string
    name?: string
    model_picker_enabled?: boolean
    vendor?: string
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>()
const modelsCache = new Map<string, { models: CopilotModelInfo[]; expiresAt: number }>()

function normalizeCopilotModels(models: CopilotModelInfo[]): CopilotModelInfo[] {
    const deduped = new Map<string, CopilotModelInfo>()

    for (const model of models) {
        const id = model?.id?.trim()
        if (!id) continue
        if (model.model_picker_enabled === false) continue
        if (deduped.has(id)) continue

        deduped.set(id, {
            ...model,
            id,
        })
    }

    return Array.from(deduped.values())
}

// Map internal model names to Copilot API compatible names
// Based on GitHub Copilot Pro supported models:
// Anthropic: claude-haiku-4.5, claude-opus-4.1, claude-opus-4.5, claude-sonnet-4, claude-sonnet-4.5
// OpenAI: gpt-4.1, gpt-4o, gpt-5, gpt-5-mini, gpt-5.1, gpt-5.1-codex, gpt-5.1-codex-max, gpt-5.2
// Google: gemini-2.5-pro, gemini-3-flash, gemini-3-pro
function mapCopilotModelName(model: string): string {
    const modelMappings: Record<string, string> = {
        // Claude models - map hyphenated to dotted format
        "claude-sonnet-4-5": "claude-sonnet-4.5",
        "claude-sonnet-4-5-thinking": "claude-sonnet-4.5", // No thinking variant in Copilot
        "claude-opus-4-5": "claude-opus-4.5",
        "claude-opus-4-5-thinking": "claude-opus-4.5",
        "claude-opus-4-1": "claude-opus-4.1",
        "claude-haiku-4-5": "claude-haiku-4.5",
        "claude-sonnet-4": "claude-sonnet-4",
        // GPT models
        "gpt-4.1": "gpt-4.1",
        "gpt-4.1-mini": "gpt-4.1-mini",
        "gpt-4o": "gpt-4o",
        "gpt-4o-mini": "gpt-4o-mini",
        "gpt-5": "gpt-5",
        "gpt-5-mini": "gpt-5-mini",
        "gpt-5.1": "gpt-5.1",
        "gpt-5.1-codex": "gpt-5.1-codex",
        "gpt-5.2": "gpt-5.2",
        // Gemini models
        "gemini-2.5-pro": "gemini-2.5-pro",
        "gemini-3-flash": "gemini-3-flash",
        "gemini-3-pro": "gemini-3-pro",
    }

    const mapped = modelMappings[model]
    if (mapped) {
        return mapped
    }
    return model
}

interface OpenAIResponse {
    choices: Array<{
        message?: { content?: string | null; tool_calls?: any[] }
        finish_reason?: string | null
    }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
}

type OpenAIMessage = ReturnType<typeof toOpenAIMessages>[number]

function shouldUseResponsesForModel(model: string): boolean {
    const normalized = model.trim().toLowerCase()
    return normalized.includes("codex")
}

function isUnsupportedChatEndpointError(status: number, body: string): boolean {
    if (status !== 400) return false
    const text = body.toLowerCase()
    return text.includes("unsupported_api_for_model")
        || (text.includes("/chat/completions") && text.includes("not accessible"))
}

function parseResponsesSSE(sseText: string): any {
    const lines = sseText.split("\n")
    const textChunks: string[] = []
    let lastResponse: any = null

    for (const line of lines) {
        if (!line.startsWith("data:")) continue
        const data = line.slice(5).trim()
        if (data === "[DONE]") continue
        try {
            const parsed = JSON.parse(data)
            if (parsed.type === "response.completed") {
                return parsed.response || parsed
            }
            if (parsed.type === "response.created" && parsed.response) {
                lastResponse = parsed.response
            }
            if (typeof parsed?.delta === "string" && String(parsed.type || "").includes("output_text")) {
                textChunks.push(parsed.delta)
            } else if (typeof parsed?.text === "string" && String(parsed.type || "").includes("output_text")) {
                textChunks.push(parsed.text)
            } else if (typeof parsed?.output_text === "string") {
                textChunks.push(parsed.output_text)
            }
        } catch {
            // Ignore invalid JSON event payloads
        }
    }

    if (textChunks.length > 0) {
        const output = [{
            type: "message",
            content: [{ type: "output_text", text: textChunks.join("") }],
        }]
        return lastResponse ? { ...lastResponse, output } : { output }
    }

    for (const line of lines) {
        if (!line.startsWith("data:")) continue
        const data = line.slice(5).trim()
        if (data === "[DONE]") continue
        try {
            const parsed = JSON.parse(data)
            if (parsed.output || parsed.choices) {
                return parsed
            }
        } catch {
            // Ignore invalid JSON event payloads
        }
    }

    if (lastResponse) {
        return { ...lastResponse, output: [] }
    }

    throw new Error("No valid response found in SSE stream")
}

function buildCompletionFromResponses(payload: any): OpenAIResponse {
    const output = Array.isArray(payload?.output) ? payload.output : []
    const textParts: string[] = []
    const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = []

    for (const item of output) {
        if (item?.type === "message" && Array.isArray(item.content)) {
            for (const content of item.content) {
                if ((content?.type === "output_text" || content?.type === "text") && typeof content.text === "string") {
                    textParts.push(content.text)
                }
                if (content?.type === "tool_call") {
                    toolCalls.push({
                        id: content.id || `tool_${crypto.randomUUID().slice(0, 8)}`,
                        type: "function",
                        function: {
                            name: content.name || "tool",
                            arguments: typeof content.arguments === "string"
                                ? content.arguments
                                : JSON.stringify(content.arguments || {}),
                        },
                    })
                }
            }
        } else if (item?.type === "tool_call") {
            toolCalls.push({
                id: item.id || `tool_${crypto.randomUUID().slice(0, 8)}`,
                type: "function",
                function: {
                    name: item.name || "tool",
                    arguments: typeof item.arguments === "string"
                        ? item.arguments
                        : JSON.stringify(item.arguments || {}),
                },
            })
        } else if (item?.type === "function_call") {
            toolCalls.push({
                id: item.call_id || item.id || `tool_${crypto.randomUUID().slice(0, 8)}`,
                type: "function",
                function: {
                    name: item.name || "tool",
                    arguments: typeof item.arguments === "string"
                        ? item.arguments
                        : JSON.stringify(item.arguments || {}),
                },
            })
        } else if (item?.type === "output_text" && typeof item.text === "string") {
            textParts.push(item.text)
        }
    }

    if (textParts.length === 0 && typeof payload?.output_text === "string") {
        textParts.push(payload.output_text)
    }

    return {
        choices: [
            {
                message: {
                    content: textParts.join(""),
                    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
                },
                finish_reason: payload?.stop_reason || null,
            },
        ],
        usage: {
            prompt_tokens: payload?.usage?.input_tokens || 0,
            completion_tokens: payload?.usage?.output_tokens || 0,
        },
    }
}

function toCopilotResponsesInput(messages: OpenAIMessage[]): any[] {
    const input: any[] = []

    for (const msg of messages) {
        if (msg.role === "user") {
            input.push({
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: msg.content || "" }],
            })
        } else if (msg.role === "assistant") {
            input.push({
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: msg.content || "" }],
            })
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                for (const toolCall of msg.tool_calls) {
                    input.push({
                        type: "function_call",
                        call_id: toolCall.id,
                        name: toolCall.function.name,
                        arguments: toolCall.function.arguments,
                    })
                }
            }
        } else if (msg.role === "tool") {
            input.push({
                type: "function_call_output",
                call_id: msg.tool_call_id,
                output: msg.content || "",
            })
        }
    }

    return input
}

async function requestCopilotChatCompletion(
    apiToken: string,
    model: string,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    maxTokens?: number
): Promise<OpenAIResponse> {
    const requestBody = {
        model,
        messages: toOpenAIMessages(messages),
        tools: toOpenAITools(tools),
        max_tokens: maxTokens,
    }

    const response = await fetchInsecureJson(COPILOT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiToken}`,
            "User-Agent": "anti-api/1.0",
            "Editor-Version": "vscode/1.95.0",
            "Editor-Plugin-Version": "copilot/1.300.0",
        },
        body: JSON.stringify(requestBody),
    })

    if (response.status < 200 || response.status >= 300) {
        throw new UpstreamError("copilot", response.status, response.text, undefined)
    }

    return response.data as OpenAIResponse
}

async function requestCopilotResponsesCompletion(
    apiToken: string,
    model: string,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    maxTokens?: number
): Promise<OpenAIResponse> {
    const openAIMessages = toOpenAIMessages(messages)
    const systemMessage = messages.find(message => message.role === "system")
    const instructions = typeof systemMessage?.content === "string" && systemMessage.content.trim().length > 0
        ? systemMessage.content
        : "You are a helpful assistant."
    const openAITools = toOpenAITools(tools)
    const responsesTools = openAITools?.map(tool => ({
        type: "function" as const,
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
    }))

    const requestBody = {
        model,
        input: toCopilotResponsesInput(openAIMessages),
        tools: responsesTools,
        instructions,
        max_output_tokens: maxTokens,
        stream: true,
        store: false,
        parallel_tool_calls: true,
    }

    const response = await fetchInsecureJson(COPILOT_RESPONSES_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiToken}`,
            "User-Agent": "anti-api/1.0",
            "Editor-Version": "vscode/1.95.0",
            "Editor-Plugin-Version": "copilot/1.300.0",
            "Openai-Beta": "responses=experimental",
        },
        body: JSON.stringify(requestBody),
    })

    if (response.status < 200 || response.status >= 300) {
        throw new UpstreamError("copilot", response.status, response.text, undefined)
    }

    const parsed = response.data && (response.data.output || response.data.choices)
        ? response.data
        : parseResponsesSSE(response.text)
    return buildCompletionFromResponses(parsed)
}

export async function createCopilotCompletion(
    account: ProviderAccount,
    model: string,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    maxTokens?: number
) {
    const apiToken = await getCopilotApiToken(account)

    // Fetch and log available models (first call will log, subsequent uses cache)
    await fetchCopilotModels(apiToken)

    // Map model name to Copilot-compatible format
    const mappedModel = mapCopilotModelName(model)
    let data: OpenAIResponse
    const preferResponses = shouldUseResponsesForModel(mappedModel)
    if (preferResponses) {
        data = await requestCopilotResponsesCompletion(apiToken, mappedModel, messages, tools, maxTokens)
    } else {
        try {
            data = await requestCopilotChatCompletion(apiToken, mappedModel, messages, tools, maxTokens)
        } catch (error) {
            if (error instanceof UpstreamError && isUnsupportedChatEndpointError(error.status, error.body)) {
                consola.warn(`Copilot model ${mappedModel} is not available on /chat/completions, retrying with /responses`)
                data = await requestCopilotResponsesCompletion(apiToken, mappedModel, messages, tools, maxTokens)
            } else {
                throw error
            }
        }
    }

    const choice = data?.choices?.[0]
    const content = choice?.message?.content || ""
    const toolCalls = choice?.message?.tool_calls || []

    const contentBlocks = []
    if (toolCalls.length > 0) {
        for (const call of toolCalls) {
            contentBlocks.push({
                type: "tool_use" as const,
                id: call.id || `tool_${crypto.randomUUID().slice(0, 8)}`,
                name: call.function?.name || "tool",
                input: safeParse(call.function?.arguments),
            })
        }
    }
    if (content) {
        contentBlocks.push({ type: "text" as const, text: content })
    }

    authStore.markSuccess("copilot", account.id)

    return {
        contentBlocks,
        stopReason: toolCalls.length > 0 ? "tool_use" : mapFinishReason(choice?.finish_reason),
        usage: {
            inputTokens: data.usage?.prompt_tokens || 0,
            outputTokens: data.usage?.completion_tokens || 0,
        },
    }
}

export async function listCopilotModelsForAccount(account: ProviderAccount): Promise<CopilotModelInfo[]> {
    const apiToken = await getCopilotApiToken(account)
    return fetchCopilotModels(apiToken)
}

async function getCopilotApiToken(account: ProviderAccount): Promise<string> {
    const cached = tokenCache.get(account.id)
    if (cached && cached.expiresAt > Date.now()) {
        return cached.token
    }

    const response = await fetchInsecureJson(COPILOT_TOKEN_URL, {
        method: "GET",
        headers: {
            Authorization: `Bearer ${account.accessToken}`,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    })

    const data = response.data as CopilotTokenResponse
    if (response.status < 200 || response.status >= 300 || !data?.token) {
        throw new Error(`copilot:token:${response.status}:${response.text}`)
    }

    const expiresAt = data.expires_at ? data.expires_at * 1000 : Date.now() + 10 * 60 * 1000
    tokenCache.set(account.id, { token: data.token, expiresAt })
    return data.token
}

function safeParse(value: string | undefined): any {
    if (!value) return {}
    try {
        return JSON.parse(value)
    } catch (error) {
        consola.warn("Copilot tool args parse failed:", error)
        return {}
    }
}

function mapFinishReason(reason?: string | null): string {
    if (!reason || reason === "stop") return "end_turn"
    if (reason === "length") return "max_tokens"
    if (reason === "tool_calls") return "tool_use"
    return reason
}

async function fetchCopilotModels(apiToken: string): Promise<CopilotModelInfo[]> {
    const cached = modelsCache.get(apiToken)
    if (cached && cached.expiresAt > Date.now()) {
        return cached.models
    }

    try {
        const response = await fetchInsecureJson(COPILOT_MODELS_URL, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${apiToken}`,
                "Accept": "application/json",
                "User-Agent": "GithubCopilot/1.0",
                "Editor-Version": "vscode/1.100.0",
                "Editor-Plugin-Version": "copilot/1.300.0",
            },
        })

        if (response.status < 200 || response.status >= 300) {
            consola.warn("Failed to fetch Copilot models:", response.status)
            return []
        }

        const data = response.data as { data: CopilotModelInfo[] }
        const models = normalizeCopilotModels(data?.data || [])

        modelsCache.set(apiToken, { models, expiresAt: Date.now() + 5 * 60 * 1000 })
        return models
    } catch (error) {
        consola.warn("Error fetching Copilot models:", error)
        return []
    }
}

// Insecure JSON fetch using Node.js https module to bypass TLS certificate errors
type InsecureResponse = { status: number; data: any; text: string }

async function fetchInsecureJson(
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<InsecureResponse> {
    const target = new URL(url)
    const method = options.method || "GET"
    const headers = {
        "User-Agent": "anti-api/1.0",
        ...(options.headers || {}),
    }
    const agent = COPILOT_INSECURE_AGENT

    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                protocol: target.protocol,
                hostname: target.hostname,
                port: target.port || 443,
                path: `${target.pathname}${target.search}`,
                method,
                headers,
                agent,
                rejectUnauthorized: agent ? false : true,
                timeout: 30000,
            },
            (res) => {
                let body = ""
                res.on("data", (chunk) => {
                    body += chunk
                })
                res.on("end", () => {
                    let data: any = null
                    if (body) {
                        try {
                            data = JSON.parse(body)
                        } catch {
                            data = null
                        }
                    }
                    resolve({
                        status: res.statusCode || 0,
                        data,
                        text: body,
                    })
                })
            }
        )

        req.on("error", (error) => {
            if (!COPILOT_INSECURE_TLS && /certificate|self signed/i.test(error.message)) {
                reject(new Error("Copilot TLS certificate error. Set ANTI_API_COPILOT_INSECURE_TLS=1 to bypass."))
                return
            }
            reject(error)
        })
        req.on("timeout", () => {
            req.destroy(new Error("Request timed out"))
        })

        if (options.body) {
            req.write(options.body)
        }
        req.end()
    })
}
