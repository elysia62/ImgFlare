# 手工测试步骤

> 部署完成后按顺序执行，每一条都给出**操作**和**期望结果**。
> 带 ⚠️ 的条目是安全相关的，必须确认。

## 0. 先跑自动化检查

下面这些不需要真实部署，本地几秒钟就能跑完。**它们通过之后再动手做后面的手工验证**——能省掉大量在浏览器和 curl 之间来回折腾的时间。

```bash
bun run verify          # 类型检查 + API 契约检查 + 全量构建
```

其中 `verify` 包含两道专门用来拦住「两边都能编译、但运行时会坏」的检查：

```bash
bun run check:contract  # Rust 序列化字段 vs TypeScript interface 字段
```

构建过程中还会校验 `dist/` 里每个 HTML 引用的本地资源确实存在（防止打包产物改名后页面静默失去交互）。

<details>
<summary>这两道检查分别防的是什么（点开看原因）</summary>

**契约检查**：Rust 用 serde、TypeScript 手写 interface，没有机制保证两边字段名一致。`created_at` vs `createdAt` 两边都能编译，但前端拿到 `undefined`，严重时抛异常。

想亲眼确认这道检查有效，可以临时删掉某个结构体上的 `#[serde(rename_all = "camelCase")]`，再跑 `bun run check:contract`，它会明确指出哪几个字段对不上并让退出码变成 1。

**资源引用校验**：`frontend/*.html` 里是 `<script src="/main.js">`。如果产物改名成 `app.js`，`tsc` 通过、构建通过、部署通过，但浏览器 404 掉打包结果，页面完全没有交互。这道检查会在构建期直接失败。

</details>

---

准备工作：把下面换成你的真实地址。只有一个域名。

```bash
ORIGIN=https://imgflare.xxx.workers.dev
```

---

## 1. 错误密码

```bash
curl -i -X POST "$ORIGIN/api/login" \
  -H 'Content-Type: application/json' \
  -H "Origin: $ORIGIN" \
  -d '{"username":"admin","password":"definitely-wrong","cf-turnstile-response":"<有效token>"}'
```

**期望**：`HTTP/1.1 401`，响应体 `{"success":false,"error":"unauthorized"}`，**没有** `Set-Cookie`。

---

## 2. 正确凭据

用浏览器打开 `$ORIGIN/login`，完成 Turnstile，输入正确的用户名与密码并提交。

**期望**：
- 跳转到 `/`
- 响应头包含 `Set-Cookie: pih_session=...; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`

⚠️ 在 DevTools 的 Application → Cookies 里确认 `HttpOnly` 和 `Secure` 都已勾选。

---

## 3. Turnstile 失败

```bash
curl -i -X POST "$ORIGIN/api/login" \
  -H 'Content-Type: application/json' \
  -H "Origin: $ORIGIN" \
  -d '{"username":"admin","password":"<正确密码>","cf-turnstile-response":"obviously-invalid"}'
```

**期望**：`HTTP/1.1 403`，`{"success":false,"error":"turnstile_failed"}`。

⚠️ 关键是：**密码正确也不放行**。这证明 Turnstile 确实在服务端校验，而不是前端摆设。

---

## 4. 登录限流

连续用错误密码请求 8 次以上：

```bash
for i in $(seq 1 10); do
  curl -s -o /dev/null -w "$i -> %{http_code}\n" -X POST "$ORIGIN/api/login" \
    -H 'Content-Type: application/json' -H "Origin: $ORIGIN" \
    -d '{"username":"admin","password":"bad","cf-turnstile-response":"<有效token>"}'
done
```

**期望**：前 8 次 `401`，之后 `429` + `{"success":false,"error":"too_many_attempts"}`。

⚠️ 用**正确**密码登录一次后，计数应清零，可立即再次登录。

---

## 5. 未登录访问面板

```bash
curl -i "$ORIGIN/"
curl -i "$ORIGIN/index.html"
```

