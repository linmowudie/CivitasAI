/**
 * @module Infra/Security/deviceFingerprint
 * @description
 * 设备唯一指纹生成——基于 MAC 地址 + 主机名 + 磁盘序列号（Windows）
 * 生成不可逆的 SHA-256 哈希作为设备标识。
 * 
 * 用途：
 *  - 开发测试账号绑定设备，防止其他设备登录开发账号
 *  - 登录时校验设备一致性
 */

import { createHash } from 'node:crypto';
import { networkInterfaces, hostname } from 'node:os';
import { execSync } from 'node:child_process';

/** 获取所有非内部网卡的 MAC 地址（排序拼接确保确定性） */
function getMacAddresses(): string[] {
  const nets = networkInterfaces();
  const macs: string[] = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      // 跳过内部回环和零 MAC
      if (!net.internal && net.mac && net.mac !== '00:00:00:00:00:00') {
        macs.push(net.mac);
      }
    }
  }
  // 排序确保跨调用一致性
  return macs.sort();
}

/** 获取磁盘序列号（仅 Windows；其他平台返回空串） */
function getDiskSerial(): string {
  if (process.platform !== 'win32') return '';
  try {
    // WMIC 获取系统盘序列号
    const output = execSync('wmic diskdrive get serialnumber', {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    });
    const lines = output.split('\n').map(l => l.trim()).filter(l => l && l !== 'SerialNumber');
    return lines[0] ?? '';
  } catch {
    return '';
  }
}

/**
 * 生成设备唯一指纹（SHA-256 哈希）。
 * 
 * 组成：MAC 地址列表 + 主机名 + 磁盘序列号
 * 输出：64 位十六进制字符串
 */
export function getDeviceFingerprint(): string {
  const macs = getMacAddresses();
  const host = hostname();
  const diskSerial = getDiskSerial();
  
  const raw = [
    macs.join(','),
    host,
    diskSerial,
  ].join('|');
  
  return createHash('sha256').update(raw).digest('hex');
}
