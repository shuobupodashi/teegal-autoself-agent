import { app, BrowserWindow, ipcMain, Menu, desktopCapturer, screen, dialog, safeStorage } from 'electron';
import path from 'path';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import * as fs from 'fs';
import { initAutoUpdater } from './autoUpdater';
import { startAgentServer } from './agentServer';

/**
 * 🔥 Headless 分身模式（TEEGAL_HEADLESS=1 或 --headless）：
 * Linux 无界面服务器上 xvfb 跑同一个包——窗口隐藏（渲染进程照常运行 = 执行宿主），
 * 跳过自动更新，起 localhost HTTP 入口（agentServer）供母体激活。
 */
const isHeadless = process.env.TEEGAL_HEADLESS === '1' || process.argv.includes('--headless');

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess | null = null;

// 🔥 项目查看器独立窗口（浏览器式多 tab）：单实例，新项目以 tab 形式加入
let appViewerWindow: BrowserWindow | null = null;

// 🔥 后端服务端口：开发环境用 3002，生产环境用 3001
// 这样开发版本和生产版本可以同时运行，互不干扰
let BACKEND_PORT = 3001; // 默认生产端口

// 🔥 日志文件路径
let logFilePath: string;

/**
 * 初始化日志文件
 */
function initLogFile() {
  const logDir = app.getPath('userData');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  logFilePath = path.join(logDir, 'teegal.log');
  
  // 清空旧日志
  fs.writeFileSync(logFilePath, `=== Teegal Log ${new Date().toISOString()} ===\n`);
}

/**
 * 写入日志
 */
function log(message: string) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;
  console.log(message);
  
  if (logFilePath) {
    fs.appendFileSync(logFilePath, logLine);
  }
}

/**
 * 清理占用端口的进程
 * @param port 要清理的端口
 */
function cleanupPort(port: number) {
  const { execSync } = require('child_process');
  try {
    if (process.platform === 'win32') {
      // Windows: 使用 netstat + taskkill
      const result = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8' });
      const lines = result.trim().split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5) {
          const pid = parts[parts.length - 1];
          console.log(`🛑 清理占用端口 ${port} 的进程: PID ${pid}`);
          try {
            execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
          } catch (e) {
            // 忽略单个进程 kill 失败
          }
        }
      }
    } else {
      // macOS/Linux: 使用 lsof + kill
      const result = execSync(`lsof -ti:${port}`, { encoding: 'utf8' });
      const pids = result.trim().split('\n').filter(Boolean);
      for (const pid of pids) {
        console.log(`🛑 清理占用端口 ${port} 的进程: PID ${pid}`);
        try {
          process.kill(parseInt(pid), 'SIGKILL');
        } catch (e) {
          // 忽略单个进程 kill 失败
        }
      }
    }
  } catch (e) {
    // 没有进程占用端口
  }
}

/**
 * 加载 .env 文件
 */
function loadEnvFile(): Record<string, string> {
  const envPath = path.join(__dirname, '../local-backend/.env');
  const envVars: Record<string, string> = {};
  
  try {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const lines = envContent.split('\n');
    
    lines.forEach(line => {
      line = line.trim();
      if (line && !line.startsWith('#')) {
        const [key, ...valueParts] = line.split('=');
        if (key && valueParts.length > 0) {
          const value = valueParts.join('=').trim();
          envVars[key.trim()] = value.replace(/^["']|["']$/g, '');
        }
      }
    });
    
    console.log('✅ 环境变量加载成功');
  } catch (error) {
    console.error('⚠️ 无法加载 .env 文件:', error);
  }
  
  return envVars;
}

/**
 * 启动后端服务（ecs-async-worker）
 */
function startBackendServer() {
  // 🔥 先判断环境并设置端口
  const isDev = !app.isPackaged;
  BACKEND_PORT = isDev ? 3002 : 3001;
  
  // 🔥 启动前先清理占用端口的进程
  cleanupPort(BACKEND_PORT);
  
  log('🚀 正在启动后端服务...');
  log(`🔧 后端端口: ${BACKEND_PORT} (${isDev ? '开发环境' : '生产环境'})`);
  
  // 加载环境变量
  const envVars = loadEnvFile();
  
  // 根据环境确定后端路径和启动方式
  let command: string;
  let args: string[];
  
  // 🔥 local-backend 放在 app.asar.unpacked 目录
  // 开发环境：__dirname 指向 dist-electron
  // 生产环境：使用 process.resourcesPath 定位 app.asar.unpacked
  const backendDir = isDev 
    ? path.join(__dirname, '../local-backend')
    : path.join(process.resourcesPath, 'app.asar.unpacked', 'local-backend');
  
  log('🔍 Electron 环境检测:');
  log(`  isPackaged: ${app.isPackaged}`);
  log(`  backendDir: ${backendDir}`);
  log(`  __dirname: ${__dirname}`);
  log(`  resourcesPath: ${process.resourcesPath}`);
  
  if (isDev) {
    // 开发模式：使用 ts-node-dev 直接运行 TypeScript
    const tsNodeDevPath = path.join(backendDir, 'node_modules/.bin/ts-node-dev');
    const srcPath = path.join(backendDir, 'src/server.ts');
    
    log('📁 开发模式后端目录: ' + backendDir);
    log('📝 使用 ts-node-dev 运行源码: ' + srcPath);
    
    // Windows: 使用 node 直接运行 ts-node-dev 模块
    // 避免 shell: true 导致的进程树问题
    if (process.platform === 'win32') {
      command = 'node';
      args = [
        path.join(backendDir, 'node_modules/ts-node-dev/lib/bin.js'),
        '--respawn',
        '--transpile-only',
        '-r', 'dotenv/config',
        srcPath
      ];
    } else {
      command = tsNodeDevPath;
      args = ['--respawn', '--transpile-only', '-r', 'dotenv/config', srcPath];
    }
  } else {
    // 生产模式：运行编译后的 JavaScript
    const backendPath = path.join(backendDir, 'dist/server.js');
    log('📁 生产模式后端服务路径: ' + backendPath);
    
    // 🔥 检查后端文件是否存在
    if (!fs.existsSync(backendPath)) {
      log('❌ 后端服务文件不存在: ' + backendPath);
    } else {
      log('✅ 后端服务文件存在');
    }
    
    // 🔥 检查 node_modules 是否存在
    const nodeModulesPath = path.join(backendDir, 'node_modules');
    if (!fs.existsSync(nodeModulesPath)) {
      log('❌ node_modules 目录不存在: ' + nodeModulesPath);
    } else {
      log('✅ node_modules 目录存在');
      
      // 检查关键依赖
      const betterSqlitePath = path.join(nodeModulesPath, 'better-sqlite3');
      if (!fs.existsSync(betterSqlitePath)) {
        log('❌ better-sqlite3 不存在');
      } else {
        log('✅ better-sqlite3 存在');
      }
    }
    
    // 🔥 使用 Electron 内置的 Node.js 运行时
    // process.execPath 指向 Electron 可执行文件，它内置了 Node.js
    // 使用 --require 参数加载脚本，避免启动整个 Electron 应用
    command = process.execPath;
    args = [backendPath];
  }
  
  log(`🔧 启动命令: ${command} ${args.join(' ')}`);
  log(`🔧 工作目录: ${backendDir}`);
  
  // 🔥 区分开发和生产环境的存储路径
  const userDataDir = isDev
    ? path.join(app.getPath('userData'), 'dev')
    : app.getPath('userData');
  log(`📁 用户数据目录: ${userDataDir} (isDev: ${isDev})`);

  backendProcess = spawn(command, args, {
    env: {
      ...process.env,
      ...envVars,
      PORT: BACKEND_PORT.toString(),
      // 🔥 传递用户数据目录给 local-backend（仅生产环境）
      // 开发环境使用项目根目录的 data/ 文件夹
      ...(isDev ? {} : { USER_DATA_DIR: userDataDir }),
      // 🔥 生产环境：设置远程服务器 URL（用于 GPU 签名等）
      // 注意：GPU 签名接口是 /api/gpu-signature，所以基础 URL 是 https://workbees.space
      HOME_WEB_URL: 'https://workbees.space',
      // 🔥 生产模式：让 Electron 作为 Node.js 运行时运行
      ELECTRON_RUN_AS_NODE: isDev ? undefined : '1',
    },
    // 🔥 开发模式显示输出，生产模式隐藏但捕获输出
    stdio: isDev ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    // Windows 下隐藏控制台窗口
    windowsHide: true,
    // 🔥 移除 shell: true，避免进程树混乱
    detached: false,
    cwd: backendDir
  });

  // 🔥 生产模式：捕获后端输出日志
  if (!isDev && backendProcess.stdout && backendProcess.stderr) {
    backendProcess.stdout.on('data', (data) => {
      log('[BACKEND] ' + data.toString().trim());
    });
    backendProcess.stderr.on('data', (data) => {
      log('[BACKEND ERROR] ' + data.toString().trim());
    });
  }

  backendProcess.on('error', (error) => {
    log('❌ 后端服务启动失败: ' + error.message);
  });

  backendProcess.on('exit', (code) => {
    log(`⚠️ 后端服务退出，退出码: ${code}`);
  });

  log('✅ 后端服务进程已创建，端口: ' + BACKEND_PORT);
}

/**
 * 创建主窗口
 */
function createWindow() {
  console.log('💻 正在创建 Electron 窗口...');
  
  // 🔥 图标路径：开发模式和生产模式不同
  const iconPath = process.env.NODE_ENV === 'development'
    ? path.join(__dirname, '../public/favicon.ico')
    : path.join(process.resourcesPath, 'public/favicon.ico');
  
  mainWindow = new BrowserWindow({
    width: 700,      // 默认宽度
    height: 650,      // 默认高度
    minWidth: 700,    // 最小宽度
    minHeight: 600,   // 最小高度
    // 🔥 macOS: 保留原生红绿灯按钮（hiddenInset），Windows: 完全无边框
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const }
      : { frame: false }),
    // 🔥 设置应用图标（使用 ICO 格式）
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      // 启用 Web Workers 和 SharedArrayBuffer 支持
      webSecurity: true
    },
    title: 'WorkBees',
    backgroundColor: '#ffffff',
    // 🔥 headless 分身：窗口隐藏但渲染进程照常运行（渲染进程是执行宿主，必须活着）
    show: !isHeadless,
  });

  console.log('✅ 窗口创建成功');

  // 🔥 headless 分身：起 localhost HTTP 激活入口（POST /api/agent/query）
  if (isHeadless) {
    console.log('🧬 [HEADLESS] 分身模式：窗口已隐藏，激活入口待页面就绪后启动');
    startAgentServer(() => mainWindow);
  }

  // 开发环境：加载 Vite 开发服务器
  if (process.env.NODE_ENV === 'development') {
    console.log('🔧 开发模式：加载 http://localhost:8080');
    mainWindow.loadURL('http://localhost:8080');
    mainWindow.webContents.openDevTools(); // 如果需要调试，取消注释这行
    
    // 设置响应头以支持 SharedArrayBuffer
    mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Cross-Origin-Embedder-Policy': ['credentialless'],
          'Cross-Origin-Opener-Policy': ['same-origin']
        }
      });
    });
  } 
  // 生产环境：加载打包后的文件
  else {
    console.log('📦 生产模式：加载本地文件');
    // app.asar 中的文件路径 - 使用 __dirname 因为 asar 是虚拟文件系统
    const indexPath = path.join(__dirname, '../dist/index.html');
    console.log('📄 加载文件:', indexPath);
    mainWindow.loadFile(indexPath);
  }

  // 窗口加载完成
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('✅ 页面加载完成');
    
    // 🔥 初始化自动更新（始终初始化，开发环境下只注册 IPC handler）
    // 🔥 headless 分身跳过：服务器上无 GUI 更新流程，且不允许分身自我重启打断任务
    if (isHeadless) {
      console.log('🧬 [HEADLESS] 跳过自动更新初始化');
    } else {
      console.log('🔍 [AutoUpdater] 初始化自动更新...');
      initAutoUpdater(mainWindow!);
    }
  });

  // 窗口加载错误
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('❌ 页面加载失败:', errorCode, errorDescription);
  });

  // 🔥 拦截新窗口打开，使用系统浏览器打开外部链接
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.log('🔗 [ELECTRON] 拦截新窗口打开:', url);
    
    // 如果是外部链接（http/https），使用系统默认浏览器打开
    if (url.startsWith('http://') || url.startsWith('https://')) {
      const { shell } = require('electron');
      shell.openExternal(url);
      return { action: 'deny' };
    }
    
    // 如果是内部路由（如 /terms, /privacy），在当前窗口加载
    if (url.startsWith('/')) {
      // 构建完整 URL
      const baseUrl = process.env.NODE_ENV === 'development' 
        ? 'http://localhost:8080'
        : `file://${path.join(__dirname, '../dist/index.html')}`;
      
      if (process.env.NODE_ENV === 'development') {
        mainWindow?.loadURL(`${baseUrl}${url}`);
      } else {
        // 生产环境使用 hash 路由
        mainWindow?.loadURL(`${baseUrl}#${url}`);
      }
      return { action: 'deny' };
    }
    
    // 默认允许打开（ shouldn't reach here ）
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    console.log('🚪 窗口已关闭');
    mainWindow = null;
  });
}

/**
 * 🔥 设置 IPC 通信监听器，处理窗口控制
 */
