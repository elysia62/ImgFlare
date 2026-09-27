你是一名资深 Rust、WebAssembly、Cloudflare Workers、Cloudflare R2、Cloudflare D1、TypeScript 工程师。

请从零完整实现一个：

> Rust/Wasm + Cloudflare Worker + R2 + D1 + Turnstile + TypeScript 的极简个人图床/文件托管项目。

项目必须真正可以编译、运行和部署。

不要只给架构图、伪代码或核心代码。

必须最终给出完整项目源码。

==================================================
一、项目目标
======

这是一个个人使用的极简图床。

核心需求：

1. 使用 Rust 编写 Cloudflare Worker
2. Rust 编译为 WebAssembly
3. 使用 Cloudflare R2 保存原始图片和文件
4. 使用 Cloudflare D1 保存文件元数据、SHA-256、API Token 等结构化数据
5. 登录使用密码 + Cloudflare Turnstile
6. 图片公共访问不需要登录
7. 公共图片 URL 可以直接用于 Markdown
8. 上传原图，不进行图片压缩和重编码
9. 支持复制 URL
10. 支持复制 Markdown
11. 支持粘贴图片
12. 支持拖拽图片
13. 支持批量上传
14. 支持 Tampermonkey / Violentmonkey
15. 油猴脚本使用 TypeScript 编写
16. 支持 API Token 上传
17. 使用 SHA-256 实现内容去重
18. 相同文件只保存一次
19. 每天自动将 D1 导出到私有 R2
20. 备份只保留一个最新文件：
    `d1/latest.sql`

项目原则：

> 简单、可靠、容易部署、容易维护。

不要设计成商业级 SaaS。

不要加入没有必要的复杂系统。

==================================================
二、最终架构
======

最终架构必须保持：

```text
Cloudflare Worker
│
├── Rust / WebAssembly
│
├── R2
│   └── personal-image-host
│       └── 图片/普通文件
│
├── R2 Backup
│   └── personal-image-host-backup
│       └── d1/latest.sql
│
└── D1
    ├── files
    └── api_tokens
```

其中：

```text
R2
=
实际文件

D1
=
文件索引 + 元数据 + SHA-256 + API Token

R2 Backup
=
最新 D1 SQL 备份

Rust Worker
=
HTTP API + 登录 + 上传 + 去重 + 管理 + 定时备份
```

不使用 KV。

不使用 Redis。

不使用 Queue。

不使用 Durable Objects。

不使用 PostgreSQL。

不使用 MySQL。

不使用独立服务器。

==================================================
三、域名设计
======

使用两个域名。

假设：

```text
panel.example.com
img.example.com
```

---

## panel.example.com

用于：

* 登录
* Turnstile
* 上传
* 文件管理
* 文件搜索
* 删除
* API
* Token 管理
* 管理页面

这个域名由 Rust Worker 提供。

---

## img.example.com

用于：

* 图片
* 普通文件
* `.user.js`
* `.js`
* `.css`
* `.json`
* `.txt`
* `.pdf`
* `.zip`

这个域名绑定公开图片 R2 Bucket：

```text
personal-image-host
```

这里：

不要要求登录。

不要要求 Turnstile。

不要要求 Cookie。

不要要求 API Token。

不要经过管理 Worker API。

例如：

```text
https://img.example.com/f/4d2a7b...
```

任何网站都可以直接访问。

==================================================
四、R2 Backup Bucket
==================

单独建立：

```text
personal-image-host-backup
```

这个 Bucket：

必须是私有的。

不要配置：

```text
img.example.com
```

不要设置公开访问。

只允许 Worker 通过 R2 Binding 写入/读取。

里面只保存：

```text
d1/latest.sql
```

不保留历史版本。

不要：

```text
d1/2026/09/27.sql
d1/2026/09/28.sql
...
```

只保留：

```text
d1/latest.sql
```

每次新的备份成功后：

```text
旧 latest.sql
        ↓
被新 latest.sql 替换
```

最终 Backup Bucket 始终只有：

```text
d1/latest.sql
```

==================================================
五、后端技术
======

必须使用：

* Rust
* workers-rs
* WebAssembly
* wasm32-unknown-unknown
* Wrangler

不能使用：

* Axum
* Actix
* Rocket
* Warp
* Express
* Node.js 后端

必须是：

```text
Rust
 ↓
Wasm
 ↓
Cloudflare Worker
```

使用当前版本 workers-rs 的真实 API。

不要根据旧版本 API 猜测。

如果当前 API 与旧教程不同：

以当前官方 API 为准。

==================================================
六、TypeScript 前端
===============

前端全部使用：

* TypeScript
* HTML
* CSS

不要使用：

* React
* Vue
* Angular
* Svelte
* Next.js
* Nuxt
* jQuery
* Bootstrap
* Tailwind

不要使用大型前端框架。

使用：

```text
TypeScript + esbuild
```

前端代码：

```text
frontend/src/*.ts
```

构建：

```text
TypeScript
    ↓
esbuild
    ↓
JavaScript
```

最终静态文件由 Cloudflare Worker Static Assets 提供。

==================================================
七、油猴脚本
======

油猴脚本也必须使用 TypeScript：

```text
userscript/image-uploader.user.ts
```

编译成：

```text
image-uploader.user.js
```

支持：

* Tampermonkey
* Violentmonkey

不能要求用户本地安装 Node 才能运行。

最终提供编译后的：

```text
userscript/image-uploader.user.js
```

可以直接安装。

==================================================
八、项目目录
======

推荐：

