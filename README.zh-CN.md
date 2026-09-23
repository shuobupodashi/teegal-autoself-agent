# Teegal - 从AutoResearch到AutoProjects，再到Autoself

<div align="center">

[English](./README.md) | 简体中文

</div>

Teegal 起源于一个想用ML方法研究量化的小团队自我补足：我们没有前沿实验室有那么多优秀的前沿研究员，也没有足够的资金购买算力。但中国有句古话：办法总比困难多。于是我们为自己写了一个 **AutoResearch Agent（自动研究智能体）**。但在实操中我们发现：AutoResearch 的方法并不局限于研究——它同样适用于任何项目型工作（Projects）。因此我们基于 AutoResearch 的递归式方法，封装出 **Auto Projects** 项目级自动化能力，让同一个 Agent 适配数据分析、模型训练、剪辑、视频制作等多类任务域——把一句需求自动推进为可交付的成果，同时我们还把GPU算力和云端常驻实例打通，任何你想到的功能，都可以快速写完并且发布，你也可以将agent注入到任何有计算能力的机子里面，让他们在有计算环境的地方工作。如果让我总结这段创作的经历，我会说：我们即将迎来一个智能无处不在的时代，不管你有没有准备好。

## 核心特点

### 1. 递归式执行（Recursive Execution）—— AutoResearch 的方法论
复杂任务自动递归分解为子任务，执行 → 观察 → 再分解，直到产出结果。全过程有工作笔记与执行记录可追溯，避免一次性长规划带来的失控。

### 2. 计算优化（Compute Optimization）—— 让"买不到算力"不再是门槛
- **本地执行**：代码运行、文件处理等轻任务在本地完成后端执行，零成本
- **云端 GPU**：训练等重任务自动调度到云端算力；本地只需维护云端凭证即可接入（hosted 模式）——GPU 规格、价格、库存、云厂商凭证全部在云端服务统一维护，本地与前端零渠道概念
- 任务按需路由，兼顾成本与性能

### 3. Projects Auto（Project-level Automation）—— 从 AutoResearch 泛化到 AutoProjects
AutoResearch 的方法论不止于研究：以项目为单位组织自动化——多阶段任务编排、产物统一落盘管理、断点恢复与执行对账，让 Agent 的产出沉淀为项目资产，而非一次性对话。

### 4. Autoself（Agent 自迭代）—— Agent 能自己迭代自己
系统自身的源码以基础项目（base-bootcode）的形式向 Agent 完全开放：Agent 可自主阅读并修改这些源码，再经版本打包、Release 发布与更新源维护，把新版本经自动更新链路送回每一台装机——从"写软件"到"写自己"，Agent 的迭代闭环就此打通。

## 功能特性

- **智能对话** - 多轮对话，自动维护上下文
- **Auto 模式** - AI 自动分析需求并执行任务（ReAct 推理-行动循环）
- **Projects Auto** - 项目级自动化任务编排
- **GPU 云端算力** - hosted 代理接入云端 GPU，按量结算
- **文件管理** - 上传、预览、下载，产物自动关联任务
- **桌面端** - Electron 跨平台桌面应用，支持自动更新
- **蜂群常驻** - Agent 以无头模式常驻服务器 7×24 无人值守，母体经 SSH 激活任务

## 项目结构

```
├── src/               # 前端应用（React 18 + TypeScript + Vite + shadcn-ui）
├── local-backend/     # 本地常驻后端（Node.js + Express + SQLite）
│                      #   ReAct 执行引擎、任务调度、GPU hosted 代理、本地数据存储
└── electron/          # 桌面端（Electron 主进程 / 预加载 / 打包与自动更新）
```

## 技术栈

- **前端**：React 18 + TypeScript + Vite + Tailwind CSS + shadcn-ui
- **后端**：Node.js + Express + SQLite（local-storage）
- **桌面端**：Electron + electron-builder
- **国际化**：i18next

## 快速开始

### 前置要求
- Node.js 18+
- npm