function setupIPC() {
  // 🔥 窗口控制改为 sender 定向：viewer 独立窗口里的控制按钮操作自己，而不是主窗口
  const windowFromEvent = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): BrowserWindow | null => {
    return BrowserWindow.fromWebContents(event.sender) || mainWindow;
  };

  // 最小化窗口
  ipcMain.on('window-minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.minimize();
    }
  });

  // 最大化/还原窗口
  ipcMain.on('window-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
    }
  });

  // 关闭窗口
  ipcMain.on('window-close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.close();
    }
  });

  // 查询窗口是否最大化
  ipcMain.handle('window-is-maximized', (event) => {
    const win = windowFromEvent(event);
    return win ? win.isMaximized() : false;
  });

  // 获取窗口大小
  ipcMain.handle('window-get-size', (event) => {
    const win = windowFromEvent(event);
    return win ? win.getSize() : [1000, 700];
  });

  // 设置窗口大小
  ipcMain.handle('window-set-size', (event, { width, height }) => {
    const win = windowFromEvent(event);
    if (win) {
      if (win.isMaximized()) {
        win.unmaximize();
      }
      const bounds = win.getBounds();
      win.setBounds({
        x: bounds.x,
        y: bounds.y,
        width: width,
        height: height
      });
      return true;
    }
    return false;
  });

  // 🔥 基础项目工具目录监视：只监听 registry.json（工具登记的唯一网关）
  // 新增/下架工具必然改 registry.json（README 教 LLM 的流程也是"先写工具文件，最后登记"），
  // 因此只以 registry 变更作为重载信号——工具文件本身写多少次都不触发，避免无意义重载。
  // 覆盖任何写入方式（userpc_shell、外部编辑器等），弥补工具钩子路径之外的盲区。
  // 注：监听目录而非单文件，因为很多编辑器/脚本用"写临时文件再改名"的方式保存，单文件 watch 会失效。
  let baseToolsWatcher: any = null;
  let baseToolsWatchDebounce: any = null;
  let baseToolsWatchDir: string | null = null; // 当前监视目录（切换账号后 appId 变化需重挂）

  ipcMain.handle('watch-base-tools', (_e, appId?: string) => {
    const appsRoot = process.env.USER_DATA_DIR
      ? path.join(process.env.USER_DATA_DIR, 'apps')
      : null;
    if (!appsRoot) return { success: false, error: 'USER_DATA_DIR 未设置' };
    // 🔥 多账号隔离：基础项目 ID 可能带 userId 后缀（base-extensiontool-{userId}），
    // 渲染进程传入 ensureBaseProject 返回的实际 appId；白名单校验防路径穿越
    const safeAppId = (typeof appId === 'string' && /^base-extensiontool(-[A-Za-z0-9_-]+)?$/.test(appId))
      ? appId
      : 'base-extensiontool';
    const toolsDir = path.join(appsRoot, safeAppId, 'tools');
    try {
      if (!fs.existsSync(toolsDir)) return { success: false, error: 'tools 目录不存在' };
    } catch {
      return { success: false, error: 'tools 目录检查失败' };
    }
    // 幂等：同目录已监视直接返回（多窗口/多次调用安全）；目录变化（切换账号）则重挂
    if (baseToolsWatcher) {
      if (baseToolsWatchDir === toolsDir) return { success: true, reused: true };
      try { baseToolsWatcher.close(); } catch { /* 旧 watcher 关闭失败忽略 */ }
      baseToolsWatcher = null;
      baseToolsWatchDir = null;
    }
    try {
      baseToolsWatcher = fs.watch(toolsDir, { recursive: true }, (_event, filename) => {
        // 🔥 只关心 registry.json 的变更；渲染进程还有内容级去重（内容没变不重载）
        if (!String(filename || '').endsWith('registry.json')) return;
        // 🔥 防抖：合并同一批写入触发的多个事件
        if (baseToolsWatchDebounce) clearTimeout(baseToolsWatchDebounce);
        baseToolsWatchDebounce = setTimeout(() => {
          for (const win of BrowserWindow.getAllWindows()) {
            try {
              if (!win.isDestroyed()) win.webContents.send('base-tools:changed');
            } catch { /* 窗口销毁竞态，忽略 */ }
          }
        }, 800);
      });
      baseToolsWatchDir = toolsDir;
      console.log(`👀 [BASE-TOOLS-WATCH] 已开始监视基础项目 registry.json: ${toolsDir}`);
      return { success: true };
    } catch (e) {
      console.warn('[BASE-TOOLS-WATCH] 监视启动失败:', e);
      return { success: false, error: String(e) };
    }
  });

  // 🔥 项目查看器独立窗口（浏览器式多 tab）：单窗口复用，新项目发给已有窗口加 tab
  ipcMain.handle('open-app-viewer-window', (_, { appId, name }) => {
    if (!appId) return { success: false, error: 'missing appId' };

    // 已有 viewer 窗口：通知其新增 tab（页面自行去重）并置前
    if (appViewerWindow && !appViewerWindow.isDestroyed()) {
      appViewerWindow.webContents.send('app-viewer:add-tab', { appId, name });
      // 🔥 Windows 下 focus() 常不提升 Z 序（多屏场景窗口被压在其他窗口下面，最小化时更是无效）：
      // 先恢复最小化，再 show + focus + moveTop，确保窗口真正跑到前台
      if (appViewerWindow.isMinimized()) appViewerWindow.restore();
      appViewerWindow.show();
      appViewerWindow.focus();
      if (process.platform === 'win32') appViewerWindow.moveTop();
      return { success: true, reused: true };
    }

    const iconPath = process.env.NODE_ENV === 'development'
      ? path.join(__dirname, '../public/favicon.ico')
      : path.join(process.resourcesPath, 'public/favicon.ico');

    // 🔥 初始比例更小（约屏 55%），弹出位置偏右：基于主窗口位置推算，主窗口不存在时退到屏幕右侧
    let x: number | undefined;
    let y: number | undefined;
    let width = 1100; // 🔥 1000 时预览面板 tab+返回按钮会换行，加宽避免
    let height = 650;
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    if (parent) {
      const [px, py] = parent.getPosition();
      const [pw, ph] = parent.getSize();
      // 主窗口右侧放得下：贴主窗口右缘（留 40px 缝隙）；放不下则与屏幕右对齐
      x = px + pw + 40;
      const { workArea } = screen.getDisplayMatching(parent.getBounds());
      if (x + width > workArea.x + workArea.width) {
        x = Math.max(workArea.x, workArea.x + workArea.width - width);
      }
      y = py + Math.max(0, Math.round((ph - height) / 2));
    } else {
      const { workArea } = screen.getPrimaryDisplay();
      x = Math.max(workArea.x, workArea.x + workArea.width - width - 60);
      y = workArea.y + 60;
    }

    const viewerWin = new BrowserWindow({
      width,
      height,
      x,
      y,
      minWidth: 900,
      minHeight: 600,
      ...(process.platform === 'darwin'
        ? { titleBarStyle: 'hiddenInset' as const }
        : { frame: false }),
      icon: iconPath,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true
      },
      // 🔥 窗口标题固定（项目名在 tab 和 viewer 内显示，可改名不受影响）
      title: 'WorkBees',
      backgroundColor: '#ffffff',
      show: false, // 先加载后显示，避免白屏闪烁
    });

    // 🔥 与主窗口相同的加载策略（dev: vite server / prod: index.html + hash 路由）
    const route = `#/app-viewer?appId=${encodeURIComponent(appId)}${name ? `&name=${encodeURIComponent(name)}` : ''}`;
    if (process.env.NODE_ENV === 'development') {
      viewerWin.loadURL(`http://localhost:8080/${route}`);
    } else {
      viewerWin.loadFile(path.join(__dirname, '../dist/index.html'), { hash: route.replace(/^#/, '') });
    }

    viewerWin.once('ready-to-show', () => {
      viewerWin.show();
    });

    viewerWin.on('closed', () => {
      appViewerWindow = null;
    });

    appViewerWindow = viewerWin;
    return { success: true };
  });

  // 🔥 读取日志文件
  ipcMain.handle('get-log-content', () => {
    try {
      if (logFilePath && fs.existsSync(logFilePath)) {
        return fs.readFileSync(logFilePath, 'utf-8');
      }
      return '日志文件不存在';
    } catch (error) {
      return `读取日志失败: ${error}`;
    }
  });

  // 🔥 获取日志文件路径
  ipcMain.handle('get-log-path', () => {
    return logFilePath;
  });

  // 🔥 获取用户数据目录路径
  ipcMain.handle('get-user-data-path', () => {
    const isDev = !app.isPackaged;
    const userDataDir = isDev
      ? pathModule.join(app.getPath('userData'), 'dev')
      : app.getPath('userData');
    return userDataDir;
  });
}

/**
 * 应用启动
 */
app.whenReady().then(async () => {
  // 🔥 初始化日志文件
  initLogFile();
  log('🚀 Teegal 应用启动');
  log(`📁 用户数据目录: ${app.getPath('userData')}`);

  // 设置 IPC 监听器
  setupIPC();

  // 先启动后端服务
  startBackendServer();

  // 等待 2 秒让后端启动完成
  setTimeout(() => {
    createWindow();
  }, 2000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // 🔥 macOS 兜底：如果后端进程不存在（崩溃或异常退出），重启后端
      // 正常情况下 window-all-closed 已保留后端，直接创建窗口即可
      if (!backendProcess) {
        console.log('🔄 [activate] 后端进程不存在，重启后端...');
        startBackendServer();
        setTimeout(() => createWindow(), 2000);
      } else {
        createWindow();
      }
    }
  });
});

/**
 * 清理后端进程
 */
function cleanupBackendProcess() {
  if (backendProcess && backendProcess.pid) {
    try {
      console.log('🛑 正在关闭后端服务... PID:', backendProcess.pid);
      
      if (process.platform === 'win32') {
        // Windows 上使用 taskkill 强制杀死进程树
        const { execSync } = require('child_process');
        execSync(`taskkill /pid ${backendProcess.pid} /T /F`, { stdio: 'ignore' });
        console.log('✅ 后端进程已强制终止');
      } else {
        // macOS/Linux: 先 SIGTERM，再 SIGKILL
        try {
          process.kill(backendProcess.pid, 'SIGTERM');
          console.log('✅ 后端进程已发送 SIGTERM');
        } catch (e) {
          try {
            process.kill(backendProcess.pid, 'SIGKILL');
            console.log('✅ 后端进程已发送 SIGKILL');
          } catch (e2) {
            // 进程可能已退出
          }
        }
      }
    } catch (error) {
      console.error('⚠️ 关闭后端进程失败:', error);
    }
    backendProcess = null;
  }
  
  // 🔥 备用清理：直接杀死占用后端端口的进程
  cleanupPort(BACKEND_PORT);
  
  // 🔥 Windows 额外清理：杀死 Teegal.exe 进程（确保安装器可以删除文件）
  if (process.platform === 'win32') {
    try {
      const { execSync } = require('child_process');
      execSync('taskkill /F /IM Teegal.exe /FI "PID ne ' + process.pid + '"', { stdio: 'ignore' });
      console.log('✅ 其他 Teegal 进程已清理');
    } catch (e) {
      // 没有其他进程或清理失败，忽略
    }
  }
}

/**
 * 应用退出前清理
 */
app.on('before-quit', (event) => {
  console.log('🛑 [before-quit] 应用即将退出，开始清理...');
  cleanupBackendProcess();
});

/**
 * 🔥 额外的退出清理（确保进程被杀死）
 */
app.on('will-quit', (event) => {
  console.log('🛑 [will-quit] 应用即将退出，再次确认清理...');
  cleanupBackendProcess();
});

/**
 * 🔥 窗口关闭时也清理（开发模式热重载时）
 */
app.on('window-all-closed', () => {
  console.log('🛑 [window-all-closed] 所有窗口已关闭');

  if (process.platform !== 'darwin') {
    // 🔥 Windows/Linux: 清理后端并退出应用
    cleanupBackendProcess();
    app.quit();
  }
  // 🔥 macOS: 应用不退出（标准行为），保留后端进程
  // 窗口重建后前端可直接复用后端，避免 ModelManager 等因后端缺失而加载失败
  // 后端清理在 before-quit / will-quit（应用真正退出时）进行
});

/**
 * IPC 通信：获取后端服务地址
 */
ipcMain.handle('get-backend-url', () => {
  // 🔥 用 127.0.0.1 替代 localhost：避免 macOS IPv6 解析问题
  return `http://127.0.0.1:${BACKEND_PORT}`;
});

/**
 * IPC 通信：获取应用版本
 */
ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

/**
 * 🔥 IPC 通信：打开外部链接
 * 使用系统默认浏览器打开链接
 */
ipcMain.handle('shell:open-external', async (_, url: string) => {
  const { shell } = require('electron');
  await shell.openExternal(url);
  return { success: true };
});

/**
 * 🔥 IPC 通信：打开文件或文件夹
 * 使用系统默认程序打开文件，或打开文件夹
 */
ipcMain.handle('shell:open-path', async (_, filePath: string) => {
  const { shell } = require('electron');
  try {
    // 检查路径是否存在
    if (!fs.existsSync(filePath)) {
      return { success: false, error: '路径不存在' };
    }
    const result = await shell.openPath(filePath);
    if (result === '') {
      return { success: true };
    } else {
      return { success: false, error: result };
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '打开失败' };
  }
});

/**
 * 🔥 IPC 通信：在文件资源管理器中显示文件/文件夹
 * 打开文件资源管理器并高亮显示指定文件/文件夹
 */
ipcMain.handle('shell:show-item-in-folder', async (_, fullPath: string) => {
  const { shell } = require('electron');
  try {
    // 检查路径是否存在
    if (!fs.existsSync(fullPath)) {
      return { success: false, error: '路径不存在' };
    }
    shell.showItemInFolder(fullPath);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '打开失败' };
  }
});

/**
 * 🔥 IPC 通信：系统命令执行
 * 在主进程中执行系统命令，通过 IPC 调用
 */
