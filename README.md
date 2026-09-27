# ImgFlare

个人图床 / 文件托管。Rust → WebAssembly → Cloudflare Worker + R2 + D1 + Turnstile。

| | |
|---|---|
| 后端 | Rust + workers-rs `0.8.7` → `wasm32-unknown-unknown` |
| 文件 | R2，内容寻址 `f/<sha256>` |
| 元数据 | D1（`files` / `api_tokens` / `kv_meta`） |
| 登录 | 用户名 + 密码 + Turnstile（服务端校验） |
| 会话 | 无状态 HMAC-SHA256 签名 Cookie |
| 前端 | TypeScript + esbuild，无框架 |
| 去重 | 浏览器 SHA-256 + R2 checksum + D1 唯一索引 |
| 备份 | 每日 Cron，D1 → SQL → 私有 R2，只保留 `d1/latest.sql` |

不使用 KV、Redis、Queue、Durable Objects。

---

## 目录

- [一、准备资源](#一准备资源)
- [二、部署](#二部署)
- [三、配置参考](#三配置参考)
- [四、绑定域名](#四绑定域名)
- [五、验收](#五验收)
- [六、API](#六api)
- [七、油猴脚本](#七油猴脚本)
- [八、备份与恢复](#八备份与恢复)
- [九、本地开发](#九本地开发)
- [十、常见问题](#十常见问题)

---

## 一、准备资源

在 Cloudflare 控制台完成以下 4 项，把拿到的 ID 记下来。

### 1. R2 Bucket（两个）

**R2 → Create bucket**

| Bucket 名 | 用途 | 公开 |
|---|---|---|
| `personal-image-host` | 用户上传的文件 | 是（绑 `img.你的域名`） |
| `personal-image-host-backup` | D1 备份 | **否**，不要绑域名 |

### 2. D1 数据库

**Workers & Pages → D1 → Create database**

名称 `personal-image-host`。创建后复制 **Database ID**。

建表：进入数据库 → **Console** → 粘贴 [`migrations/0001_init.sql`](migrations/0001_init.sql) 全文执行。

### 3. Turnstile

**Turnstile → Add widget**

- Domain：填 `panel.你的域名`
- Widget Mode：`Managed`

拿到 **Site Key**（公开）和 **Secret Key**（保密）。

### 4. Cloudflare API Token（给 D1 导出用）

**My Profile → API Tokens → Create Custom Token**

- Permissions：`Account` → `D1` → `Edit`
- Account Resources：选中你的账号

拿到 token 字符串。

> 这个 token 用来调用 D1 Export REST API。只用它做导出，权限不要给大。

---

## 二、部署

### 方式 A：Git 自动构建（推荐）

1. 把本仓库推到 GitHub。
2. **Workers & Pages → Create → Workers → Connect to Git**，选中仓库。
3. 填写构建配置：

| 项 | 值 |
|---|---|
| Build command | 见下方 |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` |

Build command（构建镜像默认没有 Rust，需要现装）：

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
. "$HOME/.cargo/env"
rustup target add wasm32-unknown-unknown
cargo install worker-build --version 0.8.7 --locked
bun install
bun run build
```

> `bun run build` 产出 `dist/`（前端）、`userscript/image-uploader.user.js`、`build/worker/shim.mjs` + `index.wasm`。

4. 首次部署会失败或行为异常，因为 `wrangler.toml` 里还是占位值。**先按第三节把配置改完再重新部署**。

### 方式 B：本地构建 + 上传

```bash
# 工具链（只需一次）
rustup target add wasm32-unknown-unknown
cargo install worker-build --version 0.8.7 --locked
bun install

# 改好 wrangler.toml（见第三节）
bun run build
npx wrangler login
npx wrangler deploy
```

### 方式 C：控制台直接粘贴

不方便用 Git、也不想装 Rust 时：本地按方式 B 跑到 `bun run build`，然后

```bash
npx wrangler deploy
```

`wrangler` 会把 `build/worker` 的 Wasm 与 `dist/` 的静态资源一起传上去。之后配置都在控制台改，无需再本地构建（除非代码有更新）。

---

## 三、配置参考

所有非密钥配置都在 [`wrangler.toml`](wrangler.toml)，把占位符替换掉：

```toml
name = "imgflare"                        # Worker 名称

[vars]
ADMIN_USERNAME     = "admin"             # 登录用户名
PUBLIC_BASE_URL    = "https://img.example.com"    # 公开访问域名
PANEL_ORIGIN       = "https://panel.example.com"  # 管理后台域名
ACCOUNT_ID         = "你的 Account ID"
DATABASE_ID        = "你的 D1 Database ID"
MAX_UPLOAD_SIZE    = "52428800"          # 50 MiB
TURNSTILE_SITE_KEY = "你的 Site Key"
SESSION_TTL_SECONDS = "604800"           # 7 天

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "personal-image-host"

[[r2_buckets]]
binding = "BACKUP_BUCKET"
bucket_name = "personal-image-host-backup"

[[d1_databases]]
binding = "DB"
database_name = "personal-image-host"
database_id = "你的 D1 Database ID"
```

> `PUBLIC_BASE_URL` 与 `PANEL_ORIGIN` **必须是不同 Origin**。上传的 `.html` / `.svg` / `.js` 由前者公开直出，若与后台同源会拿到会话 Cookie。Worker 启动时会检查，相同则拒绝服务。

### 密钥

在 **Workers & Pages → 你的 Worker → Settings → Variables and Secrets** 添加 4 个 **Secret**（Type 选 `Secret`，不要用 `Text`）：

| 名称 | 值 |
|---|---|
| `ADMIN_PASSWORD` | 管理员密码，建议 20 位以上随机串 |
| `SESSION_SECRET` | `openssl rand -base64 48` |
| `TURNSTILE_SECRET` | 第 1 节的 Turnstile Secret Key |
| `CLOUDFLARE_API_TOKEN` | 第 1 节的 API Token |

或用命令行：

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put CLOUDFLARE_API_TOKEN
```

### Cron

`wrangler.toml` 已声明，无需在控制台额外配置：

```toml
[triggers]
crons = ["0 4 * * *"]   # 每天 04:00 UTC
```

### 兼容性

```toml
compatibility_date = "2026-09-27"
compatibility_flags = ["nodejs_compat"]
```

Rust/Wasm Worker 需要 `nodejs_compat`。

---

## 四、绑定域名

### 管理端 → Worker

**Worker → Settings → Domains & Routes → Add → Custom Domain**

填 `panel.你的域名`。

### 公开端 → R2

**R2 → `personal-image-host` → Settings → Custom Domains → Connect Domain**

填 `img.你的域名`。

> 公开文件**不经过 Worker**，由 R2 直接提供。不需要登录、Cookie、Turnstile、Token。
>
> `personal-image-host-backup` **不要**绑任何域名。

---

## 五、验收

```bash
PANEL=https://panel.你的域名
IMG=https://img.你的域名

# 未登录应 401 + JSON
curl -i $PANEL/api/files

# 公开对象应免认证可访问（换成实际 sha256）
curl -I $IMG/f/<sha256>
```

浏览器打开 `$PANEL/login`，用 `ADMIN_USERNAME` + `ADMIN_PASSWORD` 登录，上传一张图，复制 Markdown 贴到别处确认能显示。

完整清单见 [`test/manual-test.md`](test/manual-test.md)。

---

## 六、API

错误统一为 `{ "success": false, "error": "<code>" }`，配真实状态码。

成功有两种形状：多数端点为 `{ "success": true, "data": {...} }`；上传相关端点字段直接在顶层。

### 页面

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/` | 管理界面 |
| `GET` | `/login` | 登录页 |

### 认证

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| `POST` | `/api/login` | Turnstile + 用户名密码 | 建立会话，连续失败会 429 |
| `POST` | `/api/logout` | Session | 清除会话 |
| `GET` | `/api/me` | 可选 | 当前身份 |

```bash
curl -X POST $PANEL/api/login \
  -H 'Content-Type: application/json' \
  -H "Origin: $PANEL" \
  -d '{"username":"admin","password":"...","cf-turnstile-response":"..."}'
```

### 上传

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| `POST` | `/api/upload/check` | Session 或 Token | 按 SHA-256 查重 |
| `POST` | `/api/upload` | Session 或 Token | `multipart/form-data`，字段 `file` |

```bash
SHA=$(sha256sum photo.png | cut -d' ' -f1)

# 查重
curl -X POST $PANEL/api/upload/check -H 'X-API-Key: cph_xxx' \
  -H 'Content-Type: application/json' -d "{\"sha256\":\"$SHA\",\"size\":123}"

# 上传
curl -X POST $PANEL/api/upload -H 'X-API-Key: cph_xxx' \
  -H "X-File-SHA256: $SHA" -F "file=@photo.png"
```

支持扩展名：`png jpg jpeg webp gif avif svg bmp ico txt json xml css js mjs html pdf zip 7z`，以及 `.user.js`。

### 文件

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| `GET` | `/api/files?q=&limit=&offset=` | Session | 分页 + 搜索 |
| `GET` | `/api/files/:id` | Session | 单个文件 |
| `DELETE` | `/api/files/:id` | **仅 Session** | 同时删 R2 与 D1 |
| `GET` | `/api/stats` | Session | 文件数与总字节 |

API Token 不能删除文件。

### Token

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| `GET` | `/api/tokens` | Session | 列表（无明文） |
| `POST` | `/api/tokens` | Session | 生成，**明文只返回一次** |
| `DELETE` | `/api/tokens/:id` | Session | 撤销 |
| `DELETE` | `/api/tokens/:id/purge` | Session | 彻底删除 |

### 备份

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| `GET` | `/api/backup/status` | Session | 大小、SHA-256、时间 |
| `GET` | `/api/backup/latest` | Session | 下载 `d1/latest.sql` |
| `POST` | `/api/backup/run` | Session | 立即备份一次 |

---

## 七、油猴脚本

编译产物在 [`userscript/image-uploader.user.js`](userscript/image-uploader.user.js)，可直接安装到 Tampermonkey / Violentmonkey。

安装后点脚本菜单 → **设置**，填：

- **API 地址**：`https://panel.你的域名`
- **Token**：在后台「API Token」页生成

功能：`Ctrl+V` 粘贴上传、拖拽上传、批量上传（最多 3 并发）、失败重试 2 次、自动插入 Markdown 到当前输入框。

改源码后重新编译：

```bash
bun run build:userscript
```

---

## 八、备份与恢复

### 流程

每天 04:00 UTC 触发 `scheduled()`：

```text
D1 Export API 建任务 → 轮询取签名 URL → 下载 SQL
  → 校验 SHA-256 → 写 d1/.tmp/... → 覆盖 d1/latest.sql → 删临时对象
```

三条规则：

1. **新备份完全成功才覆盖** `latest.sql`。任一步失败，旧备份原样保留。
2. **桶里只有 `d1/latest.sql`**，不生成日期目录、不留历史。
3. 失败自动重试 3 次，间隔递增。

备份对象带 `backup_sha256` / `backup_at` 元数据，后台「设置」页可查看。

### 恢复

```bash
# 下载
npx wrangler r2 object get personal-image-host-backup/d1/latest.sql --file=latest.sql

# 导入（先建库）
npx wrangler d1 create personal-image-host-restore
npx wrangler d1 execute personal-image-host-restore --remote --file=latest.sql
```

### Time Travel

D1 保留 30 天内任意时间点，比 SQL 备份更完整：

```bash
npx wrangler d1 time-travel info personal-image-host
npx wrangler d1 time-travel restore personal-image-host --timestamp=<ISO8601>
```

### 本地测 Cron

```bash
bun run dev:cron
curl "http://localhost:8787/__scheduled?cron=0+4+*+*+*"
```

---

## 九、本地开发

```bash
bun install
cp .dev.vars.example .dev.vars        # 已含可用的本地默认值
bun run db:migrate:local
bun run dev                            # http://localhost:8787
```

`.dev.vars` 里 `PUBLIC_BASE_URL` / `PANEL_ORIGIN` 故意用了 `127.0.0.1` 与 `localhost` 两个不同 Origin —— 两者都指向本机，但满足「必须不同源」的检查。

常用命令：

```bash
bun run verify           # 类型检查 + 契约检查 + 全量构建
bun run typecheck        # tsc --noEmit
bun run check:contract   # Rust 结构体 vs TS interface 字段比对
bun run build:assets     # 只构建前端 + 油猴
bun run build:worker     # 只构建 Wasm
bun run clean            # 清 dist / build / target
```

`check:contract` 会读 Rust 结构体（含 `rename_all` 效果）与 TS interface，逐字段比对，防止 `created_at` / `createdAt` 这类两边都能编译、运行时才炸的错位。

---

## 十、常见问题

**登录按钮点了没反应 / 一直提示失败**

- `TURNSTILE_SITE_KEY` 与 `TURNSTILE_SECRET` 是否成对配置且属于同一 Widget。
- 浏览器控制台是否有 `challenges.cloudflare.com` 被 CSP 拦截的记录。
- 连续失败 8 次会限流 15 分钟，等一会再试。

**图片能上传但打不开**

`img.你的域名` 尚未绑定到 R2 bucket，或绑定到了错误的 bucket。

**部署后所有接口 500**

`wrangler.toml` 里还有 `YOUR_*` 占位值，或 4 个 Secret 没配齐。

**`PUBLIC_BASE_URL and PANEL_ORIGIN must be different origins`**

两个变量填了同一个域名。公开端必须用独立域名（或子域名）绑定 R2。

**Cron 没跑**

**Worker → Settings → Trigger Events** 确认 Cron 存在；再看 **Logs** 里 `scheduled` 的执行结果。也可以点后台「设置 → 立即备份」手动验证。

**上传大文件失败**

`MAX_UPLOAD_SIZE` 上限同时受 Worker 请求体限制（免费版 100 MB）。第一版未实现 R2 Multipart Upload。

---

## 许可

MIT — 见 [LICENSE](LICENSE)。