```text
personal-image-host/
│
├── Cargo.toml
├── wrangler.toml
├── package.json
├── tsconfig.json
├── README.md
├── LICENSE
│
├── migrations/
│   └── 0001_init.sql
│
├── src/
│   ├── lib.rs
│   ├── router.rs
│   ├── auth.rs
│   ├── turnstile.rs
│   ├── upload.rs
│   ├── files.rs
│   ├── tokens.rs
│   ├── db.rs
│   ├── backup.rs
│   ├── response.rs
│   ├── error.rs
│   └── utils.rs
│
├── frontend/
│   ├── index.html
│   ├── login.html
│   ├── styles.css
│   │
│   └── src/
│       ├── app.ts
│       ├── api.ts
│       ├── auth.ts
│       ├── upload.ts
│       ├── files.ts
│       ├── hash.ts
│       ├── clipboard.ts
│       ├── ui.ts
│       └── types.ts
│
├── userscript/
│   └── image-uploader.user.ts
│
└── dist/
```

实际实现过程中，如果发现某些文件没有必要：

可以合并。

不要为了显得专业拆成几十个文件。

==================================================
九、管理员登录
=======

这是个人项目。

不需要：

* 注册
* 找回密码
* 邮箱
* OAuth
* GitHub 登录
* Google 登录
* 多用户
* 多角色
* 权限组

只有一个管理员。

登录：

```text
密码
+
Turnstile
```

页面：

```text
┌─────────────────────────┐
│                         │
│        个人图床          │
│                         │
│ 密码                    │
│ [___________________]   │
│                         │
│ [ Turnstile ]           │
│                         │
│ [ 登录 ]                │
│                         │
└─────────────────────────┘
```

==================================================
十、管理员密码
=======

密码必须通过 Worker Secret 配置：

```text
ADMIN_PASSWORD
```

不要写死源码。

不要保存 D1。

不要进入 Git。

不要在 API 中返回。

不要打印日志。

可以使用常量时间比较。

==================================================
十一、Turnstile
============

登录页面使用：

```text
TURNSTILE_SITE_KEY
```

后端使用：

```text
TURNSTILE_SECRET
```

Secret 必须通过：

```text
wrangler secret
```

配置。

登录流程：

```text
用户输入密码
      +
Turnstile Token
      ↓
Worker
      ↓
服务端验证密码
      ↓
调用：
https://challenges.cloudflare.com/turnstile/v0/siteverify
      ↓
验证成功
      ↓
建立 Session
```

绝对不能：

> 只在前端验证 Turnstile。

服务端必须检查。

==================================================
十二、Session
==========

不要使用大型认证框架。

使用简单的签名 Cookie Session。

例如：

```text
session=<payload>.<signature>
```

Payload 至少：

```text
issued_at
expires_at
nonce
```

使用：

```text
HMAC-SHA256
```

签名。

Secret：

```text
SESSION_SECRET
```

Cookie：

```text
HttpOnly
Secure
SameSite=Lax
Path=/
```

默认过期：

```text
7 天
```

提供：

```http
POST /api/logout
```

注销后 Cookie 清除。

不要引入 KV 保存 Session。

==================================================
十三、D1 Schema
============

D1 用于：

* 文件元数据
* SHA-256
* API Token

创建：

```text
migrations/0001_init.sql
```

至少：

```sql
CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL UNIQUE,
    r2_key TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    etag TEXT,
    created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_files_sha256
ON files(sha256);

CREATE INDEX IF NOT EXISTS idx_files_created_at
ON files(created_at DESC);
```

API Token：

```sql
CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
);
```

不需要：

```text
backup_runs
```

不需要：

```text
sessions
```

不需要其他复杂表。

==================================================
十四、R2 文件 Key
============

R2 文件 Key 必须使用：

```text
f/<sha256>
```

例如：

```text
f/4d2a7b...
```

sha256：

```text
64 个十六进制字符
```

不要使用：

```text
f/<uuid>.png
```

不要使用原始文件名作为 Key。

不要使用日期随机目录作为 Key。

核心原则：

```text
文件内容
    ↓
SHA-256
    ↓
R2 Key
```

因此相同文件：

```text
相同 SHA-256
    ↓
相同 R2 Key
    ↓
相同 URL
```

==================================================
十五、文件去重
=======

这是核心功能。

相同文件只保存一次。

判断依据：

```text
SHA-256
```

不能使用：

* 文件名
* 文件大小
* ETag
* MIME 类型

作为唯一去重依据。

必须：

```text
文件内容 SHA-256
```

==================================================
十六、浏览器端 Hash
============

前端：

```text
frontend/src/hash.ts
```

使用浏览器原生：

```javascript
crypto.subtle.digest("SHA-256", ...)
```

不能引入大型 Hash 库。

得到：

```text
64 位小写十六进制 SHA-256
```

==================================================
十七、重复上传流程
=========

用户选择文件：

```text
文件
 ↓
计算 SHA-256
 ↓
POST /api/upload/check
 ↓
查询 D1
```

如果：

```text
exists = true
```

直接返回：

```json
{
  "success": true,
  "exists": true,
  "file": {
    "id": "...",
    "name": "test.png",
    "size": 123456,
    "content_type": "image/png",
    "url": "https://img.example.com/f/...",
    "markdown": "![test.png](https://img.example.com/f/...)"
  }
}
```

此时：

> 不重新上传。

如果不存在：

继续：

```text
POST /api/upload
```

==================================================
十八、Upload Check
===============

提供：

```http
POST /api/upload/check
```

JSON：

```json
{
  "sha256": "...",
  "size": 123456
}
```

必须要求：

* Session
* 或 API Token

不能允许匿名用户通过该 API 查询任意 SHA-256。

返回：

```json
{
  "success": true,
  "exists": false
}
```

或者：

```json
{
  "success": true,
  "exists": true,
  "file": {}
}
```

==================================================
十九、实际 Upload
============

提供：

```http
POST /api/upload
```

使用：

```text
multipart/form-data
```

字段：

```text
file
```

