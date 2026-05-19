import { useEffect, useRef, useState, type FC } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Card } from '../components/Card.js';
import { ICON_MAP, CUSTOM_ICON_NAMES } from '../lib/iconMap.js';
import { VALID_ICONS_LIST } from '@shared/lib/validIcons.js';

export const IconReferencePage: FC = () => {
  const [copiedName, setCopiedName] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handleCopy = (name: string): void => {
    void navigator.clipboard.writeText(name);

    setCopiedName(name);

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = setTimeout(() => {
      setCopiedName(null);
    }, 1200);
  };

  return (
    <div className="space-y-4 text-[13px]">
      <Card>
        <div className="mb-3 flex items-baseline justify-between gap-4">
          <div className="text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
            Icon Reference ({VALID_ICONS_LIST.length} icons)
          </div>
          <div className="text-[11px] text-neutral-400">Click an icon to copy its name</div>
        </div>
        <div className="flex flex-wrap gap-1">
          {VALID_ICONS_LIST.map((name) => {
            const isCopied = copiedName === name;

            return (
              <button
                key={name}
                type="button"
                onClick={() => {
                  handleCopy(name);
                }}
                className={`flex w-32 cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors ${
                  isCopied ? 'bg-emerald-100' : 'hover:bg-black/5'
                }`}
                title={name}
              >
                {ICON_MAP[name] ? (
                  <FontAwesomeIcon
                    icon={ICON_MAP[name]}
                    className="w-3.5 shrink-0 text-[13px] text-neutral-500"
                  />
                ) : CUSTOM_ICON_NAMES.has(name) ? (
                  <span className="w-3.5 shrink-0 text-center font-mono text-[9px] text-neutral-400">
                    K
                  </span>
                ) : null}
                <span className="truncate font-mono text-[10px] text-neutral-500">
                  {isCopied ? 'Copied!' : name}
                </span>
              </button>
            );
          })}
        </div>
      </Card>
    </div>
  );
};