**期望**：两个都返回 `HTTP/1.1 302`，`Location: /login`，`Cache-Control: no-store`，
**不包含任何面板 HTML**。

登录后再访问：应返回 `200` 且带 `Content-Security-Policy`。

---

## 6. 未登录上传

```bash
curl -i -X POST "$ORIGIN/api/upload" -F "file=@test.png"
```

**期望**：`HTTP/1.1 401`。

---

## 7. 登录上传

用浏览器完成后，在后台拖入一个 PNG。

**期望**：队列显示"上传中…"→"上传成功"，返回 URL 和 Markdown。

用 curl 验证（先导出 Cookie）：

```bash
curl -X POST "$ORIGIN/api/upload" \
  -b cookies.txt \
  -H "Origin: $ORIGIN" \
  -H "X-File-SHA256: $(sha256sum test.png | cut -d' ' -f1)" \
  -F "file=@test.png"
```

**期望**：`{"success":true,"deduplicated":false,"file":{...}}`。

---

## 8. 粘贴图片

在后台页面按 `Ctrl+V`，剪贴板里先复制一张截图。

**期望**：
- 文件名为 `pasted-<时间戳>.png`
- `content_type` 为 `image/png`
- Markdown 形如 `![pasted-20260927-120000.png](https://<你的域名>/i/...)`

---

## 9. 拖拽图片

把一张图片从文件管理器拖进上传区。

**期望**：行为与粘贴一致，且**浏览器没有导航离开页面**（说明 `preventDefault` 生效）。

---

## 10. 批量上传

一次选中 5 个以上文件拖入。

**期望**：
- 队列全部出现
- 同时处于"上传中"的最多 3 个
- 全部完成后每个都有独立的 URL

---

## 11. 非图片被拒绝

上传一个 PDF、`.html` 或把 HTML 改名为 `x.png`。

**期望**：上传返回 `HTTP 415`，`{"success":false,"error":"unsupported_file_type"}`。不会写入 R2。

如果对象的类型不是图片，公开地址 `/i/<hash>` 返回 **404**，不返回文件内容。

---

## 13. API Token 上传

后台 → API Token → 生成 → 复制 `cph_...`。

```bash
curl -X POST "$ORIGIN/api/upload" \
  -H "X-API-Key: cph_xxx" \
  -H "X-File-SHA256: $(sha256sum test.png | cut -d' ' -f1)" \
  -F "file=@test.png"
```

**期望**：`HTTP 200`，成功返回。

---

## 14. ⚠️ Token 不能删除文件

```bash
curl -i -X DELETE "$ORIGIN/api/files/<某个id>" -H "X-API-Key: cph_xxx"
```

**期望**：`HTTP/1.1 403`，`{"success":false,"error":"admin_only"}`。

这验证了权限边界：**Token 只能上传，不能删除**。

---

## 15. 重复文件

同一个文件上传两次。

**期望**：
- 第二次队列显示"检测到相同文件，已跳过上传"
- 返回的 URL 与第一次**完全相同**
- 后台文件列表里仍然只有 1 条记录

```bash
# 用 check 接口直接验证
SHA=$(sha256sum test.png | cut -d' ' -f1)
curl -X POST "$ORIGIN/api/upload/check" \
  -H "X-API-Key: cph_xxx" -H 'Content-Type: application/json' \
  -d "{\"sha256\":\"$SHA\",\"size\":$(stat -c%s test.png)}"
# {"success":true,"exists":true,"file":{...}}
```

---

## 16. 并发重复文件

复制同一个文件成 `A.png` 和 `B.png`，同时上传：

```bash
SHA=$(sha256sum A.png | cut -d' ' -f1)
for f in A.png B.png; do
  curl -s -X POST "$ORIGIN/api/upload" \
    -H "X-API-Key: cph_xxx" -H "X-File-SHA256: $SHA" \
    -F "file=@$f" &
done
wait
```

