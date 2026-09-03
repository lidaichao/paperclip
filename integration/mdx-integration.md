# MDXEditor 内置界面汉化接入

核实版本：`@mdxeditor/editor` **4.2.1**。扫描本地已安装包 `dist/**/*.js` 中所有 `t(key, defaultValue, interpolations)`，共 **94 个独立键**，全部人工翻译到同目录 `mdx-messages.json`。每条保留上游键、英文、源文件和行号，便于升级差异审核。

接入位置：第一方 `ui/src/components/MarkdownEditor.tsx` 原始第 1432 行的 `<MDXEditor>`，通过官方 `translation` 属性接入；类型签名见依赖 `dist/index.d.ts:3085`。不要修改第三方包，也不要改 Markdown 正文、URL、代码块语言值或编辑器状态。

```ts
import type { Translation } from "@mdxeditor/editor";

// 由独立 mdx-messages.json 生成，不从 node_modules 运行时加载。
const messages = new Map(rows.map((row) => [row.key, row]));
const translateEditor: Translation = (key, defaultValue, interpolations = {}) => {
  const row = messages.get(key);
  // 英文变化时回退原文并交给升级审核，避免沿用过时含义。
  const template = locale === "zh-CN" && row?.english === defaultValue
    ? row.translation
    : defaultValue;
  // 回调替换只扫描一次，URL 或用户值中的 {{...}} 不会被二次展开。
  return template.replace(/\{\{([^{}]+)\}\}/g, (token, name) =>
    Object.prototype.hasOwnProperty.call(interpolations, name)
      ? String(interpolations[name])
      : token,
  );
};
// <MDXEditor translation={translateEditor} ... />
```

这里的 `rows`、`locale` 由主程序的词库构建和语言状态接入。回调随语言切换更新，保持编辑器现有 markdown 值与编辑状态。内置键区分大小写：`codeblock.delete` 与 `codeBlock.language` 的大小写不同，必须原样保留。

94 键覆盖编辑区无障碍标签、文字格式工具栏、标题/列表/引用、表格行列菜单、图片上传与尺寸、链接预览与编辑、代码块语言、文档头部元数据、提示框、撤销重做、源码与差异模式。命名占位符 `{{url}}`、`{{level}}`、`{{shortcut}}` 均保持不变，检查无遗漏。

升级时重扫依赖的翻译调用，对新增键、删除键和英文变更分别列出；保留本文件和词库。验收至少检查编辑框可访问性名称、图片/链接弹窗、撤销快捷键插值以及中英文切换。此交付只包含词库与接入说明，第三方文件没有修改。

