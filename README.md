# 简行浏览器

跨平台青少年浏览器（Windows / macOS / Linux）：家长通过**配置组**管理可访问网站，支持站点扩展（如 B 站 UP 白名单），并提供**网页收藏夹**。

## 功能

- **配置组**：自由增删改；每组绑定域名，可挂扩展
- **B 站扩展**：仅放行组内 UP 的空间与视频
- **收藏夹**：地址栏旁☆收藏当前页，顶栏收藏夹一键打开
- 家长密码保护设置页

## 开发运行

```bash
npm install
npm start
```

## 打包

```bash
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npm run dist
```

产物在 `release/`。
