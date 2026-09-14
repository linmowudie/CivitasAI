/**
 * Commitlint 配置 —— 强制 Conventional Commits
 * 格式: <type>(<scope>): <subject>
 * type: feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert
 */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always', [
      'feat', 'fix', 'docs', 'style', 'refactor', 'perf',
      'test', 'build', 'ci', 'chore', 'revert', 'merge',
    ]],
    'scope-enum': [1, 'always', [
      'core', 'infra', 'services', 'tools', 'interface',
      'client', 'config', 'docs', 'ci', 'deps',
    ]],
    'subject-max-length': [2, 'always', 100],
    'body-max-line-length': [1, 'always', 200],
  },
};
