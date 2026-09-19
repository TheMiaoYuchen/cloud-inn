# Cloud Inn 网页 MVP

这是与旧版 `app/` 完全隔离的网页客房设计 MVP。规格与实施计划见 [`../docs/web-mvp/`](../docs/web-mvp/)。

## 本地启动

```bash
npm install
npm run dev
```

界面可在没有密钥时使用并自动保存；点击生成会明确提示服务端尚未配置。

图片生成代理另开一个终端启动。将真实密钥仅注入该服务端进程后执行：

```bash
npm run server
```

开发服务器会把 `/api` 请求转发到 `http://localhost:8787`。变量名及安全边界见 [`../docs/web-mvp/api-contract.md`](../docs/web-mvp/api-contract.md)。

## 检查

```bash
npm run check
```
