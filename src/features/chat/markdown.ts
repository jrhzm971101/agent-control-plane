/*
 * 回答正文的 Markdown 渲染。
 *
 * 为什么必须用一个库，而不是自己拿正则拼：agent 的输出是任意文本，里面会混着代码块、
 * 表格、嵌套列表 —— 手写解析器在「未闭合的代码块」「行内反引号里还有星号」这些地方
 * 一定会错，而错了不会抛异常，只会把回答渲染成一团乱码。
 *
 * 三个配置决定了安全边界与观感，逐个说明：
 *
 * - `html: false`：agent 输出里的原始 HTML 一律转义。这是最重要的一条 ——
 *   模型（以及它调用的工具）返回的内容属于不可信输入，直接塞进 v-html 等于把 XSS
 *   开在自己的控制台上。关掉之后 `<script>alert(1)</script>` 只会显示成一行字。
 * - `linkify: true`：裸地址变成可点链接。agent 答运维 / 工单类问题时经常直接甩 URL。
 * - `breaks: true`：单个换行也当换行。模型习惯「一行一条」地罗列而不空行，
 *   不开这个开关，整段会被合并进一个段落，看起来像把换行吞了。
 *
 * 另外 markdown-it 自带的 validateLink 会挡掉 `javascript:` / `vbscript:` / `file:` 这类协议
 * （`data:` 只放行图片），所以不需要再挂一个 sanitizer —— 少一个依赖，也少一处会对不上的地方。
 */
import MarkdownIt from 'markdown-it';
/*
 * 主题样式在这里引，而不是在 main.ts 里全局引：配色只服务于 Markdown 正文里的代码块，
 * 让它跟着渲染器一起进对话页那个懒加载分包，其他页面完全不用下载。
 */
import './highlight.css';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import properties from 'highlight.js/lib/languages/properties';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/*
 * 代码高亮的语言白名单。
 *
 * 为什么用 `lib/core` 逐个注册，而不是 `import hljs from 'highlight.js'` 整个引进来：
 * 完整包带 190 多种语法，解压后接近 1 MB，而本平台这几个 agent（k8s 巡检、报表、
 * git、工时统计）实际吐出来的就下面这些。逐个注册把这块压到几十 KB ——
 * 代价是「遇到没注册的语言不会高亮」，而那种情况下面的 highlight 选项会退化成纯文本，
 * 只是少点颜色，不会出错。
 *
 * key 是 highlight.js 里的语言名，注册后它自带的别名也一并生效
 * （json ← jsonc、yaml ← yml、bash ← sh/shell/zsh、javascript ← js/node、
 * typescript ← ts，所以 ```yml、```sh、```js 这些写法不用单独列）。
 */
const LANGUAGES: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  bash, diff, dockerfile, ini, java, javascript, json, markdown,
  plaintext, properties, python, sql, typescript, xml, yaml,
};
for (const [name, grammar] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, grammar);
}

/*
 * 语言名消毒。
 *
 * 围栏后面跟的那串字（```java 里的 java）是**模型输出的一部分**，属于不可信输入，
 * 而它会被拼进 <code class="language-xxx">。限制在这个字符集里，
 * 就堵掉了「靠语言名把属性引号闭合掉、再塞事件属性」那条路。
 * 名单外的语言返回 null，走 markdown-it 自己的默认渲染。
 */
function normalizeLang(lang: string): string | null {
  const name = lang.trim().toLowerCase();
  if (!/^[a-z0-9+#._-]{1,32}$/.test(name)) return null;
  return hljs.getLanguage(name) ? name : null;
}

/** 属性值转义：语言名虽已过白名单正则，这里仍按 HTML 规则再走一道，不依赖上游。 */
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  /*
   * 代码块高亮。
   *
   * 返回空串表示「这次不接管」—— markdown-it 里写的是 `highlight(...) || escapeHtml(...)`，
   * 所以空串会让它自己走默认路径（转义 + 包一层 <pre><code>）。三处刻意如此：
   *   - 没写语言名（裸 ```）：不知道该按哪套语法切词，硬猜会把代码切成花脸；
   *   - 语言名不在白名单：同上；
   *   - 高亮本身抛异常：highlight.js 对畸形输入理论上不抛，但真抛了也应该退化成
   *     纯文本而不是让整条回答白屏 —— 高亮只是锦上添花，不该有能力搞坏正文。
   * 反过来，一旦接管就必须返回**完整的** <pre> 开头片段（markdown-it 靠这个前缀判断），
   * 少写了它会再包一层，页面上就会出现嵌套的代码框。
   */
  highlight(code, lang) {
    const language = normalizeLang(lang);
    if (!language) return '';
    try {
      // ignoreIllegals：流式解析下代码块常常是半截的，遇到不合语法的片段
      // 应该继续往下切词，而不是整块放弃高亮
      const { value } = hljs.highlight(code, { language, ignoreIllegals: true });
      return `<pre class="hljs"><code class="hljs language-${escapeAttr(language)}">${value}</code></pre>`;
    } catch {
      return '';
    }
  },
});

/*
 * 外链新开窗口。
 *
 * markdown-it 只负责把 [x](url) 变成 <a>，不管窗口行为。这里渲染出来的全是外部地址，
 * 不带 rel=noopener 的话，目标页能通过 window.opener 反向操作本页。
 *
 * 包一层「原始规则」而不是整个重写：默认渲染路径下 rules.link_open 是 undefined，
 * 那时退化成 renderToken，行为与不包完全一致（不漏掉任何 markdown-it 自己的处理）。
 */
const defaultLinkOpen = md.renderer.rules.link_open
  ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

/**
 * Markdown → HTML 字符串。
 *
 * 入参是「流式长出来的半截文本」属于常态：可能停在 ``` 之后、停在 ** 中间、
 * 停在只有一半的表格行上。markdown-it 对这几种输入都不抛异常，会退化成普通文本渲染，
 * 所以边收边渲染不需要额外兜底 —— 这也是「打字机效果」下唯一可行做法：
 * 等文本齐了再渲染的话，用户在整个生成期间看到的都将是原文而非排版后的内容。
 */
export function renderMarkdown(text: string): string {
  return md.render(text);
}
