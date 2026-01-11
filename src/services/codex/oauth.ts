import consola from "consola"
import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs"
import { join } from "path"
import { authStore } from "~/services/auth/store"
import type { AuthSource, ProviderAccount } from "~/services/auth/types"

const CODEX_AUTH_FILE = "~/.codex/auth.json"
const CODEX_PROXY_AUTH_DIR = "~/.cli-proxy-api"
const CODEX_PROXY_REFRESH_URL = "https://token.oaifree.com/api/auth/refresh"
const CODEX_CLI_LOGIN_TIMEOUT_MS = 10 * 60 * 1000

type CodexCliLoginSession = {
    id: string
    status: "pending" | "success" | "error"
    message?: string
    userCode?: string
    verificationUri?: string
    output: string
    createdAt: number
    exitCode?: number
    imported?: boolean
    process: ReturnType<typeof Bun.spawn>
}

const codexCliSessions = new Map<string, CodexCliLoginSession>()

const CODEX_OAUTH_CONFIG = {
    clientId: process.env.CODEX_CLIENT_ID || "app_EMoamEEZ73f0CkXaXp7hrann",
    clientSecret: process.env.CODEX_CLIENT_SECRET || "",
    authorizeUrl: "https://auth.openai.com/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    scopes: ["openid", "profile", "email", "offline_access"],
    audience: "https://api.openai.com/v1",
    callbackPort: 51222,
}

type CodexTokens = {
    accessToken: string
    refreshToken?: string
    expiresIn?: number
    idToken?: string
}

type CodexCallbackResult = {
    code?: string
    state?: string
    error?: string
    redirectUri?: string
}

type CodexOAuthSession = {
    state: string
    authUrl: string
    fallbackUrl?: string
    redirectUri: string
    expiresAt: number
    callback?: CodexCallbackResult
    server: any
    codeVerifier?: string
}

let activeSession: CodexOAuthSession | null = null
let callbackServer: any | null = null

function decodeJwt(token: string): Record<string, any> | null {
    const parts = token.split(".")
    if (parts.length < 2) return null
    const payload = parts[1]
    const padded = payload.padEnd(payload.length + (4 - payload.length % 4) % 4, "=")
    try {
        const decoded = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8")
        return JSON.parse(decoded)
    } catch {
        return null
    }
}

function expandHomePath(value: string): string {
    const homeDir = process.env.HOME || process.env.USERPROFILE || ""
    return value.replace(/^~\//, `${homeDir}/`)
}

function parseExpiresAt(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value < 1_000_000_000_000 ? value * 1000 : value
    }
    if (typeof value === "string" && value.trim()) {
        const asNumber = Number(value)
        if (Number.isFinite(asNumber)) {
            return asNumber < 1_000_000_000_000 ? asNumber * 1000 : asNumber
        }
        const parsed = Date.parse(value)
        if (!Number.isNaN(parsed)) {
            return parsed
        }
    }
    return undefined
}

function getJwtExpiresAt(token: string): number | undefined {
    const claims = decodeJwt(token)
    if (!claims || typeof claims.exp !== "number") {
        return undefined
    }
    return claims.exp * 1000
}

function extractCodexTokenFields(raw: any): {
    accessToken?: string
    refreshToken?: string
    idToken?: string
    accountId?: string
    email?: string
    expiresAt?: number
    authSource?: AuthSource
} {
    const source = raw?.tokens ?? raw ?? {}
    const accessToken = source.access_token || source.accessToken || source.OPENAI_API_KEY || source.api_key
    const refreshToken = source.refresh_token || source.refreshToken
    const idToken = source.id_token || source.idToken
    const accountId = source.account_id || source.accountId
    const email = source.email || raw?.email
    const expiresAt = parseExpiresAt(source.expires_at || source.expiresAt || source.expired || source.expiry)
    const rawSource = source.auth_source || raw?.auth_source
    const authSource = rawSource === "cli-proxy" || rawSource === "codex-cli" ? rawSource : undefined

    return { accessToken, refreshToken, idToken, accountId, email, expiresAt, authSource }
}

