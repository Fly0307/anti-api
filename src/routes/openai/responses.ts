import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import consola from "consola"

import { forwardError, summarizeUpstreamError, UpstreamError } from "~/lib/error"
import { rateLimiter } from "~/lib/rate-limiter"
import { validateResponsesRequest } from "~/lib/validation"
import { createRoutedCompletion, createRoutedCompletionStream, RoutingError } from "~/services/routing/router"
import type {
    OpenAIMessage,
    OpenAIResponsesInputContent,
    OpenAIResponsesInputItem,
    OpenAIResponsesRequest,
    OpenAIResponsesToolChoice,
} from "./types"
import { mapModel, translateMessages, translateTools } from "./translator"

type ReasoningEffort = "low" | "medium" | "high"

type ResponseToolCallItem = {
    id: string
    type: "function_call"
    call_id: string
    name: string
    arguments: string
    status: "completed"
}

type ResponseOutputMessageItem = {
    id: string
    type: "message"
    status: "completed"
    role: "assistant"
    content: Array<{
        type: "output_text"
        text: string
        annotations: any[]
    }>
}

function generateResponseId(): string {
    return `resp_${crypto.randomUUID().replace(/-/g, "")}`
}

function generateOutputMessageId(): string {
    return `msg_${crypto.randomUUID().replace(/-/g, "")}`
}

function generateFunctionCallId(): string {
    return `fc_${crypto.randomUUID().replace(/-/g, "")}`
}

function normalizeResponsesPayload(payload: OpenAIResponsesRequest): void {
    if (payload.max_output_tokens !== undefined && (payload.max_output_tokens === null || payload.max_output_tokens <= 0)) {
        delete (payload as { max_output_tokens?: number | null }).max_output_tokens
    }
    if (payload.temperature !== undefined && payload.temperature === null) {
        delete (payload as { temperature?: number | null }).temperature
    }
    if (payload.stream !== undefined && payload.stream === null) {
        delete (payload as { stream?: boolean | null }).stream
    }
    if (payload.tools !== undefined && payload.tools === null) {
        delete (payload as { tools?: any[] | null }).tools
    }
}

function extractReasoningEffort(payload: OpenAIResponsesRequest): ReasoningEffort | undefined {
    const candidate = payload.reasoning?.effort
    if (candidate === "low" || candidate === "medium" || candidate === "high") {
        return candidate
    }
    return undefined
}

function normalizeContentParts(content: OpenAIResponsesInputContent[] | unknown): string {
    if (!Array.isArray(content)) return ""

    const textParts: string[] = []
    for (const part of content) {
        if (!part || typeof part !== "object") continue
        if ((part.type === "input_text" || part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
            textParts.push(part.text)
        }
    }
    return textParts.join("")
}

function normalizeInputContent(content: string | OpenAIResponsesInputContent[] | unknown): string {
    if (typeof content === "string") return content
    return normalizeContentParts(content)
}

function normalizeFunctionOutput(output: string | OpenAIResponsesInputContent[] | unknown): string {
    if (typeof output === "string") return output
    return normalizeContentParts(output)
}

function itemToMessages(item: OpenAIResponsesInputItem): OpenAIMessage[] {
    if (typeof item === "string") {
        return [{ role: "user", content: item }]
    }

    if (!item || typeof item !== "object") {
        return []
    }

    if (item.type === "function_call") {
        return [{
            role: "assistant",
            content: null,
            tool_calls: [{
                id: item.call_id || item.id || generateFunctionCallId(),
                type: "function",
                function: {
                    name: item.name,
                    arguments: item.arguments || "{}",
                },
            }],
        }]
    }

    if (item.type === "function_call_output") {
        return [{
            role: "tool",
            content: normalizeFunctionOutput(item.output),
            tool_call_id: item.call_id,
        }]
    }

    return [{
        role: item.role || "user",
        content: normalizeInputContent(item.content),
    }]
}

function translateResponsesInput(input: OpenAIResponsesRequest["input"]): OpenAIMessage[] {
    if (typeof input === "string") {
        return [{ role: "user", content: input }]
    }
    if (Array.isArray(input)) {
        return input.flatMap(itemToMessages)
    }
    if (input && typeof input === "object") {
        return itemToMessages(input)
    }
    return []
}

function translateResponsesToolChoice(choice?: OpenAIResponsesToolChoice) {
    if (!choice) return undefined
    if (choice === "auto") return { type: "auto" as const }
    if (choice === "none") return { type: "none" as const }
    if (choice === "required") return { type: "any" as const }
    if (typeof choice === "object" && choice.type === "function" && choice.name) {
        return { type: "tool" as const, name: choice.name }
    }
    return undefined
}

function buildResponseToolCallItem(name: string, argumentsText: string, callId: string): ResponseToolCallItem {
    return {
        id: generateFunctionCallId(),
        type: "function_call",
        call_id: callId,
        name,
        arguments: argumentsText,
        status: "completed",
    }
}

function buildResponseMessageItem(text: string): ResponseOutputMessageItem {
    return {
        id: generateOutputMessageId(),
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{
            type: "output_text",
            text,
            annotations: [],
        }],
    }
}

