# ImgFlare

个人图床。Rust → WebAssembly → Cloudflare Worker + R2 + D1 + Turnstile。

| | |
|---|---|
| 后端 | Rust + workers-rs `0.8.7` → `wasm32-unknown-unknown` |
| 图片 | R2，内容寻址 `i/<sha256>`，公开路径 `/i/<sha256>` |
| 元数据 | D1（`files` / `api_tokens` / `kv_meta`） |
| 登录 | 用户名 + 密码 + Turnstile（服务端校验） |
| 会话 | 无状态 HMAC-SHA256 签名 Cookie |
| 前端 | TypeScript + esbuild，无框架 |
| 去重 | 浏览器 SHA-256 + R2 checksum + D1 唯一索引 |
| 备份 | 每日 Cron，D1 → SQL → R2，只保留 `d1/latest.sql` |

一个域名。图片公开可读，其余操作一律需要登录。

不使用 KV、Redis、Queue、Durable Objects。

---

## 目录

- [一、部署](#一部署)
- [二、配置](#二配置)
- [三、验收](#三验收)
- [四、API](#四api)
- [五、安全模型](#五安全模型)
- [六、油猴脚本](#六油猴脚本)
- [七、备份与恢复](#七备份与恢复)
- [八、本地开发](#八本地开发)
- [九、常见问题](#九常见问题)

---

## 一、部署

### 1. 连接 GitHub 仓库

Cloudflare 控制台 → **Workers & Pages** → **Create** → **Workers** → **Connect to Git**，选中本仓库。

### 2. 填写构建配置

| 项 | 值 |
|---|---|
| Build command | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh -s -- -y --profile minimal && . "$HOME/.cargo/env" && bun run build` |
| Deploy command | `bun run deploy` |
| Root directory | `/` |

Build command 里那段 `curl` 只是为了装 Rust 工具链 —— Cloudflare 构建镜像预装了 Bun，但没有 Rust，而本项目是 Rust/Wasm。`bun run build` 本身会做完全部构建工作。

想拆成多行更易读也可以：

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
. "$HOME/.cargo/env"
bun run build
```

> `wasm32-unknown-unknown` 目标与 `wasm-bindgen` 都由 `bun run build` 自动准备：前者在安装时已包含，后者按 `Cargo.lock` 锁定的版本从 GitHub Releases 下载预编译二进制（约 10 MB，缓存于 `build/.tools/`）。
>
> 不需要 `cargo install worker-build`。原因见 [`scripts/build-worker.mjs`](scripts/build-worker.mjs) 顶部注释。

#### 指定 Bun 版本

构建镜像默认 Bun `1.2.15`。要换版本，到 **Settings → Build → Build Variables** 加一个变量（或在本仓库根目录放一个配置文件）：

| 方式 | 内容 |
|---|---|
| 环境变量 | `BUN_VERSION` = `1.2.15` |
| 版本文件 | 根目录 `.bun-version` |

两者取其一即可，不需要都设。

`bun run deploy` 会执行 `wrangler deploy --keep-vars`，再执行 `wrangler d1 migrations apply DB --remote`。

### 3. 创建 R2 和访问密钥

R2 不自动创建。

1. **R2** → **Create bucket**，建两个桶：一个放图片，一个放备份。
2. **R2** → **Manage R2 API Tokens** → **Create API token**。权限选 Object Read & Write，范围包含这两个桶。
3. 记下 Access Key ID、Secret Access Key、Account ID。同一把密钥填到需要同步的其它工具里。

### 4. 配置变量与密钥

Worker → **Settings** → **Variables and Secrets**。部署命令带了 `--keep-vars`，这里填的值不会被下次部署清掉。

**Secrets**：

| 名称 | 值 |
|---|---|
| `ADMIN_PASSWORD` | 管理员密码 |
| `SESSION_SECRET` | `openssl rand -base64 48` |
| `TURNSTILE_SECRET` | Turnstile Secret Key |
| `R2_ACCESS_KEY_ID` | 上一步的 Access Key ID |
| `R2_SECRET_ACCESS_KEY` | 上一步的 Secret Access Key |

**Variables**（Type 选 Text）：

| 名称 | 值 |
|---|---|
| `ADMIN_USERNAME` | 登录用户名 |
| `ORIGIN` | `https://imgflare.xxx.workers.dev` |
| `TURNSTILE_SITE_KEY` | Turnstile Site Key |
| `R2_ACCOUNT_ID` | Cloudflare Account ID |
| `R2_BUCKET` | 图片桶名 |
| `R2_BACKUP_BUCKET` | 备份桶名 |

`MAX_UPLOAD_SIZE`、`SESSION_TTL_SECONDS` 在 `wrangler.toml` 里，有默认值。

### 5. 创建 Turnstile

**Turnstile** → **Add widget**。Domain 填 Worker 域名，Widget Mode 选 `Managed`。Site Key 和 Secret Key 填进上面两张表。

### 6. 部署

点 **Deploy**。第一次会创建 D1 数据库 `imgflare-db`，并自动执行 [`migrations/init_01.sql`](migrations/init_01.sql)。不用在 D1 控制台里粘贴 SQL。

之后打开 `ORIGIN/login`，用 `ADMIN_USERNAME` + `ADMIN_PASSWORD` 登录。

### 绑定自定义域名（可选）

Worker → **Settings** → **Domains & Routes** → **Add** → **Custom Domain**。改 `ORIGIN` 后重新部署，新的图片 URL 才会用新域名。

---

## 二、配置

`wrangler.toml` 只绑定 D1。R2 走访问密钥，不写 binding。

```toml
[[d1_databases]]
binding = "DB"
database_name = "imgflare-db"
migrations_dir = "migrations"
```

`run_worker_first` 让 `/i/*` 走 Worker。

### 日志

```toml
[observability]
enabled = false
```

只有内部错误会写一条日志，不返回给客户端。临时查看用 `bunx wrangler tail`。

---

## 三、验收

```bash
ORIGIN=https://你的域名

# 需要登录的接口应 401
curl -i $ORIGIN/api/files

# 首页应 200
curl -i $ORIGIN/
```

浏览器打开 `$ORIGIN/login`，用 `ADMIN_USERNAME` + `ADMIN_PASSWORD` 登录，上传一张图，复制 Markdown 贴到别处确认能显示。

完整清单见 [`test/manual-test.md`](test/manual-test.md)。

---

## 四、API

错误统一为 `{ "success": false, "error": "<code>" }`，配真实状态码。

成功有两种形状：多数端点为 `{ "success": true, "data": {...} }`；上传相关端点字段直接在顶层。

### 页面

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| `GET` | `/` | Session | 管理面板。未登录时 `302` 到 `/login` |
| `GET` | `/index.html` | Session | 同上 |
| `GET` | `/login` | 无 | 登录页 |

### 公开图片

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| `GET` | `/i/:sha256` | 无 | 原图 |
| `HEAD` | `/i/:sha256` | 无 | 同上，无响应体 |

### 认证

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| `POST` | `/api/login` | Turnstile + 用户名密码 | 连续失败会 429 |
| `POST` | `/api/logout` | Session | |
| `GET` | `/api/me` | 可选 | 当前身份 |

### 上传

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| `POST` | `/api/upload/check` | Session 或 Token | 按 SHA-256 查重 |
| `POST` | `/api/upload` | Session 或 Token | `multipart/form-data`，字段 `file` |

```bash
SHA=$(sha256sum photo.png | cut -d' ' -f1)

curl -X POST $ORIGIN/api/upload \
  -H 'X-API-Key: cph_xxx' \
  -H "X-File-SHA256: $SHA" \
  -F "file=@photo.png"
```

只接受图片：`png` `jpg` `jpeg` `webp` `gif` `avif` `bmp` `ico`。扩展名和文件头必须一致，其它类型返回 415。

### 图片

| 方法 | 路径 | 认证 |
|---|---|---|
| `GET` | `/api/files?q=&limit=&offset=` | Session |
| `GET` | `/api/files/:id` | Session |
| `DELETE` | `/api/files/:id` | **仅 Session** |
| `GET` | `/api/stats` | Session |

API Token 不能删除图片。

### Token

| 方法 | 路径 | 认证 |
|---|---|---|
| `GET` | `/api/tokens` | Session |
| `POST` | `/api/tokens` | Session（明文只返回一次） |
| `DELETE` | `/api/tokens/:id` | Session |
| `DELETE` | `/api/tokens/:id/purge` | Session |

### 备份

| 方法 | 路径 | 认证 |
|---|---|---|
| `GET` | `/api/backup/status` | Session |
| `GET` | `/api/backup/latest` | Session |
| `POST` | `/api/backup/run` | Session |

---

## 五、安全模型

只存图片。扩展名和文件头不一致，或者不是 `png / jpg / webp / gif / avif / bmp / ico`，上传直接 415。

`/i/<sha256>` 对这几种类型按原样返回，并带 `X-Content-Type-Options: nosniff`。其它内容类型会以 `application/octet-stream` 加 `Content-Security-Policy: sandbox` 返回。

写操作比对 `Origin` 和请求自己的 host。未登录访问 `/` 会 `302` 到 `/login`。面板 CSP 只放行本站和 Turnstile。

---

## 六、油猴脚本

编译产物在 [`userscript/image-uploader.user.js`](userscript/image-uploader.user.js)，可直接安装。

安装后点脚本菜单 → **设置**，填：

- **API 地址**：你的 `ORIGIN`
- **Token**：在后台「API Token」页生成

功能：`Ctrl+V` 粘贴上传、拖拽上传、批量上传（最多 3 并发）、失败重试 2 次、自动插入 Markdown。

改源码后重新编译：

```bash
bun run build:userscript
```

---

## 七、备份与恢复

每天 04:00 UTC 触发 `scheduled()`：

```text
D1 binding dump() → 校验 SHA-256 → 写 d1/.tmp/... → 覆盖 d1/latest.sql → 删临时对象
```

用的是 D1 binding 的 `dump()`，写到 `R2_BACKUP_BUCKET`，凭证就是上面那把访问密钥。

1. 新备份上传成功后才覆盖 `d1/latest.sql`。失败时旧文件不动。
2. 桶里只留这一个对象。
3. 失败重试 3 次。

后台「设置」可以下载，也可以看 `backup-sha256` / `backup-at`。

### 恢复

用同一把访问密钥：

```bash
AWS_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID \
AWS_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY \
aws s3 cp s3://$R2_BACKUP_BUCKET/d1/latest.sql latest.sql \
  --endpoint-url https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com

bunx wrangler d1 execute imgflare-db --remote --file=latest.sql
```

### Time Travel

D1 保留 30 天内任意时间点，比 SQL 备份更完整：

```bash
npx wrangler d1 time-travel info imgflare-db
npx wrangler d1 time-travel restore imgflare-db --timestamp=<ISO8601>
```

### 本地测 Cron

```bash
bun run dev:cron
curl "http://localhost:8787/cdn-cgi/local/scheduled"
```

> 本地 `dump()` 会返回 404 —— miniflare 未实现 D1 导出。这条路径需在线上验证。

---

## 八、本地开发

需要 Rust（`rustup` 装，含 `wasm32-unknown-unknown`）与 Bun，其余由 `bun run build` 自理。

```bash
bun install
cp .dev.vars.example .dev.vars
bun run dev                            # http://localhost:8787，会先执行本地迁移
```

常用命令：

```bash
bun run verify           # 类型检查 + 契约检查 + 全量构建
bun run typecheck        # tsc --noEmit
bun run check:contract   # Rust 结构体 vs TS interface + 静态安全不变量
bun run build:assets     # 只构建前端 + 油猴
bun run build:worker     # 只构建 Wasm
bun run clean            # 清 dist / build / target
```

---

## 九、常见问题

**部署后所有接口 500**

`ORIGIN`、`ADMIN_USERNAME`、`TURNSTILE_SITE_KEY`、`ADMIN_PASSWORD`、`SESSION_SECRET`、`TURNSTILE_SECRET` 或 R2 那五项没配齐。

**登录页没有人机验证**

`TURNSTILE_SITE_KEY` 还是占位，或没配对 `TURNSTILE_SECRET`。

**改了变量不生效**

重新部署一次。Deploy command 里的 `--keep-vars` 会保留网页上的变量。

**图片链接指向旧域名**

`ORIGIN` 没更新。改完重新部署。

**非图片上传失败**

只接受 png、jpg、webp、gif、avif、bmp、ico，而且文件头要和扩展名一致。

**Cron 没跑**

Worker → **Settings** → **Trigger Events** 确认 Cron 存在；再看 Logs 里 `scheduled` 的结果。也可以点后台「设置 → 立即备份」手动验证。

**上传大文件失败**

`MAX_UPLOAD_SIZE` 上限同时受 Worker 请求体限制（免费版 100 MB）。

---

## 许可

MIT — 见 [LICENSE](LICENSE)。