function deriveAccountIdFromFilename(filename: string): string {
    const base = filename.replace(/^codex-/, "").replace(/\.json$/i, "")
    return base || `codex-${Date.now()}`
}

function isJwtExpired(token: string): boolean {
    const expMs = getJwtExpiresAt(token)
    if (!expMs) {
        return false
    }
    return expMs <= Date.now() + 60_000
}

function sanitizeFileKey(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_")
}

function buildExpiredIso(expiresAt?: number): string | undefined {
    if (!expiresAt) return undefined
    try {
        return new Date(expiresAt).toISOString()
    } catch {
        return undefined
    }
}

function saveCodexProxyAuthFile(account: ProviderAccount, idToken?: string): void {
    const dir = expandHomePath(CODEX_PROXY_AUTH_DIR)
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
    }

    const key = sanitizeFileKey(account.email || account.id)
    const filePath = join(dir, `codex-${key}.json`)
    const payload = {
        access_token: account.accessToken,
        refresh_token: account.refreshToken,
        id_token: idToken,
        account_id: account.id,
        email: account.email,
        expired: buildExpiredIso(account.expiresAt),
        type: "codex",
        auth_source: account.authSource,
    }
    writeFileSync(filePath, JSON.stringify(payload, null, 2))
}

function lastNonEmptyLine(value: string): string | undefined {
    const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    if (lines.length === 0) return undefined
    return lines[lines.length - 1]
}

function stripAnsi(input: string): string {
    return input.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "")
}

function isLikelyDeviceCode(value: string): boolean {
    const cleaned = value.trim().replace(/[^A-Za-z0-9-]/g, "")
    if (cleaned.length < 6) return false
    const lower = cleaned.toLowerCase()
    if (["authorization", "authorize", "authorisation", "browser", "device", "token"].includes(lower)) {
        return false
    }
    if (!/[0-9]/.test(cleaned) && !/-/.test(cleaned)) {
        return false
    }
    return true
}

function extractCodexCliLoginHints(output: string): { verificationUri?: string; userCode?: string } {
    let verificationUri: string | undefined
    let userCode: string | undefined
    const sanitized = stripAnsi(output)

    const urlMatch = sanitized.match(/https?:\/\/[^\s)]+/i)
    if (urlMatch) {
        verificationUri = urlMatch[0]
    } else {
        const openaiMatch = sanitized.match(/\b(?:www\.)?openai\.com\/[^\s)]+/i)
        if (openaiMatch) {
            verificationUri = `https://${openaiMatch[0].replace(/^www\./i, "www.")}`
        }
    }

    const codeLineMatch = sanitized.match(/user\s*code[:\s]+([A-Z0-9-]{4,})/i)
    if (codeLineMatch && isLikelyDeviceCode(codeLineMatch[1])) {
        userCode = codeLineMatch[1]
    } else {
        const codeMatch = sanitized.match(/code[:\s]+([A-Z0-9-]{4,})/i)
        if (codeMatch && isLikelyDeviceCode(codeMatch[1])) {
            userCode = codeMatch[1]
        } else {
            const fallback = sanitized.match(/\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/)
            if (fallback && isLikelyDeviceCode(fallback[0])) {
                userCode = fallback[0]
            }
        }
    }

    if (!userCode && verificationUri) {
        try {
            const parsedUrl = new URL(verificationUri)
            const queryCode =
                parsedUrl.searchParams.get("user_code") ||
                parsedUrl.searchParams.get("code") ||
                parsedUrl.searchParams.get("device_code")
            if (queryCode && isLikelyDeviceCode(queryCode)) {
                userCode = queryCode
            }
        } catch {
            // ignore URL parse errors
        }
    }

    return { verificationUri, userCode }
}

