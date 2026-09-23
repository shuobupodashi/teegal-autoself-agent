/**
 * SSH 租赁路由（/api/rental/*）
 *
 * 分工：云端 /api/rental/v1/* 是账本（开机/关机/计费/扣费），
 * 本地 ssh_resources 表是用户侧资源中心（UI 视图 + 未来 workstation 扩展）。
 * 本路由做转发 + 双写登记。
 */

import { Router, Request, Response } from 'express';
import { rentalRequest } from '../rental/RentalProxy';
import { sshResourceDAO } from '../rental/SshResourceDAO';

const router = Router();

// 可租赁规格（CPU 通用计算档位 + 单价，云端权威）
router.get('/types', async (_req: Request, res: Response) => {
  try {
    const data = await rentalRequest('GET', '/types');
    res.json(data);
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

// 开机（云端异步开机 + 本地登记 booting，appId 记录项目归属）
router.post('/open', async (req: Request, res: Response) => {
  try {
    const { instanceType, userId, appId, publicKey } = req.body || {};
    if (!instanceType) {
      res.status(400).json({ success: false, error: '缺少 instanceType' });
      return;
    }
    const cloud = await rentalRequest<any>('POST', '/open', { instanceType, publicKey });
    if (!cloud?.success || !cloud.rentalId) {
      res.status(502).json({ success: false, error: '云端开机请求失败' });
      return;
    }

    const resource = sshResourceDAO.create({
      id: `sshres-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      user_id: String(userId || 'unknown'),
      app_id: String(appId || ''),
      name: `云端 ${instanceType}`,
      source: 'cloud',
      provider: 'tencent',
      instance_type: instanceType,
      cloud_rental_id: cloud.rentalId,
      price_per_hour: Number(cloud.pricePerHour || 0),
      status: 'booting',
    });

    res.json({ success: true, rentalId: cloud.rentalId, resourceId: resource.id, status: 'pending' });
  } catch (error: any) {
    console.error('[RENTAL-PROXY] 开机失败:', error.message);
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

// 云端活跃实例列表（权威视图，?active=1）
// 🔥 防泄密：剔除 ssh_password（密码只走凭据库，不进任何接口响应）
// 🔥 透传 userId：用户 JWT 模式下云端以 token 为准忽略它；worker 密钥模式下云端
//    信任 query.userId 按用户过滤——不传则返回空列表，对账会把本地 running 误判为已关
router.get('/instances', async (req: Request, res: Response) => {
  try {
    const active = req.query.active === '1' || req.query.active === 'true';
    const uid = String(req.query.userId || '');
    const query = [
      active ? 'active=1' : '',
      uid ? `userId=${encodeURIComponent(uid)}` : '',
    ].filter(Boolean).join('&');
    const data = await rentalRequest<any>('GET', `/instances${query ? `?${query}` : ''}`);
    if (Array.isArray(data?.instances)) {
      data.instances = data.instances.map(({ ssh_password, ...rest }: any) => rest);
    }
    res.json(data);
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

// 云端实例详情（轮询开机状态用；同样剔除 ssh_password）
router.get('/instances/:id', async (req: Request, res: Response) => {
  try {
    const data = await rentalRequest<any>('GET', `/instances/${encodeURIComponent(req.params.id)}`);
    if (data?.instance) {
      const { ssh_password, ...rest } = data.instance;
      data.instance = rest;
    }
    res.json(data);
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

// 关机结算（云端扣费 + 本地收尾）
router.post('/instances/:id/close', async (req: Request, res: Response) => {
  try {
    const data = await rentalRequest('POST', `/instances/${encodeURIComponent(req.params.id)}/close`, {
      reason: req.body?.reason || 'user'
    });
    if (data?.success) {
      sshResourceDAO.markClosedByCloudKey(String(req.params.id));
    }
    res.json(data);
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

// 本地资源表（用户侧资源中心）
// 🔥 sync=1 时与云端账本双向对账（数据安全第一）：
//    - 云端仍活跃但本地被误关/丢失 → 恢复 running（防止"机器还在跑但用户看不到"）
//    - 云端已不活跃但本地还亮灯 → 收尾 closed（防止脱节）
//    云端查询失败/返回异常时一律跳过，绝不动本地数据
router.get('/resources', async (req: Request, res: Response) => {
  const userId = String(req.query.userId || 'unknown');
  const appId = req.query.appId ? String(req.query.appId) : '';
  const activeOnly = req.query.active === '1' || req.query.active === 'true';

  if (req.query.sync !== '0') {
    try {
      // 🔥 带 userId：worker 密钥模式下云端按它过滤（JWT 模式下云端以 token 为准忽略）
      const cloudActive = await rentalRequest<any>('GET', `/instances?active=1&userId=${encodeURIComponent(userId)}`);
      // 🔥 只有云端明确返回成功且是数组才做对账；空列表也允许（用户确实全关干净了）
      if (cloudActive?.success === true && Array.isArray(cloudActive.instances)) {
        const ownRecords = sshResourceDAO.listByUser(userId, false);
        if (cloudActive.instances.length === 0 &&
            ownRecords.some(r => r.source === 'cloud' && (r.status === 'running' || r.status === 'booting'))) {
          console.warn('[RENTAL-SYNC] 云端活跃列表为空但本地仍有 running/booting 记录——若用户并未手动全部关机，请检查云端认证视角');
        }
        const byRentalId = new Map<string, any>();
        const byInstanceId = new Map<string, any>();
        const ownKeys = new Set<string>();
        for (const inst of cloudActive.instances) {
          if (inst.id) byRentalId.set(String(inst.id), inst);
          if (inst.instance_id) byInstanceId.set(String(inst.instance_id), inst);
        }
        for (const rec of ownRecords) {
          if (rec.source !== 'cloud') continue;
          const cloudInst =
            (rec.cloud_rental_id && byRentalId.get(rec.cloud_rental_id)) ||
            (rec.cloud_instance_id && byInstanceId.get(rec.cloud_instance_id)) ||
            null;
          if (cloudInst) {
            // 云端仍活跃：booting 未回写 / 被误关 / IP 未回填 → 统一拉回 running 并回填 IP
            if (rec.status !== 'running' || !rec.host) {
              if (rec.status === 'booting') {
                console.warn(`[RENTAL-SYNC] 云端已就绪，回写本地记录: ${rec.cloud_rental_id}`);
              }
              sshResourceDAO.reviveByCloudKey(rec.cloud_rental_id || rec.cloud_instance_id, cloudInst.public_ip);
            }
          } else if (rec.status === 'running') {
            // 云端已关（超时/余额不足/手动）→ 本地收尾
            sshResourceDAO.markClosedByCloudKey(rec.cloud_rental_id || rec.cloud_instance_id);
          }
          // booting 且云端查不到：可能仍在创建，不动（30 分钟僵死由云端 sweep 处理）
          if (rec.cloud_rental_id) ownKeys.add(rec.cloud_rental_id);
          if (rec.cloud_instance_id) ownKeys.add(rec.cloud_instance_id);
        }

        // 🔥 反向补登：云端活跃但当前用户名下无任何记录（本地库被清/登记丢失/换机器）
        // 云端账本是唯一事实源——正在计费的机子必须在本地有关机入口
        for (const inst of cloudActive.instances) {
          if (!inst.id) continue;
          // 云端带归属时只补登属于当前用户的；无归属字段（运维视角）才全量补
          if (inst.user_id && String(inst.user_id) !== userId) continue;
          // 只对"当前用户名下"查重：记录挂在别人名下时不跳过，照样给当前用户补登
          if (ownKeys.has(String(inst.id)) || (inst.instance_id && ownKeys.has(String(inst.instance_id)))) continue;
          console.warn(`[RENTAL-SYNC] 云端活跃但本地无记录，补登: ${inst.id} (${inst.instance_id})`);
          sshResourceDAO.adoptFromCloud({
            user_id: userId,
            name: `云端 ${inst.instance_type || ''}`.trim(),
            instance_type: String(inst.instance_type || ''),
            host: String(inst.public_ip || ''),
            username: String(inst.ssh_user || 'ubuntu'),
            // 凭据按统一命名规则可反查（开机时按 ssh_<instanceId> 入库），关机删除同样能对上
            credential_name: inst.instance_id ? `ssh_${inst.instance_id}` : '',
            cloud_rental_id: String(inst.id),
            cloud_instance_id: String(inst.instance_id || ''),
            price_per_hour: Number(inst.price_per_hour || 0),
            opened_at: inst.opened_at ? Number(new Date(inst.opened_at).getTime()) : undefined,
          });
        }
      }
    } catch (error: any) {
      // 云端不可达/认证失败时以本地为准，但必须留痕——静默吞掉会让人误以为对账正常
      console.warn('[RENTAL-SYNC] 云端对账跳过:', error?.message || error);
    }
  }

  let resources = sshResourceDAO.listByUser(userId, activeOnly);
  if (appId) {
    resources = resources.filter(r => r.app_id === appId);
  }
  res.json({ success: true, resources });
});

// 🔥 添加自有机器（用户自己的服务器）：密码只进凭据库不经后端，本地建档不过云端账本
router.post('/resources/self', (req: Request, res: Response) => {
  try {
    const { userId, appId, host, port, username, credentialName } = req.body || {};
    if (!host || !username) {
      res.status(400).json({ success: false, error: '缺少 host 或 username' });
      return;
    }
    // 同机器防重复绑定（活跃记录）
    const dup = sshResourceDAO.findActiveByHost(String(host), Number(port || 22), String(username));
    if (dup) {
      res.json({ success: true, duplicated: true, resourceId: dup.id, remark: '该机器已在常驻列表中' });
      return;
    }
    const resource = sshResourceDAO.addSelf({
      id: `sshres-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      user_id: String(userId || 'unknown'),
      app_id: String(appId || ''),
      name: `自有 ${host}`,
      host: String(host),
      port: Number(port || 22),
      username: String(username),
      credential_name: String(credentialName || ''),
    });
    res.json({ success: true, resourceId: resource.id });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🔥 自有机器解绑：只解除本地关联（机器本身不受影响，凭据保留；云端实例必须走 /close 结算）
router.post('/resources/:id/unbind', (req: Request, res: Response) => {
  const rec = sshResourceDAO.getById(req.params.id);
  if (!rec) {
    res.status(404).json({ success: false, error: '资源记录不存在' });
    return;
  }
  if (rec.source === 'cloud') {
    res.status(400).json({ success: false, error: '云端实例请走关机结算（/close），不能解绑' });
    return;
  }
  res.json({ success: sshResourceDAO.markClosedById(req.params.id) });
});

// 本地收尾（工具直调云端关机后回调，只改本地表不动云端）
router.post('/resources/close-by-key', (req: Request, res: Response) => {
  const key = String(req.body?.key || '');
  if (!key) {
    res.status(400).json({ success: false, error: '缺少 key' });
    return;
  }
  sshResourceDAO.markClosedByCloudKey(key);
  res.json({ success: true });
});

// 本地资源标记就绪（UI 轮询云端 running 后回写）
router.post('/resources/:id/running', (req: Request, res: Response) => {
  const rec = sshResourceDAO.getById(req.params.id);
  if (!rec) {
    res.status(404).json({ success: false, error: '资源记录不存在' });
    return;
  }
  sshResourceDAO.markRunning(req.params.id, {
    host: req.body?.host,
    cloud_instance_id: req.body?.cloudInstanceId,
    credential_name: req.body?.credentialName,
    region: req.body?.region,
    username: req.body?.sshUser,
  });
  res.json({ success: true });
});

// 本地资源标记失败
router.post('/resources/:id/error', (req: Request, res: Response) => {
  const rec = sshResourceDAO.getById(req.params.id);
  if (!rec) {
    res.status(404).json({ success: false, error: '资源记录不存在' });
    return;
  }
  sshResourceDAO.markError(req.params.id, String(req.body?.remark || '开机失败'));
  res.json({ success: true });
});

export default router;
