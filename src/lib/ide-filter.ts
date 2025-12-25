/**
 * IDE 上下文过滤器
 * 过滤 Antigravity 返回中泄露的 IDE 状态信息
 * 
 * 问题：Antigravity 会在响应中添加 IDE 上下文信息（如"我注意到你打开了..."）
 * Claude Code 会记住这些响应，导致上下文"污染"后续请求
 * 解决：在返回响应前过滤掉这些 IDE 相关内容
 */

// 匹配需要完全移除的句子模式
// 注意：使用 [\s\S] 而不是 . 来匹配包括换行符的任何字符
const REMOVE_SENTENCE_PATTERNS: RegExp[] = [
    // 中文 - 关于文件/项目的观察（匹配到句号、感叹号、逗号、问号或换行）
    /我注意到[\s\S]*?[。！？，,\n]/g,
    /我看到[\s\S]*?[。！？，,\n]/g,
    /看起来你[\s\S]*?(?:正在|打开|查看|编辑)[\s\S]*?[。！？，,\n]/g,
    /需要我帮你[\s\S]*?[。！？\n]/g,
    /如果你需要[\s\S]*?[。！？\n]/g,

    // 中文 - 关于 Antigravity 身份
    /我是\s*Antigravity[\s\S]*?[。！\n]/gi,
    /由\s*Google\s*DeepMind[\s\S]*?[。！\n]/gi,
    /Google\s*DeepMind\s*团队[\s\S]*?[。！\n]/gi,

    // 英文 - 关于文件/项目的观察
    /I (?:notice|see|observe|can see)[\s\S]*?[.!?\n]/gi,
    /(?:Looking at|Based on|From) (?:your|the) (?:open|current|active)[\s\S]*?[.!?\n]/gi,
    /You(?:'re| are) (?:currently |now )?(?:viewing|looking at|editing|working on)[\s\S]*?[.!?\n]/gi,
    /It (?:looks like|seems like|appears) you[\s\S]*?[.!?\n]/gi,
    /If you need (?:help|assistance) with (?:this|the) (?:script|project|file)[\s\S]*?[.!?\n]/gi,

    // 英文 - 关于 Antigravity 身份
    /I(?:'m| am) Antigravity[\s\S]*?[.!\n]/gi,
    /developed by Google DeepMind[\s\S]*?[.!\n]/gi,
]

// 匹配需要移除的开头段落
const REMOVE_LEADING_PATTERNS: RegExp[] = [
    // 移除问候语后面紧跟的 IDE 上下文（允许换行）
    /^(你好[！!]?\s*[。.]?\s*[\n]?)(?:我注意到|我看到|看起来你)[\s\S]*?(?:[。！？]\s*)/i,
    /^(Hello[!]?\s*[.]?\s*[\n]?)(?:I notice|I see|It looks like)[\s\S]*?(?:[.!?]\s*)/i,
]

/**
 * 过滤 AI 响应中的 IDE 上下文信息
 */
export function filterIDEContext(response: string): string {
    let filtered = response

    // 调试日志
    const originalLength = filtered.length

    // 1. 移除开头的 IDE 上下文
    for (const pattern of REMOVE_LEADING_PATTERNS) {
        pattern.lastIndex = 0
        filtered = filtered.replace(pattern, '$1')
    }

    // 2. 移除完整的 IDE 上下文句子
    for (const pattern of REMOVE_SENTENCE_PATTERNS) {
        pattern.lastIndex = 0
        filtered = filtered.replace(pattern, '')
    }

    // 3. 清理多余的空行和空格
    filtered = filtered
        .replace(/\n{3,}/g, '\n\n')  // 多个空行变成两个
        .replace(/[ \t]+\n/g, '\n')   // 行尾空格
        .trim()

    // 4. 如果过滤后变空了，返回通用问候
    if (filtered.length < 5) {
        filtered = "你好！有什么可以帮助你的吗？"
    }

    return filtered
}

/**
 * 检测响应是否包含 IDE 上下文
 */
export function hasIDEContext(response: string): boolean {
    for (const pattern of REMOVE_SENTENCE_PATTERNS) {
        pattern.lastIndex = 0
        if (pattern.test(response)) {
            return true
        }
    }
    return false
}
