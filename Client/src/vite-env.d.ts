/// <reference types="vite/client" />

/**
 * CSS Module 类型声明——让 TypeScript 识别 `import styles from './X.module.css'`。
 * CSS Modules 的类名做严格类型化会降低开发效率，此处声明为宽松的 Record<string, string>。
 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}

declare module '*.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}