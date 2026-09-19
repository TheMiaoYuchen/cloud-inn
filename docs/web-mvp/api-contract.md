# 图片生成代理接口契约

## 请求

`POST /api/generate`

请求必须来自允许的网页来源，且为 JSON：

```json
{
  "templateId": "garden-queen",
  "furnitureIds": ["oak-bed", "linen-chair"],
  "stylePrompt": "日式侘寂，暖白墙面和午后阳光。"
}
```

`templateId` 必须是服务端目录中的固定 ID；`furnitureIds` 必须全部在服务端目录中；`stylePrompt` 去除首尾空白后为 1–600 个字符。服务端不信任浏览器传来的展示名或提示词结构。

## 成功响应

```json
{
  "image": {
    "base64": "...",
    "mimeType": "image/png"
  },
  "model": "gemini-3.1-flash-image"
}
```

浏览器将其转为 data URL 显示，并保存到 IndexedDB；代理不保存玩家描述或图片。

## 失败响应

所有失败使用：

```json
{
  "error": { "code": "GENERATION_FAILED", "message": "图片模型暂时无法生成，请稍后重试。" }
}
```

已定义的错误码：`INVALID_REQUEST`（400）、`ORIGIN_DENIED`（403）、`NOT_FOUND`（404）、`RATE_LIMITED`（429）、`GENERATION_NOT_CONFIGURED`（503）和 `GENERATION_FAILED`（502）。不返回供应商原始错误、访问令牌、请求头或完整上游 URL。

## 服务端配置

仅服务端进程可读取这些环境变量：

| 变量 | 含义 |
| --- | --- |
| `CLOUD_INN_IMAGE_API_KEY` | 图片服务访问令牌，必填，不进入前端构建 |
| `CLOUD_INN_IMAGE_MODEL` | 唯一启用的模型名 |
| `CLOUD_INN_IMAGE_API_ORIGIN` | 受控图片服务根地址 |
| `CLOUD_INN_ALLOWED_ORIGIN` | 允许请求的网页来源；用逗号分隔多个值 |
| `CLOUD_INN_PROXY_PORT` | 代理监听端口 |

`web-mvp/.env.example` 只列出变量名，不含值。不要使用 `VITE_` 前缀，也不要把真实 `.env` 写入仓库。开发环境默认只允许两个本机来源；部署时必须把 `CLOUD_INN_ALLOWED_ORIGIN` 收紧为正式网页来源。当前代理设置 90 秒超时和每地址每分钟 8 次请求的进程内保护；多实例部署时应替换为共享限流层。
