# ImgFlare

个人图床：Rust/Wasm + Cloudflare Workers、R2、D1，原生 TypeScript 前端。

- 面板使用用户名、密码和 Turnstile 登录。
- 油猴脚本独立使用 API Key，仅能上传和查重。
- 图片公开地址：`/i/<32位随机ID>.<扩展名>`。
- 单张最大 50 MiB，SHA-256 去重，支持拖拽、粘贴和批量上传。
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

部署脚本将这九项配置写入 Worker，并执行 D1 迁移。R2 使用 S3 API，不需要绑定。

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
| `bun run verify` | 类型、契约、构建和集成检查 |
| `cargo test --locked` | 图片格式和 S3 签名单元测试 |
| `bun run test:integration` | 构建并验证登录、上传、权限、备份恢复及 Cron |
| `bun run dev:cron` | 启动本地服务并允许触发定时任务 |
| `bun run deploy` | 部署并执行远程数据库迁移 |

集成测试使用隔离的本地 D1 和模拟 R2/Turnstile。浏览器验收见 [test/manual-test.md](test/manual-test.md)。

## 油猴脚本

安装 [userscript/image-uploader.user.js](userscript/image-uploader.user.js)，修改脚本中的两项配置：

```js
const API_URL = 'https://你的图床域名';
const API_TOKEN = 'cph_后台生成的Token';
```

在 HTTPS 网页粘贴或拖入图片，上传后自动插入 Markdown 并复制到剪贴板。最多同时上传 3 张，失败最多重试 2 次。

脚本不发送 Cookie，不依赖面板登录；不在图床自身页面或 iframe 中运行。错误显示在浏览器控制台。更新脚本前保存自己的配置。

## API

| 方法 | 路径 | 认证 |
|---|---|---|
| GET / HEAD | `/i/:id.:ext` | 无 |
| POST | `/api/login` | 用户名、密码、Turnstile |
| POST | `/api/logout` | 同源请求 |
| GET | `/api/me` | 可选 |
| POST | `/api/upload/check` | Session 或 API Key |
| POST | `/api/upload` | Session 或 API Key |
| GET | `/api/files?q=&limit=&offset=` | Session |
| GET / DELETE | `/api/files/:id` | Session |
| GET / POST | `/api/tokens` | Session |
| DELETE | `/api/tokens/:id` | Session |
| GET | `/api/backup/status` | Session |
| GET | `/api/backup/latest` | Session |
| POST | `/api/backup/run` | Session |

上传使用 `multipart/form-data`，字段名为 `file`，请求头 `X-File-SHA256` 为文件的 SHA-256。API Key 放在 `X-API-Key` 请求头中。

查重请求体为 `{ "sha256": "64位十六进制值" }`。登录请求体为 `{ "username": "...", "password": "...", "cf-turnstile-response": "..." }`。

错误响应为 `{ "success": false, "error": "错误码" }`。一般成功响应为 `{ "success": true, "data": ... }`；上传和查重的结果字段直接位于顶层。

图片的扩展名必须与文件头一致。SVG 响应带 CSP sandbox。管理写操作校验 Origin，显式 API Key 按上传权限处理，不回退到 Cookie。

## 备份与恢复

每日 04:00 UTC 自动将 `files`、`api_tokens`、`kv_meta` 导出为 SQL，保存至同一 R2 桶的 `back/latest.sql`。后台设置页可手动备份和下载。

备份包含业务表结构、索引及数据，不含图片文件和 Worker 密钥。R2 校验 SHA-256 后原子替换备份；导出或写入被拒绝时保留原文件，总共最多尝试 3 次。

自动备份上限为三张表合计 20,000 行、SQL 数据语句 8 MiB。超过时使用：

```sh
bunx wrangler d1 export imgflare-db --remote --output latest.sql
```

恢复到一个空数据库，再更新 Worker 的 D1 绑定：

```sh
bunx wrangler d1 create imgflare-restored
bunx wrangler d1 execute imgflare-restored --remote --file latest.sql
```

本地触发 Cron：

```sh
bun run dev:cron
# 另一个终端
curl 'http://localhost:8787/cdn-cgi/local/scheduled'
```

内部错误仅写日志，可用 `bunx wrangler tail` 查看。R2 桶应保持私有，图片由 Worker 公开提供。

## 目录

- `src/`：Rust 后端
- `frontend/`：管理面板
- `shared/`：面板与油猴共用的图片处理函数
- `userscript/`：油猴源码及可安装脚本
- `migrations/`：D1 表结构
- `scripts/`：构建与部署
- `test/`：契约、集成测试与浏览器验收

MIT License，见 [LICENSE](LICENSE)。
