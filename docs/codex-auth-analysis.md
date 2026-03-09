# Codex 账号接入与认证逻辑分析

## 涉及文件

- `src/routes/auth/route.ts`
- `src/services/codex/oauth.ts`
- `src/services/codex/chat.ts`
- `src/services/auth/store.ts`
- `src/server.ts`

---

## 总体结论

当前项目里 Codex 账号接入有两条主路径：

1. **导入现有本机认证**
   - 从 `~/.codex/auth.json`
   - 或 `~/.cli-proxy-api/codex-*.json`
   - 导入后写入项目自己的 `authStore`

2. **浏览器 OAuth 登录**
   - 服务端启动本地回调端口
   - 生成 OpenAI OAuth 授权链接
   - 浏览器完成授权后回调本地 `/auth/callback`
   - 服务端拿 `code` 换 `access_token / refresh_token / id_token`
   - 保存到 `authStore`，并额外回写一份到 `~/.cli-proxy-api/`

另外，项目里还保留了 **Codex CLI device-auth 登录状态轮询能力**，但从当前 `authRouter.post("/login")` 逻辑看，Codex 的主登录入口现在优先走导入 / 浏览器 OAuth，而不是主动触发 `codex login --device-auth`。

---

## 1. 接入入口

### 1.1 服务启动时自动导入

在 `src/server.ts:74` 开始：

- 启动时会自动执行 `importCodexAuthSources()`
- 从本机已有 Codex 认证文件中导入账号
- 成功后会打印导入结果

关键位置：
- `src/server.ts:74`
- `src/services/codex/oauth.ts:871`

这意味着只要用户机器上已经有 Codex CLI 或代理残留的认证文件，项目启动时就会直接导入账号。

### 1.2 HTTP 登录入口

在 `src/routes/auth/route.ts:48` 的 `POST /auth/login`。

当 `provider === "codex"` 时：

#### 情况 A：`force: true`
直接强制启动浏览器 OAuth：
- `startCodexOAuthSession()`
- 返回：
  - `state`
  - `auth_url`
  - `fallback_url`
  - `expires_at`

代码位置：
- `src/routes/auth/route.ts:89`
- `src/services/codex/oauth.ts:892`

#### 情况 B：默认行为
先尝试导入本地认证：
- `importCodexAuthSources()`

如果导入到账号：
- 直接返回 success，`source=import`

如果没有导入到：
- 再退回浏览器 OAuth

代码位置：
- `src/routes/auth/route.ts:108`
- `src/routes/auth/route.ts:125`

所以 Codex 登录策略是：

**先复用本机已有登录态，复用不了再走交互式 OAuth。**

---

## 2. Codex 凭证来源

Codex 认证源定义在 `src/services/codex/oauth.ts`：

```ts
const CODEX_AUTH_FILE = "~/.codex/auth.json"
const CODEX_PROXY_AUTH_DIR = "~/.cli-proxy-api"
```

对应两类来源。

### 2.1 `~/.codex/auth.json`

由 `importCodexAuthFile()` 导入，位置：
- `src/services/codex/oauth.ts:719`

支持提取字段：
- `access_token` / `accessToken` / `OPENAI_API_KEY` / `api_key`
- `refresh_token` / `refreshToken`
- `id_token` / `idToken`
- `account_id` / `accountId`
- `email`
- `expires_at` / `expiresAt` / `expired` / `expiry`

提取逻辑在：
- `src/services/codex/oauth.ts:301`

这说明它兼容多种 Codex/代理文件格式，不只认一种 schema。

### 2.2 `~/.cli-proxy-api/codex-*.json`

由 `importCodexProxyAuthFiles()` 导入，位置：
- `src/services/codex/oauth.ts:801`

会扫描目录里所有：
- `codex-*.json`

每个文件都尝试提取 token 并导入为账号。

### 2.3 `authSource` 标记

