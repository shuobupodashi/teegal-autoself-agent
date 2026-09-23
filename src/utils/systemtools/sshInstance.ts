/**
 * 常驻实例（SSH）核心业务层 —— UI 与 LLM 工具共用的唯一实现
 *
 * 三步编排：sshOpenInstance 开机 → userpc_shell 直接 ssh 操作 → sshCloseInstance 关机结算。
 *
 * 架构原则：DesktopModule（React 触点）与 ssh_instance 工具（LLM）都只调这里导出的
 * 三个函数，不自己实现开机/轮询/凭据/回写逻辑——保证鼠标点击与 LLM 行为完全一致。
 *
 * - sshOpenInstance：复用检查（本项目专属优先）→ 读/生成本地公钥 → 开机注入 →
 *   轮询就绪 → 密码凭据自动入库（env_var=SSHPASS）→ 本地表回写 → 免密探测
 * - sshCloseInstance：云端关机结算 → 本地表收尾 → 凭据同步删除
 * - sshListActive：本地资源表活跃实例（带项目归属 app_id，云端自愈校正）
 *
 * 公钥免密是主路径（Windows 无 sshpass），密码凭据是 macOS/Linux 兜底。
 */

import { AutoStep, AutoToolResult } from '@/utils/auto/types';
import { CloudAuthService } from '@/services/cloud/CloudAuthService';
import { resolveProjectId, isSameProjectId } from '@/utils/apptool/ProjectIdResolver';
import { getBackendUrl } from '@/config/env';
import { executeExecuteCommandTool, ExecuteCommandProgress } from './executeCommand';

/** 开机就绪轮询参数 */
const POLL_INTERVAL_MS = 5000;
const POLL_MAX_MS = 200_000;

/** 统一云端租赁 API 调用（用户 JWT 双轨认证，401 自愈由 CloudAuthService 处理） */
async function rentalApi(
  endpoint: string,
  options: RequestInit = {}
): Promise<{ ok: boolean; status: number; data: any }> {
  const response = await CloudAuthService.cloudRequest(`/rental/v1${endpoint}`, options);
  const data = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, data };
}

/** local-backend 转发 API（本地资源表登记/收尾） */
async function localApi(
  path: string,
  options: RequestInit = {}
): Promise<{ ok: boolean; status: number; data: any }> {
  const response = await fetch(`${getBackendUrl()}${path}`, options);
  const data = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, data };
}

function fail(error: string, outputs: string[] = []): AutoToolResult {
  return {
    success: false,
    error,
    data: { type: 'terminal', command: 'ssh_instance', outputs, exitCode: -1, executionTime: 0, error },
    metadata: { toolName: 'ssh_instance' },
  };
}

function ok(outputs: string[]): AutoToolResult {
  return {
    success: true,
    data: { type: 'terminal', command: 'ssh_instance', outputs, exitCode: 0, executionTime: 0 },
    metadata: { toolName: 'ssh_instance' },
  };
}

/** 是否 Windows 母体 */
function isWindows(): boolean {
  return typeof navigator !== 'undefined' && /Win/i.test(navigator.userAgent || '');
}

/**
 * 读取（必要时生成）本地 SSH 公钥。
 * 通过 userpc_shell 执行链跑本地 shell——复用平台 shell 选择，不自己猜解释器。
 * 🔥 不再嵌套 powershell -NoProfile -Command：执行链本身是 PowerShell，
 *    双层引号转义（\"）会被破坏导致读到空输出——曾误判"本地无公钥"，
 *    连带云端开机注入收到空 publicKey（authorized_keys 0 字节的根因）。
 * 返回 { 公钥行, 文件路径 }；null 表示本地无公钥且生成失败。
 */
async function resolveLocalPublicKey(userId?: string): Promise<{ pub: string; pubPath: string } | null> {
  const run = (cmd: string) => runLocalShell(cmd.replace(/\s+/g, ' '), userId);

  const readCmd = isWindows()
    ? `$p=@("$env:USERPROFILE\\.ssh\\id_ed25519.pub","$env:USERPROFILE\\.ssh\\id_rsa.pub")|Where-Object{Test-Path $_}|Select-Object -First 1; if($p){Write-Output ("PATH:"+$p); Get-Content $p}`
    : `for f in ~/.ssh/id_ed25519.pub ~/.ssh/id_rsa.pub; do [ -f "$f" ] && echo "PATH:$f" && cat "$f" && break; done`;

  const stdout = await run(readCmd);
  const pathMatch = stdout.match(/PATH:(.+)/);
  let pubKey = extractPublicKey(stdout);
  if (pubKey && pathMatch) return { pub: pubKey, pubPath: pathMatch[1].trim() };

  // 本地无密钥：尝试 ssh-keygen 生成一把（Win10+/macOS/Linux 均自带 OpenSSH）
  const genCmd = isWindows()
    ? `if(!(Test-Path "$env:USERPROFILE\\.ssh")){New-Item -ItemType Directory -Path "$env:USERPROFILE\\.ssh" | Out-Null}; if(!(Test-Path "$env:USERPROFILE\\.ssh\\id_ed25519.pub")){ssh-keygen -t ed25519 -N "" -f "$env:USERPROFILE\\.ssh\\id_ed25519" -q}; $p="$env:USERPROFILE\\.ssh\\id_ed25519.pub"; Write-Output ("PATH:"+$p); Get-Content $p`
    : `mkdir -p ~/.ssh && { [ -f ~/.ssh/id_ed25519.pub ] || ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519 -q; } && echo "PATH:$HOME/.ssh/id_ed25519.pub" && cat ~/.ssh/id_ed25519.pub`;

  const genOut = await run(genCmd);
  const genPath = genOut.match(/PATH:(.+)/);
  pubKey = extractPublicKey(genOut);
  if (pubKey && genPath) return { pub: pubKey, pubPath: genPath[1].trim() };
  return null;
}

