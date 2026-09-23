/**
 * 凭据管理 UI 组件
 *
 * 🔥 两类配置统一管理（通过 kind 区分）：
 * - env（凭据）：value 加密存储，注入为环境变量，LLM 不可见值
 * - param（参数）：value 明文存储，代码读取，LLM 可见值
 *
 * 🔥 字段设计（4 字段）：
 * - 类型：env / param
 * - 名称：env 型=环境变量名，param 型=参数名（同时作为唯一标识）
 * - 描述：用途说明
 * - 值：env 型加密+密码框，param 型明文+普通输入框
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { Plus, Trash2, Edit2, Key, Eye, EyeOff, Loader2, ShieldCheck, Save, X, Settings, Copy, Check } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { syncModelKeyCredentials } from './modelKeySync';

type CredentialKind = 'env' | 'param';

interface CredentialItem {
  id: string;
  name: string;
  type: string; // 🔥 'env' | 'param'（复用 type 列存 kind）
  description: string;
  env_var: string;
  value: string;
  created_at: number;
  updated_at: number;
}

// 🔥 系统默认参数：首次打开时自动创建，让用户知道这些参数存在且可调
const DEFAULT_PARAMS: Array<{ name: string; value: string; description: string }> = [
  { name: 'maxMessages', value: '15', description: '对话滑动窗口大小（调高总token会增，历史背景更清晰）' },
  { name: 'clearWindow', value: '6', description: 'subagent完整记忆窗口（调高总token数和缓存命中都会提高，合适值可以完成超长任务）' },
  { name: 'maxHistoryChars', value: '60000', description: '执行历史体积预算（字符，超出时自动压缩记忆窗口并提示模型缩小读取范围）' },
  { name: 'updateSourceUrl', value: '', description: '自定义更新源 URL（留空=官方源；填入 GitHub releases URL 可自主迭代，如 https://github.com/USER/REPO/releases/latest/download/）' },
];

// 🔥 数值参数的范围约束（正整数）：输入时强制取整，保存时校验范围
const PARAM_RANGES: Record<string, { min: number; max: number }> = {
  maxMessages: { min: 5, max: 30 },
  clearWindow: { min: 3, max: 15 },
  maxHistoryChars: { min: 20000, max: 200000 },
};

interface FormData {
  kind: CredentialKind;
  env_var: string;
  description: string;
  value: string;
}

const EMPTY_FORM: FormData = {
  kind: 'env',
  env_var: '',
  description: '',
  value: '',
};

interface CredentialManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const CredentialManager: React.FC<CredentialManagerProps> = ({
  open,
  onOpenChange,
}) => {
  const [credentials, setCredentials] = useState<CredentialItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);
  const [showValues, setShowValues] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const { user } = useAuth();
  const userId = user?.id;

  // 🔥 自动同步：凭据池始终镜像「我的模型」+「搜索源」的 API Key（增/改/删跟随，无开关）
  const runSync = useCallback(async () => {
    if (!userId) return;
    try {
      await syncModelKeyCredentials(userId);
    } catch (e: any) {
      console.warn('[CREDENTIAL] 模型密钥同步失败:', e?.message);
    }
  }, [userId]);

  const loadCredentials = useCallback(async () => {
    if (!userId) {
      toast.error('请先登录后再管理凭据');
      return;
    }
    setLoading(true);
    try {
      const electron = (window as any).electron;
      const result = await electron.localStorage.listCredentials(userId);
      const list = result || [];

      // 🔥 确保系统默认参数存在：缺少的自动创建，让用户可见可调
      const existingParamNames = new Set(
        list.filter((c: CredentialItem) => c.type === 'param').map((c: CredentialItem) => c.env_var)
      );
      const missingParams = DEFAULT_PARAMS.filter(p => !existingParamNames.has(p.name));

      // 🔥 修复值为空的系统默认参数（默认值非空但当前值为空，说明数据被损坏，如旧加密迁移失败）
      const emptyParams = DEFAULT_PARAMS.filter(p => {
        if (!p.value) return false; // updateSourceUrl 默认空，不修复
        const existing = list.find((c: CredentialItem) => c.type === 'param' && c.env_var === p.name);
        return existing && !existing.value;
      });

      if (missingParams.length > 0 || emptyParams.length > 0) {
        for (const p of missingParams) {
          await electron.localStorage.createCredential({
            userId,
            name: p.name,
            type: 'param',
            description: p.description,
            envVar: p.name,
            value: p.value,
          });
        }
        // 🔥 修复空值参数：更新回默认值
        for (const p of emptyParams) {
          const existing = list.find((c: CredentialItem) => c.type === 'param' && c.env_var === p.name);
          if (existing) {
            await electron.localStorage.updateCredential(existing.id, { value: p.value, type: 'param' });
          }
        }
        // 重新加载包含新建/修复参数的列表
        const refreshed = await electron.localStorage.listCredentials(userId);
        setCredentials(refreshed || []);
      } else {
        setCredentials(list);
      }
    } catch (error: any) {
      toast.error(`加载失败: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (open) {
      setShowForm(false); // 🔥 每次打开重置到列表视图（避免上次停留在表单）
      setDeleteConfirmId(null);
      if (userId) {
        // 🔥 先镜像同步（无变化不打扰），再加载列表
        runSync().finally(() => loadCredentials());
      }
    }
  }, [open, userId, loadCredentials, runSync]);

  const handleAdd = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  };

  const handleEdit = (cred: CredentialItem) => {
    setEditingId(cred.id);
    setForm({
      kind: (cred.type === 'param' ? 'param' : 'env'),
      env_var: cred.env_var,
      description: cred.description,
      value: cred.value,
    });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!userId) {
      toast.error('请先登录后再保存配置');
      return;
    }
    if (!form.env_var.trim()) {
      toast.error('名称不能为空');
      return;
    }
    // 🔥 param 型允许空值（如 updateSourceUrl 留空=官方源），env 型必须有值
    if (form.kind !== 'param' && !form.value.trim()) {
      toast.error('env 型凭据的值不能为空');
      return;
    }

    // 🔥 数值参数范围校验：必须是正整数且在约束范围内
    const paramRange = PARAM_RANGES[form.env_var.trim()];
    if (paramRange) {
      const num = parseInt(form.value, 10);
      if (isNaN(num) || num < paramRange.min || num > paramRange.max) {
        toast.error(`${form.env_var} 需为 ${paramRange.min}-${paramRange.max} 之间的正整数`);
        return;
      }
    }

    setSaving(true);
    try {
      const electron = (window as any).electron;
      if (editingId) {
        const updates: any = {};
        const existing = credentials.find(c => c.id === editingId);
        if (existing) {
          const newKind = form.kind;
          if (newKind !== existing.type) updates.type = newKind;
          if (form.env_var !== existing.env_var) {
            updates.envVar = form.env_var.trim();
            updates.name = form.env_var.trim();
          }
          if (form.description !== existing.description) updates.description = form.description;
          if (form.value !== existing.value) {
            updates.value = form.value;
            updates.type = newKind; // 🔥 value 更新时需要 type 决定是否加密
          }
        }
        if (Object.keys(updates).length === 0) {
          toast.info('没有修改');
          setShowForm(false);
          return;
        }
        const result = await electron.localStorage.updateCredential(editingId, updates);
        if (result.success) {
          toast.success('已更新');
          setShowForm(false);
          await loadCredentials();
          // 🔥 如果修改的是 updateSourceUrl，同步到 autoUpdater
          if (form.env_var.trim() === 'updateSourceUrl' && electron.updater) {
            await electron.updater.setSourceUrl(form.value.trim());
          }
        } else {
          toast.error(result.error || '更新失败，请重试');
        }
      } else {
        const result = await electron.localStorage.createCredential({
          userId,
          name: form.env_var.trim(),
          type: form.kind,
          description: form.description.trim(),
          envVar: form.env_var.trim(),
          value: form.value,
        });
        if (result.success) {
          toast.success('已添加');
          setShowForm(false);
          await loadCredentials();
          // 🔥 如果新增的是 updateSourceUrl，同步到 autoUpdater
          if (form.env_var.trim() === 'updateSourceUrl' && electron.updater) {
            await electron.updater.setSourceUrl(form.value.trim());
          }
        } else {
          toast.error(result.error || '创建失败，请重试');
        }
      }
    } catch (error: any) {
      toast.error(`保存失败: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const electron = (window as any).electron;
      const success = await electron.localStorage.deleteCredential(id);
      if (success) {
        toast.success('已删除');
        setDeleteConfirmId(null);
        await loadCredentials();
      } else {
        toast.error('删除失败，请重试');
      }
    } catch (error: any) {
      toast.error(`删除失败: ${error.message}`);
    }
  };

  const toggleShowValue = (id: string) => {
    setShowValues(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const envCredentials = credentials.filter(c => c.type !== 'param');
  const paramCredentials = credentials.filter(c => c.type === 'param');

  const renderCredentialItem = (cred: CredentialItem, isParam: boolean) => (
    <div
      key={cred.id}
      className="flex items-center gap-2 p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
      title={cred.description || undefined}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {isParam ? (
            <Settings className="h-3.5 w-3.5 text-blue-500 flex-shrink-0" />
          ) : (
            <ShieldCheck className="h-3.5 w-3.5 text-green-600 flex-shrink-0" />
          )}
          <span className="text-sm font-medium font-mono truncate">
            {/* 🔥 优先显示凭据名（如 ssh_ins-xxx，区分多台机子）；param 型无独立名，显示 env_var */}
            {isParam ? cred.env_var : (cred.name || cred.env_var)}
          </span>
        </div>
        {isParam ? (
          // 🔥 param 型直接显示值（明文，对 LLM 透明）
          <p className="text-xs font-mono text-muted-foreground mt-0.5 pl-5 truncate">
            值: {cred.value}
          </p>
        ) : (
          <>
            {/* 🔥 env 型副行显示注入变量名，LLM 引用凭据名时以 name 为准 */}
            {cred.name && cred.name !== cred.env_var && (
              <p className="text-xs text-muted-foreground mt-0.5 pl-5 truncate">注入变量: {cred.env_var}</p>
            )}
            <button
              onClick={() => toggleShowValue(cred.id)}
              className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5 mt-1 pl-5"
            >
              {showValues[cred.id] ? (
                <>
                  <EyeOff className="h-3 w-3" />
                  <span className="font-mono">{cred.value.slice(0, 20)}{cred.value.length > 20 ? '...' : ''}</span>
                </>
              ) : (
                <>
                  <Eye className="h-3 w-3" />
                  <span>显示值</span>
                </>
              )}
            </button>
            {/* 🔥 值可见时的复制按钮（成功后显示对勾反馈） */}
            {showValues[cred.id] && (
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(cred.value);
                    setCopiedId(cred.id);
                    setTimeout(() => setCopiedId(null), 1500);
                  } catch { /* 剪贴板不可用时静默 */ }
                }}
                className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center ml-1 mt-1 p-0.5"
                title="复制值"
              >
                {copiedId === cred.id ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
              </button>
            )}
          </>
        )}
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        {deleteConfirmId === cred.id ? (
          <>
            <Button
              size="sm"
              variant="destructive"
              className="h-7 px-2 text-xs"
              onClick={() => handleDelete(cred.id)}
            >
              确认删除
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              onClick={() => setDeleteConfirmId(null)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              onClick={() => handleEdit(cred)}
            >
              <Edit2 className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0 hover:text-red-600"
              onClick={() => setDeleteConfirmId(cred.id)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
      </div>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            凭据与参数
          </DialogTitle>
        </DialogHeader>

        {!showForm ? (
          /* 列表视图 */
          <div className="flex-1 overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs text-muted-foreground">
                凭据:仅保存本地，对llm不可见
              </p>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={handleAdd} className="h-7 px-2 text-xs">
                  <Plus className="h-3.5 w-3.5" />
                  添加
                </Button>
              </div>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : credentials.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Key className="h-8 w-8 text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">暂无配置</p>
                <p className="text-xs text-muted-foreground mt-1">
                  添加凭据（SSH 密码、API Key）或参数（窗口大小等）
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {envCredentials.length > 0 && (
                  <div>
                    <div className="space-y-2">
                      {envCredentials.map(c => renderCredentialItem(c, false))}
                    </div>
                  </div>
                )}
                {paramCredentials.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-blue-700 dark:text-blue-400 mb-1.5 flex items-center gap-1">
                      参数:明文，LLM 可见值
                    </p>
                    <div className="space-y-2">
                      {paramCredentials.map(c => renderCredentialItem(c, true))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          /* 表单视图 */
          <div className="flex-1 overflow-y-auto space-y-4 py-2">
            {/* 🔥 kind 切换 */}
            <div className="space-y-2">
              <Label>类型</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={form.kind === 'env' ? 'default' : 'outline'}
                  className="h-8 text-xs"
                  onClick={() => setForm({ ...form, kind: 'env' })}
                >
                  <ShieldCheck className="h-3.5 w-3.5 mr-1" />
                  凭据（加密）
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={form.kind === 'param' ? 'default' : 'outline'}
                  className="h-8 text-xs"
                  onClick={() => setForm({ ...form, kind: 'param' })}
                >
                  <Settings className="h-3.5 w-3.5 mr-1" />
                  参数（明文）
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {form.kind === 'env'
                  ? '凭据型：值加密存储，只保存本地，LLM 不可见值'
                  : '参数型：值明文存储，代码读取，LLM 可自我调节'}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="cred-name">
                {form.kind === 'env' ? '环境变量名' : '参数名'}
              </Label>
              <Input
                id="cred-name"
                value={form.env_var}
                onChange={(e) => setForm({ ...form, env_var: e.target.value })}
                placeholder={form.kind === 'env' ? '如 OPENAI_API_KEY、SSHPASS' : '如 maxMessages、clearWindow'}
                className="h-8 text-sm font-mono"
              />
              <p className="text-xs text-muted-foreground">
                {form.kind === 'env'
                  ? 'LLM 通过此名称引用凭据，执行时自动注入为同名环境变量'
                  : '代码通过此名称读取参数值'}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="cred-value">值</Label>
              {form.kind === 'param' && PARAM_RANGES[form.env_var.trim()] ? (
                (() => {
                  const r = PARAM_RANGES[form.env_var.trim()];
                  return (
                    <>
                      <Input
                        id="cred-value"
                        type="number"
                        min={r.min}
                        max={r.max}
                        step={1}
                        value={form.value}
                        onChange={(e) => {
                          // 🔥 强制正整数：过滤非数字，小数取整
                          const raw = e.target.value;
                          if (raw === '') { setForm({ ...form, value: '' }); return; }
                          const num = parseInt(raw, 10);
                          if (isNaN(num) || num < 0) return; // 忽略非法/负数
                          setForm({ ...form, value: String(num) });
                        }}
                        placeholder={`正整数 ${r.min}-${r.max}`}
                        className="h-8 text-sm font-mono"
                      />
                      <p className="text-xs text-muted-foreground">
                        范围 {r.min}-{r.max}（正整数）
                      </p>
                    </>
                  );
                })()
              ) : (
                <Input
                  id="cred-value"
                  type={form.kind === 'env' ? 'password' : 'text'}
                  value={form.value}
                  onChange={(e) => setForm({ ...form, value: e.target.value })}
                  placeholder={form.kind === 'env' ? '凭据明文值（加密存储）' : '参数值（如 15）'}
                  className="h-8 text-sm font-mono"
                />
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="cred-desc">描述（可选）</Label>
              <Textarea
                id="cred-desc"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder={form.kind === 'env' ? '如 OpenAI 的 API 密钥' : '如 对话滑动窗口大小'}
                className="text-sm min-h-[40px]"
                rows={2}
              />
            </div>
          </div>
        )}

        {showForm && (
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowForm(false)}
              className="text-sm"
              disabled={saving}
            >
              取消
            </Button>
            <Button onClick={handleSave} className="text-sm" disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                  保存中...
                </>
              ) : (
                <>
                  <Save className="h-3.5 w-3.5 mr-1" />
                  保存
                </>
              )}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
};
