/**
 * T4: ContextStore 追加式上下文测试。
 */
import { describe, it, expect } from 'vitest';
import { ContextStore, messageFingerprint } from '../../Src/Services/Context/contextStore';

describe('T4: ContextStore 追加式上下文', () => {
  it('同键同内容 → put 返回 false，keys() 顺序不变', () => {
    const store = new ContextStore();
    expect(store.put({ key: 'a', content: 'hello', timestamp: 1 })).toBe(true);
    expect(store.put({ key: 'a', content: 'hello', timestamp: 2 })).toBe(false);
    expect(store.keys()).toEqual(['a']);
  });

  it('同键同内容（trim 后相同）→ put 返回 false', () => {
    const store = new ContextStore();
    expect(store.put({ key: 'a', content: 'hello', timestamp: 1 })).toBe(true);
    expect(store.put({ key: 'a', content: '  hello  ', timestamp: 2 })).toBe(false);
  });

  it('同键不同内容 → 返回 true，位置不变（keys 顺序一致），内容已更新', () => {
    const store = new ContextStore();
    store.put({ key: 'a', content: 'first', timestamp: 1 });
    store.put({ key: 'b', content: 'second', timestamp: 2 });
    expect(store.keys()).toEqual(['a', 'b']);

    // 替换 'a' 的内容
    expect(store.put({ key: 'a', content: 'updated', timestamp: 3 })).toBe(true);
    // 顺序不变
    expect(store.keys()).toEqual(['a', 'b']);
    // 内容已更新
    expect(store.get('a')?.content).toBe('updated');
  });

  it('新键 → 追加到末尾', () => {
    const store = new ContextStore();
    store.put({ key: 'a', content: 'first', timestamp: 1 });
    store.put({ key: 'b', content: 'second', timestamp: 2 });
    store.put({ key: 'c', content: 'third', timestamp: 3 });
    expect(store.keys()).toEqual(['a', 'b', 'c']);
  });

  it('diffSince([...]) 正确返回新增与删除', () => {
    const store = new ContextStore();
    store.put({ key: 'a', content: 'first', timestamp: 1 });
    store.put({ key: 'b', content: 'second', timestamp: 2 });

    // 模拟已知键为 ['a', 'c']（b 是新增的，c 已被删除）
    const diff = store.diffSince(['a', 'c']);
    expect(diff.added.map(s => s.key)).toEqual(['b']);
    expect(diff.removedKeys).toEqual(['c']);
  });

  it('toAppendMessages() 的消息内容以 [ctx:<key>] 开头', () => {
    const store = new ContextStore();
    store.put({ key: 'file:main.ts', content: 'console.log("hi")', timestamp: 1 });
    store.put({ key: 'task:plan', content: 'Step 1: ...', timestamp: 2 });

    const msgs = store.toAppendMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toMatch(/^\[ctx:file:main\.ts\] /);
    expect(msgs[1].content).toMatch(/^\[ctx:task:plan\] /);
  });

  it('前缀稳定：模拟 5 轮，每轮 put 一个变化的键 → 最长公共前缀 / 较短者 ≥ 90%', () => {
    const store = new ContextStore();
    const serialized: string[] = [];

    for (let round = 0; round < 5; round++) {
      // 每轮新增一个变化的键
      store.put({
        key: `round-${round}`,
        content: `Content for round ${round} with some varying data ${Math.random()}`,
        timestamp: Date.now(),
      });
      // 序列化当前消息列表
      const msgs = store.toAppendMessages();
      serialized.push(msgs.map(m => m.content).join('\n'));
    }

    // 计算相邻轮次的最长公共前缀比例
    let totalRatio = 0;
    let comparisons = 0;
    for (let i = 1; i < serialized.length; i++) {
      const a = serialized[i - 1];
      const b = serialized[i];
      const minLen = Math.min(a.length, b.length);
      let commonLen = 0;
      for (let j = 0; j < minLen; j++) {
        if (a[j] === b[j]) commonLen++;
        else break;
      }
      totalRatio += commonLen / minLen;
      comparisons++;
    }

    const avgRatio = totalRatio / comparisons;
    // 由于追加式语义，前缀应保持稳定（≥90%）
    expect(avgRatio).toBeGreaterThanOrEqual(0.9);
  });

  it('remove 返回 true 且键被移除', () => {
    const store = new ContextStore();
    store.put({ key: 'a', content: 'hello', timestamp: 1 });
    expect(store.remove('a')).toBe(true);
    expect(store.get('a')).toBeUndefined();
    expect(store.keys()).toEqual([]);
  });

  it('clear 清空所有分区', () => {
    const store = new ContextStore();
    store.put({ key: 'a', content: 'hello', timestamp: 1 });
    store.put({ key: 'b', content: 'world', timestamp: 2 });
    store.clear();
    expect(store.size).toBe(0);
    expect(store.keys()).toEqual([]);
  });

  it('messageFingerprint 相同输入产生相同输出', () => {
    const fp1 = messageFingerprint('system', 'hello world');
    const fp2 = messageFingerprint('system', 'hello world');
    expect(fp1).toBe(fp2);
    expect(fp1).toHaveLength(16);
  });

  it('messageFingerprint 不同输入产生不同输出', () => {
    const fp1 = messageFingerprint('system', 'hello');
    const fp2 = messageFingerprint('system', 'world');
    expect(fp1).not.toBe(fp2);
  });
});
