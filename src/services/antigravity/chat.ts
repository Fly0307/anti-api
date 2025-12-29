/**
 * Antigravity Chat Service - Cloud API Version
 * 
 * 使用 Antigravity Cloud API (cloudcode-pa.googleapis.com)
 * 这是使用 Antigravity 内置付费额度的正确方式
 */

import consola from "consola"
import { getAccessToken } from "./oauth"
import { state } from "~/lib/state"
import {
    antigravityToClaudeSSE,
    createConversionState,
    type ClaudeMessage,
    type ClaudeTool
} from "~/lib/translator"

// Antigravity Cloud API 配置
const ANTIGRAVITY_BASE_URLS = [
    "https://daily-cloudcode-pa.googleapis.com",
    "https://daily-cloudcode-pa.sandbox.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
]
const GENERATE_ENDPOINT = "/v1internal:generateContent"
const STREAM_ENDPOINT = "/v1internal:streamGenerateContent"
const DEFAULT_USER_AGENT = "antigravity/1.104.0 darwin/arm64"

/**
 * 模型 ID 映射表
 * 将用户友好的模型名转换为 Antigravity API 认识的格式
 * 
 * 7 个配额面板可见模型（已确认可用）:
 * - Claude Sonnet 4.5 / Thinking
 * - Claude Opus 4.5 (Thinking)
 * - Gemini 3 Pro High / Low / Flash
 * - GPT-OSS 120B
 */
const MODEL_MAPPING: Record<string, string> = {
    // Claude 4.5 系列 - 已确认工作
    "claude-sonnet-4-5": "claude-sonnet-4-5",
    "claude-sonnet-4-5-thinking": "claude-sonnet-4-5-thinking",
    "claude-opus-4-5-thinking": "claude-opus-4-5-thinking",

    // Claude Code 使用的带日期后缀版本
    "claude-sonnet-4-5-20251001": "claude-sonnet-4-5",
    "claude-sonnet-4-5-20251022": "claude-sonnet-4-5",
    "claude-haiku-4-5-20251001": "claude-sonnet-4-5",  // haiku 不可用，fallback 到 sonnet
    "claude-haiku-4-5-20251022": "claude-sonnet-4-5",

    // Gemini 3 系列 - 已确认工作
    "gemini-3-pro-high": "gemini-3-pro-high",
    "gemini-3-pro-low": "gemini-3-pro-low",
    "gemini-3-flash": "gemini-3-flash",

    // GPT-OSS 系列 - 需要完整名称带 -medium 后缀
    "gpt-oss-120b": "gpt-oss-120b-medium",
    "gpt-oss-120b-medium": "gpt-oss-120b-medium",

    // 隐藏模型（可能不可用，保持原名尝试）
    "claude-haiku-4-5": "claude-sonnet-4-5",  // haiku 不可用，fallback 到 sonnet
    "claude-haiku-4-5-thinking": "claude-sonnet-4-5-thinking",
    "claude-opus-4": "claude-opus-4",
    "claude-opus-4-thinking": "claude-opus-4-thinking",
    "claude-sonnet-4": "claude-sonnet-4",
    "claude-sonnet-4-thinking": "claude-sonnet-4-thinking",
    "gemini-3-pro": "gemini-3-pro",
    "gemini-2-5-pro": "gemini-2-5-pro",
    "gemini-2-5-flash": "gemini-2-5-flash",
}

/**
 * 获取 Antigravity API 模型名
 */
function getAntigravityModelName(userModel: string): string {
    const mapped = MODEL_MAPPING[userModel]
    if (!mapped) {
        consola.debug(`Unknown model: ${userModel}, mapping as-is`)
    }
    return mapped || userModel
}

/**
 * 聊天请求参数
 */
export interface ChatRequest {
    model: string
    messages: ClaudeMessage[]
    tools?: ClaudeTool[]
    maxTokens?: number
}

/**
 * 内容块类型
 */
export interface ContentBlock {
    type: "text" | "tool_use"
    text?: string
    id?: string
    name?: string
    input?: any
}

/**
 * 聊天响应
 */
export interface ChatResponse {
    contentBlocks: ContentBlock[]
    stopReason: string | null
    usage?: {
        inputTokens: number
        outputTokens: number
    }
}

/**
 * 生成稳定的 sessionId
 */
function generateStableSessionId(messages: ClaudeMessage[]): string {
    const userMsg = messages.find(m => m.role === "user")
    if (userMsg && typeof userMsg.content === "string") {
        let hash = 0
        for (let i = 0; i < userMsg.content.length; i++) {
            hash = ((hash << 5) - hash) + userMsg.content.charCodeAt(i)
            hash = hash & hash
        }
        const n = Math.abs(hash) * 1000000000000
        return `-${n}`
    }
    return `-${Math.floor(Math.random() * 9e18)}`
}

/**
 * 从消息内容中提取纯文本
 * 处理 Claude 格式的 content（可以是 string 或 content blocks 数组）
 * 支持 text, tool_use, tool_result 类型
 */
