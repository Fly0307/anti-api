/**
 * Auth 路由
 */

import { Hono } from "hono"
import { isAuthenticated, getUserInfo, setAuth, clearAuth, startOAuthLogin } from "~/services/antigravity/login"

export const authRouter = new Hono()

// 获取认证状态
authRouter.get("/status", (c) => {
    const userInfo = getUserInfo()
    return c.json({
        authenticated: isAuthenticated(),
        email: userInfo.email,
        name: userInfo.name,
    })
})

// 登录（触发 OAuth 或设置 token）
authRouter.post("/login", async (c) => {
    try {
        // 尝试解析 body，如果为空则触发 OAuth
        let body: { accessToken?: string; refreshToken?: string; email?: string; name?: string } = {}
        try {
            const text = await c.req.text()
            if (text && text.trim()) {
                body = JSON.parse(text)
            }
        } catch {
            // body 为空或无效 JSON
        }

        // 如果没有 accessToken，启动 OAuth 流程
        if (!body.accessToken) {
            const result = await startOAuthLogin()
            if (result.success) {
                return c.json({
                    success: true,
                    authenticated: true,
                    email: result.email,
                })
            } else {
                return c.json({ success: false, error: result.error }, 400)
            }
        }

        // 直接设置 token
        setAuth(body.accessToken, body.refreshToken, body.email, body.name)

        return c.json({
            success: true,
            authenticated: true,
            email: body.email,
            name: body.name,
        })
    } catch (error) {
        return c.json({ error: (error as Error).message }, 500)
    }
})

// 登出
authRouter.post("/logout", (c) => {
    clearAuth()
    return c.json({ success: true, authenticated: false })
})
