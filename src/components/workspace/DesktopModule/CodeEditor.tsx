import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Editor from 'react-simple-code-editor';
import * as Prism from 'prismjs';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-json';
// 🔥 补全常用语言组件（css/html/xml/clike/javascript 由 prism core 自带）——
// 之前语言映射只认 js/ts/json，其余一律按 python tokenize，
// .tsx/.css/.md 等文件全部无 token class（一片黑）
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-docker';
import 'prismjs/components/prism-graphql';
import 'prismjs/components/prism-ini';
import './code-editor-theme.css';
import DiffViewer from './DiffViewer';
import { MessageSquarePlus, Search, X, ArrowUp, ArrowDown } from 'lucide-react';

// 🔥 扩展名 → Prism 语言映射（与 CodeFileViewer 的 EXTENSION_TO_LANGUAGE 保持一致）
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  py: 'python', python: 'python',
  js: 'javascript', javascript: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', typescript: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'tsx', jsx: 'jsx',
  json: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  html: 'html', htm: 'html', xml: 'xml', svg: 'xml', vue: 'markup',
  sql: 'sql',
  sh: 'bash', bash: 'bash', zsh: 'bash', shell: 'bash',
  dockerfile: 'docker',
  graphql: 'graphql', gql: 'graphql',
  ini: 'ini', conf: 'ini', env: 'ini',
};

interface CodeEditorProps {
  value?: string;
  currentCode?: string;
  previousCode?: string;
  onChange: (value: string) => void;
  language?: string;
  height?: string;
  showDiff?: boolean;
  appId?: string;
  userId?: string;
  config?: any;
  filePath?: string; // 🔥 文件路径，用于添加到对话时显示
  /** Diff 接受/回退后回调，通知父组件同步状态 */
  onDiffHandled?: (action: 'accept' | 'revert') => void;
}

interface SelectionInfo {
  text: string;
  startLine: number;
  endLine: number;
  startPos: number;  // 🔥 字符起始位置
  endPos: number;    // 🔥 字符结束位置
}

// 🔥 符号出现位置信息
interface OccurrenceInfo {
  line: number;
  startPos: number;
  endPos: number;
}

