# Personal Image Host

一个极简的个人图床 / 文件托管服务。

**Rust → WebAssembly → Cloudflare Worker + R2 + D1 + Turnstile + TypeScript**

<div align="center">

| 需求 | 实现 |
|---|---|
| 后端 | Rust + workers-rs `0.8.7`，编译到 `wasm32-unknown-unknown` |
| 文件存储 | Cloudflare R2，内容寻址 `f/<sha256>` |
| 元数据 | Cloudflare D1（`files` / `api_tokens` / `kv_meta`） |
| 登录 | 密码 + Turnstile（**服务端**校验） |
| 会话 | 无状态 HMAC-SHA256 签名 Cookie |
| 前端 | TypeScript + esbuild，无框架 |
| 油猴脚本 | TypeScript 编译产物，可直接安装 |
| 去重 | 浏览器端 SHA-256 + R2 checksum + D1 唯一索引 |
| 备份 | 每日 Cron，D1 → SQL → 私有 R2，只保留 `d1/latest.sql` |

**没有 KV、没有 Redis、没有 Queue、没有 Durable Objects、没有额外服务器。**

</div>

---

## 目录

- [一、架构](#一架构)
- [二、域名设计](#二域名设计)
- [三、存储结构](#三存储结构)
- [四、快速开始](#四快速开始)
- [五、部署步骤](#五部署步骤)
- [六、Secrets 与变量](#六secrets-与变量)
- [七、API 参考](#七api-参考)
- [八、SHA-256 去重](#八sha-256-去重)
- [九、油猴脚本](#九油猴脚本)
- [十、每日 D1 备份](#十每日-d1-备份)
- [十一、从备份恢复](#十一从备份恢复)
- [十二、本地开发与测试](#十二本地开发与测试)
- [十三、设计说明](#十三设计说明)
- [十四、常见问题](#十四常见问题)

---

## 一、架构

```text
Cloudflare Worker (Rust / WebAssembly)
│
├── R2  personal-image-host            ┐
│      └── f/<sha256>                  │ 公开，绑定 img.example.com
│                                      ┘
├── R2  personal-image-host-backup     ┐
│      └── d1/latest.sql               │ 私有，只有 Worker 能读写
│                                      ┘
├── D1  personal-image-host
│      ├── files        文件索引 + 元数据 + SHA-256
│      ├── api_tokens   Token 哈希（不存明文）
│      └── kv_meta      只用于 last_used_at 限流
│
└── Cron  0 4 * * *  →  scheduled()  →  每日 D1 备份
```

两个入口：

| 域名 | 由谁提供 | 认证 |
|---|---|---|
| `panel.example.com` | 这个 Rust Worker + Static Assets | 密码 + Turnstile + Session Cookie |
| `img.example.com` | R2 Custom Domain（**不经过 Worker**） | 无 |

> **为什么要两个域名？**
> `.html` / `.svg` / `.js` / `.user.js` 会在浏览器里执行。如果它们和后台管理页面同源，恶意文件就能读取管理页面的数据。把公开文件放到独立 Origin，即使文件被执行也无法触碰后台。

---

## 二、域名设计

### `panel.example.com` — 管理端

登录、Turnstile、上传、文件管理、搜索、删除、API、Token 管理。

请求 `/` 时，Worker 从 Static Assets 取 `index.html` 并附加安全响应头；请求 `/api/*` 时走 Worker 的 JSON 接口。

`wrangler.toml` 中的 `run_worker_first = ["/api/*", "/login"]` 保证 API 路径不会被静态资源的 fallback 吞掉。

### `img.example.com` — 公开端

绑定 R2 Bucket `personal-image-host` 作为 Custom Domain。**不配置 Worker 路由。**

```text
https://img.example.com/f/4d2a7b3c...   ← 可直接用于 Markdown、任何网站
```

不需要登录、Cookie、Session、Turnstile 或 Token，也不经过任何管理 API。

---

## 三、存储结构

### R2 Key

```text
f/<sha256>      64 个十六进制字符
```

不使用 UUID、不使用原始文件名、不使用日期目录。**内容决定 URL**，所以相同文件必然得到相同 URL。

### 公开 URL

```text
https://img.example.com/f/<sha256>
```

由于 key 是内容哈希，对象内容不可变，因此响应带：

```http
Cache-Control: public, max-age=31536000, immutable
```

### 备份对象

```text
personal-image-host-backup
└── d1/
    └── latest.sql        永远只有一个文件
```

---

## 四、快速开始

### 前置条件

| 工具 | 版本 | 说明 |
|---|---|---|
| Rust | 1.85+（本项目在 1.93 上验证） | edition 2024 需要 1.85 起步 |
| `wasm32-unknown-unknown` | — | `rustup target add wasm32-unknown-unknown` |
| `wasm-bindgen-cli` | **必须与 `Cargo.lock` 中 `wasm-bindgen` 同版本** | 见下方「为什么必须精确同版本」 |
| `worker-build` | 0.8.7 | 独立命令，`wrangler` **不会**自动调用 |
| **Bun** | **1.4+（本项目在 1.4.2 上验证）** | 包管理 + 脚本运行时，**不用 Node/npm/pnpm** |
| Wrangler | 4+ | 随 `devDependencies` 安装 |

> 本项目是 **Bun-first**：`bun install` 装依赖、`bun run` 跑脚本、`bunx` 调 CLI。
> 构建脚本直接用 `Bun.file` / `Bun.write` / `Bun.$`，没有 Node 兼容分支。

```bash
# 1. Rust 目标平台
rustup target add wasm32-unknown-unknown

# 2. 两个构建期 CLI（版本要对齐，见下）
cargo install worker-build --version 0.8.7 --locked
cargo install wasm-bindgen-cli --version 0.2.129 --locked

# 3. 前端依赖（Bun）
bun install

# 4. 一条命令构建全部产物（前端 + 油猴脚本 + Worker Wasm）
bun run build

# 5. 本地跑起来（含 D1 / R2 本地模拟）
bun run db:migrate:local
bun run dev
```

打开 <http://localhost:8787> 即可。

> **`bun run build` 到底做了什么？**
> `bun build.mjs` → `dist/`（前端三件套 + `main.js`）
> `bun build.mjs --userscript` → `userscript/image-uploader.user.js`
> `bun scripts/worker-build.mjs` → `build/worker/shim.mjs` + `index.wasm`
>
> 只改前端时跑 `bun run build:assets` 即可，不必重新编译 Rust。

### 为什么必须精确同版本

`wasm-bindgen-cli` 的版本**必须**和编译 Wasm 时链接的 `wasm-bindgen` crate 完全一致，否则会报 `schema version mismatch` 这类难以定位的错误。查当前锁定版本：

```bash
grep -A1 '^name = "wasm-bindgen"$' Cargo.lock | head -2
```

`scripts/worker-build.mjs` 会在启动时自动比对这两个版本，不一致就直接告警，省得你编译到一半才炸。

### `scripts/worker-build.mjs` 解决了什么问题

`worker-build` 默认会在构建过程中**从 GitHub Releases 和 npm registry 下载** `wasm-bindgen`、`esbuild`、`wasm-opt`。在受限网络（公司代理、国内网络、离线 CI）下这三步必然失败，即使你的 Wasm 本身编译得好好的。

好消息是 `worker-build` 支持用环境变量覆盖这三个二进制：`WASM_BINDGEN_BIN`、`ESBUILD_BIN`、`WASM_OPT_BIN`（按 `绝对路径或 PATH` 解析）。这个脚本会：

1. 找到与 `Cargo.lock` 版本一致的 `wasm-bindgen`；
2. 从 `node_modules` 里找到**原生**的 `@esbuild/<platform>-<arch>/bin/esbuild`（注意：不是 npm 生成的 `.bin` 里的 JS 转发壳，`worker-build` 不认那个）；
3. 追加 `--no-panic-recovery`；
4. 带上以上覆盖项调用 `worker-build`。

同时在 `Cargo.toml` 里关掉了 `wasm-opt`：

```toml
[package.metadata.wasm-pack.profile.release]
wasm-opt = false
```

关掉它的代价很小（体积多几十 KB），收益是整条构建链**零外网下载**，可离线复现。

### `--no-panic-recovery` 是干什么的

不加这个参数时，`worker-build` 会给 `wasm-bindgen` 传 `--experimental-reset-state-function` 和 `--force-enable-abort-handler`。这两个参数会生成 `try`/`catch` 包装，而它要求 Wasm 模块里存在 `externref` 表和 `exception-handling` 特性——**稳定版 rustc 在 `wasm32-unknown-unknown` 上根本不会生成这两样**。结果是编译到最后一秒硬失败：

```
error: failed to generate catch wrappers
caused by: externref table required for catch wrappers
```

加上 `--no-panic-recovery` 后，`worker-build` 改用 `bundler` 目标，完全支持稳定版 Rust，而且这正是 Worker 打包需要的形态。**panic 依然会被 Worker 捕获并转成异常**，只是少了「捕获 panic 后让实例继续复用」这一层优化。

> 注意：网上有些建议说在 `[profile.release]` 里加 `panic = "abort"`，这在本项目里**行不通**——它恰恰会让上述问题更严重。我们没有设这一项。

---

## 五、部署步骤

### 1. 安装工具链

```bash
rustup target add wasm32-unknown-unknown
cargo install worker-build --version 0.8.7 --locked
cargo install wasm-bindgen-cli --version 0.2.129 --locked
bun install
```

`wrangler` 已经写在 `devDependencies` 里，用 `bunx wrangler` 调用。

> `wrangler` **不会**自动调用 `worker-build`。如果你直接跑 `wrangler deploy` 但还没编译过 Rust，会看到
> `ERROR The entry-point file at "build/worker/shim.mjs" was not found`。
> 用 `bun run deploy`（它先构建再部署）即可避免。

### 2. 创建 R2 Bucket

```bash
bunx wrangler r2 bucket create personal-image-host
bunx wrangler r2 bucket create personal-image-host-backup
```

- `personal-image-host` — 公开图片
- `personal-image-host-backup` — 私有备份（**不要**给它绑定域名）

### 3. 创建 D1 数据库

```bash
bunx wrangler d1 create personal-image-host
```

命令会输出 `database_id`，把它填到 `wrangler.toml` 的 `[[d1_databases]]` 里，同时填到 `[vars]` 的 `DATABASE_ID`。

### 4. 执行 Migration

```bash
# 本地
bunx wrangler d1 migrations apply personal-image-host --local

# 线上
bunx wrangler d1 migrations apply personal-image-host --remote
```

### 5. 创建 Turnstile Widget

Cloudflare Dashboard → **Turnstile** → Add Widget：

- 域名填 `panel.example.com`
- Widget Mode 选 **Managed**

得到 **Site Key** 和 **Secret Key**。

- Site Key → `wrangler.toml` 的 `TURNSTILE_SITE_KEY`
- Secret Key → 用 `wrangler secret put TURNSTILE_SECRET` 写入

> Site Key 是公开的（会出现在登录页 HTML 里），Secret 绝对不能进源码。

### 6. 创建 Cloudflare API Token（用于 D1 导出）

备份功能调用 D1 Export REST API，需要一个 API Token。

Dashboard → **My Profile → API Tokens → Create Token → Custom token**：

| 字段 | 值 |
|---|---|
| Permissions | **Account** → **D1** → **Edit** |
| Account Resources | Include → 你的账号 |
| Zone Resources | 不需要 |

> **最小权限**：这个 Token 只用于 D1 导出，不要给它 Zone 或 Workers 权限。

### 7. 修改域名与账号信息

编辑 `wrangler.toml`，替换所有占位符：

```toml
[vars]
PUBLIC_BASE_URL   = "https://img.example.com"     # 换成你的图片域名
PANEL_ORIGIN      = "https://panel.example.com"   # 换成你的管理域名
ACCOUNT_ID        = "YOUR_ACCOUNT_ID"             # Cloudflare 账号 ID
DATABASE_ID       = "YOUR_DATABASE_ID"            # 上一步的 database_id
```

同时更新 `Wrangler.toml` 顶部的 `name`，以及 `userscript/metadata.txt` 中的 `@namespace` 和 `@connect`（改为你的 panel 域名）。

### 8. 配置 Secrets

```bash
bunx wrangler secret put ADMIN_PASSWORD
bunx wrangler secret put SESSION_SECRET
bunx wrangler secret put TURNSTILE_SECRET
bunx wrangler secret put CLOUDFLARE_API_TOKEN
```

生成一个强随机的 `SESSION_SECRET`：

```bash
openssl rand -base64 48
```

### 9. 绑定域名

**管理域名**：Dashboard → Workers & Pages → 你的 Worker → Settings → Domains & Routes → Add Custom Domain → `panel.example.com`。

**图片域名**：Dashboard → R2 → `personal-image-host` → Settings → Public access → Custom Domains → Connect → `img.example.com`。

> 图片域名**不要**指向 Worker。它直接由 R2 + Cloudflare CDN 提供，这是公开访问不经过认证的关键。

### 10. 部署

```bash
bun run deploy         # = bun run build && wrangler deploy
```

`bun run deploy` 会依次完成：构建前端 → 构建油猴脚本 → 编译 Rust 到 Wasm 并打包 Worker → 部署。

不想部署、只想确认能不能打包：

```bash
bun run verify                                      # 类型检查 + 全量构建
bunx wrangler deploy --dry-run --outdir=/tmp/wrangler-dry
```

`--dry-run` 会打印最终上传体积和所有绑定（D1 / R2 / Assets / 变量），**不会**真正发布。这是上线前最划算的一次检查。

### 11. 逐项验证

| # | 验证项 | 做法 | 期望 |
|---|---|---|---|
| 1 | 登录页 | 打开 `https://panel.example.com` | 跳转到 `/login`，出现 Turnstile |
| 2 | 错误密码 | 输错密码 | 提示失败，**不**建立会话 |
| 3 | 正确密码 | 输入正确密码 | 跳转到上传页 |
| 4 | 上传 | 拖一个 PNG 进去 | 显示进度，返回 URL |
| 5 | 公共访问 | 新开无痕窗口打开该 URL | 图片正常显示，无需登录 |
| 6 | 去重 | 再上传同一个文件 | 提示"检测到相同文件，已跳过上传"，URL 不变 |
| 7 | 备份 | 设置卡片点「立即备份」 | 显示大小和 SHA-256 |
| 8 | 备份下载 | 点「下载最新备份」 | 下载到 `latest.sql` |
| 9 | 备份桶 | Dashboard 查看 `personal-image-host-backup` | 只有 `d1/latest.sql` |

---

## 六、Secrets 与变量

### Secrets（`wrangler secret put`）

| 名称 | 用途 | 泄露后果 |
|---|---|---|
| `ADMIN_PASSWORD` | 管理员密码 | 后台被完全接管 |
| `SESSION_SECRET` | 会话 Cookie 的 HMAC 密钥 | 可伪造任意会话 |
| `TURNSTILE_SECRET` | Turnstile 服务端校验 | 人机验证失效 |
| `CLOUDFLARE_API_TOKEN` | 调用 D1 Export API | 可导出你的 D1 数据 |

这四项**永远不能**出现在 `wrangler.toml`、源码、前端或 Git 里。

### 普通变量（`wrangler.toml`）

| 名称 | 默认值 | 说明 |
|---|---|---|
| `PUBLIC_BASE_URL` | `https://img.example.com` | 生成 URL / Markdown 用 |
| `PANEL_ORIGIN` | `https://panel.example.com` | CSRF Origin 校验 |
| `ACCOUNT_ID` | — | Cloudflare 账号 ID |
| `DATABASE_ID` | — | D1 数据库 ID |
| `MAX_UPLOAD_SIZE` | `52428800` | 单文件上限，字节（50 MiB） |
| `TURNSTILE_SITE_KEY` | — | 公开的 Site Key |
| `SESSION_TTL_SECONDS` | `604800` | 会话有效期（7 天） |

---

## 七、API 参考

### 响应格式

**错误**永远是这个形状，配真实的 HTTP 状态码（`400` `401` `403` `404` `413` `415` `429` `500`）：

```json
{ "success": false, "error": "unauthorized" }
```

**成功**分两种形状，注意区别：

```json
// 多数端点：载荷在 data 里
{ "success": true, "data": { } }
```

```json
// 上传相关端点：字段直接在顶层（规格明确要求这个形状）
{ "success": true, "exists": true, "file": { } }   // POST /api/upload/check
{ "success": true, "deduplicated": false, "file": { } }  // POST /api/upload
```

为什么上传单独用顶层？因为这两个端点要返回 `exists` / `deduplicated` 这类**控制流标志**，它们和 `file` 是平级的语义，包进 `data` 反而绕。其余端点的载荷都是单一实体，`data` 包裹更整齐。

前端 `api.ts` 的解包逻辑对两种形状都兼容（`payload?.data ?? payload`），所以加新端点时不用纠结放哪边。

### 页面

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/` | 管理界面（静态资源，客户端检查会话） |
| `GET` | `/login` | 登录页（Worker 注入 Turnstile Site Key） |

### 认证

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| `POST` | `/api/login` | Turnstile + 密码 | 建立会话 |
| `POST` | `/api/logout` | Session | 清除会话 |
| `GET` | `/api/me` | 可选 | 当前身份 |
| `GET` | `/api/health` | 无 | 存活探针 |

```bash
curl -X POST https://panel.example.com/api/login \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://panel.example.com' \
  -d '{"password":"...","cf-turnstile-response":"..."}' \
  -c cookies.txt
```

### 上传

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| `POST` | `/api/upload/check` | Session **或** Token | 查询 SHA-256 是否已存在 |
| `POST` | `/api/upload` | Session **或** Token | 实际上传 |

```bash
# 查重
curl -X POST https://panel.example.com/api/upload/check \
  -H 'X-API-Key: cph_xxx' \
  -H 'Content-Type: application/json' \
  -d '{"sha256":"<64 hex>","size":123456}'

# 上传
SHA=$(sha256sum photo.png | cut -d' ' -f1)
curl -X POST https://panel.example.com/api/upload \
  -H 'X-API-Key: cph_xxx' \
  -H "X-File-SHA256: $SHA" \
  -F "file=@photo.png"
```

> `/api/upload/check` 不允许匿名调用，否则它就成了任意内容的查询预言机。

### 文件

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| `GET` | `/api/files?q=&limit=&offset=` | Session | 分页列表 + 搜索 |
| `GET` | `/api/files/:id` | Session | 单个文件 |
| `DELETE` | `/api/files/:id` | **仅 Session** | 删除（同时删 R2 与 D1） |
| `GET` | `/api/stats` | Session | 文件数与总字节数 |

**API Token 不能删除文件。** 这是刻意的权限边界。

### Token

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| `GET` | `/api/tokens` | Session | 列出 Token（不含明文） |
| `POST` | `/api/tokens` | Session | 生成 Token（**明文只返回一次**） |
| `DELETE` | `/api/tokens/:id` | Session | 撤销 |
| `DELETE` | `/api/tokens/:id/purge` | Session | 彻底删除记录 |

### 备份

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| `GET` | `/api/backup/status` | Session | 备份状态（大小、SHA-256、时间） |
| `GET` | `/api/backup/latest` | Session | 下载 `d1/latest.sql` |
| `POST` | `/api/backup/run` | Session | 立即执行一次备份 |

---

## 八、SHA-256 去重

这是整个项目最核心的机制。

```text
文件内容
   ↓  浏览器 crypto.subtle.digest("SHA-256", ...)
sha256（64 位小写十六进制）
   ↓
POST /api/upload/check
   ↓
D1 查询
   ├── 已存在 → 直接返回已有 URL，一个字节都不上传
   └── 不存在 → POST /api/upload
```

### 服务端仍然会重新校验

`/api/upload/check` 只是快路径。`/api/upload` 会：

1. 校验认证
2. 校验文件大小（`MAX_UPLOAD_SIZE`）
3. 校验 `X-File-SHA256` 格式
4. 再次查询 D1 是否已有该 SHA-256
5. 上传 R2 时把 `X-File-SHA256` 作为 **R2 checksum** 传入 —— 内容不匹配则上传直接失败
6. 写入 D1

### 并发上传同一个文件

两个客户端同时上传相同内容，都会查到"D1 不存在"，然后都写 R2 和 D1。

由于 `files.sha256` 是 `UNIQUE`，其中一个 `INSERT` 必然冲突。**此时不返回错误**，而是重新查询 D1，返回已被写入的那条记录。

最终结果：

```text
R2:  一个对象  f/<sha256>
D1:  一条记录
两个请求: 返回同一个 URL
```

### 删除后重新上传

删除会同时移除 R2 对象和 D1 记录。重新上传相同内容时会重建 `f/<sha256>`，**URL 保持不变**。

---

## 九、油猴脚本

### 安装

编译产物已随仓库提供：

```text
userscript/image-uploader.user.js
```

用 Tampermonkey / Violentmonkey 打开该文件，或把内容粘贴为新建脚本。

> 普通用户**不需要**安装 Node.js。只有想改脚本源码的开发才需要重新编译。

### 配置

1. 部署完成后，登录后台 → **API Token** → 输入名称（如 `Tampermonkey`）→ **生成**
2. **立即复制** —— 明文只显示这一次
3. 在任意网页点击右下角悬浮按钮 → **设置**，填入：
   - API 地址：`https://panel.example.com`
   - API Token：`cph_...`
4. 保存（写在 `GM_setValue`，不碰页面的 `localStorage`）

### 功能

| 功能 | 说明 |
|---|---|
| Ctrl+V | 粘贴剪贴板里的图片，自动命名为 `pasted-<时间戳>.png` |
| 拖拽 | 把文件拖到页面任意位置 |
| 多文件 | 最多同时上传 3 个 |
| 状态 | 逐个显示：计算 Hash → 检查重复 → 上传中 → 成功/失败 |
| 重试 | 失败自动重试 2 次，也可手动点「重试」 |
| 去重 | 本地算 SHA-256，重复文件直接跳过上传 |
| Markdown | 图片 `![name](url)`，其他文件 `[name](url)` |
| 自动插入 | 插入到当前聚焦的输入框 / 可编辑区域，同时复制到剪贴板 |

### 重新编译

```bash
bun run build:userscript
```

来源是 `userscript/image-uploader.user.ts`，metadata 在 `userscript/metadata.txt`。

修改 `@connect` 时必须改成你自己的 panel 域名 —— **不要用 `@connect *`**。

---

## 十、每日 D1 备份

### 触发

```toml
[triggers]
crons = ["0 4 * * *"]
```

**04:00 UTC / 12:00 台北时间**，由 Rust 的 `scheduled()` 处理。

### 流程

```text
Cron
 ↓
scheduled()
 ↓
读取 ACCOUNT_ID / DATABASE_ID / CLOUDFLARE_API_TOKEN
 ↓
POST /accounts/{id}/d1/database/{db}/export     创建导出任务
 ↓
轮询（每 5 秒，最多 10 分钟）
 ↓
status = ready → 拿到 SQL 下载 URL
 ↓
下载 SQL（校验 HTTP 状态）
 ↓
计算 SHA-256
 ↓
写入 R2  personal-image-host-backup
 ↓
d1/.tmp/latest-<random>.sql     先写临时对象
 ↓
d1/latest.sql                   成功后才覆盖
 ↓
删除临时对象
```

### 三条铁律

1. **失败绝不删除旧备份。** 只有"导出 + 下载 + 写入"全部成功，才会覆盖 `latest.sql`。任何一步失败，旧文件原封不动。
2. **永远只有一个备份文件。** 不生成日期文件、不保留历史、不记录备份日志。
3. **先写临时对象再提升。** 避免中途失败导致 `latest.sql` 被截断。

整个任务最多重试 **3 次**，仍失败则放弃并保留旧备份。

### 备份元数据

写入 R2 时附带：

```text
Content-Type: application/sql
backup_type=d1
format=sql
backup_sha256=<SQL 全文的 SHA-256>
backup_at=<毫秒时间戳>
```

后台「设置」卡片会展示这些信息。可以用 `backup_sha256` 校验备份完整性。

### 本地测试 Cron

不需要等真实的线上定时任务：

```bash
bun run dev:cron        # 等价于 wrangler dev --test-scheduled

# 另开一个终端触发
curl "http://localhost:8787/__scheduled?cron=0+4+*+*+*"
```

更快的验证方式：登录后台，在「设置」卡片点 **立即备份**，走的是同一套代码。

---

## 十一、从备份恢复

> ⚠️ 本项目**故意不提供**网页一键恢复。覆盖生产数据库太危险，必须手动、可控地执行。

推荐流程：

```bash
# 1. 从后台下载
#    设置 → 下载最新备份  → 得到 latest.sql
#    （或 curl -b cookies.txt https://panel.example.com/api/backup/latest -o latest.sql）

# 2. 先恢复到一个全新的 D1，验证内容
bunx wrangler d1 create personal-image-host-restore
bunx wrangler d1 execute personal-image-host-restore --remote --file=latest.sql

# 3. 检查数据是否正确
bunx wrangler d1 execute personal-image-host-restore --remote \
  --command "SELECT COUNT(*) FROM files"

# 4. 确认无误后，再切换生产数据库
bunx wrangler d1 execute personal-image-host --remote --file=latest.sql
```

### D1 Time Travel

D1 自身提供 [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)，可在 30 天内回滚到任意时间点：

```bash
bunx wrangler d1 time-travel info personal-image-host
bunx wrangler d1 time-travel restore personal-image-host --timestamp=2026-09-26T04:00:00Z
```

**两者的定位不同：**

| 机制 | 保留期 | 用途 |
|---|---|---|
| D1 Time Travel | 30 天 | 短期误操作恢复 |
| R2 `d1/latest.sql` | 永久（只保留最新一份） | 独立的持久备份 |

R2 备份**不是** Time Travel 的替代品，两者互补。

---

## 十二、本地开发与测试

### 常用命令

```bash
bun install              # 安装前端依赖
bun run typecheck            # tsc --strict 类型检查
bun run verify               # 类型检查 + 全量构建（CI 用这条）

bun run build                # 全部产物：前端 + 油猴脚本 + Worker Wasm
bun run build:assets         # 只要前端 + 油猴脚本（改 UI 时用，秒级）
bun run build:frontend       # 仅前端 → dist/
bun run build:userscript     # 仅油猴脚本 → userscript/image-uploader.user.js
bun run build:worker         # 仅 Rust → build/worker/shim.mjs + index.wasm

bun run dev                  # 本地开发服务器
bun run dev:cron             # 开发服务器 + 可手动触发 scheduled
bun run cron:trigger         # 手动触发一次定时备份（配合 dev:cron）
bun run db:migrate:local     # 本地执行 migration
bun run db:migrate:remote    # 线上执行 migration
bun run clean                # 清理 dist / build / target

cargo check --target wasm32-unknown-unknown                # Rust 类型检查（快）
cargo build --release --target wasm32-unknown-unknown      # 只编译 Wasm，不打包
```

本地开发时需要创建 `.dev.vars`（**不要提交**）：

```ini
ADMIN_PASSWORD=dev-password
SESSION_SECRET=dev-session-secret-change-me
TURNSTILE_SECRET=1x0000000000000000000000000000000AA
CLOUDFLARE_API_TOKEN=dev-token
```

> Turnstile 提供了[测试密钥](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)：
> 永远通过的 Site Key `1x00000000000000000000AA`，Secret `1x0000000000000000000000000000000AA`。
> 本地开发用这两个即可。

### 测试用例清单

完整的手工测试步骤见 [`test/manual-test.md`](test/manual-test.md)。需要覆盖：

| # | 用例 | 关键断言 |
|---|---|---|
| 1 | 错误密码 | 返回 401，无 Set-Cookie |
| 2 | 正确密码 | 返回 200，Set-Cookie 带 HttpOnly/Secure/SameSite |
| 3 | Turnstile 失败 | 返回 403，密码正确也不放行 |
| 4 | 未登录上传 | 返回 401 |
| 5 | 登录上传 | 返回 200，URL 可访问 |
| 6 | 粘贴图片 | 生成 `image/png`，Markdown 为 `![..]` |
| 7 | 拖拽图片 | 同上 |
| 8 | 批量上传 | 并发不超过 3 |
| 9 | 普通文件（PDF） | Markdown 为 `[..]` 而非 `![..]` |
| 10 | `.user.js` | `application/javascript`，可从 img 域名访问 |
| 11 | API Token 上传 | 返回 200 |
| 12 | Token 删除文件 | 返回 403 |
| 13 | 重复文件 | `exists: true`，URL 与首次相同 |
| 14 | 并发重复文件 | R2 仅 1 个对象，D1 仅 1 行，两者 URL 相同 |
| 15 | 删除 | R2 与 D1 同时消失，再查返回 404 |
| 16 | 搜索 | 只返回匹配文件 |
| 17 | 分页 | `limit`/`offset` 生效，不一次返回全部 |
| 18 | 公共 URL | 无 Cookie 无 Token 也能访问 |
| 19 | 超大文件 | 返回 413 |
| 20 | 非法 SHA-256 | 返回 400 |
| 21 | 路径穿越 `/f/../x` | 返回 404 / 不命中任何对象 |
| 22 | SQL 注入尝试 | 搜索 `' OR 1=1 --` 无副作用 |
| 23 | 备份 Cron | `__scheduled` 触发成功 |
| 24 | D1 Export | 拿到 SQL 下载 URL |
| 25 | `latest.sql` | R2 中存在且内容完整 |
| 26 | 备份失败后 | 旧 `latest.sql` **仍然存在** |
| 27 | 新备份成功 | `latest.sql` 被更新，SHA-256 变化 |
| 28 | Backup Bucket | 未绑定域名，公开访问被拒 |

#### 去重验收

```text
第一次上传 test.png  → SHA=A
  R2: f/A 已创建
  D1: sha256=A

第二次上传同一个 test.png
  D1: 找到 A
  R2: 不新增对象
  返回: 同一个 URL
```

#### 并发去重验收

同时上传内容相同的 `A.png` 和 `B.png`：

```text
R2: 1 个对象
D1: 1 条记录
两个请求返回同一个 URL
```

---

## 十三、设计说明

### 为什么 R2 key 用 SHA-256 而不是 UUID

内容寻址有两个直接好处：相同文件天然去重；URL 天然不可变，因此可以激进缓存（`immutable`），不必担心"同一 URL 内容变了"。

代价是删除后 CDN 边缘可能短暂保留旧副本 —— **第一版不做 CDN purge**，这是刻意的取舍。

### 为什么两种认证方式

| 场景 | 方式 | 能否删除 |
|---|---|---|
| 浏览器后台 | Session Cookie | ✅ |
| 油猴脚本 | `X-API-Key` | ❌ |

Token 权限被刻意限制在上传和查重。即使 Token 泄露，攻击者也无法删除数据或管理后台。

### 为什么 CID 之外还要 R2 checksum

客户端可以先算出 SHA-256 再上传，但传输过程中可能损坏。把同一个哈希作为 R2 checksum 传入，R2 会在写入时独立校验，不匹配直接失败 —— 这样"内容寻址"才真正可靠。

### 为什么 `kv_meta` 表

`api_tokens.last_used_at` 如果每次上传都更新，会产生大量 D1 写操作。`kv_meta` 记录上次写入时间，**每小时最多更新一次**。

它只有 `key` / `value` 两列，不承担任何业务逻辑。

### 为什么有 `/api/tokens/:id/purge`

需求里说"不要加入无意义 API"，所以每个超出最小集合的端点都该有理由。目前多出这些：

| 端点 | 为什么留着 |
|---|---|
| `GET /api/me` | 前端启动时必须知道"我登录了吗"，否则要么多打一次 `/api/files` 靠 401 反推，要么闪烁一次未登录界面 |
| `GET /api/stats` | 顶栏的「N 个文件 · X MB」需要它，否则得把整张表拉到前端再算 |
| `GET /api/backup/status` | 设置卡片显示备份大小/时间/SHA-256，总不能每看一次就下载整个 SQL |
| `POST /api/backup/run` | 规格要求能本地测试定时任务，否则改完备份逻辑要等到凌晨 4 点才知道对不对 |
| `GET /api/health` | 存活探针，不泄露任何配置，只回 `ok` |
| `DELETE /api/tokens/:id/purge` | 撤销（revoke）是可逆的日常操作，但测试时会留下一堆废 token 行。purge 让真正清理成为可能 |

`purge` 的约束和普通删除一样严：**必须 Session（Token 一律 403）**，且校验 `Origin`。它不能用来绕过任何权限。

### 域名隔离是强制的

`PUBLIC_BASE_URL` 和 `PANEL_ORIGIN` 必须指向**不同 origin**，否则 Worker 在每个请求上直接返回 500 并说明原因。

为什么这条必须是硬约束：公开桶里的文件按原样返回、不经认证也不做净化。`svg` 和 `html` 都在允许上传的类型里。如果两者同源，一个上传的 HTML 就能读到管理端的会话，整套 CSRF 设计随之失效。配置错了会直接报错，而不是安静地以不安全形态运行。

### 安全措施汇总

| 威胁 | 防护 |
|---|---|
| 密码爆破 | Turnstile + 常量时间比较 |
| Session 伪造 | HMAC-SHA256 签名，先验签再解析 |
| XSS（管理页） | 前端全部用 `textContent`，不用 `innerHTML`；CSP |
| XSS（上传文件） | 公开文件在独立 Origin；Worker 不渲染用户内容 |
| CSRF | 写操作校验 `Origin`；Token 请求不依赖 Cookie |
| SQL 注入 | 全部 prepared statement + 参数绑定 |
| 路径穿越 | 公开路径强制校验 64 位十六进制；文件名剥离路径成分 |
| Token 泄露 | D1 只存 SHA-256；明文只显示一次 |
| 密钥泄露 | 全部走 `wrangler secret`，不进源码/Git/前端 |
| 大文件 DoS | 前后端双重校验 `MAX_UPLOAD_SIZE` |
| 备份丢失 | 失败不覆盖；先写临时对象再提升 |

---

## 十四、常见问题

**Q: 登录页 Turnstile 一直加载失败？**
检查 `wrangler.toml` 的 `TURNSTILE_SITE_KEY` 是否填了真实值，以及 Turnstile Widget 是否绑定了正确的域名。

**Q: 上传返回 `unsupported_file_type`？**
只允许需求中列出的扩展名（图片 9 种 + 普通文件 10 种）。Content-Type 由扩展名推导，不信任客户端传来的值。

**Q: 备份一直是"还没有备份"？**
检查四个 Secret 是否都配了、`ACCOUNT_ID` 和 `DATABASE_ID` 是否正确、API Token 是否有 D1 Edit 权限。直接点「立即备份」能更快看到具体错误。

**Q: 图片 404？**
确认 `img.example.com` 已绑定 R2 Bucket 作为 Custom Domain，且 `PUBLIC_BASE_URL` 与之一致。

**Q: 上传后 URL 里没有文件扩展名？**
这是设计如此。URL 是 `/f/<sha256>`，浏览器依靠 R2 的 `Content-Type` 元数据识别类型。

**Q: 能不能多用户？**
不能，也不打算支持。这是一个**单管理员**的个人工具。

**Q: `cargo check` 过了，但 `worker-build` 报 `externref table required for catch wrappers`？**
你漏了 `--no-panic-recovery`。用 `bun run build:worker`（内部已带上），不要直接裸跑 `worker-build`。原因见[上一节](#no-panic-recovery-是干什么的)。

**Q: `worker-build` 卡在 `Downloading Wasm Bindgen` 或 `Downloading Esbuild` 然后失败？**
网络受限。不要手动去改 `worker-build` 的缓存目录——用 `bun run build:worker`，它会通过 `WASM_BINDGEN_BIN` / `ESBUILD_BIN` 把本地已有的二进制喂给 `worker-build`，全程零下载。

**Q: 提示 `wasm-bindgen` 版本不匹配？**
```bash
grep -A1 '^name = "wasm-bindgen"$' Cargo.lock | head -2      # 看锁定的版本，例如 0.2.129
cargo install wasm-bindgen-cli --version 0.2.129 --locked --force
```

**Q: `wrangler deploy` 报 `the entry-point file at build/worker/shim.mjs was not found`？**
你还没编译 Rust。`wrangler` 不会自动帮你编译。用 `bun run deploy`。

**Q: `panic = "abort"` 能减小体积，为什么不加？**
加上它会让 `wasm-bindgen` 的 catch wrapper 生成失败（原因见上文），而且 `lto` + `strip` 已经把不可达的 unwind 代码删干净了，收益接近零。别加。

---

## 附录：本项目的构建验证记录

下面这些是在交付前实际跑过并通过的，不是纸面声明：

| 检查项 | 命令 | 结果 |
|---|---|---|
| Rust 类型检查 | `cargo check --target wasm32-unknown-unknown` | 0 error / 0 warning |
| Worker 打包 | `bun run build:worker` | `shim.mjs` 39 KiB + `index.wasm` 552 KiB |
| 前端类型检查 | `bun run typecheck` | `tsc --strict` 无输出 |
| **API 契约检查** | `bun run check:contract` | 6 组结构体字段一一对应 + 3 项静态安全不变量 |
| 前端构建 | `bun run build:frontend` | `dist/main.js` 21.2 KB + 3 个静态文件 |
| 资产引用校验 | 构建内置 | `dist/` 内所有本地 src/href 均存在 |
| 油猴脚本构建 | `bun run build:userscript` | 18,301 字节，含 `@connect panel.example.com` |
| 部署试运行 | `bunx wrangler deploy --dry-run` | 632 KiB，D1/R2×2/Assets/11 个变量全部解析 |
| 数据库迁移 | 迁移 SQL 灌入 SQLite | 3 张表 + 全部索引 + UNIQUE 约束建立成功 |
| UI 渲染 | Chromium 实机截图 | 登录页 / 面板 / 深色 / 移动端，0 JS 异常 |

上面的构建与 UI 检查跑在 **bun 1.4.2** 上。

安全不变量静态扫描同样全部通过：

- 前端与用户脚本中**没有** `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write`
- 所有 SQL 都是常量字符串 + `.bind()` 参数绑定，**没有**字符串拼接
- 会话 Cookie 为 `HttpOnly; Secure; SameSite=Lax; Path=/`
- API Token 只存 SHA-256 哈希，且只在上传路径生效（删除路径直接 403）
- 会话签名**先验签、后解析**，比较用 `constant_time_eq`
- 9 个 cookie 认证的写操作全部调用 `check_origin` 做 CSRF 防护

### 前端接上后端之前，先看这一节

这个项目有两处 **类型系统管不到的边界**，两边都能编译通过，但运行时会坏。已经修好并加了自动化检查，但知道它们存在很重要。

#### 1. 资源引用与打包产物名必须一致

`frontend/*.html` 里写的是 `<script type="module" src="/main.js">`。如果构建产物的文件名换成别的（比如 `app.js`），会**静默失效**：`tsc` 通过、构建通过、部署通过，但浏览器 404 掉打包结果，页面完全没有交互——最难查的那种坏法。

现在 `build.mjs` 会解析每个 HTML 里所有以 `/` 开头的 `src=` / `href=`，逐个确认文件存在于 `dist/`（`/api/...` 除外，那些是 Worker 路由）。对不上就直接让构建失败。

#### 2. Rust 与 TypeScript 的字段名必须一致

Rust 用 serde 序列化，TypeScript 手写 interface，**没有任何机制保证两边一致**。`created_at` 和 `createdAt` 两个名字在各自语言里都合法，编译器都不会吭声，但前端会拿到 `undefined`——严重时直接抛异常（例如 `file.contentType.startsWith('image/')` 遇到 `undefined`）。

修复方式是在所有跨边界的结构体上加 `#[serde(rename_all = "camelCase")]`，让整个 API 统一 camelCase：

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo { /* content_type -> contentType */ }
```

`bun run check:contract` 会把 Rust 结构体的字段（考虑 `rename_all` 的最终效果）和 TypeScript interface 的字段都读出来，转成统一的 camelCase 后逐一比对，列出任何只在一边存在的字段。它已经接进 `bun run verify`，所以 `bun run verify` 就能拦住这类问题。

> 注意：`FileRecord` / `TokenRecord` **故意**不加重命名——它们一一对应 D1 的列名，且从不直接序列化给客户端。

---

## 许可

MIT — 见 [LICENSE](LICENSE)。
