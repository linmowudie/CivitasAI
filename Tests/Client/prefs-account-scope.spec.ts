/**
 * @vitest-environment jsdom
 *
 * 偏好与同步元数据的**账号级隔离**（FE-032）
 *
 * 关注：换账号必须丢弃上一个账号的偏好与同步水位
 * （否则 B 会继承 A 的 serverRevision / statsSyncSince，误判"已同步"并可能写入 A 的偏好）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { usePrefsStore, DEFAULT_PREFS, DEFAULT_SYNC_META } from '../../Client/src/stores/prefsStore';

const PREFS_KEY = 'civitas.prefs';
const META_KEY = 'civitas.sync.meta';

const USER_A = 'user-aaaa';
const USER_B = 'user-bbbb';

beforeEach(() => {
  window.localStorage.clear();
  usePrefsStore.setState({
    prefs: { ...DEFAULT_PREFS },
    meta: { ...DEFAULT_SYNC_META },
    dirty: false,
    loaded: true,
  });
});

describe('偏好与同步元数据的账号隔离', () => {
  it('首次登录（无历史元数据）→ 按换账号处理，水位归零', () => {
    usePrefsStore.getState().setPref('selectedModel', 'stale-model');
    const switched = usePrefsStore.getState().adoptAccount(USER_A);

    expect(switched).toBe(true);
    expect(usePrefsStore.getState().meta.userId).toBe(USER_A);
    expect(usePrefsStore.getState().meta.serverRevision).toBe(0);
    expect(usePrefsStore.getState().meta.statsSyncSince).toBe(0);
    // 旧偏好被视为"上一个命名空间"的数据 → 丢弃
    expect(usePrefsStore.getState().prefs.selectedModel).toBe('');
  });

  it('同一账号再次进入 → 保留本地水位与偏好', () => {
    usePrefsStore.getState().adoptAccount(USER_A);
    usePrefsStore.getState().applyFromServer({ selectedModel: 'cloud-model' }, 7);
    usePrefsStore.getState().setStatsSyncSince(12345);

    const switched = usePrefsStore.getState().adoptAccount(USER_A);
    expect(switched).toBe(false);
    expect(usePrefsStore.getState().meta.serverRevision).toBe(7);
    expect(usePrefsStore.getState().meta.statsSyncSince).toBe(12345);
    expect(usePrefsStore.getState().prefs.selectedModel).toBe('cloud-model');
  });

  it('A → B 换账号 → 丢弃 A 的水位与偏好', () => {
    usePrefsStore.getState().adoptAccount(USER_A);
    usePrefsStore.getState().applyFromServer({ selectedModel: 'model-of-A', theme: 'light' }, 9);
    usePrefsStore.getState().setStatsSyncSince(999);

    const switched = usePrefsStore.getState().adoptAccount(USER_B);
    expect(switched).toBe(true);
    expect(usePrefsStore.getState().meta.userId).toBe(USER_B);
    expect(usePrefsStore.getState().meta.serverRevision).toBe(0);
    expect(usePrefsStore.getState().meta.statsSyncSince).toBe(0);
    expect(usePrefsStore.getState().prefs.selectedModel).toBe('');
    expect(usePrefsStore.getState().prefs.theme).toBe(DEFAULT_PREFS.theme);

    // 持久化也已更新（下次启动不会读到 A 的水位）
    expect(JSON.parse(window.localStorage.getItem(META_KEY)!).userId).toBe(USER_B);
  });

  it('登出（切到 null）→ 再次登录同一账号视为新会话，水位归零', () => {
    usePrefsStore.getState().adoptAccount(USER_A);
    usePrefsStore.getState().applyFromServer({ selectedModel: 'model-of-A' }, 5);

    const out = usePrefsStore.getState().adoptAccount(null);
    expect(out).toBe(true);
    expect(usePrefsStore.getState().meta.userId).toBeNull();

    const back = usePrefsStore.getState().adoptAccount(USER_A);
    expect(back).toBe(true); // 从 null 回到 A：保守处理为"切换"，避免用到旧水位
    expect(usePrefsStore.getState().meta.serverRevision).toBe(0);
  });

  it('旧版本地数据（元数据无 userId 字段）→ 一律按换账号处理（安全优先）', () => {
    // 模拟升级前的 localStorage：只有水位，没有 userId
    window.localStorage.setItem(META_KEY, JSON.stringify({ serverRevision: 42, statsSyncSince: 777 }));
    window.localStorage.setItem(PREFS_KEY, JSON.stringify({ selectedModel: 'legacy-model' }));

    usePrefsStore.getState().hydrate();
    const switched = usePrefsStore.getState().adoptAccount(USER_A);

    expect(switched).toBe(true);
    expect(usePrefsStore.getState().meta.serverRevision).toBe(0);
    expect(usePrefsStore.getState().meta.statsSyncSince).toBe(0);
    expect(usePrefsStore.getState().prefs.selectedModel).toBe('');
  });

  it('未登录 → 未登录：保留匿名命名空间数据', () => {
    const first = usePrefsStore.getState().adoptAccount(null);
    expect(first).toBe(false);
    expect(usePrefsStore.getState().meta.userId).toBeNull();
  });
});