function extractTextContent(content: any): string {
    // 如果是字符串，直接返回
    if (typeof content === "string") {
        return content
    }

    // 如果是数组，处理各种类型的块
    if (Array.isArray(content)) {
        const parts: string[] = []
        for (const block of content) {
            if (block.type === "text" && block.text) {
                parts.push(block.text)
            } else if (block.type === "tool_use") {
                // 工具调用 - 格式化为可读文本
                parts.push(`[Tool Call: ${block.name}]\n${JSON.stringify(block.input, null, 2)}`)
            } else if (block.type === "tool_result") {
                // 工具结果 - 提取内容
                if (typeof block.content === "string") {
                    parts.push(block.content)
                } else if (Array.isArray(block.content)) {
                    // 嵌套的 content 数组
                    for (const item of block.content) {
                        if (item.type === "text" && item.text) {
                            parts.push(item.text)
                        }
                    }
                }
            }
        }
        return parts.join("\n") || "[No text content]"
    }

    // 如果有 text 属性，返回它
    if (content && typeof content.text === "string") {
        return content.text
    }

    // 其他情况，尝试序列化
    return JSON.stringify(content)
}

/**
 * 清理 JSON Schema，移除 Antigravity API 不支持的字段
 */
function cleanJsonSchema(schema: any): any {
    if (!schema || typeof schema !== "object") {
        return schema
    }

    // 完整的不支持字段列表
    const unsupportedFields = [
        // JSON Schema 元数据
        "$schema", "$id", "$ref", "$defs", "definitions", "$comment",
        // 验证相关（Claude 不支持）
        "exclusiveMinimum", "exclusiveMaximum", "minimum", "maximum",
        "minLength", "maxLength", "pattern", "format",
        "minItems", "maxItems", "uniqueItems", "minContains", "maxContains",
        "minProperties", "maxProperties",
        // 组合逻辑（Claude 不支持）
        "additionalItems", "patternProperties", "dependencies", "dependentRequired", "dependentSchemas",
        "propertyNames", "const", "contentMediaType", "contentEncoding", "contentSchema",
        "if", "then", "else", "allOf", "anyOf", "oneOf", "not",
        // 其他不支持
        "title", "examples", "default", "readOnly", "writeOnly", "deprecated",
        "additionalProperties", "unevaluatedItems", "unevaluatedProperties",
    ]

    const result: any = {}

    for (const [key, value] of Object.entries(schema)) {
        if (unsupportedFields.includes(key)) continue

        if (key === "properties" && typeof value === "object" && value !== null) {
            result[key] = {}
            for (const [propKey, propValue] of Object.entries(value as Record<string, any>)) {
                result[key][propKey] = cleanJsonSchema(propValue)
            }
        } else if (key === "items" && typeof value === "object") {
            result[key] = cleanJsonSchema(value)
        } else if (Array.isArray(value)) {
            result[key] = value.map(item =>
                typeof item === "object" ? cleanJsonSchema(item) : item
            )
        } else if (typeof value === "object" && value !== null) {
            result[key] = cleanJsonSchema(value)
        } else {
            result[key] = value
        }
    }

    return result
}

/**
 * 转换 Claude 格式到 Antigravity 格式
 */
function claudeToAntigravity(
    model: string,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    maxTokens?: number
): any {
    // Antigravity API expects 'model' role instead of 'assistant'
    const contents = messages.map((msg) => ({
        role: msg.role === "assistant" ? "model" : msg.role,
        parts: [{ text: extractTextContent(msg.content) }],
    }))

    const sessionId = generateStableSessionId(messages)

    // 思考模型需要更多 tokens（思考过程会消耗一部分）
    // gemini-3 和 gpt-oss 都是思考模型，需要足够的 tokens
    let effectiveMaxTokens = maxTokens || 4096
    if (model.includes("gemini-3") || model.includes("gpt-oss")) {
        effectiveMaxTokens = Math.max(effectiveMaxTokens, 1000)
    }

    const generationConfig: any = {
        maxOutputTokens: effectiveMaxTokens
    }

    // 使用 auth 中保存的 projectId
    const projectId = state.cloudaicompanionProject || "unknown"

    const request: any = {
        model,
        userAgent: "antigravity",
        project: projectId,
        requestId: `agent-${crypto.randomUUID()}`,
        request: {
            contents,
            sessionId,
        },
    }

    if (Object.keys(generationConfig).length > 0) {
        request.request.generationConfig = generationConfig
    }

    // Claude 模型需要 toolConfig
    if (model.includes("claude")) {
        request.request.toolConfig = {
            functionCallingConfig: {
                mode: "VALIDATED"
            }
        }
    }

    // 只有 Claude 模型支持工具
    // Gemini 和 GPT 模型不传递 tools 避免 schema 验证错误
    if (tools && tools.length > 0 && model.includes("claude")) {
        request.request.tools = tools.map(tool => ({
            functionDeclarations: [{
                name: tool.name,
                description: tool.description,
                parameters: cleanJsonSchema(tool.input_schema)
            }]
        }))
    }

    return request
}

/**
 * 解析 API 响应
 */