/** 执行链 detailed 版：失败原因不静默（超时/执行错误透出给诊断） */
async function runLocalShellDetailed(
  command: string,
  userId?: string,
  credentialName?: string
): Promise<{ ok: boolean; out: string; err?: string }> {
  try {
    const result = await executeExecuteCommandTool(
      { toolParams: { command, timeout: 30, ...(credentialName ? { credentialName } : {}) } } as unknown as AutoStep,
      'ssh-instance',
      undefined,
      { userId }
    );
    if (result.success) {
      return { ok: true, out: (result.data?.outputs || []).join('\n') };
    }
    return { ok: false, out: (result.data?.outputs || []).join('\n'), err: result.error || '执行失败（无错误信息）' };
  } catch (error: any) {
    return { ok: false, out: '', err: error?.message || String(error) };
  }
}

async function runLocalShell(command: string, userId?: string, credentialName?: string): Promise<string> {
  const r = await runLocalShellDetailed(command, userId, credentialName);
  return r.out;
}

/** 从命令输出提取公钥行（ssh-ed25519 / ssh-rsa / ecdsa 开头） */
function extractPublicKey(stdout: string): string | null {
  const line = (stdout || '')
    .split('\n')
    .map(l => l.trim())
    .find(l => /^(ssh-(ed25519|rsa)|ecdsa-sha2-\S+) \S+/.test(l));
  return line || null;
}

/**
 * 🔥 Windows 下显式指定私钥路径（PowerShell 语法展开 $env:USERPROFILE）
 * -NoProfile/服务化环境下 ssh 可能找不到 %USERPROFILE%\.ssh 默认私钥 → publickey 认证直接失败；
 * 显式 -i 后不再依赖 ssh 客户端内部的 HOME/USERPROFILE 解析逻辑。macOS/Linux 用默认路径即可。
 */
function sshIdentityArg(): string {
  return navigator.userAgent.includes('Windows')
    ? `-i "$env:USERPROFILE\\.ssh\\id_ed25519"`
    : '';
}

/** 🔥 关机后删除对应凭据（凭据名约定 ssh_<instanceId>，与 saveCredential 对称） */
async function deleteCredentialByInstance(
  instanceId: string,
  userId?: string
): Promise<void> {
  try {
    const electron = (window as any).electron;
    if (!electron?.localStorage?.getCredentialByName || !electron?.localStorage?.deleteCredential || !userId) return;
    const name = instanceId.startsWith('ssh_') ? instanceId : `ssh_${instanceId}`;
    const existing = await electron.localStorage.getCredentialByName(name, userId);
    if (existing?.id) {
      await electron.localStorage.deleteCredential(existing.id);
    }
  } catch {
    // 凭据清理失败不影响关机
  }
}

/** 凭据自动入库（存在则更新，避免重名创建失败） */
async function saveCredential(
  instanceId: string,
  password: string,
  userId?: string
): Promise<string | null> {
  try {
    const electron = (window as any).electron;
    if (!electron?.localStorage?.getCredentialByName || !userId) {
      console.warn('[SSH-INSTANCE] 凭据入库跳过:', {
        hasApi: !!electron?.localStorage?.getCredentialByName,
        hasUserId: !!userId,
      });
      return null;
    }
    const name = `ssh_${instanceId}`;
    const existing = await electron.localStorage.getCredentialByName(name, userId);
    if (existing?.id) {
      const r = await electron.localStorage.updateCredential(existing.id, { value: password });
      if (r && r.success === false) {
        console.warn('[SSH-INSTANCE] 凭据更新失败:', r.error);
        return null;
      }
    } else {
      const r = await electron.localStorage.createCredential({
        userId,
        name,
        type: 'env',
        description: `云端实例 ${instanceId} SSH 密码（sshpass -e 兜底用，优先公钥免密）`,
        envVar: 'SSHPASS',
        value: password,
      });
      if (!r?.success) {
        console.warn('[SSH-INSTANCE] 凭据创建失败:', r?.error || JSON.stringify(r));
        return null;
      }
    }
    return name;
  } catch (error) {
    console.warn('[SSH-INSTANCE] 凭据入库失败（不影响公钥免密）:', error);
    return null;
  }
}

/** 轮询等待实例就绪（running + 公网 IP），最长 200s */
async function waitUntilReady(rentalId: string): Promise<{ ready: boolean; instance: any; error?: string }> {
  const start = Date.now();
  while (Date.now() - start < POLL_MAX_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const res = await rentalApi(`/instances/${rentalId}`);
    const inst = res.data?.instance;
    if (!res.ok || !inst) {
      return { ready: false, instance: null, error: res.data?.error || `查询实例状态失败 (HTTP ${res.status})` };
    }
    if (inst.status === 'running' && inst.public_ip) {
      return { ready: true, instance: inst };
    }
    if (inst.status === 'failed') {
      return { ready: false, instance: inst, error: inst.error || '实例开机失败' };
    }
    if (inst.status === 'closed') {
      return { ready: false, instance: inst, error: '实例已被关闭' };
    }
  }
  return { ready: false, instance: null, error: '等待实例就绪超时（200s），可稍后在常驻面板查看状态，实例将继续在云端运行' };
}

/**
 * 🔥 确保本地有 plink.exe（PuTTY 单文件 CLI，Windows 上唯一可靠的 SSH 密码自动化方案）
 * 下载到 %USERPROFILE%\.teegal\bin\plink.exe；已存在直接复用
 */
const PLINK_PATH = '"$env:USERPROFILE\\.teegal\\bin\\plink.exe"';

async function ensurePlink(userId?: string): Promise<boolean> {
  const check = await runLocalShell(`if (Test-Path ${PLINK_PATH}) { 'PLINK_OK' } else { 'PLINK_MISSING' }`.replace(/\s+/g, ' '), userId);
  if (check.includes('PLINK_OK')) return true;
  await runLocalShell(
    `New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\\.teegal\\bin" | Out-Null; Invoke-WebRequest -UseBasicParsing -Uri 'https://the.earth.li/~sgtatham/putty/latest/w64/plink.exe' -OutFile ${PLINK_PATH}; if (Test-Path ${PLINK_PATH}) { 'PLINK_DOWNLOADED' } else { 'PLINK_FAIL' }`.replace(/\s+/g, ' '),
    userId
  );
  const verify = await runLocalShell(`if (Test-Path ${PLINK_PATH}) { 'PLINK_OK' } else { 'PLINK_MISSING' }`.replace(/\s+/g, ' '), userId);
  return verify.includes('PLINK_OK');
}

