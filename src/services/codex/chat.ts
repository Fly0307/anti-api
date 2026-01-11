import consola from "consola"
import { authStore } from "~/services/auth/store"
import { UpstreamError } from "~/lib/error"
import { refreshCodexAccountIfNeeded } from "~/services/codex/oauth"
import type { ProviderAccount } from "~/services/auth/types"
import type { ClaudeMessage, ClaudeTool } from "~/lib/translator"
import { toOpenAIMessages, toOpenAITools } from "~/services/providers/openai-adapter"

const CODEX_API_BASE = "https://api.openai.com/v1"
const CHAT_COMPLETIONS_PATH = "/chat/completions"

interface OpenAIResponse {
    choices: Array<{
        message?: { content?: string | null; tool_calls?: any[] }
        finish_reason?: string | null
    }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export async function createCodexCompletion(
    account: ProviderAccount,
    model: string,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    maxTokens?: number
) {
    const effectiveAccount = await refreshCodexAccountIfNeeded(account)

    const requestBody = {
        model,
        messages: toOpenAIMessages(messages),
        tools: toOpenAITools(tools),
        max_tokens: maxTokens,
    }

    const response = await fetch(`${CODEX_API_BASE}${CHAT_COMPLETIONS_PATH}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${effectiveAccount.accessToken}`,
        },
        body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
        const errorText = await response.text()
        const retryAfter = response.headers.get("retry-after") || undefined
        throw new UpstreamError("codex", response.status, errorText, retryAfter)
    }

    const data = await response.json() as OpenAIResponse
    const choice = data.choices?.[0]
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

    authStore.markSuccess("codex", effectiveAccount.id)

    return {
        contentBlocks,
        stopReason: toolCalls.length > 0 ? "tool_use" : mapFinishReason(choice?.finish_reason),
        usage: {
            inputTokens: data.usage?.prompt_tokens || 0,
            outputTokens: data.usage?.completion_tokens || 0,
        },
    }
}

function safeParse(value: string | undefined): any {
    if (!value) return {}
    try {
        return JSON.parse(value)
    } catch (error) {
        consola.warn("Codex tool args parse failed:", error)
        return {}
    }
}

function mapFinishReason(reason?: string | null): string {
    if (!reason || reason === "stop") return "end_turn"
    if (reason === "length") return "max_tokens"
    if (reason === "tool_calls") return "tool_use"
    return reason
}
