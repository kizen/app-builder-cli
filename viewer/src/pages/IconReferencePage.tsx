import { useEffect, useMemo, useRef, useState, type FC } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faExternalLink } from '@fortawesome/free-solid-svg-icons';
import { Card } from '../components/Card.js';
import { CUSTOM_ICON_NAMES, VALID_ICONS_LIST } from '@shared/lib/validIcons.js';

const FA_ICONS_URL = 'https://fontawesome.com/icons';

// `f`/`s` select the family and style shown on a fontawesome.com icon page.
// Production Kizen renders the light style, so link straight to it.
const faIconUrl = (name: string): string => `${FA_ICONS_URL}/${name}?f=classic&s=light`;

export const IconReferencePage: FC = () => {
  const [copiedName, setCopiedName] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase();

    return needle ? VALID_ICONS_LIST.filter((name) => name.includes(needle)) : VALID_ICONS_LIST;
  }, [filter]);

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
        <div className="mb-1 flex items-baseline justify-between gap-4">
          <div className="text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
            Icon Reference (
            {filter.trim()
              ? `${String(matches.length)} of ${String(VALID_ICONS_LIST.length)}`
              : `${String(VALID_ICONS_LIST.length)} icons`}
            )
          </div>
          <div className="text-[11px] text-neutral-400">Click a name to copy it</div>
        </div>

        <p className="mb-3 text-[11px] leading-relaxed text-neutral-500">
          These are{' '}
          <a
            href={FA_ICONS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-neutral-300 underline-offset-2 hover:text-neutral-700 hover:decoration-neutral-500"
          >
            Font Awesome
          </a>{' '}
          icon names; icon appearance is defined by the Kizen app at runtime. This list shows valid
          names only.
        </p>

        <input
          type="search"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
          }}
          placeholder="Filter icon names…"
          aria-label="Filter icon names"
          className="mb-3 w-full max-w-xs rounded border border-black/10 px-2 py-1 font-mono text-[11px] text-neutral-700 placeholder:text-neutral-400 focus:border-black/25 focus:outline-none"
        />

        {matches.length === 0 ? (
          <div className="py-6 text-center font-mono text-[11px] text-neutral-400">
            No icon name matches “{filter.trim()}”
          </div>
        ) : (
          <div className="flex flex-wrap gap-1">
            {matches.map((name) => {
              const isCopied = copiedName === name;
              const isCustom = CUSTOM_ICON_NAMES.has(name);

              return (
                <div
                  key={name}
                  className={`flex w-44 items-center gap-1 rounded pr-1 transition-colors ${
                    isCopied ? 'bg-emerald-100' : 'hover:bg-black/5'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      handleCopy(name);
                    }}
                    className="min-w-0 flex-1 cursor-pointer truncate px-1.5 py-1 text-left font-mono text-[11px] text-neutral-600"
                    title={isCustom ? `${name} — Kizen custom icon` : `Copy “${name}”`}
                  >
                    {isCopied ? 'Copied!' : name}
                  </button>
                  {isCustom ? (
                    <span className="shrink-0 rounded bg-sky-100 px-1 font-mono text-[9px] text-sky-700">
                      kizen
                    </span>
                  ) : (
                    <a
                      href={faIconUrl(name)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 rounded p-1 text-[9px] text-neutral-400 opacity-60 transition hover:bg-black/5 hover:text-neutral-600 hover:opacity-100 focus-visible:opacity-100"
                      title={`View “${name}” on fontawesome.com`}
                      aria-label={`View ${name} on fontawesome.com`}
                    >
                      <FontAwesomeIcon icon={faExternalLink} />
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <p className="mt-4 border-t border-black/8 pt-3 text-[11px] leading-relaxed text-neutral-400">
          Names tagged <span className="font-mono text-sky-700">kizen</span> are Kizen&rsquo;s own
          brand icons and have no Font Awesome page. For every other name,{' '}
          <FontAwesomeIcon icon={faExternalLink} className="text-neutral-400" /> opens its Font
          Awesome page in a new tab, showing the light style Kizen renders.
        </p>
      </Card>
    </div>
  );
};