async function readProcessStream(
    stream: ReadableStream<Uint8Array> | null,
    onChunk: (text: string) => void
): Promise<void> {
    if (!stream) return
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) {
            onChunk(decoder.decode(value))
        }
    }
}

function updateCliSessionOutput(session: CodexCliLoginSession, chunk: string): void {
    session.output = (session.output + chunk).slice(-8000)
    const hints = extractCodexCliLoginHints(session.output)
    if (!session.verificationUri && hints.verificationUri) {
        session.verificationUri = hints.verificationUri
    }
    if (!session.userCode && hints.userCode) {
        session.userCode = hints.userCode
    }
}

export async function startCodexCliLogin(): Promise<{
    sessionId: string
    status: "pending" | "error"
    message?: string
    verificationUri?: string
    userCode?: string
}> {
    try {
        const binary = Bun.which("codex")
        if (!binary) {
            return {
                sessionId: crypto.randomUUID(),
                status: "error",
                message: "Codex CLI not found. Install codex and retry.",
            }
        }
        const scriptPath = Bun.which("script")

        for (const session of codexCliSessions.values()) {
            if (session.status === "pending") {
                try {
                    session.process.kill()
                } catch {
                    // ignore
                }
                session.status = "error"
                session.message = "Superseded by a new Codex login"
            }
        }

        const sessionId = crypto.randomUUID()
        const baseArgs = [binary, "login", "--device-auth"]
        const args = scriptPath
            ? (process.platform === "darwin"
                ? [scriptPath, "-q", "/dev/null", ...baseArgs]
                : [scriptPath, "-q", "/dev/null", "-c", baseArgs.join(" ")])
            : baseArgs
        const proc = Bun.spawn(args, {
            stdout: "pipe",
            stderr: "pipe",
            env: {
                ...process.env,
                TERM: process.env.TERM || "xterm-256color",
            },
        })

        const session: CodexCliLoginSession = {
            id: sessionId,
            status: "pending",
            output: "",
            createdAt: Date.now(),
            process: proc,
        }

        codexCliSessions.set(sessionId, session)

        void readProcessStream(proc.stdout, (chunk) => updateCliSessionOutput(session, chunk))
        void readProcessStream(proc.stderr, (chunk) => updateCliSessionOutput(session, chunk))

        void proc.exited.then((code) => {
            session.exitCode = code
            if (code === 0) {
                session.status = "success"
            } else {
                session.status = "error"
                const lastLine = lastNonEmptyLine(stripAnsi(session.output || ""))
                session.message = lastLine || `Codex CLI login exited with code ${code}`
            }
        })

        setTimeout(() => {
            if (session.status === "pending") {
                try {
                    session.process.kill()
                } catch {
                    // ignore
                }
                session.status = "error"
                session.message = "Codex CLI login timed out"
            }
        }, CODEX_CLI_LOGIN_TIMEOUT_MS)

        return {
            sessionId,
            status: session.status,
            message: session.message,
            verificationUri: session.verificationUri,
            userCode: session.userCode,
        }
    } catch (error) {
        return {
            sessionId: crypto.randomUUID(),
            status: "error",
            message: (error as Error).message,
        }
    }
}

export async function getCodexCliLoginStatus(sessionId: string): Promise<{
    status: "pending" | "success" | "error"
    message?: string
    verificationUri?: string
    userCode?: string
    accounts?: ProviderAccount[]
}> {
    const session = codexCliSessions.get(sessionId)
    if (!session) {
        return { status: "error", message: "Codex CLI session not found" }
    }

    if (session.status === "success" && !session.imported) {
        const result = await importCodexAuthSources()
        if (result.accounts.length === 0) {
            if (Date.now() - session.createdAt < 15_000) {
                return {
                    status: "pending",
                    message: "Waiting for Codex auth files...",
                    verificationUri: session.verificationUri,
                    userCode: session.userCode,
                }
            }
        }
        session.imported = true
        return {
            status: "success",
            message: result.accounts.length > 0 ? "Codex CLI login completed" : "Codex CLI login finished, no accounts found",
            verificationUri: session.verificationUri,
            userCode: session.userCode,
            accounts: result.accounts,
        }
    }

    return {
        status: session.status,
        message: session.message,
        verificationUri: session.verificationUri,
        userCode: session.userCode,
    }
}