/**
 * 🔥 plink 执行（密码通道，credentialName 注入 SSHPASS）
 * 两步走：-batch 首连失败会输出 hostkey 指纹 → 解析后带 -hostkey 重连。
 * 注意：-hostkey 验证通过【不会】写入注册表缓存 → 指纹必须回传给 LLM 模板复用。
 * 绝不用 `echo y |` 管道——spawn 环境下会挂死等 tty。
 */
async function plinkExec(
  host: string,
  user: string,
  credentialName: string,
  command: string,
  userId?: string,
  port: number = 22
): Promise<{ out: string; fingerprint?: string; err?: string }> {
  const base = `${PLINK_PATH} -ssh -P ${port} -batch -pw $env:SSHPASS ${user}@${host}`.replace(/\s+/g, ' ');
  // 🔥 2>&1 必须带：-batch 的 "host key is not cached" 错误（含指纹）走 stderr，不合并就拿不到指纹
  const r1 = await runLocalShellDetailed(`${base} "${command}" 2>&1`, userId, credentialName);
  let out = r1.out;
  const fp = out.match(/SHA256:[A-Za-z0-9+/=]+/);
  if (fp && /host key is not cached/i.test(out)) {
    const r2 = await runLocalShellDetailed(`${PLINK_PATH} -ssh -P ${port} -batch -hostkey "${fp[0]}" -pw $env:SSHPASS ${user}@${host} "${command}" 2>&1`.replace(/\s+/g, ' '), userId, credentialName);
    return { out: r2.out, fingerprint: fp[0], err: r2.err };
  }
  return { out, err: r1.err };
}

/**
 * 🔥 公钥现场注入（本地自救）：不依赖云端 cloud-init（实测不可靠，authorized_keys 常 为空）。
 * 密码通道拿到 hostkey 指纹后，用 plink 把本地公钥追加进服务器 authorized_keys。
 * 返回 ok=true 后重探公钥通道即可免密。
 */
async function injectPublicKeyViaPlink(
  host: string,
  user: string,
  credentialName: string,
  fingerprint: string | undefined,
  userId?: string,
  port: number = 22
): Promise<{ ok: boolean; out: string; err?: string }> {
  // 确保本地公钥文件存在（必要时生成）
  const local = await resolveLocalPublicKey(userId);
  if (!local) return { ok: false, out: '', err: '本地无 SSH 公钥且生成失败' };
  // 指纹缺失（hostkey 已在注册表缓存）时省略 -hostkey，同样走缓存无交互
  const hostArg = fingerprint ? ` -hostkey "${fingerprint}"` : '';
  // 🔥 cmd /c + < 重定向 stdin（实测成功的唯一形态：INJECT_OK + 免密打通）。
  //    PowerShell 管道（Get-Content | plink）会让 plink 参数解析失败（Host does not exist），
  //    公钥文本嵌命令行又会被引号转义破坏——公钥必须走文件重定向。
  const cmd = `cmd /c '%USERPROFILE%\\.teegal\\bin\\plink.exe -ssh -P ${port} -batch${hostArg} -pw %SSHPASS% ${user}@${host} "cat >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys && echo INJECT_OK" < ${local.pubPath}'`;
  const r = await runLocalShellDetailed(cmd.replace(/\s+/g, ' '), userId, credentialName);
  return { ok: r.ok && r.out.includes('INJECT_OK'), out: r.out, err: r.err };
}

/**
 * 🔥 SSH 免密探测：云端 running ≠ 公钥已注入。用 BatchMode=yes 探测
 * （公钥失败立即退出，绝不挂起等密码），直到 echo ok 才算真正可用。
 * 公钥探测失败后自动降级 plink 密码探测（Windows 密码通道），并做 ssh -v 诊断。
 */
