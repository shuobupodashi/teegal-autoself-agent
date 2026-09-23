/**
 * 🔥 自动更新模块
 * 
 * 使用 electron-updater 实现自动更新功能
 * 更新文件托管在 OSS 上
 * 
 * ⚠️ macOS 不支持无签名自动安装，改为检测更新 + 通知用户手动下载 DMG
 */

import { autoUpdater } from 'electron-updater';
import { ipcMain, BrowserWindow, shell, app } from 'electron';
import { platform } from 'process';
import * as fs from 'fs';
import * as path from 'path';

// 🔥 macOS 检测
const isMac = platform === 'darwin';

// 官方 OSS 更新文件基础 URL（默认）
const DEFAULT_OSS_UPDATES_URL = 'https://bb-1storage.oss-cn-hangzhou.aliyuncs.com/updates';
// 官方 macOS DMG 下载链接（默认）
const DEFAULT_MAC_DOWNLOAD_URL = 'https://bb-1storage.oss-cn-hangzhou.aliyuncs.com/downloads/Teegal-mac.dmg';

// 🔥 用户自定义更新源 URL（从配置文件读取，空则用官方默认）
let customUpdateUrl: string | null = null;

/**
 * 🔥 读取用户自定义更新源配置
 * 存储在 userData/update-config.json，主进程启动时同步读取，不依赖后端/userId
 */
function loadUpdateConfig(): string | null {
  try {
    const configPath = path.join(app.getPath('userData'), 'update-config.json');
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(raw);
      return config.updateSourceUrl || null;
    }
  } catch (e) {
    log.error('[AutoUpdater] 读取更新配置失败:', e);
  }
  return null;
}

/**
 * 🔥 获取当前生效的更新源 URL
 */
/**
 * 馃敟 瑙勮寖鍖栨洿鏂版簮 base URL锛氱‘淇濅互 / 缁撳熬
 * electron-updater generic provider 浼氱敤 new URL('latest.yml', base) 鎷兼帴锛? * 鑻?base 鏃犲熬鏂滄潬浼氶€€鍖栨垚 /releases/latest/latest.yml -> 404
 */
function normalizeUpdateBaseUrl(url: string): string {
  if (!url) return url;
  return url.replace(/\/+$/, '') + '/';
}
function getEffectiveUpdateUrl(): string {
  return normalizeUpdateBaseUrl(customUpdateUrl || DEFAULT_OSS_UPDATES_URL);
}

/**
 * 🔥 获取当前生效的 macOS DMG 下载链接
 * 如果是自定义源，从基础 URL 推导；否则用官方默认
 */
function getEffectiveMacDownloadUrl(): string {
  if (customUpdateUrl) {
    // 自定义源：DMG 文件名保持一致，放在更新源根目录
    const base = customUpdateUrl.replace(/\/+$/, '');
    return `${base}/Teegal-mac.dmg`;
  }
  return DEFAULT_MAC_DOWNLOAD_URL;
}

// 简单的日志对象
const log = {
  info: (message: string, ...args: any[]) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`, ...args);
  },
  error: (message: string, ...args: any[]) => {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ${message}`, ...args);
  }
};

// 更新状态
let updateStatus: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' = 'idle';
let downloadProgress = 0;
let downloadedVersion: string = '';  // 🔥 保存下载完成的版本号
let mainWindow: BrowserWindow | null = null;
// 🔥 IPC handlers 是进程级的，只注册一次，不随窗口生命周期重置
// macOS 关闭窗口后进程仍存活，点 Dock 重建窗口会再次调用 initAutoUpdater
// 若重复注册 ipcMain.handle 会抛 "second handler" 错误
let ipcHandlersRegistered = false;
let checkUpdateTimeout: NodeJS.Timeout | null = null; // 检查更新的定时器

/**
 * 初始化自动更新
 */
