/**
 * 上下文历史装配测试。
 *
 * 产品决策：暂停/中断消息如何进入上下文
 * - 已产出部分回复的暂停轮次 → 保留
 * - 未产出任何内容就暂停 → 不写入上下文（不产生空助手轮次，悬空 user 一并剔除）
 * - 最后一条消息始终保留（它就是本轮要回答的请求）
 */
import { describe, it, expect } from 'vitest';
import { buildContextHistory } from '../../Src/Core/Model/contextHistory.js';
import type { ContextMessage } from '../../Src/Core/Model/contextHistory.js';

const user = (content: string): ContextMessage => ({ role: 'user', content });
const assistant = (content: string): ContextMessage => ({ role: 'assistant', content });
const system = (content: string): ContextMessage => ({ role: 'system', content });

describe('buildContextHistory', () => {
  it('正常多轮对话原样保留', () => {
    const rows = [user('Q1'), assistant('A1'), user('Q2'), assistant('A2'), user('Q3')];
    expect(buildContextHistory(rows)).toEqual(rows);
  });

  it('空白 assistant 不进入上下文，其对应的悬空 user 一并剔除', () => {
    const rows = [user('Q1'), assistant(''), user('Q2'), assistant('   '), user('Q3')];
    // Q1/Q2 的轮次都是"未产出内容就暂停"，整轮不写入上下文；Q3 是当前请求，保留
    expect(buildContextHistory(rows)).toEqual([user('Q3')]);
  });

  it('暂停但已产出部分回复 → 保留该助手消息', () => {
    const rows = [user('Q1'), assistant('这是被暂停前已经输出的部分内容'), user('Q2')];
    expect(buildContextHistory(rows)).toEqual(rows);
  });

  it('未回复就暂停的历史 user 消息被剔除（悬空 user）', () => {
    // 历史上有 3 条发了却始终没有得到回复的消息，最后一条是当前请求
    const rows = [user('停止1'), user('停止2'), user('停止3'), user('当前提问')];
    const out = buildContextHistory(rows);
    expect(out).toEqual([user('当前提问')]);
  });

  it('混悬空与正常轮次：只剔除悬空 user，保留已答复轮次', () => {
    const rows = [
      user('Q1'), assistant('A1'),
      user('停止且无回复'),
      user('Q2'), assistant('A2-部分'),
      user('当前提问'),
    ];
    expect(buildContextHistory(rows)).toEqual([
      user('Q1'), assistant('A1'),
      user('Q2'), assistant('A2-部分'),
      user('当前提问'),
    ]);
  });

  it('最后一条是 assistant（重新生成场景）时，悬空 user 仍被剔除', () => {
    const rows = [user('停止无回复'), user('Q1'), assistant('A1')];
    expect(buildContextHistory(rows)).toEqual([user('Q1'), assistant('A1')]);
  });

  it('system 消息始终保留', () => {
    const rows = [system('sys'), user('停止无回复'), user('Q1'), assistant('A1')];
    expect(buildContextHistory(rows)).toEqual([system('sys'), user('Q1'), assistant('A1')]);
  });

  it('空输入返回空数组', () => {
    expect(buildContextHistory([])).toEqual([]);
  });

  it('单条未回复的当前提问被保留', () => {
    expect(buildContextHistory([user('只有这一条')])).toEqual([user('只有这一条')]);
  });
});
