/**
 * 聊天页面头部组件
 */

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { User, Settings, LogOut, RefreshCw, Sparkles, Server, X, Minus, Cloud, Key } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useUserBalance } from '@/hooks/payment/useUserBalance';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ModelSettings } from '@/components/profile/ModelSettings';
import { CredentialManager } from '@/components/workspace/auth/CredentialManager';
import { syncModelKeyCredentials } from '@/components/workspace/auth/modelKeySync';
import { ModelManager } from '@/utils/llm/ModelManager';
import { CloudAuthService } from '@/services/cloud/CloudAuthService';
import { loadBaseProjectTools } from '@/utils/auto/BaseProjectToolLoader';
import { RechargeDialog } from '@/components/payment/RechargeDialog';
import { RechargeHistory } from '@/components/payment/RechargeHistory';
import i18n from '@/i18n/index';

interface ChatHeaderProps {
  userId?: string;
  userEmail?: string;
  onOpenDesktop?: () => void;
  isDesktopOpen?: boolean;
  onOpenDSE?: () => void;
  isDSEOpen?: boolean;
}

const ChatHeader: React.FC<ChatHeaderProps> = ({
  userId,
  userEmail,
  onOpenDesktop,
  isDesktopOpen,
  onOpenDSE,
  isDSEOpen
}) => {
  const { t } = useTranslation();

  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [showModelSettings, setShowModelSettings] = useState(false);
  const [showRechargeDialog, setShowRechargeDialog] = useState(false);
  const [showHistoryDialog, setShowHistoryDialog] = useState(false);
  const [showCredentialManager, setShowCredentialManager] = useState(false);
  const { isAuthenticated, user, logout, setShowAuthModal, setAuthModalView, session } = useAuth();
  const { balance, refreshBalance } = useUserBalance();

  // Electron 环境检测
  const isElectron = typeof window !== 'undefined' && (window as any).electron?.isElectron;
  // 🔥 macOS 检测：macOS 使用原生红绿灯按钮，不显示自定义窗口控件
  const isMac = isElectron && (window as any).electron?.platform === 'darwin';
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking'>('idle');
  const [isMaximized, setIsMaximized] = useState(false);
  const [appVersion, setAppVersion] = useState<string>('');

  // 🔥 启动时静默同步模型密钥到凭据池（延迟等待登录/后端就绪，失败不打扰）
  useEffect(() => {
    const uid = userId || user?.id;
    if (!uid) return;
    const timer = setTimeout(() => {
      syncModelKeyCredentials(String(uid)).catch(() => {});
    }, 2000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, user?.id]);

  // 🔥 刷新套餐模型的 JWT 快照：JWT 7 天过期，而 local-backend 的后台链路（summary/训练等）
  // 读的是持久化快照且不经过前端 cloudRequest（401 无法触发自动刷新）——
  // 必须启动时主动用 refreshToken（30 天）续期 access token，再刷快照，
  // 否则第 7 天起训练/总结全量 401"令牌无效或已过期"
  useEffect(() => {
    const refreshSnapshot = () => {
      ModelManager.refreshPackageModelTokens().catch(() => {});
    };
    const bootRefresh = async () => {
      try {
        const result = await CloudAuthService.refreshToken();
        if (!result.success) {
          // refreshToken 也过期（30 天未启动）——需重新登录，静默即可
          console.warn('[ChatHeader] 刷新 token 失败:', result.error);
        }
      } catch {
        // 网络异常不阻塞快照刷新
      }
      refreshSnapshot();
    };
    const timer = setTimeout(bootRefresh, 3000);
    // 登录成功时 token 必然新鲜，直接刷快照即可
    window.addEventListener('cloud-auth-changed', refreshSnapshot);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('cloud-auth-changed', refreshSnapshot);
    };
  }, []);

  // 🔥 启动时初始化基础项目并加载动态工具（幂等：已有项目/文件不覆盖，仅补缺失）
  // 🔥 失败重试：后端冷启动时首次加载可能失败（ensureBaseProject 报错，内部缓存已重置），
  //    4s 后重试一次，避免切换/新注册用户的基础项目永远没建出来（项目列表全空）
  useEffect(() => {
    const uid = userId || user?.id;
    if (!uid) return;
    const timer = setTimeout(() => {
      loadBaseProjectTools(String(uid)).then((count) => {
        if (count === 0) {
          setTimeout(() => loadBaseProjectTools(String(uid)).catch(() => {}), 4000);
        }
      }).catch(() => {});
      // 🔥 BootCode 项目（开源源码）初始化：与扩展工具同点触发（不依赖 ToolHandler 构造，
      //    那要到首次发消息才发生），内部幂等 + 失败下次启动自动重试
      import('@/utils/auto/BootProjectLoader').then((m) => m.loadBootProject(String(uid))).catch(() => {});
    }, 2500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, user?.id]);

  // 获取版本号
  React.useEffect(() => {
    if (!isElectron) return;
    const getVersion = async () => {
      try {
        const version = await (window as any).electron.getAppVersion?.();
        if (version) {
          setAppVersion(version);
        }
      } catch (e) {
        console.error('获取版本号失败:', e);
      }
    };
    getVersion();
  }, [isElectron]);

  // 监听窗口最大化状态
  React.useEffect(() => {
    if (!isElectron) return;
    const checkMaximized = async () => {
      if ((window as any).electron?.window) {
        const maximized = await (window as any).electron.window.isMaximized();
        setIsMaximized(maximized);
      }
    };
    checkMaximized();
    const interval = setInterval(checkMaximized, 500);
    return () => clearInterval(interval);
  }, [isElectron]);

  // Electron 窗口控制
  const handleMinimize = () => {
    if (isElectron && (window as any).electron?.window) {
      (window as any).electron.window.minimize();
    }
  };

  const handleMaximize = () => {
    if (isElectron && (window as any).electron?.window) {
      (window as any).electron.window.maximize();
    }
  };

  const handleClose = () => {
    if (isElectron && (window as any).electron?.window) {
      (window as any).electron.window.close();
    }
  };

  const handleLogin = () => {
    setAuthModalView('login');
    setShowAuthModal(true);
  };

  const handleLogout = async () => {
    await logout();
  };

  const getUserDisplayName = () => {
    if (user?.name) return user.name;
    if (user?.email) return user.email.split('@')[0];
    if (session?.user?.email) return session.user.email.split('@')[0];
    return t('workspace.chatHeader.defaultUserName');
  };

  const getUserInitial = () => {
    return getUserDisplayName().charAt(0).toUpperCase();
  };

  const getUserEmail = () => {
    return user?.email || session?.user?.email || '';
  };

  const getUserAvatarUrl = () => {
    return user?.avatar_url || session?.user?.user_metadata?.avatar_url;
  };

  const handleSetLanguage = async (lng: 'zh' | 'en') => {
    try {
      localStorage.setItem('preferredLanguage', lng);
      localStorage.setItem('i18nextLng', lng);
      await i18n.changeLanguage(lng);
    } catch (e) {
      console.error('更新语言偏好失败', e);
    }
  };

  const currentLng = (() => {
    try {
      const pref = localStorage.getItem('preferredLanguage') || i18n.language || 'en';
      return pref.toLowerCase().startsWith('zh') ? 'zh' : 'en';
    } catch {
      return 'en';
    }
  })();

  const handleCheckUpdate = async () => {
    if (!isElectron || !(window as any).electron?.updater) {
      return;
    }
    setUpdateStatus('checking');
    try {
      await (window as any).electron.updater.check();
    } catch (e) {
      console.error('检查更新失败:', e);
    }
    setTimeout(() => setUpdateStatus('idle'), 2000);
  };

  return (
    <>
      <div 
        className="flex items-center justify-between px-4 py-2 border-b bg-white flex-shrink-0 h-12"
        style={isElectron ? { WebkitAppRegion: 'drag' } as any : {}}
      >
        {/* 左侧：标题 - macOS 需要留出红绿灯按钮空间 */}
        <h2 className={`font-medium ${isMac ? 'ml-16' : ''}`}>{t('workspace.chatHeader.title')}</h2>

        {/* 右侧：操作按钮 - 使用统一的按钮样式 */}
        <div 
          className="flex items-center gap-1"
          style={isElectron ? { WebkitAppRegion: 'no-drag' } as any : {}}
        >
          {/* 项目按钮 */}
          {onOpenDesktop && (
            <Button
              variant={isDesktopOpen ? "secondary" : "ghost"}
              size="sm"
              onClick={onOpenDesktop}
              className="h-7 px-2.5 gap-1"
            >
              <Server className="h-3.5 w-3.5" />
              <span>{t('workspace.chatHeader.projects')}</span>
            </Button>
          )}
          {/* 文件按钮 */}
          {onOpenDSE && (
            <Button
              variant={isDSEOpen ? "secondary" : "ghost"}
              size="sm"
              onClick={onOpenDSE}
              className="h-7 px-2.5 gap-1"
            >
              <Cloud className="h-3.5 w-3.5" />
              <span>{t('workspace.chatHeader.files')}</span>
            </Button>
          )}

          {/* 用户菜单 */}
          <DropdownMenu open={userMenuOpen} onOpenChange={(open) => { setUserMenuOpen(open); if (open) refreshBalance(); }}>
            <DropdownMenuTrigger asChild>
              {isAuthenticated ? (
                <Button variant="ghost" size="sm" className="p-1 h-8 w-8">
                  <Avatar className="h-7 w-7">
                    <AvatarImage src={getUserAvatarUrl()} />
                    <AvatarFallback className="text-xs bg-primary/10 text-primary font-semibold">
                      {getUserInitial()}
                    </AvatarFallback>
                  </Avatar>
                </Button>
              ) : (
                <Button variant="ghost" size="sm" className="h-7 px-2.5 gap-1 text-xs">
                  <User className="h-3.5 w-3.5 text-emerald-600" />
                  <span className="font-medium">{t('workspace.chatHeader.loginRegister')}</span>
                </Button>
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              {isAuthenticated ? (
                <>
                  {/* 用户信息 */}
                  <DropdownMenuItem disabled>
                    <div className="flex flex-col w-full">
                      <span className="text-sm font-medium">{getUserDisplayName()}</span>
                      <span className="text-xs text-muted-foreground">{getUserEmail()}</span>
                    </div>
                  </DropdownMenuItem>

                  <DropdownMenuSeparator />

                  {/* 余额显示 */}
                  <DropdownMenuItem asChild>
                    <div className="flex items-center justify-between w-full px-2 py-1">
                      <div className="flex items-center gap-2">
                        <Sparkles className="h-4 w-4 text-violet-500" />
                        <span className="text-sm"> {balance.toFixed(2)}</span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() => setShowRechargeDialog(true)}
                      >
                        {t('workspace.chatHeader.recharge')}
                      </Button>
                    </div>
                  </DropdownMenuItem>

                  <DropdownMenuSeparator />

                  {/* 语言设置 */}
                  <DropdownMenuItem disabled>
                    <span className="text-xs text-muted-foreground">{t('workspace.chatHeader.languagePreference')}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <div className="flex items-center gap-1 px-1 py-0">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleSetLanguage('zh')}
                        className={`${currentLng === 'zh' ? 'bg-black text-white border-black' : ''} h-6 px-2 py-0 text-xs`}
                      >
                        中文
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleSetLanguage('en')}
                        className={`${currentLng === 'en' ? 'bg-black text-white border-black' : ''} h-6 px-2 py-0 text-xs`}
                      >
                        English
                      </Button>
                    </div>
                  </DropdownMenuItem>

                  <DropdownMenuSeparator />

                  {/* 模型设置 */}
                  <DropdownMenuItem onClick={() => setShowModelSettings(true)} className="py-2 font-normal">
                    <Settings className="mr-2 h-4 w-4" />
                    {t('workspace.chatHeader.customModels')}
                  </DropdownMenuItem>

                  {/* 🔥 凭据管理 */}
                  <DropdownMenuItem onClick={() => setShowCredentialManager(true)} className="py-2 font-normal">
                    <Key className="mr-2 h-4 w-4" />
                    {t('workspace.chatHeader.credentialManager')}
                  </DropdownMenuItem>

                  {/* 检查更新 (仅Electron) */}
                  {isElectron && (
                    <DropdownMenuItem onClick={handleCheckUpdate} className="py-2 font-normal">
                      <div className="flex items-center justify-between w-full">
                        <div className="flex items-center">
                          <RefreshCw className={`mr-2 h-4 w-4 ${updateStatus === 'checking' ? 'animate-spin' : ''}`} />
                          <span>{updateStatus === 'checking' ? t('workspace.chatHeader.checking') : t('workspace.chatHeader.checkUpdate')}</span>
                        </div>
                        <span className="text-xs text-muted-foreground ml-2">v{appVersion || '1.2.5'}</span>
                      </div>
                    </DropdownMenuItem>
                  )}

                  <DropdownMenuSeparator />

                  {/* 退出登录 */}
                  <DropdownMenuItem onClick={handleLogout} className="py-2 font-normal text-red-600 focus:text-red-600">
                    <LogOut className="mr-2 h-4 w-4" />
                    {t('workspace.chatHeader.logout')}
                  </DropdownMenuItem>
                </>
              ) : (
                <DropdownMenuItem onClick={handleLogin} className="py-2 font-normal">
                  <User className="mr-2 h-4 w-4" />
                  {t('workspace.chatHeader.loginRegister')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Electron 窗口控制按钮 - 仅 Windows 显示（macOS 使用原生红绿灯） */}
          {isElectron && !isMac && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleMinimize}
                className="h-8 w-8 p-0"
              >
                <Minus className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClose}
                className="h-8 w-8 p-0 hover:bg-red-500 hover:text-white"
              >
                <X className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      </div>

      {/* 模型设置弹窗 */}
      <ModelSettings
        open={showModelSettings}
        onOpenChange={setShowModelSettings}
        userId={user?.id || ''}
      />

      {/* 🔥 凭据管理弹窗 */}
      <CredentialManager
        open={showCredentialManager}
        onOpenChange={setShowCredentialManager}
      />

      {/* 充值弹窗 */}
      <RechargeDialog
        open={showRechargeDialog}
        onOpenChange={setShowRechargeDialog}
        onRechargeSuccess={refreshBalance}
      />

      {/* 充值历史 */}
      <RechargeHistory
        open={showHistoryDialog}
        onOpenChange={setShowHistoryDialog}
      />
    </>
  );
};

export default ChatHeader;