账号来源会被标成两种之一：
- `"codex-cli"`
- `"cli-proxy"`

类型定义：
- `src/services/auth/types.ts:2`

这个字段后续会直接影响 refresh token 的刷新路径。

---

## 3. OAuth 登录流程

### 3.1 OAuth 参数

在 `src/services/codex/oauth.ts:31`：

- `clientId`: 环境变量 `CODEX_CLIENT_ID`，默认 `app_EMoamEEZ73f0CkXaXp7hrann`
- `clientSecret`: `CODEX_CLIENT_SECRET`，默认空
- `authorizeUrl`: `https://auth.openai.com/oauth/authorize`
- `tokenUrl`: `https://auth.openai.com/oauth/token`
- `scopes`:
  - `openid`
  - `email`
  - `profile`
  - `offline_access`

说明：
- 项目使用的是 OpenAI 官方 OAuth 端点
- 请求了 `offline_access`，因此会拿到 `refresh_token`

### 3.2 本地回调服务

OAuth 会在本地起一个 callback server：

- 默认端口：`1455`
- 回调路径：`/auth/callback`

代码：
- `src/services/codex/oauth.ts:37`
- `src/services/codex/oauth.ts:1308`
- `src/services/codex/oauth.ts:1349`

如果 1455 被占用，会尝试 `1455 ~ 1465`：
- `src/services/codex/oauth.ts:1354`
- `src/services/codex/oauth.ts:1392`

### 3.3 PKCE 支持

在 `buildCodexAuthorizeUrl()` 中：
- 如果没有 `CODEX_CLIENT_SECRET`
- 就生成 `code_verifier` / `code_challenge`

代码：
- `src/services/codex/oauth.ts:685`
- `src/services/codex/oauth.ts:705`
- `src/services/codex/oauth.ts:1076`

因此支持两种模式：
- confidential client：带 `client_secret`
- public client：PKCE

### 3.4 状态轮询

前端拿到 `state` 后，可以轮询：

- `GET /auth/codex/status?state=...`

服务端调用：
- `pollCodexOAuthSession(state)`

代码位置：
- `src/routes/auth/route.ts:208`
- `src/services/codex/oauth.ts:919`

轮询逻辑会：
1. 检查 session 是否存在
2. 检查是否过期
3. 检查 callback 是否已到达
4. 若有 `code`，调用 `exchangeCodexCode(...)` 换 token
5. 组装 `ProviderAccount`
6. 保存账号

---

## 4. Token 交换与刷新

### 4.1 code 换 token

函数：
- `exchangeCodexCode()`
- `src/services/codex/oauth.ts:1038`

POST 到：
- `https://auth.openai.com/oauth/token`

参数：
- `grant_type=authorization_code`
- `client_id`
- `code`
- `redirect_uri`
- 可选 `client_secret`
- 可选 `code_verifier`

返回解析：
- `access_token`
- `refresh_token`
- `expires_in`
- `id_token`

### 4.2 refresh token 刷新

统一入口：
- `refreshCodexAccessToken(refreshToken, authSource)`
- `src/services/codex/oauth.ts:1092`

分两条支路：

#### a. `authSource === "cli-proxy"`
调用：
- `https://token.oaifree.com/api/auth/refresh`

函数：
- `refreshCodexProxyAccessToken()`
- `src/services/codex/oauth.ts:1144`

#### b. 其他情况（默认 codex-cli / browser oauth）
调用 OpenAI 官方：
- `https://auth.openai.com/oauth/token`
- `grant_type=refresh_token`

代码：
- `src/services/codex/oauth.ts:1108`

### 4.3 刷新锁

项目使用了 `refreshLocks` 防止同一个 refresh token 被并发刷新：

- `src/services/codex/oauth.ts:41`
- `src/services/codex/oauth.ts:1096`

这可以避免 refresh token 轮换场景下的并发冲突。

### 4.4 按需刷新账号