async function probeSshReady(
  host: string,
  user: string,
  credentialName: string | null,
  userId?: string,
  maxAttempts: number = 8,
  port: number = 22
): Promise<{ ready: boolean; authMode: 'key' | 'password' | 'none'; fingerprint?: string; diag?: string }> {
  const idArg = sshIdentityArg();
  const portArg = port !== 22 ? ` -p ${port}` : '';
  const cmd = `ssh ${idArg}${portArg} -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${user}@${host} 'echo ok'`.replace(/\s+/g, ' ');
  // 公钥探测：最多 ~90s（首次启动初始化通常 30-60s）；自有机器传 maxAttempts=1（机器是活的）
  for (let i = 0; i < maxAttempts; i++) {
    const out = await runLocalShell(cmd, userId);
    if (out.includes('ok')) return { ready: true, authMode: 'key' };
    await new Promise(r => setTimeout(r, 10000));
  }
  // 🔥 公钥失败：ssh -v 诊断（本地私钥是否被 ssh 看到）
  const dbg = await runLocalShell(`ssh ${idArg}${portArg} -v -o BatchMode=yes -o ConnectTimeout=10 ${user}@${host} exit 2>&1`.replace(/\s+/g, ' '), userId);
  const timedOut = /Connection timed out|connect to host/i.test(dbg) && new RegExp(`port ${port}`).test(dbg);
  const keyLines = dbg.split('\n').filter(l =>
    /identity file|Trying private key|no such identity|Permission denied|Authentications that can continue|Connection timed out|port 22/i.test(l)
  ).slice(0, 6);
  const hint = timedOut
    ? `⚠️ TCP 22 端口不可达（Connection timed out）：通常是该实例所在区域的安全组未放行 22 端口，请到腾讯云控制台检查对应区域安全组入站规则。这与公钥注入无关。`
    : '';

  // 🔥 降级：plink 密码探测（-batch + hostkey 指纹两步走，无交互不挂死）
  let plinkDiag = '';
  if (credentialName && navigator.userAgent.includes('Windows')) {
    const plinkOk = await ensurePlink(userId);
    if (plinkOk) {
      const pr = await plinkExec(host, user, credentialName, 'echo ok', userId, port);
      const passwordReady = pr.out.includes('ok');
      plinkDiag = passwordReady
        ? '[plink 密码通道可用]'
        : `[plink 密码通道失败] ${pr.err ? `执行错误: ${pr.err}` : `输出摘要: ${pr.out.replace(/\s+/g, ' ').slice(0, 200) || '（空输出）'}`}`;

      // 🔥 公钥自愈：只要密码通道可达（或拿到指纹），就现场注入本地公钥 → 收敛到免密 key 模式
      //    （服务端 authorized_keys 为空是常态——cloud-init 注入不可靠，靠本地自救）
      if (passwordReady || pr.fingerprint) {
        const inj = await injectPublicKeyViaPlink(host, user, credentialName, pr.fingerprint, userId, port);
        if (inj.ok) {
          for (let i = 0; i < 2; i++) {
            const out2 = await runLocalShell(cmd, userId);
            if (out2.includes('ok')) {
              return {
                ready: true,
                authMode: 'key',
                fingerprint: pr.fingerprint,
                diag: [hint, '[公钥已通过 plink 密码通道现场注入并生效（不依赖云端 cloud-init）]', keyLines.join('\n')].filter(Boolean).join('\n'),
              };
            }
            await new Promise(r => setTimeout(r, 5000));
          }
          plinkDiag += '；公钥注入返回成功但公钥探测仍未通过';
        } else if (passwordReady) {
          plinkDiag += `；公钥自动注入失败（不影响密码通道）: ${inj.err || inj.out.replace(/\s+/g, ' ').slice(0, 120) || '（空输出）'}`;
        } else {
          plinkDiag += `；公钥注入失败: ${inj.err || inj.out.replace(/\s+/g, ' ').slice(0, 120) || '（空输出）'}`;
        }
      }

      if (passwordReady) {
        return {
          ready: true,
          authMode: 'password',
          fingerprint: pr.fingerprint,
          // 🔥 注入结果必须可见：成功与否/失败原因都在 plinkDiag 里（authMode 未收敛到 key 时 LLM 据此决策）
          diag: [hint, plinkDiag, '[公钥未生效（服务端 authorized_keys 为空），已降级 plink 密码通道]', keyLines.join('\n')].filter(Boolean).join('\n'),
        };
      }
    } else {
      plinkDiag = '[plink 密码通道跳过] plink.exe 不可用且下载失败';
    }
  } else if (!credentialName) {
    plinkDiag = '[plink 密码通道跳过] 无密码凭据（自动入库失败，见 DevTools console 的 [SSH-INSTANCE] 日志）';
  }

  return {
    ready: false,
    authMode: 'none',
    diag: [hint, plinkDiag, keyLines.join('\n') || dbg.slice(-300)].filter(Boolean).join('\n'),
  };
}

// ============================================================
// 核心业务层（UI 与 LLM 工具共用）
// ============================================================

export interface SshOpenOptions {
  instanceType: string;
  /** 登记项目归属（本地表 app_id），LLM 传项目 ID / UI 传当前 appId */
  projectId?: string;
  userId?: string;
  /** 进度回调（UI 展示用；LLM 路径不传） */
  onProgress?: (msg: string) => void;
  /** 指定复用某台活跃实例（LLM activate 复用路径） */
  resumeInstanceId?: string;
}

export interface SshOpenResult {
  ok: boolean;
  /** 就绪实例（id/instance_id/public_ip/instance_type/price_per_hour…） */
  instance?: any;
  credentialName?: string | null;
  /** 免密探测结果（false = 公钥/密码探测都未通过，稍后重试；undefined = 复用已跳过探测） */
  sshReady?: boolean;
  /** 探测通过的认证方式：key=公钥免密（首选）；password=plink 密码通道（公钥未生效时的降级） */
  authMode?: 'key' | 'password' | 'none';
  /** plink hostkey 指纹（authMode=password 时 LLM 命令模板必须带 -hostkey，因为不会写入注册表缓存） */
  plinkFingerprint?: string;
  /** 是否复用了已有实例（未新开机） */
  reused?: boolean;
  /** 免密探测失败时的 ssh -v 诊断摘要（本地私钥是否可见等） */
  probeDiag?: string;
  error?: string;
}

/**
 * 开机常驻实例（或复用同规格活跃实例）。
 * 复用检查：本项目专属的机子优先；其他项目专属的不复用（防跨项目干扰）；未绑定归属的可复用。
 */
