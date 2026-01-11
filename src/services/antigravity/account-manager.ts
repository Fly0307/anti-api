/**
 * 多账号管理器
 * 支持多个 Google 账号，当一个账号配额耗尽时自动切换
 */

import { state } from "~/lib/state"
import { refreshAccessToken, getProjectID } from "./oauth"
import * as fs from "fs"
import * as path from "path"
import consola from "consola"
import { authStore } from "~/services/auth/store"
import { parseRetryDelay } from "~/lib/retry"

type RateLimitReason =
    | "quota_exhausted"
    | "rate_limit_exceeded"
    | "model_capacity_exhausted"
    | "server_error"
    | "unknown"

function parseRateLimitReason(statusCode: number, errorText: string): RateLimitReason {
    if (statusCode !== 429) {
        if (statusCode >= 500) {
            return "server_error"
        }
        return "unknown"
    }

    const trimmed = errorText.trim()
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
            const json = JSON.parse(trimmed)
            const reason = json?.error?.details?.[0]?.reason
            if (typeof reason === "string") {
                if (reason === "QUOTA_EXHAUSTED") return "quota_exhausted"
                if (reason === "RATE_LIMIT_EXCEEDED") return "rate_limit_exceeded"
                if (reason === "MODEL_CAPACITY_EXHAUSTED") return "model_capacity_exhausted"
            }

            const message = json?.error?.message
            if (typeof message === "string") {
                const msgLower = message.toLowerCase()
                if (msgLower.includes("per minute") || msgLower.includes("rate limit")) {
                    return "rate_limit_exceeded"
                }
            }
        } catch {
            // ignore JSON parse errors
        }
    }

    const lower = errorText.toLowerCase()
    if (lower.includes("per minute") || lower.includes("rate limit") || lower.includes("too many requests")) {
        return "rate_limit_exceeded"
    }
    if (lower.includes("model_capacity") || lower.includes("capacity")) {
        return "model_capacity_exhausted"
    }
    if (lower.includes("exhausted") || lower.includes("quota")) {
        return "quota_exhausted"
    }
    return "unknown"
}

function defaultRateLimitMs(reason: RateLimitReason, failures: number): number {
    switch (reason) {
        case "quota_exhausted": {
            if (failures <= 1) return 60_000
            if (failures === 2) return 5 * 60_000
            if (failures === 3) return 30 * 60_000
            return 2 * 60 * 60_000
        }
        case "rate_limit_exceeded":
            return 30_000
        case "model_capacity_exhausted":
            return 15_000
        case "server_error":
            return 20_000
        default:
            return 60_000
    }
}

export interface Account {
    id: string
    email: string
    accessToken: string
    refreshToken: string
    expiresAt: number
    projectId: string | null
    // 限流状态
    rateLimitedUntil: number | null
    consecutiveFailures: number
}

class AccountManager {
    private accounts: Map<string, Account> = new Map()
    private currentIndex = 0
    private dataFile: string
    private loaded = false

    constructor() {
        const homeDir = process.env.HOME || process.env.USERPROFILE || "."
        this.dataFile = path.join(homeDir, ".anti-api", "accounts.json")
    }

    private ensureLoaded(): void {
        if (!this.loaded) {
            this.load()
        }
    }

    private hydrateFromAuthStore(accountId?: string): void {
        const fromStore = accountId
            ? [authStore.getAccount("antigravity", accountId)].filter(Boolean)
            : authStore.listAccounts("antigravity")

        for (const stored of fromStore) {
            if (!stored || this.accounts.has(stored.id)) continue
            this.accounts.set(stored.id, {
                id: stored.id,
                email: stored.email || stored.login || stored.id,
                accessToken: stored.accessToken,
                refreshToken: stored.refreshToken || "",
                expiresAt: stored.expiresAt || 0,
                projectId: stored.projectId || null,
                rateLimitedUntil: null,
                consecutiveFailures: 0,
            })
        }
    }

