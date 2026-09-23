import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { DesktopApp, DesktopAppExecutionResult, CodeVersion } from './types/DesktopAppTypes';
import {CodeEditor} from './CodeEditor';
import {PreviewViewer} from './PreviewViewer';
import {
  CadPreview, isCadFile,
  ImageViewer, isImageFile,
  VideoViewer, isVideoFile,
  PdfViewer, isPdfFile,
  OfficeViewer, isOfficeFile,
  AudioViewer, isAudioFile,
} from './viewers';
import { LegacyFileTree, saveFile, getHistoryContent, getCurrentFileContent } from './FileTree/index';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Play, Save, Loader2, Zap, Server, Cloud, LayoutPanelLeft, PanelLeftClose, PanelLeftOpen, Settings, X, FileIcon, ExternalLink, Maximize2, Minimize2, OctagonX, Terminal, CloudLightning, CalendarSync } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useDesktopApp } from '@/hooks/workspace/desktopapp/useDesktopApp';
import { trainingTaskStorage } from '@/services/storage';
import { getBackendUrl } from '@/config/api';
import { appDatabaseService } from '@/utils/apptool/AppDatabaseService';
import GPUSelectorDialog from './GPUSelectorDialog';
import SSHSelectorDialog, { SshSpecOption } from './SSHSelectorDialog';
import { sshOpenInstance } from '@/utils/systemtools/sshInstance';
import { isSameProjectId } from '@/utils/apptool/ProjectIdResolver';
import { ECSWebSocketManager } from '@/utils/workspace/ECSWebSocketManager';
import HistoryTaskList, { HistoryTaskListRef, TrainingTask } from './HistoryTaskList';
import ExecutionLogList, { ExecutionLogListRef, ExecutionLog } from './ExecutionLogList';
import { executeLocalCode, claimPendingExecutionResult } from '@/utils/apptool/LocalExecutor';
import { stopAppService } from '@/utils/apptool/CpuExecutionService';
import { appExecutionService, checkGpuRequirement } from '@/utils/apptool/AppExecutionService';
import { useUserBalance } from '@/hooks/payment/useUserBalance';
import { RechargeDialog } from '@/components/payment/RechargeDialog';

interface DesktopAppViewerProps {
  appId: string;
  userId: string;
  isOpen: boolean;
  onClose: () => void;
  initialApp?: DesktopApp;
  onAppUpdated: (appId: string) => void;
  conversationId?: string | null; // 🔥 新增：对话ID，用于文件上传
  /** 🔥 独立窗口模式：隐藏 viewer 自带的关闭按钮（由页面标题栏的窗口控制接管） */
  embedded?: boolean;
}


