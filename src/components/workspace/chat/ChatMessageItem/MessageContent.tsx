import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkBreaks from 'remark-breaks';
import rehypeKatex from 'rehype-katex';
import Prism from 'prismjs';
// 🔥 不引入 prismjs/themes/prism.css：它和 CodeEditor 的 code-editor-theme.css 是两套全局主题，
// 优先级相同靠加载顺序取胜——顺序翻转时会用深棕色（如 .token.url #9a6e3a）覆盖编辑器的亮色主题。
// 全应用统一用 CodeEditor 引入的亮色自定义主题（chat 代码块背景为浅色，完全兼容）。
import 'katex/dist/katex.min.css'; // 🔥 导入 KaTeX 样式

// 🔥 覆盖 KaTeX 错误样式：渲染失败时显示为淡灰色背景而非刺眼红色
// 这样即使 remark-math 错误配对了定界符，也不会出现大片红色文字
const KATEX_ERROR_STYLE = `
.katex-error {
  color: inherit !important;
  background-color: rgba(156, 163, 175, 0.15) !important;
  border-left: 2px solid rgba(156, 163, 175, 0.4) !important;
  padding: 0 4px !important;
  font-size: 0.9em !important;
}
`;
import { ChevronDown, ChevronUp, Copy, Check, Loader2, FileText, FolderOpen, ExternalLink, Image as ImageIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MessageData } from './types';
import { PreviewViewer } from '@/components/workspace/DesktopModule/PreviewViewer';
import { TerminalOutputView, isTerminalOutput } from './TerminalOutputView';
import { ECSWebSocketManager } from '@/utils/workspace/ECSWebSocketManager';
import ImageViewer from '@/components/workspace/common/media/ImageViewer';
import type { FileAttachment } from '@/components/workspace/types/ChatTypes';

// 🔥 预处理 LaTeX 公式：统一转换为 remark-math 支持的格式
// 支持：\[ ... \] -> $$ ... $$（块级），\( ... \) -> $ ... $（行内）
const preprocessLatexFormulas = (text: string): string => {
  return text
    // 🔥 首先处理 \left$$ 和 \right$$ 的情况，避免被错误识别为公式分隔符
    // 将 \left$$ 替换为 \left\(，将 \right$$ 替换为 \right\)
    .replace(/\\left\$\$/g, '\\left\\(')
    .replace(/\\right\$\$/g, '\\right\\)')
    // 块级公式 \[ ... \] -> $$ ... $$
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, formula) => `$$${formula.trim()}$$`)
    // 行内公式 \( ... \) -> $ ... $
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, formula) => `$${formula.trim()}$`);
    // 🔥 移除了 [formula] -> $$..$$ 的转换，该规则太激进，容易误匹配普通 Markdown 链接
};

// 🔥 判断内容是否像块级数学公式（$$...$$ 内的内容）
const isLikelyBlockMath = (content: string): boolean => {
  const trimmed = content.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > 2000) return false;

  // 内容不应包含 $$（不允许嵌套块级公式）
  if (content.includes('$$')) return false;

  // CJK 字符比例过高，说明是混合文本而非纯公式
  const cjkCount = (content.match(/[\u4e00-\u9fa5]/g) || []).length;
  if (cjkCount > 3 && cjkCount / content.length > 0.1) return false;

  // 必须包含 LaTeX/数学特征
  if (/\\[a-zA-Z]/.test(trimmed)) return true;
  if (/[\\^_{}]/.test(trimmed)) return true;
  if (/[α-ωΑ-Ω]/.test(trimmed)) return true;

  return false;
};