    /**
     * 加载账号列表
     */
    load(): void {
        try {
            if (fs.existsSync(this.dataFile)) {
                const data = JSON.parse(fs.readFileSync(this.dataFile, "utf-8"))
                if (Array.isArray(data.accounts)) {
                    for (const acc of data.accounts) {
                        this.accounts.set(acc.id, {
                            ...acc,
                            rateLimitedUntil: null,
                            consecutiveFailures: 0,
                        })
                        authStore.saveAccount({
                            id: acc.id,
                            provider: "antigravity",
                            email: acc.email,
                            accessToken: acc.accessToken,
                            refreshToken: acc.refreshToken,
                            expiresAt: acc.expiresAt,
                            projectId: acc.projectId || undefined,
                            label: acc.email,
                        })
                    }
                }
            }
        } catch (e) {
            consola.warn("Failed to load accounts:", e)
        }

        if (this.accounts.size === 0) {
            this.hydrateFromAuthStore()
        }

        // 如果没有已保存的账号，从 state 迁移当前账号
        if (this.accounts.size === 0 && state.accessToken && state.refreshToken) {
            const id = state.userEmail || "default"
            this.accounts.set(id, {
                id,
                email: state.userEmail || "unknown",
                accessToken: state.accessToken,
                refreshToken: state.refreshToken,
                expiresAt: state.tokenExpiresAt || 0,
                projectId: state.cloudaicompanionProject,
                rateLimitedUntil: null,
                consecutiveFailures: 0,
            })
        }

        this.loaded = true
    }

