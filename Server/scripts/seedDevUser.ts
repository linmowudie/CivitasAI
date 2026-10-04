#!/usr/bin/env tsx
/**
 * 开发测试用户初始化脚本
 * 
 * 用法：npm run seed:dev
 * 
 * 创建 dev@civitas.local 开发测试用户并绑定当前设备指纹。
 * 开发环境验证码固定为 888888（在 authService 中通过 NODE_ENV 判断）。
 */
import { readEnv, loadConfig } from '../src/config.js';
import { createDb } from '../src/db/pool.js';
import * as users from '../src/repositories/users.js';
import { hashPassword } from '../src/security/password.js';
import { getDeviceFingerprint } from '../../Src/Infra/Security/deviceFingerprint.js';

const DEV_EMAIL = 'dev@civitas.local';
const DEV_DISPLAY_NAME = '开发测试用户';

async function main(): Promise<void> {
  const cfgResult = loadConfig(readEnv());
  if (!cfgResult.ok || !cfgResult.config) {
    console.error('✖ 配置校验失败：');
    for (const e of cfgResult.errors ?? []) console.error('  -', e);
    process.exit(1);
  }
  const cfg = cfgResult.config;

  const db = createDb(cfg.databaseUrl, cfg.db);
  if (!(await db.ping())) {
    console.error('✖ 无法连接数据库，请检查 DATABASE_URL：');
    await db.close();
    process.exit(1);
  }

  try {
    // 检查用户是否已存在
    const existing = await users.findUserByEmail(db, DEV_EMAIL);
    if (existing) {
      console.log('✔ 开发测试用户已存在：');
      console.log(`   邮箱: ${existing.email}`);
      console.log(`   ID: ${existing.id}`);
      console.log(`   状态: ${existing.status}`);
      console.log(`   绑定设备: ${existing.bound_device_id ?? '未绑定'}`);
      
      // 如果未绑定设备，绑定当前设备
      if (!existing.bound_device_id) {
        const deviceId = getDeviceFingerprint();
        await users.bindDevice(db, existing.id, deviceId, { label: '开发设备' });
        console.log(`   ✔ 已绑定当前设备: ${deviceId}`);
      }
      return;
    }

    // 创建开发测试用户（使用随机密码哈希，验证码登录不需要密码）
    const randomHash = await hashPassword(`__dev_user_${Date.now()}_${Math.random()}`);
    const user = await users.createUser(db, {
      email: DEV_EMAIL,
      emailLower: DEV_EMAIL.toLowerCase(),
      passwordHash: randomHash,
      displayName: DEV_DISPLAY_NAME,
    });

    // 绑定当前设备指纹
    const deviceId = getDeviceFingerprint();
    await users.bindDevice(db, user.id, deviceId, { label: '开发设备' });

    console.log('✔ 开发测试用户创建成功：');
    console.log(`   邮箱: ${DEV_EMAIL}`);
    console.log(`   ID: ${user.id}`);
    console.log(`   设备指纹: ${deviceId}`);
    console.log('');
    console.log('登录方式：使用验证码登录');
    console.log('开发环境验证码：888888（固定）或查看控制台输出');
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error('✖ 初始化失败:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
