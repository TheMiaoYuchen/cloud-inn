# Vercel 测试部署

线上测试地址：`https://cloud-inn-test.zhong2.xyz`。

Vercel 项目名为 `web-mvp`，其根目录是仓库内的 `web-mvp/`。`vercel.json` 会构建 Vite 静态站点，并将 `api/generate.js` 部署为同源函数；浏览器始终请求 `/api/generate`，从不接触模型密钥。

## 启用真实生成

在 Vercel 项目的 Production 环境添加：

```text
CLOUD_INN_IMAGE_API_KEY=<图片服务密钥>
```

可选覆盖项：

```text
CLOUD_INN_IMAGE_MODEL=gemini-3.1-flash-image
CLOUD_INN_IMAGE_API_ORIGIN=https://img-api.apinebula.ai/
CLOUD_INN_ALLOWED_ORIGIN=https://cloud-inn-test.zhong2.xyz
```

添加或改动变量后重新部署生产版本。完成后，用测试站点选择客房、家具并填写描述，点击“生成效果图”；成功返回的图片会自动存入当前浏览器的 IndexedDB。

## 验收清单

- 首页返回 200，并显示客房设计工作台。
- `POST /api/generate` 从测试域名调用时，在未配置密钥前返回 `GENERATION_NOT_CONFIGURED`（503）。
- 配置密钥后，同一请求返回图片的 `base64`、`mimeType` 与实际模型名。
- 从非允许来源调用时返回 `ORIGIN_DENIED`（403）。