// 🔥 修复孤立的 $$ 定界符
//
// 核心问题：LLM 输出中可能存在孤立的 $$（如公式开头 $$ 被截断丢失），
// remark-math 会把它和后面最近的 $$ 配对，导致中间大段文本被当成公式渲染。
//
// 解决方案：
// 1. 找到所有 $$ 的位置
// 2. 按顺序配对，验证每对 $$ 之间的内容是否像数学公式
// 3. 如果内容不像公式（CJK比例高、太长、无LaTeX特征），则不配对
// 4. 未配对的孤立 $$ 转义为 \$\$
//
// 重要：不处理 $ 行内公式，让 remark-math 自然处理
const fixOrphanedBlockMath = (text: string): string => {
  const placeholders: string[] = [];
  let phId = 0;

  const protect = (content: string): string => {
    placeholders.push(content);
    return `\x00PH${phId++}\x00`;
  };

  // Step 1: 保护代码块、行内代码、已转义的 \$
  let result = text.replace(/```[\s\S]*?```|`[^`]+`/g, protect);
  result = result.replace(/\\\$/g, protect);

  // Step 2: 找到所有 $$ 的位置
  const ddPositions: number[] = [];
  let si = 0;
  while ((si = result.indexOf('$$', si)) !== -1) {
    ddPositions.push(si);
    si += 2;
  }

  if (ddPositions.length === 0) {
    // 没有 $$，直接还原并返回
    result = result.replace(/\x00PH(\d+)\x00/g, (_, idx) => {
      return placeholders[parseInt(idx)];
    });
    return result;
  }

  // Step 3: 按顺序配对 $$ 并验证
  const paired = new Set<number>(); // 已配对的 $$ 索引（在 ddPositions 中的索引）
  let i = 0;
  while (i < ddPositions.length) {
    let foundPair = false;
    for (let j = i + 1; j < ddPositions.length; j++) {
      if (paired.has(j)) continue;
      const content = result.substring(ddPositions[i] + 2, ddPositions[j]);
      if (isLikelyBlockMath(content)) {
        paired.add(i);
        paired.add(j);
        i = j + 1;
        foundPair = true;
        break;
      }
    }
    if (!foundPair) {
      i++;
    }
  }

  // Step 4: 转义未配对的孤立 $$
  // 从后往前替换，避免位置偏移
  let output = result;
  for (let k = ddPositions.length - 1; k >= 0; k--) {
    if (!paired.has(k)) {
      const pos = ddPositions[k];
      output = output.substring(0, pos) + '\\$\\$' + output.substring(pos + 2);
    }
  }

  // Step 5: 还原被保护的内容
  output = output.replace(/\x00PH(\d+)\x00/g, (_, idx) => {
    return placeholders[parseInt(idx)];
  });

  return output;
};

// 🔥 修复行内单 $ 定界符的过度配对（LaTeX 识别过度的兜底层）
//
// remark-math 会把任意两个 $ 之间的内容当行内公式。LLM 输出中的单 $
// （shell 变量 $env:、$HOME，以及被 $..$ 包裹的代码常量如 $INJECT_OK$）
// 会与远处下一个 $ 配对，把中间整段文本吞进公式——KaTeX 逐字符渲染，
// 就是你看到的 I\nN\nJ\nE\nC\nT 竖排效果。
//
// 与 fixOrphanedBlockMath 同构的四步走：
// 1. 保护代码块/行内代码/块级公式 $$..$$/已转义 \$
// 2. 相邻配对单 $...$
// 3. 校验内容是否真像行内公式（isLikelyInlineMath）
// 4. 不像 → 该 $ 转义为 \$（remark-math 不再配对，原样显示）
const isLikelyInlineMath = (content: string): boolean => {
  const trimmed = content.trim();
  if (!trimmed || trimmed.length > 120) return false;
  if (/["']/.test(trimmed)) return false; // 引号 → 代码/文案
  // CJK 与全角标点 → 对话文本，公式不会夹中文说明
  if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]/.test(trimmed)) return false;
  // 代码风格常量排除：INJECT_OK / ARK_API_KEY / EXITCODE=0（全大写多字母 + 下划线/等号）
  if (/\b[A-Z][A-Z0-9]{1,}_[A-Z0-9_]+\b/.test(trimmed)) return false;
  if (/\b[A-Z]{3,}[A-Z0-9_]*\s*=[^=]/.test(trimmed)) return false;
  // snake_case 代码标识符（user_id、max_tokens）；单字母主体不受影响（x_t、y_1 是数学下标）
  if (/\b[a-z][a-z0-9]{1,}(?:_[a-z0-9]+)+\b/.test(trimmed)) return false;
  // 代码占位符风格：ARK_{API}_{KEY}（大写主体 ≥2 字母 + 花括号下标）；单字母主体（V_{t}）是数学
  if (/\b[A-Z][A-Z0-9]{1,}_{?[A-Za-z0-9]+\}/.test(trimmed)) return false;
  // 必须有数学特征才配对
  if (/\\[a-zA-Z]/.test(trimmed)) return true; // LaTeX 命令
  if (/[_^{}]/.test(trimmed)) return true; // 上下标 / 花括号结构
  if (/[\u0370-\u03ffΣ∑∫∏√±≈≠≤≥∈⊗⊙∇∂×⋅·÷]/.test(trimmed)) return true; // 希腊字母 / 数学符号
  // 单变量等式（E=mc^2、x=1、λ=0.9）；多字母大写等式已被上面排除
  if (/^[a-zA-Z](?:_[\w{}]+|\^\{?[\w{}]+})?\s*[=<>]\s*[-\w.]+$/.test(trimmed)) return true;
  if (/^\d+(\.\d+)?\s*[+\-*/]\s*\d+(\.\d+)?$/.test(trimmed)) return true; // 简单算式
  return false;
};

const fixOrphanedInlineMath = (text: string): string => {
  const placeholders: string[] = [];
  let phId = 0;
  const protect = (content: string): string => {
    placeholders.push(content);
    return `\x00IM${phId++}\x00`;
  };

  // 保护代码块、行内代码、块级公式 $$...$$、已转义的 \$
  let result = text
    .replace(/```[\s\S]*?```/g, protect)
    .replace(/`[^`]+`/g, protect)
    .replace(/\$\$[\s\S]*?\$\$/g, protect)
    .replace(/\\\$/g, protect);

  // 找所有单 $ 位置
  const positions: number[] = [];
  let si = 0;
  while ((si = result.indexOf('$', si)) !== -1) {
    positions.push(si);
    si += 1;
  }

  // 相邻配对 + 校验；通过则跳过一对，不通过则转义该 $（防止与远处配对吞文本）
  const escapeSet = new Set<number>();
  let i = 0;
  while (i < positions.length) {
    const j = i + 1;
    if (j >= positions.length) {
      escapeSet.add(i); // 落单的 $
      break;
    }
    const content = result.substring(positions[i] + 1, positions[j]);
    if (isLikelyInlineMath(content)) {
      i = j + 1;
    } else {
      escapeSet.add(i);
      i++;
    }
  }

  // 从后往前转义，避免位置偏移
  let output = result;
  for (let k = positions.length - 1; k >= 0; k--) {
    if (escapeSet.has(k)) {
      const pos = positions[k];
      output = output.substring(0, pos) + '\\$' + output.substring(pos + 1);
    }
  }

  // 还原被保护的内容
  output = output.replace(/\x00IM(\d+)\x00/g, (_, idx) => {
    return placeholders[parseInt(idx)];
  });

  return output;
};