Header：

```text
X-File-SHA256
```

Worker 必须：

1. 验证认证
2. 检查文件大小
3. 检查 SHA-256 格式
4. 检查 D1 是否已有相同 SHA-256
5. 如果已有，直接返回已有记录
6. 如果没有，写入 R2
7. 写入 D1
8. 返回 URL

不能只依赖：

```text
/api/upload/check
```

因为两个客户端可能同时上传。

==================================================
二十、并发重复上传
=========

必须处理：

```text
A 上传同一个文件
B 同时上传同一个文件
```

都查到：

```text
D1 不存在
```

之后：

A：

```text
R2 f/SHA
D1 INSERT
```

B：

```text
R2 f/SHA
D1 INSERT
```

D1：

```text
sha256 UNIQUE
```

因此其中一个 INSERT 会冲突。

发生冲突时：

不要返回普通错误。

应该：

```text
重新查询 D1
    ↓
得到已有文件
    ↓
返回已有 URL
```

最终：

```text
R2：
只有一个对象

D1：
只有一条记录
```

==================================================
二十一、R2 Checksum
===============

上传 R2 时尽量使用 R2 当前 API 支持的 SHA-256 checksum。

逻辑：

```text
客户端 SHA-256
        ↓
Worker
        ↓
R2 checksum 校验
```

如果 R2 认为 checksum 不一致：

上传失败。

不要在代码中假设不存在的 workers-rs 方法。

必须根据当前 workers-rs 实际 API 实现。

==================================================
二十二、原始文件
========

必须：

> 用户上传什么，R2 保存什么。

禁止：

* 图片压缩
* JPEG 重编码
* PNG 重编码
* WebP 转码
* AVIF 转码
* 自动裁剪
* 自动缩放
* EXIF 修改
* ImageMagick
* Sharp

只修改：

```text
HTTP Metadata
Custom Metadata
```

不能修改文件本体。

==================================================
二十三、支持文件
========

图片：

```text
jpg
jpeg
png
gif
webp
avif
svg
bmp
ico
```

普通文件：

```text
txt
json
xml
css
js
mjs
html
pdf
zip
7z
```

特别支持：

```text
.user.js
```

例如：

```text
https://img.example.com/f/xxxxxxxx
```

可以直接访问 userscript。

==================================================
二十四、Content-Type
================

根据扩展名设置：

```text
.png       image/png
.jpg       image/jpeg
.jpeg      image/jpeg
.webp      image/webp
.gif       image/gif
.avif      image/avif
.svg       image/svg+xml
.js        application/javascript
.mjs       application/javascript
.user.js   application/javascript
.css       text/css
.json      application/json
.txt       text/plain
.pdf       application/pdf
.zip       application/zip
```

无法判断：

```text
application/octet-stream
```

不要盲目信任用户提交的 Content-Type。

至少结合文件扩展名。

==================================================
二十五、危险文件类型
==========

以下文件可能被浏览器执行：

```text
html
svg
js
mjs
user.js
```

因此：

```text
panel.example.com
```

和：

```text
img.example.com
```

必须是两个不同 Origin。

不要让用户上传的：

```text
.html
.svg
.js
.user.js
```

与后台管理页面处于相同 Origin。

==================================================
二十六、公共 URL
==========

格式：

```text
https://img.example.com/f/<sha256>
```

例如：

```text
https://img.example.com/f/4d2a7b...
```

不需要：

* 登录
* Cookie
* Session
* Turnstile
* API Token
* Authorization

图片应该直接由 R2 Custom Domain / Cloudflare CDN 提供。

不要通过：

```text
panel.example.com/api/file/...
```

读取图片。

==================================================
二十七、缓存
======

由于：

```text
R2 Key = SHA-256
```

对象内容是不可变的。

可以：

```http
Cache-Control: public, max-age=31536000, immutable
```

删除后旧 CDN 缓存可能短时间继续存在。

第一版不要实现复杂 CDN purge。

==================================================
二十八、上传大小
========

默认：

```text
50 MiB
```

作为单文件上传限制。

配置：

```text
MAX_UPLOAD_SIZE
```

前端检查。

后端必须再次检查。

不能只信任前端。

以后如果需要：

* 视频
* 大文件
* 超过 Worker 请求限制

再考虑 R2 Multipart Upload。

第一版不要实现复杂分片系统。

==================================================
二十九、批量上传
========

网页支持：

```text
multiple
```

多个文件。

油猴也支持多个文件。

并发控制：

```text
最多 3 个
```

不要无限同时上传。

结构：

```text
Queue
├── file1
├── file2
├── file3
├── file4
└── ...
```

同时最多三个任务。

==================================================
三十、上传失败重试
=========

上传失败：

最多重试：

```text
2 次
```

不要无限重试。

UI：

```text
上传失败
[重试]
```

==================================================
三十一、Web 上传界面
============

登录后首页就是上传。

不要复杂 Dashboard。

上传区域：

```text
┌─────────────────────────────┐
│                             │
│      拖拽文件到这里          │
│                             │
│      点击选择文件            │
│                             │
│      Ctrl + V 粘贴图片       │
│                             │
└─────────────────────────────┘
```

支持：

* 点击选择
* 拖拽
* Ctrl+V
* 多文件

==================================================
三十二、粘贴图片
========

监听：

```text
paste
```

获取：

```text
clipboardData
```

处理：

```text
image/*
```

流程：

```text
粘贴图片
 ↓
File
 ↓
SHA-256
 ↓
check
 ↓
重复：
   直接完成

新文件：
   upload
 ↓
生成 Markdown
```

不要把图片内容转换成 Base64 再上传。

直接使用 File / Blob。

==================================================
三十三、拖拽
======

支持：

```text
dragover
drop
```

必须：

```text
preventDefault()
```

