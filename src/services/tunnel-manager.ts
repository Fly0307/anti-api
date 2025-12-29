/**
 * 隧道管理服务
 * 支持 cloudflared, ngrok, localtunnel
 */

import { spawn, type ChildProcess } from "child_process"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import consola from "consola"

const CONFIG_FILE = join(process.cwd(), "data", "remote-config.json")

interface TunnelConfig {
    ngrokAuthtoken?: string
    localtunnelSubdomain?: string
}

interface TunnelState {
    process: ChildProcess | { pid: number; kill: () => void } | null
    url: string | null
}

export interface TunnelStatus {
    active: boolean
    url: string | null
    pid: number | null
    error?: string
}

// 隧道状态
const tunnelState: Record<string, TunnelState> = {
    cloudflared: { process: null, url: null },
    ngrok: { process: null, url: null },
    localtunnel: { process: null, url: null },
}

/**
 * 加载配置
 */
function loadConfig(): TunnelConfig {
    try {
        if (existsSync(CONFIG_FILE)) {
            return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"))
        }
    } catch (e) { }
    return {}
}

/**
 * 保存配置
 */
function saveConfig(config: TunnelConfig): void {
    try {
        const dir = join(process.cwd(), "data")
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true })
        }
        writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
    } catch (e) {
        consola.error("Failed to save config:", e)
    }
}

/**
 * 获取所有隧道状态
 */
export function getAllTunnelStatus(): Record<string, TunnelStatus> {
    return {
        cloudflared: {
            active: !!tunnelState.cloudflared.process,
            url: tunnelState.cloudflared.url,
            pid: (tunnelState.cloudflared.process as any)?.pid || null,
        },
        ngrok: {
            active: !!tunnelState.ngrok.process,
            url: tunnelState.ngrok.url,
            pid: (tunnelState.ngrok.process as any)?.pid || null,
        },
        localtunnel: {
            active: !!tunnelState.localtunnel.process,
            url: tunnelState.localtunnel.url,
            pid: (tunnelState.localtunnel.process as any)?.pid || null,
        },
    }
}

/**
 * 获取保存的配置
 */
export function getSavedConfig(): TunnelConfig {
    return loadConfig()
}

/**
 * 启动 Cloudflared 隧道
 */
export async function startCloudflared(port: number): Promise<TunnelStatus> {
    if (tunnelState.cloudflared.process) {
        return { active: true, url: tunnelState.cloudflared.url, pid: (tunnelState.cloudflared.process as any).pid || null }
    }

    return new Promise((resolve) => {
        const proc = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"], {
            stdio: ["ignore", "pipe", "pipe"]
        })

        tunnelState.cloudflared.process = proc

        let resolved = false
        const timeout = setTimeout(() => {
            if (!resolved) {
                resolved = true
                resolve({ active: !!tunnelState.cloudflared.process, url: null, pid: proc.pid || null, error: "60秒超时，建议使用ngrok" })
            }
        }, 60000)

        const handleOutput = (data: Buffer) => {
            const output = data.toString()
            const urlMatch = output.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/)
            if (urlMatch && !resolved) {
                tunnelState.cloudflared.url = urlMatch[0]
                resolved = true
                clearTimeout(timeout)
                resolve({ active: true, url: urlMatch[0], pid: proc.pid || null })
            }
        }

        proc.stdout?.on("data", handleOutput)
        proc.stderr?.on("data", handleOutput)

        proc.on("close", () => {
            tunnelState.cloudflared.process = null
            tunnelState.cloudflared.url = null
            if (!resolved) {
                resolved = true
                clearTimeout(timeout)
                resolve({ active: false, url: null, pid: null, error: "进程退出" })
            }
        })

        proc.on("error", (err) => {
            tunnelState.cloudflared.process = null
            if (!resolved) {
                resolved = true
                clearTimeout(timeout)
                resolve({ active: false, url: null, pid: null, error: err.message })
            }
        })
    })
}

/**
 * 停止 Cloudflared 隧道
 */
export function stopCloudflared(): TunnelStatus {
    if (tunnelState.cloudflared.process) {
        (tunnelState.cloudflared.process as ChildProcess).kill?.()
        tunnelState.cloudflared.process = null
        tunnelState.cloudflared.url = null
    }
    return { active: false, url: null, pid: null }
}

/**
 * 启动 ngrok 隧道
 */
