# ImgFlare

个人图床 / 文件托管。Rust → WebAssembly → Cloudflare Worker + R2 + D1 + Turnstile。

| | |
|---|---|
| 后端 | Rust + workers-rs `0.8.7` → `wasm32-unknown-unknown` |
| 文件 | R2，内容寻址 `i/<sha256>`，公开路径 `/i/<sha256>` |
| 元数据 | D1（`files` / `api_tokens` / `kv_meta`） |
| 登录 | 用户名 + 密码 + Turnstile（服务端校验） |
| 会话 | 无状态 HMAC-SHA256 签名 Cookie |
| 前端 | TypeScript + esbuild，无框架 |
| 去重 | 浏览器 SHA-256 + R2 checksum + D1 唯一索引 |
| 备份 | 每日 Cron，D1 → SQL → 私有 R2，只保留 `d1/latest.sql` |

一个域名。图片公开可读，其余操作一律需要登录。

不使用 KV、Redis、Queue、Durable Objects。

---

## 目录

- [一、部署](#一部署)
- [二、配置](#二配置)
- [三、验收](#三验收)
- [四、API](#四api)
- [五、油猴脚本](#五油猴脚本)
- [六、备份与恢复](#六备份与恢复)
- [七、本地开发](#七本地开发)
- [八、常见问题](#八常见问题)

---

## 一、部署

### 1. 连接 GitHub 仓库

Cloudflare 控制台 → **Workers & Pages** → **Create** → **Workers** → **Connect to Git**，选中本仓库。

### 2. 填写构建配置

| 项 | 值 |
|---|---|
| Build command | 见下方 |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` |

构建镜像里没有 Rust，需要现装：

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
. "$HOME/.cargo/env"
rustup target add wasm32-unknown-unknown
cargo install worker-build --version 0.8.7 --locked
cargo install wasm-bindgen-cli --version 0.2.129 --locked
bun install
bun run build
```

> `wasm-bindgen-cli` 的版本必须与 `Cargo.lock` 里锁定的 `wasm-bindgen` 一致，否则报 `schema version mismatch`。升级依赖后同步改这里的版本号。

### 3. 首次部署

点 **Deploy**。第一次会失败在配置检查上，因为 `TURNSTILE_SITE_KEY` 还是占位值——这是刻意的，见下一节。

**D1 数据库和两个 R2 桶会自动创建**，名字由 Worker 名推导：

| Binding | 自动创建的资源 |
|---|---|
| `DB` | `imgflare-db` |
| `BUCKET` | `imgflare-bucket` |
| `BACKUP_BUCKET` | `imgflare-backup-bucket` |

不需要提前手工建库建桶，也不需要填任何 ID。

### 4. 建表

Worker → **D1** → `imgflare-db` → **Console**，粘贴 [`migrations/init_01.sql`](migrations/init_01.sql) 全文执行。

### 5. 配置变量与密钥

Worker → **Settings** → **Variables and Secrets**。

**Secrets**（Type 选 `Secret`）：

| 名称 | 值 |
|---|---|
| `ADMIN_PASSWORD` | 管理员密码，建议 20 位以上随机串 |
| `SESSION_SECRET` | `openssl rand -base64 48` |
| `TURNSTILE_SECRET` | 见第 6 步 |

**Variables**（Type 选 `Text`）：

| 名称 | 值 |
|---|---|
| `ADMIN_USERNAME` | 登录用户名，默认 `admin` |
| `ORIGIN` | 你的访问地址，如 `https://imgflare.xxx.workers.dev` |
| `TURNSTILE_SITE_KEY` | 见第 6 步 |

其余变量（`MAX_UPLOAD_SIZE`、`SESSION_TTL_SECONDS`）已有合理默认值，在 `wrangler.toml` 里，需要时再改。

### 6. 创建 Turnstile

**Turnstile** → **Add widget**：

- Domain：填你的 Worker 域名
- Widget Mode：`Managed`

拿到 Site Key（填进上面的 `TURNSTILE_SITE_KEY`）和 Secret Key（填进 `TURNSTILE_SECRET`）。

### 7. 重新部署

改动变量后需要重新部署一次才生效。之后打开 `ORIGIN/login` 即可登录。

### 绑定自定义域名（可选）

Worker → **Settings** → **Domains & Routes** → **Add** → **Custom Domain**。

绑定后把 `ORIGIN` 改成新域名并重新部署，图片 URL 才会用新域名生成。

---

## 二、配置

`wrangler.toml` 里只有四个绑定和几个变量：

```toml
name = "imgflare"

[assets]
directory = "./dist"
binding = "ASSETS"
run_worker_first = ["/", "/index.html", "/login", "/i/*", "/api/*"]

[triggers]
crons = ["0 4 * * *"]

[[r2_buckets]]
binding = "BUCKET"

[[r2_buckets]]
binding = "BACKUP_BUCKET"

[[d1_databases]]
binding = "DB"
```

R2 和 D1 都只写了 `binding`，资源名由 Cloudflare 按 Worker 名自动推导并创建。想用自己的名字就补上 `bucket_name` / `database_name`：

```toml
[[r2_buckets]]
binding = "BUCKET"
bucket_name = "my-images"
```

`run_worker_first` 让 `/i/*` 走 Worker，这样公开文件也能经过一层响应头处理（见「安全模型」）。

### 日志

`wrangler.toml` 里 Workers Logs 默认关闭：

```toml
[observability]
enabled = false
```

代码本身不输出进度日志 —— 备份、登录、上传都靠返回值上报。唯一保留的是 `ApiError::Internal` 的详情，它只写日志、不返回给客户端，排查线上 500 时需要它。

要临时看日志，用 `npx wrangler tail`（不受 `observability` 开关影响）。想在控制台保留事件再把它改成 `true`。

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

### 公开文件

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| `GET` | `/i/:sha256` | 无 | 原始文件 |
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

支持扩展名：`png jpg jpeg webp gif avif svg bmp ico txt json xml css js mjs html pdf zip 7z`，以及 `.user.js`。

### 文件

| 方法 | 路径 | 认证 |
|---|---|---|
| `GET` | `/api/files?q=&limit=&offset=` | Session |
| `GET` | `/api/files/:id` | Session |
| `DELETE` | `/api/files/:id` | **仅 Session** |
| `GET` | `/api/stats` | Session |

API Token 不能删除文件。

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

单个域名意味着「公开的图片」和「带会话的后台」同源。这是有代价的，项目用三条措施兜住：

**1. 上传的内容不能当文档执行。**

浏览器打开 `/i/<sha256>` 时的响应类型：

| 类型 | 返回 | 原因 |
|---|---|---|
| `image/png` `jpeg` `webp` `gif` `avif` `bmp` `ico` | 原样 | 位图，无法执行 |
| `image/svg+xml` | 原样 + `sandbox` | 保持类型才能在 Markdown 里显示；`sandbox` 挡掉内嵌脚本 |
| `application/pdf` | 原样 + `sandbox` | PDF 阅读器可能执行脚本 |
| `application/javascript` | 原样 + `sandbox` | 顶层导航只会显示源码；保持类型才能让 `.user.js` 被 Tampermonkey 安装 |
| `text/plain` `text/css` `application/json` | 原样 | 非文档格式 |
| `text/html` `text/xml` `application/xml` | **`text/plain`** + `sandbox` | 这些一导航就执行 |
| 其他 | `application/octet-stream` + `sandbox` | 不让浏览器猜 |

关键点是 `text/html` 被降级：上传一个 `<script>` 然后访问它的 URL，脚本不会执行，只会看到源码。

全部响应都带 `X-Content-Type-Options: nosniff`。

**2. CSRF 与请求自身同源比对。**

写操作检查 `Origin` 头是否等于请求实际到达的 host。因为脚本无法在本源执行，攻击页面无法伪造出匹配的 `Origin`。

**3. 面板需要登录才能拿到。**

`/` 在未登录时是 `302 /login`，不会把面板 HTML 发给匿名访问者。图片走 `/i/<sha256>`，完全不经过鉴权。

**4. 面板页面 CSP。**

`default-src 'self'`，只额外放行 Turnstile。上传的文件不可能被加载进面板。

以上规则由 `bun run check:contract` 自动校验——它会解析 `src/public.rs` 的分支表，断言每个脚本可执行类型都已降级或 sandbox，改错会直接让构建失败。

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

用的是 D1 binding 自带的导出，不需要 Cloudflare API Token，也不需要账户 ID。

三条规则：

1. **新备份完全成功才覆盖** `latest.sql`。任一步失败，旧备份原样保留。
2. **桶里只有 `d1/latest.sql`**，不生成日期目录、不留历史。
3. 失败自动重试 3 次，间隔递增。

备份对象带 `backup_sha256` / `backup_at` 元数据，后台「设置」页可查看。

### 恢复

```bash
npx wrangler r2 object get imgflare-backup-bucket/d1/latest.sql --file=latest.sql
npx wrangler d1 execute imgflare-db --remote --file=latest.sql
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
curl "http://localhost:8787/__scheduled?cron=0+4+*+*+*"
```

> 本地 `dump()` 会返回 404 —— miniflare 未实现 D1 导出。这条路径需在线上验证。

---

## 八、本地开发

```bash
bun install
cp .dev.vars.example .dev.vars
bun run db:migrate:local
bun run dev                            # http://localhost:8787
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

`TURNSTILE_SITE_KEY` 还是占位值，或 `ADMIN_PASSWORD` / `SESSION_SECRET` / `TURNSTILE_SECRET` 没配齐。看 Worker 的 Logs。

**登录页没有人机验证**

同上，Worker 会拒绝服务并报 `TURNSTILE_SITE_KEY is still the placeholder`。

**改了变量不生效**

Cloudflare 上的变量改动需要重新部署。

**图片链接指向旧域名**

`ORIGIN` 没更新。改完要重新部署，已有文件的 URL 是按当时的 `ORIGIN` 生成的。

**上传的 HTML 打开是源代码**

设计如此，见「安全模型」。同源部署下这是防止会话被窃取的代价。

**Cron 没跑**

Worker → **Settings** → **Trigger Events** 确认 Cron 存在；再看 Logs 里 `scheduled` 的结果。也可以点后台「设置 → 立即备份」手动验证。

**上传大文件失败**

`MAX_UPLOAD_SIZE` 上限同时受 Worker 请求体限制（免费版 100 MB）。

---

## 许可

MIT — 见 [LICENSE](LICENSE)。
