/**
 * SSH 资源表 DAO（用户侧"我的资源中心"）
 *
 * 与云端账本（rental_instances，只记卖出的实例）分工：
 * 本地表记"我的机器"——来源 cloud（云端租赁）/ workstation（本地工作站，预留），
 * UI 与后续工具链都读写它。云端扣费账本以云端为准，本地只做资源视图。
 */

import { localDatabase } from '../local-storage/database';

export interface SshResource {
  id: string;
  user_id: string;
  app_id: string;            // 🔥 项目归属：开机时登记的 appId（区分"这个项目专属的机子"）
  name: string;
  source: string;            // cloud | workstation
  provider: string;          // tencent
  instance_type: string;
  region: string;
  host: string;              // 公网 IP / 工作站地址
  port: number;
  username: string;
  credential_name: string;
  cloud_rental_id: string;
  cloud_instance_id: string;
  price_per_hour: number;
  status: string;            // booting | running | closed | error
  remark: string;
  created_at: number;
  closed_at: number;
  updated_at: number;
}

export class SshResourceDAO {
  create(rec: {
    id: string;
    user_id: string;
    app_id?: string;
    name?: string;
    source?: string;
    provider?: string;
    instance_type?: string;
    cloud_rental_id?: string;
    price_per_hour?: number;
    status?: string;
    remark?: string;
  }): SshResource {
    const db = localDatabase.getDb();
    const now = Date.now();
    db.prepare(`
      INSERT INTO ssh_resources (
        id, user_id, app_id, name, source, provider, instance_type,
        cloud_rental_id, price_per_hour, status, remark, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      rec.id,
      rec.user_id || 'unknown',
      rec.app_id || '',
      rec.name || '',
      rec.source || 'cloud',
      rec.provider || 'tencent',
      rec.instance_type || '',
      rec.cloud_rental_id || '',
      rec.price_per_hour || 0,
      rec.status || 'booting',
      rec.remark || '',
      now,
      now
    );
    return this.getById(rec.id)!;
  }

  /** 开机就绪：补 IP / 底层实例 ID / 凭据名 */
  markRunning(
    id: string,
    patch: { host?: string; cloud_instance_id?: string; credential_name?: string; region?: string; username?: string }
  ): void {
    const db = localDatabase.getDb();
    db.prepare(`
      UPDATE ssh_resources
      SET host = COALESCE(?, host),
          cloud_instance_id = COALESCE(?, cloud_instance_id),
          credential_name = COALESCE(?, credential_name),
          region = COALESCE(?, region),
          username = COALESCE(?, username),
          status = 'running',
          updated_at = ?
      WHERE id = ?
    `).run(
      patch.host ?? null,
      patch.cloud_instance_id ?? null,
      patch.credential_name ?? null,
      patch.region ?? null,
      patch.username ?? null,
      Date.now(),
      id
    );
  }

  /** 🔥 添加自有机器（用户自己的服务器：不过云端账本、不计费、不参与对账） */
  addSelf(rec: {
    id: string;
    user_id: string;
    app_id?: string;
    name: string;
    host: string;
    port: number;
    username: string;
    credential_name: string;
  }): SshResource {
    const db = localDatabase.getDb();
    const now = Date.now();
    db.prepare(`
      INSERT INTO ssh_resources (
        id, user_id, app_id, name, source, provider, instance_type,
        host, port, username, credential_name,
        cloud_rental_id, cloud_instance_id, price_per_hour, status, remark, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, 'workstation', 'self', 'self', ?, ?, ?, ?, '', '', 0, 'running', '自有机器（本地维护）', ?, ?)
    `).run(
      rec.id,
      rec.user_id || 'unknown',
      rec.app_id || '',
      rec.name,
      rec.host,
      rec.port || 22,
      rec.username,
      rec.credential_name || '',
      now,
      now
    );
    return this.getById(rec.id)!;
  }

  /** 🔥 自有机器查重：同 host+port+username 的活跃记录（防重复绑定） */
  findActiveByHost(host: string, port: number, username: string): SshResource | null {
    const row = localDatabase.getDb().prepare(`
      SELECT * FROM ssh_resources
      WHERE source = 'workstation' AND host = ? AND port = ? AND username = ?
        AND status IN ('booting', 'running')
      LIMIT 1
    `).get(host, port, username) as any;
    return row || null;
  }

  /** 🔥 自有机器解绑（只解除本地关联；机器本身不受影响，云端账本无关） */
  markClosedById(id: string): boolean {
    const result = localDatabase.getDb().prepare(`
      UPDATE ssh_resources
      SET status = 'closed', closed_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('booting', 'running')
    `).run(Date.now(), Date.now(), id);
    return result.changes > 0;
  }

  /** 按云端键（rentalId 或底层 instanceId）关机收尾 */
  markClosedByCloudKey(cloudKey: string): void {
    const db = localDatabase.getDb();
    db.prepare(`
      UPDATE ssh_resources
      SET status = 'closed', closed_at = ?, updated_at = ?
      WHERE (cloud_rental_id = ? OR cloud_instance_id = ?) AND status IN ('booting', 'running')
    `).run(Date.now(), Date.now(), cloudKey, cloudKey);
  }

  /** 🔥 云端对账校正：云端仍活跃但本地状态落后（booting 未回写/被误关/丢失）→ 拉回 running 并回填 IP */
  reviveByCloudKey(cloudKey: string, host?: string): boolean {
    const db = localDatabase.getDb();
    const result = db.prepare(`
      UPDATE ssh_resources
      SET status = 'running', closed_at = 0, host = COALESCE(NULLIF(?, ''), host), updated_at = ?
      WHERE (cloud_rental_id = ? OR cloud_instance_id = ?) AND status IN ('closed', 'error', 'booting')
    `).run(host || '', Date.now(), cloudKey, cloudKey);
    return result.changes > 0;
  }

  /** 开机失败 */
  markError(id: string, remark: string): void {
    const db = localDatabase.getDb();
    db.prepare(`UPDATE ssh_resources SET status = 'error', remark = ?, updated_at = ? WHERE id = ?`)
      .run(remark, Date.now(), id);
  }

  getById(id: string): SshResource | null {
    const row = localDatabase.getDb().prepare('SELECT * FROM ssh_resources WHERE id = ?').get(id) as any;
    return row || null;
  }

  listByUser(userId: string, activeOnly = false): SshResource[] {
    const sql = activeOnly
      ? `SELECT * FROM ssh_resources WHERE user_id = ? AND status IN ('booting', 'running') ORDER BY created_at DESC`
      : `SELECT * FROM ssh_resources WHERE user_id = ? ORDER BY created_at DESC`;
    return localDatabase.getDb().prepare(sql).all(userId) as any[];
  }

  /** 🔥 按项目 appId 查活跃实例（让 LLM 知道当前项目是否有专属机子可用） */
  listActiveByAppId(appId: string): SshResource[] {
    return localDatabase.getDb()
      .prepare(`SELECT * FROM ssh_resources WHERE app_id = ? AND status IN ('booting', 'running') ORDER BY created_at DESC`)
      .all(appId) as any[];
  }

  /** 🔥 对账补登：云端活跃但本地无记录（开本地库前的机子/记录丢失）→ 以 running 建档 */
  adoptFromCloud(rec: {
    user_id: string;
    name: string;
    instance_type: string;
    host: string;
    username: string;
    credential_name: string;
    cloud_rental_id: string;
    cloud_instance_id: string;
    price_per_hour: number;
    opened_at?: number;
  }): SshResource {
    const id = `sshres-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const db = localDatabase.getDb();
    const created = rec.opened_at && rec.opened_at > 0 ? rec.opened_at : Date.now();
    db.prepare(`
      INSERT INTO ssh_resources (
        id, user_id, app_id, name, source, provider, instance_type, region,
        host, port, username, credential_name, cloud_rental_id, cloud_instance_id,
        price_per_hour, status, remark, created_at, updated_at
      )
      VALUES (?, ?, '', ?, 'cloud', 'tencent', ?, '', ?, 22, ?, ?, ?, ?, ?, 'running', '对账补登（云端账本恢复）', ?, ?)
    `).run(
      id,
      rec.user_id,
      rec.name,
      rec.instance_type,
      rec.host,
      rec.username,
      rec.credential_name,
      rec.cloud_rental_id,
      rec.cloud_instance_id,
      rec.price_per_hour,
      created,
      Date.now()
    );
    return this.getById(id)!;
  }
}

export const sshResourceDAO = new SshResourceDAO();
