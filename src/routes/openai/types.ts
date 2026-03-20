/**
 * OpenAI API 类型定义
 */

export interface OpenAIChatCompletionRequest {
    model: string
    messages: OpenAIMessage[]
    stream?: boolean
    max_tokens?: number
    temperature?: number
    top_p?: number
    tools?: OpenAITool[]
    reasoning_effort?: "low" | "medium" | "high"
    reasoning?: {
        effort?: "low" | "medium" | "high"
    }
}

export type OpenAIResponsesToolChoice =
    | "auto"
    | "none"
    | "required"
    | {
        type: "function"
        name: string
    }

export interface OpenAIResponsesFunctionTool {
    type: "function"
    name: string
    description?: string
    parameters?: Record<string, any>
    strict?: boolean
}

export type OpenAIResponsesInputContent =
    | {
        type: "input_text" | "output_text" | "text"
        text: string
    }
    | {
        type: "input_image"
        image_url?: string
        file_id?: string
        detail?: "low" | "high" | "auto"
    }
    | {
        type: "input_file"
        file_id?: string
        file_url?: string
        file_data?: string
        filename?: string
    }

export type OpenAIResponsesInputItem =
    | string
    | {
        type?: "message"
        role: "system" | "user" | "assistant" | "developer"
        content: string | OpenAIResponsesInputContent[]
        phase?: "commentary" | "final_answer"
    }
    | {
        type: "function_call"
        id?: string
        call_id: string
        name: string
        arguments: string
        status?: "in_progress" | "completed" | "incomplete"
    }
    | {
        type: "function_call_output"
        id?: string
        call_id: string
        output: string | OpenAIResponsesInputContent[]
        status?: "in_progress" | "completed" | "incomplete"
    }

export interface OpenAIResponsesRequest {
    model: string
    input: string | OpenAIResponsesInputItem[] | OpenAIResponsesInputItem
    stream?: boolean
    max_output_tokens?: number | null
    temperature?: number | null
    top_p?: number
    tools?: OpenAIResponsesFunctionTool[] | null
    tool_choice?: OpenAIResponsesToolChoice
    reasoning?: {
        effort?: "low" | "medium" | "high"
    }
    previous_response_id?: string
    store?: boolean
    user?: string
    metadata?: Record<string, string>
}

export interface OpenAIMessage {
    role: "system" | "user" | "assistant" | "tool" | "developer"
    content: string | null
    tool_calls?: OpenAIToolCall[]
    tool_call_id?: string
}

export interface OpenAITool {
    type: "function"
    function: {
        name: string
        description?: string
        parameters?: Record<string, any>
    }
}

export interface OpenAIToolCall {
    id: string
    type: "function"
    function: {
        name: string
        arguments: string
    }
}

export interface OpenAIChatCompletionResponse {
    id: string
    object: "chat.completion"
    created: number
    model: string
    choices: OpenAIChoice[]
    usage?: OpenAIUsage
}

export interface OpenAIChoice {
    index: number
    message: OpenAIMessage
    finish_reason: "stop" | "length" | "tool_calls" | null
}

export interface OpenAIUsage {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
}

export interface OpenAIStreamChunk {
    id: string
    object: "chat.completion.chunk"
    created: number
    model: string
    choices: OpenAIStreamChoice[]
}

export interface OpenAIStreamChoice {
    index: number
    delta: Partial<OpenAIMessage>
    finish_reason: "stop" | "length" | "tool_calls" | null
}