export async function sshOpenInstance(opts: SshOpenOptions): Promise<SshOpenResult> {
  const { instanceType, userId, onProgress, resumeInstanceId } = opts;
  // 🔥 长短 id 置换：短 id/slug 统一解析为完整 id 再登记（UI 按完整 id 比对归属指示灯）
  let projectId: string | undefined;
  if (opts.projectId) {
    const resolved = { id: '' };
    const resolveErr = await resolveProjectId(opts.projectId, resolved, userId);
    if (resolveErr) {
      return { ok: false, error: `projectId 无法解析：${resolveErr}` };
    }
    projectId = resolved.id;
  }
  if (!instanceType && !resumeInstanceId) {
    return { ok: false, error: '缺少 instanceType（如 S5.MEDIUM4，可用 list_instance_types 查询规格）' };
  }

  // 1. 复用检查
  let target: any = null;
  let reused = false;
  let localResourceId: string | null = null;  // 新开机时本地资源表记录 id（就绪后回写用）
  if (resumeInstanceId) {
    // 指定实例复用：活跃才行（已关机的让 LLM 重新开）
    const d = await rentalApi(`/instances/${encodeURIComponent(resumeInstanceId)}`);
    const inst = d.data?.instance;
    if (!d.ok || !inst || inst.status === 'closed' || inst.status === 'failed') {
      return { ok: false, error: `未找到活跃实例 ${resumeInstanceId}（可能已关机，用 instanceType 重新开机）` };
    }
    target = inst;
    reused = true;
    // 🔥 复用凭据名从本地记录补齐（云端详情不回传密码，凭据早已入库无需重建）
    const lr = await localApi(`/api/rental/resources?userId=${encodeURIComponent(userId || '')}`)
      .catch(() => ({ ok: false, status: 0, data: null }));
    const localRec = (lr.data?.resources || []).find((x: any) =>
      x.cloud_rental_id === resumeInstanceId || x.cloud_instance_id === resumeInstanceId
    );
    if (localRec?.credential_name) {
      target.ssh_password = undefined; // 无新密码，保留下方 null 逻辑
      (target as any)._localCredentialName = localRec.credential_name;
    }
  } else {
    onProgress?.('检查可复用的活跃实例...');
    const localRes = await localApi(
      `/api/rental/resources?userId=${encodeURIComponent(userId || 'unknown')}&active=1&sync=1`
    ).catch(() => ({ ok: false, status: 0, data: null }));
    const localActives: any[] = localRes.data?.resources || [];
    const boundToOther = new Set(
      // 🔥 长短 id 兼容比对：存量记录可能登记短 id
      localActives.filter(r => r.app_id && !isSameProjectId(r.app_id, projectId)).map(r => r.cloud_rental_id || r.cloud_instance_id)
    );

    const listRes = await rentalApi('/instances?active=1');
    if (listRes.ok) {
      const active: any[] = listRes.data?.instances || [];
      target = active.find(i => i.instance_type === instanceType && !boundToOther.has(i.id)) || null;
      if (target) reused = true;
    }
  }

  // 2. 无可复用 → 经本地后端开机（本地登记项目归属 + 云端开机，公钥注入透传）
  if (!target) {
    onProgress?.('读取本地 SSH 公钥...');
    const localKey = await resolveLocalPublicKey(userId);

    onProgress?.('发送开机请求...');
    const openRes = await localApi('/api/rental/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instanceType,
        publicKey: localKey?.pub || undefined,
        userId,
        appId: projectId || undefined,
      }),
    });
    const openData = openRes.data;
    if (!openRes.ok || !openData?.success) {
      return { ok: false, error: openData?.error || `开机请求失败 (HTTP ${openRes.status})` };
    }
    target = { id: openData.rentalId, instance_type: instanceType, status: 'pending' };
    localResourceId = openData.resourceId || null;
  }

  // 3. 等待就绪
  if (target.status !== 'running' || !target.public_ip) {
    onProgress?.('等待实例就绪（通常 1-3 分钟）...');
    const waited = await waitUntilReady(target.id);
    if (!waited.ready) {
      // 就绪失败：本地资源表标记 error（UI 立即可见失败态）
      if (localResourceId) {
        localApi(`/api/rental/resources/${encodeURIComponent(localResourceId)}/error`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ remark: waited.error }),
        }).catch(() => {});
      }
      return { ok: false, error: waited.error || '实例未就绪' };
    }
    target = waited.instance;
  }

  // 4. 密码凭据自动入库（复用路径无新密码 → 沿用本地记录里的凭据名）
  const credentialName = target.ssh_password
    ? await saveCredential(target.instance_id, target.ssh_password, userId)
    : ((target as any)._localCredentialName || null);

  // 5. 🔥 就绪信息回写本地资源表（IP/实例ID/凭据名/running）——否则本地表永远停在 booting
  if (localResourceId) {
    localApi(`/api/rental/resources/${encodeURIComponent(localResourceId)}/running`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: target.public_ip,
        cloudInstanceId: target.instance_id,
        credentialName,
        region: target.region,
        sshUser: target.ssh_user || 'ubuntu',
      }),
    }).catch(() => {});
  }

  // 6. 🔥 免密探测（仅新开机做）：复用的机子已在跑，探测会白等 90s 拖死 UI/LLM
  let sshReady: boolean | undefined = undefined;
  let authMode: 'key' | 'password' | 'none' | undefined = undefined;
  let probeDiag: string | undefined = undefined;
  let plinkFingerprint: string | undefined = undefined;
  if (!reused) {
    onProgress?.('免密连通性探测...');
    const probe = await probeSshReady(target.public_ip, target.ssh_user || 'ubuntu', credentialName, userId);
    sshReady = probe.ready;
    authMode = probe.authMode;
    probeDiag = probe.diag;
    plinkFingerprint = probe.fingerprint;
  }

  return { ok: true, instance: target, credentialName, sshReady, authMode, plinkFingerprint, reused, probeDiag };
}

/** 活跃实例清单（本地资源表，带项目归属 app_id；查询时云端自愈校正） */
export async function sshListActive(
  userId?: string
): Promise<{ ok: boolean; instances: any[]; error?: string }> {
  const uid = userId || '';
  const res = await localApi(
    `/api/rental/resources?userId=${encodeURIComponent(uid)}&active=1&sync=1`
  ).catch(() => ({ ok: false, status: 0, data: null }));
  if (!res.ok) {
    return { ok: false, instances: [], error: res.data?.error || `查询失败 (HTTP ${res.status})` };
  }
  return { ok: true, instances: res.data?.resources || [] };
}

/** 自有机器凭据入库（密码只进凭据库，不经任何后端；存在则更新） */
async function upsertSelfCredential(
  name: string,
  host: string,
  username: string,
  password: string,
  userId?: string
): Promise<boolean> {
  try {
    const electron = (window as any).electron;
    if (!electron?.localStorage?.getCredentialByName || !userId) {
      console.warn('[SSH-INSTANCE] 自有机器凭据入库跳过: 缺少凭据 API 或 userId');
      return false;
    }
    const existing = await electron.localStorage.getCredentialByName(name, userId);
    if (existing?.id) {
      const r = await electron.localStorage.updateCredential(existing.id, { value: password });
      return !(r && r.success === false);
    }
    const r = await electron.localStorage.createCredential({
      userId,
      name,
      type: 'env',
      description: `自有机器 ${username}@${host} SSH 密码（sshpass -e / plink 兜底用，优先公钥免密）`,
      envVar: 'SSHPASS',
      value: password,
    });
    return !!r?.success;
  } catch (error) {
    console.warn('[SSH-INSTANCE] 自有机器凭据入库失败:', error);
    return false;
  }
}

