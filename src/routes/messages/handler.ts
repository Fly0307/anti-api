/**
 * /v1/messages 端点处理器
 * 将Anthropic格式请求转换为Antigravity调用
 */

import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import consola from "consola"

import { createChatCompletion, createChatCompletionStream } from "~/services/antigravity/chat"
import type { ClaudeMessage, ClaudeTool } from "~/lib/translator"
import type {
    AnthropicMessagesPayload,
    AnthropicMessage,
    AnthropicResponse,
    AnthropicTextBlock,
    AnthropicContentBlock,
} from "./types"

/**
 * 将Anthropic消息转换为 Claude 格式（保留完整结构）
 */
function translateMessages(payload: AnthropicMessagesPayload): ClaudeMessage[] {
    return payload.messages as unknown as ClaudeMessage[]
}

/**
 * 提取工具定义
 */
function extractTools(payload: AnthropicMessagesPayload): ClaudeTool[] | undefined {
    if (!payload.tools || payload.tools.length === 0) {
        return undefined
    }

    return payload.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema
    }))
}

/**
 * 生成响应ID
 */
function generateMessageId(): string {
    return `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
}

/**
 * 处理非流式请求
 */
export async function handleCompletion(c: Context): Promise<Response> {
    const payload = await c.req.json<AnthropicMessagesPayload>()

    // Debug: 查看收到的请求
    // Model and tools logging simplified
    consola.debug(`Model: ${payload.model}, Tools: ${payload.tools?.length || 0}`)

    const messages = translateMessages(payload)
    const tools = extractTools(payload)

    // 检查是否流式
    if (payload.stream) {
        return handleStreamCompletion(c, payload, messages, tools)
    }

    // 非流式请求
    const result = await createChatCompletion({
        model: payload.model,
        messages,
        tools,
        maxTokens: payload.max_tokens,
    })

    // 构建响应内容 - 从 contentBlocks 转换为 Anthropic 格式
    const content = result.contentBlocks.map(block => {
        if (block.type === "tool_use") {
            return {
                type: "tool_use" as const,
                id: block.id!,
                name: block.name!,
                input: block.input
            }
        }
        return {
            type: "text" as const,
            text: block.text || ""
        }
    })

    const response: AnthropicResponse = {
        id: generateMessageId(),
        type: "message",
        role: "assistant",
        content,
        model: payload.model,
        stop_reason: result.stopReason as "end_turn" | "tool_use" | "max_tokens",
        stop_sequence: null,
        usage: {
            input_tokens: result.usage?.inputTokens || 0,
            output_tokens: result.usage?.outputTokens || 0,
        },
    }

    // Response logging removed for cleaner output
    return c.json(response)
}

/**
 * 处理流式请求
 */
async function handleStreamCompletion(
    c: Context,
    payload: AnthropicMessagesPayload,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[]
): Promise<Response> {
    return streamSSE(c, async (stream) => {
        try {
            const chatStream = createChatCompletionStream({
                model: payload.model,
                messages,
                tools,
                maxTokens: payload.max_tokens,
            })

            // 直接写入来自翻译器的 SSE 事件
            for await (const event of chatStream) {
                await stream.write(event)
            }

        } catch (error) {
            consola.error("Stream error:", error)
            await stream.writeSSE({
                event: "error",
                data: JSON.stringify({
                    type: "error",
                    error: { type: "api_error", message: (error as Error).message },
                }),
            })
        }
    })
}
