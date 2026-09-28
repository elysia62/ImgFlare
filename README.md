# ImgFlare

个人图床。Rust → WebAssembly → Cloudflare Worker + R2 + D1 + Turnstile。

| | |
|---|---|
| 后端 | Rust + workers-rs `0.8.7` → `wasm32-unknown-unknown` |
| 图片 | 公开路径 `/i/<32位id>.<ext>`，例如 `/i/4L4V3tZnrvk16TmODWWOyZWDTzov1YY4.png` |
| 元数据 | D1（`files` / `api_tokens` / `kv_meta`） |
| 登录 | 用户名 + 密码 + Turnstile（服务端校验） |
| 会话 | 无状态 HMAC-SHA256 签名 Cookie |
| 前端 | TypeScript + esbuild，无框架 |
| 去重 | 浏览器 SHA-256 + R2 checksum + D1 唯一索引 |
| 备份 | 每日 Cron，D1 → SQL → 同一个桶的 `back/latest.sql` |

一个域名。图片公开可读；面板使用用户名、密码和 Turnstile 登录，油猴脚本独立使用 API Key 上传，无需登录面板。

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
| Build command | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh -s -- -y --profile minimal --default-toolchain stable && . "$HOME/.cargo/env" && bun run build` |
| Deploy command | `bun run deploy` |
| Root directory | `/` |

Build command 里那段 `curl` 只是为了装 Rust。Cloudflare 构建镜像有 Bun，没有 Rust。`rust-toolchain.toml` 会让第一次调用 `cargo` 时补上 `wasm32-unknown-unknown`，`bun run build` 再完成前端和 Worker。

第一次构建要下载工具链并编译，大概几分钟。免费版 Worker 的 CPU 时间只有 10 毫秒，不够校验上传，部署到 **Workers Paid**。

想拆成多行更易读也可以：

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
. "$HOME/.cargo/env"
bun run build
```

> `wasm32-unknown-unknown` 由 `rust-toolchain.toml` 声明，构建脚本发现没有这个目标时会执行 `rustup target add`。`wasm-bindgen` 按 `Cargo.lock` 锁定的版本下载预编译包，缓存在 `build/.tools/`。
>
> 不需要 `cargo install worker-build`。原因见 [`scripts/build-worker.mjs`](scripts/build-worker.mjs) 顶部注释。

#### 指定 Bun 版本

构建镜像默认 Bun `1.2.15`，但本仓库的 `bun.lock` 由 Bun `1.4.2` 生成（`lockfileVersion: 2`），旧版读不懂，会直接报 `Unknown lockfile version` 并中止构建。

所以必须在 **Settings → Build → Build Variables and Secrets** 里加一个变量：

| 变量 | 值 |
|---|---|
| `BUN_VERSION` | `1.4.2` |

Bun 不支持版本文件覆盖，只能通过这个环境变量。`package.json` 里的 `packageManager` 也写成了 `bun@1.4.2`，保持不变。

> 以后改动依赖后，本地也要用同一版本跑 `bun install`，否则锁文件版本号会和构建环境对不上。

`bun run deploy` 会读取下面这 9 个环境变量，写进 Worker，再执行 `wrangler d1 migrations apply DB --remote`。`BUN_VERSION` 只用于构建，不会写进 Worker。

### 3. 创建页

D1 名字保持 `imgflare-db`，位置 `Automatic`，不要勾读取复制。

填在 **Settings → Build → Build variables and secrets**。仓库里不写值。这一页的值只在构建时能读到，部署命令会把它们写进 Worker。选「变量」或「密钥」都可以。

| 名称 | 变量 | 加密 |
|---|---|---|
| 管理员用户名 | `ADMIN_USERNAME` | 否 |
| 管理员密码 | `ADMIN_PASSWORD` | 是 |
| 会话签名密钥 | `SESSION_SECRET` | 是 |
| Turnstile Site Key | `TURNSTILE_SITE_KEY` | 否 |
| Turnstile Secret Key | `TURNSTILE_SECRET` | 是 |
| R2 Account ID | `R2_ACCOUNT_ID` | 否 |
| R2 的 Access Key ID | `R2_ACCESS_KEY_ID` | 是 |
| R2 的 Secret Access Key | `R2_SECRET_ACCESS_KEY` | 是 |
| R2 桶名 | `R2_BUCKET` | 否 |

上传上限 50 MB、登录有效期 7 天。

`SESSION_SECRET` 必须为每个部署单独生成的随机密钥（至少 32 字符）。可用 `openssl rand -hex 32` 生成一次，保存到构建密钥中；后续部署保持不变。升级到此版本时必须补上这个配置，原有 Cookie 会失效，需要重新登录；API Token 不受影响。不要沿用旧版写在代码里的密钥。更换 `SESSION_SECRET` 可让所有已签发的面板会话失效。

