import { useEffect, useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faChevronRight,
  faChevronDown,
  faFolder,
  faFolderOpen,
  faFile,
  faSpinner,
} from '@fortawesome/free-solid-svg-icons';
import { CodeViewer, extensionToLanguage } from '../components/CodeViewer.js';
import { useLocalStorage } from '../hooks/useLocalStorage.js';
import { formatBytes } from '@shared/lib/formatBytes.js';
import { TEXT_EXTENSIONS } from '@shared/lib/fileExtensions.js';

interface TreeEntry {
  name: string;
  kind: 'dir' | 'file';
  size?: number;
}

interface TreeResponse {
  path: string;
  entries: TreeEntry[];
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico']);

function extnameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf('.');

  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

function joinPath(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`;
}

function treeQueryOptions(path: string): {
  queryKey: readonly unknown[];
  queryFn: () => Promise<TreeResponse>;
} {
  return {
    queryKey: ['source-tree', path] as const,
    queryFn: async (): Promise<TreeResponse> => {
      const res = await fetch(`/api/source/tree?path=${encodeURIComponent(path)}`);

      if (!res.ok) {
        throw new Error(`Failed to list ${path || '/'}`);
      }

      return (await res.json()) as TreeResponse;
    },
  };
}

interface FileResponse {
  kind: 'text' | 'image' | 'binary' | 'too-large';
  content?: string;
  size: number;
  contentType: string;
}

class FileFetchError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);

    this.status = status;
  }
}

function fileQueryOptions(path: string | null): {
  queryKey: readonly unknown[];
  queryFn: () => Promise<FileResponse>;
  enabled: boolean;
  retry: (failureCount: number, error: Error) => boolean;
} {
  return {
    queryKey: ['source-file', path] as const,
    enabled: path !== null && path !== '',
    retry: (failureCount: number, error: Error): boolean => {
      if (error instanceof FileFetchError && error.status >= 400 && error.status < 500) {
        return false;
      }

      return failureCount < 3;
    },
    queryFn: async (): Promise<FileResponse> => {
      if (path === null || path === '') {
        throw new Error('No path');
      }

      const res = await fetch(`/api/source/file?path=${encodeURIComponent(path)}`);
      const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
      const sizeHeader = res.headers.get('content-length');
      const size = sizeHeader !== null ? Number(sizeHeader) : 0;

      if (res.status === 413) {
        const body = (await res.json()) as { size?: number };

        return {
          kind: 'too-large',
          size: body.size ?? size,
          contentType,
        };
      }

      if (!res.ok) {
        throw new FileFetchError(`Failed to read ${path}`, res.status);
      }

      const ext = extnameOf(path);

      if (IMAGE_EXTENSIONS.has(ext) && !contentType.startsWith('text/')) {
        return { kind: 'image', size, contentType };
      }

      if (
        TEXT_EXTENSIONS.has(ext) ||
        contentType.startsWith('text/') ||
        contentType.includes('json')
      ) {
        const text = await res.text();

        return { kind: 'text', content: text, size: text.length, contentType };
      }

      return { kind: 'binary', size, contentType };
    },
  };
}

interface DirectoryNodeProps {
  path: string;
  name: string;
  depth: number;
  expanded: Set<string>;
  toggleExpanded: (path: string) => void;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

const DirectoryNode: FC<DirectoryNodeProps> = ({
  path,
  name,
  depth,
  expanded,
  toggleExpanded,
  selectedPath,
  onSelect,
}) => {
  const isOpen = expanded.has(path);

  const { data, isLoading, isError } = useQuery({
    ...treeQueryOptions(path),
    enabled: isOpen,
  });

  return (
    <div>
      <button
        onClick={() => {
          toggleExpanded(path);
        }}
        className="flex w-full items-center gap-1.5 px-2 py-0.5 text-left text-[12px] text-neutral-700 hover:bg-neutral-100"
        style={{ paddingLeft: `${String(8 + depth * 12)}px` }}
      >
        <FontAwesomeIcon
          icon={isOpen ? faChevronDown : faChevronRight}
          className="w-3 text-[9px] text-neutral-400"
        />
        <FontAwesomeIcon
          icon={isOpen ? faFolderOpen : faFolder}
          className="w-3 text-[11px] text-amber-500"
        />
        <span className="truncate">{name}</span>
      </button>
      {isOpen && (
        <div>
          {isLoading && (
            <div
              className="flex items-center gap-1.5 px-2 py-0.5 text-[11px] text-neutral-400"
              style={{ paddingLeft: `${String(24 + depth * 12)}px` }}
            >
              <FontAwesomeIcon icon={faSpinner} className="animate-spin text-[9px]" />
              <span>Loading…</span>
            </div>
          )}
          {isError && (
            <div
              className="px-2 py-0.5 text-[11px] text-red-500"
              style={{ paddingLeft: `${String(24 + depth * 12)}px` }}
            >
              Failed to load
            </div>
          )}
          {data?.entries.map((entry) => {
            const childPath = joinPath(path, entry.name);

            if (entry.kind === 'dir') {
              return (
                <DirectoryNode
                  key={childPath}
                  path={childPath}
                  name={entry.name}
                  depth={depth + 1}
                  expanded={expanded}
                  toggleExpanded={toggleExpanded}
                  selectedPath={selectedPath}
                  onSelect={onSelect}
                />
              );
            }

            const isSelected = selectedPath === childPath;

            return (
              <button
                key={childPath}
                onClick={() => {
                  onSelect(childPath);
                }}
                className={`flex w-full items-center gap-1.5 px-2 py-0.5 text-left text-[12px] ${
                  isSelected ? 'bg-neutral-800 text-white' : 'text-neutral-700 hover:bg-neutral-100'
                }`}
                style={{ paddingLeft: `${String(24 + (depth + 1) * 12)}px` }}
                title={childPath}
              >
                <FontAwesomeIcon
                  icon={faFile}
                  className={`w-3 text-[11px] ${isSelected ? 'text-white/70' : 'text-neutral-400'}`}
                />
                <span className="truncate">{entry.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

interface FileContentViewerProps {
  path: string;
  onMissing: () => void;
}

const FileContentViewer: FC<FileContentViewerProps> = ({ path, onMissing }) => {
  const { data, isLoading, isError, error } = useQuery(fileQueryOptions(path));
  const ext = extnameOf(path);

  useEffect(() => {
    if (isError && error instanceof FileFetchError && error.status === 404) {
      onMissing();
    }
  }, [isError, error, onMissing]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 p-4 text-[12px] text-neutral-500">
        <FontAwesomeIcon icon={faSpinner} className="animate-spin" />
        <span>Loading {path}…</span>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="p-4 text-[12px] text-red-600">
        {error instanceof Error ? error.message : `Could not read ${path}`}
      </div>
    );
  }

  if (data.kind === 'too-large') {
    return (
      <div className="p-4 text-[12px] text-neutral-600">
        File too large to preview ({formatBytes(data.size)}).
      </div>
    );
  }

  if (data.kind === 'image') {
    return (
      <div className="flex items-start justify-start p-4">
        <img
          src={`/api/source/file?path=${encodeURIComponent(path)}`}
          alt={path}
          className="max-w-full rounded border border-black/10 bg-[url('data:image/svg+xml;utf8,<svg%20xmlns=%22http://www.w3.org/2000/svg%22%20width=%2216%22%20height=%2216%22><rect%20width=%228%22%20height=%228%22%20fill=%22%23f3f4f6%22/><rect%20x=%228%22%20y=%228%22%20width=%228%22%20height=%228%22%20fill=%22%23f3f4f6%22/></svg>')]"
        />
      </div>
    );
  }

  if (data.kind === 'binary') {
    return (
      <div className="p-4 text-[12px] text-neutral-600">
        Binary file ({formatBytes(data.size)}) — cannot preview.
      </div>
    );
  }

  return (
    <div className="p-4">
      <CodeViewer code={data.content ?? ''} language={extensionToLanguage(ext)} />
    </div>
  );
};

export const SourceBrowserPage: FC = () => {
  const { data, isLoading, isError } = useQuery(treeQueryOptions(''));

  const [expandedArr, setExpandedArr] = useLocalStorage<string[]>('source-browser-expanded', []);
  const [selectedPath, setSelectedPath] = useLocalStorage<string | null>(
    'source-browser-selected',
    null,
  );

  const expanded = useMemo(() => new Set(expandedArr), [expandedArr]);

  const toggleExpanded = (path: string): void => {
    const next = new Set(expanded);

    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }

    setExpandedArr([...next]);
  };

  const [copied, setCopied] = useState(false);

  const copyPath = (): void => {
    if (selectedPath === null) {
      return;
    }

    void navigator.clipboard.writeText(selectedPath).then(() => {
      setCopied(true);

      setTimeout(() => {
        setCopied(false);
      }, 1200);
    });
  };

  if (isLoading) {
    return (
      <div className="-m-6 flex h-[calc(100%+3rem)] items-center justify-center bg-white text-[13px] text-neutral-600">
        Loading source tree…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="-m-6 flex h-[calc(100%+3rem)] items-center justify-center bg-white text-[13px] text-red-600">
        Could not load source tree.
      </div>
    );
  }

  return (
    <div className="-m-6 flex h-[calc(100%+3rem)] overflow-hidden bg-white">
      <div className="flex w-72 shrink-0 flex-col border-r border-black/10 bg-neutral-50/60">
        <div className="flex h-10 shrink-0 items-center border-b border-black/10 px-4 text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
          Plugin Source
        </div>
        <div className="flex-1 overflow-auto py-1">
          {data.entries.map((entry) => {
            const childPath = joinPath('', entry.name);

            if (entry.kind === 'dir') {
              return (
                <DirectoryNode
                  key={childPath}
                  path={childPath}
                  name={entry.name}
                  depth={0}
                  expanded={expanded}
                  toggleExpanded={toggleExpanded}
                  selectedPath={selectedPath}
                  onSelect={setSelectedPath}
                />
              );
            }

            const isSelected = selectedPath === childPath;

            return (
              <button
                key={childPath}
                onClick={() => {
                  setSelectedPath(childPath);
                }}
                className={`flex w-full items-center gap-1.5 px-2 py-0.5 text-left text-[12px] ${
                  isSelected ? 'bg-neutral-800 text-white' : 'text-neutral-700 hover:bg-neutral-100'
                }`}
                style={{ paddingLeft: '24px' }}
                title={childPath}
              >
                <FontAwesomeIcon
                  icon={faFile}
                  className={`w-3 text-[11px] ${isSelected ? 'text-white/70' : 'text-neutral-400'}`}
                />
                <span className="truncate">{entry.name}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-black/10 px-4">
          {selectedPath !== null ? (
            <>
              <span className="truncate font-mono text-[12px] text-neutral-700">
                {selectedPath}
              </span>
              <button
                onClick={copyPath}
                className="rounded-full border border-black/10 bg-white px-2 py-0.5 text-[10px] font-medium text-neutral-500 hover:border-black/20 hover:text-neutral-800"
              >
                {copied ? 'Copied' : 'Copy path'}
              </button>
            </>
          ) : (
            <span className="text-[12px] text-neutral-400">Select a file to preview</span>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {selectedPath !== null && selectedPath !== '' && (
            <FileContentViewer
              path={selectedPath}
              onMissing={() => {
                setSelectedPath(null);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
};