取得：

```text
File[]
```

然后进入统一上传队列。

==================================================
三十四、上传状态
========

每个文件显示：

```text
文件名
大小
状态
```

状态例如：

```text
计算 Hash...
检查重复...
发现重复
上传中...
上传成功
上传失败
```

如果重复：

```text
检测到相同文件
跳过上传
```

这是重要体验。

==================================================
三十五、上传成功
========

显示：

```text
文件名
大小
URL
Markdown
```

按钮：

```text
复制 URL
复制 Markdown
打开
```

默认不要自动修改剪贴板。

只有用户点击：

```text
复制 URL
```

或：

```text
复制 Markdown
```

才写入 Clipboard。

==================================================
三十六、Markdown
============

图片：

```markdown
![filename](https://img.example.com/f/sha256)
```

普通文件：

```markdown
[filename](https://img.example.com/f/sha256)
```

不能默认把所有文件都变成：

```markdown
![...](...)
```

==================================================
三十七、文件列表
========

后台：

```text
我的文件
```

显示：

```text
缩略图 / 图标
文件名
类型
大小
上传时间
```

操作：

```text
复制 URL
复制 Markdown
打开
删除
```

图片显示缩略预览。

普通文件使用图标。

==================================================
三十八、文件搜索
========

提供：

```text
搜索文件名
```

D1：

```sql
WHERE original_name LIKE ?
```

必须使用 prepared statement。

第一版不需要 FTS。

==================================================
三十九、分页
======

不能一次把全部文件加载到前端。

使用：

```text
LIMIT
```

和：

```text
created_at DESC
```

提供：

```text
加载更多
```

或者：

```text
分页
```

选择最简单的方案。

==================================================
四十、删除
=====

提供：

```http
DELETE /api/files/:id
```

只允许 Session。

不能使用 API Token 删除。

流程：

```text
Session
 ↓
D1 查询
 ↓
取得 r2_key
 ↓
删除 R2
 ↓
删除 D1
```

如果文件不存在：

返回：

```text
404
```

不能让用户通过构造 URL 删除任意对象。

==================================================
四十一、API Token
=============

油猴脚本使用：

```http
X-API-Key: cph_xxxxxxxxx
```

Token 示例：

```text
cph_xxxxxxxxxxxxxxxxxxxx
```

Token 不能保存明文到 D1。

只保存：

```text
SHA-256(token)
```

==================================================
四十二、Token 管理
============

后台：

```text
API Token
```

支持：

```text
生成
查看元信息
撤销
```

生成 Token：

```text
名称：
Tampermonkey

[生成]
```

生成后：

```text
cph_xxxxxxxxxxxxx
```

只显示一次。

不要再次显示完整 Token。

D1：

```text
token_hash
```

保存。

==================================================
四十三、Token 上传
============

油猴：

```http
X-API-Key: cph_xxx
```

Worker：

```text
SHA-256(Token)
 ↓
D1
 ↓
revoked_at IS NULL
```

成功：

允许：

```text
upload
upload/check
```

不允许：

```text
delete
token management
admin settings
```

Token 认证不依赖 Cookie。

==================================================
四十四、Token last_used_at
======================

可以更新：

```text
last_used_at
```

但不要每次上传都产生大量 D1 更新。

可以限制：

```text
同一个 Token 每小时最多更新一次
```

个人项目优先简单。

==================================================
四十五、油猴脚本
========

提供：

```text
userscript/image-uploader.user.ts
```

以及编译后的：

```text
userscript/image-uploader.user.js
```

必须参考用户现有 NodeImage 上传助手的交互设计。

需要支持：

1. Ctrl+V
2. 拖拽
3. 文件选择
4. 多文件
5. 上传状态
6. 自动重试
7. API Token
8. SHA-256
9. 重复检测
10. 获取 URL
11. 生成 Markdown
12. 自动插入 Markdown

==================================================
四十六、油猴 Metadata
===============

包括：

```text
// ==UserScript==
// @name
// @namespace
// @version
// @description
// @match
// @grant GM_xmlhttpRequest
// @grant GM_getValue
// @grant GM_setValue
// @grant GM_addStyle
// @connect
// ==/UserScript==
```

Token 使用：

```text
GM_getValue
GM_setValue
```

不要保存到当前网页：

```text
localStorage
```

不要：

```text
@connect *
```

只连接：

```text
panel.example.com
```

==================================================
四十七、油猴 API 地址
=============

脚本配置：

```text
API URL
API Token
```

例如：

```text
API URL:
https://panel.example.com

API Token:
cph_xxxxxxxxx
```

可以提供简单的设置弹窗。

不要做复杂设置系统。

==================================================
四十八、TypeScript 类型
=================

开启：

```text
strict
```

尽量避免：

```text
any
```

定义：

```ts
interface FileInfo {
    id: string;
    sha256: string;
    name: string;
    contentType: string;
    size: number;
    url: string;
    markdown: string;
    createdAt: number;
}
```

还需要：

```ts
interface UploadResult
interface DuplicateCheckResult
interface ApiToken
interface ApiResponse<T>
```

前后端 JSON 结构保持一致。

==================================================
四十九、API 路由
==========

至少：

```http
GET  /
GET  /login

POST /api/login
POST /api/logout

POST /api/upload/check
POST /api/upload

GET  /api/files
GET  /api/files/:id

DELETE /api/files/:id

GET  /api/tokens
POST /api/tokens
DELETE /api/tokens/:id
```

不要加入无意义 API。

==================================================
五十、API 错误
=========

统一 JSON：

```json
{
    "success": false,
    "error": "unauthorized"
}
```

合理使用：

```text
400
401
403
404
413
415
429
500
```

不要所有错误都返回 HTTP 200。

==================================================
五十一、安全
======

必须处理：