R2 桶要自己先建好。不要开公共访问。

### 4. 部署

点 **Deploy**。第一次会按页上的名字创建 D1 `imgflare-db`，并自动执行 [`migrations/init_01.sql`](migrations/init_01.sql)。不用在 D1 控制台里粘贴 SQL。

Turnstile 在 **Turnstile → Add widget** 里创建。Domain 填 Worker 域名，Widget Mode 选 `Managed`。Site Key 和 Secret Key 填进上面那张表。

之后打开 Worker 域名的 `/login`，用管理员用户名和密码登录。改了上面的值要重新部署，部署命令会把新值写进 Worker。

### 绑定自定义域名（可选）

Worker → **Settings** → **Domains & Routes** → **Add** → **Custom Domain**。图片地址用你打开面板时的那个域名，不用再改配置。

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
# 换成 Cloudflare 给的 workers.dev，或你绑定的域名
BASE=https://你的域名

# 未登录打开首页应 302 到 /login
curl -si $BASE/ | head -n 20

# 不存在的图片应 404，不要求登录
curl -si $BASE/i/0123456789ABCDEF0123456789ABCDEF.png | head -n 20
```

浏览器打开 `$BASE/login`，用 `ADMIN_USERNAME` + `ADMIN_PASSWORD` 登录，上传一张图，复制 Markdown 贴到别处确认能显示。

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
| `GET` | `/i/:id.:ext` | 无 | 原图，例如 `/i/4L4V3tZnrvk16TmODWWOyZWDTzov1YY4.png` |
| `HEAD` | `/i/:id.:ext` | 无 | 同上，无响应体 |

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

curl -X POST $BASE/api/upload \
  -H 'X-API-Key: cph_xxx' \
  -H "X-File-SHA256: $SHA" \
  -F "file=@photo.png"
```

只接受图片：`png` `jpg` `jpeg` `webp` `gif` `avif` `bmp` `ico` `svg` `jxl` `heic` `heif` `tif` `tiff`。扩展名和文件头必须一致，其它类型返回 415。公开地址带真实后缀；后缀不对返回 404。

### 图片

| 方法 | 路径 | 认证 |
|---|---|---|
| `GET` | `/api/files?q=&limit=&offset=` | Session |
| `GET` | `/api/files/:id` | Session |
| `DELETE` | `/api/files/:id` | **仅 Session** |

API Token 不能删除图片。

### Token

| 方法 | 路径 | 认证 |
|---|---|---|
| `GET` | `/api/tokens` | Session |
| `POST` | `/api/tokens` | Session（明文只返回一次） |
| `DELETE` | `/api/tokens/:id` | Session（删除记录，立刻失效） |

### 备份

| 方法 | 路径 | 认证 |
|---|---|---|
| `GET` | `/api/backup/status` | Session |
| `GET` | `/api/backup/latest` | Session |
| `POST` | `/api/backup/run` | Session |

---

## 五、安全模型

只存图片。扩展名和文件头不一致就拒绝上传。

`/i/<id>.<ext>` 不需要登录。后缀和图片类型不一致，或者不是图片，返回 404，不返回文件内容。SVG 会加 `Content-Security-Policy: sandbox`，直接打开时不执行脚本。

不要给 R2 桶开公共访问。图片只从 Worker 的 `/i/` 出去，`back/latest.sql` 不在这条路径上。

面板 Cookie 的写操作比对 `Origin` 和请求自己的 host。显式携带 `X-API-Key` 时只验证该 Key，不回退到 Cookie；Key 仅允许上传、查重和查询自身身份，不授予管理权限。未登录访问 `/` 会 `302` 到 `/login`。面板 CSP 只放行本站和 Turnstile。

---

## 六、油猴脚本

编译产物在 [`userscript/image-uploader.user.js`](userscript/image-uploader.user.js)，可直接安装。

安装后**改脚本里顶部的两行配置**，保存即可（没有设置菜单，也没有悬浮按钮）：

```js
const API_URL = 'https://你的域名';
const API_TOKEN = 'cph_在后台生成的Token';
```

- `API_URL`：**必须带 `https://`**，Worker 域名或你绑定的域名都行，结尾不要带斜杠。
- `API_TOKEN`：在后台「API Token」页生成，明文只显示一次。

用法：在任意网页 `Ctrl+V` 粘贴图片，或把图片拖进页面。上传完成后 Markdown 会插入当前光标处，同时留在剪贴板里。同一时间最多上传 3 个，失败自动重试 2 次。

行为说明：