在真正发请求前会调用：
- `refreshCodexAccountIfNeeded(account)`
- `src/services/codex/oauth.ts:1174`

逻辑：
- 没有 refresh token：直接返回
- access token 未过期：直接返回
- access token 没有 expiresAt，但 JWT 看起来还没过期：直接返回
- 否则刷新并写回 `authStore`

---

## 5. 账号如何保存

统一存储在 `authStore`。

### 5.1 存储位置

`src/services/auth/store.ts:8`

账号落盘目录：
- `join(getDataDir(), "auth")`

每个账号一个 JSON 文件。

### 5.2 存储字段

写入逻辑：
- `src/services/auth/store.ts:108`

Codex 账号会保存：
- `id`
- `type: "codex"`
- `email`
- `label`
- `auth_source`
- `access_token`
- `refresh_token`
- `expires_at`
- `created_at`
- `updated_at`

### 5.3 同步回写到代理目录

Codex 登录成功后还会额外写一份到：
- `~/.cli-proxy-api/codex-<key>.json`

函数：
- `saveCodexProxyAuthFile()`
- `src/services/codex/oauth.ts:349`

调用点：
- `src/services/codex/oauth.ts:790`
- `src/services/codex/oauth.ts:966`
- `src/services/codex/oauth.ts:1031`

因此，这个项目不仅会读取代理目录，也会反向维护代理目录里的 Codex 凭证。

---

## 6. 发起 Codex 请求时如何使用认证

Codex 实际调用逻辑在：
- `src/services/codex/chat.ts`

### 6.1 请求头

模型列表请求头：
- `getCodexModelsHeaders()`
- `src/services/codex/chat.ts:130`

聊天/Responses 请求头：
- `getCodexHeaders()`
- `src/services/codex/chat.ts:245`

核心认证头：
- `Authorization: Bearer <accessToken>`

另外还会带：
- `Chatgpt-Account-Id: <account.id>`

说明后端不仅依赖 bearer token，也显式传了 account id。

### 6.2 请求地址

Codex API 基地址：
- `https://chatgpt.com/backend-api/codex`
- `src/services/codex/chat.ts:10`

主要端点：
- `/models`
- `/responses`
- `/chat/completions`

但当前代码里：
- `shouldUseResponses()` 永远返回 `true`
- 因此实际主流程走 `/responses`

位置：
- `src/services/codex/chat.ts:494`

---

## 7. 请求失败时的认证恢复策略

关键逻辑在：
- `src/services/codex/chat.ts:816`

如果请求 Codex 时返回 401/403：

### 第一步：尝试重新导入本地认证源
调用：
- `importCodexAuthSources()`

如果导入到更新的 token：
- 用新 token 重试

代码：
- `src/services/codex/chat.ts:853`
- `src/services/codex/chat.ts:856`

这说明作者考虑了：用户可能在外部重新登录了 Codex CLI，本项目需要热同步最新 token。

### 第二步：直接用 refresh token 刷新

如果导入没恢复，再：
- `refreshCodexAccessToken(...)`
- 刷新后写回 `authStore`
- 重试请求

代码：
- `src/services/codex/chat.ts:879`

### 第三步：处理 refresh token reuse

如果 refresh 报错包含：
- `"refresh token"`
- `"already been used"`

会认为 refresh token 已轮换或失效：
1. 清掉当前账号上的 `refreshToken`
2. 再从 `authStore` 读一次最新账号
3. 如果本地有更新 token，就重试
4. 否则再次尝试导入外部 auth 源

代码：
- `src/services/codex/chat.ts:891`
- `src/services/codex/chat.ts:892`

这是为了应对：
- 多处同时刷新 token
- 外部 CLI 已替换 refresh token
- 当前内存里的 refresh token 已失效

---

## 8. 模型同步和账号认证的关系

项目会基于已登录的 Codex 账号动态拉取模型列表：

