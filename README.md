# 简行浏览器

跨平台青少年浏览器（Windows / macOS / Linux）：家长通过**配置组**管理可访问网站，支持站点扩展、收藏夹，以及**账号云同步**。

## 功能

- **配置组**：自由增删改；每组绑定域名，可挂扩展
- **B 站扩展**：仅放行组内 UP 的空间与视频
- **收藏夹**：文件夹、拖拽、管理窗口
- **自动更新**：启动后检查服务器，有新版本则自动下载并提示安装
- **账号与同步**：注册/登录后，配置组可上传到服务器、从服务器拉取到其它设备
- 家长密码保护本机设置页（不同步）

## 下载

公开下载页（含历史版本）：

http://182.92.120.159/downloads/jianxing/

## 同步服务

服务端代码：`server/sync-server.js`  
公网 API：`http://182.92.120.159/jianxing-api/health`

## 自动更新

更新源目录与下载页相同。发布新版本：

```bash
set JIANXING_SSH_PASSWORD=***
npm run release
```

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
