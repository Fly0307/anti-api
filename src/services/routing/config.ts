import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { randomUUID } from "crypto"
import consola from "consola"
import type { AuthProvider } from "~/services/auth/types"

export interface RoutingEntry {
    id: string
    provider: AuthProvider
    accountId: string
    modelId: string
    label: string
    accountLabel?: string
}

export interface RoutingFlow {
    id: string
    name: string
    entries: RoutingEntry[]
}

export interface RoutingConfig {
    version: number
    updatedAt: string
    flows: RoutingFlow[]
}

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || "."
const ROUTING_FILE = join(HOME_DIR, ".anti-api", "routing.json")
const CURRENT_VERSION = 2

function ensureDir(): void {
    const dir = join(HOME_DIR, ".anti-api")
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
    }
}

function normalizeEntry(entry: RoutingEntry): RoutingEntry {
    return {
        ...entry,
        id: entry.id || randomUUID(),
        label: entry.label || `${entry.provider}:${entry.modelId}`,
    }
}

function normalizeFlow(flow: Partial<RoutingFlow>, index: number): RoutingFlow {
    const name = (flow.name || `Flow ${index + 1}`).trim()
    const entries = Array.isArray(flow.entries) ? flow.entries.map(normalizeEntry) : []

    return {
        id: flow.id || randomUUID(),
        name: name || `Flow ${index + 1}`,
        entries,
    }
}

function normalizeConfig(raw: Partial<RoutingConfig> & { entries?: RoutingEntry[] }): RoutingConfig {
    const updatedAt = raw.updatedAt || new Date().toISOString()

    if (Array.isArray(raw.flows)) {
        return {
            version: raw.version || CURRENT_VERSION,
            updatedAt,
            flows: raw.flows.map((flow, index) => normalizeFlow(flow, index)),
        }
    }

    if (Array.isArray(raw.entries)) {
        const legacyEntries = raw.entries.map(normalizeEntry)
        return {
            version: CURRENT_VERSION,
            updatedAt,
            flows: legacyEntries.length
                ? [{ id: randomUUID(), name: "default", entries: legacyEntries }]
                : [],
        }
    }

    return { version: CURRENT_VERSION, updatedAt, flows: [] }
}

export function loadRoutingConfig(): RoutingConfig {
    try {
        if (!existsSync(ROUTING_FILE)) {
            return { version: CURRENT_VERSION, updatedAt: new Date().toISOString(), flows: [] }
        }
        const raw = JSON.parse(readFileSync(ROUTING_FILE, "utf-8")) as Partial<RoutingConfig> & {
            entries?: RoutingEntry[]
        }
        return normalizeConfig(raw)
    } catch (error) {
        consola.warn("Failed to load routing config:", error)
        return { version: CURRENT_VERSION, updatedAt: new Date().toISOString(), flows: [] }
    }
}

export function saveRoutingConfig(flows: RoutingFlow[]): RoutingConfig {
    ensureDir()
    const config: RoutingConfig = {
        version: CURRENT_VERSION,
        updatedAt: new Date().toISOString(),
        flows: flows.map((flow, index) => normalizeFlow(flow, index)),
    }
    writeFileSync(ROUTING_FILE, JSON.stringify(config, null, 2))
    return config
}