export function initAutoUpdater(window: BrowserWindow) {
  mainWindow = window;

  // 🔥 IPC handlers 是进程级的，不依赖窗口，只注册一次
  // macOS 关闭窗口后进程仍存活，点 Dock 重建窗口会再次调用 initAutoUpdater
  // 若重复注册 ipcMain.handle 会抛 "second handler" 错误
  if (!ipcHandlersRegistered) {
    setupIpcHandlers();
    ipcHandlersRegistered = true;
  }

  // 🔥 读取用户自定义更新源（每次窗口创建都读，支持配置变更）
  customUpdateUrl = loadUpdateConfig();
  const effectiveUrl = getEffectiveUpdateUrl();
  log.info(`[AutoUpdater] 更新源: ${customUpdateUrl ? '自定义' : '官方'} → ${effectiveUrl}`);

  // 🔥 使用动态 URL（官方 OSS 或用户自定义源）
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: effectiveUrl,
    channel: 'latest'
  });

  // 🔥 macOS: 不自动下载（无签名无法自动安装），仅检测 + 通知
  // Windows: 自动下载，手动触发安装
  autoUpdater.autoDownload = !isMac;
  autoUpdater.autoInstallOnAppQuit = false;  // 🔥 禁用，避免重复安装

  // 🔥 关键修复：禁用差分更新，强制下载完整文件
  // 差分更新可能导致 Content-Length 不匹配问题
  autoUpdater.disableDifferentialDownload = true;

  // 🔥 关键修复：设置请求头，禁用压缩，避免 Content-Length 不匹配
  autoUpdater.requestHeaders = {
    'Accept-Encoding': 'identity',
    'Connection': 'keep-alive',
  };

  log.info('[AutoUpdater] 初始化自动更新模块');

  // 🔥 重新绑定前先移除旧监听（幂等，窗口重建时防止重复绑定 autoUpdater 事件）
  removeAutoUpdaterEvents();
  setupAutoUpdaterEvents();

  // 应用启动后延迟检查更新（避免影响启动速度）
  // 🔥 开发环境下不自动检查；避免重复设置定时器
  if (process.env.NODE_ENV !== 'development' && !checkUpdateTimeout) {
    checkUpdateTimeout = setTimeout(() => {
      checkForUpdates();
    }, 5000); // 5秒后检查
  }

  // 🔥 监听窗口关闭事件，清理窗口级资源（IPC handlers 进程级保留，不清理）
  window.once('closed', () => {
    if (checkUpdateTimeout) {
      clearTimeout(checkUpdateTimeout);
      checkUpdateTimeout = null;
    }
    // 移除事件监听器（下次窗口创建时重新绑定）
    removeAutoUpdaterEvents();
    mainWindow = null;
    log.info('[AutoUpdater] 窗口已关闭，清理窗口级资源（IPC handlers 保留）');
  });
}

/**
 * 设置自动更新事件监听
 */
function setupAutoUpdaterEvents() {
  // 检查更新时
  autoUpdater.on('checking-for-update', onCheckingForUpdate);

  // 有可用更新
  autoUpdater.on('update-available', onUpdateAvailable);

  // 没有更新
  autoUpdater.on('update-not-available', onUpdateNotAvailable);

  // 更新下载进度
  autoUpdater.on('download-progress', onDownloadProgress);

  // 更新下载完成
  autoUpdater.on('update-downloaded', onUpdateDownloaded);

  // 更新错误
  autoUpdater.on('error', onUpdateError);
}

/**
 * 移除自动更新事件监听
 */
function removeAutoUpdaterEvents() {
  autoUpdater.removeListener('checking-for-update', onCheckingForUpdate);
  autoUpdater.removeListener('update-available', onUpdateAvailable);
  autoUpdater.removeListener('update-not-available', onUpdateNotAvailable);
  autoUpdater.removeListener('download-progress', onDownloadProgress);
  autoUpdater.removeListener('update-downloaded', onUpdateDownloaded);
  autoUpdater.removeListener('error', onUpdateError);
}

// 事件处理函数
function onCheckingForUpdate() {
  updateStatus = 'checking';
  log.info('[AutoUpdater] 正在检查更新...');
  sendToRenderer('update-checking');
}

function onUpdateAvailable(info: any) {
  updateStatus = 'available';
  log.info('[AutoUpdater] 发现新版本:', info.version);
  
  if (isMac) {
    // 🔥 macOS: 通知前端有新版本可用，附带 DMG 下载链接（不自动安装）
    const macUrl = getEffectiveMacDownloadUrl();
    log.info('[AutoUpdater] macOS 无签名，通知用户手动下载:', macUrl);
    sendToRenderer('update-available', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes,
      downloadUrl: macUrl,  // 🔥 macOS 直接给 DMG 下载链接
      requiresManualInstall: true,     // 🔥 标记需要手动安装
    });
  } else {
    sendToRenderer('update-available', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes,
    });
  }
}

function onUpdateNotAvailable() {
  updateStatus = 'idle';
  log.info('[AutoUpdater] 当前已是最新版本');
  sendToRenderer('update-not-available');
}

function onDownloadProgress(progress: any) {
  updateStatus = 'downloading';
  downloadProgress = Math.round(progress.percent);
  log.info(`[AutoUpdater] 下载进度: ${downloadProgress}%`);
  sendToRenderer('update-progress', { progress: downloadProgress });
}

