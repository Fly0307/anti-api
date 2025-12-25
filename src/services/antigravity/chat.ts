/**
 * Antigravity Chat 服务 v6
 * 通过本地 Language Server 的 HTTPS 端点调用
 * 
 * 服务: exa.language_server_pb.LanguageServerService
 * 端点: SendUserCascadeMessage
 * 协议: HTTPS + application/proto
 * 
 * 重要: 使用 Bun 的 fetch，支持 TLS 和 HTTP/2
 */

import consola from "consola"

import { getToken } from "~/lib/token"
import { state } from "~/lib/state"
import { AntigravityError } from "~/lib/error"
import { filterIDEContext } from "~/lib/ide-filter"
import { encodeSendUserCascadeMessage } from "~/proto/encoder"

/**
 * 聊天消息格式
 */
export interface ChatMessage {
    role: "user" | "assistant" | "system"
    content: string
}

/**
 * 聊天请求参数
 */
export interface ChatRequest {
    model: string
    messages: ChatMessage[]
    stream?: boolean
    maxTokens?: number
    system?: string
}

/**
 * 聊天响应
 */
export interface ChatResponse {
    content: string
    model: string
    stopReason: string | null
    usage?: {
        inputTokens: number
        outputTokens: number
    }
}

// 禁用 TLS 证书验证（自签名证书）
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"

/**
 * 创建新的 Cascade
 */
async function startCascade(): Promise<string> {
    const port = state.languageServerPort
    const csrfToken = state.csrfToken

    if (!port || !csrfToken) {
        throw new AntigravityError("Language Server 未初始化", "not_initialized")
    }

    const requestCascadeId = crypto.randomUUID()
    const sessionId = crypto.randomUUID().slice(0, 8)  // Unique session to avoid memory leakage
    const response = await fetch(`https://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/StartCascade`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "connect-protocol-version": "1",
            "x-codeium-csrf-token": csrfToken,
        },
        body: JSON.stringify({
            cascadeId: requestCascadeId,
            workspaceUri: `file:///tmp/anti-api-${sessionId}`
        }),
    })

    if (!response.ok) {
        throw new Error(`StartCascade 失败: ${response.status}`)
    }

    const data = await response.json() as { cascadeId: string }
    consola.info("Created new cascade:", data.cascadeId)
    return data.cascadeId
}

/**
 * 为每个请求创建新的 Cascade
 * 避免 "executor is not idle" 错误
 */
async function createFreshCascade(): Promise<string> {
    return await startCascade()
}

/**
 * 构建 Protobuf 请求
 * 重要：不转发 Claude Code 的 system prompt，因为其中包含项目上下文
 */
function buildProtobufRequest(request: ChatRequest, cascadeId: string): Uint8Array {
    const token = getToken()

    // 只取最后一条用户消息 - 不转发 system prompt 和历史消息
    // Claude Code 的 system prompt 包含当前目录的文件列表，转发会导致上下文泄露
    let userMessage = ""

    for (const msg of request.messages) {
        if (msg.role === "user") {
            // 只保留最后一条用户消息
            userMessage = msg.content
        }
        // 忽略 system 和 assistant 消息
    }

    // 过滤请求中嵌入的污染历史（Claude Code 的 Summarize/Title 请求会包含之前的对话）
    // 这些历史中可能包含 IDE 上下文，需要在发送前清理
    userMessage = filterEmbeddedHistory(userMessage)

    return encodeSendUserCascadeMessage({
        cascadeId: cascadeId,
        message: userMessage.trim(),
        apiKey: token,
        model: request.model,
    })
}

/**
 * 过滤用户消息中嵌入的污染历史
 * Claude Code 的某些请求（如 Summarize、Title）会在 user message 中嵌入之前的对话
 * 这些对话可能包含 IDE 上下文信息，需要清理
 */
