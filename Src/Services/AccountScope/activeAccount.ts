/**
 * @module Services/AccountScope/activeAccount
 * @description
 * 兼容薄壳（2026-10-04）：实现已下移至 `Src/Infra/AccountScope/activeAccount.ts`。
 *
 * 原因：属主上下文是**零依赖的进程级原语**，被 `Infra/Db/Repositories/*` 消费时
 * 若仍留在 Services 层会形成 "Infra → Services" 上行依赖（违反分层红线，
 * `import/no-restricted-paths` 门禁）。下移后 Infra 内部直接引用新路径，
 * 其余层经本壳保持既有导入路径不变。
 */

export {
  LOCAL_OWNER, setActiveOwner, getActiveOwner, isAnonymousOwner,
} from '../../Infra/AccountScope/activeAccount.js';