1. Turnstile 服务端验证
2. Session 签名
3. HttpOnly
4. Secure
5. SameSite
6. API Token Hash
7. SHA-256
8. 文件大小限制
9. MIME 判断
10. 路径校验
11. SQL 参数绑定
12. Origin 检查
13. HTML 转义
14. Markdown 转义
15. panel/img 域名隔离

==================================================
五十二、CSRF
========

使用 Session Cookie 的：

```text
POST
DELETE
```

请求必须检查：

```text
Origin
```

允许：

```text
https://panel.example.com
```

API Token 请求不依赖 Cookie。

==================================================
五十三、SQL 注入
==========

所有用户输入：

必须使用：

```text
prepared statement
```

禁止：

```text
字符串拼接 SQL
```

==================================================
五十四、文件名
=======

原始文件名保存：

```text
original_name
```

R2 Key 绝不使用文件名。

支持中文文件名。

HTML 输出必须转义。

Markdown 中如果文件名存在特殊字符：

进行必要转义。

==================================================
五十五、路径校验
========

公开 URL：

```text
/f/<sha256>
```

sha256 必须严格检查：

```text
64 个十六进制字符
```

拒绝：

```text
../
..\
/
\
任意其他路径
```

==================================================
五十六、R2 Public Bucket
====================

公开文件 Bucket：

```text
personal-image-host
```

配置：

```text
img.example.com
```

只提供：

```text
/f/<sha256>
```

不允许 Worker Admin API 直接通过公共 URL 执行任何管理操作。

==================================================
五十七、静态前端
========

使用 Cloudflare Workers Static Assets。

前端：

```text
dist/
```

API：

```text
/api/*
```

不要让：

```text
/api/*
```

被 SPA fallback 吞掉。

==================================================
五十八、页面
======

至少：

```text
/login
/
```

登录：

```text
密码
Turnstile
登录
```

后台：

```text
上传
文件
API Token
退出
```

不需要：

```text
复杂 Dashboard
统计图
用户中心
通知系统
国际化
插件系统
多主题系统
```

==================================================
五十九、UI
======

保持：

* 简洁
* 现代
* 轻量

支持：

```text
浅色
深色
```

使用 CSS Variables。

不要使用 UI Framework。

==================================================
六十、最核心：每日 D1 自动备份
=================

增加：

```text
Cloudflare Cron Trigger
```

每天自动运行一次。

建议：

```text
0 4 * * *
```

即：

```text
04:00 UTC
```

台湾时间：

```text
12:00
```

由 Rust Worker 的：

```text
scheduled()
```

处理。

不要再引入 KV。

不要再引入 Queue。

不要为了这个备份功能单独创建一个新的后端服务。

==================================================
六十一、备份目标
========

每天：

```text
D1
 ↓
SQL Export
 ↓
私有 R2
 ↓
d1/latest.sql
```

始终只保留：

```text
d1/latest.sql
```

不保留：

```text
历史备份
日期备份
备份列表
备份数据库记录
```

==================================================
六十二、D1 Export
=============

不要自己：

```text
SELECT *
```

然后拼装 SQL。

必须优先使用 Cloudflare 官方 D1 Export API。

流程：

```text
POST
/accounts/{account_id}/d1/database/{database_id}/export
```

获得：

```text
Export Job
```

然后持续查询 Export 状态。

直到：

```text
ready
```

获得 SQL 下载 URL。

==================================================
六十三、Cloudflare API Token
========================

D1 Export API 需要 Cloudflare API Token。

配置：

```text
CLOUDFLARE_API_TOKEN
```

必须是 Worker Secret。

不能：

```text
写入源码
写入 Git
放入前端
放入 wrangler.toml 明文
```

还需要：

```text
ACCOUNT_ID
DATABASE_ID
```

使用 Worker 配置变量。

API Token 必须遵循最小权限原则，只用于必要的 D1 Export 操作。

README 必须说明如何创建。

==================================================
六十四、备份流程
========

完整流程：

```text
Cron
 ↓
scheduled()
 ↓
读取 ACCOUNT_ID
读取 DATABASE_ID
 ↓
调用 D1 Export API
 ↓
得到 Export Job
 ↓
轮询 Export Job
 ↓
ready
 ↓
获得 SQL 下载 URL
 ↓
下载 SQL
 ↓
校验 HTTP 状态
 ↓
写入私有 R2
 ↓
d1/latest.sql
 ↓
成功
```

任何一个阶段失败：

```text
本次备份失败
```

但：

```text
旧 latest.sql
```

必须继续保留。

==================================================
六十五、非常重要：不要破坏旧备份
================

如果当前：

```text
d1/latest.sql
```

已经存在。

当天备份失败：

```text
绝对不能删除旧 latest.sql
```

例如：

```text
旧备份：
d1/latest.sql

今天：
Export 失败

结果：
d1/latest.sql
仍然存在
```

只有当：

```text
新 D1 Export
+
SQL 下载
+
R2 上传
```

全部成功之后，才覆盖：

```text
d1/latest.sql
```

==================================================
六十六、备份写入
========

推荐：

```text
d1/.tmp/latest-<random>.sql
```

先写临时对象。

全部成功后：

```text
d1/latest.sql
```

再进行替换。

如果当前 R2 API 支持直接复制对象：

可以：

```text
tmp
 ↓
copy
 ↓
latest.sql
```

如果当前 workers-rs 版本更适合直接 PUT：

可以直接写：

```text
latest.sql
```

因为 R2 对象级写入完成后才替换对象。

必须保证：

> 不要因为中途失败导致 `latest.sql` 被提前清空。

如果使用临时对象：

成功后删除临时对象。

最终 Backup Bucket：

```text
d1/latest.sql
```

只有一个有效备份。

==================================================
六十七、只保留最新备份
===========