### 1. 安装依赖
```bash
# 根目录（前端 + 桌面端）
npm install

# 本地后端
cd local-backend
npm install
```

### 2. 配置环境变量
```bash
# 复制模板并按需修改
cp .env.example .env
cp local-backend/.env.example local-backend/.env
```

### 3. 启动开发环境
```bash
# 启动本地后端（默认 3001 端口）
cd local-backend
npm run dev

# 新终端：启动 Web 前端（默认 8080 端口）
npm run dev

# 或直接启动桌面端开发环境（前端 + Electron）
npm run electron:dev
```

### 4. 构建桌面安装包
```bash
npm run electron:package:win    # Windows
npm run electron:package:mac    # macOS
npm run electron:package:linux  # Linux
```

## 环境变量

| 变量 | 位置 | 说明 |
|---|---|---|
| `VITE_HOME_WEB_URL` | 根目录 `.env` | 云端服务地址（不配置则使用默认官方服务） |
| `VITE_ALIYUN_OSS_BUCKET` / `REGION` | 根目录 `.env` | 对象存储直传配置（凭证由云端动态下发） |
| `GPU_WORKER_SECRET` | `local-backend/.env` | 云端 GPU 执行层服务间密钥 |
| `HOME_WEB_URL` | `local-backend/.env` | 云端地址（不配置则默认官方服务） |
| `TEEGAL_HEADLESS` / `TEEGAL_AGENT_PORT` / `TEEGAL_AGENT_HOST` | 启动环境变量 | 无头分身模式与激活入口（详见"蜂群常驻"） |

完整说明见 `.env.example` 与 `local-backend/.env.example`。

## 云端算力

Teegal 采用 **hosted 云端执行架构**：本地不持有任何云厂商凭证，GPU 规格/价格/库存/结算全部由云端服务统一维护。

- **开箱即用**：克隆后无需任何配置，云端算力默认接入官方服务（`https://www.workbees.space`），训练等重任务自动调度到云端执行
- **自建云端（可选）**：如需指向自己的云端服务，在 `local-backend/.env` 配置：
   ```env
   GPU_WORKER_SECRET=your-worker-secret
   HOME_WEB_URL=https://your-cloud-service
   ```
   云端服务需自行部署（云端执行层代码不在本仓库中），负责配置云厂商凭证与对象存储；训练任务自动提交执行，状态/日志/产物 URL 回传本地展示

> OSS 与 GPU 同理：谁运行云端，谁配置存储。开源代码中不含任何存储凭证。

## 蜂群常驻（Headless 分身）

Agent 不仅能跑在桌面端，还能以无头模式常驻 Linux 服务器：界面隐藏、执行内核照常运行，像分身一样 7×24 无人值守接活。启动时加 `TEEGAL_HEADLESS=1`（或 `--headless` 参数）即进入分身模式：

```bash
TEEGAL_HEADLESS=1 npm run electron:start
# 打包后的应用同理，可改用 --headless 参数
```

分身在本机开放 HTTP 激活入口（默认 `127.0.0.1:7717`），母体（桌面端或运维脚本）经 SSH 登录服务器即可激活任务：

```bash
# 健康检查：确认分身在线
curl http://127.0.0.1:7717/api/agent/ping

# 激活任务：受理即回，任务在分身内异步执行，产物经项目文件/GPU 任务回流查看
curl -X POST http://127.0.0.1:7717/api/agent/query \
  -H 'Content-Type: application/json' \
  -d '{"userQuery": "分析 data.csv 并生成可视化报告"}'
```

- **安全默认**：只绑 `127.0.0.1` 不暴露公网，经 SSH 进来调本机端口；如需直连设 `TEEGAL_AGENT_HOST=0.0.0.0`（自行承担风险），端口用 `TEEGAL_AGENT_PORT` 调整
- **一套代码三形态**：分身只做"激活"，执行链完整保留在渲染进程（Auto 内核 → ReAct → 工具 → local-backend），与桌面端同一套代码；分身模式自动跳过自动更新，避免打断执行中的任务

## 许可证

MIT