export const DesktopAppViewer: React.FC<DesktopAppViewerProps> = ({
  appId,
  userId,
  isOpen,
  onClose,
  initialApp,
  onAppUpdated,
  conversationId,
  embedded
}) => {
  const { t } = useTranslation();
  // 提取代码内容，支持CodeVersion或字符串
  const getCodeContent = (val: string | any): string => {
    // 如果是字符串且看起来像JSON，尝试解析
    if (typeof val === 'string') {
      try {
        // 检查字符串是否看起来像JSON（以{或[开头）
        const trimmed = val.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          const parsed = JSON.parse(val);
          if (parsed && typeof parsed === 'object' && parsed.content !== undefined) {
            return parsed.content;
          }
        }
      } catch (e) {
        // 解析失败，直接作为字符串返回
      }
      return val;
    }
    
    if (typeof val === 'object' && val.content !== undefined) {
      // CodeVersion对象
      return val.content;
    }
    return val as string;
  };

  // 🔥 简化：不再区分单文件/多文件模式，统一使用文件树
  const [code, setCode] = useState<string>('');
  const codeRef = useRef<string>(''); // 🔥 ref 存储最新代码，解决异步状态问题
  const [previousCode, setPreviousCode] = useState<string>('');
  const [showDiff, setShowDiff] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  
  // 🔥 同步更新 ref 和 state
  const handleCodeChange = useCallback((newCode: string) => {
    codeRef.current = newCode;
    setCode(newCode);
  }, []);
  // 🔥 方案 B：previewContent 不再从 initialApp.preview 初始化（避免加载大字段）
  // 由 HistoryTaskList 的 onLatestTaskChange 回调按需加载
  const [previewContent, setPreviewContent] = useState('');
  const [executionError, setExecutionError] = useState<string | undefined>();
  const [generatedFiles, setGeneratedFiles] = useState<{ [filename: string]: any }>({});
  const [charts, setCharts] = useState<any[]>([]);
  const [executionTime, setExecutionTime] = useState<number | undefined>(); 
  const [lastExecutedAt, setLastExecutedAt] = useState<string | undefined>();
  const [editingAppName, setEditingAppName] = useState(false);
  const [appName, setAppName] = useState(initialApp?.name || '');
  const [appConfig, setAppConfig] = useState<any>(initialApp?.config || {});
  const [isEditorExpanded, setIsEditorExpanded] = useState(true);
  const [isPreviewExpanded, setIsPreviewExpanded] = useState(false);
  // 🔥 文件树默认显示
  const [showFileTree, setShowFileTree] = useState(true);
  // 🔥 当前选中的文件路径
  const [selectedFilePath, setSelectedFilePath] = useState<string>('');
  // 🔥 当前文件名
  const [currentFileName, setCurrentFileName] = useState('');
  const { toast } = useToast();

  // 🔥 Electron 环境检测
  const isElectron = typeof window !== 'undefined' && (window as any).electron?.isElectron;

  // 🚀 核心状态：切换预览模式
  const [previewTab, setPreviewTab] = useState<'live' | 'history' | 'logs'>('live');
  const [selectedTask, setSelectedTask] = useState<TrainingTask | null>(null);

  // 🔥 历史任务列表 ref（用于调用子组件方法）
  const historyListRef = useRef<HistoryTaskListRef>(null);
  const executionLogListRef = useRef<ExecutionLogListRef>(null);
  const [historyTotalCount, setHistoryTotalCount] = useState(0);
  const [executionLogCount, setExecutionLogCount] = useState(0);
  const [isGpuTaskRunning, setIsGpuTaskRunning] = useState(false);
  const [gpuTaskStatus, setGpuTaskStatus] = useState<'starting' | 'pending' | 'running' | 'none'>('none');
  
  // GPU训练 仅保留确认弹窗所需状态
  const [showGpuConfirmation, setShowGpuConfirmation] = useState(false);
  const [gpuConfirmationCallback, setGpuConfirmationCallback] = useState<((gpuOption: any) => void) | null>(null);

  // 🔥 常驻实例租赁（长期常驻，区别于 Train/Run 短任务）：选择弹窗 + 开机中状态
  // 按钮恒定样式，不随实例状态翻转——运行中实例的查看/关机统一在 SSHSelectorDialog 里管理（可多台并存）
  const [showSshSelector, setShowSshSelector] = useState(false);
  const [isSshBooting, setIsSshBooting] = useState(false);
  // 🔥 常驻指示灯：本项目归属的活跃实例存在时按钮文字后加绿点（不改变点击行为）
  // 只认 app_id = 当前项目的机子——其他项目/未关联的机子不亮，避免误导用户以为本项目有专属机子
  const [hasRunningResident, setHasRunningResident] = useState(false);

  const refreshResidentIndicator = useCallback(async () => {
    if (!userId || !appId) return;
    try {
      const resp = await fetch(`${getBackendUrl()}/api/rental/resources?userId=${encodeURIComponent(userId)}&active=1`);
      const data = await resp.json().catch(() => null);
      // 🔥 长短 id 兼容比对：存量记录可能登记短 id/截断 slug
      const mine = (data?.resources || []).filter((r: any) => isSameProjectId(r.app_id, appId));
      setHasRunningResident(mine.length > 0);
    } catch {
      // 本地后端不可达，保持现状
    }
  }, [userId, appId]);

  // 挂载/切换用户时同步指示灯
  useEffect(() => {
    refreshResidentIndicator();
  }, [refreshResidentIndicator]);

  // 🔥 Kill 训练弹窗状态
  const [showKillDialog, setShowKillDialog] = useState(false);
  const [killReason, setKillReason] = useState('');
  // 🔥 待停止的任务 ID（从 GPU 管理面板点停止时指定，与 runningTaskId 单任务状态解耦）
  const [killTargetTaskId, setKillTargetTaskId] = useState<string | null>(null);
  // 🔥 训练中的任务列表（GPU 管理面板上半区展示，可多台并存）
  const [runningTrainTasks, setRunningTrainTasks] = useState<any[]>([]);

  // 查询当前项目的训练中任务（running/pending）
  const fetchRunningTrainTasks = useCallback(async () => {
    if (!appId) return;
    try {
      const tasks = await trainingTaskStorage.getByAppId(appId);
      setRunningTrainTasks(tasks.filter((t: any) => t.status === 'running' || t.status === 'pending'));
    } catch {
      // 查询失败保持现状
    }
  }, [appId]);

  // 挂载/切换项目时同步训练中任务
  useEffect(() => {
    fetchRunningTrainTasks();
  }, [fetchRunningTrainTasks]);
  const [isKilling, setIsKilling] = useState(false);
  // 🔥 当前正在运行的 GPU 任务（来自 latestTask 或 WebSocket）
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);

  // 🔥 本地代码执行状态
  const [isLocalRunning, setIsLocalRunning] = useState(false);
  // 🔥 该项目是否有常驻的后台服务进程（dev server）：显示 Stop 按钮，让用户能主动停掉释放端口/内存
  const [hasLocalService, setHasLocalService] = useState(false);
  const [gpuCodeWarning, setGpuCodeWarning] = useState<{ show: boolean; reason?: string }>({ show: false });
  const [selectedLog, setSelectedLog] = useState<ExecutionLog | null>(null);

  // 🔥 余额相关状态
  const { balance: userBalance, isLoading: isBalanceLoading, refreshBalance } = useUserBalance();
  const [showRechargeDialog, setShowRechargeDialog] = useState(false);

  const { apps, fetchApps, getAppDetail, deleteApp } = useDesktopApp(userId);
  const wsRef = useRef<ECSWebSocketManager | null>(null);

  // 将消息发送到聊天输入框的函数
  const onSendToAgent = (message: string) => {
    // 使用全局事件系统将消息发送到聊天输入框
    window.dispatchEvent(new CustomEvent('sendToChatInput', { detail: message }));
  };

  // GPU确认处理函数
  const handleGpuConfirm = (gpuOption: any) => {
    setShowGpuConfirmation(false);
    if (gpuConfirmationCallback) {
      gpuConfirmationCallback(gpuOption);
      setGpuConfirmationCallback(null);
    }
  };

  const handleGpuCancel = () => {
    setShowGpuConfirmation(false);
    setGpuConfirmationCallback(null);
    if (isGpuTaskRunning) {
      console.log('🚫 用户取消 GPU 选择');
      historyListRef.current?.addCancelledTask('用户取消 GPU 选择');
      setIsGpuTaskRunning(false);
      setIsRunning(false);
    }
  };

  // 🔥 本地代码执行（RunDev）
  const handleRunDev = async () => {
    if (!appId || isLocalRunning || isRunning) return;

    // 🔥 Run 按钮 = 执行整个项目（浏览任意项目文件时）；
    // 仅在"未浏览任何文件但编辑器有代码"（草稿）时走单文件模式
    const codeContent = codeRef.current?.trim() ? codeRef.current : '';

    // 🔥 检测 GPU 代码，给出不建议在 CPU 环境执行的提示
    const gpuCheck = checkGpuRequirement(codeContent);
    if (gpuCheck.requiresGPU && !gpuCodeWarning.show) {
      setGpuCodeWarning({ show: true, reason: gpuCheck.reason });
      return;  // 弹窗确认后再执行
    }

    // 重置警告状态
    setGpuCodeWarning({ show: false });

    setIsLocalRunning(true);
    setSelectedLog(null);
    setPreviewContent(''); // 🔥 清空之前的输出
    console.log(`🚀 [RUN-DEV] 开始本地执行: appId=${appId}, isMultiFile=${!!selectedFilePath}`);

    // 🔥 看门狗：执行链中有不带超时的 await（执行日志 create/update、列表 refresh 的 HTTP 请求），
    // local-backend 卡住会让 isLocalRunning 永远为 true（spinner 无限转）。兜底保证 UI 必然恢复。
    const runStartedAt = Date.now();
    const watchdog = setTimeout(() => {
      setIsLocalRunning(prev => {
        if (prev) {
          console.warn(`⚠️ [RUN-DEV] 执行 ${Math.round((Date.now() - runStartedAt) / 1000)}s 未完成，看门狗强制复位执行状态（local-backend 可能无响应）`);
          return false;
        }
        return prev;
      });
    }, 11 * 60 * 1000); // 11 分钟 > 进程执行 10 分钟兜底

    try {
      // 🔥 分发逻辑（定死）：
      // - 正在浏览项目文件（selectedFilePath 有值）→ 项目模式：mainFile 传当前文件名，
      //   底层入口探测会校验它（不可执行/不存在时自动换成项目真实入口 main.py/app.py/...）
      //   ⚠️ 不能用"编辑器有无内容"判模式：浏览 main.py 时内容会走单文件临时脚本路径，
      //   detectLanguage 对注释/docstring 开头的代码误判为 shell → 写 .sh → Windows 弹"选择打开方式"
      // - 没浏览任何文件（selectedFilePath 空）且编辑器有代码 → 单文件草稿模式，执行编辑器代码
      // - 没浏览文件且编辑器为空 → 项目模式（自动探测入口）
      const isMultiFile = !!selectedFilePath || !codeContent;
      const result = await executeLocalCode(
        {
          code: codeContent,
          language: 'auto',
          timeout: 600,
          appId,
          userId,
          isMultiFile,
          // 🔥 项目模式：当前浏览的文件作为入口候选（探测校验）；草稿模式不需要
          mainFile: isMultiFile ? (currentFileName || '') : '',
        },
        (progress) => {
          // 🔥 实时输出到 previewContent
          if (progress.type === 'stdout' || progress.type === 'stderr') {
            setPreviewContent(prev => prev + (progress.data || ''));
          }
          // 🔥 检测到开发服务器 URL，显示 toast
          if (progress.type === 'url') {
            setHasLocalService(true); // 🔥 服务常驻运行 → 显示 Stop 按钮
            const url = progress.data;
            toast({
              title: t('workspace.desktopModule.desktopAppViewer.devServerStarted'),
              description: t('workspace.desktopModule.desktopAppViewer.clickToVisit', { url }),
              action: (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => window.open(url, '_blank')}
                >
                  {t('workspace.desktopModule.desktopAppViewer.openBrowser')}
                </Button>
              ),
            });
          }
        }
      );

      // 🔥 切换到日志 Tab
      setPreviewTab('logs');
      // 🔥 等待数据库更新后再刷新列表
      await new Promise(r => setTimeout(r, 100));
      await executionLogListRef.current?.refresh();

      // 🔥 本地执行完成：自动切到一半一半，方便查看输出结果
      setIsEditorExpanded(false);
      setIsPreviewExpanded(false);

      if (result.success) {
        toast({ title: t('workspace.desktopModule.desktopAppViewer.executeSuccess') });
      } else {
        // 🔥 检测是否是环境缺失错误，让 agent 帮安装
        const missingMatch = result.error?.match(/电脑未安装\s+(\w+).*下载地址:\s*(https:\/\/[^\s]+)/);
        if (missingMatch) {
          const [, envName, downloadUrl] = missingMatch;
          // 🔥 自动填充安装请求到 chat input，用户回到对话按发送即可
          const installMessage = `请帮我安装 ${envName}。下载地址：${downloadUrl}\n请下载后安装到默认路径，安装完成后告诉我。`;
          onSendToAgent(installMessage);
          toast({
            title: t('workspace.desktopModule.desktopAppViewer.envMissingTitle', { env: envName }),
            description: t('workspace.desktopModule.desktopAppViewer.envMissingDesc'),
            variant: 'default',
          });
        } else {
          toast({ title: t('workspace.desktopModule.desktopAppViewer.executeFailed'), description: result.error?.slice(0, 100), variant: 'destructive' });
        }
      }
    } catch (err: any) {
      toast({ title: t('workspace.desktopModule.desktopAppViewer.executeException'), description: err.message, variant: 'destructive' });
    } finally {
      setIsLocalRunning(false);
    }
  };

  // 🔥 挂载/切换 appId 时同步后台进程状态：
  // 1. 服务类进程（dev server）→ 显示 Stop 按钮
  // 2. 认领"窗口关闭期间在后台跑完"的结果 → 补写进 executionlog（修复记录卡在"执行中"）
  // 3. 计算类脚本还在后台跑 → 轮询等它结束，结束后认领结果刷新列表
  useEffect(() => {
    if (!appId) return;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const electron = (window as any).electron;

    // 认领后台结果：找到 still-running 的执行记录，用后台结果补写完成（含耗时）
    const claimAndUpdateRecord = async (): Promise<boolean> => {
      const updated = await claimPendingExecutionResult(appId);
      if (updated) {
        await executionLogListRef.current?.refresh();
      }
      return updated;
    };

    const sync = async () => {
      try {
        const info = await electron?.queryAppService?.(appId);
        if (cancelled) return;
        setHasLocalService(!!info?.isService);
        // 计算类脚本还在后台跑：轮询等结束，结束后认领结果
        if (info?.running && !info.isService) {
          toast({ title: t('workspace.desktopModule.desktopAppViewer.backgroundTaskRunning') });
          pollTimer = setInterval(async () => {
            try {
              const cur = await electron?.queryAppService?.(appId);
              if (cur?.running) return; // 还在跑
              if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
              await claimAndUpdateRecord();
            } catch { /* 忽略轮询错误 */ }
          }, 3000);
        } else {
          // 没有活跃进程：直接认领（覆盖"窗口关闭期间已跑完"的场景）
          await claimAndUpdateRecord();
        }
      } catch { /* Electron API 不可用时忽略 */ }
    };

    sync();
    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [appId]);

  // 🔥 主动停止本项目的常驻服务进程（释放端口/内存）
  const handleStopLocalService = () => {
    stopAppService(appId);
    setHasLocalService(false);
    toast({ title: t('workspace.desktopModule.desktopAppViewer.serviceStopped') });
  };

  // 🔥 Kill GPU 训练（可指定 taskId——管理面板多任务场景；不传用当前 runningTaskId）
  const handleKillTrain = (taskId?: string) => {
    const target = taskId || runningTaskId;
    if (!target && !isGpuTaskRunning && !isRunning) return;
    setKillTargetTaskId(target || null);
    setKillReason('');
    setShowKillDialog(true);
  };

  const handleKillConfirm = async () => {
    const targetTaskId = killTargetTaskId || runningTaskId;
    if (!targetTaskId) return;
    setIsKilling(true);
    try {
      // 🔥 传入用户填写的原因
      const result = await appExecutionService.stopGpuTask(targetTaskId, appId, killReason.trim() || '用户手动停止');
      if (result.success) {
        setIsRunning(false);
        setIsGpuTaskRunning(false);
        setGpuTaskStatus('none');
        setRunningTaskId(null);
        setShowKillDialog(false);
        historyListRef.current?.refresh();
        fetchRunningTrainTasks();
        toast({ title: t('workspace.desktopModule.desktopAppViewer.trainingStopped'), description: t('workspace.desktopModule.desktopAppViewer.trainingStoppedDesc') });
        // 🔥 不再直接通知 agent，通过后端 waitForCompletion 返回 reason 的路径传递
        // stopGpuTask 已经将 reason 传给后端 → waitForCompletion 返回 → 工具返回 → 前端展示
      } else {
        toast({ title: t('workspace.desktopModule.desktopAppViewer.stopFailed'), description: result.error || t('workspace.desktopModule.desktopAppViewer.unknownError'), variant: 'destructive' });
      }
    } catch (error) {
      toast({ title: t('workspace.desktopModule.desktopAppViewer.stopFailed'), description: error instanceof Error ? error.message : t('workspace.desktopModule.desktopAppViewer.unknownError'), variant: 'destructive' });
    } finally {
      setIsKilling(false);
    }
  };

  useEffect(() => {
    // 🔥 只要详情页打开，就建立 WebSocket 监听，以接收 GPU 任务或自动运行的通知
    if (isOpen && appId) {
      console.log(`🔌 [DesktopAppViewer] 建立 WebSocket 监听: app-${appId}`);
      
      const conversationId = `app-${appId}`;
      const ws = new ECSWebSocketManager(conversationId);
      wsRef.current = ws;

      ws.connect().then(() => {
        ws.onMessage((data) => {
          if (data.appId !== appId) return;

          if (data.type === 'desktop_app_auto_run_result') {
            console.log(`🤖 [DesktopAppViewer] 收到自动运行更新通知:`, data.appId);
            handleExecutionResult(data.result);
          } else if (data.type === 'gpu_task_status') {
            console.log(`🔄 [DesktopAppViewer] 收到 GPU 任务状态变化:`, data.status);
            setGpuTaskStatus(data.status === 'running' ? 'running' : 'pending');
            if (data.taskId) setRunningTaskId(data.taskId);
            historyListRef.current?.refresh();
            fetchRunningTrainTasks();
          } else if (data.type === 'gpu_task_complete') {
            console.log(`🎯 [DesktopAppViewer] 收到 GPU 任务完成通知:`, data.appId);
            setIsRunning(false);
            setIsGpuTaskRunning(false);
            setGpuTaskStatus('none');
            setRunningTaskId(null);
            handleExecutionResult(data.result);
            historyListRef.current?.refresh();
            fetchRunningTrainTasks();
          }
        });
      }).catch(err => {
        console.error('❌ [DesktopAppViewer] WebSocket 连接失败:', err);
      });

      return () => {
        // 🔥 项目窗口关闭：释放该项目的后台服务进程（dev server 等）。
        // 只杀"检测到服务地址"而登记的服务器类进程；main.py 推理等计算脚本
        // 不登记、自己跑完退出，不受关窗口影响（避免用户"结果还没出就被杀了"的错觉）
        stopAppService(appId);
        if (wsRef.current) {
          console.log(`🛑 [DesktopAppViewer] 销毁 WebSocket 监听 (原因: 详情页关闭)`);
          wsRef.current.close();
          wsRef.current = null;
        }
      };
    }
  }, [isOpen, appId]); // ✅ 移除了 isAutoRunning 依赖

  // 🔥 处理历史任务列表的最新任务变化
  // 方案 B：自动加载最近一条 task 的完整数据，作为 live 预览的展示内容
  const handleLatestTaskChange = async (latestTask: TrainingTask | null) => {
    if (!latestTask) {
      // 没有历史任务，清空 live 预览
      setPreviewContent('');
      setGeneratedFiles({});
      setCharts([]);
      setLastExecutedAt(undefined);
      return;
    }

    // 🔥 恢复 GPU 运行状态
    if (latestTask.status === 'running' || latestTask.status === 'pending') {
      console.log(`⏳ [DesktopAppViewer] 发现正在运行中的历史 GPU 任务: ${latestTask.id}, status: ${latestTask.status}`);
      setIsRunning(true);
      setIsGpuTaskRunning(true);
      setGpuTaskStatus(latestTask.status === 'pending' ? 'pending' : 'running');
      setRunningTaskId(latestTask.id);
      // 运行中的任务不加载完整数据（可能还没有结果）
      return;
    }

    // 🔥 已完成的任务：加载完整数据作为 live 预览
    try {
      const fullTask = await trainingTaskStorage.getById(latestTask.id);
      if (fullTask) {
        setPreviewContent(fullTask.stdout_output || '');
        setGeneratedFiles(fullTask.files_json || {});
        setCharts(fullTask.charts_json || []);
        setLastExecutedAt(fullTask.created_at);
        setExecutionTime(fullTask.duration ? fullTask.duration * 1000 : undefined);
        console.log(`✅ [DesktopAppViewer] 已加载最近任务作为 live 预览: ${fullTask.id}`);
      }
    } catch (err) {
      console.warn('⚠️ [DesktopAppViewer] 加载最近任务完整数据失败:', err);
    }
  };

  // 🚀 初始化加载应用数据
  useEffect(() => {
    if (!isOpen || !appId) return;
      
    loadApp();
    // 🔥 GPU 状态恢复由 HistoryTaskList 的 onLatestTaskChange 回调处理
  }, [isOpen, appId]);
  
  // 🚀 订阅文件树变化事件（实时模式：AI修改成功后的事件通知）
  // 🔥 去重：1 秒内的重复事件跳过（避免 save_project_file 和 fs.watch 双重通知）
  const lastFileChangeTimeRef = useRef<number>(0);

  // 🔥 替代已删除的 codeEditEventService.code_updated
  // 职责：仅同步磁盘最新内容到编辑器；不再弹「已保存」toast，也不再做 previousCode 挪窝
  // - 用户主动 Save 的 toast 由 handleSave 负责
  // - fs.watch 误报/AI 修改的提示由 DesktopAppCard 红点承担，避免文案混淆
  // - previousCode 的挪窝只在 diff 模式（handleViewDiff/handleFileSelect）下有意义
  useEffect(() => {
    if (!isOpen) return;

    const handleFilesChanged = async (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.appId !== appId) return;

      // 🔥 去重：1 秒内跳过（fs.watch 兜底与 save_project_file 可能同时触发）
      const now = Date.now();
      if (now - lastFileChangeTimeRef.current < 1000) return;
      lastFileChangeTimeRef.current = now;

      // 🔥 主动从文件树读取当前文件的最新内容（AI 外部修改同步到编辑器）
      if (selectedFilePath) {
        const latestContent = await getCurrentFileContent(appId, selectedFilePath);
        if (latestContent !== null) {
          handleCodeChange(latestContent);
        }
      }
    };

    window.addEventListener('trainProjectFilesChanged', handleFilesChanged);
    return () => window.removeEventListener('trainProjectFilesChanged', handleFilesChanged);
  }, [isOpen, appId, selectedFilePath, handleCodeChange]);

  // 🚀 从数据库加载应用详情（包括previousCode）
  const loadApp = async () => {
    try {
      const appDetail = await getAppDetail(appId);
        
      if (appDetail) {
        // 🔥 不再从数据库加载 code，代码由文件树管理
        setPreviousCode(appDetail.previous_code || '');
        setAppName(appDetail.name || '');
        setAppConfig(appDetail.config || {});
          
        // 🔥 方案 B：不再从 desktop_apps.preview 加载大字段
        // live 预览的数据来源改为 training_tasks 表的最近一条记录
        // 由 HistoryTaskList 的 onLatestTaskChange 回调设置
      }
    } catch (error) {
      console.error('Failed to load desktop app:', error);
      toast({
        title: t('workspace.desktopModule.errorOccurred'),
        variant: 'destructive'
      });
    }
  };

  const handleAppNameDoubleClick = () => {
    setEditingAppName(true);
  };

  const handleAppNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setAppName(e.target.value);
  };

  const handleAppNameBlur = async () => {
    if (!appName.trim()) {
      setAppName(initialApp?.name || '');
      setEditingAppName(false);
      return;
    }
    
    try {
      // 使用AppDatabaseService来更新应用
      // 🔥 方案 B：不再保存 preview 大字段，只更新应用名称
      await appDatabaseService.updateDesktopApp(appId, {
        name: appName
      } as any, userId);
      
      toast({
        title: t('workspace.desktopModule.desktopAppViewer.appUpdated'),
      });
      
      onAppUpdated(appId); // 通知父组件更新
    } catch (error) {
      console.error('Failed to update app name:', error);
      setAppName(initialApp?.name || ''); // 恢复原始名称
      toast({
        title: t('workspace.desktopModule.codeEditor.saveFailed'),
        variant: 'destructive'
      });
    } finally {
      setEditingAppName(false);
    }
  };

  const handleAppNameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      setAppName(initialApp?.name || '');
      setEditingAppName(false);
    }
  };

  const handleExecutionResult = (result: any) => {
    // 🔥 清除之前的错误状态
    setExecutionError(undefined);
    
    // 🔥 安全检查：确保 result 是对象
    if (!result || typeof result !== 'object') {
      console.warn('⚠️ [DesktopAppViewer] handleExecutionResult 收到无效结果:', result);
      setExecutionError(t('workspace.desktopModule.desktopAppViewer.invalidResultFormat'));
      toast({
        title: t('workspace.desktopModule.desktopAppViewer.invalidResultFormat'),
        variant: 'destructive'
      });
      return;
    }
    
    if (result.success) {
      // 🚀 如果是 GPU 任务，执行完成后刷新任务列表
      if (result.executionMode === 'gpu') {
        historyListRef.current?.refresh();
      }

      // 更新执行时间
      if (result.executionTime) {
        setExecutionTime(result.executionTime);
      }
      setLastExecutedAt(result.lastExecutedAt || new Date().toISOString());

      // 更新预览内容
      setPreviewContent(result.output || '执行成功，无输出');
      
      // 🔥 处理生成的文件：添加类型检查
      if (result.files && typeof result.files === 'object' && !Array.isArray(result.files)) {
        const filesObj = result.files as { [key: string]: any };
        if (Object.keys(filesObj).length > 0) {
          console.log('📁 生成的文件:', filesObj);
          setGeneratedFiles(filesObj);
        }
      } else if (result.files) {
        console.warn('⚠️ [DesktopAppViewer] files 格式不正确，期望对象:', result.files);
      }
      
      // 🔥 处理生成的图表：添加类型检查
      if (result.charts && Array.isArray(result.charts) && result.charts.length > 0) {
        console.log('📊 生成的图表:', result.charts);
        setCharts(result.charts);
      } else if (result.charts) {
        console.warn('⚠️ [DesktopAppViewer] charts 格式不正确，期望数组:', result.charts);
      }
      
      // 显示执行模式提示
      toast({
        title: t('workspace.desktopModule.codeEditor.success'),
      });
    } else {
      // 🔥 错误时设置独立的错误状态，而不是混入previewContent
      const errorMsg = result.error || t('workspace.desktopModule.desktopAppViewer.executeFailed');
      setExecutionError(errorMsg);
      setPreviewContent(''); // 清空正常输出
      toast({
        title: errorMsg,
        variant: 'destructive'
      });
    }

    // 🔥 新执行结果到达：自动切到一半一半，方便查看结果（默认进入是代码区最大）
    setIsEditorExpanded(false);
    setIsPreviewExpanded(false);
  };

  // 🚀 核心执行逻辑
  /**
   * 🔥 云端执行入口 - 弹选择框（GPU 卡型 + CPU 档位同列表，用户显式选择）
   * 本地执行由 handleRunDev 处理，路径互不交叉
   */
  const handleGpuTrain = async () => {
    if (!appId || isRunning) return;

    setIsRunning(true);
    setExecutionTime(undefined);
    setGeneratedFiles({});
    setCharts([]);
    setExecutionError(undefined);
    setPreviewContent('');
    
    try {
      const codeContent = getCodeContent(codeRef.current);
      const taskId = crypto.randomUUID();

      const executeWithGpu = async (gpuOption: any) => {
        setIsRunning(true);
        setIsGpuTaskRunning(true);
        setGpuTaskStatus('pending'); 

        try {
          console.log(`🚀 [FRONTEND] 发起 GPU 执行: ${gpuOption.provider} - ${gpuOption.instanceType}, TaskId: ${taskId}`);
          setTimeout(() => historyListRef.current?.refresh(), 2000);

          const result = await appExecutionService.execute({
            appId,
            userId,
            isGpu: true,
            gpuInstanceType: gpuOption.instanceType,
            gpuProvider: gpuOption.provider,
            code: codeContent,
            config: appConfig,
          });
          
          handleExecutionResult(result);
          
          if (!result.success) {
            setIsRunning(false);
            setIsGpuTaskRunning(false);
            setGpuTaskStatus('none');
            historyListRef.current?.refresh();
          }
        } catch (err) {
          console.error('GPU Execution failed:', err);
          setIsRunning(false);
          setIsGpuTaskRunning(false);
          setGpuTaskStatus('none');
          historyListRef.current?.refresh();
        }
      };

      // 直接弹 GPU 选择框（管理面板：训练中任务 + 规格选择），不检查代码
      if (!gpuConfirmationCallback) {
        fetchRunningTrainTasks();
        setShowGpuConfirmation(true);
        setGpuConfirmationCallback(() => (gpuOption: any) => executeWithGpu(gpuOption));
        setIsRunning(false);
        return;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '执行失败';
      setPreviewContent(errorMessage);
      toast({
        title: t('workspace.desktopModule.codeEditor.error'),
        variant: 'destructive'
      });
    } finally {
      setIsRunning(false);
    }
  };

  // 🚀 云端训练触发
  const handleRun = async () => {
    setExecutionTime(undefined);
    await handleGpuTrain();
    setTimeout(() => historyListRef.current?.refresh(), 2000);
  };

  // 🔥 SSHRun：开机常驻实例（长期租赁，区别于 Train/Run 跑完即销毁）
  // 只做触点：核心逻辑统一走 sshOpenInstance（与 LLM ssh_instance 工具同一条链路）
  const handleSshBoot = async (spec: SshSpecOption) => {
    setShowSshSelector(false);
    if (isSshBooting) return;
    setIsSshBooting(true);
    try {
      const r = await sshOpenInstance({ instanceType: spec.instanceType, projectId: appId, userId });
      if (r.ok && r.instance) {
        toast({
          title: r.sshReady === false ? '云端实例已开机（免密探测未通过，稍等 1-2 分钟）' : '云端常驻实例已就绪',
          description: `IP: ${r.instance.public_ip}（${r.instance.instance_type}）。上传文件与运行交给 agent 编排即可，用完记得关机。`,
        });
        refreshResidentIndicator();
      } else {
        throw new Error(r.error || '开机失败');
      }
    } catch (error: any) {
      console.error('[SSH-RUN] 开机失败:', error);
      toast({
        title: '云端实例开机失败',
        description: error?.message || '未知错误',
        variant: 'destructive'
      });
    } finally {
      setIsSshBooting(false);
    }
  };

  // 🚀 手动保存代码（用户点击Save按钮）
  // 🔥 简化架构：保存到 files 目录，不创建历史版本
  // 🔥 历史版本由用户点击 Commit 按钮创建
  const handleSave = async () => {
    setIsSaving(true);
    try {
      // 🔥 确定文件名
      const fileName = currentFileName || 'main.py';

      // 🔥 使用 ref 获取最新代码（解决异步状态问题）
      const currentCode = codeRef.current;
      const result = await saveFile(appId, fileName, currentCode);

      if (result.success) {
        console.log('[DesktopAppViewer] 文件保存成功:', fileName);

        // 🔥 刷新文件树
        if ((window as any).__fileTreeRefresh) {
          (window as any).__fileTreeRefresh();
        }

        // 🔥 保存后刷新 previousCode（saveFile 可能创建了历史副本）
        const historyContent = await getHistoryContent(appId, fileName);
        setPreviousCode(historyContent || '');

        // 🔥 通知 ChangeList 重算该文件的 diff 统计
        window.dispatchEvent(new CustomEvent('changeListFileChanged', { detail: { fileName } }));

        toast({
          title: t('workspace.desktopModule.codeEditor.saved'),
        });

        // 🔥 方案 B：不再将 previewContent 持久化到 desktop_apps.preview
        // 预览数据统一由 training_tasks 表管理，避免数据冗余
        onAppUpdated(appId);
      } else {
        throw new Error(result.error || t('workspace.desktopModule.desktopAppViewer.saveFailed'));
      }
    } catch (error) {
      console.error('Failed to save desktop app:', error);
      toast({
        title: t('workspace.desktopModule.codeEditor.saveFailed'),
        variant: 'destructive'
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleFileSelect = async (filePath: string, content: string) => {
    console.log('[DESKTOP-APP-VIEWER] 文件选中:', filePath);

    setSelectedFilePath(filePath);

    // 🔥 选中普通文件时退出 diff 模式
    setShowDiff(false);

    // 🔥 计算相对于 appId 目录的相对路径
    const electron = (window as any).electron;
    let relativePath = filePath;
    if (electron?.getUserDataPath) {
      // 🔥 支持导入项目：使用实际的代码目录路径计算相对路径
      const { getAppBasePath } = await import('@/utils/apptool/AppPathHelper');
      const appDir = await getAppBasePath(appId);
      // 🔥 统一分隔符后匹配
      const normalizedFilePath = filePath.replace(/\\/g, '/');
      const normalizedAppDir = appDir.replace(/\\/g, '/');
      if (normalizedFilePath.startsWith(normalizedAppDir)) {
        relativePath = filePath.slice(appDir.length + 1); // +1 去掉开头的斜杠
      }
    }

    setCurrentFileName(relativePath);

    // 🔥 图片/视频等二进制文件跳过文本内容处理，由专用 Viewer 自行读取
    if (isImageFile(relativePath) || isVideoFile(relativePath)) {
      setIsEditorExpanded(true);
      setIsPreviewExpanded(false);
      return;
    }

    console.log('[DESKTOP-APP-VIEWER] 文件内容:', content?.substring(0, 100));
    handleCodeChange(content);

    // 🔥 切换文件时保持代码区最大（默认进入代码最大，执行结果到达时才切一半一半）
    setIsEditorExpanded(true);
    setIsPreviewExpanded(false);

    // 🔥 从 history 目录读取 previousCode（供手动点击 diff 按钮时使用）
    const historyContent = await getHistoryContent(appId, relativePath);
    setPreviousCode(historyContent || '');
    console.log('[DESKTOP-APP-VIEWER] 历史版本:', historyContent?.substring(0, 100));
  };

  // 🔥 查看历史版本
  const handleViewHistory = (fileName: string, content: string) => {
    console.log('[DESKTOP-APP-VIEWER] 查看历史版本:', fileName, '内容长度:', content?.length);
    
    if (!content) {
      toast({ title: t('workspace.desktopModule.desktopAppViewer.historyEmpty'), variant: 'destructive' });
      return;
    }

    // 🔥 将历史版本内容显示在编辑器中
    handleCodeChange(content);
    toast({ title: t('workspace.desktopModule.desktopAppViewer.viewHistoryVersion', { fileName }) });
  };

  // 🔥 从变更记录点击 → 在 CodeEditor 中显示 diff
  const handleViewDiff = async (fileName: string, oldCode: string, newCode: string) => {
    console.log('[DESKTOP-APP-VIEWER] 查看 diff:', fileName);

    // 更新 selectedFilePath 指向该文件
    const electron = (window as any).electron;
    if (electron?.getUserDataPath) {
      // 🔥 支持导入项目：使用实际的代码目录路径
      const { getAppBasePath } = await import('@/utils/apptool/AppPathHelper');
      const baseDir = await getAppBasePath(appId);
      const fullPath = `${baseDir}/${fileName.replace(/\\/g, '/')}`;
      setSelectedFilePath(fullPath);
    }
    setCurrentFileName(fileName);

    // 设置 previousCode 和 currentCode，开启 diff 模式
    setPreviousCode(oldCode);
    handleCodeChange(newCode);
    setShowDiff(true);
  };

  // 🔥 ChangeList 文件接受/回退后 → 退出 diff 模式
  const handleFileHandled = async (fileName: string, action: 'accept' | 'revert') => {
    console.log('[DESKTOP-APP-VIEWER] 文件已处理:', fileName, action);
    // 如果当前 diff 显示的是被操作的文件，退出 diff 模式
    if (currentFileName === fileName) {
      setShowDiff(false);
      setPreviousCode('');
      // 接受后 code 保持不变；回退后需要重新加载文件内容
      if (action === 'revert') {
        // 🔥 回退后重新加载文件内容到 CodeEditor
        try {
          const revertedContent = await getCurrentFileContent(appId, fileName);
          if (revertedContent != null) {
            handleCodeChange(revertedContent);
            console.log('[DESKTOP-APP-VIEWER] 回退完成，已更新 CodeEditor');
          }
        } catch (err) {
          console.error('[DESKTOP-APP-VIEWER] 回退后加载文件失败:', err);
        }
      }
    }
  };

  const handleOpenInBrowser = () => {
    if (!selectedFilePath) return;
    const electron = (window as any).electron;
    // 🔥 使用 openPath 打开本地文件，而不是 openExternal
    if (electron?.shell?.openPath) {
      electron.shell.openPath(selectedFilePath);
    } else if (electron?.openPath) {
      electron.openPath(selectedFilePath);
    } else {
      window.open(selectedFilePath, '_blank');
    }
  };


  return (
    <div className="h-full min-h-0 min-w-0 w-full flex flex-col overflow-hidden">
      {/* 顶部工具栏 */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-gray-50 dark:bg-gray-800 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <button
            onClick={() => setShowFileTree(!showFileTree)}
            className="p-1.5 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
            title={showFileTree ? t('workspace.desktopModule.desktopAppViewer.hideFileTree') : t('workspace.desktopModule.desktopAppViewer.showFileTree')}
          >
            {showFileTree ? (
              <PanelLeftClose className="w-4 h-4 text-gray-600 dark:text-gray-400" />
            ) : (
              <PanelLeftOpen className="w-4 h-4 text-gray-600 dark:text-gray-400" />
            )}
          </button>
          {/* 🔥 普通标题（非 DialogTitle）：viewer 现在也在独立窗口中使用，无 Dialog context */}
          <h2 onDoubleClick={handleAppNameDoubleClick} className="cursor-pointer text-sm font-medium truncate">
            {editingAppName ? (
              <input
                type="text"
                value={appName}
                onChange={handleAppNameChange}
                onBlur={handleAppNameBlur}
                onKeyDown={handleAppNameKeyDown}
                autoFocus
                className="bg-white border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent w-48"
              />
            ) : (
              <span className="inline-block min-w-0 truncate">{appName || t('workspace.desktopModule.desktopAppViewer.defaultAppName')}</span>
            )}
          </h2>
          {selectedFilePath && (
            <span className="text-xs text-gray-500 dark:text-gray-400 truncate font-mono" title={selectedFilePath}>
              / {currentFileName}
            </span>
          )}
        </div>
        
        <div className="flex items-center gap-1">
          {selectedFilePath && selectedFilePath.toLowerCase().endsWith('.html') && (
            <Button variant="outline" size="sm" onClick={handleOpenInBrowser} className="h-7 w-7 p-0" title={t('workspace.desktopModule.desktopAppViewer.openInBrowser')}>
              <ExternalLink className="w-3.5 h-3.5" />
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={handleSave} className="h-7 w-7 p-0" title={t('workspace.desktopModule.desktopAppViewer.save')}>
            {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          </Button>
          {/* 🔥 云端运行按钮（恒定样式）：点开 GPU 管理面板（训练中任务查看/停止 + 规格选择）；有任务跑时文字后加绿点 */}
          <Button
            variant="outline" size="sm"
            onClick={handleRun}
            className={`h-7 px-2 text-xs font-medium ${isRunning ? 'bg-blue-50 border-blue-200 text-blue-600' : 'bg-white hover:bg-gray-100'}`}
            title={t('workspace.desktopModule.desktopAppViewer.cloudTraining')}
          >
            {isRunning ? (
              <span className="flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />Run</span>
            ) : (
              <span className="flex items-center gap-1">
                <CloudLightning className="w-3 h-3" />Train | Run
                {(runningTrainTasks.length > 0 || isGpuTaskRunning) && <span className="h-1.5 w-1.5 rounded-full bg-green-500" />}
              </span>
            )}
          </Button>
          {/* 🔥 常驻按钮：点开常驻实例管理面板（开机新机 / 查看运行中的多台 / 关机） */}
          <Button
            variant="outline" size="sm"
            onClick={() => setShowSshSelector(true)}
            disabled={isSshBooting}
            className={`h-7 px-2 text-xs font-medium ${isSshBooting ? 'bg-blue-50 border-blue-200 text-blue-600' : 'bg-white hover:bg-gray-100'}`}
            title={isSshBooting ? '开机中...' : '常驻实例（开机 / 查看 / 关机）'}
          >
            {isSshBooting ? (
              <span className="flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />开机中</span>
            ) : (
              <span className="flex items-center gap-1">
                <Cloud className="w-3 h-3" />常驻
                {hasRunningResident && <span className="h-1.5 w-1.5 rounded-full bg-green-500" />}
              </span>
            )}
          </Button>
          {/* 🔥 RunDev 按钮：本地代码执行 */}
          <Button
            variant="outline" size="sm"
            onClick={handleRunDev}
            disabled={isLocalRunning || isRunning || isGpuTaskRunning}
            className={`h-7 px-2 text-xs font-medium ${isLocalRunning ? 'bg-green-100 border-green-300 text-green-700' : 'bg-white hover:bg-gray-100'}`}
            title={isLocalRunning ? t('workspace.desktopModule.desktopAppViewer.executing') : t('workspace.desktopModule.desktopAppViewer.localExecute')}
          >
            {isLocalRunning ? (
              <span className="flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />Run</span>
            ) : (
              <span className="flex items-center gap-1"><Terminal className="w-3 h-3" />LocalRun</span>
            )}
          </Button>
          {/* 🔥 Stop 按钮：项目有常驻服务进程（dev server）时出现，主动停掉释放端口/内存 */}
          {hasLocalService && (
            <Button
              variant="outline" size="sm"
              onClick={handleStopLocalService}
              disabled={isLocalRunning}
              className="h-7 px-2 text-xs font-medium bg-red-50 hover:bg-red-100 text-red-600 hover:text-red-700 border-red-200"
              title={t('workspace.desktopModule.desktopAppViewer.stopService')}
            >
              <span className="flex items-center gap-1"><OctagonX className="w-3 h-3" />Stop</span>
            </Button>
          )}
          {/* 🔥 embedded（独立窗口）模式不显示 viewer 自带关闭按钮，由页面标题栏窗口控制接管 */}
          {!embedded && (
            <Button
              variant="ghost" size="sm" onClick={onClose}
              className="h-7 w-7 p-0 hover:bg-gray-200 dark:hover:bg-gray-700"
              title={t('workspace.desktopModule.desktopAppViewer.close')}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* 主内容区 */}
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden flex relative">
        {/* 🔥 主按钮：代码最大 ↔ 一半一半（惯常操作，两态切换） */}
        <Button 
          variant="outline" size="sm" 
          onClick={() => {
            setIsEditorExpanded(!isEditorExpanded);
            setIsPreviewExpanded(false);
          }} 
          className="absolute right-2 top-2 h-7 w-7 p-0 z-10 bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm shadow-sm hover:shadow-md transition-all"
          title={isEditorExpanded ? t('workspace.desktopModule.desktopAppViewer.halfHalf') : t('workspace.desktopModule.desktopAppViewer.codeMax')}
        >
          <CalendarSync className="w-3.5 h-3.5" />
        </Button>

        {/* 🔥 次按钮：一半一半 ↔ Preview最大（低频操作，只在非代码最大时显示） */}
        {!isEditorExpanded && (
          <Button 
            variant="outline" size="sm" 
            onClick={() => {
              setIsPreviewExpanded(!isPreviewExpanded);
            }} 
            className="absolute right-10 top-2 h-7 w-7 p-0 z-10 bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm shadow-sm hover:shadow-md transition-all"
            title={isPreviewExpanded ? t('workspace.desktopModule.desktopAppViewer.halfHalf') : t('workspace.desktopModule.desktopAppViewer.previewMax')}
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </Button>
        )}
        {/* 文件树 */}
        {showFileTree && (
          <div className="w-64 border-r border-gray-200 dark:border-gray-700 flex-shrink-0 h-full overflow-y-auto">
            {/* 🔥 始终显示 LegacyFileTree 组件（包含 Clone Repository 按钮） */}
            <LegacyFileTree
              appId={appId}
              onFileSelect={handleFileSelect}
              selectedFile={selectedFilePath}
              onRefresh={() => console.log('[DesktopAppViewer] FileTree refreshed')}
              onViewHistory={handleViewHistory}
              onViewDiff={handleViewDiff}
              onFileHandled={handleFileHandled}
            />
          </div>
        )}

        {/* 代码编辑器 / CAD 预览器 / 图片预览 / 视频预览 */}
        {!isPreviewExpanded && (
          <div className={`flex-1 min-w-0 flex flex-col h-full overflow-hidden`}>
            {selectedFilePath ? (
              isCadFile(currentFileName) ? (
                <CadPreview
                  filePath={selectedFilePath}
                  appId={appId}
                  fileName={currentFileName}
                />
              ) : isImageFile(currentFileName) ? (
                <ImageViewer
                  filePath={selectedFilePath}
                  fileName={currentFileName}
                />
              ) : isVideoFile(currentFileName) ? (
                <VideoViewer
                  filePath={selectedFilePath}
                  fileName={currentFileName}
                />
              ) : isAudioFile(currentFileName) ? (
                <AudioViewer
                  filePath={selectedFilePath}
                  fileName={currentFileName}
                />
              ) : isPdfFile(currentFileName) ? (
                <PdfViewer
                  filePath={selectedFilePath}
                  fileName={currentFileName}
                />
              ) : isOfficeFile(currentFileName) ? (
                <OfficeViewer
                  filePath={selectedFilePath}
                  fileName={currentFileName}
                />
              ) : (
              <CodeEditor
                currentCode={code}
                previousCode={previousCode}
                onChange={handleCodeChange}
                language="python"
                height="100%"
                showDiff={showDiff}
                appId={appId}
                userId={userId}
                config={appConfig}
                filePath={selectedFilePath}
                onDiffHandled={(action) => {
                  console.log('[DESKTOP-APP-VIEWER] CodeEditor diff 处理:', action);
                  setShowDiff(false);
                  setPreviousCode('');
                }}
              />
              )
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-gray-400 text-sm">
                <FileIcon className="w-12 h-12 mb-3 opacity-30" />
                <p>{t('workspace.desktopModule.desktopAppViewer.selectFileFromTree')}</p>
                <p className="text-xs mt-1 opacity-60">{t('workspace.desktopModule.desktopAppViewer.orCreateNew')}</p>
              </div>
            )}
          </div>
        )}

        {/* 预览查看器 */}
        {(!isEditorExpanded || isPreviewExpanded) && (
        <div className={`flex-1 min-w-0 flex flex-col h-full min-h-0 overflow-hidden border-l border-gray-200 dark:border-gray-700`}>
          <div className="flex-shrink-0 bg-gray-50 dark:bg-gray-800 border-b flex items-center justify-between px-2 h-10">
            <div className="flex bg-gray-200 dark:bg-gray-700 p-0.5 rounded-md text-[10px]">
              <button 
                onClick={() => { setPreviewTab('live'); setSelectedTask(null); }}
                className={`px-3 py-1 rounded flex items-center gap-1 transition-all ${previewTab === 'live' ? 'bg-white dark:bg-gray-600 shadow-sm text-blue-600' : 'text-gray-500 hover:text-gray-700'}`}
              >
                <Zap className="w-3 h-3" />
                {t('workspace.desktopModule.previewViewer.title')}
              </button>
              <button
                onClick={() => { setPreviewTab('history'); historyListRef.current?.refresh(); }}
                className={`px-3 py-1 rounded flex items-center gap-1 transition-all ${previewTab === 'history' ? 'bg-white dark:bg-gray-600 shadow-sm text-blue-600' : 'text-gray-500 hover:text-gray-700'}`}
              >
                <CloudLightning className="w-3 h-3" />
                {t('workspace.desktopModule.desktopAppViewer.trainingHistory')} ({historyTotalCount})
              </button>
              <button
                onClick={() => { setPreviewTab('logs'); executionLogListRef.current?.refresh(); }}
                className={`px-3 py-1 rounded flex items-center gap-1 transition-all ${previewTab === 'logs' ? 'bg-white dark:bg-gray-600 shadow-sm text-green-600' : 'text-gray-500 hover:text-gray-700'}`}
              >
                <Terminal className="w-3 h-3" />
                {t('workspace.desktopModule.desktopAppViewer.executionLog', { count: executionLogCount })}
              </button>
            </div>
            <div className="flex items-center gap-1">
              {previewTab === 'history' && selectedTask && (
                <button
                  onClick={() => setSelectedTask(null)}
                  className="text-[10px] text-blue-600 hover:underline flex items-center gap-1 mr-10"
                >
                  <LayoutPanelLeft className="w-3 h-3" /> {t('workspace.desktopModule.desktopAppViewer.backToList')}
                </button>
              )}
              {previewTab === 'logs' && selectedLog && (
                <button
                  onClick={() => setSelectedLog(null)}
                  className="text-[10px] text-green-600 hover:underline flex items-center gap-1 mr-14"
                >
                  <LayoutPanelLeft className="w-3 h-3" /> {t('workspace.desktopModule.desktopAppViewer.backToList')}
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-hidden relative">
            <div className={(previewTab === 'live' || (previewTab !== 'logs' && selectedTask)) ? 'h-full' : 'hidden'}>
              <PreviewViewer 
                content={selectedTask ? selectedTask.stdout_output : previewContent}
                isLoading={selectedTask ? false : (isRunning || isGpuTaskRunning)}
                loadingMessage={
                  gpuTaskStatus === 'starting' 
                    ? t('workspace.desktopModule.desktopAppViewer.resourceAdjustmentWait') 
                    : gpuTaskStatus === 'pending' 
                      ? t('workspace.desktopModule.desktopAppViewer.instanceCreatingWait')
                      : gpuTaskStatus === 'running' 
                        ? t('workspace.desktopModule.desktopAppViewer.trainingProgressWait') 
                        : undefined
                }
                error={selectedTask ? undefined : executionError}
                files={selectedTask ? selectedTask.files_json : generatedFiles}
                charts={selectedTask ? selectedTask.charts_json : charts}
                trainingInfo={selectedTask ? {
                  status: selectedTask.status,
                  duration: selectedTask.duration,
                  cost: selectedTask.cost,
                  instanceType: selectedTask.instance_type,
                  createdAt: selectedTask.created_at,
                  modelUrl: selectedTask.model_oss_url
                } : undefined}
                appId={appId}
                onClose={onClose}
                executionTime={selectedTask ? (selectedTask.duration * 1000) : executionTime}
                lastExecutedAt={selectedTask ? selectedTask.created_at : lastExecutedAt}
                conversationId={conversationId}
              />
            </div>
            
            <div className={previewTab === 'history' && !selectedTask && !selectedLog ? 'h-full' : 'hidden'}>
              <HistoryTaskList
                ref={historyListRef}
                appId={appId}
                onSelectTask={setSelectedTask}
                onTotalCountChange={setHistoryTotalCount}
                onLatestTaskChange={handleLatestTaskChange}
              />
            </div>

            <div className={previewTab === 'logs' && !selectedLog ? 'h-full' : 'hidden'}>
              <ExecutionLogList
                ref={executionLogListRef}
                appId={appId}
                onSelectLog={setSelectedLog}
                onTotalCountChange={setExecutionLogCount}
              />
            </div>

            <div className={previewTab === 'logs' && selectedLog ? 'h-full' : 'hidden'}>
              <PreviewViewer
                content={selectedLog?.stdout_output || ''}
                isLoading={selectedLog?.status === 'running'}
                loadingMessage={selectedLog?.status === 'running' ? t('workspace.desktopModule.desktopAppViewer.executing') : undefined}
                error={selectedLog?.status === 'failed' ? (selectedLog.stderr_output || selectedLog.error_message) : undefined}
                appId={appId}
                onClose={onClose}
                executionTime={selectedLog?.duration || 0}
                lastExecutedAt={selectedLog?.created_at ? new Date(selectedLog.created_at).toISOString() : undefined}
                conversationId={conversationId}
              />
            </div>
          </div>
          
        </div>
        )}
        
        {/* GPU 管理弹窗（训练中任务查看/停止 + GPU 卡型/CPU 档位选择） */}
        <GPUSelectorDialog
          isOpen={showGpuConfirmation}
          userBalance={userBalance}
          onSelect={handleGpuConfirm}
          onCancel={handleGpuCancel}
          onRecharge={() => {
            setShowGpuConfirmation(false);
            setShowRechargeDialog(true);
          }}
          runningTasks={runningTrainTasks}
          onStopTask={handleKillTrain}
          stoppingTaskId={isKilling ? killTargetTaskId : null}
        />

        {/* SSH 实例选择弹窗（长期租赁，开机常驻） */}
        <SSHSelectorDialog
          isOpen={showSshSelector}
          userBalance={userBalance}
          currentAppId={appId}
          onSelect={handleSshBoot}
          onCancel={() => setShowSshSelector(false)}
          onRecharge={() => {
            setShowSshSelector(false);
            setShowRechargeDialog(true);
          }}
          userId={userId}
        />

        {/* 🔥 充值弹窗 - 移到条件块外，全屏时也能显示 */}
        <RechargeDialog
          open={showRechargeDialog}
          onOpenChange={(open) => {
            setShowRechargeDialog(open);
            if (!open) {
              refreshBalance();
            }
          }}
          onRechargeSuccess={() => {
            refreshBalance();
            toast({
              title: t('workspace.desktopModule.desktopAppViewer.rechargeSuccess'),
              description: t('workspace.desktopModule.desktopAppViewer.rechargeSuccessDesc'),
            });
          }}
        />

        {/* 🔥 GPU 代码本地执行警告 */}
        <AlertDialog open={gpuCodeWarning.show} onOpenChange={(open) => { if (!open) setGpuCodeWarning({ show: false }); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('workspace.desktopModule.desktopAppViewer.gpuWarningTitle')}</AlertDialogTitle>
              <AlertDialogDescription className="space-y-2">
                <p>{gpuCodeWarning.reason || t('workspace.desktopModule.desktopAppViewer.gpuWarningDefault')}</p>
                <p>{t('workspace.desktopModule.desktopAppViewer.gpuWarningDesc')}</p>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('workspace.desktopModule.desktopAppViewer.cancel')}</AlertDialogCancel>
              <AlertDialogAction onClick={() => handleRunDev()} className="bg-orange-500 hover:bg-orange-600">
                {t('workspace.desktopModule.desktopAppViewer.stillExecute')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* 🔥 Kill 训练确认弹窗 */}
        {showKillDialog && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50" onClick={() => setShowKillDialog(false)}>
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-96 p-6" onClick={e => e.stopPropagation()}>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">{t('workspace.desktopModule.desktopAppViewer.stopTraining')}</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                {t('workspace.desktopModule.desktopAppViewer.killConfirmDesc')}
              </p>
              <textarea
                value={killReason}
                onChange={(e) => setKillReason(e.target.value)}
                placeholder={t('workspace.desktopModule.desktopAppViewer.killReasonPlaceholder')}
                className="w-full h-20 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md resize-none focus:outline-none focus:ring-2 focus:ring-red-500 dark:bg-gray-700 dark:text-gray-200"
              />
              <div className="flex justify-end gap-2 mt-4">
                <Button variant="outline" size="sm" onClick={() => setShowKillDialog(false)} disabled={isKilling}>
                  {t('workspace.desktopModule.desktopAppViewer.cancel')}
                </Button>
                <Button variant="destructive" size="sm" onClick={handleKillConfirm} disabled={isKilling}>
                  {isKilling ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : null}
                  {isKilling ? t('workspace.desktopModule.desktopAppViewer.stopping') : t('workspace.desktopModule.desktopAppViewer.confirmStop')}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default DesktopAppViewer;