- `src/routes/routing/route.ts:210`
- `src/services/codex/chat.ts:140`

过程：
1. 遍历所有 codex account
2. `refreshCodexAccountIfNeeded(account)`
3. 调 `/models`
4. 把该账号可见模型写入动态模型缓存

因此：
**Codex 账号认证不仅用于聊天请求，也驱动 routing 的模型可见性。**

---

## 9. 删除账号时的清理逻辑

删除账号 API 在：
- `src/server.ts:274`

如果删的是 Codex 账号，不仅删 `authStore` 中的账号，还会调用：
- `removeCodexAuthArtifacts(...)`
- `src/services/codex/oauth.ts:376`

它会删除：
- `~/.codex/auth.json`（如果匹配该账号）
- `~/.cli-proxy-api/codex-*.json`

这是比较重的清理动作，说明项目希望删除账号时，把本机相关 Codex 认证残留也一起清掉。

---

## 10. 这套设计的主要特点

1. **优先复用现有生态登录态**
   - 先读取 Codex CLI / cli-proxy-api 现有凭证

2. **同时兼容官方 OAuth 和代理刷新**
   - `authSource` 决定 refresh 走 OpenAI 官方还是 `token.oaifree.com`

3. **有项目内持久化，也有外部文件同步**
   - 内部：`authStore`
   - 外部：`~/.cli-proxy-api/`

4. **运行时可自愈**
   - 401/403 后会尝试重新导入、refresh、处理 refresh reuse 并重试

5. **支持动态模型同步**
   - 账号认证状态会影响 routing 可见模型

6. **TLS 有兼容开关**
   - 环境变量：`ANTI_API_CODEX_INSECURE_TLS=1`
   - 位置：
     - `src/services/codex/oauth.ts:13`
     - `src/services/codex/chat.ts:15`

---

## 11. 特别值得注意的点

### A. `/auth/login` 对 Codex 是“导入优先”
即：
- 若用户已经登录过 Codex CLI
- 启动后通常无需再次登录

### B. `startCodexCliLogin()` 仍存在，但不是当前主入口
相关代码：
- `src/services/codex/oauth.ts:532`

它会执行：
- `codex login --device-auth`

并解析输出中的：
- `verificationUri`
- `userCode`

但当前 `POST /auth/login` 没有直接走这条路径，因此更像是保留能力或兼容旧流程。

### C. 删除账号会删除用户本机外部认证文件
这一点比单纯删除项目内部数据更激进。

### D. 认证来源之间会互相回填
例如：
- 从官方 OAuth 登录后
- 会写入 `~/.cli-proxy-api`
- 后续又可被 import 逻辑重新读回

因此认证状态在多个系统之间形成了共享层。

---

## 12. 简化流程图

### 登录接入

```text
POST /auth/login(provider=codex)
  ├─ force=true
  │   └─ startCodexOAuthSession()
  │       └─ 浏览器授权 -> /auth/callback -> exchangeCodexCode()
  │           ├─ authStore.saveAccount()
  │           └─ saveCodexProxyAuthFile()
  │
  └─ force=false
      ├─ importCodexAuthSources()
      │   ├─ ~/.codex/auth.json
      │   └─ ~/.cli-proxy-api/codex-*.json
      ├─ 有账号 -> success
      └─ 无账号 -> startCodexOAuthSession()
```

### 请求时认证恢复

```text
createCodexCompletion()
  ├─ refreshCodexAccountIfNeeded()
  ├─ 发请求到 chatgpt.com/backend-api/codex
  ├─ 若 401/403:
  │   ├─ importCodexAuthSources() 再试
  │   ├─ refreshCodexAccessToken() 再试
  │   └─ 若 refresh token reused:
  │       ├─ 清旧 refreshToken
  │       ├─ 读 authStore 最新值
  │       └─ 再次 import 外部 auth 源
  └─ 成功后 authStore.markSuccess()
```