function parseApiResponse(rawResponse: string): ChatResponse {
    let chunks: any[] = []
    const trimmed = rawResponse.trim()

    if (trimmed.startsWith("[")) {
        chunks = JSON.parse(trimmed)
    } else if (trimmed.startsWith("{")) {
        chunks = [JSON.parse(trimmed)]
    }

    if (chunks.length === 0) {
        throw new Error("Empty response from API")
    }

    const lastChunk = chunks[chunks.length - 1]
    if (!lastChunk?.response) {
        throw new Error("No valid response from Antigravity")
    }

    const contentBlocks: ContentBlock[] = []
    let hasToolUse = false

    for (const chunk of chunks) {
        const parts = chunk.response?.candidates?.[0]?.content?.parts || []
        // Debug: 打印 parts 结构
        if (parts.length > 0) {
            // Debug logging removed for cleaner output
        }
        for (const part of parts) {
            // 提取文本内容（不再跳过 thought，因为 Gemini 思考模型可能把内容放在 thought 中）
            if (part.text) {
                const lastBlock = contentBlocks[contentBlocks.length - 1]
                if (lastBlock?.type === "text") {
                    lastBlock.text = (lastBlock.text || "") + part.text
                } else if (part.text) {
                    contentBlocks.push({ type: "text", text: part.text })
                }
            }
            if (part.functionCall) {
                hasToolUse = true
                contentBlocks.push({
                    type: "tool_use",
                    id: part.functionCall.id || `toolu_${crypto.randomUUID().slice(0, 8)}`,
                    name: part.functionCall.name,
                    input: part.functionCall.args || {}
                })
            }
        }
    }

    if (contentBlocks.length === 0) {
        contentBlocks.push({ type: "text", text: "" })
    }

    const usage = lastChunk.response.usageMetadata || lastChunk.usageMetadata
    const inputTokens = usage?.promptTokenCount || 0
    const outputTokens = (usage?.candidatesTokenCount || 0) + (usage?.thoughtsTokenCount || 0)

    const finishReason = lastChunk.response.candidates?.[0]?.finishReason
    let stopReason = "end_turn"
    if (hasToolUse) {
        stopReason = "tool_use"
    } else if (finishReason === "MAX_TOKENS") {
        stopReason = "max_tokens"
    }

    return {
        contentBlocks,
        stopReason,
        usage: { inputTokens, outputTokens },
    }
}

/**
 * 发送请求
 */
async function sendRequest(
    endpoint: string,
    antigravityRequest: any,
    accessToken: string
): Promise<string> {
    let lastError: Error | null = null

    for (const baseUrl of ANTIGRAVITY_BASE_URLS) {
        const url = `${baseUrl}${endpoint}`
        consola.debug("Trying API:", url)

        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${accessToken}`,
                    "User-Agent": DEFAULT_USER_AGENT,
                    "Accept": "application/json",
                },
                body: JSON.stringify(antigravityRequest),
            })

            if (response.ok) {
                consola.success("API request successful on:", baseUrl)
                return await response.text()
            }

            const errorText = await response.text()
            consola.warn(`API error on ${baseUrl}: ${response.status}`, errorText.substring(0, 300))
            lastError = new Error(`Antigravity API error: ${response.status} ${errorText}`)
            continue
        } catch (e) {
            consola.warn(`Request failed on ${baseUrl}:`, e)
            lastError = e as Error
            continue
        }
    }

    throw lastError || new Error("All API endpoints failed")
}

/**
 * 创建聊天完成（非流式）
 */
export async function createChatCompletion(request: ChatRequest): Promise<ChatResponse> {
    const accessToken = await getAccessToken()

    const antigravityRequest = claudeToAntigravity(
        getAntigravityModelName(request.model),
        request.messages,
        request.tools,
        request.maxTokens
    )

    // Verbose request logging removed - use --verbose flag to enable

    const rawResponse = await sendRequest(GENERATE_ENDPOINT, antigravityRequest, accessToken)

    // Debug: 打印原始响应的前2000字符用于调试
    // Debug response logging removed

    return parseApiResponse(rawResponse)
}

/**
 * 创建流式聊天完成
 */
export async function* createChatCompletionStream(
    request: ChatRequest
): AsyncGenerator<string, void, unknown> {
    const accessToken = await getAccessToken()

    const antigravityRequest = claudeToAntigravity(
        getAntigravityModelName(request.model),
        request.messages,
        request.tools,
        request.maxTokens
    )

    // Verbose request logging removed

    const rawResponse = await sendRequest(STREAM_ENDPOINT, antigravityRequest, accessToken)
    const conversionState = createConversionState()

    let chunks: any[] = []
    const trimmed = rawResponse.trim()

    if (trimmed.startsWith("[")) {
        chunks = JSON.parse(trimmed)
    } else if (trimmed.startsWith("{")) {
        chunks = [JSON.parse(trimmed)]
    }

    for (const chunk of chunks) {
        const events = antigravityToClaudeSSE(chunk, conversionState)
        for (const event of events) {
            yield event
        }
    }
}