ipcMain.handle('system:execute-command', async (event, { command, timeout = 120, workingDir }) => {
  
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    
    const isWindows = process.platform === 'win32';
    
    // 🔥 修复：处理包含换行符的命令
    // 注意：保留换行符，因为 PowerShell 需要多行命令（如 userpc_run_python）
    let sanitizedCommand = command || '';
    
    // Windows 下设置 UTF-8 编码
    const actualCommand = isWindows 
      ? `chcp 65001 >nul && ${sanitizedCommand}`
      : sanitizedCommand;
    
    console.log('⚡ [MAIN] 最终执行命令:', actualCommand);
    
    // 🔥 修复：不再使用 Node spawn 自带 timeout——它只给直接子进程(powershell)发 SIGTERM 并置 killed=true，
    // 孙进程(git.exe 等)存活且持有 stdio 管道 → close 永不触发，同时手写兜底因 killed=true 被跳过 → Promise 永远 pending（UI 无限转圈）
    // 统一由下方手写超时负责：强杀整棵进程树 + 必定 resolve
    const spawnOptions: any = {
      cwd: workingDir || process.cwd(),
      windowsHide: true,
      env: { 
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        LANG: 'en_US.UTF-8',
        // 🔥 git 禁用终端交互提示：私有仓库/凭据缺失时快速报错，而不是在 stdin 上等输入挂死
        GIT_TERMINAL_PROMPT: '0'
      }
    };
    
    let proc;
    if (isWindows) {
      // Windows: 显式使用 PowerShell 执行命令，添加 UTF-8 编码设置
      const encodedCommand = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${sanitizedCommand}`;
      proc = spawn('powershell', ['-NoProfile', '-Command', encodedCommand], {
        ...spawnOptions,
        shell: false
      });
    } else {
      // macOS/Linux: 使用 bash
      proc = spawn('/bin/bash', ['-c', sanitizedCommand], spawnOptions);
    }

    // 🔥 幂等收尾：无论 close/error/timeout 哪条路先到，只 resolve 一次
    let settled = false;
    const finish = (result: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolve({
        isHighRisk: command.trim().toLowerCase().startsWith('pip install'),
        ...result,
      });
    };
    
    // 🔥 输出截断保护：防止大量输出消耗过多内存
    const MAX_NON_STREAM_OUTPUT = 1 * 1024 * 1024; // 1MB
    let nonStreamOutputTruncated = false;

    proc.stdout?.on('data', (data) => {
      if (stdout.length + data.length > MAX_NON_STREAM_OUTPUT) {
        if (!nonStreamOutputTruncated) {
          nonStreamOutputTruncated = true;
          stdout += `\n⚠️ [输出截断] 超过 ${(MAX_NON_STREAM_OUTPUT / 1024 / 1024).toFixed(0)}MB，后续已截断`;
        }
        return;
      }
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      if (stderr.length + data.length > MAX_NON_STREAM_OUTPUT) {
        if (!nonStreamOutputTruncated) {
          nonStreamOutputTruncated = true;
          stderr += `\n⚠️ [输出截断] 超过 ${(MAX_NON_STREAM_OUTPUT / 1024 / 1024).toFixed(0)}MB，后续已截断`;
        }
        return;
      }
      stderr += data.toString();
    });
    
    proc.on('close', (code) => {
      console.log('⚡ [MAIN] 命令执行完成，退出码:', code);
      finish({
        success: code === 0,
        output: stdout.trim(),
        error: stderr.trim(),
        exitCode: code,
      });
    });
    
    proc.on('error', (error) => {
      console.error('❌ [MAIN] 命令执行错误:', error);
      finish({
        success: false,
        output: stdout.trim(),
        error: error.message,
        exitCode: -1,
      });
    });
    
    // 🔥 超时处理：强杀整棵进程树（Windows 用 taskkill /T /F，连带 git.exe 等孙进程）并必定 resolve
    // 不杀树的话孙进程持有 stdio 管道，close 事件永不触发，Promise 永远 pending
    const watchdog = setTimeout(() => {
      console.warn(`⚠️ [MAIN] 命令超时（${timeout}s），强杀进程树 PID=${proc.pid}`);
      try {
        if (isWindows) {
          // /T 杀整棵树，/F 强制（SIGTERM 对 powershell 无效且不杀子进程）
          spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
        } else {
          proc.kill('SIGKILL');
        }
      } catch (e) {
        console.error('[MAIN] 进程树终止失败:', e);
      }
      // 立刻 resolve 保证 UI 必然恢复；随后若有 close 事件会被 settled 挡掉
      finish({
        success: false,
        output: stdout.trim(),
        error: `Command timeout（${timeout}s，已强制终止进程树）`,
        exitCode: -1,
      });
    }, timeout * 1000);
  });
});

/**
 * 🔥 IPC 通信：系统命令执行（流式输出版本）
 * 支持实时输出反馈，用于长时间运行的命令（如下载、编译等）
 * 通过 event.sender.send 发送实时输出到渲染进程
 */
// 🔥 存储正在执行的进程，用于取消
const runningProcesses = new Map<string, { proc: any; cancelled?: boolean }>();

// 🔥 安全的 sender 发送函数
function safeSenderSend(sender: any, channel: string, data: any) {
  try {
    if (sender && !sender.isDestroyed()) {
      sender.send(channel, data);
    }
  } catch (error: any) {
    // 🔥 静默处理渲染进程已销毁的错误（常见于用户关闭窗口）
    if (error?.message?.includes('Render frame was disposed')) {
      // 渲染进程已销毁，静默忽略
      return;
    }
    // 其他错误记录日志
    console.log('[MAIN-STREAM] 发送消息失败:', error?.message || error);
  }
}

ipcMain.on('system:execute-command-stream', (event, { command, timeout = 120, workingDir, executionId, env: extraEnv, appId }) => {
  const isWindows = process.platform === 'win32';

  // 🔥 修复：处理包含换行符的命令
  // 注意：保留换行符，因为 PowerShell 需要多行命令（如 userpc_run_python）
  let sanitizedCommand = command || '';

  // 🔥 同一 appId 的服务类进程（dev server）重新启动前，先杀旧的进程树：
  // 避免端口一路顺延（8080→8081→...）和多进程叠加。
  // 注册表在 main 进程，不受渲染窗口刷新/重载影响（渲染进程的 Map 一刷新就丢，进程会失联）
  let killWaitMs = 0;
  if (appId) {
    const prev = appServiceProcesses.get(appId);
    if (prev) {
      appServiceProcesses.delete(appId);
      console.log(`🛑 [MAIN-STREAM] appId=${appId} 重新执行，先终止旧服务进程（executionId=${prev.executionId}, PID=${prev.proc.pid}）`);
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(prev.proc.pid), '/f', '/t'], { windowsHide: true });
        } else {
          prev.proc.kill('SIGKILL');
        }
        // 🔥 taskkill 是异步的：不等端口释放就起新进程，vite 会报 "Port in use" 顺延端口。
        // 给新命令脚本前加短暂 sleep，等进程树终止 + 端口释放
        killWaitMs = 1200;
      } catch (e) {
        console.warn('⚠️ [MAIN-STREAM] 终止旧服务进程失败（继续启动新进程）:', e);
      }
    }
  }

  // Windows 下设置 UTF-8 编码
  const actualCommand = isWindows
    ? `chcp 65001 >nul && ${sanitizedCommand}`
    : sanitizedCommand;

  console.log('⚡ [MAIN-STREAM] 开始执行命令:', actualCommand);

  // 发送开始执行事件
  safeSenderSend(event.sender, 'system:command-output', {
    executionId,
    type: 'start',
    message: `开始执行: ${sanitizedCommand}`,
    timestamp: Date.now()
  });
  
  const spawnOptions: any = {
    cwd: workingDir || process.cwd(),
    // 🔥 注意：不使用 spawn 的 timeout 选项，使用手动 setTimeout 来统一处理超时
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      LANG: 'en_US.UTF-8',
      ...extraEnv // 🔥 注入额外环境变量（如凭据值，不会出现在命令行/日志中）
    }
  };
  
  let proc;
  if (isWindows) {
    // 🔥 优化：检测下载命令，禁用进度条以提高稳定性
    let optimizedCommand = sanitizedCommand;
    if (sanitizedCommand.includes('Invoke-WebRequest')) {
      // 禁用进度条，避免阻塞输出流
      optimizedCommand = `$ProgressPreference = 'SilentlyContinue'; ${sanitizedCommand}`;
      console.log('🔧 [MAIN-STREAM] 检测到下载命令，已禁用进度条');
    }
    // 🔥 修复：将单引号中的路径转换为使用 $env:USERPROFILE 变量，避免转义问题
    // 将 'C:\Users\xxx\.teegal\...' 转换为 "$env:USERPROFILE\.teegal\..."
    optimizedCommand = optimizedCommand.replace(/'C:\\Users\\[^\\]+\\\.teegal([^']*)'/g, '"$env:USERPROFILE\\.teegal$1"');
    if (optimizedCommand !== sanitizedCommand) {
      console.log('🔧 [MAIN-STREAM] 修复路径格式，使用 $env:USERPROFILE');
    }
    // 🔥 检测后台启动命令（如 start /b），改用 PowerShell 的后台任务
    // 使用 Start-Job 让父进程立即退出，不会阻塞前端
    if (/start\s+\/b/i.test(optimizedCommand)) {
      const bgCommand = optimizedCommand.replace(/start\s+\/b\s+(.+)/i, '$1');
      // 使用 Start-Job 在后台运行，父进程立即返回
      optimizedCommand = `$job = Start-Job { ${bgCommand} }; Write-Host "后台进程已启动 (Job ID: $($job.Id))"; Start-Sleep -Milliseconds 500; exit 0`;
      console.log('🔧 [MAIN-STREAM] 检测到后台启动命令，转换为 Start-Job');
    }
    // 🔥 使用 -File 参数执行脚本文件，避免命令行长度限制
    const fs = require('fs');
    const path = require('path');
    // 🔥 杀旧服务进程后等端口释放（killWaitMs），避免新进程报 "Port in use"
    const waitPrefix = killWaitMs > 0 ? `Start-Sleep -Milliseconds ${killWaitMs}\r\n` : '';
    const scriptContent = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\r\n${waitPrefix}${optimizedCommand}`;
    const scriptPath = path.join(require('os').tmpdir(), `teegal_cmd_${Date.now()}.ps1`);
    fs.writeFileSync(scriptPath, scriptContent, 'utf8');
    console.log('🔧 [MAIN-STREAM] 命令已写入脚本文件:', scriptPath);
    
    proc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      ...spawnOptions,
      shell: false
    });
    
    // 进程结束后清理脚本文件
    proc.on('close', () => {
      try {
        fs.unlinkSync(scriptPath);
      } catch (e) {
        // 忽略清理错误
      }
    });
  } else {
    // 🔥 杀旧服务进程后等端口释放（killWaitMs），避免新进程报 "Port in use"
    proc = spawn('/bin/bash', ['-c', killWaitMs > 0 ? `sleep ${(killWaitMs / 1000).toFixed(1)} && ${sanitizedCommand}` : sanitizedCommand], spawnOptions);
  }

  // 🔥 存储进程用于取消
  runningProcesses.set(executionId, { proc, cancelled: false });

  // 🔥 按 appId 登记进程（服务类进程常驻、计算类会自然退出并触发 close 清理）。
  // 用于：同 appId 重新执行时杀旧（服务类和计算类都杀，防叠加）、关闭项目窗口时释放（仅服务类）
  if (appId) {
    appServiceProcesses.set(appId, { proc, executionId, isService: false, startedAt: Date.now() });
    // 🔥 新执行开始：上一次的后台结果/缓冲已无意义（记录要么已更新要么已被放弃），清掉
    appPendingResults.delete(appId);
    appOutputBuffers.delete(appId);
  }

  // 🔥 诊断：记录进程启动信息
  console.log('🔍 [MAIN-STREAM] 进程启动:', { pid: proc.pid, executionId, command: actualCommand.substring(0, 100) });

  // 🔥 检查渲染进程是否还有效的辅助函数
  const isSenderValid = () => {
    try {
      return event.sender && !event.sender.isDestroyed();
    } catch {
      return false;
    }
  };

  // 🔥 输出缓冲区管理：防止管道死锁
  // 当 Python 等程序产生大量 stderr（如长 traceback），管道缓冲区满后会阻塞进程写入，导致卡死
  // 解决方案：超过上限后停止 IPC 转发但继续从管道读取（丢弃），防止管道满阻塞进程
  const MAX_OUTPUT_BYTES = 1 * 1024 * 1024; // 1MB 上限（正常输出足够，异常 traceback 通常 50-200KB）
  let totalOutputBytes = 0;
  let outputTruncated = false;

  // 🔥 统一输出处理：检查缓冲区，超限时丢弃后续数据（保持管道畅通），但进程继续运行
  const handleOutput = (type: 'stdout' | 'stderr', data: Buffer) => {
    totalOutputBytes += data.length;

    // 🔥 超过上限：只发一次截断提示，后续数据静默丢弃（仍需读取，否则管道满会卡死进程）
    if (totalOutputBytes > MAX_OUTPUT_BYTES) {
      if (!outputTruncated) {
        outputTruncated = true;
        console.warn(`⚠️ [MAIN-STREAM] 输出超过 ${(MAX_OUTPUT_BYTES / 1024 / 1024).toFixed(0)}MB，后续输出已截断（进程继续运行）`);
        if (isSenderValid()) {
          safeSenderSend(event.sender, 'system:command-output', {
            executionId,
            type: 'stderr',
            data: `\n⚠️ [输出截断] 命令输出超过 ${(MAX_OUTPUT_BYTES / 1024 / 1024).toFixed(0)}MB，后续输出不再显示（进程仍在运行）。如需查看完整输出，请将结果写入文件。`,
            timestamp: Date.now()
          });
        }
      }
      return; // 🔥 丢弃后续输出，但管道仍被读取，进程不会卡死
    }

    const output = data.toString();
    console.log(`📤 [MAIN-STREAM] ${type}:`, output.substring(0, 50));

    // 🔥 项目进程的输出进缓冲（封顶 512KB）：窗口关闭后脚本继续跑，
    // 输出留在这里，跑完连同退出码存入 appPendingResults 等待下次打开窗口时认领
    if (appId) {
      const prev = appOutputBuffers.get(appId) || '';
      appOutputBuffers.set(appId, (prev + output).slice(-MAX_APP_BUFFER));
    }

    if (!isSenderValid()) {
      // 🔥 带 appId 的项目进程（计算脚本/服务）：渲染窗口重载/刷新不应杀死它。
      // - 脱管的服务（dev server）：常驻运行，由"重新执行"/"Stop 按钮"/"关闭项目窗口"释放
      // - 计算脚本（main.py 推理等）：自己跑完退出，超时看门狗兜底；
      //   中途被杀会导致用户"推理到一半结果丢失"
      // 只是没了输出接收方，停止转发即可
      if (appId && [...appServiceProcesses.values()].some(e => e.executionId === executionId)) {
        return;
      }
      // 🔥 无主命令（LLM userpc_shell 探索等）：渲染进程销毁则终止。必须杀整棵进程树——
      // proc.kill() 只杀 powershell 父进程，node/vite 等孙进程存活变孤儿，
      // 继续占用端口且父死后 taskkill /T 再也找不到它们
      console.log('🛑 [MAIN-STREAM] 渲染进程已销毁，终止进程（杀整棵进程树）');
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { windowsHide: true });
        } else {
          proc.kill('SIGKILL');
        }
      } catch (e) {
        console.warn('⚠️ [MAIN-STREAM] 终止进程树失败:', e);
      }
      return;
    }
    safeSenderSend(event.sender, 'system:command-output', {
      executionId,
      type,
      data: output,
      timestamp: Date.now()
    });
  };

  // 实时发送 stdout 输出
  let stdoutDataCount = 0;
  proc.stdout?.on('data', (data) => {
    stdoutDataCount++;
    handleOutput('stdout', data);
  });

  // 实时发送 stderr 输出
  let stderrDataCount = 0;
  proc.stderr?.on('data', (data) => {
    stderrDataCount++;
    handleOutput('stderr', data);
  });

  // 命令退出（进程已退出，但流可能未关闭）
  let exitCode: number | null = null;
  proc.on('exit', (code, signal) => {
    console.log('⚡ [MAIN-STREAM] 命令退出:', { exitCode: code, signal, executionId });
    exitCode = code;
  });

  // 命令完成（流已关闭）
  proc.on('close', (code, signal) => {
    console.log('⚡ [MAIN-STREAM] 命令执行完成:', { exitCode: code, signal, stdoutCount: stdoutDataCount, stderrCount: stderrDataCount, executionId });
    // 🔥 清理进程记录
    const processInfo = runningProcesses.get(executionId);
    runningProcesses.delete(executionId);
    streamWatchdogs.delete(executionId); // 🔥 清理超时看门狗（已结束的进程不再需要）
    // 🔥 计算类脚本自然退出 → 清理 appId 登记（服务类常驻不退出，由重新执行/关窗口释放）
    const appEntry = appId ? appServiceProcesses.get(appId) : undefined;
    if (appId && appEntry?.executionId === executionId) {
      appServiceProcesses.delete(appId);
    }
    // 使用 exit 事件的 code 如果 close 事件的 code 为 null
    const finalExitCode = code !== null ? code : exitCode;
    // 🔥 检查是否被用户取消
    const wasCancelled = processInfo?.cancelled || false;
    // 🔥 项目进程执行完毕：输出缓冲连同退出码存入待认领结果。
    // 正常路径（窗口开着）渲染进程自己更新记录，这里的备份会被下次认领时丢弃；
    // 窗口已关闭/重载（sender 失效，promise 已丢）→ 下次打开项目窗口认领补写进 executionlog
    if (appId) {
      // exitCode 为 null（被信号杀死等）按失败处理，记为 1
      // 🔥 duration 一并记入：认领补写 executionlog 时才有耗时数据（否则列表显示 "-"）
      appPendingResults.set(appId, {
        exitCode: finalExitCode ?? 1,
        output: appOutputBuffers.get(appId) || '',
        duration: appEntry?.startedAt ? Date.now() - appEntry.startedAt : undefined,
      });
      appOutputBuffers.delete(appId);
    }
    console.log('📤 [MAIN-STREAM] 发送 close 消息:', { executionId, finalExitCode, wasCancelled, senderDestroyed: event.sender?.isDestroyed() });
    safeSenderSend(event.sender, 'system:command-output', {
      executionId,
      type: 'close',
      exitCode: finalExitCode,
      success: finalExitCode === 0,
      cancelled: wasCancelled,
      outputTruncated, // 🔥 标记输出是否被截断
      timestamp: Date.now()
    });
  });

  // 错误处理
  proc.on('error', (error) => {
    console.error('❌ [MAIN-STREAM] 命令执行错误:', error);
    safeSenderSend(event.sender, 'system:command-output', {
      executionId,
      type: 'error',
      error: error.message,
      timestamp: Date.now()
    });
  });

  // 超时处理（服务类进程可通过 system:detach-command 取消超时，活到被杀为止）
  const watchdog = setTimeout(() => {
    streamWatchdogs.delete(executionId);
    if (!proc.killed) {
      // 🔥 必须杀整棵进程树：proc.kill() 只杀 powershell 父进程，
      // python/node 孙进程会变孤儿继续跑（占用 CPU/内存，再也无法管理）
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { windowsHide: true });
        } else {
          proc.kill('SIGKILL');
        }
      } catch (e) {
        console.warn('⚠️ [MAIN-STREAM] 超时杀进程树失败:', e);
      }
      safeSenderSend(event.sender, 'system:command-output', {
        executionId,
        type: 'timeout',
        error: 'Command timeout',
        timestamp: Date.now()
      });
    }
  }, timeout * 1000);
  streamWatchdogs.set(executionId, watchdog);
});

/**
 * 🔥 流式命令的超时看门狗（服务类进程检测到启动地址后可"脱管"，不再被超时杀掉）
 */
const streamWatchdogs = new Map<string, NodeJS.Timeout>();

/**
 * 🔥 按 appId 登记的项目进程（main 进程持有，不受渲染窗口刷新/重载影响）
 * 严格区分两类，避免逻辑混淆：
 * - 服务类 isService=true（vite/app.py 等检测到访问地址后脱管）：
 *   常驻运行 → Stop 按钮 / 重新 Run 覆盖 / 关闭项目窗口时杀掉
 * - 计算类 isService=false（main.py 推理等纯脚本）：
 *   不做进程管理，跑完自然退出（超时看门狗兜底），关闭窗口不影响它
 * 两类共同点：重新 Run 时旧的会被杀掉（防止叠加占资源）
 */
const appServiceProcesses = new Map<string, { proc: any; executionId: string; isService: boolean; startedAt?: number }>();

