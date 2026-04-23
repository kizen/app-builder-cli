import { type FC, useMemo } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlay, faSpinner } from '@fortawesome/free-solid-svg-icons';
import hljs from 'highlight.js/lib/core';
import python from 'highlight.js/lib/languages/python';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import css from 'highlight.js/lib/languages/css';
import bash from 'highlight.js/lib/languages/bash';
import plaintext from 'highlight.js/lib/languages/plaintext';
import 'highlight.js/styles/github.css';

hljs.registerLanguage('python', python);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('css', css);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('plaintext', plaintext);

const EXTENSION_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.svg': 'xml',
  '.xml': 'xml',
  '.html': 'xml',
  '.htm': 'xml',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.css': 'css',
  '.scss': 'css',
  '.sh': 'bash',
  '.py': 'python',
};

export function extensionToLanguage(ext: string): string {
  return EXTENSION_LANGUAGE[ext.toLowerCase()] ?? 'plaintext';
}

export type ExecutionMode = 'local' | 'remote';

interface CodeViewerProps {
  code: string;
  language?: string;
  onRun?: () => void;
  isRunning?: boolean;
  executionMode?: ExecutionMode;
  onModeChange?: (mode: ExecutionMode) => void;
}

export const CodeViewer: FC<CodeViewerProps> = ({
  code,
  language = 'python',
  onRun,
  isRunning = false,
  executionMode,
  onModeChange,
}) => {
  const highlightedLines = useMemo(
    () => hljs.highlight(code, { language }).value.split('\n'),
    [code, language],
  );

  return (
    <div className="overflow-hidden rounded-lg border border-black/10 bg-white">
      <div className="flex items-center gap-2 border-b border-black/10 bg-neutral-50 px-4 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
          {language}
        </span>
        <div className="flex-1" />
        {executionMode && onModeChange && (
          <div className="flex overflow-hidden rounded border border-black/10 text-[11px] font-medium">
            {(['local', 'remote'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => {
                  onModeChange(mode);
                }}
                className={`px-2.5 py-0.5 transition-colors ${
                  executionMode === mode
                    ? 'bg-neutral-700 text-white'
                    : 'bg-white text-neutral-500 hover:bg-neutral-100'
                }`}
              >
                {mode === 'local' ? 'Local' : 'Remote'}
              </button>
            ))}
          </div>
        )}
        {onRun && (
          <button
            onClick={onRun}
            disabled={isRunning}
            className="flex items-center gap-1.5 rounded-full border border-black/10 bg-white px-3 py-1 text-[11px] font-medium text-neutral-600 transition-colors hover:border-green-300 hover:text-green-700 disabled:cursor-wait disabled:opacity-50"
          >
            <FontAwesomeIcon
              icon={isRunning ? faSpinner : faPlay}
              className={isRunning ? 'animate-spin' : ''}
            />
            <span>{isRunning ? 'Running…' : 'Run'}</span>
          </button>
        )}
      </div>
      <div className="flex overflow-auto bg-white font-mono text-[13px] leading-[20px]">
        <div className="shrink-0 select-none border-r border-black/5 bg-neutral-50 px-3 py-3 text-right text-neutral-300">
          {highlightedLines.map((_, i) => (
            <div key={i}>{String(i + 1)}</div>
          ))}
        </div>
        <div className="flex-1 overflow-auto py-3 pl-4 pr-4">
          {highlightedLines.map((lineHtml, i) => (
            <div
              key={i}
              className="hljs whitespace-pre"
              dangerouslySetInnerHTML={{ __html: lineHtml || '\u00a0' }}
            />
          ))}
        </div>
      </div>
    </div>
  );
};
