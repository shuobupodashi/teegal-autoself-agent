# Teegal - From AutoResearch to AutoProjects, and to Autoself

<div align="center">

English | [简体中文](./README.zh-CN.md)

</div>

Teegal began as a small team's way of compensating for what we lacked: no frontier research team, and no budget for compute. So we built an **AutoResearch Agent** for ourselves. Along the way, we discovered that the AutoResearch methodology is not limited to research — it applies to any project-based work. So we distilled its recursive methodology into **Projects Auto**, project-level automation that lets the same Agent adapt to many task domains — data analysis, model training, video editing, media production — turning a single request into deliverable results automatically. We also bridged cloud GPUs and resident cloud instances: any feature you can imagine can be quickly built and published, and you can inject the agent into any machine with compute capability, letting them work wherever a compute environment exists. If I were to sum up this journey: we are heading into an era where intelligence is everywhere — whether you are ready or not.

## Key Highlights

### 1. Recursive Execution — the AutoResearch methodology
Complex tasks are automatically decomposed into subtasks in a recursive loop: execute → observe → decompose further — until results are produced. The whole process is traceable through working notes and execution records, avoiding the loss of control of one-shot long planning.

### 2. Compute Optimization — no compute budget? No longer a blocker
- **Local execution**: lightweight tasks (code running, file processing) run locally at zero cost
- **Cloud GPU**: heavy tasks (training) are automatically scheduled to cloud compute; you only need to maintain cloud credentials locally (hosted mode) — GPU specs, pricing, availability, and provider credentials are all maintained by the cloud service. No provider concepts leak into the local codebase
- Tasks are routed on demand, balancing cost and performance

### 3. Projects Auto — from AutoResearch to AutoProjects
The methodology generalizes beyond research: automation is organized around projects — multi-stage task orchestration, unified artifact management, resumable runs and execution reconciliation. Agent output accumulates as project assets instead of one-off conversations.

### 4. Autoself — the agent iterates itself
The system's own source code is fully exposed to the agent as a base project (base-bootcode): the agent can read and modify it, then autonomously handle version packaging, release publishing, and update-source maintenance — delivering the new version back to every installed machine through the auto-update chain. From "writing software" to "writing itself": the agent's iteration loop is closed.

## Features

- **Smart conversation** - Multi-turn dialogue with automatic context management
- **Auto mode** - AI analyzes requests and executes tasks automatically (ReAct loop)
- **Projects Auto** - Project-level automation orchestration
- **Cloud GPU** - hosted proxy to cloud GPUs with usage-based billing
- **File management** - Upload, preview, download; artifacts are linked to tasks
- **Desktop app** - Cross-platform Electron app with auto-update
- **Swarm resident** - Run the agent headless on a server 24/7, activated remotely via SSH

## Project Structure

```
├── src/               # Frontend app (React 18 + TypeScript + Vite + shadcn-ui)
├── local-backend/     # Local resident backend (Node.js + Express + SQLite)
│                      #   ReAct engine, task scheduling, GPU hosted proxy, local storage
└── electron/          # Desktop shell (Electron main / preload / packaging & auto-update)
```

## Tech Stack

- **Frontend**: React 18 + TypeScript + Vite + Tailwind CSS + shadcn-ui
- **Backend**: Node.js + Express + SQLite
- **Desktop**: Electron + electron-builder
- **i18n**: i18next

## Getting Started

### Prerequisites
- Node.js 18+
- npm

### 1. Install dependencies
```bash
# Root (frontend + desktop)
npm install

# Local backend
cd local-backend
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
cp local-backend/.env.example local-backend/.env
```

### 3. Start development
```bash
# Start local backend (port 3001 by default)
cd local-backend
npm run dev

# New terminal: start web frontend (port 8080 by default)
npm run dev

# Or start desktop dev environment (frontend + Electron)
npm run electron:dev
```

### 4. Build desktop installers
```bash
npm run electron:package:win    # Windows
npm run electron:package:mac    # macOS
npm run electron:package:linux  # Linux
```

## Environment Variables

| Variable | Location | Description |
|---|---|---|
| `VITE_HOME_WEB_URL` | Root `.env` | Cloud service URL (defaults to the official service) |
| `VITE_ALIYUN_OSS_BUCKET` / `REGION` | Root `.env` | Object storage direct-upload config (credentials are delivered by the cloud) |
| `GPU_WORKER_SECRET` | `local-backend/.env` | Service-to-service secret for the cloud GPU execution layer |
| `HOME_WEB_URL` | `local-backend/.env` | Cloud service URL (defaults to the official service) |
| `TEEGAL_HEADLESS` / `TEEGAL_AGENT_PORT` / `TEEGAL_AGENT_HOST` | Startup env | Headless agent mode & activation endpoint (see "Swarm Resident") |

See `.env.example` and `local-backend/.env.example` for details.

## Cloud Compute

Teegal uses a **hosted cloud execution architecture**: no cloud provider credentials live in the local codebase. GPU specs, pricing, availability, and settlement are all maintained by the cloud service.

- **Out of the box**: after cloning, zero configuration is needed — cloud compute defaults to the official service (`https://www.workbees.space`), and heavy tasks like training are scheduled to the cloud automatically
- **Self-hosted cloud (optional)**: to point to your own cloud service, set in `local-backend/.env`:
   ```env
   GPU_WORKER_SECRET=your-worker-secret
   HOME_WEB_URL=https://your-cloud-service
   ```
   The cloud service needs to be deployed by yourself (the cloud execution layer is not part of this repository); it holds the provider credentials and object storage config. Training tasks are submitted automatically; status, logs, and artifact URLs flow back to the local UI

> The same rule applies to object storage as to GPUs: whoever runs the cloud configures the storage. No storage credentials are bundled with the open-source code.

## Swarm Resident (Headless Agent)

The agent can also run resident on a Linux server in headless mode: the UI is hidden while the execution kernel keeps running — a clone that accepts tasks 24/7 unattended. Start with `TEEGAL_HEADLESS=1` (or the `--headless` argument):

```bash
TEEGAL_HEADLESS=1 npm run electron:start
# Same for the packaged app, or pass --headless
```

The clone exposes a local HTTP activation endpoint (default `127.0.0.1:7717`). The mother instance (desktop app or ops scripts) activates tasks over SSH:

```bash
# Health check: confirm the clone is alive
curl http://127.0.0.1:7717/api/agent/ping

# Activate a task: acked immediately, executed asynchronously in the clone;
# results flow back via project files / GPU tasks
curl -X POST http://127.0.0.1:7717/api/agent/query \
  -H 'Content-Type: application/json' \
  -d '{"userQuery": "Analyze data.csv and generate a visual report"}'
```

- **Secure defaults**: binds to `127.0.0.1` only, never exposed to the public network — callers come in via SSH and hit the local port. Set `TEEGAL_AGENT_HOST=0.0.0.0` for direct access (at your own risk); adjust the port via `TEEGAL_AGENT_PORT`
- **One codebase, three shapes**: the clone only "activates" — the full execution chain stays in the renderer (Auto kernel → ReAct → tools → local-backend), identical to the desktop app. Auto-update is skipped in headless mode so running tasks are never interrupted

## License

MIT
