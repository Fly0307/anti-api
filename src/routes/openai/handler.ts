/**
 * OpenAI /v1/chat/completions 端点处理器
 */

import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import consola from "consola"

import { createChatCompletion, createChatCompletionStream } from "~/services/antigravity/chat"
import type { OpenAIChatCompletionRequest } from "./types"
import {
    mapModel,
    translateMessages,
    translateTools,
    generateChatId,
    buildStreamChunk,
    mapStopReason,
} from "./translator"

export async function handleChatCompletion(c: Context): Promise<Response> {
    const payload = await c.req.json<OpenAIChatCompletionRequest>()

    consola.info("OpenAI request - model:", payload.model, "stream:", payload.stream)

    const anthropicModel = mapModel(payload.model)
    const messages = translateMessages(payload.messages)
    const tools = translateTools(payload.tools)

    if (payload.stream) {
        return handleStreamCompletion(c, payload, anthropicModel, messages, tools)
    }

    try {
        const result = await createChatCompletion({
            model: anthropicModel,
            messages,
            tools,
            maxTokens: payload.max_tokens || 4096,
        })

        let textContent = ""
        const toolCalls: any[] = []

        for (const block of result.contentBlocks) {
            if (block.type === "text") {
                textContent += block.text || ""
            } else if (block.type === "tool_use") {
                toolCalls.push({ id: block.id, name: block.name, input: block.input })
            }
        }

        const message: any = { role: "assistant", content: toolCalls.length > 0 ? null : textContent }
        if (toolCalls.length > 0) {
            message.tool_calls = toolCalls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: { name: tc.name, arguments: JSON.stringify(tc.input) },
            }))
        }

        return c.json({
            id: generateChatId(),
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: payload.model,
            choices: [{ index: 0, message, finish_reason: mapStopReason(result.stopReason || "end_turn") }],
            usage: {
                prompt_tokens: result.usage?.inputTokens || 0,
                completion_tokens: result.usage?.outputTokens || 0,
                total_tokens: (result.usage?.inputTokens || 0) + (result.usage?.outputTokens || 0),
            },
        })
    } catch (error) {
        consola.error("OpenAI completion error:", error)
        return c.json({ error: { message: (error as Error).message, type: "api_error" } }, 500)
    }
}

async function handleStreamCompletion(
    c: Context,
    payload: OpenAIChatCompletionRequest,
    anthropicModel: string,
    messages: any[],
    tools?: any[]
): Promise<Response> {
    const chatId = generateChatId()

    return streamSSE(c, async (stream) => {
        try {
            const chatStream = createChatCompletionStream({
                model: anthropicModel,
                messages,
                tools,
                maxTokens: payload.max_tokens || 4096,
            })

            let sentRole = false
            let accumulatedToolCalls: any[] = []
            let currentToolCall: any = null

            for await (const event of chatStream) {
                const lines = event.split("\n")
                for (const line of lines) {
                    if (!line.startsWith("data: ")) continue
                    const data = line.slice(6)
                    if (data === "[DONE]") continue

                    try {
                        const parsed = JSON.parse(data)
                        const eventType = parsed.type

                        switch (eventType) {
                            case "message_start":
                                if (!sentRole) {
                                    await stream.writeSSE({ data: buildStreamChunk(chatId, payload.model, undefined, "assistant") })
                                    sentRole = true
                                }
                                break

                            case "content_block_start":
                                if (parsed.content_block?.type === "tool_use") {
                                    currentToolCall = {
                                        id: parsed.content_block.id,
                                        name: parsed.content_block.name,
                                        input: {},
                                        arguments: "",
                                    }
                                }
                                break

                            case "content_block_delta":
                                if (parsed.delta?.type === "text_delta" && parsed.delta?.text) {
                                    await stream.writeSSE({ data: buildStreamChunk(chatId, payload.model, parsed.delta.text) })
                                } else if (parsed.delta?.type === "input_json_delta" && currentToolCall) {
                                    currentToolCall.arguments += parsed.delta.partial_json || ""
                                }
                                break

                            case "content_block_stop":
                                if (currentToolCall) {
                                    try { currentToolCall.input = JSON.parse(currentToolCall.arguments || "{}") } catch { currentToolCall.input = {} }
                                    accumulatedToolCalls.push(currentToolCall)
                                    currentToolCall = null
                                }
                                break

                            case "message_delta":
                                const stopReason = parsed.delta?.stop_reason || "end_turn"
                                if (accumulatedToolCalls.length > 0) {
                                    await stream.writeSSE({ data: buildStreamChunk(chatId, payload.model, undefined, undefined, "tool_use", accumulatedToolCalls) })
                                }
                                await stream.writeSSE({ data: buildStreamChunk(chatId, payload.model, undefined, undefined, stopReason) })
                                break
                        }
                    } catch (e) { }
                }
            }

            await stream.writeSSE({ data: "[DONE]" })
        } catch (error) {
            consola.error("OpenAI stream error:", error)
            await stream.writeSSE({ data: JSON.stringify({ error: { message: (error as Error).message, type: "api_error" } }) })
        }
    })
}