export const CodeEditor: React.FC<CodeEditorProps> = ({ 
  value, 
  currentCode,
  previousCode: initialPreviousCode,
  onChange, 
  language = 'python',
  height = '100%',
  showDiff = false,
  appId,
  userId,
  config = {},
  filePath,
  onDiffHandled
}) => {
  const { t } = useTranslation();
  
  const [internalValue, setInternalValue] = useState(currentCode || value || '');
  const [prevCode, setPrevCode] = useState(initialPreviousCode || '');
  const [localShowDiff, setLocalShowDiff] = useState(showDiff);
  
  // 🔥 选中文本相关状态
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [showAddButton, setShowAddButton] = useState(false);
  const [buttonPosition, setButtonPosition] = useState({ x: 0, y: 0 });
  
  // 🔥 符号出现位置高亮状态
  const [occurrences, setOccurrences] = useState<OccurrenceInfo[]>([]);
  const [selectedOccurrenceIndex, setSelectedOccurrenceIndex] = useState<number>(-1); // 当前选中的出现位置索引
  const [editorScrollTop, setEditorScrollTop] = useState<number>(0); // 🔥 编辑器滚动位置（用于 minimap 更新）
  
  // 🔥 搜索功能状态
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<OccurrenceInfo[]>([]);
  const [currentSearchIndex, setCurrentSearchIndex] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement>(null);
  
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const editorContentRef = useRef<HTMLDivElement | null>(null); // 🔥 编辑器内容容器（用于滚动到指定行）

  // 🔥 当 currentCode 变化时，更新内部状态
  useEffect(() => {
    if (currentCode !== undefined) {
      // 🔥 强制更新，不比较 internalValue（避免闭包问题）
      setInternalValue(currentCode);
      console.log('[CodeEditor] currentCode 更新:', currentCode?.substring(0, 50));
    }
  }, [currentCode]);

  useEffect(() => {
    if (initialPreviousCode !== undefined) {
      setPrevCode(initialPreviousCode);
    }
  }, [initialPreviousCode]);

  useEffect(() => {
    setLocalShowDiff(showDiff);
  }, [showDiff]);

  // 🔥 获取 textarea 元素
  useEffect(() => {
    if (editorContainerRef.current) {
      textareaRef.current = editorContainerRef.current.querySelector('textarea');
    }
  }, []);

  const getPrismLanguage = (): string => {
    // 🔥 优先按文件扩展名推断（language prop 可能是父组件写死的默认值，如 python）
    const ext = (filePath || '').split('.').pop()?.toLowerCase() || '';
    if (ext && EXTENSION_TO_LANGUAGE[ext]) return EXTENSION_TO_LANGUAGE[ext];
    const lang = language.toLowerCase();
    if (EXTENSION_TO_LANGUAGE[lang]) return EXTENSION_TO_LANGUAGE[lang];
    return lang; // 未知语言由调用方兜底（clike / 纯文本）
  };

  const highlightCode = (code: string): string => {
    // 🔥 超长单行防护：Prism 正则会在超长单行（minified JS / base64 打包串 / tmp_pack 之类）内
    // 灾难性回溯，长时间阻塞渲染主线程 → 整个窗口点不动。
    // 判据用"最长行"而不是文件总大小：正常代码行宽有限，大文件只是慢不至于死；
    // 只有超长单行才降级为转义纯文本（无语法颜色，但可正常查看/编辑），保留弹性
    const MAX_LINE_LENGTH = 10 * 1024; // 单行超 10KB 判定为打包/压缩产物
    const escapePlain = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (code.length > MAX_LINE_LENGTH) {
      let maxLine = 0, lineStart = 0;
      for (let i = 0; i < code.length; i++) {
        if (code.charCodeAt(i) === 10) { // '\n'
          const lineLen = i - lineStart;
          if (lineLen > maxLine) maxLine = lineLen;
          lineStart = i + 1;
          if (maxLine > MAX_LINE_LENGTH) break;
        }
      }
      if (code.length - lineStart > maxLine) maxLine = code.length - lineStart; // 最后一行
      if (maxLine > MAX_LINE_LENGTH) {
        return escapePlain(code);
      }
    }

    const prismLanguage = getPrismLanguage();
    // 🔥 未知语言兜底 clike（C 系通用语法，keyword/string/comment 有基本颜色），Prism.highlight 异常时降级纯文本
    const grammar = Prism.languages[prismLanguage] || Prism.languages.clike;
    let highlighted: string;
    try {
      highlighted = grammar
        ? Prism.highlight(code, grammar, prismLanguage)
        : escapePlain(code);
    } catch (e) {
      console.warn('[CodeEditor] Prism 高亮失败，降级纯文本:', e);
      highlighted = escapePlain(code);
    }
    
    // 🔥 通用高亮函数：在 Prism 高亮后的 HTML 中，对纯文本部分添加 <mark> 高亮
    const applyHighlight = (html: string, searchText: string, className: string, matchAll: boolean = false): string => {
      try {
        const parts = html.split(/(<[^>]+>)/g);
        let result = '';
        const lowerSearch = searchText.toLowerCase();
        
        for (const part of parts) {
          if (part.startsWith('<')) {
            result += part;
          } else {
            if (matchAll) {
              // 搜索模式：不区分大小写，高亮所有匹配
              const lowerPart = part.toLowerCase();
              let pos = 0;
              while (pos < part.length) {
                const foundPos = lowerPart.indexOf(lowerSearch, pos);
                if (foundPos === -1) {
                  result += part.substring(pos);
                  break;
                }
                result += part.substring(pos, foundPos);
                result += `<mark class="${className}">${part.substring(foundPos, foundPos + searchText.length)}</mark>`;
                pos = foundPos + searchText.length;
              }
            } else {
              // 符号模式：区分大小写，完整单词匹配
              let pos = 0;
              while (pos < part.length) {
                const foundPos = part.indexOf(searchText, pos);
                if (foundPos === -1) {
                  result += part.substring(pos);
                  break;
                }
                const beforeChar = foundPos > 0 ? part[foundPos - 1] : '';
                const afterChar = foundPos + searchText.length < part.length ? part[foundPos + searchText.length] : '';
                const isWordBoundary = !/[a-zA-Z0-9_]/.test(beforeChar) && !/[a-zA-Z0-9_]/.test(afterChar);
                
                if (isWordBoundary) {
                  result += part.substring(pos, foundPos);
                  result += `<mark class="${className}">${searchText}</mark>`;
                  pos = foundPos + searchText.length;
                } else {
                  result += part.substring(pos, foundPos + searchText.length);
                  pos = foundPos + searchText.length;
                }
              }
            }
          }
        }
        return result;
      } catch (e) {
        console.warn('[CodeEditor] 高亮失败:', e);
        return html;
      }
    };
    
    // 🔥 添加搜索结果高亮
    if (searchResults.length > 0 && searchQuery) {
      // 先高亮所有普通匹配
      highlighted = applyHighlight(highlighted, searchQuery, 'search-highlight', true);
      
      // 再对当前选中项应用更高优先级的高亮
      if (currentSearchIndex >= 0 && currentSearchIndex < searchResults.length) {
        // 需要找到第 currentSearchIndex 个 search-highlight 并替换为 search-highlight-current
        let count = 0;
        const marker = '<mark class="search-highlight">';
        const currentMarker = '<mark class="search-highlight-current">';
        let idx = 0;
        while ((idx = highlighted.indexOf(marker, idx)) !== -1) {
          if (count === currentSearchIndex) {
            highlighted = highlighted.substring(0, idx) + currentMarker + highlighted.substring(idx + marker.length);
            break;
          }
          count++;
          idx += marker.length;
        }
      }
    }
    
    // 🔥 添加符号出现位置高亮
    if (occurrences.length > 0 && selection) {
      highlighted = applyHighlight(highlighted, selection.text, 'occurrence-highlight', false);
    }
    
    return highlighted;
  };

  const handleValueChange = (newValue: string) => {
    setInternalValue(newValue);
    onChange(newValue);
  };

  const handleRevert = async () => {
    if (!prevCode) {
      return;
    }
    
    if (appId && filePath) {
      try {
        const { saveFile, commitFiles } = await import('./FileTree/utils');
        const result = await saveFile(appId, filePath, prevCode);
        
        if (result.success) {
          // 🔥 回退后删除 history 中的副本
          await commitFiles(appId, filePath);
          console.log('[CodeEditor] 回退成功，已删除历史版本');
          setInternalValue(prevCode);
          setPrevCode('');
          onChange(prevCode);
          setLocalShowDiff(false);
          onDiffHandled?.('revert');
        } else {
          console.error('[CodeEditor] 回退失败:', result.error);
        }
      } catch (error) {
        console.error('[CodeEditor] 回退异常:', error);
      }
    } else {
      setInternalValue(prevCode);
      setPrevCode('');
      onChange(prevCode);
      setLocalShowDiff(false);
      onDiffHandled?.('revert');
    }
  };

  // 🔥 接受当前版本（=commit，只清空当前文件的历史版本）
  const handleAccept = async () => {
    if (!appId) {
      setPrevCode('');
      setLocalShowDiff(false);
      onDiffHandled?.('accept');
      return;
    }

    try {
      const { commitFiles } = await import('./FileTree/utils');
      // 🔥 只清空当前文件的历史版本，不影响其他文件
      const result = await commitFiles(appId, filePath);
      
      if (result.success) {
        console.log('[CodeEditor] 接受成功，已清空当前文件历史版本:', filePath);
        setPrevCode('');
        setLocalShowDiff(false);
        onDiffHandled?.('accept');
      } else {
        console.error('[CodeEditor] 接受失败:', result.error);
      }
    } catch (error) {
      console.error('[CodeEditor] 接受异常:', error);
    }
  };

  const syncScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (lineNumbersRef.current) lineNumbersRef.current.scrollTop = e.currentTarget.scrollTop;
    // 🔥 更新滚动位置状态，触发 minimap 标记更新
    setEditorScrollTop(e.currentTarget.scrollTop);
  };

  // 🔥 获取选中的文本和行号
  const getSelectionInfo = useCallback((): SelectionInfo | null => {
    const textarea = textareaRef.current;
    if (!textarea) return null;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    
    if (start === end) return null;

    const text = internalValue.substring(start, end);
    const linesBeforeStart = internalValue.substring(0, start).split('\n').length;
    const linesBeforeEnd = internalValue.substring(0, end).split('\n').length;

    return {
      text,
      startLine: linesBeforeStart,
      endLine: linesBeforeEnd,
      startPos: start,
      endPos: end
    };
  }, [internalValue]);

  // 🔥 查找所有匹配的出现位置
  const findOccurrences = useCallback((selectedText: string): OccurrenceInfo[] => {
    if (!selectedText || selectedText.trim().length === 0) return [];
    
    // 🔥 只对标识符（函数名、变量名等）进行高亮，避免对常见关键词高亮
    // 标识符特征：不包含空格、不以数字开头、长度 > 1
    const isIdentifier = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(selectedText.trim());
    if (!isIdentifier) return [];
    
    const occurrences: OccurrenceInfo[] = [];
    const code = internalValue;
    let pos = 0;
    
    while (pos < code.length) {
      const foundPos = code.indexOf(selectedText, pos);
      if (foundPos === -1) break;
      
      // 🔥 检查是否是完整单词（避免部分匹配）
      const beforeChar = foundPos > 0 ? code[foundPos - 1] : '';
      const afterChar = foundPos + selectedText.length < code.length ? code[foundPos + selectedText.length] : '';
      const isWordBoundary = !/[a-zA-Z0-9_]/.test(beforeChar) && !/[a-zA-Z0-9_]/.test(afterChar);
      
      if (isWordBoundary) {
        const lineNum = code.substring(0, foundPos).split('\n').length;
        occurrences.push({
          line: lineNum,
          startPos: foundPos,
          endPos: foundPos + selectedText.length
        });
      }
      
      pos = foundPos + 1;
    }
    
    return occurrences;
  }, [internalValue]);

  // 🔥 搜索功能：查找所有匹配项（默认不区分大小写）
  const findSearchResults = useCallback((query: string): OccurrenceInfo[] => {
    if (!query || query.trim().length === 0) return [];
    
    const results: OccurrenceInfo[] = [];
    const code = internalValue;
    const searchText = query.toLowerCase();
    const searchCode = code.toLowerCase();
    let pos = 0;
    
    while (pos < searchCode.length) {
      const foundPos = searchCode.indexOf(searchText, pos);
      if (foundPos === -1) break;
      
      const lineNum = code.substring(0, foundPos).split('\n').length;
      results.push({
        line: lineNum,
        startPos: foundPos,
        endPos: foundPos + query.length
      });
      
      pos = foundPos + 1;
    }
    
    return results;
  }, [internalValue]);

  // 🔥 处理搜索查询变化
  const handleSearchChange = useCallback((query: string) => {
    setSearchQuery(query);
    const results = findSearchResults(query);
    setSearchResults(results);
    setCurrentSearchIndex(results.length > 0 ? 0 : -1);
    
    if (results.length > 0) {
      scrollToOccurrence(results[0]);
    }
  }, [findSearchResults]);

  // 🔥 滚动到指定搜索结果
  const scrollToSearchResult = useCallback((index: number) => {
    if (index < 0 || index >= searchResults.length) return;
    
    setCurrentSearchIndex(index);
    scrollToOccurrence(searchResults[index]);
  }, [searchResults]);

  // 🔥 下一个搜索结果
  const handleNextSearch = useCallback(() => {
    if (searchResults.length === 0) return;
    
    const nextIndex = currentSearchIndex < searchResults.length - 1 
      ? currentSearchIndex + 1 
      : 0;
    
    scrollToSearchResult(nextIndex);
  }, [currentSearchIndex, searchResults, scrollToSearchResult]);

  // 🔥 上一个搜索结果
  const handlePrevSearch = useCallback(() => {
    if (searchResults.length === 0) return;
    
    const prevIndex = currentSearchIndex > 0 
      ? currentSearchIndex - 1 
      : searchResults.length - 1;
    
    scrollToSearchResult(prevIndex);
  }, [currentSearchIndex, searchResults, scrollToSearchResult]);

  // 🔥 关闭搜索
  const handleCloseSearch = useCallback(() => {
    setShowSearch(false);
    setSearchQuery('');
    setSearchResults([]);
    setCurrentSearchIndex(-1);
  }, []);
  // 🔥 处理文本选择
  const handleSelectionChange = useCallback(() => {
    const info = getSelectionInfo();
    if (info && info.text.trim().length > 0) {
      setSelection(info);
      setShowAddButton(true);
      
      // 🔥 查找所有匹配的出现位置
      const foundOccurrences = findOccurrences(info.text);
      console.log('[CodeEditor] 🔍 findOccurrences:', info.text, '→', foundOccurrences.length, '个匹配');
      setOccurrences(foundOccurrences);
      
      // 🔥 找到当前选中的出现位置索引
      const currentIdx = foundOccurrences.findIndex(
        o => o.startPos === info.startPos && o.endPos === info.endPos
      );
      setSelectedOccurrenceIndex(currentIdx >= 0 ? currentIdx : 0);
      
      // 🔥 根据选中的行号计算按钮位置
      const lineHeight = 22; // 每行高度
      const paddingTop = 12; // 编辑器内边距
      const paddingLeft = 12 + 50; // 编辑器左边距 + 行号宽度
      
      // 计算选区起始行的垂直位置（考虑滚动）
      const textarea = textareaRef.current;
      const scrollTop = textarea?.scrollTop || 0;
      const containerWidth = editorContainerRef.current?.clientWidth || 400;
      
      // 按钮显示在选区起始行的上方
      const y = paddingTop + (info.startLine - 1) * lineHeight - scrollTop - 35;
      // 水平居中显示
      const x = (containerWidth - paddingLeft) / 2;
      
      setButtonPosition({
        x: Math.max(10, Math.min(x, containerWidth - 130)),
        y: Math.max(5, y)
      });
    } else {
      setShowAddButton(false);
      setSelection(null);
      setOccurrences([]); // 🔥 清除出现位置
      setSelectedOccurrenceIndex(-1);
    }
  }, [getSelectionInfo, findOccurrences]);

  // 🔥 处理添加到对话
  const handleAddToChat = useCallback(() => {
    if (!selection) return;

    const path = filePath || config?.datasetPath || '当前文件';
    const lines = selection.endLine - selection.startLine + 1;
    const lineInfo = lines > 1 
      ? `第 ${selection.startLine}-${selection.endLine} 行`
      : `第 ${selection.startLine} 行`;
    
    // 🔥 使用特殊标记格式，ChatInput 会识别并隐藏，只显示简洁预览
    const codeBlockData = {
      appId: appId || '',
      filePath: path,
      language,
      startLine: selection.startLine,
      endLine: selection.endLine,
      code: selection.text
    };
    
    // 🔥 紧凑格式，便于正则匹配
    const message = `[[CODE_BLOCK:${btoa(encodeURIComponent(JSON.stringify(codeBlockData)))}]]`;

    // 🔥 独立窗口（app-viewer）里 window 事件到不了主窗口，改走 localStorage 跨窗口通道；
    // 主窗口 OptimizedChatInput 监听 storage 事件接收
    const isStandaloneWindow = window.location.hash.includes('app-viewer');
    if (isStandaloneWindow) {
      try {
        localStorage.setItem('sendToChatInputSignal', JSON.stringify({ message, t: Date.now() }));
        setShowAddButton(false);
        setSelection(null);
        return;
      } catch { /* 写失败则退回 window 事件（本窗口内） */ }
    }

    // 发送事件到聊天输入框
    window.dispatchEvent(new CustomEvent('sendToChatInput', { detail: message }));
    
    // 隐藏按钮
    setShowAddButton(false);
    setSelection(null);
  }, [selection, appId, filePath, config, language]);

  // 🔥 监听文本选择事件
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const handleMouseUp = () => {
      setTimeout(handleSelectionChange, 10);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      // 只在选择相关的按键后处理
      if (['Shift', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
        setTimeout(handleSelectionChange, 10);
      }
    };

    textarea.addEventListener('mouseup', handleMouseUp);
    textarea.addEventListener('keyup', handleKeyUp);
    textarea.addEventListener('select', handleSelectionChange);

    return () => {
      textarea.removeEventListener('mouseup', handleMouseUp);
      textarea.removeEventListener('keyup', handleKeyUp);
      textarea.removeEventListener('select', handleSelectionChange);
    };
  }, [handleSelectionChange]);

  // 🔥 点击其他地方隐藏按钮
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.add-to-chat-button')) {
        setShowAddButton(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // 🔥 快捷键 Ctrl+F 搜索 / Ctrl+S 保存
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setShowSearch(true);
        setTimeout(() => {
          searchInputRef.current?.focus();
        }, 50);
      }
      // 🔥 Ctrl+S 保存（接受当前版本）
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (prevCode) {
          handleAccept();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [prevCode]);

  // 🔥 滚动时更新按钮位置
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || !showAddButton || !selection) return;

    const handleScroll = () => {
      const lineHeight = 22;
      const paddingTop = 12;
      const scrollTop = textarea.scrollTop;
      const containerWidth = editorContainerRef.current?.clientWidth || 400;
      const paddingLeft = 12 + 50;
      
      const y = paddingTop + (selection.startLine - 1) * lineHeight - scrollTop - 35;
      const x = (containerWidth - paddingLeft) / 2;
      
      setButtonPosition({
        x: Math.max(10, Math.min(x, containerWidth - 130)),
        y: Math.max(5, y)
      });
      
      // 如果按钮滚出可视区域，隐藏它
      if (y < -40 || y > (textarea.clientHeight + 40)) {
        setShowAddButton(false);
      }
    };

    textarea.addEventListener('scroll', handleScroll);
    return () => textarea.removeEventListener('scroll', handleScroll);
  }, [showAddButton, selection]);

  const renderLineNumbers = () => {
    const lines = internalValue.split('\n');
    return (
      <div className="h-full">
        {Array.from({ length: Math.max(lines.length, 1) }, (_, i) => (
          <div key={i} className="text-right text-gray-400 select-none flex items-center justify-center h-[22px] leading-[22px] font-medium">
            {i + 1}
          </div>
        ))}
      </div>
    );
  };

  // 🔥 滚动到指定的出现位置
  const scrollToOccurrence = useCallback((occurrence: OccurrenceInfo) => {
    const scrollContainer = editorContentRef.current;
    if (!scrollContainer) return;
    
    const lineHeight = 22;
    const paddingTop = 12;
    const lineY = (occurrence.line - 1) * lineHeight + paddingTop;
    const scrollTop = lineY - scrollContainer.clientHeight / 2;
    
    scrollContainer.scrollTo({
      top: Math.max(0, scrollTop),
      behavior: 'smooth'
    });
    
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.focus();
      textarea.setSelectionRange(occurrence.startPos, occurrence.endPos);
    }
  }, []);

  // 🔥 渲染 minimap 上的标记点（全局 minimap）
  const renderOccurrenceMarkers = () => {
    if (occurrences.length === 0) return null;
    
    const textarea = textareaRef.current;
    const totalLines = internalValue.split('\n').length;
    const scrollContainer = editorContentRef.current;
    
    // 🔥 使用滚动容器获取准确的滚动状态（而不是 textarea）
    const scrollHeight = (scrollContainer?.scrollHeight || 0) - (scrollContainer?.clientHeight || 0);
    const scrollTop = scrollContainer?.scrollTop || editorScrollTop;
    
    // 🔥 当前可视区域百分比
    const scrollPercentage = scrollHeight > 0 ? (scrollTop / scrollHeight) * 100 : 0;
    // 🔥 可视区域高度比例（动态计算）
    const viewportRatio = scrollContainer ? scrollContainer.clientHeight / scrollContainer.scrollHeight : 0.1;
    const viewportHeightPercent = viewportRatio * 100;
    
    console.log('[CodeEditor] 🎨 renderOccurrenceMarkers:', occurrences.length, '个标记, totalLines=', totalLines, 'scrollPercentage=', scrollPercentage, 'viewportHeightPercent=', viewportHeightPercent, 'scrollHeight=', scrollHeight, 'clientHeight=', scrollContainer?.clientHeight);
    
    return (
      // 🔥 Minimap 容器：在编辑器右侧，高度等于编辑器高度（全局 minimap）
      // 🔥 背景透明，z-index 降低（避免挡住 DesktopAppViewer 的按钮）
      <div 
        className="occurrence-minimap h-full w-4 cursor-pointer flex-shrink-0 relative"
        onClick={(e) => {
          // 🔥 点击 minimap 跳转到对应位置
          if (!scrollContainer) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const clickY = e.clientY - rect.top;
          const percentage = clickY / rect.height;
          const targetScrollTop = percentage * scrollHeight;
          scrollContainer.scrollTop = targetScrollTop;
          setEditorScrollTop(targetScrollTop);
        }}
        title="点击跳转到对应位置"
      >
        {/* 🔥 标记点容器 */}
        <div className="absolute inset-0 overflow-hidden">
          {occurrences.map((occ, idx) => {
            // 🔥 使用百分比定位（全局 minimap）
            const topPercent = ((occ.line - 1) / totalLines) * 100;
            
            return (
              <div
                key={`${occ.line}-${occ.startPos}`}
                className={`occurrence-marker absolute left-0 right-0 cursor-pointer transition-all ${
                  idx === selectedOccurrenceIndex 
                    ? 'bg-blue-500 opacity-80' 
                    : 'bg-yellow-400 opacity-60 hover:opacity-80'
                }`}
                style={{
                  top: `${topPercent}%`,
                  height: '3px', // 🔥 固定高度 3px
                  minHeight: '2px'
                }}
                onClick={(e) => {
                  e.stopPropagation(); // 阻止触发 minimap 点击
                  scrollToOccurrence(occ);
                }}
                title={`第 ${occ.line} 行 (${idx + 1}/${occurrences.length})`}
              />
            );
          })}
        </div>
        
        {/* 🔥 当前可视区域指示器（蓝色半透明块） */}
        <div 
          className="absolute left-0 right-0 bg-blue-400 opacity-20 pointer-events-none"
          style={{
            top: `${scrollPercentage}%`,
            height: `${Math.min(viewportHeightPercent, 30)}%`,
            minHeight: '4px'
          }}
        />
      </div>
    );
  };

  return (
    <div className="h-full min-h-0 min-w-0 w-full flex flex-col overflow-hidden bg-white" ref={editorContainerRef}>
      {/* 🔥 搜索栏 */}
      {showSearch && (
        <div className="code-editor-search-bar">
          <Search className="w-4 h-4 text-gray-400 flex-shrink-0" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleNextSearch();
              } else if (e.key === 'Escape') {
                handleCloseSearch();
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                handleNextSearch();
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                handlePrevSearch();
              }
            }}
            placeholder="搜索代码..."
            className="code-editor-search-input"
            autoFocus
          />
          {searchQuery && (
            <button
              onClick={handleCloseSearch}
              className="code-editor-search-button"
              title="关闭搜索 (Esc)"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          <span className="code-editor-search-count">
            {searchResults.length > 0 
              ? `${currentSearchIndex + 1}/${searchResults.length}` 
              : ''}
          </span>
          <button
            onClick={handlePrevSearch}
            className="code-editor-search-button"
            title="上一个 (Shift+Enter)"
            disabled={searchResults.length === 0}
          >
            <ArrowUp className="w-4 h-4" />
          </button>
          <button
            onClick={handleNextSearch}
            className="code-editor-search-button"
            title="下一个 (Enter)"
            disabled={searchResults.length === 0}
          >
            <ArrowDown className="w-4 h-4" />
          </button>
          <button
            onClick={handleCloseSearch}
            className="code-editor-search-button"
            title="关闭搜索 (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0 w-full overflow-hidden flex flex-col p-2 min-w-0 relative">
        {localShowDiff ? (
          <div className="flex-1 min-h-0 w-full border border-gray-200 rounded-md overflow-hidden bg-white">
            <DiffViewer oldCode={prevCode} newCode={internalValue} onRevert={handleRevert} onAccept={handleAccept} />
          </div>
        ) : (
          <div className="border border-gray-200 rounded-md flex-1 overflow-auto flex flex-col w-full min-w-0">
            <div className="flex h-full">
              <div ref={lineNumbersRef} className="bg-gray-50 border-r border-gray-200 text-xs font-mono flex flex-col items-end justify-start flex-shrink-0 p-[12px_8px] w-[50px] min-h-full overflow-hidden">
                {renderLineNumbers()}
              </div>
              <div className="flex-1 relative overflow-auto CodeEditor-container" onScroll={syncScroll} ref={editorContentRef}>
                <Editor
                  value={internalValue} 
                  onValueChange={handleValueChange}
                  highlight={highlightCode}
                  padding={12} 
                  className="focus:outline-none !block"
                  style={{ 
                    fontFamily: "'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', monospace", 
                    fontSize: 14, 
                    fontWeight: 500, 
                    lineHeight: '22px', 
                    backgroundColor: 'white', 
                    minHeight: '100%', 
                    whiteSpace: 'pre',
                    minWidth: 'max-content',
                    fontVariantLigatures: 'none'
                  }}
                  textareaClassName="focus:outline-none !block"
                />
                
                {/* 🔥 添加到对话按钮 */}
                {showAddButton && selection && (
                  <button
                    onClick={handleAddToChat}
                    className="add-to-chat-button absolute z-50 flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded-md shadow-lg transition-all"
                    style={{
                      left: `${Math.max(10, Math.min(buttonPosition.x, (editorContainerRef.current?.clientWidth || 300) - 120))}px`,
                      top: `${Math.max(10, buttonPosition.y)}px`,
                    }}
                    title="将选中的代码添加到对话"
                  >
                    <MessageSquarePlus className="w-3.5 h-3.5" />
                    <span>添加到对话</span>
                  </button>
                )}
              </div>
              
              {/* 🔥 符号出现位置标记（全局 minimap） - 在编辑器右侧 */}
              {renderOccurrenceMarkers()}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default CodeEditor;
