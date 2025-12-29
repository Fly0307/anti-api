/**
 * OpenAI /v1/chat/completions 路由
 */

import { Hono } from "hono"
import { forwardError } from "~/lib/error"
import { handleChatCompletion } from "./handler"

export const openaiRoutes = new Hono()

openaiRoutes.post("/", async (c) => {
    try {
        return await handleChatCompletion(c)
    } catch (error) {
        return await forwardError(c, error)
    }
})