/**
 * 🔥 计算类脚本的输出缓冲（appId → 最近输出，封顶 512KB）
 * 窗口关闭期间脚本继续在后台跑：输出进缓冲，跑完连同退出码存入 appPendingResults，
 * 下次打开项目窗口时由渲染进程认领，补写进 executionlog（结果不丢）
 */
const appOutputBuffers = new Map<string, string>();
const MAX_APP_BUFFER = 512 * 1024;

/**
 * 🔥 已在后台执行完毕、等待渲染进程认领的结果（appId → { exitCode, output }）
 * 正常路径（窗口开着跑完）渲染进程自己更新记录，认领时发现无 running 记录会自动丢弃
 */
const appPendingResults = new Map<string, { exitCode: number; output: string; duration?: number }>();

/**
 * 🔥 IPC 通信：取消流式命令的超时（服务器类进程常驻运行，由用户关窗口/重新 Run 时终止）
 * 同时把该进程标记为服务类（isService）：Stop 按钮 / 关窗释放只对服务类生效
 */
ipcMain.on('system:detach-command', (_event, { executionId }) => {
  const watchdog = streamWatchdogs.get(executionId);
  if (watchdog) {
    clearTimeout(watchdog);
    streamWatchdogs.delete(executionId);
  }
  for (const entry of appServiceProcesses.values()) {
    if (entry.executionId === executionId) entry.isService = true;
  }
  console.log(`🔔 [MAIN-STREAM] 命令已脱管（服务类进程，常驻运行）: ${executionId}`);
});

/**
 * 🔥 IPC 通信：查询 appId 的后台进程状态
 * 返回 { running, isService }：running=有进程（计算类也算），isService=是服务类
 * 渲染进程据此：isService → 显示 Stop 按钮；running && !isService → 轮询等结果
 */
ipcMain.handle('system:query-app-service', (_event, { appId }) => {
  const entry = appServiceProcesses.get(appId);
  return { running: !!entry, isService: !!entry?.isService };
});

/**
 * 🔥 IPC 通信：认领 appId 在后台执行完毕的结果（打开项目窗口时调用，取走即清）
 */
ipcMain.handle('system:claim-app-result', (_event, { appId }) => {
  const result = appPendingResults.get(appId) || null;
  appPendingResults.delete(appId);
  return result;
});

/**
 * 🔥 IPC 通信：释放 appId 的后台服务进程（关闭项目窗口时调用，杀整棵进程树）
 * 只杀服务类（dev server）；计算类脚本不受关窗影响，继续后台跑完，结果等下次认领
 */
ipcMain.on('system:stop-app-service', (_event, { appId }) => {
  const entry = appServiceProcesses.get(appId);
  if (!entry) return;
  if (!entry.isService) {
    console.log(`ℹ️ [MAIN-STREAM] appId=${appId} 是计算类脚本，关窗不终止（继续后台执行，结果稍后可认领）`);
    return;
  }
  appServiceProcesses.delete(appId);
  appOutputBuffers.delete(appId);
  console.log(`🛑 [MAIN-STREAM] 项目窗口关闭，释放 appId=${appId} 的服务进程（executionId=${entry.executionId}, PID=${entry.proc.pid}）`);
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(entry.proc.pid), '/f', '/t'], { windowsHide: true });
    } else {
      entry.proc.kill('SIGKILL');
    }
  } catch (e) {
    console.warn('⚠️ [MAIN-STREAM] 释放服务进程失败:', e);
  }
});

/**
 * 🔥 IPC 通信：取消命令执行
 */
ipcMain.on('system:cancel-command', (event, { executionId }) => {
  console.log('🛑 [MAIN-STREAM] 收到取消命令请求:', executionId);
  const processInfo = runningProcesses.get(executionId);
  if (processInfo && !processInfo.proc.killed) {
    console.log('🛑 [MAIN-STREAM] 正在终止进程:', processInfo.proc.pid);
    // 🔥 标记为已取消
    processInfo.cancelled = true;
    // Windows 上使用 taskkill 终止进程树
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', processInfo.proc.pid.toString(), '/f', '/t']);
      killer.on('close', () => {
        // taskkill 完成，proc 的 close 事件会被触发，不需要额外处理
        console.log('🛑 [MAIN-STREAM] taskkill 完成:', executionId);
      });
    } else {
      processInfo.proc.kill('SIGTERM');
    }
    // 不要立即删除，让 close 事件处理
    // runningProcesses.delete(executionId);
  }
});

/**
 * 🔥 IPC 通信：本地存储 API（SQLite）
 * 注意：这里通过 HTTP 调用后端 local-storage 服务
 * 🔥 使用函数动态获取 URL，确保使用最新的 BACKEND_PORT 值
 */
const getBackendStorageUrl = () => `http://127.0.0.1:${BACKEND_PORT}/api/local`;

/**
 * 🔥 User Storage API URL
 */
const getBackendUserStorageUrl = () => `http://127.0.0.1:${BACKEND_PORT}/api/user-storage`;

// Conversation 操作
ipcMain.handle('local-storage:conversation:create', async (_, data) => {
  try {
    const response = await fetch(`${getBackendStorageUrl()}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await response.json() as { data?: any };
    return result.data || null;
  } catch (error) {
    console.error('[IPC] createConversation error:', error);
    return null;
  }
});

ipcMain.handle('local-storage:conversation:getByUserId', async (_, { userId, limit, offset }) => {
  try {
    const query = new URLSearchParams({ user_id: userId, limit: String(limit || 50), offset: String(offset || 0) });
    const response = await fetch(`${getBackendStorageUrl()}/conversations?${query}`);
    const result = await response.json() as { data?: any[] };
    return result.data || []; // 返回数组而不是 { data: [...] }
  } catch (error) {
    console.error('[IPC] getConversationsByUserId error:', error);
    return []; // 返回空数组而不是抛出错误
  }
});

ipcMain.handle('local-storage:conversation:getById', async (_, id) => {
  try {
    const response = await fetch(`${getBackendStorageUrl()}/conversations/${id}`);
    const result = await response.json() as { data?: any };
    return result.data || null;
  } catch (error) {
    console.error('[IPC] getConversationById error:', error);
    return null;
  }
});

ipcMain.handle('local-storage:conversation:update', async (_, { id, updates }) => {
  try {
    const response = await fetch(`${getBackendStorageUrl()}/conversations/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    const result = await response.json() as { data?: any };
    return !!result.data;
  } catch (error) {
    console.error('[IPC] updateConversation error:', error);
    return false;
  }
});

ipcMain.handle('local-storage:conversation:delete', async (_, id) => {
  try {
    const response = await fetch(`${getBackendStorageUrl()}/conversations/${id}`, {
      method: 'DELETE'
    });
    const result = await response.json() as { success?: boolean };
    return result.success || false;
  } catch (error) {
    console.error('[IPC] deleteConversation error:', error);
    return false;
  }
});

// Message 操作
ipcMain.handle('local-storage:message:create', async (_, data) => {
  try {
    const { conversation_id, role, content, metadata, files, api_role, result, status, call_id, icon_text, session_id, memory } = data;

    if (!conversation_id) {
      console.error('[IPC] Missing conversation_id!');
      return null;
    }

    const response = await fetch(`${getBackendStorageUrl()}/conversations/${conversation_id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, content, metadata, files, api_role, result, status, call_id, icon_text, session_id, memory })
    });
    if (!response.ok) {
      console.error('[IPC] createMessage HTTP error:', response.status, await response.text());
      return null;
    }
    const responseData = await response.json() as { data?: any };
    return responseData.data || null;
  } catch (error) {
    console.error('[IPC] createMessage error:', error);
    return null;
  }
});

ipcMain.handle('local-storage:message:getByConversationId', async (_, { conversationId, limit, offset }) => {
  // console.log('[IPC] getMessagesByConversationId:', { conversationId, limit, offset });
  try {
    const url = `${getBackendStorageUrl()}/conversations/${conversationId}/messages?limit=${limit || 100}&offset=${offset || 0}`;
    // console.log('[IPC] Fetching:', url);
    const response = await fetch(url);
    // console.log('[IPC] Response status:', response.status);
    const result = await response.json() as { data?: any[] };
    // console.log('[IPC] Result:', { hasData: !!result.data, count: result.data?.length || 0 });
    return result.data || [];
  } catch (error) {
    console.error('[IPC] getMessagesByConversationId error:', error);
    return [];
  }
});

ipcMain.handle('local-storage:message:getCount', async (_, conversationId) => {
  // console.log('[IPC] getMessageCount:', conversationId);
  try {
    const url = `${getBackendStorageUrl()}/conversations/${conversationId}/messages/count`;
    // console.log('[IPC] Fetching:', url);
    const response = await fetch(url);
    // console.log('[IPC] Response status:', response.status);
    const result = await response.json() as { count?: number };
    // console.log('[IPC] Result:', { count: result.count });
    return result.count || 0;
  } catch (error) {
    console.error('[IPC] getMessageCount error:', error);
    return 0;
  }
});

// 🔥 通过 call_id 更新消息
ipcMain.handle('local-storage:message:updateByCallId', async (_, { conversationId, callId, updates }) => {
  try {
    const url = `${getBackendStorageUrl()}/conversations/${conversationId}/messages/${callId}`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    if (!response.ok) {
      console.error('[IPC] updateMessageByCallId HTTP error:', response.status);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[IPC] updateMessageByCallId error:', error);
    return false;
  }
});

// 🔥 获取指定矩阵坐标的消息
ipcMain.handle('local-storage:message:getCoordMessages', async (_, { conversationId, widthIndex, depth }) => {
  try {
    const url = `${getBackendStorageUrl()}/conversations/${conversationId}/messages/coord?widthIndex=${widthIndex}&depth=${depth}`;
    const response = await fetch(url);
    const result = await response.json() as { data?: any[] };
    return result.data || [];
  } catch (error) {
    console.error('[IPC] getCoordMessages error:', error);
    return [];
  }
});

// 🔥 获取指定会话的消息
ipcMain.handle('local-storage:message:getSessionMessages', async (_, { conversationId, sessionId }) => {
  try {
    const url = `${getBackendStorageUrl()}/conversations/${conversationId}/messages/session?sessionId=${sessionId}`;
    const response = await fetch(url);
    const result = await response.json() as { data?: any[] };
    return result.data || [];
  } catch (error) {
    console.error('[IPC] getSessionMessages error:', error);
    return [];
  }
});

// 🔥 ExecutionSnapshot IPC 处理
ipcMain.handle('local-storage:execution-snapshot:create', async (_, data) => {
  // console.log('[IPC] createExecutionSnapshot:', { id: data.id, conversationId: data.conversation_id });
  try {
    const url = `${getBackendStorageUrl()}/execution-snapshots`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await response.json() as { data?: any };
    // console.log('[IPC] createExecutionSnapshot result:', result);
    return result.data;
  } catch (error) {
    console.error('[IPC] createExecutionSnapshot error:', error);
    return null;
  }
});

ipcMain.handle('local-storage:execution-snapshot:getById', async (_, id) => {
  // console.log('[IPC] getExecutionSnapshotById:', id);
  try {
    const url = `${getBackendStorageUrl()}/execution-snapshots/${id}`;
    const response = await fetch(url);
    const result = await response.json() as { data?: any };
    return result.data;
  } catch (error) {
    console.error('[IPC] getExecutionSnapshotById error:', error);
    return null;
  }
});

ipcMain.handle('local-storage:execution-snapshot:getByConversationId', async (_, conversationId) => {
  // console.log('[IPC] getExecutionSnapshotsByConversationId:', conversationId);
  try {
    const url = `${getBackendStorageUrl()}/execution-snapshots?conversationId=${conversationId}`;
    const response = await fetch(url);
    const result = await response.json() as { data?: any[] };
    return result.data || [];
  } catch (error) {
    console.error('[IPC] getExecutionSnapshotsByConversationId error:', error);
    return [];
  }
});

ipcMain.handle('local-storage:execution-snapshot:update', async (_, { id, updates }) => {
  // console.log('[IPC] updateExecutionSnapshot:', { id, updates });
  try {
    const url = `${getBackendStorageUrl()}/execution-snapshots/${id}`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    return response.ok;
  } catch (error) {
    console.error('[IPC] updateExecutionSnapshot error:', error);
    return false;
  }
});

ipcMain.handle('local-storage:execution-snapshot:delete', async (_, id) => {
  // console.log('[IPC] deleteExecutionSnapshot:', id);
  try {
    const url = `${getBackendStorageUrl()}/execution-snapshots/${id}`;
    const response = await fetch(url, { method: 'DELETE' });
    return response.ok;
  } catch (error) {
    console.error('[IPC] deleteExecutionSnapshot error:', error);
    return false;
  }
});

// ==========================================
// 🔥 本地文件存储 IPC 处理器
// ==========================================

ipcMain.handle('local-storage:message:createBatch', async (_, messages) => {
  try {
    // 批量创建消息需要逐个调用，因为后端没有批量接口
    const results = [];
    for (const message of messages) {
      const { conversation_id, role, content, metadata } = message;
      const response = await fetch(`${getBackendStorageUrl()}/conversations/${conversation_id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, content, metadata })
      });
      const result = await response.json() as { data?: any };
      if (result.data) {
        results.push(result.data);
      }
    }
    return results;
  } catch (error) {
    console.error('[IPC] createBatchMessages error:', error);
    return [];
  }
});

// ==========================================
// 🔥 Tool Storage IPC 处理器
// ==========================================

ipcMain.handle('user-storage:create-table', async (_, { tableName, columns, replaceIfExists, userId }) => {
  // console.log('[IPC] user-storage:create-table:', { tableName, replaceIfExists, userId });
  try {
    const url = `${getBackendUserStorageUrl()}/tables`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-User-Id': userId 
      },
      body: JSON.stringify({ tableName, columns, replaceIfExists })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    return { success: true, data: result };
  } catch (error) {
    console.error('[IPC] user-storage:create-table error:', error);
    return { success: false, error: error instanceof Error ? error.message : '创建表失败' };
  }
});