function onUpdateDownloaded(info: any) {
  updateStatus = 'ready';
  downloadedVersion = info.version;  // 🔥 保存版本号
  log.info('[AutoUpdater] 更新下载完成，准备自动安装:', info.version);
  sendToRenderer('update-ready', {
    version: info.version,
  });
}

/**
 * 🔥 执行安装更新
 * Windows: 一键安装模式
 * macOS: 不支持（无签名），由前端引导用户手动下载
 */
async function performInstall(version: string) {
  if (isMac) {
    // macOS 无签名，打开下载链接让用户手动安装
    const macUrl = getEffectiveMacDownloadUrl();
    log.info('[AutoUpdater] macOS: 打开 DMG 下载链接:', macUrl);
    await shell.openExternal(macUrl);
    return;
  }

  log.info('[AutoUpdater] 开始安装更新，版本:', version);

  // 🔥 通知前端显示安装状态
  sendToRenderer('update-installing', { version });

  // 🔥 延迟 500ms 让前端显示状态
  await new Promise(resolve => setTimeout(resolve, 500));

  // 🔥 执行安装
  // isSilent=false: 显示安装界面（用户可以看到进度，一键安装只需点一次）
  // forceRunAfter=true: 安装完成后自动运行新版本
  log.info('[AutoUpdater] 启动一键安装...');
  autoUpdater.quitAndInstall(false, true);
}

function onUpdateError(error: Error) {
  updateStatus = 'idle';
  log.error('[AutoUpdater] 更新错误:', error.message);
  sendToRenderer('update-error', { message: error.message });
}

/**
 * 注册 IPC 处理程序
 */
function setupIpcHandlers() {
  // 手动检查更新
  ipcMain.handle('updater:check', async () => {
    return await checkForUpdates();
  });

  // 安装更新并重启
  ipcMain.handle('updater:install', async () => {
    return await installUpdate();
  });

  // 获取当前更新状态
  ipcMain.handle('updater:getStatus', () => {
    return {
      status: updateStatus,
      progress: downloadProgress,
    };
  });

  // 🔥 设置自定义更新源 URL（由 CredentialManager 调用）
  ipcMain.handle('updater:setSourceUrl', async (_event, url: string) => {
    try {
      const trimmedUrl = (url || '').trim();
      customUpdateUrl = trimmedUrl ? normalizeUpdateBaseUrl(trimmedUrl) : null;

      // 持久化到配置文件
      const configPath = path.join(app.getPath('userData'), 'update-config.json');
      fs.writeFileSync(configPath, JSON.stringify({ updateSourceUrl: customUpdateUrl }, null, 2), 'utf-8');

      // 更新 feed URL
      const effectiveUrl = getEffectiveUpdateUrl();
      autoUpdater.setFeedURL({
        provider: 'generic',
        url: effectiveUrl,
        channel: 'latest'
      });

      log.info(`[AutoUpdater] 更新源已切换: ${customUpdateUrl ? '自定义' : '官方'} → ${effectiveUrl}`);

      return { success: true, url: effectiveUrl };
    } catch (error) {
      log.error('[AutoUpdater] 设置更新源失败:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // 🔥 获取当前更新源配置
  ipcMain.handle('updater:getSourceUrl', () => {
    return {
      customUrl: customUpdateUrl,
      effectiveUrl: getEffectiveUpdateUrl(),
      isCustom: !!customUpdateUrl,
    };
  });
}

/**
 * 检查更新
 */
async function checkForUpdates() {
  try {
    log.info('[AutoUpdater] 开始检查更新...');
    const result = await autoUpdater.checkForUpdates();
    return {
      success: true,
      updateInfo: result?.updateInfo || null,
    };
  } catch (error) {
    log.error('[AutoUpdater] 检查更新失败:', error);
    return {
      success: false,
      error: (error as Error).message,
    };
  }
}

/**
 * 安装更新并重启
 */
async function installUpdate() {
  try {
    if (updateStatus !== 'ready') {
      return {
        success: false,
        error: '更新尚未下载完成',
      };
    }

    log.info('[AutoUpdater] 安装更新并重启...');
    await performInstall(downloadedVersion);
    
    return {
      success: true,
    };
  } catch (error) {
    log.error('[AutoUpdater] 安装更新失败:', error);
    return {
      success: false,
      error: (error as Error).message,
    };
  }
}

/**
 * 发送消息到渲染进程
 */
function sendToRenderer(channel: string, data?: any) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(`updater:${channel}`, data);
  }
}

/**
 * 获取当前更新状态（供外部使用）
 */
export function getUpdateStatus() {
  return {
    status: updateStatus,
    progress: downloadProgress,
  };
}