function openBrowser(url: string): void {
    const platform = process.platform
    let cmd = "xdg-open"
    let args = [url]
    if (platform === "darwin") {
        cmd = "open"
    } else if (platform === "win32") {
        cmd = "cmd"
        args = ["/c", "start", url]
    }
    Bun.spawn([cmd, ...args], { stdout: "ignore", stderr: "ignore" })
}

function buildCodexAuthorizeUrl(): {
    state: string
    authUrl: string
    fallbackUrl?: string
    redirectUri: string
    codeVerifier?: string
} {
    const state = crypto.randomUUID()
    const redirectUri = `http://localhost:${CODEX_OAUTH_CONFIG.callbackPort}/oauth-callback`
    const params = new URLSearchParams({
        client_id: CODEX_OAUTH_CONFIG.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: CODEX_OAUTH_CONFIG.scopes.join(" "),
        state,
        audience: CODEX_OAUTH_CONFIG.audience,
        prompt: "consent",
    })

    const codeVerifier = CODEX_OAUTH_CONFIG.clientSecret ? undefined : generateCodeVerifier()
    if (codeVerifier) {
        params.set("code_challenge", generateCodeChallenge(codeVerifier))
        params.set("code_challenge_method", "S256")
    }

    const authUrl = `${CODEX_OAUTH_CONFIG.authorizeUrl}?${params.toString()}`
    params.delete("audience")
    const fallbackRedirectUri = `http://127.0.0.1:${CODEX_OAUTH_CONFIG.callbackPort}/oauth-callback`
    params.set("redirect_uri", fallbackRedirectUri)
    const fallbackUrl = `${CODEX_OAUTH_CONFIG.authorizeUrl}?${params.toString()}`

    return { state, authUrl, fallbackUrl, redirectUri, codeVerifier }
}

export async function importCodexAuthFile(): Promise<ProviderAccount | null> {
    const expandedPath = expandHomePath(CODEX_AUTH_FILE)
    try {
        const raw = JSON.parse(await Bun.file(expandedPath).text()) as any
        const fields = extractCodexTokenFields(raw)
        let accessToken = fields.accessToken
        const refreshToken = fields.refreshToken
        let expiresAt = fields.expiresAt
        if (!accessToken && !refreshToken) {
            return null
        }

        const idToken = fields.idToken
        const claims = idToken ? decodeJwt(idToken) : null
        const authSource = fields.authSource ?? "codex-cli"
        let email = fields.email || claims?.email
        let accountId = fields.accountId || claims?.sub
        const now = Date.now()
        if (!accessToken && refreshToken) {
            try {
                const refreshed = await refreshCodexAccessToken(refreshToken, "codex-cli")
                accessToken = refreshed.accessToken
                if (refreshed.expiresIn) {
                    expiresAt = now + refreshed.expiresIn * 1000
                }
            } catch (error) {
                consola.warn("Codex refresh failed during import:", error)
                return null
            }
        }
        if (accessToken && isJwtExpired(accessToken) && refreshToken) {
            try {
                const refreshed = await refreshCodexAccessToken(refreshToken, "codex-cli")
                accessToken = refreshed.accessToken
                if (refreshed.expiresIn) {
                    expiresAt = now + refreshed.expiresIn * 1000
                }
            } catch (error) {
                consola.warn("Codex refresh failed during import:", error)
                return null
            }
        }
        if (!accessToken) {
            return null
        }
        if (!expiresAt) {
            expiresAt = getJwtExpiresAt(accessToken)
        }
        if (!accountId) {
            accountId = email || `codex-${Date.now()}`
        }

        const account: ProviderAccount = {
            id: accountId,
            provider: "codex",
            email,
            accessToken,
            refreshToken,
            expiresAt,
            label: email || "Codex Account",
            authSource,
        }

        authStore.saveAccount(account)
        try {
            saveCodexProxyAuthFile(account, idToken)
        } catch (error) {
            consola.warn("Codex proxy auth save failed:", error)
        }
        return account
    } catch (error) {
        consola.warn("Codex auth file import failed:", error)
        return null
    }
}