// 🔥 自定义 URL 链接转换：在渲染前将裸 URL 转换为 markdown 链接语法
// 这样可以避免 remark-gfm 的 autolink 错误识别中文
const preprocessUrls = (text: string): string => {
  // 匹配 URL，遇到以下字符停止：
  // - 空白字符 \s
  // - CJK 标点 \u3000-\u303f
  // - 全角字符 \uff00-\uffef（包括全角括号、逗号等）
  // - 半角括号 ()（LLM 常在 URL 后加括号，如 `https://...csv)`）
  // - 反引号 `（Markdown 行内代码）
  // - 星号 *（Markdown 加粗/斜体定界符，**http://...** 场景 URL 会吞掉结尾 ** 变成链接的一部分）
  // - 其他括号 <>(){}【】「」『』〔〕〖〗〘〙〚〛
  // 注意：URL 路径中允许中文字符（如 OSS 文件名含中文），不排除 \u4e00-\u9fa5
  const urlRegex = /(https?:\/\/[^\s\u3000-\u303f\uff00-\uffef()`<>(){}\[\]【】「」『』〔〕〖〗〘〙〚〛*]+)/g;

  return text.replace(urlRegex, (match) => {
    // 清理 URL 结尾可能的标点符号（双保险；含 * 防加粗定界符粘连）
    const cleanUrl = match.replace(/[.,;:!?。，；：！？"'\s\)\(\`\]*]+$/, '');
    return `[${cleanUrl}](${cleanUrl})`;
  });
};

// 🔥 自动包裹裸公式：LLM 经常输出不带 $ 定界符的公式
// （如 "V_target = V_old + A^GAE"、"δ_t = r_t + γV(s_{t+1})"、"Σ_{l≥0}"），
// remark-math 无法识别，页面直接显示原始 _ ^ { } 记号。
//
// 策略：
//   1. 保护已有结构（代码块、行内代码、markdown 链接、已有 $..$/$$..$$、Windows 路径）
//   2. 按中日韩文字切分（公式不会跨越中文）
//   3. 词元级识别"数学 run"：含 _ ^ { } \ 希腊字母或数学符号的连续词元
//   4. 强信号校验（避免误包英文散文/标识符/版本号）
//   5. 包裹为 $...$ 并归一化（希腊字母→命令、Σ→\sum、−→-、多字母上下标加花括号）

const BARE_MATH_CJK_SPLIT = /([\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]+)/;
const BARE_MATH_TOKEN_CHARS = /[_^{}()\\=+\-−×⋅·<>≤≥≈≠Σ∑∫∏√±∈⊗⊙∇∂]/;
const BARE_MATH_GREEK = /[\u0370-\u03ff]/;
const BARE_MATH_SYMBOLS = /[Σ∑∫∏√±≈≠≤≥∈⊗⊙∇∂×⋅·]/;

// 包裹时的数学内容归一化：全部转为 ASCII LaTeX 命令，不依赖 KaTeX 的 unicode 支持
const normalizeMathContent = (s: string): string => {
  return s
    // 希腊字母 → 命令
    .replace(/α/g, '\\alpha ').replace(/β/g, '\\beta ').replace(/γ/g, '\\gamma ')
    .replace(/δ/g, '\\delta ').replace(/ε/g, '\\epsilon ').replace(/ζ/g, '\\zeta ')
    .replace(/η/g, '\\eta ').replace(/θ/g, '\\theta ').replace(/ι/g, '\\iota ')
    .replace(/κ/g, '\\kappa ').replace(/λ/g, '\\lambda ').replace(/μ/g, '\\mu ')
    .replace(/ν/g, '\\nu ').replace(/ξ/g, '\\xi ').replace(/π/g, '\\pi ')
    .replace(/ρ/g, '\\rho ').replace(/σ/g, '\\sigma ').replace(/τ/g, '\\tau ')
    .replace(/υ/g, '\\upsilon ').replace(/φ/g, '\\phi ').replace(/χ/g, '\\chi ')
    .replace(/ψ/g, '\\psi ').replace(/ω/g, '\\omega ')
    .replace(/Γ/g, '\\Gamma ').replace(/Δ/g, '\\Delta ').replace(/Θ/g, '\\Theta ')
    .replace(/Λ/g, '\\Lambda ').replace(/Ξ/g, '\\Xi ').replace(/Π/g, '\\Pi ')
    .replace(/Φ/g, '\\Phi ').replace(/Ψ/g, '\\Psi ').replace(/Ω/g, '\\Omega ')
    // 运算符/关系符
    .replace(/[Σ∑]/g, '\\sum ').replace(/∫/g, '\\int ').replace(/∏/g, '\\prod ')
    .replace(/−/g, '-').replace(/×/g, '\\times ').replace(/[⋅·]/g, '\\cdot ')
    .replace(/≥/g, '\\geq ').replace(/≤/g, '\\leq ').replace(/≈/g, '\\approx ')
    .replace(/≠/g, '\\neq ').replace(/±/g, '\\pm ').replace(/∞/g, '\\infty ')
    .replace(/√/g, '\\sqrt ').replace(/∈/g, '\\in ').replace(/∇/g, '\\nabla ')
    .replace(/∂/g, '\\partial ')
    // KaTeX 中需转义的特殊字符
    .replace(/%/g, '\\% ').replace(/#/g, '\\# ').replace(/&/g, '\\& ')
    // 多字母上下标加花括号：V_target → V_{target}，A^GAE → A^{GAE}
    .replace(/\^([A-Za-z]{2,})(?![A-Za-z])/g, '^{$1}')
    .replace(/_([A-Za-z]{2,})(?![A-Za-z])/g, '_{$1}');
};

const preprocessBareMath = (text: string): string => {
  const placeholders: string[] = [];
  let phId = 0;
  const protect = (content: string): string => {
    placeholders.push(content);
    return `\x00BM${phId++}\x00`;
  };

  // 1. 保护：代码块、行内代码、markdown 链接、已有数学定界符、Windows 路径
  let result = text
    .replace(/```[\s\S]*?```/g, protect)
    .replace(/`[^`]+`/g, protect)
    .replace(/\[[^\]]*\]\([^)]*\)/g, protect)
    .replace(/\$\$[\s\S]*?\$\$/g, protect)
    .replace(/\$[^$\n]+\$/g, protect)
    .replace(/[A-Za-z]:[\\/][^\s"']*/g, protect);

  // 词元是否属于数学 run
  const isMathToken = (tok: string): boolean => {
    if (tok.includes('\x00')) return false; // 占位符作为边界
    const core = tok.replace(/^[.,;:!?]+|[.,;:!?]+$/g, '');
    if (!core) return false;
    if (/^[\d.]+$/.test(core)) return true; // 纯数字可并入 run（等式右值）
    if (/^(?=.*\d)(?=.*[a-zA-Z])[a-zA-Z\d.]+$/.test(core)) return true; // 数字+字母混合（2x、V2）
    return BARE_MATH_TOKEN_CHARS.test(core) || BARE_MATH_GREEK.test(core);
  };

  // run 的强信号（避免误包散文/标识符/版本号）
  const hasStrongSignal = (run: string): boolean => {
    const r = run.trim();
    if (/[_^]\{|\\[a-zA-Z]/.test(r)) return true; // 花括号上下标 / LaTeX 命令
    if (BARE_MATH_GREEK.test(r) && /[=<>≥≤≈]/.test(r)) return true; // 希腊字母+关系符（λ=1）
    if (BARE_MATH_SYMBOLS.test(r)) return true; // 数学符号（Σ ≥ ≈ ×）
    if (/[\w)][_^][\w(]/.test(r)) {
      if (/[=+\-−/]/.test(r)) return true; // 带运算符的等式（V_target = V_old）
      if (r.length <= 6) return true; // 短上下标（x^2、e^x）
    }
    return false;
  };

  // 明确不该包裹的 run
  const isBadRun = (run: string): boolean => {
    if (/["']/.test(run)) return true; // 字符串字面量（代码）
    if (/:\/\//.test(run) || /[A-Za-z]:[\\/]/.test(run)) return true; // URL / 路径
    if (run.includes('$')) return true; // 残留 $ 定界符（交给 remark-math）
    if (run.length > 300) return true;
    // 🔥 代码风格排除（与 isLikelyInlineMath 同款）：全大写下划线常量（INJECT_OK、ARK_API_KEY）、
    // snake_case（credential_name）、大写等号常量（EXITCODE=0）——是代码输出/占位符，不是数学
    if (/\b[A-Z][A-Z0-9]{1,}_[A-Z0-9_]+\b/.test(run)) return true;
    if (/\b[a-z][a-z0-9]{1,}(?:_[a-z0-9]+)+\b/.test(run)) return true;
    if (/\b[A-Z]{3,}[A-Z0-9_]*\s*=[^=]/.test(run)) return true;
    return false;
  };

  // 2. 按中日韩切分，只处理非 CJK 段
  const parts = result.split(BARE_MATH_CJK_SPLIT);

  const processedParts = parts.map((part) => {
    if (!part.trim() || /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]/.test(part)) {
      return part;
    }

    // 3. 词元扫描（保留原始位置，包裹时用原文切片）
    const tokens: Array<{ text: string; start: number; end: number }> = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(part)) !== null) {
      tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    }

    let out = '';
    let cursor = 0;
    let i = 0;
    while (i < tokens.length) {
      if (!isMathToken(tokens[i].text)) { i++; continue; }
      let j = i;
      while (j + 1 < tokens.length && isMathToken(tokens[j + 1].text)) j++;
      const runText = part.substring(tokens[i].start, tokens[j].end);

      if (hasStrongSignal(runText) && !isBadRun(runText)) {
        // 去除首尾空白与悬空运算符（remark-math 要求 $ 紧贴内容）
        const trimmed = runText
          .replace(/^[\s=+\-−/×⋅·]+/, '')
          .replace(/[\s=+\-−/×⋅·,;:.]+$/, '')
          .trim();
        if (trimmed && !/["']/.test(trimmed)) {
          out += part.substring(cursor, tokens[i].start);
          out += `$${normalizeMathContent(trimmed)}$`;
          cursor = tokens[j].end;
        }
      }
      i = j + 1;
    }
    out += part.substring(cursor);
    return out;
  });

  result = processedParts.join('');

  // 4. 还原被保护的内容
  result = result.replace(/\x00BM(\d+)\x00/g, (_, idx) => placeholders[parseInt(idx)]);

  return result;
};

// 🔥 句中短公式降级：$$...$$ 嵌在句子中间（同一行 $$ 前有文字）且内容短无换行时，
// 降级为行内 $...$，避免块级数学渲染（KaTeX display 强制独立居中成块）打断句子流。
// 独立成行的 display 公式（前后是行首/空行）不受影响。
const downgradeInlineDisplayMath = (text: string): string => {
  const placeholders: string[] = [];
  let phId = 0;
  const protect = (content: string): string => {
    placeholders.push(content);
    return `\x00DM${phId++}\x00`;
  };

  // 保护代码块、行内代码
  let result = text
    .replace(/```[\s\S]*?```/g, protect)
    .replace(/`[^`]+`/g, protect);

  // $$ 前紧跟非空白字符（句中嵌入）+ 内容短且无换行 + 有数学特征 → $...$
  result = result.replace(/(\S)\$\$([^$\n]{1,80})\$\$/g, (match, before: string, inner: string) => {
    if (!/\\[a-zA-Z]|[≈≠≤≥×÷±∑∫√^_{}]|[α-ωΑ-Ω]/.test(inner)) return match;
    return `${before}$${inner}$`;
  });

  result = result.replace(/\x00DM(\d+)\x00/g, (_, idx) => placeholders[parseInt(idx)]);
  return result;
};

// 🔥 统一的消息文本预处理管道（content 和 result 共用，保证行为一致）
const preprocessMessageText = (text: string): string => {
  return preprocessNumericRanges(
    fixOrphanedInlineMath(
      fixOrphanedBlockMath(
        downgradeInlineDisplayMath(
          preprocessBareMath(
            preprocessLatexFormulas(
              preprocessMarkdownTables(
                preprocessUrls(text)
              )
            )
          )
        )
      )
    )
  );
};

// 🔥 预处理数值范围中的波浪号：防止 remark-gfm 将 ~ 误解析为删除线 ~~
//
// 核心问题：LLM 输出中的数值范围（如 "-50~50"、"0.02~0.025"）使用 ~ 作为范围分隔符，
// 当相邻的 ~ 被 remark-gfm 配对成 ~~ 时，中间大段文字会被错误渲染为删除线。
// 例如："输出范围 -50~50，huberdelta 提高到 20...改成 -50~50" 中，
// remark-gfm 看到 ~50~...~50~ 配对为 ~~50...50~~，导致整段文字被划线。
//
// 解决方案：在预处理阶段将数值范围中的 ~ 转义为 \~，阻止 remark-gfm 配对。
// 匹配模式：数字(含负号、小数点) + ~ + 数字(含负号、小数点)
const preprocessNumericRanges = (text: string): string => {
  // 保护代码块和行内代码
  const placeholders: string[] = [];
  let phId = 0;
  const protect = (content: string): string => {
    placeholders.push(content);
    return `\x00NR${phId++}\x00`;
  };

  let result = text.replace(/```[\s\S]*?```|`[^`]+`/g, protect);

  // 匹配数值范围中的 ~：前面是数字/小数点/负号，后面是数字/负号
  // 例如：-50~50 → -50\~50, 0.02~0.025 → 0.02\~0.025
  result = result.replace(/([\d.\-])~(-?[\d.])/g, '$1\\~$2');

  // 还原被保护的内容
  result = result.replace(/\x00NR(\d+)\x00/g, (_, idx) => {
    return placeholders[parseInt(idx)];
  });

  return result;
};

// 🔥 预处理表格：修复 LLM 输出的表格格式问题
//
// 常见问题：
// 1. 所有的行都在同一行上，缺少换行符
//    如：| a | b | |---|---| | c | d |
// 2. 数据行合并在同一行上（| | 作为行间分隔）
//    如：|---|---|\n| c | d | | e | f |
// 3. data 行不以 | 开头
//    如：0.01 | 0.905 | 0.135 | | 0.05 | ...
// 4. 表格紧跟段落文字，缺少空行（remark-gfm 要求表格前后有空行）
//
// 策略：找到 separator 行 → 确定列数 → 把 header+data 按 | 拆成 cell → 按列数重组
// 1. 行级拆分：把 separator 前后合并的其他内容拆到独立行
// 2. cell 重组：不依赖 startsWith('|')、不依赖列数整除，自动补 | 和空 cell
// 3. 空行边界：header 前 + data 后自动加空行（remark-gfm 要求）
const preprocessMarkdownTables = (text: string): string => {
  // 快速检测：必须包含 | 且有 separator 行（---）
  if (!text.includes('|') || !text.includes('---')) return text;

  const lines = text.split('\n');

  // 拆分 separator 行中合并的其他内容（separator 前后可能有 header/data 挤在同一行）
  // 关键：[-:\s]+ 不含 |，避免正则回溯只匹配到 |---| 而非整个 |---|---|
  const sepPattern = /(\|[-:\s]+\|[-:\s|]*\|)/;
  for (let j = 0; j < lines.length; j++) {
    const m = lines[j].match(sepPattern);
    if (!m) continue;
    const sep = m[1];
    const sepStart = lines[j].indexOf(sep);
    const before = lines[j].substring(0, sepStart).trim();
    const after = lines[j].substring(sepStart + sep.length).trim();
    const parts: string[] = [];
    if (before) parts.push(before);
    parts.push(sep);
    if (after) parts.push(after);
    if (parts.length > 1) {
      lines.splice(j, 1, ...parts);
      j += parts.length - 1;
    }
  }

  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    // 检测 separator 行：只含 |,-,:,空格，且包含 ---
    if (!/^[\s|:\-]+$/.test(trimmed) || !trimmed.includes('---') || !trimmed.includes('|')) {
      i++;
      continue;
    }

    // 确定列数
    const cols = trimmed.split('|').map(s => s.trim()).filter(s => s).length;
    if (cols < 1) { i++; continue; }

    // header 行（紧邻 separator 上一行，且包含 |）
    const headerIdx = i - 1;
    if (headerIdx < 0 || !lines[headerIdx].includes('|')) { i++; continue; }

    // data 行（separator 后连续包含 | 的非空行）
    let endIdx = i + 1;
    while (endIdx < lines.length && lines[endIdx].includes('|') && lines[endIdx].trim()) endIdx++;
    if (endIdx === i + 1) { i++; continue; }

    // 规范化每行：确保以 | 开头和结尾（修复 data 行不以 | 开头的情况）
    const normalize = (line: string): string => {
      let t = line.trim();
      if (!t) return '';
      if (!t.startsWith('|')) t = '| ' + t;
      if (!t.endsWith('|')) t = t + ' |';
      return t;
    };

    const headerFixed = normalize(lines[headerIdx]);
    const dataFixed = lines.slice(i + 1, endIdx).map(normalize).filter(l => l);

    // 拼接所有行，按 | 拆分成 cells
    const allBlock = [headerFixed, ...dataFixed].join(' ');
    const rawCells = allBlock.split('|').map(c => c.trim());
    while (rawCells.length && rawCells[0] === '') rawCells.shift();
    while (rawCells.length && rawCells[rawCells.length - 1] === '') rawCells.pop();

    // 按 cols 分行，跳过行间空 cell（| | 合并行产生的空分隔）
    const rows: string[][] = [];
    let current: string[] = [];
    for (const cell of rawCells) {
      if (current.length === cols) {
        rows.push(current);
        current = [];
      }
      if (cell === '' && current.length === 0) continue;
      current.push(cell);
    }
    if (current.length === cols) {
      rows.push(current);
    } else if (current.length > 0) {
      while (current.length < cols) current.push('');
      rows.push(current);
    }

    if (rows.length < 2) { i++; continue; }

    // 重建表格：空行 + header + separator + data + 空行
    const separator = '|' + Array(cols).fill('---').join('|') + '|';
    const tableLines = [
      '',
      '| ' + rows[0].join(' | ') + ' |',
      separator,
      ...rows.slice(1).map(r => '| ' + r.join(' | ') + ' |'),
      ''
    ];

    lines.splice(headerIdx, endIdx - headerIdx, ...tableLines);
    i = headerIdx + tableLines.length;
  }

  return lines.join('\n');
};

// 🔥 检测本地路径（白名单制）
// 策略：只匹配确定是用户本地路径的模式，不匹配云端执行环境路径
// 匹配的三种模式：
//   1. Windows 绝对路径：C:\Users\file.txt 或 D:/path/to/file
//   2. Unix home 路径：~/Documents/file
//   3. macOS 绝对路径：/Users/username/file
// 不匹配的路径（云端环境路径）：/tmp/ /var/ /home/ /app/ /volume/ /root/ 等
const extractLocalPaths = (text: string): string[] => {
  const paths: string[] = [];

  // 移除多行代码块；行内代码只剥离反引号、保留内容参与识别
  // （LLM 常用反引号包裹路径做代码样式，整段删除会导致路径无法识别）
  const textWithoutCodeBlocks = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1');

  // 移除 URL
  const urlRegex = /https?:\/\/[^\s]+/g;
  const textWithoutUrls = textWithoutCodeBlocks.replace(urlRegex, '');

  // 常见文件扩展名（用于验证路径是否以有效文件结尾）
  const fileExtPattern = /\.[a-zA-Z]{1,8}$/;

  // 已知的可识别目录名（路径最后一段）
  const knownDirNames = /^(output|files|docs|data|temp|tmp|downloads|desktop|documents|webapp|project|workspace)$/i;

  const addPath = (raw: string) => {
    let path = raw.trim();

    // 清理开头
    path = path.replace(/^\/+/, '');
    // 清理结尾标点（但保留扩展名中的点）
    path = path.replace(/[.,;:!?"'。，；：！？"'\s\)]+$/, '');

    if (path.length <= 1) return;

    // 排除中文紧跟路径的情况：如果路径以中文结尾，说明路径嵌入在中文语境中
    if (/[\u4e00-\u9fa5]$/.test(path)) return;
    // 路径中间有中文目录名时排除（允许中文文件名，但不允许中文目录名）
    if (/[\/\\][\u4e00-\u9fa5]+[\/\\]/.test(path)) return;

    // 路径最后一段
    const lastSegment = path.split(/[\/\\]/).pop() || '';

    // 必须有文件扩展名，或者是已知目录名
    const hasExtension = fileExtPattern.test(lastSegment);
    const isKnownDir = knownDirNames.test(lastSegment);
    const isWindowsAbsolute = /^[a-zA-Z]:[\/\\]/.test(path);
    const isUnixHome = /^~\//.test(path);
    const isMacAbsolute = /^Users\//.test(path); // 去掉前导 / 后的 /Users/...

    // 相对路径（非 Windows、非 home、非 macOS 绝对）：必须有扩展名
    if (!isWindowsAbsolute && !isUnixHome && !isMacAbsolute) {
      if (!hasExtension) return;
    }

    // Windows 绝对路径或 macOS 绝对路径或 home 路径，即使没有扩展名也允许
    if (!hasExtension && !isKnownDir && !isWindowsAbsolute && !isUnixHome && !isMacAbsolute) return;

    if (!paths.includes(path)) {
      paths.push(path);
    }
  };

  // 1. Windows 绝对路径: C:\Users\file.txt 或 D:/path/to/file
  const windowsRegex = /[a-zA-Z]:[\\\/][\w\-.\/\\\u4e00-\u9fa5]+/g;
  const windowsMatches = textWithoutUrls.match(windowsRegex) || [];
  windowsMatches.forEach(addPath);

  // 2. Unix home 路径: ~/Documents/file
  const homeRegex = /~\/[\w\-.\/\u4e00-\u9fa5]+/g;
  const homeMatches = textWithoutUrls.match(homeRegex) || [];
  homeMatches.forEach(addPath);

  // 3. macOS 绝对路径: /Users/username/file（白名单制，只匹配 /Users/ 开头）
  // 不匹配 /tmp/ /var/ /home/ /app/ 等云端环境路径
  const macRegex = /(?:^|[\s\r\n])(\/Users\/[\w\-.\/\u4e00-\u9fa5]+)/gm;
  let m;
  while ((m = macRegex.exec(textWithoutUrls)) !== null) {
    addPath(m[1]);
  }

  return paths;
};

// 🔥 点击本地路径打开文件
const EDITABLE_EXTENSIONS = ['.py', '.js', '.ts', '.jsx', '.tsx', '.md', '.json', '.txt', '.yaml', '.yml', '.xml', '.html', '.css', '.scss', '.sql', '.sh', '.bat', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.rb', '.php'];

const isEditableFile = (path: string): boolean => {
  const ext = '.' + path.split('.').pop()?.toLowerCase();
  return EDITABLE_EXTENSIONS.includes(ext);
};

const isHtmlFile = (path: string): boolean => {
  return path.toLowerCase().endsWith('.html');
};

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.tiff', '.tif'];

const isImageFile = (path: string): boolean => {
  const ext = '.' + path.split('.').pop()?.toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext);
};

const handleOpenHtmlInBrowser = async (localPath: string) => {
  const electron = (window as any).electron;
  // 🔥 使用 openPath 打开本地文件，而不是 openExternal
  // openExternal 用于打开 URL（网页链接），不适合打开本地文件
  if (electron?.openPath) {
    try {
      const result = await electron.openPath(localPath);
      if (!result?.success) {
        console.error('打开文件失败:', result?.error);
      }
    } catch (error) {
      console.error('调用 openPath 失败:', error);
    }
  } else {
    console.warn('Electron openPath API 不可用');
  }
};

const handleLocalPathClick = async (localPath: string) => {
  const electron = (window as any).electron;
  if (electron?.showItemInFolder) {
    try {
      const result = await electron.showItemInFolder(localPath);
      if (!result?.success) {
        console.error('打开文件夹失败:', result?.error);
      }
    } catch (error) {
      console.error('调用 showItemInFolder 失败:', error);
    }
  } else if (electron?.openPath) {
    try {
      await electron.openPath(localPath);
    } catch (error) {
      console.error('调用 openPath 失败:', error);
    }
  } else {
    console.warn('Electron shell API 不可用');
  }
};

const handleOpenInDesktop = (localPath: string) => {
  if (isEditableFile(localPath)) {
    // 🔥 通过 window 事件通知 DesktopPanel 打开文件（替代已删除的 codeEditEventService）
    window.dispatchEvent(new CustomEvent('openProjectFile', {
      detail: { filePath: localPath }
    }));
  } else {
    handleLocalPathClick(localPath);
  }
};

// 🔥 本地路径链接组件 - 简洁行内样式
const LocalPathLinks: React.FC<{ text: string }> = ({ text }) => {
  const { t } = useTranslation();
  const localPaths = extractLocalPaths(text);
  const [previewImage, setPreviewImage] = useState<FileAttachment | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  const handleCopyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      setCopiedPath(path);
      setTimeout(() => setCopiedPath(null), 2000);
    } catch (error) {
      console.error('复制路径失败:', error);
    }
  };

  if (localPaths.length === 0) return null;

  return (
    <>
      <div className="flex flex-wrap gap-2 mt-1.5">
        {localPaths.map((path, index) => (
          <div key={`localpath-${index}`} className="flex items-center gap-1">
            <button
              onClick={() => handleLocalPathClick(path)}
              className="inline-flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 cursor-pointer hover:underline bg-blue-50 dark:bg-blue-900/20 px-2 py-1 rounded-md border border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors"
              title={t('workspace.messageContent.openInFolder', { path })}
            >
              <FolderOpen className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="font-mono truncate max-w-[250px]">{path}</span>
            </button>
            {isImageFile(path) && (
              <button
                onClick={() => {
                  const fileName = path.split(/[\\/]/).pop() || 'image';
                  setPreviewImage({
                    id: `local-${Date.now()}`,
                    name: fileName,
                    content: '',
                    type: 'image/' + (path.split('.').pop() || 'png').toLowerCase(),
                    localPath: path,
                  } as any);
                }}
                className="inline-flex items-center gap-1.5 text-xs text-orange-600 hover:text-orange-800 dark:text-orange-400 dark:hover:text-orange-300 cursor-pointer hover:underline bg-orange-50 dark:bg-orange-900/20 px-2 py-1 rounded-md border border-orange-200 dark:border-orange-800 hover:bg-orange-100 dark:hover:bg-orange-900/30 transition-colors"
                title={t('workspace.messageContent.previewImage', { path })}
              >
                <ImageIcon className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="text-xs">{t('workspace.messageContent.preview')}</span>
              </button>
            )}
            {isHtmlFile(path) && (
              <button
                onClick={() => handleOpenHtmlInBrowser(path)}
                className="inline-flex items-center gap-1.5 text-xs text-purple-600 hover:text-purple-800 dark:text-purple-400 dark:hover:text-purple-300 cursor-pointer hover:underline bg-purple-50 dark:bg-purple-900/20 px-2 py-1 rounded-md border border-purple-200 dark:border-purple-800 hover:bg-purple-100 dark:hover:bg-purple-900/30 transition-colors"
                title={t('workspace.messageContent.openInBrowser', { path })}
              >
                <ExternalLink className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="text-xs">{t('workspace.messageContent.browser')}</span>
              </button>
            )}
            {isEditableFile(path) && !isImageFile(path) && (
              <button
                onClick={() => handleOpenInDesktop(path)}
                className="inline-flex items-center gap-1.5 text-xs text-green-600 hover:text-green-800 dark:text-green-400 dark:hover:text-green-300 cursor-pointer hover:underline bg-green-50 dark:bg-green-900/20 px-2 py-1 rounded-md border border-green-200 dark:border-green-800 hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors"
                title={t('workspace.messageContent.openInDesktop', { path })}
              >
                <FileText className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="text-xs">{t('workspace.messageContent.open')}</span>
              </button>
            )}
            <button
              onClick={() => handleCopyPath(path)}
              className="inline-flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-300 cursor-pointer hover:underline bg-gray-50 dark:bg-gray-900/20 px-2 py-1 rounded-md border border-gray-200 dark:border-gray-800 hover:bg-gray-100 dark:hover:bg-gray-900/30 transition-colors"
              title={t('workspace.messageContent.copyPath', { path })}
            >
              {copiedPath === path ? (
                <Check className="w-3.5 h-3.5 flex-shrink-0 text-green-600" />
              ) : (
                <Copy className="w-3.5 h-3.5 flex-shrink-0" />
              )}
            </button>
          </div>
        ))}
      </div>
      {previewImage && (
        <ImageViewer
          file={previewImage}
          isOpen={!!previewImage}
          onClose={() => setPreviewImage(null)}
        />
      )}
    </>
  );
};

interface MessageContentProps {
  message: MessageData;
  icon?: React.ReactNode;
}

/**
 * 🔥 Diff 内容渲染组件
 * 按行渲染 diff：- 行红色背景，+ 行绿色背景，其他行正常显示
 */
const DiffContent: React.FC<{ content: string }> = ({ content }) => {
  const lines = content.split('\n');
  return (
    <code className="text-xs font-mono block">
      {lines.map((line, idx) => {
        const isDeleted = line.startsWith('-');
        const isInserted = line.startsWith('+');
        const prefix = isDeleted ? '-' : isInserted ? '+' : ' ';
        const text = isDeleted || isInserted ? line.substring(1) : line;
        return (
          <div
            key={idx}
            className={
              isDeleted
                ? 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300'
                : isInserted
                ? 'bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-300'
                : 'text-gray-800 dark:text-gray-200'
            }
          >
            <span className="select-none inline-block w-4 text-gray-400">{prefix}</span>
            <span>{text || ' '}</span>
          </div>
        );
      })}
    </code>
  );
};

/**
 * 可折叠代码块组件
 */
const CollapsibleCodeBlock: React.FC<{ content: string; language?: string; className?: string }> = ({
  content,
  language = 'plaintext',
  className,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  const lines = content.split('\n');
  const totalLines = lines.length;
  const shouldCollapse = totalLines > 10;
  const displayContent = isExpanded || !shouldCollapse
    ? content
    : lines.slice(0, 10).join('\n') + '\n...';

  // 🔥 diff 模式下统计增删行数（与 DiffContent 渲染逻辑保持一致：+ 开头为新增，- 开头为删除）
  const diffStats = language === 'diff' ? {
    added: lines.filter(l => l.startsWith('+')).length,
    deleted: lines.filter(l => l.startsWith('-')).length,
  } : null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const getLanguageLabel = (lang: string): string => {
    const labels: Record<string, string> = {
      javascript: 'JavaScript',
      typescript: 'TypeScript',
      python: 'Python',
      java: 'Java',
      cpp: 'C++',
      c: 'C',
      csharp: 'C#',
      go: 'Go',
      rust: 'Rust',
      ruby: 'Ruby',
      php: 'PHP',
      swift: 'Swift',
      kotlin: 'Kotlin',
      sql: 'SQL',
      html: 'HTML',
      css: 'CSS',
      json: 'JSON',
      yaml: 'YAML',
      markdown: 'Markdown',
      bash: 'Bash',
      shell: 'Shell',
      plaintext: 'Text',
    };
    return labels[lang] || lang.toUpperCase();
  };

  const highlightCode = (code: string, lang: string): string => {
    if (!Prism.languages[lang]) {
      try {
        require(`prismjs/components/prism-${lang}`);
      } catch {
        // 语言不支持，使用 plaintext
      }
    }
    
    const grammar = Prism.languages[lang] || Prism.languages.plaintext;
    return Prism.highlight(code, grammar, lang);
  };

  return (
    <div className={cn('relative group rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700', className)}>
      {/* 代码块头部 */}
      <div className="flex items-center justify-between px-3 py-2 bg-gray-100 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          <span className="font-mono">{getLanguageLabel(language)}</span>
          <span className="text-gray-300 dark:text-gray-600">|</span>
          {diffStats ? (
            <>
              <span className="text-green-600 dark:text-green-400 font-medium">+{diffStats.added} 行</span>
              <span className="text-gray-300 dark:text-gray-600">|</span>
              <span className="text-red-600 dark:text-red-400 font-medium">-{diffStats.deleted} 行</span>
            </>
          ) : (
            <span>{totalLines} 行</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {shouldCollapse && (
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="flex items-center gap-1 px-2 py-1 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
            >
              {isExpanded ? (
                <>
                  <ChevronUp className="w-3 h-3" />
                  收起
                </>
              ) : (
                <>
                  <ChevronDown className="w-3 h-3" />
                  展开
                </>
              )}
            </button>
          )}
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-1 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
          >
            {isCopied ? (
              <>
                <Check className="w-3 h-3" />
                已复制
              </>
            ) : (
              <>
                <Copy className="w-3 h-3" />
                复制
              </>
            )}
          </button>
        </div>
      </div>

      {/* 代码内容 */}
      <pre className="p-3 overflow-x-auto m-0 bg-gray-50 dark:bg-gray-100 rounded-b-lg">
        {language === 'diff' ? (
          <DiffContent content={displayContent} />
        ) : (
          <code
            className="text-xs font-mono text-gray-800"
            dangerouslySetInnerHTML={{ __html: highlightCode(displayContent, language) }}
          />
        )}
      </pre>
    </div>
  );
};

/**
 * Markdown 渲染配置 - 参考 AutoPlanMessage 样式
 */
const markdownComponents: Components = {
  // 🔥 代码块渲染（rehype-katex 会自动处理数学公式，无需手动处理）
  code({ className, children, ...props }) {
    // 普通代码块处理
    const match = /language-(\w+)/.exec(className || '');
    const isInline = !match && !className;
    const language = match ? match[1] : 'plaintext';

    if (isInline) {
      return (
        <code
          className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 font-mono text-sm"
          {...props}
        >
          {children}
        </code>
      );
    }

    return (
      <CollapsibleCodeBlock
        content={String(children).replace(/\n$/, '')}
        language={language}
        className="my-3"
      />
    );
  },
  pre({ children }) {
    return <>{children}</>;
  },
  // 🔥 段落样式
  p({ children }) {
    return <p className="mb-2 text-sm leading-relaxed text-gray-800 dark:text-gray-200">{children}</p>;
  },
  // 🔥 标题样式 - 移除 prose 默认的 border-top
  h1({ children }) {
    return <h1 className="text-lg font-semibold mt-4 mb-2 !pt-0 !border-0 text-gray-900 dark:text-gray-100">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="text-base font-semibold mt-3 mb-2 !pt-0 !border-0 text-gray-900 dark:text-gray-100">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="text-sm font-medium mt-3 mb-1.5 !pt-0 !border-0 text-gray-800 dark:text-gray-200">{children}</h3>;
  },
  // 🔥 列表样式
  ul({ children }) {
    return <ul className="list-disc list-inside my-2 space-y-1 text-sm text-gray-800 dark:text-gray-200">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="list-decimal list-inside my-2 space-y-1 text-sm text-gray-800 dark:text-gray-200">{children}</ol>;
  },
  li({ children }) {
    return <li className="text-sm text-gray-800 dark:text-gray-200">{children}</li>;
  },
  // 🔥 强调样式
  strong({ children }) {
    return <strong className="font-semibold text-gray-900 dark:text-gray-100">{children}</strong>;
  },
  em({ children }) {
    return <em className="italic text-gray-800 dark:text-gray-200">{children}</em>;
  },
  // 🔥 链接样式
  a({ children, href }) {
    return (
      <a
        href={href}
        className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 underline"
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    );
  },
  // 🔥 引用块样式
  blockquote({ children }) {
    return (
      <blockquote className="border-l-4 border-gray-300 dark:border-gray-600 pl-4 my-2 italic text-gray-700 dark:text-gray-300">
        {children}
      </blockquote>
    );
  },
  // 🔥 表格样式
  table({ children }) {
    return (
      <table className="w-full border-collapse my-3 text-sm">
        {children}
      </table>
    );
  },
  th({ children }) {
    return (
      <th className="border border-gray-300 dark:border-gray-600 px-3 py-2 bg-gray-100 dark:bg-gray-800 font-medium text-left">
        {children}
      </th>
    );
  },
  td({ children }) {
    return (
      <td className="border border-gray-300 dark:border-gray-600 px-3 py-2">
        {children}
      </td>
    );
  },
  // 🔥 分隔线样式 - 无边框，仅保留间距
  hr() {
    return <div className="my-3" />;
  },
  // 🔥 删除线样式：区分真正的删除线和数值范围表示
  // remark-gfm 的 ~~text~~ 语法会被解析为 <del> 元素
  // 但 LLM 输出的数值范围（如 "0.02~0.025" 或 "-0.02~-0.025"）可能被误用删除线语法
  del({ children }) {
    const content = String(children);
    // 检测数值范围模式：数字(可能带负号和小数点) + 分隔符(~/-) + 数字
    // 例如：0.02~0.025, -0.02~-0.025, 0.01-0.016, 0.10.25
    const isNumericRange = /^-?[\d.]+[-~]-?[\d.]+$/.test(content);

    if (isNumericRange) {
      // 数值范围：正常显示，不使用删除线样式
      // 用浅色背景提示这是一个"范围"表示，而非删除内容
      return (
        <span className="text-sm text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 px-1 rounded">
          {children}
        </span>
      );
    }

    // 真正的删除线：显示横线穿过文字
    return <del className="line-through text-gray-500 dark:text-gray-400">{children}</del>;
  },
};

/**
 * 🔥 判断是否为 appExecution 类型的结果
 */
const isAppExecutionResult = (result: string): boolean => {
  try {
    const parsed = JSON.parse(result);
    return parsed && typeof parsed === 'object' && 
      (parsed.data?.type === 'appExecution' || parsed.type === 'appExecution');
  } catch {
    return false;
  }
};

/**
 * 🔥 解析 appExecution 结果
 */
const parseAppExecutionResult = (result: string): any => {
  try {
    const parsed = JSON.parse(result);
    if (parsed.data?.type === 'appExecution') {
      return parsed.data;
    }
    if (parsed.type === 'appExecution') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
};

/**
 * 🔥 AppExecution 渲染组件
 *
 * 逻辑很简单：
 * 1. appResult.status === 'streaming' → 任务异步执行中，连接 WebSocket 等待结果
 * 2. finalResult 存在 → WebSocket 通知任务完成，显示结果
 * 3. appResult.output 存在 → 同步执行完成，直接显示结果
 */
const AppExecutionView: React.FC<{ result: string; conversationId?: string }> = ({
  result,
  conversationId,
}) => {
  const { t } = useTranslation();
  const appResult = useMemo(() => parseAppExecutionResult(result), [result]);
  const [taskStatus, setTaskStatus] = useState<string | null>(null);
  const [finalResult, setFinalResult] = useState<any>(null);
  const wsRef = useRef<ECSWebSocketManager | null>(null);

  const isAsyncStreaming = appResult?.status === 'streaming';
  const hasOutput = !!(finalResult || appResult?.output);

  useEffect(() => {
    if (appResult?.taskStatus) {
      setTaskStatus(appResult.taskStatus);
    }
  }, [appResult?.taskStatus]);

  useEffect(() => {
    if (!isAsyncStreaming || !appResult?.appId) return;

    const appId = appResult.appId;
    const taskId = appResult.taskId;

    console.log(`🔌 [AppExecutionView] 连接 WebSocket: appId=${appId}, taskId=${taskId}`);

    const ws = new ECSWebSocketManager(`app-${appId}`);
    wsRef.current = ws;

    ws.onMessage((data: any) => {
      console.log(`📨 [AppExecutionView] 收到 WebSocket 消息:`, data);

      if (data.type === 'gpu_task_status' && data.taskId === taskId) {
        setTaskStatus(data.status);
      }

      if (data.type === 'gpu_task_complete' && data.taskId === taskId) {
        console.log(`✅ [AppExecutionView] 任务完成:`, data.result);
        setFinalResult(data.result);
        setTaskStatus('completed');
        wsRef.current?.close();
      }
    });

    ws.connect();

    return () => {
      console.log(`🔌 [AppExecutionView] 断开 WebSocket: appId=${appId}`);
      wsRef.current?.close();
    };
  }, [isAsyncStreaming, appResult?.appId, appResult?.taskId]);

  if (!appResult) return null;

  if (isAsyncStreaming && !hasOutput) {
    const statusText = taskStatus === 'running' ? t('workspace.messageContent.trainingRunning')
      : taskStatus === 'pending' ? t('workspace.messageContent.instanceCreating')
      : t('workspace.messageContent.appRunning');

    return (
      <div className="mt-3 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
        <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border-b border-blue-200 dark:border-blue-800">
          <div className="flex items-center gap-2 mb-2">
            <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />
            <span className="font-semibold text-gray-800 dark:text-gray-200">{statusText}</span>
          </div>
          {appResult.taskId && (
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {t('workspace.messageContent.taskId')}: <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">{appResult.taskId}</code>
            </p>
          )}
          {appResult.gpuInstanceType && (
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {t('workspace.messageContent.gpuSpec')}: <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">{appResult.gpuInstanceType}</code>
            </p>
          )}
        </div>
        <div className="p-3 bg-white dark:bg-gray-900">
          <p className="text-sm text-gray-700 dark:text-gray-300">
            ⏱️ <span className="font-medium">{t('workspace.messageContent.trainingLongTime')}</span>
          </p>
        </div>
      </div>
    );
  }

  const displayResult = finalResult || appResult;
  const isSuccess = displayResult.success !== false;
  const error = displayResult.error;

  // 🔥 安全处理 charts 和 files：确保类型正确
  const safeCharts = Array.isArray(displayResult.charts) ? displayResult.charts : [];
  const safeFiles = (displayResult.files && typeof displayResult.files === 'object' && !Array.isArray(displayResult.files)) 
    ? displayResult.files : {};

  return (
    <div className="mt-3 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <div className={`p-4 ${isSuccess ? 'bg-green-50 dark:bg-green-900/20' : 'bg-red-50 dark:bg-red-900/20'} border-b`}>
        <div className="flex items-center gap-2 mb-2">
          <span className={`text-lg ${isSuccess ? 'text-green-600' : 'text-red-600'}`}>
            {isSuccess ? '✅' : '❌'}
          </span>
          <span className="font-semibold text-gray-800 dark:text-gray-200">
            {isSuccess ? t('workspace.messageContent.executeComplete') : t('workspace.messageContent.executeFailed')}
          </span>
        </div>
        {appResult.taskId && (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('workspace.messageContent.taskId')}: <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">{appResult.taskId}</code>
          </p>
        )}
        {displayResult.executionTime && (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('workspace.messageContent.executionTime')}: {(displayResult.executionTime / 1000).toFixed(1)}s
          </p>
        )}
      </div>
      {error && !isSuccess ? (
        <div className="p-3 bg-white dark:bg-gray-900">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      ) : (
        <PreviewViewer
          content={displayResult.output || displayResult.content || ''}
          charts={safeCharts}
          files={safeFiles}
          executionTime={displayResult.executionTime}
          error={displayResult.error}
          isLoading={false}
          conversationId={conversationId}
        />
      )}
    </div>
  );
};

/**
 * 消息内容组件
 *
 * 样式参考 AutoPlanMessage
 */
export const MessageContent: React.FC<MessageContentProps> = ({ message, icon }) => {
  const { content, result, status, apiRole, metadata, callId } = message;

  // 🔥 确保 result 是字符串（null/undefined 返回空字符串）
  const resultString = result && result !== 'null' 
    ? (typeof result === 'string' ? result : JSON.stringify(result))
    : '';

  // 🔥 检查 result 是否为 appExecution 类型
  const isAppExecution = resultString && isAppExecutionResult(resultString);

  // 🔥 检查 result 是否为 terminal 类型
  const isTerminal = resultString && isTerminalOutput(resultString);

  // 🔥 检查 result 是否应该显示（纯文本或有 type 字段的 JSON）
  const shouldShowResult = (resultStr: string): boolean => {
    if (!resultStr) return false;
    try {
      const parsed = JSON.parse(resultStr);
      // 如果是 JSON，必须有 type 字段才显示（terminal/appExecution）
      if (parsed && typeof parsed === 'object') {
        return 'type' in parsed;
      }
      return true;
    } catch {
      // 不是 JSON，是纯文本，应该显示
      return true;
    }
  };

  const isResultVisible = shouldShowResult(resultString);

  return (
    <div className="space-y-3">
      {/* 🔥 注入 KaTeX 错误样式覆盖 */}
      <style dangerouslySetInnerHTML={{ __html: KATEX_ERROR_STYLE }} />
      {/* 第1行：Content - 步骤描述 */}
      {content && (
        <div className="prose prose-sm max-w-none prose-headings:!border-0 prose-headings:!pt-0 prose-p:!border-0 prose-p:!pt-0 prose-ul:!border-0 prose-ol:!border-0 prose-li:!border-0">
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]}
            rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
            components={markdownComponents}
            children={preprocessMessageText(content)}
          />
          {/* 🔥 检测 content 中的本地路径 */}
          <LocalPathLinks text={content} />
        </div>
      )}

      {/* 第2行：Icon + IconText - 状态指示 */}
      {icon && (
        <div className="flex items-center">
          {icon}
        </div>
      )}

      {/* 第3行：Result - 执行结果 */}
      {resultString && isResultVisible && (
        <>
          {isAppExecution ? (
            <div className="mt-3">
              <AppExecutionView
                result={resultString}
                conversationId={metadata?.conversationId}
              />
            </div>
          ) : isTerminal ? (
            /* 🔥 terminal 类型使用终端输出渲染 */
            <div className="mt-3">
              <TerminalOutputView result={resultString} callId={callId} />
            </div>
          ) : (
            <div className="prose prose-sm max-w-none prose-headings:!border-0 prose-headings:!pt-0 prose-p:!border-0 prose-p:!pt-0 prose-ul:!border-0 prose-ol:!border-0 prose-li:!border-0">
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]}
                rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
                components={markdownComponents}
                children={preprocessMessageText(resultString)}
              />
              {/* 🔥 检测 result 中的本地路径 */}
              <LocalPathLinks text={resultString} />
            </div>
          )}
        </>
      )}

      {/* 🔥 状态指示器 - 不再硬编码显示文本，依赖 iconText 显示状态 */}
    </div>
  );
};

export default MessageContent;