**期望**：
- 两个请求都返回 `success: true`
- 两者返回**同一个 URL**
- D1 中只有一条记录：
  ```bash
  bunx wrangler d1 execute imgflare-db --remote \
    --command "SELECT COUNT(*) FROM files WHERE sha256='$SHA'"
  # 1
  ```
- R2 中只有一个对象 `i/<sha256>`

---

## 17. 删除

后台点某个文件的「删除」并确认。

**期望**：
- 列表里消失
- `$ORIGIN/i/<sha256>` 返回 404
- D1 记录消失

⚠️ 再重新上传同一个文件，**URL 应该和之前一样**（因为 key 由内容决定）。

---

## 18. 搜索

在后台搜索框输入文件名的一部分。

**期望**：只显示匹配的文件，且是服务端过滤（Network 里能看到 `?q=` 请求）。

---

## 19. 分页

上传 30 个以上文件。

**期望**：
- 首屏只加载 24 个（默认 `PAGE_SIZE`）
- 出现"加载更多（还有 N 个）"
- 点击后追加一页，而**不是**一次性加载全部

---

## 20. 公共 URL 免认证

```bash
# 完全不带任何凭据
curl -i "$ORIGIN/i/<sha256>"
```

**期望**：`HTTP/1.1 200`，返回文件内容，响应头包含：

```http
cache-control: public, max-age=31536000, immutable
x-content-type-options: nosniff
```

⚠️ 同时确认：不带 Cookie、不带 `X-API-Key`、不经过 `$ORIGIN/api/...`。

图片 URL 直接贴进任意 Markdown 渲染器都应该正常显示。

非图片不能上传，见第 11 节。

---

## 21. 超大文件

生成一个超过 50 MB 的文件：

```bash
dd if=/dev/urandom of=big.bin bs=1M count=60
```

尝试上传。

**期望**：
- 前端直接拒绝（文件超过大小限制）
- 用 curl 绕过前端时，服务端返回 `HTTP 413`，`file_too_large`

⚠️ 服务端必须独立校验，不能只信前端。

---

## 22. 非法 SHA-256

```bash
curl -i -X POST "$ORIGIN/api/upload/check" \
  -H "X-API-Key: cph_xxx" -H 'Content-Type: application/json' \
  -d '{"sha256":"not-a-hash","size":1}'
```

**期望**：`HTTP 400`，`invalid_sha256`。

也试试 64 个字符但含非十六进制字符（如 `zzzz...`）—— 同样应为 400。

---

## 23. 路径穿越

```bash
curl -i "$ORIGIN/i/../../../etc/passwd"
curl -i "$ORIGIN/i/..%2f..%2fsecret"
curl -i "$ORIGIN/api/files/..%2f..%2fetc"
```

**期望**：全部 404 或 400，**不会**命中任何对象。

⚠️ 公开路径只接受严格的 64 位十六进制 SHA-256。

---

## 24. SQL 参数绑定

在后台搜索框输入：

```text
' OR 1=1 --
```

**期望**：
- 没有返回全部文件
- 没有数据库错误
- 只当作普通字符串搜索

也可以尝试 `%` 和 `_` —— 它们应被转义为字面量，而不是通配符。

---

## 25. 备份 Cron

```bash
bunx wrangler dev --test-scheduled
# 另一个终端
curl "http://localhost:8787/__scheduled?cron=0+4+*+*+*"
```

**期望**：Worker 日志出现

```text
D1 backup started
D1 export started
D1 export polling
D1 backup uploaded (size=... sha256=... at=...)
```

线上也可以直接点后台「立即备份」，走同一套代码路径。

---

## 26. D1 dump

`dump()` 走的是 D1 binding 自带的导出，不需要任何 Cloudflare API Token。

**期望**：日志出现 `D1 backup started` 与 `D1 backup uploaded (size=... sha256=...)`。