export async function importCodexProxyAuthFiles(): Promise<ProviderAccount[]> {
    const expandedDir = expandHomePath(CODEX_PROXY_AUTH_DIR)
    if (!existsSync(expandedDir)) {
        return []
    }

    const files = readdirSync(expandedDir).filter(file => file.startsWith("codex-") && file.endsWith(".json"))
    const accounts = new Map<string, ProviderAccount>()

    for (const file of files) {
        try {
            const raw = JSON.parse(readFileSync(join(expandedDir, file), "utf-8")) as any
            const fields = extractCodexTokenFields(raw)
            let accessToken = fields.accessToken
            const refreshToken = fields.refreshToken
            let expiresAt = fields.expiresAt

            if (!accessToken && refreshToken) {
                try {
                    const refreshed = await refreshCodexAccessToken(refreshToken, "cli-proxy")
                    accessToken = refreshed.accessToken
                    if (refreshed.expiresIn) {
                        expiresAt = Date.now() + refreshed.expiresIn * 1000
                    }
                } catch (error) {
                    consola.warn(`Codex proxy refresh failed for ${file}:`, error)
                    continue
                }
            }

            if (!accessToken) {
                continue
            }

            if (!expiresAt) {
                expiresAt = getJwtExpiresAt(accessToken)
            }

            const claims = fields.idToken ? decodeJwt(fields.idToken) : null
            const email = fields.email || claims?.email
            const accountId =
                fields.accountId ||
                claims?.sub ||
                email ||
                deriveAccountIdFromFilename(file)

            const account: ProviderAccount = {
                id: accountId,
                provider: "codex",
                email,
                accessToken,
                refreshToken,
                expiresAt,
                label: email || accountId,
                authSource: fields.authSource ?? "cli-proxy",
            }

            authStore.saveAccount(account)
            accounts.set(account.id, account)
        } catch (error) {
            consola.warn(`Codex proxy auth import failed for ${file}:`, error)
        }
    }

    return Array.from(accounts.values())
}

export async function importCodexAuthSources(): Promise<{ accounts: ProviderAccount[]; sources: string[] }> {
    const sources: string[] = []
    const accounts = new Map<string, ProviderAccount>()

    const cliAccount = await importCodexAuthFile()
    if (cliAccount) {
        sources.push("codex-cli")
        accounts.set(cliAccount.id, cliAccount)
    }

    const proxyAccounts = await importCodexProxyAuthFiles()
    if (proxyAccounts.length > 0) {
        sources.push("cli-proxy")
        for (const account of proxyAccounts) {
            accounts.set(account.id, account)
        }
    }

    return { accounts: Array.from(accounts.values()), sources }
}

export function startCodexOAuthSession(): { state: string; authUrl: string; fallbackUrl?: string; expiresAt: number } {
    if (activeSession && Date.now() < activeSession.expiresAt) {
        return {
            state: activeSession.state,
            authUrl: activeSession.authUrl,
            fallbackUrl: activeSession.fallbackUrl,
            expiresAt: activeSession.expiresAt,
        }
    }

    callbackServer = ensureCodexCallbackServer()

    const { state, authUrl, fallbackUrl, redirectUri, codeVerifier } = buildCodexAuthorizeUrl()
    activeSession = {
        state,
        authUrl,
        redirectUri,
        expiresAt: Date.now() + 5 * 60 * 1000,
        server: callbackServer,
        codeVerifier,
        fallbackUrl,
    }

    return { state, authUrl, fallbackUrl, expiresAt: activeSession.expiresAt }
}