export async function startNgrok(port: number, authtoken?: string): Promise<TunnelStatus> {
    if (tunnelState.ngrok.process) {
        return { active: true, url: tunnelState.ngrok.url, pid: (tunnelState.ngrok.process as any).pid || null }
    }

    if (authtoken) {
        const config = loadConfig()
        config.ngrokAuthtoken = authtoken
        saveConfig(config)
    }

    const config = loadConfig()
    const token = authtoken || config.ngrokAuthtoken

    if (!token) {
        return { active: false, url: null, pid: null, error: "需要 authtoken，请访问 https://ngrok.com/signup 注册获取" }
    }

    return new Promise(async (resolve) => {
        const args = ["http", port.toString(), "--authtoken", token, "--log", "stdout"]
        consola.info("Starting ngrok with args:", args)

        const proc = spawn("ngrok", args, {
            stdio: ["ignore", "pipe", "pipe"]
        })

        tunnelState.ngrok.process = proc

        let attempts = 0
        const maxAttempts = 15

        const checkUrl = async () => {
            attempts++
            try {
                const apiRes = await fetch("http://localhost:4040/api/tunnels")
                const data = await apiRes.json() as any
                const url = data.tunnels?.[0]?.public_url
                if (url) {
                    tunnelState.ngrok.url = url
                    consola.success("Ngrok URL:", url)
                    resolve({ active: true, url, pid: proc.pid || null })
                    return
                }
            } catch (e) { }

            if (attempts < maxAttempts) {
                setTimeout(checkUrl, 2000)
            } else {
                consola.error("Failed to get ngrok URL after", maxAttempts, "attempts")
                resolve({ active: !!tunnelState.ngrok.process, url: null, pid: proc.pid || null, error: "获取URL失败" })
            }
        }

        setTimeout(checkUrl, 2000)

        proc.on("close", (code) => {
            consola.warn(`Ngrok process exited with code ${code}`)
            tunnelState.ngrok.process = null
            tunnelState.ngrok.url = null
        })

        proc.on("error", (err) => {
            consola.error("Ngrok error:", err)
            tunnelState.ngrok.process = null
            resolve({ active: false, url: null, pid: null, error: err.message })
        })
    })
}

/**
 * 停止 ngrok 隧道
 */
export function stopNgrok(): TunnelStatus {
    if (tunnelState.ngrok.process) {
        (tunnelState.ngrok.process as ChildProcess).kill?.()
        tunnelState.ngrok.process = null
        tunnelState.ngrok.url = null
    }
    return { active: false, url: null, pid: null }
}

/**
 * 启动 localtunnel 隧道
 */
export async function startLocaltunnel(port: number, subdomain?: string): Promise<TunnelStatus> {
    if (tunnelState.localtunnel.process) {
        return { active: true, url: tunnelState.localtunnel.url, pid: (tunnelState.localtunnel.process as any).pid || null }
    }

    if (subdomain) {
        const config = loadConfig()
        config.localtunnelSubdomain = subdomain
        saveConfig(config)
    }

    return new Promise(async (resolve) => {
        try {
            const localtunnel = (await import("localtunnel")).default
            const tunnelOptions: any = { port, host: "127.0.0.1", local_host: "127.0.0.1" }
            if (subdomain) {
                tunnelOptions.subdomain = subdomain
            }

            consola.info("Starting localtunnel with options:", tunnelOptions)
            const tunnel = await localtunnel(tunnelOptions)
            consola.info("Localtunnel URL:", tunnel.url)

            tunnelState.localtunnel.process = {
                pid: process.pid,
                kill: () => tunnel.close(),
            } as any
            tunnelState.localtunnel.url = tunnel.url

            tunnel.on("close", () => {
                tunnelState.localtunnel.process = null
                tunnelState.localtunnel.url = null
            })

            tunnel.on("error", (err: any) => {
                consola.error("Localtunnel error:", err)
                tunnelState.localtunnel.process = null
                tunnelState.localtunnel.url = null
            })

            let password = ""
            try {
                const pwdRes = await fetch("https://loca.lt/mytunnelpassword")
                password = (await pwdRes.text()).trim()
            } catch (e) { }

            resolve({
                active: true,
                url: tunnel.url,
                pid: process.pid,
                error: password ? `密码: ${password}` : undefined
            })
        } catch (e: any) {
            consola.error("Failed to start localtunnel:", e)
            resolve({ active: false, url: null, pid: null, error: e.message })
        }
    })
}

/**
 * 停止 localtunnel 隧道
 */
export function stopLocaltunnel(): TunnelStatus {
    if (tunnelState.localtunnel.process) {
        tunnelState.localtunnel.process.kill()
        tunnelState.localtunnel.process = null
        tunnelState.localtunnel.url = null
    }
    return { active: false, url: null, pid: null }
}