上传成功后：

删除：

```text
d1/.tmp/*
```

不要删除：

```text
d1/latest.sql
```

不要生成：

```text
d1/2026/
d1/history/
d1/archive/
```

最终 Bucket：

```text
d1/latest.sql
```

==================================================
六十八、备份 Content-Type
===================

设置：

```text
Content-Type: application/sql
```

Metadata 可以：

```text
backup_type=d1
format=sql
```

如果后续实现 gzip：

再使用：

```text
application/gzip
```

第一版不要求 gzip。

==================================================
六十九、备份完整性
=========

下载 SQL 后：

计算：

```text
SHA-256
```

可以把 SHA-256：

写入 R2 Custom Metadata。

例如：

```text
backup_sha256=<hash>
backup_at=<timestamp>
```

这样以后管理员可以检查备份完整性。

==================================================
七十、备份大小
=======

不要无必要把整个 SQL 文件读取成巨大的 String。

尽量使用流式：

```text
HTTP response body
 ↓
R2 put
```

按照当前 workers-rs 的真实 API 实现。

如果当前 workers-rs R2 写入接口需要特定方式：

使用当前官方支持的流式写入方式。

不要为了简单把任意大小的备份一次性复制很多份到内存。

==================================================
七十一、Export Polling
==================

Export 不是立即完成。

必须：

```text
create export
 ↓
poll
 ↓
等待
 ↓
poll
 ↓
ready
```

轮询间隔建议：

```text
5 秒
```

或当前官方建议值。

必须设置最大轮询时间。

例如：

```text
10 分钟
```

超过：

```text
backup failed
```

不要无限等待。

==================================================
七十二、失败重试
========

整个每日备份任务：

最多自动重试：

```text
3 次
```

例如：

```text
第一次失败
 ↓
等待
 ↓
第二次
 ↓
等待
 ↓
第三次
```

第三次失败：

```text
保持旧 latest.sql
```

不要继续无限运行。

==================================================
七十三、备份日志
========

日志只记录必要信息：

```text
D1 backup started
D1 export started
D1 export polling
D1 backup uploaded
D1 backup failed
```

不能打印：

```text
ADMIN_PASSWORD
SESSION_SECRET
CLOUDFLARE_API_TOKEN
API Token
Session Cookie
TURNSTILE_SECRET
```

可以记录：

```text
backup size
backup sha256
timestamp
```

不要输出敏感 Secret。

==================================================
七十四、管理后台不要做备份历史
===============

因为只保留一个备份。

设置页简单显示：

```text
D1 Backup

状态：
正常 / 失败

最近备份：
2026-09-27 04:00 UTC

备份大小：
123 KB

SHA-256：
xxxxxxxx
```

不需要：

```text
历史备份列表
备份日期选择
删除旧备份
恢复点列表
```

因为根本没有历史备份。

==================================================
七十五、管理后台下载最新备份
==============

可以提供：

```text
[下载最新备份]
```

接口：

```http
GET /api/backup/latest
```

必须要求：

```text
Session
```

流程：

```text
Session
 ↓
读取私有 Backup R2
 ↓
返回 d1/latest.sql
```

或者使用当前合适的私有 R2 下载方案。

绝对不能直接把 Backup Bucket 设置成公开。

==================================================
七十六、备份恢复
========

第一版：

不需要网页一键恢复。

但是 README 必须写清：

```text
如何下载 latest.sql
如何使用 Wrangler / D1 import 恢复
```

恢复前：

建议先恢复到：

```text
新 D1 Database
```

确认没有问题后再切换生产数据库。

不要做危险的：

```text
Web 页面一键覆盖生产数据库
```

==================================================
七十七、D1 Time Travel
==================

README 中说明：

D1 本身有 Time Travel。

本项目 R2 Backup 用于：

```text
独立的最新 SQL 备份
```

不是替代 Time Travel。

Time Travel：

```text
短期恢复
```

R2：

```text
独立持久备份
```

因为本项目只要求最新备份：

```text
d1/latest.sql
```

即可。

==================================================
七十八、文件删除
========

删除图片：

```text
D1
+
R2
```

一起删除。

如果删除：

```text
f/<sha256>
```

同时删除：

```text
D1 files
```

以后重新上传：

```text
同样内容
```

会重新创建：

```text
f/<sha256>
```

所以 URL 可以保持一致。

==================================================
七十九、HTTP Cache
==============

公共图片：

```http
Cache-Control:
public, max-age=31536000, immutable
```

因为：

```text
R2 Key = SHA-256
```

不会发生“同一 URL 内容改变”的问题。

==================================================
八十、D1 查询
========

所有用户输入：

必须参数绑定。

包括：

* 搜索
* ID
* 文件名
* Token

禁止 SQL 字符串拼接。

==================================================
八十一、前端安全
========

HTML：

必须转义。

文件名：

不能直接作为 HTML。

Markdown：

必须进行适当转义。

不能允许文件名破坏页面结构。

==================================================
八十二、CORS
========

管理后台和 API 使用同源：

```text
panel.example.com
```

不要默认：

```text
Access-Control-Allow-Origin: *
```

尤其不要让任何网页随意使用 Cookie Session API。

油猴使用：

```text
GM_xmlhttpRequest
```

调用 API。

==================================================
八十三、前端构建
========

提供：

```text
package.json
```

使用：

```text
TypeScript
esbuild
```

例如：

```text
pnpm build
```

完成：

```text
frontend TypeScript
    ↓
dist
```

并准备好最终部署。

==================================================
八十四、Rust 编译
===========

Cargo：

```toml
[profile.release]
lto = true
strip = true
codegen-units = 1
opt-level = "s"
```

支持：

```bash
rustup target add wasm32-unknown-unknown
```

使用：

