/**
 * @module Services/A2A/memoryGuard
 * @description 记忆侧**通道守卫**（P0a 后端内核）—— 设计 §16（权责隔离）RS 落在**写入处**。
 *
 * 为什么放在这里而不是 `SharedMemory` 内：规则属于 A2A 的"通道混用"判据（C7），
 * 而 `SharedMemory` 不应反向依赖 A2A（会形成环）。因此由本模块实现规则，
 * 经 `globalWorkspace.setMemoryChannelGuard()` **注入**。
 *
 * 拦截四类越界（全部 fail-closed）：
 *  - **C7-B 拿记忆当信箱**：键 ∉ 任务命名空间，或内容含点对点私语特征；
 *  - **RM4 权限不互授**：治理键仅 L0（A2A 卡片上的权限**不得**替代记忆写权）；
 *  - **RM7 双向可追溯**：A2A 驱动的写入必须携带**有效** `sourceMessageId`（存在、同任务、且该消息**已放行**）；
 *  - （既有）隔离键/治理键的键分层校验由 `memoryGovernance.requireWritePermission` 承担。
 */

import { classifyKeyTier } from '../SharedMemory/memoryGovernance.js';
import { setMemoryChannelGuard, type MemoryWriteGuardInput, type MemoryWriteGuardDecision } from '../SharedMemory/globalWorkspace.js';
import { detectMemoryAsMailbox } from './collusion.js';
import { getMessageById } from './a2aStore.js';
import { tierOfRole } from '../../Infra/Roles/roleVocabulary.js';

/** 判定一次记忆写入是否放行（纯逻辑 + 一次消息查询） */
export function evaluateMemoryWrite(input: MemoryWriteGuardInput): MemoryWriteGuardDecision {
  const key = String(input.key ?? '');
  const content = String(input.content ?? '');

  // ① C7-B：记忆不得当信箱（键命名空间 / 私语特征）
  //    ⚠️ 治理键按定义是跨任务共享事实通道 → 豁免命名空间规则，仅保留私语检查（§18 #31）
  const tier = classifyKeyTier(key);
  const mailbox = detectMemoryAsMailbox({
    key, taskId: input.taskId, content,
    ...(tier === 'governance' ? { skipNamespaceCheck: true } : {}),
  });
  if (mailbox) {
    return {
      allowed: false,
      rule: 'C7',
      reason: `写入被拒绝：疑似**把共享记忆当通信信箱**（${String(mailbox.evidence['reason'])}）${mailbox.evidence['whisperMarker'] ? `，命中私语特征「${String(mailbox.evidence['whisperMarker'])}」` : ''}。请改用 A2A 通道。`,
    };
  }

  // ② RM4：治理键仅 L0 / 所有者（卡片权限**不得**替代记忆写权）
  if (tier === 'governance') {
    const roleTier = tierOfRole(input.actorRole);
    const isOwner = input.actorRole === 'user';
    if (!isOwner && roleTier !== 'L0') {
      return {
        allowed: false,
        rule: 'RM4',
        reason: `写入被拒绝：key "${key}" 属**治理键**，仅 L0/所有者可写（当前 actorRole=${input.actorRole ?? '未提供'}）—— A2A 授权不隐含记忆写权。`,
      };
    }
  }

  // ③ RM7：A2A 驱动的写入必须可追溯，且**被阻断的消息不得沉淀为事实**
  if (input.sourceMessageId) {
    const msg = getMessageById(input.sourceMessageId);
    if (!msg) {
      return { allowed: false, rule: 'RM7', reason: `写入被拒绝：sourceMessageId=${input.sourceMessageId} 在本机不存在（无法追溯来源）。` };
    }
    if (input.taskId && msg.envelope.taskId !== input.taskId) {
      return {
        allowed: false, rule: 'RM7',
        reason: `写入被拒绝：来源消息属任务 ${msg.envelope.taskId}，与写入任务 ${input.taskId} 不一致（禁止跨任务伪造溯源）。`,
      };
    }
    if (msg.verdict !== 'allow') {
      return {
        allowed: false, rule: 'RM7',
        reason: `写入被拒绝：来源消息判定为 ${msg.verdict}（未放行），**被阻断/隔离的通信不得沉淀为共享事实**。`,
      };
    }
  }

  return { allowed: true };
}

/** 装配守卫到 GlobalWorkspace（幂等） */
export function attachMemoryChannelGuard(): void {
  setMemoryChannelGuard(evaluateMemoryWrite);
}

/** 卸载守卫（测试/热重载） */
export function detachMemoryChannelGuard(): void {
  setMemoryChannelGuard(null);
}