/** 自有机器操作选项 */
export interface SshAddSelfOptions {
  host: string;
  port?: number;
  username: string;
  password: string;
  /** 自定义凭据名（默认自动生成 ssh_self-xxx） */
  credentialName?: string;
  /** 登记项目归属（本地表 app_id） */
  projectId?: string;
  userId?: string;
  onProgress?: (msg: string) => void;
}

/**
 * 添加自有机器（用户自己的服务器）：连通测试（顺带自动配公钥免密）→ 凭据入库 → 本地建档。
 * 不经过云端账本：不计费、不参与对账；"close"只解绑（机器本身不受影响）。
 */
export async function sshAddSelfInstance(
  opts: SshAddSelfOptions
): Promise<SshOpenResult & { resourceId?: string }> {
  const { host, username, password, userId, onProgress } = opts;
  // 🔥 长短 id 置换：与 sshOpenInstance 同规则，登记完整 id
  let projectId: string | undefined;
  if (opts.projectId) {
    const resolved = { id: '' };
    const resolveErr = await resolveProjectId(opts.projectId, resolved, userId);
    if (resolveErr) {
      return { ok: false, error: `projectId 无法解析：${resolveErr}` };
    }
    projectId = resolved.id;
  }
  const port = opts.port || 22;
  if (!host || !username || !password) {
    return { ok: false, error: '缺少 host / username / password' };
  }

  // 1. 凭据先入库（连通测试的 plink 通道依赖凭据名注入 SSHPASS；失败/重复绑定会回滚）
  const credName = (opts.credentialName || `ssh_self-${Date.now().toString(36)}`).trim();
  onProgress?.('保存凭据...');
  if (!(await upsertSelfCredential(credName, host, username, password, userId))) {
    return { ok: false, error: '凭据保存失败（见 DevTools console 的 [SSH-INSTANCE] 日志）' };
  }

  // 2. 连通性测试（自有机器是活的，1 次探测即可；公钥注入自愈同样适用）
  onProgress?.(`测试连接 ${username}@${host}:${port}...`);
  const probe = await probeSshReady(host, username, credName, userId, 1, port);
  if (!probe.ready) {
    await deleteCredentialByInstance(credName, userId);
    return {
      ok: false,
      error: `连接测试未通过：${probe.diag || '检查地址/端口/用户名/密码，以及服务器防火墙是否放行该端口'}`,
    };
  }

  // 3. 本地建档（source=workstation，不过云端账本）
  onProgress?.('登记自有机器...');
  const addRes = await localApi('/api/rental/resources/self', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId,
      appId: projectId || undefined,
      host,
      port,
      username,
      credentialName: credName,
    }),
  });
  if (!addRes.ok || !addRes.data?.success) {
    await deleteCredentialByInstance(credName, userId);
    return { ok: false, error: addRes.data?.error || `本地登记失败 (HTTP ${addRes.status})` };
  }
  if (addRes.data?.duplicated) {
    await deleteCredentialByInstance(credName, userId);
    return { ok: false, error: '该机器已在常驻列表中，未重复添加' };
  }

  return {
    ok: true,
    resourceId: addRes.data?.resourceId,
    credentialName: credName,
    sshReady: probe.ready,
    authMode: probe.authMode,
    plinkFingerprint: probe.fingerprint,
    probeDiag: probe.diag,
    instance: {
      id: addRes.data?.resourceId,
      instance_id: 'self',
      instance_type: 'self',
      public_ip: host,
      ssh_user: username,
      price_per_hour: 0,
    },
  };
}