function buildResponseObject(
    payload: OpenAIResponsesRequest,
    responseId: string,
    output: Array<ResponseToolCallItem | ResponseOutputMessageItem>,
    usage: { input_tokens: number; output_tokens: number },
    reasoningEffort?: ReasoningEffort,
) {
    const outputText = output
        .filter((item): item is ResponseOutputMessageItem => item.type === "message")
        .flatMap(item => item.content)
        .map(part => part.text)
        .join("")

    return {
        id: responseId,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "completed",
        error: null,
        incomplete_details: null,
        instructions: null,
        max_output_tokens: payload.max_output_tokens ?? null,
        model: payload.model,
        output,
        output_text: outputText,
        parallel_tool_calls: true,
        previous_response_id: payload.previous_response_id ?? null,
        reasoning: {
            effort: reasoningEffort ?? null,
            summary: null,
        },
        store: payload.store ?? true,
        temperature: payload.temperature ?? 1,
        text: { format: { type: "text" } },
        tool_choice: payload.tool_choice ?? "auto",
        tools: payload.tools ?? [],
        top_p: payload.top_p ?? 1,
        truncation: "disabled",
        usage: {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: usage.input_tokens + usage.output_tokens,
        },
        user: payload.user ?? null,
        metadata: payload.metadata ?? {},
    }
}

function buildValidationReason(message?: string): string {
    const raw = (message || "invalid_request").replace(/[\r\n]+/g, " ").trim()
    if (!raw) return "invalid_request"
    return raw.length > 160 ? `${raw.slice(0, 157)}...` : raw
}

export async function handleResponses(c: Context): Promise<Response> {
    try {
        const payload = await c.req.json<OpenAIResponsesRequest>()
        if (payload && typeof payload === "object") {
            normalizeResponsesPayload(payload)
        }

        const validation = validateResponsesRequest(payload)
        if (!validation.valid) {
            c.header("X-Log-Reason", buildValidationReason(validation.error))
            return c.json({ error: { type: "invalid_request_error", message: validation.error } }, 400)
        }

        await rateLimiter.wait()

        const anthropicModel = mapModel(payload.model)
        const messages = translateMessages(translateResponsesInput(payload.input))
        const tools = translateTools(payload.tools?.map((tool) => ({
            type: "function" as const,
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            },
        })))
        const toolChoice = translateResponsesToolChoice(payload.tool_choice)
        const reasoningEffort = extractReasoningEffort(payload)

        if (payload.stream) {
            return handleStreamResponses(c, payload, anthropicModel, messages, tools, toolChoice, reasoningEffort)
        }

        let result
        try {
            result = await createRoutedCompletion({
                model: anthropicModel,
                messages,
                tools,
                toolChoice,
                maxTokens: payload.max_output_tokens || 4096,
                reasoningEffort,
            })
        } catch (error) {
            if (error instanceof RoutingError) {
                c.header("X-Log-Reason", buildValidationReason(error.message))
                return c.json({ error: { type: "invalid_request_error", message: error.message } }, error.status)
            }
            throw error
        }

        const output: Array<ResponseToolCallItem | ResponseOutputMessageItem> = []
        let textContent = ""

        for (const block of result.contentBlocks) {
            if (block.type === "text") {
                textContent += block.text || ""
            } else if (block.type === "tool_use") {
                output.push(buildResponseToolCallItem(
                    block.name || "tool",
                    JSON.stringify(block.input || {}),
                    block.id || generateFunctionCallId(),
                ))
            }
        }

        if (textContent || output.length === 0) {
            output.unshift(buildResponseMessageItem(textContent))
        }

        return c.json(buildResponseObject(
            payload,
            generateResponseId(),
            output,
            {
                input_tokens: result.usage?.inputTokens || 0,
                output_tokens: result.usage?.outputTokens || 0,
            },
            reasoningEffort,
        ))
    } catch (error) {
        if (error instanceof UpstreamError) {
            return await forwardError(c, error)
        }
        consola.error("Responses API error:", error)
        return c.json({ error: { message: (error as Error).message, type: "api_error" } }, 500)
    }
}