export async function pollCodexOAuthSession(state: string): Promise<{
    status: "pending" | "success" | "error"
    message?: string
    account?: ProviderAccount
}> {
    if (!activeSession || activeSession.state !== state) {
        return { status: "error", message: "No active Codex session" }
    }

    if (Date.now() > activeSession.expiresAt) {
        activeSession = null
        return { status: "error", message: "Codex OAuth session expired" }
    }

    if (!activeSession.callback) {
        return { status: "pending" }
    }

    const callback = activeSession.callback
    if (callback.error) {
        activeSession = null
        return { status: "error", message: callback.error }
    }

    if (!callback.code || callback.state !== state) {
        return { status: "error", message: "Invalid OAuth callback" }
    }

    const redirectUri = callback.redirectUri || activeSession.redirectUri
    const tokenResponse = await exchangeCodexCode(callback.code, redirectUri, activeSession.codeVerifier)
    const claims = tokenResponse.idToken ? decodeJwt(tokenResponse.idToken) : null
    const email = claims?.email
    const accountId = claims?.sub || email || `codex-${Date.now()}`

    const account: ProviderAccount = {
        id: accountId,
        provider: "codex",
        email,
        accessToken: tokenResponse.accessToken,
        refreshToken: tokenResponse.refreshToken,
        expiresAt: tokenResponse.expiresIn ? Date.now() + tokenResponse.expiresIn * 1000 : undefined,
        label: email || "Codex Account",
        authSource: "codex-cli",
    }

    authStore.saveAccount(account)
    try {
        saveCodexProxyAuthFile(account, tokenResponse.idToken)
    } catch (error) {
        consola.warn("Codex proxy auth save failed:", error)
    }
    activeSession = null

    return { status: "success", account }
}

export async function startCodexOAuthLogin(): Promise<ProviderAccount> {
    const state = crypto.randomUUID()
    const redirectUri = `http://localhost:${CODEX_OAUTH_CONFIG.callbackPort}/oauth-callback`

    const params = new URLSearchParams({
        client_id: CODEX_OAUTH_CONFIG.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: CODEX_OAUTH_CONFIG.scopes.join(" "),
        state,
        audience: CODEX_OAUTH_CONFIG.audience,
        prompt: "consent",
    })

    const codeVerifier = CODEX_OAUTH_CONFIG.clientSecret ? undefined : generateCodeVerifier()
    if (codeVerifier) {
        params.set("code_challenge", generateCodeChallenge(codeVerifier))
        params.set("code_challenge_method", "S256")
    }

    const authUrl = `${CODEX_OAUTH_CONFIG.authorizeUrl}?${params.toString()}`

    const { server, waitForCallback } = await startOAuthCallbackServer(CODEX_OAUTH_CONFIG.callbackPort)
    consola.info("Codex OAuth callback server started")

    openBrowser(authUrl)

    const result = await waitForCallback()
    server.stop()

    if (result.error) {
        throw new Error(result.error)
    }
    if (!result.code || result.state !== state) {
        throw new Error("Invalid OAuth callback state")
    }

    const effectiveRedirect = result.redirectUri || redirectUri
    const tokenResponse = await exchangeCodexCode(result.code, effectiveRedirect, codeVerifier)
    const claims = tokenResponse.idToken ? decodeJwt(tokenResponse.idToken) : null
    const email = claims?.email
    const accountId = claims?.sub || email || `codex-${Date.now()}`

    const account: ProviderAccount = {
        id: accountId,
        provider: "codex",
        email,
        accessToken: tokenResponse.accessToken,
        refreshToken: tokenResponse.refreshToken,
        expiresAt: tokenResponse.expiresIn ? Date.now() + tokenResponse.expiresIn * 1000 : undefined,
        label: email || "Codex Account",
        authSource: "codex-cli",
    }

    authStore.saveAccount(account)
    try {
        saveCodexProxyAuthFile(account, tokenResponse.idToken)
    } catch (error) {
        consola.warn("Codex proxy auth save failed:", error)
    }
    return account
}