    /**
     * 保存账号列表
     */
    save(): void {
        try {
            const dir = path.dirname(this.dataFile)
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true })
            }
            const accounts = Array.from(this.accounts.values()).map(acc => ({
                id: acc.id,
                email: acc.email,
                accessToken: acc.accessToken,
                refreshToken: acc.refreshToken,
                expiresAt: acc.expiresAt,
                projectId: acc.projectId,
            }))
            fs.writeFileSync(this.dataFile, JSON.stringify({ accounts }, null, 2))
        } catch (e) {
            consola.warn("Failed to save accounts:", e)
        }
    }

    /**
     * 添加账号
     */
    addAccount(account: Omit<Account, "rateLimitedUntil" | "consecutiveFailures">): void {
        this.accounts.set(account.id, {
            ...account,
            rateLimitedUntil: null,
            consecutiveFailures: 0,
        })
        this.save()
        authStore.saveAccount({
            id: account.id,
            provider: "antigravity",
            email: account.email,
            accessToken: account.accessToken,
            refreshToken: account.refreshToken,
            expiresAt: account.expiresAt,
            projectId: account.projectId || undefined,
            label: account.email,
        })
    }

    /**
     * 获取账号数量
     */
    count(): number {
        return this.accounts.size
    }

    /**
     * 获取所有账号邮箱
     */
    getEmails(): string[] {
        return Array.from(this.accounts.values()).map(a => a.email)
    }

    /**
     * 标记账号为限流状态
     */
    markRateLimited(accountId: string, durationMs: number = 60000): void {
        const account = this.accounts.get(accountId)
        if (account) {
            account.rateLimitedUntil = Date.now() + durationMs
            account.consecutiveFailures++
            consola.warn(`Account ${account.email} rate limited for ${durationMs / 1000}s (failures: ${account.consecutiveFailures})`)
        }
    }

    /**
     * 根据错误信息标记账号限流
     */
    markRateLimitedFromError(
        accountId: string,
        statusCode: number,
        errorText: string,
        retryAfterHeader?: string
    ): { reason: RateLimitReason; durationMs: number } | null {
        const account = this.accounts.get(accountId)
        if (!account) return null

        const reason = parseRateLimitReason(statusCode, errorText)
        const retryDelayMs = parseRetryDelay(errorText, retryAfterHeader)
        account.consecutiveFailures++

        let durationMs = retryDelayMs ?? defaultRateLimitMs(reason, account.consecutiveFailures)
        if (retryDelayMs !== null) {
            durationMs = Math.max(retryDelayMs + 500, 2000)
        }

        account.rateLimitedUntil = Date.now() + durationMs
        consola.warn(
            `Account ${account.email} rate limited (${reason}) for ${Math.ceil(durationMs / 1000)}s (failures: ${account.consecutiveFailures})`
        )
        return { reason, durationMs }
    }

    /**
     * 标记账号成功
     */
    markSuccess(accountId: string): void {
        const account = this.accounts.get(accountId)
        if (account) {
            account.rateLimitedUntil = null
            account.consecutiveFailures = 0
        }
    }

    /**
     * 获取下一个可用账号
     * 跳过当前被限流的账号
     */
    async getNextAvailableAccount(forceRotate: boolean = false): Promise<{
        accessToken: string
        projectId: string
        email: string
        accountId: string
    } | null> {
        this.ensureLoaded()
        if (this.accounts.size === 0) {
            this.hydrateFromAuthStore()
        }
        const now = Date.now()
        const accountList = Array.from(this.accounts.values())

        if (accountList.length === 0) {
            return null
        }

        // 找到第一个可用账号
        let attempts = 0
        while (attempts < accountList.length) {
            if (forceRotate || attempts > 0) {
                this.currentIndex = (this.currentIndex + 1) % accountList.length
            }

            const account = accountList[this.currentIndex]

            // 检查是否被限流
            if (account.rateLimitedUntil && account.rateLimitedUntil > now) {
                const waitSeconds = Math.ceil((account.rateLimitedUntil - now) / 1000)
                consola.debug(`Account ${account.email} is rate limited for ${waitSeconds}s more, trying next...`)
                attempts++
                continue
            }

            // 检查 token 是否过期，如果过期则刷新
            if (account.expiresAt > 0 && now > account.expiresAt - 5 * 60 * 1000) {
                try {
                    const tokens = await refreshAccessToken(account.refreshToken)
                    account.accessToken = tokens.accessToken
                    account.expiresAt = now + tokens.expiresIn * 1000

                    // 刷新 projectId
                    if (!account.projectId) {
                        account.projectId = await getProjectID(account.accessToken)
                    }

                    this.save()
                    authStore.saveAccount({
                        id: account.id,
                        provider: "antigravity",
                        email: account.email,
                        accessToken: account.accessToken,
                        refreshToken: account.refreshToken,
                        expiresAt: account.expiresAt,
                        projectId: account.projectId || undefined,
                        label: account.email,
                    })
                    consola.success(`Refreshed token for ${account.email}`)
                } catch (e) {
                    consola.warn(`Failed to refresh token for ${account.email}:`, e)
                    account.rateLimitedUntil = now + 60000 // 标记为暂时不可用
                    attempts++
                    continue
                }
            }

            return {
                accessToken: account.accessToken,
                projectId: account.projectId || "unknown",
                email: account.email,
                accountId: account.id,
            }
        }

        // 所有账号都被限流，返回等待时间最短的账号
        let bestAccount = accountList[0]
        for (const acc of accountList) {
            if (!acc.rateLimitedUntil) {
                bestAccount = acc
                break
            }
            if (!bestAccount.rateLimitedUntil || (acc.rateLimitedUntil && acc.rateLimitedUntil < bestAccount.rateLimitedUntil)) {
                bestAccount = acc
            }
        }

        // 等待限流结束
        if (bestAccount.rateLimitedUntil && bestAccount.rateLimitedUntil > now) {
            const waitMs = bestAccount.rateLimitedUntil - now
            consola.warn(`All accounts rate limited, waiting ${Math.ceil(waitMs / 1000)}s for ${bestAccount.email}...`)
            await new Promise(resolve => setTimeout(resolve, waitMs))
            bestAccount.rateLimitedUntil = null
        }

        return {
            accessToken: bestAccount.accessToken,
            projectId: bestAccount.projectId || "unknown",
            email: bestAccount.email,
            accountId: bestAccount.id,
        }
    }

    /**
     * 按 ID 获取指定账号（并刷新 token）
     */
    async getAccountById(accountId: string): Promise<{
        accessToken: string
        projectId: string
        email: string
        accountId: string
    } | null> {
        this.ensureLoaded()
        if (!this.accounts.has(accountId)) {
            this.hydrateFromAuthStore(accountId)
        }
        const account = this.accounts.get(accountId)
        if (!account) return null

        const now = Date.now()
        if (account.rateLimitedUntil && account.rateLimitedUntil > now) {
            return null
        }

        if (account.expiresAt > 0 && now > account.expiresAt - 5 * 60 * 1000) {
            try {
                const tokens = await refreshAccessToken(account.refreshToken)
                account.accessToken = tokens.accessToken
                account.expiresAt = now + tokens.expiresIn * 1000

                if (!account.projectId) {
                    account.projectId = await getProjectID(account.accessToken)
                }
                this.save()
                authStore.saveAccount({
                    id: account.id,
                    provider: "antigravity",
                    email: account.email,
                    accessToken: account.accessToken,
                    refreshToken: account.refreshToken,
                    expiresAt: account.expiresAt,
                    projectId: account.projectId || undefined,
                    label: account.email,
                })
                consola.success(`Refreshed token for ${account.email}`)
            } catch (e) {
                consola.warn(`Failed to refresh token for ${account.email}:`, e)
                account.rateLimitedUntil = now + 60000
                return null
            }
        }

        return {
            accessToken: account.accessToken,
            projectId: account.projectId || "unknown",
            email: account.email,
            accountId: account.id,
        }
    }
}

// 全局单例
export const accountManager = new AccountManager()
