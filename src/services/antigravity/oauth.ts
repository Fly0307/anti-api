/**
 * Antigravity OAuth 配置和工具函数
 * 基于 CLIProxyAPI 的实现
 */

import { state } from "~/lib/state"

// OAuth 配置（来自 CLIProxyAPI）
export const OAUTH_CONFIG = {
    clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    clientSecret: "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",
    callbackPort: 51121,
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
    projectUrl: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    scopes: [
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/cclog",
        "https://www.googleapis.com/auth/experimentsandconfigs",
    ],
}

/**
 * 生成随机 state 用于 CSRF 保护
 */
export function generateState(): string {
    return crypto.randomUUID()
}

/**
 * 生成 OAuth 授权 URL
 */
export function generateAuthURL(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
        client_id: OAUTH_CONFIG.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: OAUTH_CONFIG.scopes.join(" "),
        access_type: "offline",
        prompt: "consent",
        state,
    })
    return `${OAUTH_CONFIG.authUrl}?${params.toString()}`
}

/**
 * 交换 authorization code 获取 tokens
 */
export async function exchangeCode(code: string, redirectUri: string): Promise<{
    accessToken: string
    refreshToken: string
    expiresIn: number
}> {
    const params = new URLSearchParams({
        code,
        client_id: OAUTH_CONFIG.clientId,
        client_secret: OAUTH_CONFIG.clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
    })

    const response = await fetch(OAUTH_CONFIG.tokenUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
    })

    if (!response.ok) {
        const error = await response.text()
        throw new Error(`Token exchange failed: ${response.status} ${error}`)
    }

    const data = await response.json() as {
        access_token: string
        refresh_token: string
        expires_in: number
    }

    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in,
    }
}

/**
 * 获取用户信息（从 Google API）
 */
export async function fetchUserInfo(accessToken: string): Promise<{ email: string }> {
    const response = await fetch(OAUTH_CONFIG.userInfoUrl, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    })

    if (!response.ok) {
        throw new Error(`Failed to get user info: ${response.status}`)
    }

    const data = await response.json() as { email: string }
    return data
}

/**
 * 获取 Antigravity Project ID
 */
export async function getProjectID(accessToken: string): Promise<string | null> {
    try {
        const response = await fetch(OAUTH_CONFIG.projectUrl, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
                "User-Agent": "google-api-nodejs-client/9.15.1",
                "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
                "Client-Metadata": JSON.stringify({
                    ideType: "IDE_UNSPECIFIED",
                    platform: "PLATFORM_UNSPECIFIED",
                    pluginType: "GEMINI",
                }),
            },
            body: JSON.stringify({
                metadata: {
                    ideType: "IDE_UNSPECIFIED",
                    platform: "PLATFORM_UNSPECIFIED",
                    pluginType: "GEMINI",
                },
            }),
        })

        if (!response.ok) {
            return null
        }

        const data = await response.json() as { cloudaicompanionProject?: string }
        return data.cloudaicompanionProject || null
    } catch (error) {
        console.error("Failed to get project ID:", error)
        return null
    }
}

/**
 * 刷新 access token
 */
export async function refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string
    expiresIn: number
}> {
    const params = new URLSearchParams({
        client_id: OAUTH_CONFIG.clientId,
        client_secret: OAUTH_CONFIG.clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
    })

    const response = await fetch(OAUTH_CONFIG.tokenUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
    })

    if (!response.ok) {
        const error = await response.text()
        throw new Error(`Token refresh failed: ${response.status} ${error}`)
    }

    const data = await response.json() as {
        access_token: string
        expires_in: number
    }

    return {
        accessToken: data.access_token,
        expiresIn: data.expires_in,
    }
}

/**
 * 获取访问令牌（如果过期则自动刷新）
 */
export async function getAccessToken(): Promise<string> {
    if (!state.accessToken) {
        throw new Error("Not authenticated. Please login first.")
    }

    // 检查 token 是否过期（提前 5 分钟刷新）
    const now = Date.now()
    const expiresAt = state.tokenExpiresAt || 0
    const needsRefresh = expiresAt > 0 && (now > expiresAt - 5 * 60 * 1000)

    if (needsRefresh && state.refreshToken) {
        try {
            const tokens = await refreshAccessToken(state.refreshToken)
            state.accessToken = tokens.accessToken
            state.antigravityToken = tokens.accessToken
            state.tokenExpiresAt = now + tokens.expiresIn * 1000

            // 保存刷新后的 token
            const { saveAuth } = await import("./login")
            saveAuth()

            console.log("[OAuth] Token refreshed successfully")
        } catch (error) {
            console.error("[OAuth] Token refresh failed:", error)
            // 刷新失败时抛出错误，让用户重新登录
            throw new Error("Token expired and refresh failed. Please re-login.")
        }
    }

    return state.accessToken
}

/**
 * OAuth 回调服务器
 */
interface OAuthCallbackResult {
    code?: string
    state?: string
    error?: string
}

export function startOAuthCallbackServer(): Promise<{
    server: any
    port: number
    waitForCallback: () => Promise<OAuthCallbackResult>
}> {
    return new Promise((resolve, reject) => {
        let callbackResolve: ((result: OAuthCallbackResult) => void) | null = null
        const callbackPromise = new Promise<OAuthCallbackResult>((res) => {
            callbackResolve = res
        })

        const server = Bun.serve({
            port: OAUTH_CONFIG.callbackPort,
            fetch(req) {
                const url = new URL(req.url)

                if (url.pathname === "/oauth-callback") {
                    const code = url.searchParams.get("code")
                    const state = url.searchParams.get("state")
                    const error = url.searchParams.get("error")

                    if (callbackResolve) {
                        callbackResolve({ code: code || undefined, state: state || undefined, error: error || undefined })
                    }

                    // 返回成功页面
                    return new Response(`
                        <!DOCTYPE html>
                        <html>
                        <head>
                            <title>Succeed</title>
                            <style>
                                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #000; color: #fff; }
                                h1 { color: #fff; font-size: 48px; }
                            </style>
                        </head>
                        <body>
                            <h1>Succeed</h1>
                        </body>
                        </html>
                    `, {
                        headers: { "Content-Type": "text/html" },
                    })
                }

                return new Response("Not Found", { status: 404 })
            },
        })

        resolve({
            server,
            port: OAUTH_CONFIG.callbackPort,
            waitForCallback: () => callbackPromise,
        })
    })
}
