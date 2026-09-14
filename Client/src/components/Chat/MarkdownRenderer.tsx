/**
 * Markdown 渲染器——react-markdown + remark-gfm + shiki 代码高亮。
 * F2.3：未闭合代码块缓冲（防抖/防闪烁）。
 */
import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { createHighlighter, type Highlighter } from 'shiki';
import { useState, useEffect } from 'react';
import type { Components } from 'react-markdown';

// ── Shiki 高亮器单例（懒加载）──────────────────────────────────────

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['github-dark'],
      langs: ['typescript', 'javascript', 'python', 'rust', 'go', 'json', 'bash', 'sql', 'html', 'css', 'markdown', 'yaml', 'toml'],
    });
  }
  return highlighterPromise;
}

// ── 未闭合代码块检测 ────────────────────────────────────────────────

function hasUnclosedCodeBlock(content: string): boolean {
  const fenceCount = (content.match(/^```/gm) || []).length;
  return fenceCount % 2 !== 0;
}

// ── 代码块组件 ──────────────────────────────────────────────────────

function CodeBlock({ className, children }: { className?: string; children?: string }) {
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const code = String(children ?? '').replace(/\n$/, '');
  const lang = className?.replace('language-', '') ?? '';

  useEffect(() => {
    getHighlighter().then(hl => {
      try {
        const validLangs = hl.getLoadedLanguages();
        const useLang = validLangs.includes(lang as any) ? lang : 'text';
        const html = hl.codeToHtml(code, { theme: 'github-dark', lang: useLang });
        setHighlighted(html);
      } catch {
        setHighlighted(null);
      }
    }).catch(() => setHighlighted(null));
  }, [code, lang]);

  return (
    <div className="relative group my-2">
      {/* 语言标签 + 复制按钮 */}
      <div className="flex items-center justify-between px-3 py-1 bg-surface-700 rounded-t-lg text-[10px] text-text-muted font-mono">
        <span>{lang || 'text'}</span>
        <button
          onClick={() => navigator.clipboard.writeText(code)}
          className="opacity-0 group-hover:opacity-100 transition-opacity px-1.5 py-0.5 rounded hover:bg-surface-600 text-text-secondary hover:text-text-primary"
          title="复制代码"
        >
          复制
        </button>
      </div>
      {highlighted ? (
        <div
          className="shiki-container p-3 rounded-b-lg overflow-x-auto text-xs leading-relaxed"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      ) : (
        <pre className="p-3 rounded-b-lg bg-surface-800 overflow-x-auto text-xs leading-relaxed">
          <code className={className}>{code}</code>
        </pre>
      )}
    </div>
  );
}

// ── 主组件 ──────────────────────────────────────────────────────────

interface MarkdownRendererProps {
  content: string;
  isStreaming?: boolean;
}

export default function MarkdownRenderer({ content, isStreaming }: MarkdownRendererProps) {
  // 流式中如果代码块未闭合，暂不渲染最后一个代码块
  const displayContent = useMemo(() => {
    if (!isStreaming || !hasUnclosedCodeBlock(content)) return content;
    // 找到最后一个 ``` 的位置，之前的内容正常渲染
    const lastFence = content.lastIndexOf('```');
    if (lastFence <= 0) return content;
    return content.slice(0, lastFence);
  }, [content, isStreaming]);

  const components: Components = {
    code({ className, children, ...rest }) {
      const isBlock = className?.includes('language-');
      if (isBlock) {
        return <CodeBlock className={className}>{String(children)}</CodeBlock>;
      }
      return (
        <code className="px-1 py-0.5 rounded bg-surface-700 text-brand-300 text-xs font-mono" {...rest}>
          {children}
        </code>
      );
    },
  };

  return (
    <div className="markdown-body prose prose-invert max-w-none text-sm leading-relaxed text-text-primary">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {displayContent}
      </ReactMarkdown>
      {isStreaming && <span className="streaming-cursor" />}
    </div>
  );
}
