/**
 * @module Infra/AccountScope/activeAccount
 * @description
 * **账号数据命名空间**（个人数据隔离的单一真源）。
 *
 * 背景（FE-032 及其扩展）：应用里大量个人数据（会话/消息、审批队列、共享工作区、
 * 长时记忆、统计事件）原本是"机器级"的 —— 同一台机器切换账号后，
 * 新账号能看到上一个账号的数据，甚至把它上传到自己的云端账号。
 *
 * 方案：所有"属于某个人的数据"都带 `owner_user_id`，读写一律以本模块的
 * `getActiveOwner()` 为准：
 *  - 未登录：`local`（本机匿名数据）
 *  - 已登录：服务端 userId
 *
 * 切换属主由客户端在登录/登出时通过 `PUT /api/account/active-user` 触发；
 * 切换后各内存态（长时记忆 Map、会话缓存等）会按新属主重新加载。
 *
 * 分层说明（2026-10-04，FE-064~072 批次分层审计）：本模块原位于
 * `Src/Services/AccountScope/`，被 `Infra/Db/Repositories/*` 消费时会形成
 * "Infra → Services" 上行依赖（违反分层红线）。本模块是**零依赖的进程级上下文
 * 原语**（与 `Infra/Time` 同性质），故下移至 Infra；原路径保留薄壳重导出兼容。
 */

/** 未登录时的属主键（本机匿名数据） */
export const LOCAL_OWNER = 'local';

let activeOwner: string = LOCAL_OWNER;

/** 设置当前属主（null/空/空白 → local）。返回是否发生了变化 */
export function setActiveOwner(owner: string | null | undefined): boolean {
  const next = owner && owner.trim().length > 0 ? owner.trim() : LOCAL_OWNER;
  if (next === activeOwner) return false;
  activeOwner = next;
  return true;
}

/** 当前属主（用于所有个人数据表的读写过滤） */
export function getActiveOwner(): string {
  return activeOwner;
}

/** 是否处于匿名（未登录）命名空间 */
export function isAnonymousOwner(): boolean {
  return activeOwner === LOCAL_OWNER;
}