/** 关机结算（云端扣费 + 本地表收尾 + 凭据同步删除）；自有机器只解绑 */
export async function sshCloseInstance(
  instanceId: string,
  userId?: string
): Promise<{ ok: boolean; rentalId?: string; unbound?: boolean; error?: string }> {
  // 🔥 关机前先从本地资源表取底层 instanceId / 凭据名 / 来源
  // （LLM 关机传的可能是 rentalId rent-xxx，而凭据名按底层实例 ID 命名 ssh_ins-xxx，直接删会扑空）
  let cloudInstanceId = '';
  let credentialName = '';
  let localId = '';
  let source = 'cloud';
  const lr = await localApi(`/api/rental/resources?userId=${encodeURIComponent(userId || '')}`)
    .catch(() => ({ ok: false, status: 0, data: null }));
  if (lr.ok) {
    const rec = (lr.data?.resources || []).find((r: any) =>
      r.cloud_rental_id === instanceId || r.cloud_instance_id === instanceId || r.id === instanceId
    );
    if (rec) {
      cloudInstanceId = rec.cloud_instance_id || '';
      credentialName = rec.credential_name || '';
      localId = rec.id || '';
      source = rec.source || 'cloud';
    }
  }

  // 🔥 自有机器：只解绑（机器本身不受影响、不计费，绝不能调云端 API），凭据同步清除不留僵尸
  if (source === 'workstation') {
    if (!localId) return { ok: false, error: `本地记录不存在: ${instanceId}` };
    const r = await localApi(`/api/rental/resources/${encodeURIComponent(localId)}/unbind`, {
      method: 'POST',
    });
    if (!r.ok || !r.data?.success) {
      return { ok: false, error: r.data?.error || `解绑失败 (HTTP ${r.status})` };
    }
    // 解绑后凭据（存着服务器密码）一并删除；重新绑定时会重新入库
    if (credentialName) {
      await deleteCredentialByInstance(credentialName, userId);
    }
    return { ok: true, unbound: true };
  }

  const res = await rentalApi(`/instances/${encodeURIComponent(instanceId)}/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'user' }),
  });
  if (!res.ok) {
    return { ok: false, error: res.data?.error || `关机失败 (HTTP ${res.status})` };
  }
  const rentalId = res.data?.rentalId || instanceId;
  // 本地资源表收尾 + 凭据同步删除（保证 UI 常驻灯熄灭、凭据不留僵尸）
  await localApi('/api/rental/resources/close-by-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: rentalId }),
  }).catch(() => {});
  // 🔥 凭据清理：记录里的凭据名 + 底层实例 ID + 传入 ID 三路兜底（idempotent，重复删无害）
  for (const key of [credentialName, cloudInstanceId ? `ssh_${cloudInstanceId}` : '', `ssh_${instanceId}`]) {
    if (key) await deleteCredentialByInstance(key, userId);
  }
  return { ok: true, rentalId };
}

// ============================================================
// LLM 工具入口（薄封装，核心逻辑在上面三个函数）
// ============================================================

function usageHint(inst: any, credentialName: string | null, authMode?: 'key' | 'password' | 'none', fingerprint?: string): string[] {
  const ip = inst.public_ip;
  const user = inst.ssh_user || 'ubuntu';   // Ubuntu 镜像主用户（root 禁 SSH，root 权限用 sudo -i）
  const hint = [
    `✅ 实例已就绪: ${inst.instance_id} (${inst.instance_type}) @ ${ip}`,
    `   rentalId: ${inst.id} | 登录用户: ${user} | 单价: ${inst.price_per_hour}/小时`,
    `   凭据名: ${credentialName || '（自动入库失败，原因见 DevTools console 的 [SSH-INSTANCE] 日志；公钥免密不受影响）'}`,
  ];
  if (authMode === 'password') {
    // 🔥 公钥未生效：Windows 密码通道（plink + credentialName 注入的 SSHPASS）
    // -hostkey 验证不写注册表缓存 → 指纹直接给 LLM，每条命令都带
    hint.push(`   ⚠️ 公钥免密未生效（服务端 authorized_keys 为空），走 plink 密码通道。用 userpc_shell 执行（传 credentialName=${credentialName} 注入 SSHPASS）:`);
    hint.push(`   & "$env:USERPROFILE\\.teegal\\bin\\plink.exe" -ssh -batch${fingerprint ? ` -hostkey "${fingerprint}"` : ''} -pw $env:SSHPASS ${user}@${ip} "命令"`.replace(/\s+/g, ' '));
  } else {
    const idArg = sshIdentityArg();
    hint.push(`   现在用 userpc_shell 执行: ssh ${idArg} -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${user}@${ip} '命令'`.replace(/\s+/g, ' '));
  }
  hint.push(`   （需要 root 权限时用: ${user}@${ip} 'sudo -i' 或 'sudo 命令'）`);
  if (authMode !== 'password' && credentialName) {
    hint.push(`   （密码兜底，macOS/Linux）: userpc_shell 传 credentialName=${credentialName}, command='sshpass -e ssh -o StrictHostKeyChecking=no ${user}@${ip} 命令'`);
  }
  hint.push(`   用完后务必调 ssh_instance(action=close, instanceId=${inst.id}) 关机结算`);
  hint.push(`   凭据用法: shell 传 credentialName=${credentialName || '凭据名'} 自动注入密码变量；代码里引用凭据名会自动替换为密码`);
  return hint;
}

/** 自有机器的使用提示（不计费；close 只解绑） */
function selfUsageHint(inst: any, credentialName: string | null, authMode?: 'key' | 'password' | 'none', fingerprint?: string): string[] {
  const ip = inst.public_ip || inst.host;
  const user = inst.ssh_user || inst.username || 'root';
  const port = Number(inst.port) || 22;
  const portArg = port !== 22 ? ` -p ${port}` : '';
  const hint = [
    `✅ 自有机器已就绪: ${inst.instance_type || 'self'} @ ${ip}:${port}`,
    `   记录ID: ${inst.id || inst.resourceId} | 登录用户: ${user} | 来源: 用户自有（不计费）`,
    `   凭据名: ${credentialName || '（未设置）'}`,
  ];
  if (authMode === 'password') {
    hint.push(`   ⚠️ 公钥免密未生效，走 plink 密码通道。用 userpc_shell 执行（传 credentialName=${credentialName} 注入 SSHPASS）:`);
    hint.push(`   & "$env:USERPROFILE\\.teegal\\bin\\plink.exe" -ssh -P ${port} -batch${fingerprint ? ` -hostkey "${fingerprint}"` : ''} -pw $env:SSHPASS ${user}@${ip} "命令"`.replace(/\s+/g, ' '));
  } else {
    const idArg = sshIdentityArg();
    hint.push(`   现在用 userpc_shell 执行: ssh ${idArg}${portArg} -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${user}@${ip} '命令'`.replace(/\s+/g, ' '));
  }
  hint.push(`   （需要 root 权限时用: ${user}@${ip} 'sudo -i' 或 'sudo 命令'）`);
  if (authMode !== 'password' && credentialName) {
    hint.push(`   （密码兜底，macOS/Linux）: userpc_shell 传 credentialName=${credentialName}, command='sshpass -e ssh${portArg} -o StrictHostKeyChecking=no ${user}@${ip} 命令'`);
  }
  hint.push(`   该机器由用户自有维护，不产生平台计费；用 action=close, instanceId=${inst.id || inst.resourceId} 只解除项目绑定（机器不受影响）`);
  return hint;
}

/**
 * ssh_instance 工具执行入口
 * action: activate（开机/复用）| add（绑定自有服务器）| close（关机/解绑）| list（活跃实例清单）
 */
export async function executeSshInstanceTool(
  step: AutoStep,
  _planId: string,
  _onProgress?: (progress: ExecuteCommandProgress) => void,
  context?: { userId?: string }
): Promise<AutoToolResult> {
  const params = step.toolParams || {};
  const action = String(params.action || 'activate').trim();

  // ---------- list：活跃实例清单（本地资源表，带项目归属 appId） ----------
  if (action === 'list') {
    const r = await sshListActive(context?.userId);
    if (!r.ok) return fail(r.error || '查询失败');
    if (r.instances.length === 0) {
      return ok(['当前没有活跃的常驻实例。用 action=activate + instanceType 开机']);
    }
    const lines = r.instances.map((r: any) =>
      r.source === 'workstation'
        ? `- ${r.id} | 自有机器（不计费） | ${r.instance_type} | ${r.status} | ${r.username || 'root'}@${r.host || '?'}:${r.port || 22} | 项目: ${r.app_id || '（未绑定）'} | 凭据: ${r.credential_name || '（未设置）'}`
        : `- ${r.cloud_rental_id || r.cloud_instance_id} | ${r.instance_type} | ${r.status} | IP: ${r.host || '分配中'} | 登录用户: ${r.username || r.ssh_user || 'ubuntu'} | 项目: ${r.app_id || '（未绑定）'} | 凭据: ${r.credential_name || `ssh_${r.cloud_instance_id}`}`
    );
    return ok([
      `活跃常驻实例 ${r.instances.length} 台（按项目归属区分，root 权限用 sudo -i）:`,
      ...lines,
      `凭据用法: userpc_shell 传 credentialName=凭据名 即自动登录对应机子；代码/脚本里引用该凭据名会自动替换成密码`,
      `绑定用户自有服务器: action=add + host/port/username/password（连通测试通过后自动配公钥免密并登记，不计费）`,
    ]);
  }

  // ---------- close：关机结算（自有机器=解绑） ----------
  if (action === 'close') {
    const instanceId = String(params.instanceId || '').trim();
    if (!instanceId) return fail('缺少 instanceId（可用 action=list 先查询）');
    const r = await sshCloseInstance(instanceId, context?.userId);
    if (!r.ok) return fail(r.error || '关机失败');
    if (r.unbound) {
      return ok([`✅ 自有机器已解除绑定（机器本身不受影响，不计费，凭据已同步清除；需要时重新添加即可）`]);
    }
    return ok([`✅ 实例 ${r.rentalId} 已关机，云端已按时长结算扣费（对应凭据已清理）`]);
  }

  // ---------- add：绑定用户自有服务器（不计费、不过云端账本） ----------
  if (action === 'add') {
    const host = String(params.host || '').trim();
    const username = String(params.username || 'root').trim();
    const password = String(params.password || '').trim();
    const port = Number(params.port || 22) || 22;
    if (!host || !password) {
      return fail('缺少 host 或 password（自有服务器地址与密码请向用户确认后传入）');
    }
    const r = await sshAddSelfInstance({
      host,
      port,
      username,
      password,
      projectId: String(params.projectId || '').trim() || undefined,
      userId: context?.userId,
    });
    if (!r.ok) return fail(r.error || '添加失败');
    const hint = selfUsageHint(r.instance, r.credentialName ?? null, r.authMode, r.plinkFingerprint);
    hint.unshift(`sshReady=${r.sshReady} | authMode=${r.authMode ?? 'unknown'} | credentialName=${r.credentialName || '（入库失败）'}${r.plinkFingerprint ? ` | hostkey=${r.plinkFingerprint}` : ''}`);
    return ok(hint);
  }

  // ---------- activate：开机（或复用；instanceId 命中自有机器直接复用） ----------
  if (action !== 'activate') {
    return fail(`未知 action: ${action}（支持 activate | add | close | list）`);
  }

  const instanceId = String(params.instanceId || '').trim();
  const instanceType = String(params.instanceType || '').trim();
  if (!instanceType && !instanceId) {
    return fail('缺少 instanceType（如 S5.MEDIUM4，可用 list_instance_types 查询规格），或传 instanceId 复用已有实例（可用 action=list 查询）');
  }

  // 🔥 自有机器复用：instanceId 命中本地 workstation 活跃记录 → 直接返回（不查云端）
  if (instanceId) {
    const lr = await localApi(`/api/rental/resources?userId=${encodeURIComponent(context?.userId || '')}`)
      .catch(() => ({ ok: false, status: 0, data: null }));
    const rec = (lr.data?.resources || []).find((x: any) => x.id === instanceId && x.source === 'workstation');
    if (rec && (rec.status === 'booting' || rec.status === 'running')) {
      const hint = selfUsageHint(rec, rec.credential_name || null);
      hint.unshift(`sshReady=true | authMode=reused(自有机器) | credentialName=${rec.credential_name || '（未设置）'}`);
      return ok(hint);
    }
    if (rec) {
      return fail(`自有机器 ${instanceId} 已解除绑定，请用 action=add 重新添加`);
    }
  }

  const r = await sshOpenInstance({
    instanceType,
    projectId: String(params.projectId || '').trim() || undefined,
    userId: context?.userId,
    resumeInstanceId: instanceId || undefined,
  });
  if (!r.ok) return fail(r.error || '开机失败');

  const lines = usageHint(r.instance, r.credentialName ?? null, r.authMode, r.plinkFingerprint);
  // 🔥 显式字段行：LLM 解析依赖机器可读字段，不再只靠语义文案
  lines.unshift(
    `sshReady=${r.sshReady === undefined ? 'skipped(复用机)' : r.sshReady} | authMode=${r.authMode ?? 'unknown'} | credentialName=${r.credentialName || '（入库失败）'}${r.plinkFingerprint ? ` | hostkey=${r.plinkFingerprint}` : ''}${r.reused ? ' | reused=true' : ''}`
  );
  if (r.sshReady === false) {
    lines.unshift(`⚠️ 免密 SSH 探测未通过（authMode=${r.authMode ?? 'unknown'}：key/password 都未连通），稍等 1-2 分钟重试探测；不要挂起等密码`);
    if (r.probeDiag) {
      lines.push(`[探测诊断摘要，本地侧]`);
      lines.push(r.probeDiag);
    }
  } else if (r.authMode === 'password' && r.probeDiag) {
    lines.push(r.probeDiag.split('\n')[0]);
  }
  return ok(lines);
}