function filterEmbeddedHistory(message: string): string {
    // 检测是否是包含对话历史的请求
    if (!message.includes("Claude:") && !message.includes("conversation:")) {
        return message  // 普通消息，不处理
    }

    let filtered = message

    // 直接替换污染内容（不依赖复杂的 Claude: 块匹配）
    // IDE 上下文模式 - 中文
    filtered = filtered.replace(/我注意到[^。！？\n]*?[。！？，,\n]/g, '')
    filtered = filtered.replace(/我看到[^。！？\n]*?[。！？，,\n]/g, '')
    filtered = filtered.replace(/需要我帮你[^。！？\n]*?[。！？\n]/g, '')
    filtered = filtered.replace(/如果你需要[^。！？\n]*?[。！？\n]/g, '')
    filtered = filtered.replace(/有关(?:这个|该)(?:脚本|项目|文件)[^。！？\n]*?[。！？\n]/g, '')

    // Antigravity 身份模式 - 中文
    filtered = filtered.replace(/我是\s*\*?\*?Antigravity\*?\*?[^。！\n]*?[。！\n]/gi, '')
    filtered = filtered.replace(/由\s*Google\s*DeepMind[^。！\n]*?[。！\n]/gi, '')
    filtered = filtered.replace(/一个由\s*Google[^。！\n]*?[。！\n]/gi, '')

    // IDE 上下文模式 - 英文
    filtered = filtered.replace(/I notice[^.!?\n]*?[.!?\n]/gi, '')
    filtered = filtered.replace(/I see[^.!?\n]*?you[^.!?\n]*?[.!?\n]/gi, '')
    filtered = filtered.replace(/If you need[^.!?\n]*?(?:script|project|file)[^.!?\n]*?[.!?\n]/gi, '')

    // Antigravity 身份模式 - 英文
    filtered = filtered.replace(/I(?:'m| am) Antigravity[^.!\n]*?[.!\n]/gi, '')
    filtered = filtered.replace(/developed by Google DeepMind[^.!\n]*?[.!\n]/gi, '')

    // 清理多余空行
    filtered = filtered.replace(/\n{3,}/g, '\n\n').trim()

    return filtered
}

/**
 * 调用本地 Language Server
 */
async function callLanguageServer(
    path: string,
    body: Uint8Array
): Promise<ArrayBuffer> {
    const port = state.languageServerPort
    const csrfToken = state.csrfToken

    if (!port || !csrfToken) {
        throw new AntigravityError(
            "Language Server 信息未初始化，请确保 Antigravity 正在运行",
            "language_server_not_found"
        )
    }

    const url = `https://127.0.0.1:${port}${path}`
    consola.debug("Calling Language Server:", url)
    consola.debug("Port:", port, "CSRF:", csrfToken.slice(0, 10) + "...")

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/proto",
            "Accept": "application/proto",
            "x-codeium-csrf-token": csrfToken,
            "connect-protocol-version": "1",
        },
        body: Buffer.from(body),
    })

    consola.debug("Response status:", response.status)

    if (!response.ok) {
        const errorText = await response.text()
        consola.error("Language Server error:", response.status, errorText)
        throw new Error(`Language Server 请求失败: ${response.status}`)
    }

    return await response.arrayBuffer()
}

/**
 * 获取 Cascade 轨迹 (包含 AI 回复)
 */
