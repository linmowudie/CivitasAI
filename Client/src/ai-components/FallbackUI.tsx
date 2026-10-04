/**
 * FallbackUI——族错误边界降级组件。
 * Docs/Client/03-AI组件族架构 §3.4。
 *
 * 职责：当某族组件崩溃时，展示友好的降级提示。
 * 开发环境显示详细错误信息，生产环境显示通用提示。
 */

import styles from './FallbackUI.module.css';

interface FallbackUIProps {
  /** 出错的族名 */
  family: string;
  /** 错误对象（开发环境可展示） */
  error?: Error;
  /** 重试回调 */
  onRetry?: () => void;
}

export function FallbackUI({ family, error, onRetry }: FallbackUIProps) {
  const isDev = import.meta.env.DEV;

  return (
    <div className={styles.fallback} data-family={family}>
      <span className={styles.icon}>⚠️</span>
      <span className={styles.message}>{family} 族组件加载失败</span>
      {isDev && error && (
        <pre className={styles.detail}>{error.message}</pre>
      )}
      {onRetry && (
        <button className={styles.retry} onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
}