ipcMain.handle('user-storage:get-tables', async (_, { userId }) => {
  // console.log('[IPC] user-storage:get-tables:', { userId });
  try {
    const url = `${getBackendUserStorageUrl()}/tables`;
    const response = await fetch(url, {
      headers: { 'X-User-Id': userId }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json() as any;
    return result.tables || [];
  } catch (error) {
    console.error('[IPC] user-storage:get-tables error:', error);
    return [];
  }
});

ipcMain.handle('user-storage:get-table-schema', async (_, { tableName, userId }) => {
  // console.log('[IPC] user-storage:get-table-schema:', { tableName, userId });
  try {
    const url = `${getBackendUserStorageUrl()}/tables/${tableName}`;
    const response = await fetch(url, {
      headers: { 'X-User-Id': userId }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json() as any;
    return result.table || result;
  } catch (error) {
    console.error('[IPC] user-storage:get-table-schema error:', error);
    return null;
  }
});

ipcMain.handle('user-storage:get-table-data', async (_, { tableName, limit, offset, userId }) => {
  // console.log('[IPC] user-storage:get-table-data:', { tableName, limit, offset, userId });
  try {
    const queryStr = new URLSearchParams();
    if (limit) queryStr.append('limit', String(limit));
    if (offset) queryStr.append('offset', String(offset));
    const url = `${getBackendUserStorageUrl()}/data/${tableName}?${queryStr.toString()}`;
    const response = await fetch(url, {
      headers: { 'X-User-Id': userId }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json() as any;
    return result.data || [];
  } catch (error) {
    console.error('[IPC] user-storage:get-table-data error:', error);
    return [];
  }
});

ipcMain.handle('user-storage:insert', async (_, { tableName, data, userId }) => {
  // console.log('[IPC] user-storage:insert:', { tableName, userId });
  try {
    const url = `${getBackendUserStorageUrl()}/data`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-User-Id': userId 
      },
      body: JSON.stringify({ tableName, data })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    return { success: true, data: result };
  } catch (error) {
    console.error('[IPC] user-storage:insert error:', error);
    return { success: false, error: error instanceof Error ? error.message : '插入数据失败' };
  }
});

ipcMain.handle('user-storage:update', async (_, { tableName, data, where, userId }) => {
  // console.log('[IPC] user-storage:update:', { tableName, userId });
  try {
    const url = `${getBackendUserStorageUrl()}/data/${tableName}`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 
        'Content-Type': 'application/json',
        'X-User-Id': userId 
      },
      body: JSON.stringify({ data, where })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    return { success: true, data: result };
  } catch (error) {
    console.error('[IPC] user-storage:update error:', error);
    return { success: false, error: error instanceof Error ? error.message : '更新数据失败' };
  }
});

ipcMain.handle('user-storage:delete', async (_, { tableName, where, clearAll, userId }) => {
  console.log('[IPC] user-storage:delete:', { tableName, clearAll, userId });
  try {
    const params = new URLSearchParams();
    if (where) {
      params.append('where', JSON.stringify(where));
    }
    if (clearAll) {
      params.append('clearAll', 'true');
    }
    const url = `${getBackendUserStorageUrl()}/data/${tableName}?${params.toString()}`;
    const response = await fetch(url, {
      method: 'DELETE',
      headers: { 
        'Content-Type': 'application/json',
        'X-User-Id': userId 
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    return { success: true, data: result };
  } catch (error) {
    console.error('[IPC] user-storage:delete error:', error);
    return { success: false, error: error instanceof Error ? error.message : '删除数据失败' };
  }
});

ipcMain.handle('user-storage:drop-table', async (_, { tableName, userId }) => {
  // console.log('[IPC] user-storage:drop-table:', { tableName, userId });
  try {
    const url = `${getBackendUserStorageUrl()}/tables/${tableName}`;
    const response = await fetch(url, { 
      method: 'DELETE',
      headers: { 'X-User-Id': userId }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    return { success: true, data: result };
  } catch (error) {
    console.error('[IPC] user-storage:drop-table error:', error);
    return { success: false, error: error instanceof Error ? error.message : '删除表失败' };
  }
});

ipcMain.handle('user-storage:alter-table', async (_, { tableName, addColumns, dropColumns, renameTo, userId }) => {
  console.log('[IPC] user-storage:alter-table:', { tableName, addColumns, dropColumns, renameTo, userId });
  try {
    const url = `${getBackendUserStorageUrl()}/tables/${tableName}`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 
        'Content-Type': 'application/json',
        'X-User-Id': userId 
      },
      body: JSON.stringify({ addColumns, dropColumns, renameTo })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    return { success: true, data: result };
  } catch (error) {
    console.error('[IPC] user-storage:alter-table error:', error);
    return { success: false, error: error instanceof Error ? error.message : '修改表失败' };
  }
});

ipcMain.handle('user-storage:execute-sql', async (_, { sql, userId }) => {
  console.log('[IPC] user-storage:execute-sql:', { sql: sql?.substring(0, 100) + (sql?.length > 100 ? '...' : ''), userId });
  try {
    const url = `${getBackendUserStorageUrl()}/sql`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-User-Id': userId 
      },
      body: JSON.stringify({ sql })
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string };
      throw new Error(errorData.error || `HTTP ${response.status}`);
    }
    const result = await response.json() as { data?: any; columns?: string[] };
    return { success: true, data: result.data, columns: result.columns };
  } catch (error) {
    console.error('[IPC] user-storage:execute-sql error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'SQL 执行失败' };
  }
});

// ==========================================
// 🔥 本地文件存储 IPC 处理器
// ==========================================

import * as pathModule from 'path';

/**
 * 获取文件存储根目录
 * 区分开发和生产环境
 */
function getFilesRootDir(): string {
  const isDev = !app.isPackaged;
  const userDataDir = isDev
    ? pathModule.join(app.getPath('userData'), 'dev')
    : app.getPath('userData');
  return pathModule.join(userDataDir, 'files');
}

/**
 * 确保文件存储目录存在
 */
function ensureFilesRootDir(): string {
  const dir = getFilesRootDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log('📁 [LOCAL-FILE] 创建文件存储目录:', dir);
  }
  return dir;
}

/**
 * 获取对话的文件目录
 */
function getConversationDir(conversationId: string): string {
  const dir = pathModule.join(getFilesRootDir(), conversationId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * 保存文件到本地
 */
ipcMain.handle('local-file:save', async (_, { conversationId, fileName, content, mimeType }) => {
  try {
    const conversationDir = getConversationDir(conversationId);
    const filePath = pathModule.join(conversationDir, fileName);
    
    // 🔥 处理两种格式的 content
    // 1. data URL 格式：data:application/...;base64,...
    // 2. 纯 base64 格式：...base64content...
    let base64Content = content;
    
    if (content.startsWith('data:')) {
      // 🔥 提取 data URL 中的 base64 部分
      const matches = content.match(/^data:[^;]*;base64,(.+)$/);
      if (matches && matches[1]) {
        base64Content = matches[1];
      } else {
        console.error('❌ [LOCAL-FILE] data URL 格式解析失败');
        return { success: false, error: 'data URL 格式解析失败' };
      }
    }
    
    // 将 base64 内容转换为 Buffer 并保存
    const buffer = Buffer.from(base64Content, 'base64');
    fs.writeFileSync(filePath, buffer);
    
    console.log('✅ [LOCAL-FILE] 文件已保存:', filePath);
    return { success: true, localPath: filePath };
  } catch (error) {
    console.error('❌ [LOCAL-FILE] 保存文件失败:', error);
    return { success: false, error: error instanceof Error ? error.message : '保存文件失败' };
  }
});

/**
 * 🔥 下载外部 URL（绕过 CORS）
 * 主进程不受 CORS 限制，可以直接下载
 */
ipcMain.handle('local-file:download-url', async (_, { url, mimeType }) => {
  try {
    console.log('📥 [LOCAL-FILE] 主进程下载URL:', url.substring(0, 100) + '...');
    
    const https = require('https');
    const http = require('http');
    const client = url.startsWith('https://') ? https : http;
    
    return new Promise((resolve) => {
      const request = client.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      }, (response: any) => {
        // 处理重定向
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          console.log('🔄 [LOCAL-FILE] 重定向到:', redirectUrl);
          // 递归处理重定向
          ipcMain.emit('local-file:download-url', _, { url: redirectUrl, mimeType });
          return;
        }
        
        if (response.statusCode !== 200) {
          resolve({ success: false, error: `HTTP ${response.statusCode}` });
          return;
        }
        
        const chunks: Buffer[] = [];
        const contentType = response.headers['content-type'] || mimeType || 'application/octet-stream';
        
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const base64 = buffer.toString('base64');
          console.log('✅ [LOCAL-FILE] 下载完成:', { size: buffer.length, contentType });
          resolve({ 
            success: true, 
            base64: `data:${contentType};base64,${base64}`,
            size: buffer.length 
          });
        });
        response.on('error', (err: Error) => {
          console.error('❌ [LOCAL-FILE] 响应错误:', err);
          resolve({ success: false, error: err.message });
        });
      });
      
      request.on('error', (err: Error) => {
        console.error('❌ [LOCAL-FILE] 请求错误:', err);
        resolve({ success: false, error: err.message });
      });
      
      // 60秒超时
      request.setTimeout(60000, () => {
        request.destroy();
        resolve({ success: false, error: '下载超时' });
      });
    });
  } catch (error) {
    console.error('❌ [LOCAL-FILE] 下载URL失败:', error);
    return { success: false, error: error instanceof Error ? error.message : '下载失败' };
  }
});

/**
 * 读取本地文件
 */
ipcMain.handle('local-file:read', async (_, { localPath }) => {
  try {
    if (!fs.existsSync(localPath)) {
      return { success: false, error: '文件不存在' };
    }
    
    const buffer = fs.readFileSync(localPath);
    const content = buffer.toString('base64');
    
    return { success: true, content };
  } catch (error) {
    console.error('❌ [LOCAL-FILE] 读取文件失败:', error);
    return { success: false, error: error instanceof Error ? error.message : '读取文件失败' };
  }
});

/**
 * 删除本地文件
 */
ipcMain.handle('local-file:delete', async (_, { localPath }) => {
  try {
    if (fs.existsSync(localPath)) {
      fs.unlinkSync(localPath);
      console.log('✅ [LOCAL-FILE] 文件已删除:', localPath);
    }
    return { success: true };
  } catch (error) {
    console.error('❌ [LOCAL-FILE] 删除文件失败:', error);
    return { success: false, error: error instanceof Error ? error.message : '删除文件失败' };
  }
});

/**
 * 检查文件是否存在
 */
ipcMain.handle('local-file:exists', async (_, { localPath }) => {
  try {
    const exists = fs.existsSync(localPath);
    return { exists };
  } catch (error) {
    console.error('❌ [LOCAL-FILE] 检查文件存在性失败:', error);
    return { exists: false };
  }
});

/**
 * 🔥 追加内容到文件（用于动态知识库写入）
 * 支持绝对路径和项目相对路径（以 src/ 开头）
 */
ipcMain.handle('local-file:append', async (_, { localPath, content }) => {
  try {
    let resolvedPath = localPath;
    // 🔥 如果是项目相对路径（以 src/ 开头），转换为绝对路径
    if (localPath.startsWith('src/') || localPath.startsWith('src\\')) {
      const projectRoot = app.isPackaged
        ? path.join(process.resourcesPath, 'app')
        : path.join(__dirname, '..');
      resolvedPath = path.join(projectRoot, localPath);
    }

    if (!fs.existsSync(resolvedPath)) {
      return { success: false, error: '文件不存在: ' + resolvedPath };
    }
    fs.appendFileSync(resolvedPath, content, 'utf-8');
    console.log('✅ [LOCAL-FILE] 追加内容成功:', resolvedPath);
    return { success: true };
  } catch (error) {
    console.error('❌ [LOCAL-FILE] 追加内容失败:', error);
    return { success: false, error: String(error) };
  }
});

/**
 * 获取对话的所有文件
 */
ipcMain.handle('local-file:getByConversation', async (_, { conversationId }) => {
  try {
    const conversationDir = pathModule.join(getFilesRootDir(), conversationId);
    if (!fs.existsSync(conversationDir)) {
      return { files: [] };
    }
    
    const files = fs.readdirSync(conversationDir)
      .map(file => pathModule.join(conversationDir, file))
      .filter(filePath => fs.statSync(filePath).isFile());
    
    return { files };
  } catch (error) {
    console.error('❌ [LOCAL-FILE] 获取文件列表失败:', error);
    return { files: [] };
  }
});

/**
 * 清理对话的所有文件
 */
ipcMain.handle('local-file:cleanup', async (_, { conversationId }) => {
  try {
    const conversationDir = pathModule.join(getFilesRootDir(), conversationId);
    if (fs.existsSync(conversationDir)) {
      // 删除文件夹及其所有内容
      fs.rmSync(conversationDir, { recursive: true, force: true });
      console.log('✅ [LOCAL-FILE] 已清理对话文件:', conversationId);
    }
    return { success: true };
  } catch (error) {
    console.error('❌ [LOCAL-FILE] 清理文件失败:', error);
    return { success: false, error: error instanceof Error ? error.message : '清理文件失败' };
  }
});

// ==========================================
// 🔥 App 代码文件存储 IPC 处理器
// ==========================================

/**
 * 🔥 获取 App 代码目录
 * @param appId 应用ID
 * @param codePath 可选的自定义路径（导入项目时由前端传入）
 * - codePath 非空时：直接返回 codePath（用户指定的目录）
 * - codePath 为空时：返回默认的 userDataPath/apps/{appId}
 */
function getAppCodeDir(appId: string, codePath?: string): string {
  if (codePath) {
    return codePath;
  }
  const appCodeRoot = pathModule.join(app.getPath('userData'), 'apps');
  return pathModule.join(appCodeRoot, appId);
}

/**
 * 🔥 获取 App 默认目录（不受 codePath 影响，用于 history 等固定位置）
 */
function getAppDefaultDir(appId: string): string {
  const appCodeRoot = pathModule.join(app.getPath('userData'), 'apps');
  return pathModule.join(appCodeRoot, appId);
}

/**
 * 确保目录存在
 */
function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * 保存 App 代码文件
 */
ipcMain.handle('app-code:save', async (_, { appId, fileName, content, codePath }) => {
  try {
    const appDir = getAppCodeDir(appId, codePath);
    ensureDir(appDir);
    
    const filePath = pathModule.join(appDir, fileName);
    
    // 🔥 检查文件是否存在
    const fileExists = fs.existsSync(filePath);
    
    // 🔥 如果文件已存在，先备份当前版本到 history 目录
    // 🔥 history 始终在默认路径下（不受 codePath 影响）
    if (fileExists) {
      const defaultDir = getAppDefaultDir(appId);
      const historyDir = pathModule.join(defaultDir, 'history', fileName);
      
      // 🔥 检查 history 目录下是否已有该文件的版本目录
      if (!fs.existsSync(historyDir)) {
        // 🔥 创建 history 文件目录
        fs.mkdirSync(historyDir, { recursive: true });
        
        // 🔥 备份当前版本到 history 目录（命名为 v1）
        const ext = fileName.split('.').pop() || 'txt';
        const versionFileName = `v1.${ext}`;
        const versionFilePath = pathModule.join(historyDir, versionFileName);
        fs.copyFileSync(filePath, versionFilePath);
        
        console.log('✅ [APP-CODE] 备份当前版本成功:', versionFilePath);
      }
    }
    
    // 🔥 确保子目录存在
    const fileDir = pathModule.dirname(filePath);
    if (!fs.existsSync(fileDir)) {
      fs.mkdirSync(fileDir, { recursive: true });
    }
    
    // 🔥 使用 Buffer 确保正确的 UTF-8 编码（带 BOM）
    const BOM = '\ufeff';
    const buffer = Buffer.from(BOM + content, 'utf-8');
    fs.writeFileSync(filePath, buffer);
    
    console.log('✅ [APP-CODE] 代码文件已保存 (UTF-8 with BOM):', filePath);
    return { success: true, localPath: filePath };
  } catch (error) {
    console.error('❌ [APP-CODE] 保存代码文件失败:', error);
    return { success: false, error: error instanceof Error ? error.message : '保存失败' };
  }
});

/**
 * 读取 App 代码文件
 */
ipcMain.handle('app-code:read', async (_, { appId, fileName, codePath }) => {
  try {
    const appDir = getAppCodeDir(appId, codePath);
    const filePath = pathModule.join(appDir, fileName);
    
    if (!fs.existsSync(filePath)) {
      return { success: false, error: '文件不存在' };
    }
    
    let content = fs.readFileSync(filePath, 'utf-8');
    // 🔥 去除 BOM（如果存在）
    if (content.charCodeAt(0) === 0xfeff) {
      content = content.slice(1);
    }
    
    return { success: true, content };
  } catch (error) {
    console.error('❌ [APP-CODE] 读取代码文件失败:', error);
    return { success: false, error: error instanceof Error ? error.message : '读取失败' };
  }
});

/**
 * 检查 App 代码文件是否存在
 */
ipcMain.handle('app-code:exists', async (_, { appId, fileName, codePath }) => {
  try {
    const appDir = getAppCodeDir(appId, codePath);
    const filePath = pathModule.join(appDir, fileName);
    const exists = fs.existsSync(filePath);
    return { exists };
  } catch (error) {
    console.error('❌ [APP-CODE] 检查文件存在性失败:', error);
    return { exists: false };
  }
});

/**
 * 复制 App 代码文件
 */
ipcMain.handle('app-code:copy', async (_, { appId, sourceFileName, targetFileName, codePath }) => {
  try {
    const appDir = getAppCodeDir(appId, codePath);
    const sourcePath = pathModule.join(appDir, sourceFileName);
    const targetPath = pathModule.join(appDir, targetFileName);
    
    if (!fs.existsSync(sourcePath)) {
      return { success: false, error: '源文件不存在' };
    }
    
    fs.copyFileSync(sourcePath, targetPath);
    
    console.log('✅ [APP-CODE] 代码文件已复制:', { source: sourcePath, target: targetPath });
    return { success: true };
  } catch (error) {
    console.error('❌ [APP-CODE] 复制代码文件失败:', error);
    return { success: false, error: error instanceof Error ? error.message : '复制失败' };
  }
});

/**
 * 🔥 拆分版本：复制整个 App 代码目录（含 history）到新 App
 * 使用异步复制避免阻塞主进程
 */
ipcMain.handle('app-code:fork', async (_, { sourceAppId, targetAppId, codePath }) => {
  try {
    const sourceDir = getAppCodeDir(sourceAppId, codePath);
    const targetDir = getAppCodeDir(targetAppId); // fork 出来的新 app 始终用默认路径

    if (!fs.existsSync(sourceDir)) {
      return { success: false, error: '源应用目录不存在' };
    }

    if (fs.existsSync(targetDir)) {
      return { success: false, error: '目标应用目录已存在' };
    }

    // 🔥 异步复制整个目录（含 files 和 history 子目录），不阻塞主进程
    await fs.promises.cp(sourceDir, targetDir, { recursive: true });

    console.log('✅ [APP-CODE] 拆分版本成功:', { source: sourceDir, target: targetDir });
    return { success: true };
  } catch (error) {
    console.error('❌ [APP-CODE] 拆分版本失败:', error);
    return { success: false, error: error instanceof Error ? error.message : '拆分版本失败' };
  }
});

/**
 * 🔥 删除目录（Windows 强化版）：
 * 1. git clone 的项目里 .git 对象文件全部带只读属性，rmSync 删只读文件报 EPERM
 *    → 先用 attrib -r 递归剥掉只读属性再删
 * 2. Defender/索引服务可能短暂锁住句柄 → 删失败时延迟重试
 */
function removeDirRobust(targetPath: string): void {
  const isWindows = process.platform === 'win32';
  const tryRemove = (): boolean => {
    try {
      if (isWindows) {
        // /S /D 递归处理目录及文件（含目录本身），静默失败不阻塞
        spawnSync('attrib', ['-r', targetPath + '\\*.*', '/s', '/d'], { windowsHide: true });
      }
      fs.rmSync(targetPath, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  };
  if (tryRemove()) return;
  // 句柄被短暂占用（杀毒扫描/索引）：等 400ms 再试两次
  for (let i = 0; i < 2; i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); // 同步 sleep，不阻塞事件循环的替代方案有限，此处删除操作短暂可接受
    if (tryRemove()) return;
  }
  // 最后一次直接抛出让上层返回错误
  fs.rmSync(targetPath, { recursive: true, force: true });
}

/**
 * 🔥 删除 App 代码文件或目录
 * 跨平台：使用 Node.js fs API，不依赖 PowerShell/Bash
 */
ipcMain.handle('app-code:delete', async (_, { appId, fileName, isDirectory, codePath }: { appId: string; fileName: string; isDirectory?: boolean; codePath?: string }) => {
  try {
    const appDir = getAppCodeDir(appId, codePath);
    const filePath = pathModule.join(appDir, fileName);

    if (!fs.existsSync(filePath)) {
      return { success: true }; // 文件不存在也返回成功（幂等）
    }

    if (fs.statSync(filePath).isDirectory()) {
      removeDirRobust(filePath);
    } else {
      fs.unlinkSync(filePath);
    }

    // 🔥 同时删除 history 中的版本（始终在默认路径下）
    const defaultDir = getAppDefaultDir(appId);
    const historyPath = pathModule.join(defaultDir, 'history', fileName);
    if (fs.existsSync(historyPath)) {
      if (fs.statSync(historyPath).isDirectory()) {
        removeDirRobust(historyPath);
      } else {
        fs.unlinkSync(historyPath);
      }
    }

    console.log('✅ [APP-CODE] 已删除:', fileName);
    return { success: true };
  } catch (error) {
    console.error('❌ [APP-CODE] 删除失败:', error);
    return { success: false, error: error instanceof Error ? error.message : '删除失败' };
  }
});

/**
 * 🔥 重命名 App 代码文件
 * 跨平台：使用 Node.js fs API
 */
ipcMain.handle('app-code:rename', async (_, { appId, oldFileName, newFileName, codePath }: { appId: string; oldFileName: string; newFileName: string; codePath?: string }) => {
  try {
    const appDir = getAppCodeDir(appId, codePath);
    const oldPath = pathModule.join(appDir, oldFileName);
    const newPath = pathModule.join(appDir, newFileName);

    if (!fs.existsSync(oldPath)) {
      return { success: false, error: '源文件不存在' };
    }
    if (fs.existsSync(newPath)) {
      return { success: false, error: '文件名已存在' };
    }

    // 🔥 确保目标目录存在
    const newDir = pathModule.dirname(newPath);
    if (!fs.existsSync(newDir)) {
      fs.mkdirSync(newDir, { recursive: true });
    }

    fs.renameSync(oldPath, newPath);

    // 🔥 同时重命名 history 中的版本（始终在默认路径下）
    const defaultDir = getAppDefaultDir(appId);
    const oldHistoryPath = pathModule.join(defaultDir, 'history', oldFileName);
    const newHistoryPath = pathModule.join(defaultDir, 'history', newFileName);
    if (fs.existsSync(oldHistoryPath)) {
      const newHistoryDir = pathModule.dirname(newHistoryPath);
      if (!fs.existsSync(newHistoryDir)) {
        fs.mkdirSync(newHistoryDir, { recursive: true });
      }
      fs.renameSync(oldHistoryPath, newHistoryPath);
    }

    console.log('✅ [APP-CODE] 已重命名:', oldFileName, '->', newFileName);
    return { success: true };
  } catch (error) {
    console.error('❌ [APP-CODE] 重命名失败:', error);
    return { success: false, error: error instanceof Error ? error.message : '重命名失败' };
  }
});

/**
 * 🔥 Commit - 清空 history 目录
 * 跨平台：使用 Node.js fs API
 */
ipcMain.handle('app-code:commit', async (_, { appId, fileName, codePath }: { appId: string; fileName?: string; codePath?: string }) => {
  try {
    // 🔥 history 始终在默认路径下（不受 codePath 影响）
    const defaultDir = getAppDefaultDir(appId);
    const historyDir = pathModule.join(defaultDir, 'history');

    if (!fs.existsSync(historyDir)) {
      return { success: true };
    }

    if (fileName) {
      // 🔥 只清空指定文件的历史版本
      const fileHistoryDir = pathModule.join(historyDir, fileName);
      if (fs.existsSync(fileHistoryDir)) {
        fs.rmSync(fileHistoryDir, { recursive: true, force: true });
      }
      console.log('✅ [APP-CODE] 已清空文件历史版本:', fileName);
    } else {
      // 🔥 清空整个 history 目录内容
      const items = fs.readdirSync(historyDir);
      for (const item of items) {
        const itemPath = pathModule.join(historyDir, item);
        fs.rmSync(itemPath, { recursive: true, force: true });
      }
      console.log('✅ [APP-CODE] 已清空 history 目录:', appId);
    }

    return { success: true };
  } catch (error) {
    console.error('❌ [APP-CODE] commit 失败:', error);
    return { success: false, error: error instanceof Error ? error.message : '清空失败' };
  }
});

/**
 * 🔥 保存历史版本（将当前文件备份到 history 目录）
 * 跨平台：使用 Node.js fs API
 */
ipcMain.handle('app-code:save-history', async (_, { appId, fileName, codePath }: { appId: string; fileName: string; codePath?: string }) => {
  try {
    // 🔥 当前文件从 codePath 目录读取
    const appDir = getAppCodeDir(appId, codePath);
    const currentFilePath = pathModule.join(appDir, fileName);

    if (!fs.existsSync(currentFilePath)) {
      return { success: false, error: '当前文件不存在' };
    }

    // 🔥 history 始终存到默认路径下
    const defaultDir = getAppDefaultDir(appId);
    const ext = fileName.split('.').pop() || 'txt';
    const fileHistoryDir = pathModule.join(defaultDir, 'history', fileName);
    const historyFilePath = pathModule.join(fileHistoryDir, `v1.${ext}`);

    // 🔥 如果 history 中已有版本，跳过
    if (fs.existsSync(historyFilePath)) {
      return { success: true, skipped: true };
    }

    // 🔥 创建 history 目录
    if (!fs.existsSync(fileHistoryDir)) {
      fs.mkdirSync(fileHistoryDir, { recursive: true });
    }

    // 🔥 复制当前文件到 history
    fs.copyFileSync(currentFilePath, historyFilePath);

    console.log('✅ [APP-CODE] 已保存历史版本:', historyFilePath);
    return { success: true };
  } catch (error) {
    console.error('❌ [APP-CODE] 保存历史版本失败:', error);
    return { success: false, error: error instanceof Error ? error.message : '保存历史版本失败' };
  }
});

/**
 * 🔥 读取历史版本内容
 * 跨平台：使用 Node.js fs API
 */
ipcMain.handle('app-code:read-history', async (_, { appId, fileName, codePath }: { appId: string; fileName: string; codePath?: string }) => {
  try {
    // 🔥 history 始终在默认路径下
    const defaultDir = getAppDefaultDir(appId);
    const ext = fileName.split('.').pop() || 'txt';
    const historyFilePath = pathModule.join(defaultDir, 'history', fileName, `v1.${ext}`);

    if (!fs.existsSync(historyFilePath)) {
      return { success: false, error: '历史版本不存在' };
    }

    let content = fs.readFileSync(historyFilePath, 'utf-8');
    // 🔥 去除 BOM
    if (content.charCodeAt(0) === 0xfeff) {
      content = content.slice(1);
    }

    return { success: true, content };
  } catch (error) {
    console.error('❌ [APP-CODE] 读取历史版本失败:', error);
    return { success: false, error: error instanceof Error ? error.message : '读取历史版本失败' };
  }
});

/**
 * 🔥 检查 App 代码目录是否存在
 * 跨平台：使用 Node.js fs API
 */
ipcMain.handle('app-code:dir-exists', async (_, { appId, dirPath, codePath }: { appId: string; dirPath: string; codePath?: string }) => {
  try {
    const appDir = getAppCodeDir(appId, codePath);
    const fullPath = pathModule.join(appDir, dirPath);
    const exists = fs.existsSync(fullPath);
    return { exists };
  } catch (error) {
    return { exists: false };
  }
});

/**
 * 🔥 确保 App 代码子目录存在
 * 跨平台：使用 Node.js fs API
 */
ipcMain.handle('app-code:ensure-dir', async (_, { appId, dirPath, codePath }: { appId: string; dirPath: string; codePath?: string }) => {
  try {
    const appDir = getAppCodeDir(appId, codePath);
    const fullPath = pathModule.join(appDir, dirPath);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
    return { success: true, path: fullPath };
  } catch (error) {
    console.error('❌ [APP-CODE] 创建目录失败:', error);
    return { success: false, error: error instanceof Error ? error.message : '创建目录失败' };
  }
});

/**
 * 🔥 复制 App 代码目录（版本历史用）
 * 跨平台：使用 Node.js fs API
 */
ipcMain.handle('app-code:copy-dir', async (_, { appId, sourceDir, targetDir, codePath }: { appId: string; sourceDir: string; targetDir: string; codePath?: string }) => {
  try {
    const appDir = getAppCodeDir(appId, codePath);
    const sourcePath = pathModule.join(appDir, sourceDir);
    const targetPath = pathModule.join(appDir, targetDir);

    if (!fs.existsSync(sourcePath)) {
      return { success: false, error: '源目录不存在' };
    }

    // 🔥 递归复制
    fs.cpSync(sourcePath, targetPath, { recursive: true, force: true });

    console.log('✅ [APP-CODE] 已复制目录:', sourceDir, '->', targetDir);
    return { success: true };
  } catch (error) {
    console.error('❌ [APP-CODE] 复制目录失败:', error);
    return { success: false, error: error instanceof Error ? error.message : '复制目录失败' };
  }
});

/**
 * 🔥 文件变化监听器（fs.watch + 去抖动）
 * 用于检测 LLM 通过 Python 等方式直接修改文件的情况（工具系统之外的变化）
 *
 * 性能：fs.watch 是操作系统级通知（inotify/FSEvents），非轮询，零 CPU 开销
 * 去抖动：500ms 内多次变化只通知一次
 * 跨平台：Windows + macOS 都支持 recursive: true
 */
const appCodeWatchers = new Map<string, {
  watcher: fs.FSWatcher;
  debounceTimer: NodeJS.Timeout | null;
  fileMtimes: Map<string, number>; // 🔥 记录每个文件的上次 mtime，用于过滤"查看"触发的噪声
}>();

// 🔥 忽略的文件/目录变化模式（这些变化不认为是"代码修改"）
// - history/：备份目录
// - __pycache__/、.pyc/.pyo：Python 编译缓存
// - .git/：版本控制元数据
// - Thumbs.db、.DS_Store、desktop.ini：系统文件
// - .swp、.swo、.tmp、.bak：临时/备份文件
const IGNORED_CHANGE_PATTERNS = [
  /^(history|__pycache__|\.git)[\\/]/,
  /[\\/](__pycache__|\.git)[\\/]/,
  /\.(pyc|pyo|pyd|swp|swo|tmp|bak)$/i,
  /^(Thumbs\.db|\.DS_Store|desktop\.ini)$/i,
];

function shouldIgnoreFileChange(filename: string | null | undefined): boolean {
  if (!filename) return true;
  // 同时测试原始（反斜杠）和归一化（正斜杠）两种形式
  const normalized = filename.replace(/\\/g, '/');
  return IGNORED_CHANGE_PATTERNS.some(p => p.test(filename) || p.test(normalized));
}

ipcMain.handle('watch-app-code-dir', async (event, { appId, codePath }: { appId: string; codePath?: string }) => {
  try {
    // 如果已经在监听，先停止
    if (appCodeWatchers.has(appId)) {
      const existing = appCodeWatchers.get(appId)!;
      if (existing.debounceTimer) clearTimeout(existing.debounceTimer);
      existing.watcher.close();
      appCodeWatchers.delete(appId);
    }

    const appDir = getAppCodeDir(appId, codePath);
    // 🔥 优先监听 files/ 子目录，如果不存在则监听整个 appDir
    const filesDir = pathModule.join(appDir, 'files');
    const watchDir = fs.existsSync(filesDir) ? filesDir : appDir;

    if (!fs.existsSync(watchDir)) {
      return { success: false, error: '目录不存在' };
    }

    const fileMtimes = new Map<string, number>();

    // 🔥 预填 mtime：避免首次读取文件时误触发通知
    // 问题：fileMtimes 初始为空，首次 stat 时 lastMtime===undefined !== stat.mtimeMs，会穿透到通知逻辑
    // 场景：打开项目时文件树扫描/读取所有文件 → Windows fs.watch 对访问敏感 → 首次触发误报"已保存"
    // 解决：监听启动前先把目录下所有文件的 mtime 填入 Map，首次读取时 lastMtime 已存在且等于当前 mtime，正确 return
    const prefetchMtimes = (dir: string) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (shouldIgnoreFileChange(entry.name)) continue;
          const fullPath = pathModule.join(dir, entry.name);
          if (entry.isDirectory()) {
            prefetchMtimes(fullPath);
          } else {
            try {
              const stat = fs.statSync(fullPath);
              fileMtimes.set(fullPath, stat.mtimeMs);
            } catch {
              // 单文件 stat 失败不影响整体预填
            }
          }
        }
      } catch {
        // 目录读取失败忽略（可能已被删除）
      }
    };
    prefetchMtimes(watchDir);

    const watcher = fs.watch(watchDir, { recursive: true }, async (eventType, filename) => {
      // 🔥 忽略非源代码文件变化（缓存、系统文件、备份等）
      if (shouldIgnoreFileChange(filename)) return;

      const state = appCodeWatchers.get(appId);
      if (!state) return;

      // 🔥 mtime 对比兜底：Windows fs.watch 对文件访问过于敏感
      // 单纯读取文件（Defender 扫描、Indexer 索引、fs.readFile）可能触发 'change' 事件
      // 用 mtime 是否真正变化来区分"查看"和"修改"
      try {
        const fullPath = pathModule.join(watchDir, filename!);
        const stat = await fs.promises.stat(fullPath);
        const lastMtime = state.fileMtimes.get(fullPath);
        if (lastMtime === stat.mtimeMs) {
          return; // mtime 没变 → 是"查看"触发的噪声，忽略
        }
        state.fileMtimes.set(fullPath, stat.mtimeMs);
      } catch {
        // stat 抛错 → 文件被删除/重命名，认为有真实变化，继续通知
      }

      // 🔥 去抖动 500ms
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      state.debounceTimer = setTimeout(() => {
        console.log(`📦 [APP-WATCH] 文件变化: ${appId}/${filename}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('app-code-changed', { appId, filename });
        }
        if (state.debounceTimer) {
          clearTimeout(state.debounceTimer);
          state.debounceTimer = null;
        }
      }, 500);
    });

    watcher.on('error', (err) => {
      console.error(`❌ [APP-WATCH] 监听错误: ${appId}`, err);
    });

    appCodeWatchers.set(appId, { watcher, debounceTimer: null, fileMtimes });
    console.log(`👁️ [APP-WATCH] 开始监听: ${appId} (${watchDir})`);
    return { success: true };
  } catch (error) {
    console.error('❌ [APP-WATCH] 启动监听失败:', error);
    return { success: false, error: error instanceof Error ? error.message : '启动监听失败' };
  }
});

ipcMain.handle('unwatch-app-code-dir', async (_, { appId }: { appId: string }) => {
  try {
    const state = appCodeWatchers.get(appId);
    if (state) {
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      state.watcher.close();
      appCodeWatchers.delete(appId);
      console.log(`👁️ [APP-WATCH] 停止监听: ${appId}`);
    }
    return { success: true };
  } catch (error) {
    console.error('❌ [APP-WATCH] 停止监听失败:', error);
    return { success: false, error: error instanceof Error ? error.message : '停止监听失败' };
  }
});

/**
 * 🔥 显示文件/文件夹选择对话框
 */
ipcMain.handle('show-open-dialog', async (event, options: Electron.OpenDialogOptions & { parent?: 'caller' | 'main' }) => {
  try {
    const { dialog } = require('electron');
    // 🔥 对话框默认挂到"发起调用的窗口"（多窗口场景关键）：
    // 写死挂 mainWindow 会把主窗口强行提到前台、viewer 窗口沉底，
    // 取消对话框后用户面对的是错误的窗口
    const { parent: parentMode, ...dialogOptions } = options || {};
    let parentWindow: Electron.BrowserWindow | null = null;
    if (parentMode === 'main') {
      parentWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    } else {
      try {
        parentWindow = BrowserWindow.fromWebContents(event.sender);
      } catch (e) {
        parentWindow = null;
      }
    }
    const result = await dialog.showOpenDialog(parentWindow!, dialogOptions);
    return result;
  } catch (error) {
    console.error('❌ [DIALOG] 打开对话框失败:', error);
    return { canceled: true, filePaths: [] };
  }
});

/**
 * 🔥 扫描目录
 * 返回目录下的所有文件和子目录
 */
ipcMain.handle('read-directory', async (_, dirPath: string) => {
  try {
    if (!fs.existsSync(dirPath)) {
      return { success: false, error: '目录不存在', files: [] };
    }

    const files: any[] = [];
    const items = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const item of items) {
      const fullPath = pathModule.join(dirPath, item.name);

      if (item.isDirectory()) {
        files.push({
          name: item.name,
          path: fullPath,
          type: 'directory',
        });
      } else if (item.isFile()) {
        const ext = pathModule.extname(item.name).replace('.', '');
        const stats = fs.statSync(fullPath);
        files.push({
          name: item.name,
          path: fullPath,
          type: 'file',
          ext,
          size: stats.size,
          modifiedTime: stats.mtime.toISOString(),
        });
      }
    }

    console.log('✅ [READ-DIR] 目录扫描完成:', { dirPath, count: files.length });
    return { success: true, files };
  } catch (error) {
    console.error('❌ [READ-DIR] 目录扫描失败:', error);
    return { success: false, error: error instanceof Error ? error.message : '扫描失败', files: [] };
  }
});

/**
 * 🔥 递归扫描目录（用于 list_project_files）
 * 返回完整的嵌套文件树结构
 */
ipcMain.handle('read-directory-recursive', async (_, dirPath: string, options?: { maxDepth?: number }) => {
  const maxDepth = options?.maxDepth ?? 10;

  // 🔥 扫描时过滤的目录名（不区分大小写）
  const IGNORED_DIRS = new Set([
    'node_modules', '__pycache__', '.venv', 'venv', 'env',
    '.git', '.svn', '.hg', 'dist', 'build', '.next', '.nuxt',
    '.cache', '.pytest_cache', '.mypy_cache', '.ruff_cache',
    'logs', 'wandb', 'runs', 'checkpoints', '.ipynb_checkpoints',
    'history',
  ]);

  const scanRecursive = (currentPath: string, depth: number): any[] => {
    if (depth > maxDepth) return [];

    try {
      if (!fs.existsSync(currentPath)) return [];

      const items = fs.readdirSync(currentPath, { withFileTypes: true });
      const results: any[] = [];

      for (const item of items) {
        // 🔥 过滤隐藏文件（以 . 开头）
        if (item.name.startsWith('.')) continue;
        // 🔥 过滤缓存/依赖目录
        if (item.isDirectory() && IGNORED_DIRS.has(item.name.toLowerCase())) continue;

        const fullPath = pathModule.join(currentPath, item.name);

        if (item.isDirectory()) {
          const children = scanRecursive(fullPath, depth + 1);
          results.push({
            name: item.name,
            path: fullPath,
            type: 'directory',
            children,
          });
        } else if (item.isFile()) {
          const ext = pathModule.extname(item.name).replace('.', '');
          const stats = fs.statSync(fullPath);
          results.push({
            name: item.name,
            path: fullPath,
            type: 'file',
            ext,
            size: stats.size,
            modifiedTime: stats.mtime.toISOString(),
          });
        }
      }

      return results;
    } catch {
      return [];
    }
  };

  try {
    if (!fs.existsSync(dirPath)) {
      return { success: false, error: '目录不存在', files: [] };
    }

    const files = scanRecursive(dirPath, 0);
    console.log('✅ [READ-DIR-RECURSIVE] 递归扫描完成:', { dirPath, count: files.length });
    return { success: true, files };
  } catch (error) {
    console.error('❌ [READ-DIR-RECURSIVE] 递归扫描失败:', error);
    return { success: false, error: error instanceof Error ? error.message : '扫描失败', files: [] };
  }
});

// ==========================================
// 🔥 Desktop App IPC 处理器
// ==========================================

ipcMain.handle('local-storage:desktop-app:create', async (_, data) => {
  try {
    console.log('[IPC] createDesktopApp 请求:', getBackendStorageUrl(), data);
    const response = await fetch(`${getBackendStorageUrl()}/desktop-apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    console.log('[IPC] createDesktopApp 响应状态:', response.status, response.statusText);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[IPC] createDesktopApp 响应错误:', response.status, errorText);
      return null;
    }
    
    const result = await response.json() as { data?: any };
    console.log('[IPC] createDesktopApp 成功:', result.data?.id);
    return result.data || null;
  } catch (error) {
    console.error('[IPC] createDesktopApp error:', error);
    return null;
  }
});

ipcMain.handle('local-storage:desktop-app:getByUserId', async (_, { userId, limit, offset, appType, baseFirst }) => {
  try {
    const query = new URLSearchParams({
      user_id: userId,
      limit: String(limit || 100),
      offset: String(offset || 0)
    });
    // 🔥 可选类型过滤（UI 筛选）：normal / system_base
    if (appType) {
      query.append('app_type', appType);
    }
    // 🔥 基础项目置顶（仅供 LLM 的 list_projects，防项目太多被淹没）
    if (baseFirst) {
      query.append('base_first', '1');
    }
    const response = await fetch(`${getBackendStorageUrl()}/desktop-apps?${query}`);
    const result = await response.json() as { data?: any[] };
    return result.data || [];
  } catch (error) {
    console.error('[IPC] getDesktopAppsByUserId error:', error);
    return [];
  }
});

ipcMain.handle('local-storage:desktop-app:getById', async (_, id) => {
  try {
    const response = await fetch(`${getBackendStorageUrl()}/desktop-apps/${id}`);
    const result = await response.json() as { data?: any };
    return result.data || null;
  } catch (error) {
    console.error('[IPC] getDesktopAppById error:', error);
    return null;
  }
});

ipcMain.handle('local-storage:desktop-app:update', async (_, { id, updates }) => {
  try {
    const response = await fetch(`${getBackendStorageUrl()}/desktop-apps/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    const result = await response.json() as { data?: any };
    return result.data || null;
  } catch (error) {
    console.error('[IPC] updateDesktopApp error:', error);
    return null;
  }
});

ipcMain.handle('local-storage:desktop-app:delete', async (_, id) => {
  try {
    const response = await fetch(`${getBackendStorageUrl()}/desktop-apps/${id}`, {
      method: 'DELETE'
    });
    const result = await response.json() as { success?: boolean };
    return result.success || false;
  } catch (error) {
    console.error('[IPC] deleteDesktopApp error:', error);
    return false;
  }
});

// ==========================================
// 🔥 Credential IPC 处理器（凭据管理，safeStorage 加密/解密）
// 🔥 架构：Electron 主进程负责加密/解密，后端只存密文
// ==========================================

/**
 * 🔥 加密明文为 base64 字符串（用于存储）
 * 使用 Electron safeStorage（OS 级加密：Windows DPAPI / macOS Keychain / Linux libsecret）
 */
function encryptCredentialValue(plainText: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('⚠️ safeStorage 不可用，凭据将以明文存储（不安全）');
    return `plain:${plainText}`;
  }
  const encryptedBuffer = safeStorage.encryptString(plainText);
  return encryptedBuffer.toString('base64');
}

/**
 * 🔥 解密 base64 字符串为明文
 */
function decryptCredentialValue(encryptedValue: string): string {
  // 🔥 兼容明文 fallback（safeStorage 不可用时创建的凭据）
  if (encryptedValue.startsWith('plain:')) {
    return encryptedValue.slice(6);
  }
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('⚠️ safeStorage 不可用，无法解密凭据');
    return '';
  }
  try {
    const encryptedBuffer = Buffer.from(encryptedValue, 'base64');
    return safeStorage.decryptString(encryptedBuffer);
  } catch (error) {
    console.error('❌ 解密凭据失败:', error);
    return '';
  }
}

/**
 * 🔥 判断 param 型的 storedValue 是否为旧的加密数据
 * 修复前 param 型也会被加密存储，这里用于检测并触发迁移
 */
function isEncryptedParamValue(storedValue: string): boolean {
  if (!storedValue || storedValue.startsWith('plain:')) return false;
  if (!safeStorage.isEncryptionAvailable()) return false;
  try {
    const buf = Buffer.from(storedValue, 'base64');
    // 🔥 单字符明文值（如 '6'）解码为空 Buffer，decryptString 不抛错，会误判为加密数据
    if (buf.length === 0) return false;
    safeStorage.decryptString(buf); // 能解密说明是加密的
    return true;
  } catch {
    return false; // 解密失败说明是明文（新数据）
  }
}

/**
 * 🔥 读取 param 型的值：兼容旧加密数据
 * - 旧数据（加密的 base64）→ 尝试解密返回明文
 * - 新数据（明文）→ 直接返回
 * - plain: 前缀 → 去掉前缀返回明文
 */
function tryDecryptParamValue(storedValue: string): string {
  if (storedValue.startsWith('plain:')) {
    return storedValue.slice(6);
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return storedValue;
  }
  try {
    const buf = Buffer.from(storedValue, 'base64');
    // 🔥 单字符值（如 '6'）base64 解码为空 Buffer，decryptString 对空 Buffer 不抛错
    // 而是静默返回空字符串，导致值被误判为加密数据而"解密"成空 → 必须显式排除
    if (buf.length === 0) return storedValue;
    return safeStorage.decryptString(buf); // 成功=旧加密数据，返回明文
  } catch {
    return storedValue; // 失败=已是明文，直接返回
  }
}

/**
 * 🔥 异步迁移：把旧的加密 param 凭据写回为明文存储（一次性，不阻塞 UI）
 */
async function migrateEncryptedParams(credentials: any[]) {
  for (const cred of credentials) {
    if (cred.type !== 'param') continue;
    if (!isEncryptedParamValue(cred.encrypted_value)) continue;
    try {
      const plainValue = decryptCredentialValue(cred.encrypted_value);
      // 🔥 解密失败返回空字符串时跳过，避免把空值写回数据库损坏数据
      if (!plainValue) {
        console.error('[IPC] 迁移 param 凭据失败（解密为空，可能密文损坏），跳过:', cred.name);
        continue;
      }
      await fetch(`${getBackendStorageUrl()}/credentials/${cred.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encrypted_value: plainValue }),
      });
      log(`🔄 已迁移 param 凭据为明文存储: ${cred.name}`);
    } catch (e) {
      console.error('[IPC] 迁移 param 凭据失败:', cred.name, e);
    }
  }
}

/**
 * 🔥 解密凭据对象的 encrypted_value，返回带明文 value 的对象（给 UI 用）
 * param 型存明文（兼容旧加密数据），env 型才解密
 */
function decryptCredentialForUI(credential: any): any {
  const value = credential.type === 'param'
    ? tryDecryptParamValue(credential.encrypted_value)  // 🔥 param 型存明文，兼容旧加密数据
    : decryptCredentialValue(credential.encrypted_value);  // env 型解密
  return {
    id: credential.id,
    user_id: credential.user_id,
    name: credential.name,
    type: credential.type,
    description: credential.description,
    env_var: credential.env_var,
    value,
    created_at: credential.created_at,
    updated_at: credential.updated_at,
  };
}

/**
 * 🔥 剥离 encrypted_value，只返回元数据（给 LLM 用）
 * param 型对 LLM 透明（返回明文 value），env 型不返回 value
 */
function stripCredentialValueForLLM(credential: any): any {
  if (credential.type === 'param') {
    return {
      id: credential.id,
      env_var: credential.env_var,
      description: credential.description,
      value: tryDecryptParamValue(credential.encrypted_value), // 🔥 param 型存明文（兼容旧加密数据），对 LLM 透明
    };
  }
  return {
    id: credential.id,
    env_var: credential.env_var,
    description: credential.description,
  };
}

// 获取用户所有凭据（带明文 value，给 UI 用）
ipcMain.handle('local-storage:credential:list', async (_, { userId }) => {
  try {
    const response = await fetch(`${getBackendStorageUrl()}/credentials?user_id=${encodeURIComponent(userId)}`);
    const result = await response.json() as { data?: any[] };
    const credentials = result.data || [];
    // 🔥 解密后返回给 UI（包含明文 value）
    const uiCredentials = credentials.map(decryptCredentialForUI);
    // 🔥 异步迁移旧的加密 param 数据为明文（不阻塞 UI，下次读取即为明文存储）
    migrateEncryptedParams(credentials);
    return uiCredentials;
  } catch (error) {
    console.error('[IPC] listCredentials error:', error);
    return [];
  }
});

// 获取用户所有凭据元数据（不含 value，给 LLM 用）
// 🔥 这是 list_credentials LLM 工具的底层数据源
ipcMain.handle('local-storage:credential:list-meta', async (_, { userId }) => {
  try {
    const response = await fetch(`${getBackendStorageUrl()}/credentials?user_id=${encodeURIComponent(userId)}`);
    const result = await response.json() as { data?: any[] };
    const credentials = result.data || [];
    // 🔥 剥离 encrypted_value，只返回 name/type/description/env_var
    return credentials.map(stripCredentialValueForLLM);
  } catch (error) {
    console.error('[IPC] listCredentialsMeta error:', error);
    return [];
  }
});

// 根据名称获取凭据明文（给 userpc_shell 注入环境变量用）
// 🔥 简化后 credentialName = 环境变量名，这里先按 name 查，查不到按 env_var 遍历查（兼容旧数据 name ≠ env_var）
ipcMain.handle('local-storage:credential:get-by-name', async (_, { name, userId }) => {
  try {
    // 1️⃣ 先按 name 查（新数据 name = env_var）
    const response = await fetch(
      `${getBackendStorageUrl()}/credentials/by-name/${encodeURIComponent(name)}?user_id=${encodeURIComponent(userId)}`
    );
    if (response.ok) {
      const result = await response.json() as { data?: any };
      if (result.data) {
        return decryptCredentialForUI(result.data);
      }
    }

    // 2️⃣ name 查不到时，按 env_var 遍历查（兼容旧数据 name ≠ env_var）
    const listResponse = await fetch(`${getBackendStorageUrl()}/credentials?user_id=${encodeURIComponent(userId)}`);
    const listResult = await listResponse.json() as { data?: any[] };
    const credentials = listResult.data || [];
    const matched = credentials.find((c: any) => c.env_var === name);
    if (matched) {
      return decryptCredentialForUI(matched);
    }

    console.error('[IPC] getCredentialByName not found:', name);
    return null;
  } catch (error) {
    console.error('[IPC] getCredentialByName error:', error);
    return null;
  }
});

// 创建凭据（加密 value 后转发后端）
ipcMain.handle('local-storage:credential:create', async (_, data) => {
  try {
    const { user_id, name, type, description, env_var, value } = data;

    // 🔥 param 型允许空值（如 updateSourceUrl 留空=官方源），env 型必须有值
    if (!user_id || !name || !env_var) {
      return { success: false, error: 'user_id, name, env_var 为必填项' };
    }
    if (type !== 'param' && !value) {
      return { success: false, error: 'env 型凭据的 value 为必填项' };
    }

    // 🔥 param 型存明文，env 型加密
    const encryptedValue = type === 'param' ? value : encryptCredentialValue(value);

    const response = await fetch(`${getBackendStorageUrl()}/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id,
        name,
        type: type || 'env_var',
        description: description || '',
        env_var,
        encrypted_value: encryptedValue,
      }),
    });

    if (!response.ok) {
      const errorResult = await response.json() as { error?: string; code?: string };
      return { success: false, error: errorResult.error || '创建凭据失败', code: errorResult.code };
    }

    const result = await response.json() as { data?: any };
    // 🔥 返回给 UI 时解密
    return { success: true, data: decryptCredentialForUI(result.data) };
  } catch (error: any) {
    console.error('[IPC] createCredential error:', error);
    return { success: false, error: error.message };
  }
});

// 更新凭据（如更新 value 则加密）
ipcMain.handle('local-storage:credential:update', async (_, { id, updates }) => {
  try {
    const forwardedUpdates: any = {};
    if (updates.name !== undefined) forwardedUpdates.name = updates.name;
    if (updates.type !== undefined) forwardedUpdates.type = updates.type;
    if (updates.description !== undefined) forwardedUpdates.description = updates.description;
    if (updates.env_var !== undefined) forwardedUpdates.env_var = updates.env_var;
    // 🔥 如果更新 value，根据 type 决定是否加密
    if (updates.value !== undefined) {
      forwardedUpdates.encrypted_value = updates.type === 'param'
        ? updates.value  // param 型存明文
        : encryptCredentialValue(updates.value);
    }

    const response = await fetch(`${getBackendStorageUrl()}/credentials/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(forwardedUpdates),
    });

    if (!response.ok) {
      const errorResult = await response.json() as { error?: string; code?: string };
      return { success: false, error: errorResult.error || '更新凭据失败', code: errorResult.code };
    }

    const result = await response.json() as { data?: any };
    // 🔥 返回给 UI 时解密
    return { success: true, data: decryptCredentialForUI(result.data) };
  } catch (error: any) {
    console.error('[IPC] updateCredential error:', error);
    return { success: false, error: error.message };
  }
});

// 删除凭据
ipcMain.handle('local-storage:credential:delete', async (_, { id }) => {
  try {
    const response = await fetch(`${getBackendStorageUrl()}/credentials/${id}`, {
      method: 'DELETE',
    });
    const result = await response.json() as { success?: boolean };
    return result.success || false;
  } catch (error) {
    console.error('[IPC] deleteCredential error:', error);
    return false;
  }
});

// ==========================================
// 🔥 Training Task IPC 处理器
// ==========================================

ipcMain.handle('local-storage:training-task:create', async (_, data) => {
  try {
    const response = await fetch(`${getBackendStorageUrl()}/training-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await response.json() as { data?: any };
    return result.data || null;
  } catch (error) {
    console.error('[IPC] createTrainingTask error:', error);
    return null;
  }
});

ipcMain.handle('local-storage:training-task:getByUserId', async (_, { userId, limit, offset }) => {
  try {
    const query = new URLSearchParams({
      user_id: userId,
      limit: String(limit || 100),
      offset: String(offset || 0)
    });
    const response = await fetch(`${getBackendStorageUrl()}/training-tasks?${query}`);
    const result = await response.json() as { data?: any[] };
    return result.data || [];
  } catch (error) {
    console.error('[IPC] getTrainingTasksByUserId error:', error);
    return [];
  }
});

ipcMain.handle('local-storage:training-task:getByAppId', async (_, appId) => {
  try {
    const response = await fetch(`${getBackendStorageUrl()}/training-tasks/app/${appId}`);
    const result = await response.json() as { data?: any[] };
    return result.data || [];
  } catch (error) {
    console.error('[IPC] getTrainingTasksByAppId error:', error);
    return [];
  }
});

// 🔥 轻量级查询：只返回摘要，不包含大字段
ipcMain.handle('local-storage:training-task:getSummaryByAppId', async (_, appId) => {
  try {
    const response = await fetch(`${getBackendStorageUrl()}/training-tasks/app/${appId}/summary`);
    const result = await response.json() as { data?: any[] };
    return result.data || [];
  } catch (error) {
    console.error('[IPC] getSummaryByAppId error:', error);
    return [];
  }
});

ipcMain.handle('local-storage:training-task:getById', async (_, id) => {
  try {
    const response = await fetch(`${getBackendStorageUrl()}/training-tasks/${id}`);
    const result = await response.json() as { data?: any };
    return result.data || null;
  } catch (error) {
    console.error('[IPC] getTrainingTaskById error:', error);
    return null;
  }
});

ipcMain.handle('local-storage:training-task:update', async (_, { id, updates }) => {
  try {
    const response = await fetch(`${getBackendStorageUrl()}/training-tasks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    const result = await response.json() as { data?: any };
    return result.data || null;
  } catch (error) {
    console.error('[IPC] updateTrainingTask error:', error);
    return null;
  }
});

ipcMain.handle('local-storage:training-task:delete', async (_, id) => {
  try {
    const response = await fetch(`${getBackendStorageUrl()}/training-tasks/${id}`, {
      method: 'DELETE'
    });
    const result = await response.json() as { success?: boolean };
    return result.success || false;
  } catch (error) {
    console.error('[IPC] deleteTrainingTask error:', error);
    return false;
  }
});

// ==========================================
// 🔥 Execution Log IPC 处理器
// ==========================================

ipcMain.handle('local-storage:execution-log:create', async (_, data) => {
  try {
    const response = await fetch(`${getBackendStorageUrl()}/execution-logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await response.json() as { data?: any };
    return result.data || null;
  } catch (error) {
    console.error('[IPC] createExecutionLog error:', error);
    return null;
  }
});

ipcMain.handle('local-storage:execution-log:getByAppId', async (_, appId) => {
  try {
    const response = await fetch(`${getBackendStorageUrl()}/execution-logs/app/${appId}`);
    const result = await response.json() as { data?: any[] };
    return result.data || [];
  } catch (error) {
    console.error('[IPC] getExecutionLogsByAppId error:', error);
    return [];
  }
});

ipcMain.handle('local-storage:execution-log:getSummaryByAppId', async (_, appId) => {
  try {
    const response = await fetch(`${getBackendStorageUrl()}/execution-logs/app/${appId}/summary`);
    const result = await response.json() as { data?: any[] };
    return result.data || [];
  } catch (error) {
    console.error('[IPC] getExecutionLogSummariesByAppId error:', error);
    return [];
  }
});

ipcMain.handle('local-storage:execution-log:getById', async (_, id) => {
  try {
    const response = await fetch(`${getBackendStorageUrl()}/execution-logs/${id}`);
    const result = await response.json() as { data?: any };
    return result.data || null;
  } catch (error) {
    console.error('[IPC] getExecutionLogById error:', error);
    return null;
  }
});

ipcMain.handle('local-storage:execution-log:update', async (_, { id, updates }) => {
  try {
    const response = await fetch(`${getBackendStorageUrl()}/execution-logs/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    const result = await response.json() as { data?: any };
    return result.data || null;
  } catch (error) {
    console.error('[IPC] updateExecutionLog error:', error);
    return null;
  }
});

ipcMain.handle('local-storage:execution-log:delete', async (_, id) => {
  try {
    const response = await fetch(`${getBackendStorageUrl()}/execution-logs/${id}`, {
      method: 'DELETE'
    });
    const result = await response.json() as { success?: boolean };
    return result.success || false;
  } catch (error) {
    console.error('[IPC] deleteExecutionLog error:', error);
    return false;
  }
});

// ==========================================
// 🔥 屏幕截图 IPC 处理器
// ==========================================

/**
 * 🔥 截取屏幕
 * 使用 Electron 的 desktopCapturer API
 * 返回 Base64 图片，由前端上传到 OSS
 */
ipcMain.handle('capture-screen', async () => {
  try {
    console.log('📸 [SCREEN-CAPTURE] 开始截图...');

    // 获取主屏幕
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.size;
    const scaleFactor = primaryDisplay.scaleFactor;

    // 🔥 使用物理分辨率截图
    const physicalWidth = Math.round(width * scaleFactor);
    const physicalHeight = Math.round(height * scaleFactor);

    console.log(`[SCREEN-CAPTURE] 逻辑尺寸: ${width}x${height}, 物理尺寸: ${physicalWidth}x${physicalHeight}, scaleFactor: ${scaleFactor}`);

    // 使用 desktopCapturer 获取屏幕源
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: physicalWidth, height: physicalHeight }
    });

    if (sources.length === 0) {
      return {
        success: false,
        error: '无法获取屏幕源'
      };
    }

    // 🔥 找到主显示器对应的屏幕源
    const primarySource = sources.find(s => s.display_id === String(primaryDisplay.id)) || sources[0];
    console.log(`[SCREEN-CAPTURE] 找到 ${sources.length} 个屏幕源，使用: ${primarySource.name} (id: ${primarySource.display_id})`);

    // 将缩略图转换为 base64
    const thumbnail = primarySource.thumbnail;
    if (!thumbnail) {
      return {
        success: false,
        error: '无法获取屏幕缩略图'
      };
    }

    // 🔥 获取实际截图尺寸
    const actualSize = thumbnail.getSize();
    console.log(`[SCREEN-CAPTURE] 实际截图尺寸: ${actualSize.width}x${actualSize.height}`);

    // 转换为 base64
    const imageUrl = thumbnail.toDataURL();

    console.log('✅ [SCREEN-CAPTURE] 截图成功', { width: actualSize.width, height: actualSize.height, scaleFactor, timestamp: Date.now() });

    return {
      success: true,
      imageUrl: imageUrl,
      screenWidth: actualSize.width,
      screenHeight: actualSize.height,
      scaleFactor: scaleFactor
    };
  } catch (error) {
    console.error('❌ [SCREEN-CAPTURE] 截图失败:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : '截图失败'
    };
  }
});