async function getTrajectory(cascadeId: string): Promise<any> {
    const port = state.languageServerPort
    const csrfToken = state.csrfToken

    if (!port || !csrfToken) {
        throw new AntigravityError("Language Server 未初始化", "not_initialized")
    }

    const response = await fetch(`https://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "connect-protocol-version": "1",
            "x-codeium-csrf-token": csrfToken,
        },
        body: JSON.stringify({ cascadeId }),
    })

    if (!response.ok) {
        throw new Error(`GetCascadeTrajectory 失败: ${response.status}`)
    }

    return await response.json()
}

/**
 * 等待并提取最新的 AI 回复
 */
async function waitForAIResponse(cascadeId: string, initialStepCount: number, maxWaitMs = 30000): Promise<string> {
    const startTime = Date.now()
    const pollInterval = 500

    while (Date.now() - startTime < maxWaitMs) {
        await new Promise(resolve => setTimeout(resolve, pollInterval))

        const trajectory = await getTrajectory(cascadeId)
        const steps = trajectory.trajectory?.steps || []

        // 检查是否有新的 PLANNER_RESPONSE
        if (steps.length > initialStepCount) {
            const newSteps = steps.slice(initialStepCount)

            // 查找完成的 PLANNER_RESPONSE
            for (let i = newSteps.length - 1; i >= 0; i--) {
                const step = newSteps[i]
                if (step.type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE" &&
                    step.status === "CORTEX_STEP_STATUS_DONE" &&
                    step.plannerResponse?.response) {
                    return step.plannerResponse.response
                }
            }

            // 检查是否有 NOTIFY_USER (表示需要用户输入)
            for (const step of newSteps) {
                if (step.type === "CORTEX_STEP_TYPE_NOTIFY_USER" && step.notifyUser?.message) {
                    return step.notifyUser.message
                }
            }
        }
    }

    throw new Error("等待 AI 回复超时")
}

/**
 * 调用 Language Server SendUserCascadeMessage 并获取回复
 */
export async function createChatCompletion(request: ChatRequest): Promise<ChatResponse> {
    const cascadeId = await createFreshCascade()

    // 1. 获取当前 step 数量
    const initialTrajectory = await getTrajectory(cascadeId)
    const initialStepCount = initialTrajectory.trajectory?.steps?.length || 0
    consola.debug("Initial step count:", initialStepCount)

    // 2. 发送消息
    const body = buildProtobufRequest(request, cascadeId)
    consola.debug("Request body size:", body.length, "bytes")

    const responseData = await callLanguageServer(
        "/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage",
        body
    )
    consola.debug("Message queued, response size:", responseData.byteLength, "bytes")

    // 3. 轮询等待 AI 回复
    consola.debug("Polling for AI response...")
    const aiResponse = await waitForAIResponse(cascadeId, initialStepCount)

    // 4. 过滤 IDE 上下文泄露
    const filteredResponse = filterIDEContext(aiResponse)

    return {
        content: filteredResponse,
        model: request.model,
        stopReason: "end_turn",
        usage: {
            inputTokens: 0,
            outputTokens: 0,
        },
    }
}

/**
 * 流式调用 - 发送消息并轮询回复（模拟流式）
 * 注意：为了过滤 IDE 上下文，需要先获取完整响应再模拟流式输出
 */
export async function* createChatCompletionStream(request: ChatRequest): AsyncGenerator<string> {
    const cascadeId = await createFreshCascade()

    // 获取初始 step 数量
    const initialTrajectory = await getTrajectory(cascadeId)
    const initialStepCount = initialTrajectory.trajectory?.steps?.length || 0

    // 发送消息
    const body = buildProtobufRequest(request, cascadeId)
    await callLanguageServer(
        "/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage",
        body
    )

    // 轮询等待完整回复
    const startTime = Date.now()
    const maxWaitMs = 60000
    const pollInterval = 300

    while (Date.now() - startTime < maxWaitMs) {
        await new Promise(resolve => setTimeout(resolve, pollInterval))

        const trajectory = await getTrajectory(cascadeId)
        const steps = trajectory.trajectory?.steps || []

        if (steps.length > initialStepCount) {
            const newSteps = steps.slice(initialStepCount)

            for (const step of newSteps) {
                if (step.type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE" &&
                    step.status === "CORTEX_STEP_STATUS_DONE" &&
                    step.plannerResponse?.response) {

                    // 获取完整响应并过滤 IDE 上下文
                    const fullResponse = filterIDEContext(step.plannerResponse.response)

                    // 模拟流式输出（分块返回）
                    const chunkSize = 20  // 每次输出约 20 个字符
                    for (let i = 0; i < fullResponse.length; i += chunkSize) {
                        yield fullResponse.slice(i, i + chunkSize)
                    }
                    return
                }
            }
        }
    }
}
