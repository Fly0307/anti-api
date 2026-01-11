import type { ClaudeMessage, ClaudeTool } from "~/lib/translator"
import { UpstreamError } from "~/lib/error"
import { createChatCompletionWithOptions, createChatCompletionStreamWithOptions } from "~/services/antigravity/chat"
import { createCodexCompletion } from "~/services/codex/chat"
import { createCopilotCompletion } from "~/services/copilot/chat"
import { authStore } from "~/services/auth/store"
import { loadRoutingConfig, type RoutingEntry, type RoutingFlow } from "./config"
import { buildMessageStart, buildContentBlockStart, buildTextDelta, buildInputJsonDelta, buildContentBlockStop, buildMessageDelta, buildMessageStop } from "~/lib/translator"

interface RoutedRequest {
    model: string
    messages: ClaudeMessage[]
    tools?: ClaudeTool[]
    maxTokens?: number
}

function isEntryUsable(entry: RoutingEntry): boolean {
    if (entry.provider === "antigravity") {
        return true
    }
    return !!authStore.getAccount(entry.provider, entry.accountId)
}

function normalizeEntries(entries: RoutingEntry[]): RoutingEntry[] {
    return entries.filter(isEntryUsable)
}

const FALLBACK_STATUSES = new Set([408, 429, 500, 503, 529])

function isAccountUnavailableError(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    return error.message.startsWith("Account not found:")
}

function isTransientTransportError(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    return /certificate|fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed out/i.test(error.message)
}

function shouldFallbackOnUpstream(error: UpstreamError): boolean {
    return FALLBACK_STATUSES.has(error.status)
}

function getFlowKey(model: string): string {
    const raw = model?.trim() || ""
    if (raw.toLowerCase().startsWith("route:")) {
        return raw.slice("route:".length).trim()
    }
    return raw
}

function selectFlowEntries(flows: RoutingFlow[], model: string): RoutingEntry[] {
    if (flows.length === 0) {
        return []
    }

    const flowKey = getFlowKey(model)
    const exact = flows.find(flow => flow.name === flowKey)
    if (exact) {
        return exact.entries
    }

    const fallback = flows.find(flow => flow.name === "default") || flows[0]
    return fallback?.entries || []
}

export async function createRoutedCompletion(request: RoutedRequest) {
    const config = loadRoutingConfig()
    const entries = normalizeEntries(selectFlowEntries(config.flows, request.model))

    if (entries.length === 0) {
        return createChatCompletionWithOptions(request, { allowRotation: true })
    }

    let lastError: Error | null = null

    for (const entry of entries) {
        try {
            if (entry.provider === "antigravity") {
                const accountId = entry.accountId === "auto" ? undefined : entry.accountId
                return await createChatCompletionWithOptions({ ...request, model: entry.modelId }, {
                    accountId,
                    allowRotation: accountId ? false : true,
                })
            }

            if (authStore.isRateLimited(entry.provider, entry.accountId)) {
                continue
            }

            const account = authStore.getAccount(entry.provider, entry.accountId)
            if (!account) {
                continue
            }

            if (entry.provider === "codex") {
                return await createCodexCompletion(account, entry.modelId, request.messages, request.tools, request.maxTokens)
            }

            if (entry.provider === "copilot") {
                return await createCopilotCompletion(account, entry.modelId, request.messages, request.tools, request.maxTokens)
            }
        } catch (error) {
            lastError = error as Error
            if (entry.provider === "antigravity" && isAccountUnavailableError(error)) {
                continue
            }
            if (error instanceof UpstreamError && shouldFallbackOnUpstream(error)) {
                if (entry.provider !== "antigravity") {
                    authStore.markRateLimited(entry.provider, entry.accountId, error.status, error.body, error.retryAfter)
                }
                continue
            }
            if (isTransientTransportError(error)) {
                if (entry.provider !== "antigravity") {
                    authStore.markRateLimited(entry.provider, entry.accountId, 500, (error as Error).message)
                }
                continue
            }
            throw error
        }
    }

    if (lastError) {
        throw lastError
    }

    throw new Error("No routing entries available")
}

export async function* createRoutedCompletionStream(request: RoutedRequest): AsyncGenerator<string, void, unknown> {
    const config = loadRoutingConfig()
    const entries = normalizeEntries(selectFlowEntries(config.flows, request.model))

    if (entries.length === 0) {
        yield* createChatCompletionStreamWithOptions(request, { allowRotation: true })
        return
    }

    let lastError: Error | null = null

    for (const entry of entries) {
        try {
            if (entry.provider === "antigravity") {
                const accountId = entry.accountId === "auto" ? undefined : entry.accountId
                yield* createChatCompletionStreamWithOptions({ ...request, model: entry.modelId }, {
                    accountId,
                    allowRotation: accountId ? false : true,
                })
                return
            }

            if (authStore.isRateLimited(entry.provider, entry.accountId)) {
                continue
            }

            const account = authStore.getAccount(entry.provider, entry.accountId)
            if (!account) {
                continue
            }

            let completion
            if (entry.provider === "codex") {
                completion = await createCodexCompletion(account, entry.modelId, request.messages, request.tools, request.maxTokens)
            } else if (entry.provider === "copilot") {
                completion = await createCopilotCompletion(account, entry.modelId, request.messages, request.tools, request.maxTokens)
            }

            if (!completion) {
                throw new Error("Empty completion")
            }

            yield buildMessageStart(request.model)
            let blockIndex = 0
            for (const block of completion.contentBlocks) {
                if (block.type === "tool_use") {
                    yield buildContentBlockStart(blockIndex, "tool_use", { id: block.id!, name: block.name! })
                    const inputText = JSON.stringify(block.input || {})
                    yield buildInputJsonDelta(blockIndex, inputText)
                    yield buildContentBlockStop(blockIndex)
                    blockIndex++
                    continue
                }

                yield buildContentBlockStart(blockIndex, "text")
                yield buildTextDelta(blockIndex, block.text || "")
                yield buildContentBlockStop(blockIndex)
                blockIndex++
            }
            yield buildMessageDelta(completion.stopReason || "end_turn", completion.usage)
            yield buildMessageStop()
            return
        } catch (error) {
            lastError = error as Error
            if (entry.provider === "antigravity" && isAccountUnavailableError(error)) {
                continue
            }
            if (error instanceof UpstreamError && shouldFallbackOnUpstream(error)) {
                if (entry.provider !== "antigravity") {
                    authStore.markRateLimited(entry.provider, entry.accountId, error.status, error.body, error.retryAfter)
                }
                continue
            }
            if (isTransientTransportError(error)) {
                if (entry.provider !== "antigravity") {
                    authStore.markRateLimited(entry.provider, entry.accountId, 500, (error as Error).message)
                }
                continue
            }
            throw error
        }
    }

    if (lastError) {
        throw lastError
    }

    throw new Error("No routing entries available")
}