- 脚本通过 `X-API-Key` 认证并设置 `anonymous: true`，不发送 Cookie，也不需要先登录面板。
- 没有悬浮面板、没有提示框。出错只在浏览器控制台写一条 `[imgflare]` 日志。
- 在你的图床域名下脚本不会生效：后台本身支持粘贴上传，两边都拦截会重复上传。
- 只在最外层文档运行，不在 iframe 里重复接管。
- 页面必须是安全上下文（HTTPS 或 localhost）。普通 HTTP 页面浏览器不提供 `crypto.subtle`，算不了 SHA-256，会明确报错而不是静默失败。
- 配置没写好时不会静默失效，控制台会说明原因（缺 `https://`、还是占位值）。

> 升级脚本会覆盖你手改的这两行，更新前先记下配置。

改源码后重新编译：

```bash
bun run build:userscript
```

---

## 七、备份与恢复

每天 04:00 UTC 触发 `scheduled()`：

```text
D1 单次查询取得三张业务表的一致快照 → SQL 文本 → R2 校验 SHA-256 → 原子写入 back/latest.sql
```

写在图片同一个桶里，凭证就是上面那把访问密钥。公开地址只读 `/i/<id>.<ext>`，读不到 `back/`。不要给这个桶开 R2 公共访问。

1. R2 完整接收并校验新文件后才原子替换 `back/latest.sql`，不会出现半份备份。导出失败或 R2 拒绝写入时保留旧文件。
2. 只留这一个备份。
3. 总共最多尝试 3 次，失败会记录错误日志。
4. 导出 `files`、`api_tokens`、`kv_meta` 的建表语句、索引和数据，不包含图片内容、Worker 密钥或 D1 内部迁移表。新增业务表/迁移时需同步更新导出逻辑。
5. 自动备份限制为三张表合计 20,000 行、SQL 数据语句 8 MiB，超出时明确失败并保留旧备份，避免耗尽 Worker 内存。更大数据库请使用 `bunx wrangler d1 export imgflare-db --remote --output latest.sql` 或 D1 Time Travel。

后台「设置」可以下载，也可以看 `backup-sha256` / `backup-at`。

### 恢复

先创建一个空 D1 数据库作为恢复目标，再用同一把 R2 访问密钥下载 SQL；恢复完成后更新 Worker 的 D1 绑定。不要将下列 SQL 导入仍有业务数据的库：

```bash
AWS_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID \
AWS_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY \
aws s3 cp s3://$R2_BUCKET/back/latest.sql latest.sql \
  --endpoint-url https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com

bunx wrangler d1 execute imgflare-restored --remote --file=latest.sql
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

> 已移除仅支持旧 Alpha 数据库的 `dump()`。查询导出可在本地 D1 验证；`bun run test:integration` 使用隔离的本地 D1 和模拟 R2/Turnstile，验证 SQL 恢复、权限、定时任务及失败保留。

---

## 八、本地开发

需要 Rust（`rustup` 装，含 `wasm32-unknown-unknown`）与 Bun，其余由 `bun run build` 自理。

```bash
bun install
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，填入随机 SESSION_SECRET 和自己的 R2 配置
bun run dev                            # http://localhost:8787，会先执行本地迁移
```

常用命令：

```bash
bun run verify           # 类型检查 + 契约检查 + 全量构建 + Worker 集成测试
bun run typecheck        # tsc --noEmit
bun run check:contract   # Rust 结构体 vs TS interface + 静态安全不变量
bun run test:integration # 先构建资源和 Worker，再测登录、Key 上传、备份恢复及 Cron
bun run build:assets     # 只构建前端 + 油猴
bun run build:worker     # 只构建 Wasm
bun run clean            # 清 dist / build / target
```

---

## 九、常见问题

**构建时报 `Unknown lockfile version`**

Cloudflare 构建镜像的默认 Bun 比本地旧，读不懂 `bun.lock`。到 **Settings → Build → Build Variables and Secrets** 加 `BUN_VERSION` = `1.4.2`，再重新部署。

**部署报 `required secrets have not been set`**

「变量和机密」里的值只给构建用，wrangler 不会把它当成 Worker 密钥。确认 9 个名字都填了，然后重新部署。`bun run deploy` 会读这些环境变量并写进 Worker。

**部署后所有接口 500**

登录账号、Turnstile 或 R2 没填全。创建页上的值要填完整。

**登录页没有人机验证**

`TURNSTILE_SITE_KEY` 还是占位，或没配对 `TURNSTILE_SECRET`。

**改了变量不生效**

重新部署一次。部署命令会用构建环境里的新值覆盖 Worker 上的旧值。

**非图片上传失败**

只接受 png、jpg、webp、gif、avif、bmp、ico，而且文件头要和扩展名一致。

**Cron 没跑**

Worker → **Settings** → **Trigger Events** 确认 Cron 存在；再看 Logs 里 `scheduled` 的结果。也可以点后台「设置 → 立即备份」手动验证。

**上传大文件失败**

单张上限 50 MB，写死在程序里。Worker 请求体还有自己的上限。

---

## 许可

MIT — 见 [LICENSE](LICENSE)。