```text
worker-build
```

编译。

==================================================
八十五、Rust 入口
===========

Rust Worker 至少支持：

```text
fetch
scheduled
```

HTTP：

```text
fetch
```

定时：

```text
scheduled
```

Cron：

```text
0 4 * * *
```

只用于：

```text
D1 → R2 latest.sql
```

不要把图片访问放到 scheduled。

==================================================
八十六、Cron 测试
===========

必须提供本地测试方法。

说明如何通过 Wrangler 本地触发：

```text
scheduled
```

并验证：

```text
backup function
```

不要要求真实线上 Cron 才能测试代码。

==================================================
八十七、备份配置
========

wrangler 中：

公开 R2：

```text
BUCKET
```

备份 R2：

```text
BACKUP_BUCKET
```

D1：

```text
DB
```

例如概念：

```toml
[[r2_buckets]]
binding = "BUCKET"
bucket_name = "personal-image-host"

[[r2_buckets]]
binding = "BACKUP_BUCKET"
bucket_name = "personal-image-host-backup"

[[d1_databases]]
binding = "DB"
database_name = "personal-image-host"
database_id = "YOUR_DATABASE_ID"
```

必须根据当前 Wrangler 配置格式输出真正可用版本。

==================================================
八十八、Secret
==========

README 至少包含：

```bash
wrangler secret put ADMIN_PASSWORD
wrangler secret put SESSION_SECRET
wrangler secret put TURNSTILE_SECRET
wrangler secret put CLOUDFLARE_API_TOKEN
```

不能在：

```text
wrangler.toml
```

写 Secret 明文。

==================================================
八十九、变量
======

配置：

```text
ACCOUNT_ID
DATABASE_ID
MAX_UPLOAD_SIZE
PUBLIC_BASE_URL
```

其中：

```text
PUBLIC_BASE_URL
=
https://img.example.com
```

不要把：

```text
CLOUDFLARE_API_TOKEN
TURNSTILE_SECRET
ADMIN_PASSWORD
SESSION_SECRET
```

作为普通公开变量。

==================================================
九十、部署
=====

README 必须说明：

1. 安装 Rust
2. 安装 wasm32
3. 安装 Node/pnpm
4. 安装 Wrangler
5. 创建图片 R2
6. 创建 Backup R2
7. 创建 D1
8. 执行 Migration
9. 创建 Turnstile
10. 配置 Secrets
11. 修改域名
12. 配置 R2 Custom Domain
13. 部署 Worker
14. 验证登录
15. 验证上传
16. 验证去重
17. 验证公共 URL
18. 验证自动备份

==================================================
九十一、R2 创建
=========

README 提供：

```bash
wrangler r2 bucket create personal-image-host
```

以及：

```bash
wrangler r2 bucket create personal-image-host-backup
```

其中：

```text
personal-image-host
```

用于公开图片。

```text
personal-image-host-backup
```

用于私有备份。

==================================================
九十二、D1 创建
=========

README：

```bash
wrangler d1 create personal-image-host
```

然后：

```bash
wrangler d1 migrations apply personal-image-host --remote
```

如果当前 Wrangler 命令有所变化：

使用当前官方命令。

==================================================
九十三、Turnstile 配置
================

README 写明：

创建 Turnstile Widget。

绑定：

```text
panel.example.com
```

得到：

```text
Site Key
Secret Key
```

Site Key：

可以放到前端。

Secret：

必须：

```text
wrangler secret put TURNSTILE_SECRET
```

==================================================
九十四、API Token
=============

README：

后台登录后：

```text
API Token
 ↓
生成
 ↓
复制
```

油猴：

```text
API URL
API Token
```

保存。

==================================================
九十五、测试用例
========

必须至少测试：

1. 错误密码
2. 正确密码
3. Turnstile 失败
4. 未登录上传
5. 登录上传
6. 粘贴图片
7. 拖拽图片
8. 批量上传
9. 普通文件
10. `.user.js`
11. API Token 上传
12. 重复文件
13. 并发重复文件
14. 删除
15. 搜索
16. 文件列表
17. Markdown
18. 公共 URL
19. 超大文件
20. 非法 SHA-256
21. 非法路径
22. SQL 参数绑定
23. 备份 Cron
24. D1 Export
25. latest.sql
26. 备份失败后旧 latest.sql 仍存在
27. 新备份成功后 latest.sql 被更新
28. Backup Bucket 无公共访问

==================================================
九十六、去重验收
========

测试：

```text
test.png
```

第一次：

```text
SHA=A
```

结果：

```text
R2:
f/A

D1:
sha256=A
```

第二次：

```text
同一个 test.png
```

结果：

```text
D1:
找到 A

R2:
不再新增对象

返回：
同一个 URL
```

==================================================
九十七、并发去重验收
==========

同时上传：

```text
A.png
B.png
```

如果内容完全相同：

结果必须：

```text
R2:
一个对象

D1:
一条记录

两个上传请求：
返回同一个 URL
```

==================================================
九十八、备份验收
========

每天：

```text
04:00 UTC
```

自动：

```text
D1
 ↓
Export API
 ↓
Polling
 ↓
SQL
 ↓
Backup R2
 ↓
d1/latest.sql
```

如果成功：

```text
latest.sql
=
最新 D1
```

如果失败：

```text
旧 latest.sql
继续保留
```

绝对不能：

```text
失败
 ↓
删除 latest.sql
```

==================================================
九十九、Backup Bucket 最终状态
======================

正常情况下：

```text
personal-image-host-backup
└── d1/
    └── latest.sql
```

只保留：

```text
1 个备份文件
```

不要：

```text
历史备份
日期文件
备份日志文件
```

==================================================
一百、不要加入的东西
==========

禁止为了这个项目加入：

