import { spawn } from "node:child_process"
import { existsSync } from "fs"
import { authStore } from "~/services/auth/store"
import type { ProviderAccount } from "~/services/auth/types"
import { fetchZedAuthenticatedUser } from "./chat"

const ZED_APP_PATH = "/Applications/Zed.app"
const ZED_SERVER_URL = "https://zed.dev"
const KEYCHAIN_TIMEOUT_MS = 8000

function runSecurity(args: string[], timeoutMs = KEYCHAIN_TIMEOUT_MS): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn("security", args, { stdio: ["ignore", "pipe", "pipe"] })
        let stdout = ""
        let stderr = ""
        const timer = setTimeout(() => {
            child.kill("SIGTERM")
            reject(new Error("Timed out while reading Zed credentials from macOS Keychain. Approve keychain access for anti-api and try again."))
        }, timeoutMs)

        child.stdout.on("data", (chunk) => {
            stdout += String(chunk)
        })
        child.stderr.on("data", (chunk) => {
            stderr += String(chunk)
        })
        child.on("error", (error) => {
            clearTimeout(timer)
            reject(error)
        })
        child.on("close", (code) => {
            clearTimeout(timer)
            if (code === 0) {
                resolve(stdout || stderr)
                return
            }
            reject(new Error((stderr || stdout || "Failed to read Zed credentials").trim()))
        })
    })
}

async function readZedKeychainAccountId(): Promise<string> {
    const output = await runSecurity(["find-internet-password", "-s", ZED_SERVER_URL])
    const match = output.match(/"acct"<blob>="([^"]+)"/)
    const accountId = match?.[1]?.trim()
    if (!accountId) {
        throw new Error("Could not locate Zed account id in macOS Keychain.")
    }
    return accountId
}

async function readZedKeychainAccessToken(): Promise<string> {
    const output = await runSecurity(["find-internet-password", "-s", ZED_SERVER_URL, "-w"])
    const token = output.trim()
    if (!token) {
        throw new Error("Could not read Zed access token from macOS Keychain.")
    }
    return token
}

export async function importZedLocalAccount(): Promise<ProviderAccount> {
    if (!existsSync(ZED_APP_PATH)) {
        throw new Error("Zed.app is not installed in /Applications.")
    }

    const userId = await readZedKeychainAccountId()
    const accessToken = await readZedKeychainAccessToken()
    const profile = await fetchZedAuthenticatedUser(userId, accessToken, ZED_SERVER_URL)

    const account: ProviderAccount = {
        id: String(profile.user.id),
        provider: "zed",
        login: profile.user.github_login,
        label: profile.user.name || profile.user.github_login,
        accessToken,
        organizationId: profile.organizations?.[0]?.id,
        serverUrl: ZED_SERVER_URL,
        authSource: "zed-local",
    }

    authStore.saveAccount(account)
    return account
}
