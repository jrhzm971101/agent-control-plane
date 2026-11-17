/*
 * Markdown 渲染的单测。
 *
 * 这一层只有二十来行，但它是「不可信内容进 DOM」的唯一入口 —— 所以测试重点不在
 * 「排版好不好看」，而在三条安全契约：
 *   1. 模型 / 工具返回的原始 HTML 必须被转义（html:false），否则等于把 XSS 开在自己
 *      的控制台上；
 *   2. `javascript:` 这类协议必须被挡住（且要挡成「不成链」，而不是只把 href 掏空）；
 *   3. 流式长出来的半截文本不能抛异常 —— 抛了整条回答就白屏。
 * 排版类只留几个「配置确实生效」的证据，不去把 markdown-it 自己的实现细节测一遍。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

describe('renderMarkdown 安全契约', () => {
  it('原始 HTML 被转义，不产生脚本节点', () => {
    const html = renderMarkdown('<script>alert(1)</script>');

    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
  });

  /*
   * <img onerror> 是最常见的「不用 script 标签也能执行」的路子，
   * 单独钉一条用例，防止以后有人为了「让图片能显示」把 html 打开。
   */
  it('带事件属性的 HTML 同样被转义', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');

    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  /*
   * 断言「没有 href」而不是「没有 javascript: 字样」：markdown-it 挡掉非法链接后，
   * 原始文本会原样保留在正文里 —— 用户看到 [点我](javascript:alert(1)) 这串字是安全的，
   * 危险的是它变成可点的 <a>。所以这里要钉的是「没生成链接」。
   */
  it('javascript: 链接不生成 href', () => {
    const html = renderMarkdown('[点我](javascript:alert(1))');

    expect(html).not.toContain('href');
    expect(html).not.toContain('<a ');
  });

  it('外链带 target=_blank 且补 noopener noreferrer', () => {
    const html = renderMarkdown('[官网](https://example.com/a)');

    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

/*
 * 流式容错。
 *
 * 「半截文本」不是异常输入，而是打字机效果下的常态：token 是逐个到的，
 * 每一次重渲染都可能停在 ``` 之后、** 中间、表格分隔行的半路上。
 * 这几条用例的作用是把「markdown-it 对这种输入不抛异常」这个前提固化成契约 ——
 * 将来若换成别的渲染库，这组用例会第一时间报红。
 */
describe('renderMarkdown 流式容错', () => {
  it('未闭合的代码围栏不抛异常', () => {
    const html = renderMarkdown('```java\nint a = 1;');

    // 只断言「成了代码块」：带语言名时会被高亮接管，<pre> 上会多出 hljs 类
    expect(html).toContain('<pre');
    expect(html).toContain('int');
  });

  it('半截加粗标记不抛异常', () => {
    expect(renderMarkdown('**还没写完')).toContain('**还没写完');
  });

  it('半截表格行不抛异常', () => {
    expect(() => renderMarkdown('| a | b |\n| --- |')).not.toThrow();
  });

  it('空串渲染成空串，不产生多余节点', () => {
    expect(renderMarkdown('')).toBe('');
  });
});

describe('renderMarkdown 排版配置', () => {
  it('单换行被保留成换行（breaks:true）', () => {
    expect(renderMarkdown('第一行\n第二行')).toContain('<br>');
  });

  it('代码块渲染成 pre/code', () => {
    const html = renderMarkdown('```\ncode\n```');

    expect(html).toContain('<pre>');
    expect(html).toContain('<code>');
  });

  it('裸地址自动成链（linkify:true）', () => {
    expect(renderMarkdown('见 https://example.com/x')).toContain('href="https://example.com/x"');
  });
});

/*
 * 代码高亮。
 *
 * 这一组用例守的不是「颜色好不好看」，而是「拿不到语法时不能把正文搞坏」——
 * 高亮是可选的锦上添花，任何一条路径都不该让代码消失或被切碎。
 */
describe('renderMarkdown 代码高亮', () => {
  it('写了语言名的围栏产出高亮节点', () => {
    const html = renderMarkdown('```java\npublic class A { int x = 1; }\n```');

    expect(html).toContain('class="hljs language-java"');
    expect(html).toContain('hljs-keyword');
  });

  it('别名同样能高亮（yml → yaml）', () => {
    // highlight.js 注册 yaml 时自带 yml 别名，这条钉住「别名没被白名单挡在门外」
    expect(renderMarkdown('```yml\na: 1\n```')).toContain('class="hljs language-yml"');
  });

  it('没注册的语言退回纯文本，只保留 language 类', () => {
    const html = renderMarkdown('```cobol\nDISPLAY "X".\n```');

    // 走的是 markdown-it 的默认路径：内容照常渲染，只是没有色彩标记
    expect(html).toContain('language-cobol');
    expect(html).toContain('DISPLAY');
    expect(html).not.toContain('hljs-');
  });

  it('不写语言名不做高亮', () => {
    expect(renderMarkdown('```\n随便一段\n```')).toContain('<pre><code>');
  });

  it('代码里的 HTML 被转义，不产生真的标签', () => {
    const html = renderMarkdown('```xml\n<script>alert(1)</script>\n```');

    // 高亮会把 &lt;tag&gt; 再切成若干 span，所以不能断言 &lt;script&gt; 连在一起，
    // 只钉「没有真的 script 标签」这条安全契约
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;');
  });

  /*
   * 围栏后面那串字也是模型输出的一部分。它能出现在 class 属性里，
   * 所以必须钉住「塞不进额外属性」—— 上面 normalizeLang 的字符白名单就是为这条存在的。
   */
  it('语言名带引号也无法闭合 class 属性', () => {
    const html = renderMarkdown('```a" onmouseover="alert(1)\nx\n```');

    expect(html).not.toContain('onmouseover');
    expect(html).not.toContain('language-a"');
  });
});