* KV
* Redis
* Queue
* Durable Objects
* PostgreSQL
* MySQL
* React
* Vue
* Next.js
* Tailwind
* Bootstrap
* Axum
* Actix
* Docker 必需依赖
* Kubernetes
* 微服务
* OAuth
* 邮件服务
* 注册
* 多用户
* 多租户
* 复杂 RBAC
* 插件系统
* 图片 AI
* 图片转码
* 图片压缩
* ImageMagick
* Sharp
* 一键生产库恢复
* 备份历史系统

==================================================
一百零一、代码质量
=========

Rust：

* Rust 2024 edition
* 清晰
* 简洁
* 少依赖
* wasm 兼容
* 不过度抽象
* 不写无意义 trait
* 不写复杂依赖注入
* 错误处理清晰

TypeScript：

* strict
* 尽量不用 any
* 类型明确
* 原生 API
* 模块化
* 不用大型框架

==================================================
一百零二、当前 Cloudflare API
======================

非常重要：

不要根据旧教程猜 API。

实现时优先依据当前 Cloudflare 官方文档和当前 workers-rs API。

特别检查：

1. R2 Binding
2. D1 Binding
3. R2 put
4. R2 checksum
5. D1 prepared statement
6. Cron scheduled()
7. D1 Export REST API
8. Wrangler 配置格式
9. Workers Static Assets

如果当前 workers-rs API 与 JavaScript API 的名称不同：

使用真实 Rust API。

不要输出无法编译的伪 API。

==================================================
一百零三、README
===========

必须提供完整：

```text
项目介绍
架构
安装
开发
构建
部署
R2
D1
Turnstile
Secrets
域名
API
油猴
SHA-256 去重
备份
恢复
测试
```

特别说明：

```text
D1 Backup
=
每天自动一次
=
只保留 latest.sql
```

==================================================
一百零四、最终项目体验
===========

浏览器：

```text
打开 panel.example.com
        ↓
密码 + Turnstile
        ↓
进入上传页
        ↓
Ctrl + V
        ↓
计算 SHA-256
        ↓
D1 查重
        │
        ├── 已存在
        │      ↓
        │   直接返回 URL
        │
        └── 不存在
               ↓
            R2 上传
               ↓
            D1 记录
               ↓
            返回 URL
               ↓
         复制 Markdown
```

最终 Markdown：

```markdown
![image.png](https://img.example.com/f/xxxxxxxxxxxxxxxxxxxxxxxx)
```

任何网站：

```text
直接访问 img.example.com
```

不需要登录。

每天：

```text
D1
 ↓
SQL Export
 ↓
private R2
 ↓
d1/latest.sql
```

只有一个最新备份。

==================================================
一百零五、最终交付要求
===========

不要只提供：

```text
架构
伪代码
核心代码
部分文件
```

必须给出完整：

```text
Cargo.toml
wrangler.toml
package.json
tsconfig.json

migrations/0001_init.sql

全部 Rust 源码
全部 TypeScript 源码
HTML
CSS
油猴 TypeScript
编译后的 userscript

README.md
```

不要写：

```text
这里省略...
```

不要写：

```text
其余代码类似...
```

不要使用伪代码代替实现。

所有 API 必须真正实现。

所有文件必须可以拼成一个实际项目。

==================================================
一百零六、最终验收清单
===========

必须全部满足：

[ ] Rust Worker 可以编译

[ ] WebAssembly 构建正常

[ ] Wrangler 部署正常

[ ] R2 图片 Bucket 正常

[ ] R2 Backup Bucket 正常

[ ] D1 正常

[ ] 静态前端正常

[ ] 登录正常

[ ] Turnstile 正常

[ ] Session 正常

[ ] Logout 正常

[ ] 上传正常

[ ] 粘贴上传正常

[ ] 拖拽上传正常

[ ] 批量上传正常

[ ] 原图不修改

[ ] MIME 正常

[ ] SHA-256 正常

[ ] 重复上传跳过

[ ] 并发重复上传正确处理

[ ] API Token 正常

[ ] `.user.js` 上传正常

[ ] `.user.js` 公共访问正常

[ ] 文件列表正常

[ ] 搜索正常

[ ] 删除正常

[ ] URL 正常

[ ] Markdown 正常

[ ] 公共 URL 不需要认证

[ ] 公共 URL 不经过管理 API

[ ] Backup Bucket 私有

[ ] Cron 每天自动运行

[ ] D1 Export 正常

[ ] Export Job 正确轮询

[ ] 最新 SQL 正常写入 R2

[ ] 只存在 latest.sql

[ ] 新备份成功才覆盖 latest.sql

[ ] 新备份失败不会破坏旧 latest.sql

[ ] Backup 下载需要管理员 Session

[ ] Cloudflare API Token 使用 Secret

[ ] 所有 SQL 参数绑定

[ ] 没有明显路径穿越

[ ] 没有明显 XSS

[ ] 没有明显 CSRF

[ ] 不引入 KV

[ ] 不引入 Redis

[ ] 不引入 Queue

[ ] 不引入 Durable Objects

==================================================
一百零七、最终原则
=========

项目必须遵守：

> 简单优先。

> R2 保存文件。

> D1 保存文件信息和去重索引。

> Rust Worker 处理所有后台逻辑。

> TypeScript 只负责前端和油猴。

> 图片访问完全公开。

> 上传和管理必须认证。

> SHA-256 内容寻址保证重复文件只存一份。

> 每天自动备份 D1。

> R2 Backup 只保留一个 latest.sql。

> 不为了“看起来企业级”加入无必要的 Cloudflare 服务。

最终系统保持：

```text
Rust Worker
├── R2
├── D1
└── Cron scheduled()

TypeScript
├── Web UI
└── Userscript
```

这就是最终架构。

请直接开始实现完整项目。

