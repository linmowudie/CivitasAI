/**
 * @module Interface/RestApi/skillsApi
 * @description
 * Skills API——技能/Playbook/Rubric 只读视图。
 * 前端 FeatureView skills 子视图数据源。
 *
 * 读取 Skills/ 目录下的 .md 文件。
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';

import { json, apiError, registerRoute } from './router.js';

const SKILLS_DIR = join(process.cwd(), 'Skills');

/** 技能条目类型 */
export interface SkillEntry {
  id: string;
  category: 'playbooks' | 'rubrics' | 'rules' | 'strategies';
  name: string;
  path: string;
  size: number;
  /** 文件首行（作为摘要） */
  summary: string;
}

function listSkills(): SkillEntry[] {
  const entries: SkillEntry[] = [];
  const categories = ['playbooks', 'rubrics', 'rules', 'strategies'] as const;

  for (const cat of categories) {
    const catDir = join(SKILLS_DIR, cat);
    if (!existsSync(catDir)) continue;

    try {
      const files = readdirSync(catDir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const filePath = join(catDir, file);
        const stat = statSync(filePath);
        const content = readFileSync(filePath, 'utf-8');
        const firstLine = content.split('\n').find(l => l.trim().length > 0) ?? '';

        entries.push({
          id: `${cat}/${file.replace('.md', '')}`,
          category: cat,
          name: file.replace('.md', ''),
          path: `Skills/${cat}/${file}`,
          size: stat.size,
          summary: firstLine.replace(/^#+\s*/, '').slice(0, 100),
        });
      }
    } catch {
      // 目录读取失败，跳过
    }
  }

  return entries;
}

// ── 路由注册 ────────────────────────────────────────────────────────

export function registerSkillsRoutes(): void {
  registerRoute('GET', '/api/skills', async () => {
    const skills = listSkills();
    return json({ items: skills, total: skills.length });
  });

  registerRoute('GET', '/api/skills/:id', async (req) => {
    const id = req.params.id;
    if (!id) return apiError('id is required', 400);

    // id 格式: category/name (如 playbooks/quickStart)
    const [category, name] = id.split('/');
    if (!category || !name) return apiError('Invalid skill id format (expected category/name)', 400);

    const filePath = join(SKILLS_DIR, category, `${name}.md`);
    if (!existsSync(filePath)) return apiError('Skill not found', 404);

    try {
      const content = readFileSync(filePath, 'utf-8');
      return json({ id, category, name, path: `Skills/${category}/${name}.md`, content });
    } catch {
      return apiError('Failed to read skill', 500);
    }
  });
}