async function exchangeCodexCode(code: string, redirectUri: string, codeVerifier?: string): Promise<CodexTokens> {
    const params = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CODEX_OAUTH_CONFIG.clientId,
        code,
        redirect_uri: redirectUri,
    })
    if (CODEX_OAUTH_CONFIG.clientSecret) {
        params.set("client_secret", CODEX_OAUTH_CONFIG.clientSecret)
    }
    if (codeVerifier) {
        params.set("code_verifier", codeVerifier)
    }

    const response = await fetch(CODEX_OAUTH_CONFIG.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
    })

    const data = await response.json() as any
    if (!response.ok) {
        throw new Error(data?.error_description || data?.error || "Codex token exchange failed")
    }

    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in,
        idToken: data.id_token,
    }
}

function generateCodeVerifier(): string {
    return base64Url(randomBytes(32))
}

function generateCodeChallenge(verifier: string): string {
    return base64Url(createHash("sha256").update(verifier).digest())
}

function base64Url(buffer: Buffer): string {
    return buffer
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "")
}

export async function refreshCodexAccessToken(
    refreshToken: string,
    authSource?: AuthSource
): Promise<{ accessToken: string; expiresIn?: number }> {
    if (authSource === "cli-proxy") {
        return refreshCodexProxyAccessToken(refreshToken)
    }

    const params = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CODEX_OAUTH_CONFIG.clientId,
        refresh_token: refreshToken,
    })

    const response = await fetch(CODEX_OAUTH_CONFIG.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
    })

    const data = await response.json() as any
    if (!response.ok) {
        throw new Error(data?.error_description || data?.error || "Codex token refresh failed")
    }

    return {
        accessToken: data.access_token,
        expiresIn: data.expires_in,
    }
}

async function refreshCodexProxyAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresIn?: number }> {
    const params = new URLSearchParams({
        refresh_token: refreshToken,
    })

    const response = await fetch(CODEX_PROXY_REFRESH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
    })

    const data = await response.json().catch(() => ({} as any)) as any
    if (!response.ok) {
        throw new Error(data?.error_description || data?.error || "Codex proxy token refresh failed")
    }

    return {
        accessToken: data.access_token || data.accessToken,
        expiresIn: data.expires_in,
    }
}

export async function refreshCodexAccountIfNeeded(account: ProviderAccount): Promise<ProviderAccount> {
    const now = Date.now()
    if (!account.refreshToken) {
        return account
    }

    const hasAccessToken = !!account.accessToken
    const hasExpiry = typeof account.expiresAt === "number" && Number.isFinite(account.expiresAt)

    if (hasAccessToken && hasExpiry && account.expiresAt! > now + 60_000) {
        return account
    }

    if (hasAccessToken && !hasExpiry && !isJwtExpired(account.accessToken)) {
        return account
    }

    const refreshed = await refreshCodexAccessToken(account.refreshToken, account.authSource)
    const updated: ProviderAccount = {
        ...account,
        accessToken: refreshed.accessToken,
    }

    if (refreshed.expiresIn) {
        updated.expiresAt = now + refreshed.expiresIn * 1000
    } else {
        const jwtExpiry = getJwtExpiresAt(refreshed.accessToken)
        if (jwtExpiry) {
            updated.expiresAt = jwtExpiry
        }
    }

    authStore.saveAccount(updated)
    return updated
}

type CodexOAuthProbe = {
    url: string
    ok?: boolean
    status?: number
    statusText?: string
    headers?: Record<string, string>
    bodyPreview?: string
    error?: string
    durationMs: number
}

function pickHeaders(headers: Headers, keys: string[]): Record<string, string> {
    const picked: Record<string, string> = {}
    for (const key of keys) {
        const value = headers.get(key)
        if (value) picked[key] = value
    }
    return picked
}