**若失败**，检查 Logs 里的具体错误（`ApiError` 的详细原因只写日志、不返回给客户端）。

> 本地 `wrangler dev` 下 `dump()` 固定返回 404 —— miniflare 未实现 D1 导出。
> 这一条必须在线上验证。

---

## 27. `latest.sql`

```bash
aws s3 cp s3://$R2_BUCKET/back/latest.sql check.sql \
  --endpoint-url https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com
head -20 check.sql
```

**期望**：是合法的 SQL 转储，能看到 `CREATE TABLE files` 等语句。

---

## 28. ⚠️ 备份失败后旧备份仍在

这是最关键的一条。

1. 先确认已有备份：
   ```bash
   aws s3 cp s3://$R2_BUCKET/back/latest.sql before.sql \
     --endpoint-url https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com
   sha256sum before.sql
   ```

2. 故意让备份失败 —— 把 `R2_BUCKET` 改成一个不存在的桶名，重新部署，再点「立即备份」。

3. **期望**：备份失败。把变量改回去之前，原来的 `back/latest.sql` 还在，哈希不变。

4. 把 `R2_BUCKET` 改回正确的桶名并重新部署。

---

## 29. 新备份成功后更新

1. 上一个文件（让 D1 数据变化）。
2. 触发备份。
3. 确认 `latest.sql` 的 SHA-256 **与之前不同**，且内容包含新文件。

同时确认后台「设置」卡片显示的 `SHA-256` 与实际下载文件一致：

```bash
aws s3 cp s3://$R2_BUCKET/back/latest.sql now.sql \
  --endpoint-url https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com
sha256sum now.sql
```

---

## 30. ⚠️ 桶没有公共访问

图片和 `back/latest.sql` 在同一个桶。不要给这个桶开 R2 Public access，也不要绑 Custom Domain。公开图片只走 Worker 的 `/i/<sha256>`。

```bash
curl -i "https://<桶的假想公共域名>/back/latest.sql"
```

**期望**：无法访问。

---

## 附：快速回归脚本

把上面的冒烟部分脚本化（需要 `jq`）：

```bash
#!/usr/bin/env bash
set -euo pipefail
ORIGIN=${PANEL:?set PANEL}
TOKEN=${TOKEN:?set TOKEN}

pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; exit 1; }

echo "1. 未认证上传应被拒绝"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$ORIGIN/api/upload" -F "file=@test.png")
[ "$code" = "401" ] && pass "401" || fail "expected 401, got $code"

echo "2. 非法 SHA-256 应被拒绝"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$ORIGIN/api/upload/check" \
  -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"sha256":"bad","size":1}')
[ "$code" = "400" ] && pass "400" || fail "expected 400, got $code"

echo "3. 合法上传 + 去重"
SHA=$(sha256sum test.png | cut -d' ' -f1)
first=$(curl -s -X POST "$ORIGIN/api/upload" -H "X-API-Key: $TOKEN" \
  -H "X-File-SHA256: $SHA" -F "file=@test.png" | jq -r '.file.url')
second=$(curl -s -X POST "$ORIGIN/api/upload" -H "X-API-Key: $TOKEN" \
  -H "X-File-SHA256: $SHA" -F "file=@test.png" | jq -r '.file.url')
[ "$first" = "$second" ] && pass "URL 稳定" || fail "URL 不稳定"

echo "4. 公共 URL 免认证可达"
code=$(curl -s -o /dev/null -w '%{http_code}' "$first")
[ "$code" = "200" ] && pass "200" || fail "expected 200, got $code"

echo "5. Token 不能删除"
id=$(curl -s "$ORIGIN/api/files?limit=1" -b cookies.txt | jq -r '.data.files[0].id')
code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$ORIGIN/api/files/$id" -H "X-API-Key: $TOKEN")
[ "$code" = "403" ] && pass "403" || fail "expected 403, got $code"

echo "全部通过"
```