// ==========================================
// 🔥 通用文件操作 IPC 处理器
// ==========================================

/**
 * 读取任意路径的文件
 */
ipcMain.handle('userpc:file:read', async (_, { filePath, encoding }: { filePath: string; encoding?: 'utf-8' | 'base64' }) => {
  try {
    if (!filePath) {
      return { success: false, error: '文件路径不能为空' };
    }

    const resolvedPath = pathModule.isAbsolute(filePath)
      ? filePath
      : pathModule.join(app.getAppPath(), filePath);

    if (!fs.existsSync(resolvedPath)) {
      return { success: false, error: `文件不存在: ${filePath}` };
    }

    const stats = fs.statSync(resolvedPath);
    if (stats.isDirectory()) {
      return { success: false, error: '路径是目录，不是文件' };
    }

    const ext = pathModule.extname(resolvedPath).toLowerCase();
    const binaryExtensions = ['.xlsx', '.xls', '.pdf', '.docx', '.doc', '.zip', '.png', '.jpg', '.jpeg', '.gif', '.mp4', '.mp3'];
    const isBinary = binaryExtensions.includes(ext) || encoding === 'base64';

    if (isBinary) {
      const buffer = fs.readFileSync(resolvedPath);
      const base64 = buffer.toString('base64');
      console.log('✅ [USERPC-FILE] 读取二进制文件成功 (base64):', filePath);
      return {
        success: true,
        data: { content: base64, filePath, size: stats.size, encoding: 'base64', ext }
      };
    } else {
      let content = fs.readFileSync(resolvedPath, 'utf-8');
      // 🔥 去除 BOM（如果存在）
      if (content.charCodeAt(0) === 0xfeff) {
        content = content.slice(1);
      }
      console.log('✅ [USERPC-FILE] 读取文本文件成功:', filePath);
      return {
        success: true,
        data: { content, filePath, size: stats.size, encoding: 'utf-8', ext }
      };
    }
  } catch (error) {
    console.error('❌ [USERPC-FILE] 读取文件失败:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : '读取文件失败'
    };
  }
});