async function probeUrl(url: string): Promise<CodexOAuthProbe> {
    const start = Date.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)
    try {
        const response = await fetch(url, {
            redirect: "manual",
            signal: controller.signal,
            headers: {
                "User-Agent": "anti-api/1.0",
            },
        })
        clearTimeout(timeout)

        const headers = pickHeaders(response.headers, [
            "content-type",
            "content-length",
            "location",
            "server",
            "cf-ray",
            "cf-cache-status",
            "x-request-id",
            "date",
        ])

        let bodyPreview: string | undefined
        const contentType = response.headers.get("content-type") || ""
        if (contentType.includes("text/html") || contentType.includes("text/plain")) {
            const text = await response.text()
            bodyPreview = text.slice(0, 500)
        }

        return {
            url,
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            headers,
            bodyPreview,
            durationMs: Date.now() - start,
        }
    } catch (error) {
        clearTimeout(timeout)
        const err = error as { message?: string; code?: string; cause?: { code?: string; message?: string } }
        const code = err?.code || err?.cause?.code
        const message = err?.message || err?.cause?.message || String(error)
        return {
            url,
            error: code ? `${code}: ${message}` : message,
            durationMs: Date.now() - start,
        }
    }
}

export async function debugCodexOAuth(): Promise<{
    authUrl: string
    fallbackUrl?: string
    state: string
    redirectUri: string
    probes: { authorize: CodexOAuthProbe; openid: CodexOAuthProbe }
    timestamp: string
}> {
    const { authUrl, fallbackUrl, state, redirectUri } = buildCodexAuthorizeUrl()
    const authorize = await probeUrl(authUrl)
    const openid = await probeUrl("https://auth.openai.com/.well-known/openid-configuration")
    return {
        authUrl,
        fallbackUrl,
        state,
        redirectUri,
        probes: { authorize, openid },
        timestamp: new Date().toISOString(),
    }
}

function startCodexCallbackServer(
    port: number,
    onResult: (result: CodexCallbackResult) => void
): any {
    return Bun.serve({
        port,
        fetch(req) {
            const url = new URL(req.url)
            if (url.pathname === "/oauth-callback") {
                const code = url.searchParams.get("code")
                const state = url.searchParams.get("state")
                const error = url.searchParams.get("error")
                const redirectUri = `${url.origin}${url.pathname}`
                onResult({
                    code: code || undefined,
                    state: state || undefined,
                    error: error || undefined,
                    redirectUri,
                })
                return new Response(`
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <title>Codex OAuth</title>
                        <style>
                            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #000; color: #fff; }
                            h1 { font-size: 42px; }
                        </style>
                    </head>
                    <body>
                        <h1>Codex Connected</h1>
                        <p>You can close this window.</p>
                    </body>
                    </html>
                `, { headers: { "Content-Type": "text/html" } })
            }
            return new Response("Not Found", { status: 404 })
        },
    })
}

function ensureCodexCallbackServer(): any {
    if (callbackServer) {
        return callbackServer
    }
    try {
        callbackServer = startCodexCallbackServer(CODEX_OAUTH_CONFIG.callbackPort, (result) => {
            if (activeSession && activeSession.state === result.state) {
                activeSession.callback = result
            }
        })
        return callbackServer
    } catch (error) {
        throw new Error(`Codex callback port ${CODEX_OAUTH_CONFIG.callbackPort} is in use.`)
    }
}

async function startOAuthCallbackServer(port: number): Promise<{
    server: any
    waitForCallback: () => Promise<{ code?: string; state?: string; error?: string; redirectUri?: string }>
}> {
    let callbackResolve: ((result: { code?: string; state?: string; error?: string; redirectUri?: string }) => void) | null = null
    const callbackPromise = new Promise<{ code?: string; state?: string; error?: string; redirectUri?: string }>((res) => {
        callbackResolve = res
    })

    const server = startCodexCallbackServer(port, (result) => {
        if (callbackResolve) {
            callbackResolve(result)
        }
    })

    return {
        server,
        waitForCallback: () => callbackPromise,
    }
}
