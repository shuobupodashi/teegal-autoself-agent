# AGENTS.md — base-bootcode 项目 Git 与发布约定

本目录是 Teegal 系统自身的完整源码（自举项目）。本文档约束 Agent 在本目录内的 git 操作与版本发布流程。

## 仓库拓扑

- **origin**：当前 remote。初始指向官方母仓；开始自主发布前，应改指用户自己的仓库：
  ```bash
  git remote set-url origin https://github.com/USER/REPO.git
  ```
- **官方母仓**：`https://github.com/shuobupodashi/teegal-autoprojects.git`
  无需配置 remote，需要时按 URL 直接 fetch

## 日常操作分工

- 页面"拉取更新"按钮 = `git pull --ff-only`（拉 origin）：多机同步用
- push / merge / 官方对齐 / 冲突解决：由 Agent 在终端完成
- `--ff-only` 会拒绝覆盖本地未推送的修改，这是资产保护，不要绕过（除非用户明确要求）

## 与官方对齐（两种策略，先判断再执行）

```bash
# 策略 1：保留本地修改，合并官方新版本（可能冲突，逐个解决）
git fetch https://github.com/shuobupodashi/teegal-autoprojects.git main
git merge FETCH_HEAD

# 策略 2：齐头重新分叉（丢弃本地未推送的修改，以官方为准）
git fetch https://github.com/shuobupodashi/teegal-autoprojects.git main
git reset --hard FETCH_HEAD
```

执行前：先 `git status` 确认工作区状态；若存在未推送的本地修改，先与用户确认取舍（merge 还是丢弃）。

## 版本发布流程

1. **bump 版本**：`package.json` 的 `version` 必须递增（否则已装机客户端比对不出新版本，不会触发更新）
2. **提交并 push** 到 origin
3. **打包**：`npm install && npm run electron:package:win`
4. **发布 Release**（tag 随命令自动创建）：
   ```bash
   gh release create vX.Y.Z dist/*.exe dist/latest.yml
   ```
5. **向用户报告更新源**：
   ```
   https://github.com/USER/REPO/releases/latest/download/
   ```
   用户将其填入 设置 → 凭据管理 → `updateSourceUrl`，各机器即自动感知后续版本

### 更新源 URL 规范（已核实 electron-updater 6.8.3 源码，勿再实验验证）

- 推荐写法（带尾斜杠）：`https://github.com/USER/REPO/releases/latest/download/`
- 6.8.3 的 GenericProvider 会自动补尾斜杠（`out/util.js` 的 `newBaseUrl`），因此不带尾斜杠的 `.../download` 也能用；带尾斜杠是稳妥写法，不依赖版本行为
- 客户端实际请求 = `<更新源>` + `latest.yml`（频道文件）→ `.../download/latest.yml`
- 安装包 URL 由 latest.yml 内的相对文件名拼到同一 base → `.../download/Teegal-Setup-x.y.z.exe`
- `releases/latest/download/` 是 GitHub 固定路由，永远指向最新 Release 的资产——更新源配置一次即可，发新版无需修改
- 修改 `updateSourceUrl` 后即时生效，无需重启

## 发布前提自查

- `gh` 已登录（`gh auth status` 或已设置 `GH_TOKEN`）
- 仓库必须 **public**（私有仓的 release 资产下载需要鉴权，generic 更新源会 404）
- `latest.yml` 与安装包必须同属本次构建产物，一起上传