/**
 * 写入文件到任意路径
 */
ipcMain.handle('userpc:file:write', async (_, { filePath, content }: { filePath: string; content: string }) => {
  try {
    if (!filePath) {
      return { success: false, error: '文件路径不能为空' };
    }

    // 解析路径
    const resolvedPath = pathModule.isAbsolute(filePath)
      ? filePath
      : pathModule.join(app.getAppPath(), filePath);

    // 确保目录存在
    const dir = pathModule.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 🔥 直接写入 UTF-8，不带 BOM（BOM 会导致 Python 等脚本乱码）
    fs.writeFileSync(resolvedPath, content, 'utf-8');
    console.log('✅ [USERPC-FILE] 写入文件成功 (UTF-8):', filePath);

    return {
      success: true,
      data: { filePath, message: '文件写入成功' }
    };
  } catch (error) {
    console.error('❌ [USERPC-FILE] 写入文件失败:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : '写入文件失败'
    };
  }
});

/**
 * 删除任意路径的文件
 */
ipcMain.handle('userpc:file:delete', async (_, { filePath }: { filePath: string }) => {
  try {
    if (!filePath) {
      return { success: false, error: '文件路径不能为空' };
    }

    const resolvedPath = pathModule.isAbsolute(filePath)
      ? filePath
      : pathModule.join(app.getAppPath(), filePath);

    if (!fs.existsSync(resolvedPath)) {
      return { success: false, error: `文件不存在: ${filePath}` };
    }

    const stats = fs.statSync(resolvedPath);
    if (stats.isDirectory()) {
      return { success: false, error: '不能删除目录，只能删除文件' };
    }

    fs.unlinkSync(resolvedPath);
    console.log('✅ [USERPC-FILE] 删除文件成功:', filePath);

    return {
      success: true,
      data: { filePath, message: '文件删除成功' }
    };
  } catch (error) {
    console.error('❌ [USERPC-FILE] 删除文件失败:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : '删除文件失败'
    };
  }
});

/**
 * 检查文件是否存在
 */
ipcMain.handle('userpc:file:exists', async (_, { filePath }: { filePath: string }) => {
  try {
    if (!filePath) {
      return { success: false, error: '文件路径不能为空' };
    }

    const resolvedPath = pathModule.isAbsolute(filePath)
      ? filePath
      : pathModule.join(app.getAppPath(), filePath);

    const exists = fs.existsSync(resolvedPath);
    const stats = exists ? fs.statSync(resolvedPath) : null;

    return {
      success: true,
      data: {
        exists,
        isFile: stats ? stats.isFile() : false,
        isDirectory: stats ? stats.isDirectory() : false,
        size: stats ? stats.size : 0
      }
    };
  } catch (error) {
    console.error('❌ [USERPC-FILE] 检查文件存在性失败:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : '检查文件失败'
    };
  }
});



