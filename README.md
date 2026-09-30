# ImgFlare

个人图床：Rust/Wasm + Cloudflare Workers、R2、D1，原生 TypeScript 前端。

- 面板使用用户名、密码和 Turnstile 登录。
- 油猴脚本独立使用 API Key，仅能上传和查重。
- 图片公开地址：`/i/<32位随机ID>.<扩展名>`。
- 单张最大 50 MiB，SHA-256 去重，支持拖拽、粘贴和批量上传。
- 自动生成小尺寸缩略图；图片支持条件缓存、HEAD 和单段 Range 请求。
- 支持 PNG、JPEG、WebP、GIF、AVIF、BMP、ICO、SVG、JXL、HEIC、HEIF、TIFF。

## 部署

1. 创建一个私有 R2 桶，以及该桶的读写访问密钥。
2. 创建 Turnstile Managed widget，允许访问图床的域名。
3. 在 Cloudflare Workers 中连接本仓库，根目录选择 `/`。
4. 填写构建配置及下表中的变量，然后部署。D1 名称使用 `imgflare-db`。

| 构建配置 | 值 |
|---|---|
| Build command | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh -s -- -y --profile minimal --default-toolchain stable && . "$HOME/.cargo/env" && bun run build` |
| Deploy command | `bun run deploy` |
| Build variable | `BUN_VERSION=1.4.2` |

在 **Settings → Build → Build variables and secrets** 中填写：

| 名称 | 内容 | 类型 |
|---|---|---|
| `ADMIN_USERNAME` | 管理员用户名 | 变量 |
| `ADMIN_PASSWORD` | 管理员密码 | 密钥 |
| `SESSION_SECRET` | `openssl rand -hex 32` 生成的随机值 | 密钥 |
| `TURNSTILE_SITE_KEY` | Turnstile Site Key | 变量 |
| `TURNSTILE_SECRET` | Turnstile Secret Key | 密钥 |
| `R2_ACCOUNT_ID` | Cloudflare Account ID | 变量 |
| `R2_ACCESS_KEY_ID` | R2 Access Key ID | 密钥 |
| `R2_SECRET_ACCESS_KEY` | R2 Secret Access Key | 密钥 |
| `R2_BUCKET` | R2 桶名 | 变量 |

部署脚本将这九项配置写入 Worker，并执行 D1 迁移。R2 使用 S3 API，不需要绑定。[init_01.sql](backend/migrations/init_01.sql) 完整初始化数据库。后续结构变更从 `init_03.sql` 开始追加迁移，不复用已执行过的迁移文件名。

`SESSION_SECRET` 生成一次后保持不变；修改它会使已有登录失效。会话有效期为 7 天。

部署后打开 `/login`。可在 Worker 的 **Domains & Routes** 中绑定自定义域名，并同步添加到 Turnstile 允许的域名中。

## 本地开发

需要 Bun 1.4.2、Node.js 22+ 和 Rust（含 `wasm32-unknown-unknown`）。构建脚本会下载与 Cargo.lock 一致的 wasm-bindgen。

```sh
bun install --frozen-lockfile
cp .dev.vars.example .dev.vars
# 填写 .dev.vars 中的配置
bun run dev
```

| 命令 | 用途 |
|---|---|
| `bun run build` | 构建前端、油猴脚本和 Worker |
| `bun run build:assets` | 构建前端和油猴脚本 |
| `bun run build:worker` | 构建 Rust/Wasm Worker |
| `bun run verify` | 类型、契约、前端、工具、Rust、构建及集成检查 |
| `bun run test:frontend` | 搜索竞态、上传队列、进度 DOM 和响应校验 |
| `bun run test:tooling` | 请求体限额和开发监听调度 |
| `cargo test --locked` | 图片格式和 S3 签名单元测试 |
| `bun run test:integration` | 构建并验证登录、上传、权限、备份恢复及 Cron |
| `bun run dev:cron` | 启动本地服务并允许触发定时任务 |
| `bun run deploy` | 部署并执行远程数据库迁移 |
| `bun run clean` | 清理构建产物与 Rust 编译缓存 |

`bun run dev` 会监听 Rust、SQL、TypeScript、HTML、CSS 和共享模块，合并连续修改并依次重建；新增迁移自动应用到本地 D1。GitHub Actions 在 push 和 pull request 时运行 `bun run verify`。

集成测试使用隔离的本地 D1 和模拟 R2/Turnstile，覆盖 50 MiB 上传、存储故障重试、缩略图、缓存失效、游标插入竞态和备份恢复。浏览器验收见 [tests/manual-test.md](tests/manual-test.md)。

## 油猴脚本

在面板的「设置」中生成并复制 API Token，然后安装 [web/userscript/image-uploader.user.js](web/userscript/image-uploader.user.js)，修改脚本中的两项配置：

```js
const API_URL = 'https://你的图床域名';
const API_TOKEN = 'cph_后台生成的Token';
```

在 HTTPS 网页粘贴图片，上传后自动插入 `![粘贴图片](图片地址)` 并复制到剪贴板。最多同时上传 3 张，失败最多重试 2 次。拖拽上传请使用网站主页。

脚本不发送 Cookie，不依赖面板登录；不在图床自身页面或 iframe 中运行。错误显示在浏览器控制台。更新脚本前保存自己的配置。

## API

| 方法 | 路径 | 认证 |
|---|---|---|
| GET / HEAD | `/i/:id.:ext`、`/t/:id.:ext` | 无 |
| POST | `/api/login` | 用户名、密码、Turnstile |
| POST | `/api/logout` | 同源请求 |
| GET | `/api/me` | 可选 |
| POST | `/api/upload/check` | Session 或 API Key |
| POST | `/api/upload` | Session 或 API Key |
| GET | `/api/files?q=&limit=&cursor=` | Session |
| GET / DELETE | `/api/files/:id` | Session |
| POST | `/api/files/:id/thumbnail` | Session |
| GET / POST | `/api/tokens` | Session |
| DELETE | `/api/tokens/:id` | Session |
| GET | `/api/backup/status` | Session |
| GET | `/api/backup/latest` | Session |
| POST | `/api/backup/run` | Session |

上传使用 `multipart/form-data`，字段名为 `file`，请求头 `X-File-SHA256` 为文件的 SHA-256。API Key 放在 `X-API-Key` 请求头中。可选 `thumbnail` 字段接收最大 256 KiB 的 PNG、JPEG 或 WebP；缩略图失败不影响原图。面板和油猴优先生成最长边 384 像素的 WebP，浏览已有图片时逐步补齐缩略图。不支持解码的格式继续显示原图。

查重请求体为 `{ "sha256": "64位十六进制值" }`。登录请求体为 `{ "username": "...", "password": "...", "cf-turnstile-response": "..." }`。

错误响应为 `{ "success": false, "error": "错误码" }`。一般成功响应为 `{ "success": true, "data": ... }`；上传和查重的结果字段直接位于顶层。

图片的扩展名必须与文件头一致。SVG 响应带 CSP sandbox。管理写操作校验 Origin，显式 API Key 按上传权限处理，不回退到 Cookie。

列表使用游标分页：将响应的 `nextCursor` 作为下一页的 `cursor`，返回 `null` 表示结束。排序按 `created_at DESC, id DESC`，并发插入新图片不会挤动后续页。查询参数仅接受 `q`、`limit` 和 `cursor`。

图片响应包含 ETag、Last-Modified、Content-Length 和 Accept-Ranges。浏览器缓存 60 秒，边缘 Cache API 缓存一天；每次读取边缘缓存前先检查 D1，已删除图片立即返回 404。浏览器已保存的副本可能在 60 秒内继续显示。

上传使用原生流计算 SHA-256，并直接转发 File；每个 Worker isolate 同时只解析一份上传，最多排队三份，额外请求返回可重试的 429。请求在解析前按实际流量限制大小，R2 请求最多等待 60 秒。

删除先事务写入 `cleanup_jobs` 并移除文件索引，再清理 R2 原图和缩略图。失败或中断的上传、删除由每 15 分钟运行的任务重试，每轮最多处理 20 个对象；上传中的暂存任务保留 15 分钟再清理。有效文件和备份引用的对象不会被误删。

## 备份与恢复

每日 04:00 UTC 将五张业务表（`files`、`api_tokens`、`kv_meta`、`cleanup_jobs`、`backup_snapshots`）导出为 SQL。先写入 `back/history/<时间>-<随机值>.sql`，再原子更新 `back/latest.sql`，保留最近 30 份历史备份。后台可手动备份和下载最新文件，历史文件可通过 R2 的私有访问密钥下载。

备份包含业务表结构、索引及数据，不含图片文件和 Worker 密钥。R2 校验 SHA-256 后原子替换备份；导出或写入被拒绝时保留原文件，总共最多尝试 3 次。

自动备份上限为五张表合计 20,000 行、SQL 数据语句 8 MiB。超过时使用：

```sh
bunx wrangler d1 export imgflare-db --remote --output latest.sql
```

备份使用 [backend/schema.sql](backend/schema.sql) 中的完整当前结构；修改表结构时必须同步迁移、恢复结构和导出查询，集成测试会验证迁移与恢复结构一致。

恢复到一个空数据库，再更新 Worker 的 D1 绑定。备份自带对应的迁移记录，恢复后无需重放已经包含的历史迁移：

```sh
bunx wrangler d1 create imgflare-restored
bunx wrangler d1 execute imgflare-restored --remote --file latest.sql
```

本地触发 Cron：

```sh
bun run dev:cron
# 另一个终端
curl 'http://localhost:8787/cdn-cgi/local/scheduled?cron=0%204%20*%20*%20*'
# 只触发待清理任务
curl 'http://localhost:8787/cdn-cgi/local/scheduled?cron=*/15%20*%20*%20*%20*'
```

请求日志包含方法、路径、状态、耗时和请求 ID，不记录凭证或查询参数；Workers Logs 默认按 10% 采样。内部错误仅写日志，可用 `bunx wrangler tail` 查看。R2 桶应保持私有，图片由 Worker 公开提供。

## 目录

```text
backend/
  src/          Rust Worker、SQL 备份查询
  migrations/   D1 数据库迁移
  schema.sql    SQL 备份的完整恢复结构
  entry.mjs     Worker 入口及请求体限额
web/
  frontend/     管理面板页面、样式及 TypeScript
  userscript/   油猴源码、元数据及可安装脚本
  shared/       两个客户端共用的图片处理函数和类型
scripts/        构建、部署及开发监听脚本
tests/          前端、Rust、契约、工具及集成验证
.github/        自动检查工作流
dist/           构建产物（不入库）
  assets/       面板静态资源
  worker/       Worker 入口及 Wasm
.cache/         Bun、Rust、构建工具缓存（不入库）
```

根目录保留 Bun、Cargo、TypeScript 和 Wrangler 的项目配置及锁文件，所有开发命令均在根目录执行。Cargo 入口由 `Cargo.toml` 的 `lib.path` 指向 `backend/src/lib.rs`，编译缓存由 `.cargo/config.toml` 指向 `.cache/cargo/`。

`.dev.vars` 保存本地配置，`.wrangler/` 保存 Wrangler 本地运行状态，均不入库。`web/userscript/image-uploader.user.js` 是供直接安装的生成文件，构建后需与源码一同提交。

MIT License，见 [LICENSE](LICENSE)。
