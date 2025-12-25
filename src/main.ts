#!/usr/bin/env bun
/**
 * Anti-API 入口
 * 将Antigravity内置大模型暴露为Anthropic兼容API
 */

import { defineCommand, runMain } from "citty"
import consola from "consola"

import { server } from "./server"
import { setupAntigravityToken } from "./lib/token"
import { getLanguageServerInfo } from "./lib/port-finder"
import { state } from "./lib/state"

const start = defineCommand({
    meta: {
        name: "start",
        description: "启动Anti-API服务器",
    },
    args: {
        port: {
            type: "string",
            default: "8964",
            description: "监听端口",
            alias: "p",
        },
        verbose: {
            type: "boolean",
            default: false,
            description: "详细日志",
            alias: "v",
        },
    },
    async run({ args }) {
        state.port = parseInt(args.port, 10)
        state.verbose = args.verbose

        if (args.verbose) {
            consola.level = 4 // debug
        } else {
            consola.level = 0 // silent - only show request logs
        }

        // 读取Antigravity token
        await setupAntigravityToken()

        // 获取language_server信息
        const lsInfo = await getLanguageServerInfo()
        if (lsInfo) {
            state.languageServerPort = lsInfo.port
            state.csrfToken = lsInfo.csrfToken
        }

        // 启动服务器
        Bun.serve({
            fetch: server.fetch,
            port: state.port,
        })
    },
})

const main = defineCommand({
    meta: {
        name: "anti-api",
        description: "Antigravity API Proxy - 将Antigravity内置大模型暴露为Anthropic兼容API",
    },
    subCommands: { start },
})

await runMain(main)