async function handleStreamResponses(
    c: Context,
    payload: OpenAIResponsesRequest,
    anthropicModel: string,
    messages: any[],
    tools: any[] | undefined,
    toolChoice: { type: "auto" | "any" | "tool" | "none"; name?: string } | undefined,
    reasoningEffort?: ReasoningEffort,
): Promise<Response> {
    const responseId = generateResponseId()
    const responseCreatedAt = Math.floor(Date.now() / 1000)
    const assistantMessageId = generateOutputMessageId()

    return streamSSE(c, async (stream) => {
        try {
            const responseCreated = buildResponseObject(
                payload,
                responseId,
                [],
                { input_tokens: 0, output_tokens: 0 },
                reasoningEffort,
            )
            responseCreated.status = "in_progress"
            responseCreated.output = []
            responseCreated.output_text = ""
            await stream.writeSSE({
                event: "response.created",
                data: JSON.stringify({ type: "response.created", response: responseCreated }),
            })

            const chatStream = createRoutedCompletionStream({
                model: anthropicModel,
                messages,
                tools,
                toolChoice,
                maxTokens: payload.max_output_tokens || 4096,
                reasoningEffort,
            })

            let textContent = ""
            let streamInputTokens = 0
            let streamOutputTokens = 0
            let messageOutputIndex: number | null = null
            let currentToolCall: { name: string; callId: string; arguments: string; outputIndex: number } | null = null
            const completedOutputItems: Array<ResponseToolCallItem | ResponseOutputMessageItem> = []

            for await (const event of chatStream) {
                const lines = event.split("\n")
                for (const line of lines) {
                    if (!line.startsWith("data: ")) continue
                    const data = line.slice(6)
                    if (data === "[DONE]") continue

                    try {
                        const parsed = JSON.parse(data)

                        switch (parsed.type) {
                            case "message_start":
                                if (parsed.message?.usage?.input_tokens) {
                                    streamInputTokens = parsed.message.usage.input_tokens
                                }
                                break

                            case "content_block_start":
                                if (parsed.content_block?.type === "text" && messageOutputIndex === null) {
                                    messageOutputIndex = completedOutputItems.length
                                    await stream.writeSSE({
                                        event: "response.output_item.added",
                                        data: JSON.stringify({
                                            type: "response.output_item.added",
                                            response_id: responseId,
                                            output_index: messageOutputIndex,
                                            item: {
                                                id: assistantMessageId,
                                                type: "message",
                                                status: "in_progress",
                                                role: "assistant",
                                                content: [],
                                            },
                                        }),
                                    })
                                }
                                if (parsed.content_block?.type === "tool_use") {
                                    const outputIndex = completedOutputItems.length
                                    currentToolCall = {
                                        name: parsed.content_block.name || "tool",
                                        callId: parsed.content_block.id || generateFunctionCallId(),
                                        arguments: "",
                                        outputIndex,
                                    }
                                    await stream.writeSSE({
                                        event: "response.output_item.added",
                                        data: JSON.stringify({
                                            type: "response.output_item.added",
                                            response_id: responseId,
                                            output_index: outputIndex,
                                            item: {
                                                id: currentToolCall.callId,
                                                type: "function_call",
                                                call_id: currentToolCall.callId,
                                                name: currentToolCall.name,
                                                arguments: "",
                                                status: "in_progress",
                                            },
                                        }),
                                    })
                                }
                                break

                            case "content_block_delta":
                                if (parsed.delta?.type === "text_delta" && parsed.delta?.text && messageOutputIndex !== null) {
                                    textContent += parsed.delta.text
                                    await stream.writeSSE({
                                        event: "response.output_text.delta",
                                        data: JSON.stringify({
                                            type: "response.output_text.delta",
                                            item_id: assistantMessageId,
                                            output_index: messageOutputIndex,
                                            content_index: 0,
                                            delta: parsed.delta.text,
                                        }),
                                    })
                                } else if (parsed.delta?.type === "input_json_delta" && currentToolCall) {
                                    currentToolCall.arguments += parsed.delta.partial_json || ""
                                    await stream.writeSSE({
                                        event: "response.function_call_arguments.delta",
                                        data: JSON.stringify({
                                            type: "response.function_call_arguments.delta",
                                            item_id: currentToolCall.callId,
                                            output_index: currentToolCall.outputIndex,
                                            delta: parsed.delta.partial_json || "",
                                        }),
                                    })
                                }
                                break

                            case "content_block_stop":
                                if (currentToolCall) {
                                    const toolItem = buildResponseToolCallItem(
                                        currentToolCall.name,
                                        currentToolCall.arguments || "{}",
                                        currentToolCall.callId,
                                    )
                                    completedOutputItems.push(toolItem)
                                    await stream.writeSSE({
                                        event: "response.function_call_arguments.done",
                                        data: JSON.stringify({
                                            type: "response.function_call_arguments.done",
                                            item_id: toolItem.call_id,
                                            output_index: currentToolCall.outputIndex,
                                            arguments: toolItem.arguments,
                                        }),
                                    })
                                    await stream.writeSSE({
                                        event: "response.output_item.done",
                                        data: JSON.stringify({
                                            type: "response.output_item.done",
                                            response_id: responseId,
                                            output_index: currentToolCall.outputIndex,
                                            item: toolItem,
                                        }),
                                    })
                                    currentToolCall = null
                                }
                                break

                            case "message_delta":
                                if (parsed.usage?.output_tokens) {
                                    streamOutputTokens = parsed.usage.output_tokens
                                }
                                break
                        }
                    } catch {
                        // Ignore malformed SSE fragments from upstream translation.
                    }
                }
            }

            if (textContent || completedOutputItems.length === 0) {
                const messageItem = buildResponseMessageItem(textContent)
                if (messageOutputIndex === null) {
                    messageOutputIndex = 0
                }
                completedOutputItems.splice(messageOutputIndex, 0, messageItem)
                await stream.writeSSE({
                    event: "response.output_text.done",
                    data: JSON.stringify({
                        type: "response.output_text.done",
                        item_id: messageItem.id,
                        output_index: messageOutputIndex,
                        content_index: 0,
                        text: textContent,
                    }),
                })
                await stream.writeSSE({
                    event: "response.content_part.done",
                    data: JSON.stringify({
                        type: "response.content_part.done",
                        item_id: messageItem.id,
                        output_index: messageOutputIndex,
                        content_index: 0,
                        part: {
                            type: "output_text",
                            text: textContent,
                            annotations: [],
                        },
                    }),
                })
                await stream.writeSSE({
                    event: "response.output_item.done",
                    data: JSON.stringify({
                        type: "response.output_item.done",
                        response_id: responseId,
                        output_index: messageOutputIndex,
                        item: messageItem,
                    }),
                })
            }

            const completedResponse = buildResponseObject(
                payload,
                responseId,
                completedOutputItems,
                { input_tokens: streamInputTokens, output_tokens: streamOutputTokens },
                reasoningEffort,
            )
            completedResponse.created_at = responseCreatedAt
            await stream.writeSSE({
                event: "response.completed",
                data: JSON.stringify({ type: "response.completed", response: completedResponse }),
            })
        } catch (error) {
            if (error instanceof UpstreamError) {
                const summary = summarizeUpstreamError(error)
                consola.error("Responses stream error:", summary.message)
                await stream.writeSSE({
                    event: "error",
                    data: JSON.stringify({
                        type: "error",
                        error: {
                            type: "upstream_error",
                            message: summary.message,
                            provider: error.provider,
                            ...(summary.reason ? { reason: summary.reason } : {}),
                        },
                    }),
                })
            } else {
                consola.error("Responses stream error:", error)
                await stream.writeSSE({
                    event: "error",
                    data: JSON.stringify({
                        type: "error",
                        error: { message: (error as Error).message, type: "api_error" },
                    }),
                })
            }
        }
    })
}
