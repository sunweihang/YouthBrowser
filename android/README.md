# 简行浏览器 Android

青少年家长控制浏览器（配套 Electron Windows 版 SimplyGo / 简行），包名 `com.jianxing.browser`，版本 **1.1.32** (versionCode 32)。

目标：与 Windows Electron 客户端在界面与功能上对齐。

## 功能（与 Windows 桌面版对齐）

- 深色 chrome：标签栏、后退/前进/刷新、胶囊地址栏、收藏星标、汉堡菜单
- 多标签、查找栏、主页栏、保存密码栏、书签工具栏（含文件夹）
- 菜单：新建/关闭标签、主页、查找、打印、缩放、全屏、家长、更新、密码、默认浏览器
- WebView 浏览器：地址栏、后退/前进/刷新、书签星标、书签工具栏芯片
- 家长密码：与 Electron 相同的 scrypt 哈希（`scrypt$salt$hash`，N=16384,r=8,p=1,keylen=64）
- 本地规则 CRUD：配置组 / hosts / B 站扩展 `allowedMids`
- 导航守卫：仅 http/https；主机须匹配已启用配置组；B 站按路径与 UP mid 校验
- 已批准访问申请：同 host+pathname 在守卫前放行
- 拦截页：中文 reason 映射 +「申请访问」（与 Windows block 页一致）
- 家长设置多面板：账号门禁 → 解锁 → 概览 / 配置组 / 访问申请 / 账号与同步 / 账号安全
- 同步 API：`https://spacedreams.cn/simplygo-api`（register / login / logout、`/sync/config`、`/sync/bookmarks`）

## 构建前准备

### 1. Android SDK / JDK

- JDK 17+
- Android SDK（compileSdk 34）
- 设置 `ANDROID_HOME`，或在本目录创建 `local.properties`：

```properties
sdk.dir=C\:\\Users\\你的用户名\\AppData\\Local\\Android\\Sdk
```

### 2. Gradle Wrapper

已包含 `gradlew` / `gradlew.bat` 与 `gradle/wrapper/gradle-wrapper.jar`。

`gradle-wrapper.properties` 使用腾讯云镜像下载 Gradle 8.2。

### 3. 签名

Release 使用 `keystore/jianxing-release.jks`（密码/别名均为 `jianxing`）。若不存在则回退 debug 签名。

## 构建 APK

```bash
cd android
.\gradlew.bat assembleRelease
```

产物：`app/build/outputs/apk/release/app-release.apk`

## 说明

- 升级自 v1 时，旧的 SHA-256 家长密码哈希会在加载时清除，需重新设置密码（之后与 Windows 互通）。
- 规则与收藏夹可通过同步服务器在两端共享；家长密码仅保存在本机。
