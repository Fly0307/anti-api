import { Hono } from "hono"
import { forwardError } from "~/lib/error"
import { handleResponses } from "./responses"

export const openaiResponsesRoutes = new Hono()

openaiResponsesRoutes.post("/", async (c) => {
    try {
        return await handleResponses(c)
    } catch (error) {
        return await forwardError(c, error)
    }
})
