import type { RoutablePageConfig } from '@kizenapps/engine';
import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useSyncExternalStore,
  forwardRef,
  useImperativeHandle,
  type FC,
} from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { VALID_ICONS } from '@shared/lib/validIcons.js';
import { ICON_MAP, CUSTOM_ICON_NAMES } from '../lib/iconMap.js';
import { PLUGIN_IFRAME_ALLOW } from '../lib/constants.js';
import {
  getNavigationEvents,
  parseSessionDataKey,
  subscribeNavigation,
} from '../lib/navigationContext.js';
import { NavigationDestination } from './NavigationDestination.js';
import { NavigationLogSection } from './NavigationLogSection.js';
import { PluginViewContent } from './PluginViewContent.js';

const RoutablePageView: FC<{ page: RoutablePageConfig; isActive: boolean }> = ({
  page,
  isActive,
}) => (
  <PluginViewContent
    page={page}
    style={{ display: isActive ? 'block' : 'none' }}
    className="h-full w-full"
    contentClassName="p-3"
    iframeAllow={PLUGIN_IFRAME_ALLOW}
  />
);

export interface BrowserHandle {
  navigate: (path: string, options?: { replace?: boolean }) => void;
  openNewTab: (url: string) => void;
}

interface HomeHistory {
  entries: string[];
  index: number;
}
interface DynamicTab {
  id: string;
  url: string;
  title: string;
}

const ROUTE_CHANGE_EVENT = 'integration:route-change';

function findMatchingPage(
  pages: RoutablePageConfig[],
  normalized: string,
): RoutablePageConfig | undefined {
  return pages.find(
    (p) => p.api_name === normalized || normalized.endsWith(`${p.plugin_api_name}/${p.api_name}`),
  );
}

// Page matching keys off the path only; a plugin can navigate to the same page
// with a different ?query#hash (e.g. a session_data_key), so the query must not
// leak into the api_name comparison.
function stripQuery(path: string): string {
  const marker = path.search(/[?#]/);

  return marker === -1 ? path : path.slice(0, marker);
}

// Split a plugin-provided path into location parts without `new URL()`, which
// throws on malformed input (e.g. a stray `%`) and would crash the browser UI
// on a tab switch. We only need the raw pathname/search/hash split.
function toLocationParts(displayPath: string): {
  pathname: string;
  search: string;
  hash: string;
} {
  const hashStart = displayPath.indexOf('#');
  const hash = hashStart === -1 ? '' : displayPath.slice(hashStart);
  const beforeHash = hashStart === -1 ? displayPath : displayPath.slice(0, hashStart);

  const searchStart = beforeHash.indexOf('?');
  const search = searchStart === -1 ? '' : beforeHash.slice(searchStart);
  const pathname = searchStart === -1 ? beforeHash : beforeHash.slice(0, searchStart);

  return { pathname: `/${pathname}`, search, hash };
}

// Body of a dynamic (non-routable-page) tab: an iframe for real http urls, a
// simulated Kizen destination when the url carries a navigation-context key,
// otherwise "Page not found". A tab's url never changes after creation, so no
// remount key is needed here (unlike the home tab).
const DynamicTabContent: FC<{ tab: DynamicTab }> = ({ tab }) => {
  if (/^https?:\/\//i.test(tab.url)) {
    return (
      <iframe
        src={tab.url}
        className="h-full w-full border-0"
        title={tab.title}
        allow={PLUGIN_IFRAME_ALLOW}
      />
    );
  }

  const sessionDataKey = parseSessionDataKey(tab.url);

  if (sessionDataKey) {
    return <NavigationDestination url={tab.url} sessionDataKey={sessionDataKey} />;
  }

  return (
    <div className="flex flex-col gap-2 p-6 font-mono text-[11px]">
      <div className="text-neutral-400">{tab.url}</div>
      <div className="mt-1 text-[13px] font-medium text-neutral-500">Page not found</div>
      <div className="text-neutral-400">
        No routable page with path{' '}
        <code className="rounded bg-neutral-100 px-1">{stripQuery(tab.url)}</code> is defined in
        this plugin.
      </div>
    </div>
  );
};

function tabTitleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);

    return parsed.hostname !== ''
      ? parsed.hostname
      : (parsed.pathname.split('/').filter(Boolean).pop() ?? url);
  } catch {
    const path = stripQuery(url);

    return path.split('/').filter(Boolean).pop() ?? path;
  }
}

export const RoutablePageBrowser = forwardRef<BrowserHandle, { pages: RoutablePageConfig[] }>(
  ({ pages }, ref) => {
    const [activeTab, setActiveTab] = useState<string>('home');
    const [homeHistory, setHomeHistory] = useState<HomeHistory>({ entries: [''], index: 0 });
    const [dynamicTabs, setDynamicTabs] = useState<DynamicTab[]>([]);
    const [navVersions, setNavVersions] = useState<Record<string, number>>({});
    const tabIdCounter = useRef(0);
    const tabBarRef = useRef<HTMLDivElement>(null);
    const [canScrollLeft, setCanScrollLeft] = useState(false);
    const [canScrollRight, setCanScrollRight] = useState(false);

    const checkTabScroll = useCallback(() => {
      const el = tabBarRef.current;

      if (!el) {
        return;
      }

      setCanScrollLeft(el.scrollLeft > 0);
      setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    }, []);

    useEffect(() => {
      const el = tabBarRef.current;

      if (!el) {
        return;
      }

      checkTabScroll();
      el.addEventListener('scroll', checkTabScroll);
      const ro = new ResizeObserver(checkTabScroll);

      ro.observe(el);

      return () => {
        el.removeEventListener('scroll', checkTabScroll);
        ro.disconnect();
      };
    }, [checkTabScroll]);

    const currentHomePath = homeHistory.entries[homeHistory.index] ?? '';
    const displayPath = activeTab === 'home' ? currentHomePath : activeTab;

    const isFirstRender = useRef(true);

    useEffect(() => {
      if (isFirstRender.current) {
        isFirstRender.current = false;

        return;
      }

      const { pathname, search, hash } = toLocationParts(displayPath);

      window.dispatchEvent(
        new CustomEvent(ROUTE_CHANGE_EVENT, {
          detail: {
            location: {
              host: window.location.host,
              origin: window.location.origin,
              port: window.location.port,
              protocol: window.location.protocol,
              pathname,
              search,
              hash,
              href: `${window.location.origin}${pathname}${search}${hash}`,
            },
          },
        }),
      );
    }, [displayPath]);

    const canGoBack = activeTab === 'home' && homeHistory.index > 0;
    const canGoForward = activeTab === 'home' && homeHistory.index < homeHistory.entries.length - 1;

    const navigate = useCallback(
      (path: string, options?: { replace?: boolean }) => {
        // Keep the full path (incl. query/hash) for history + the url bar, but
        // match pages on the path alone so a session_data_key doesn't miss.
        const normalized = path.replace(/^\/+/, '');
        const matchedPage = findMatchingPage(pages, stripQuery(normalized));

        if (matchedPage) {
          setActiveTab(matchedPage.api_name);

          setNavVersions((prev) => ({
            ...prev,
            [matchedPage.api_name]: (prev[matchedPage.api_name] ?? 0) + 1,
          }));
        } else {
          setActiveTab('home');

          setHomeHistory((prev) => {
            if (!options?.replace && prev.entries[prev.index] === normalized) {
              return prev;
            }

            if (options?.replace) {
              const entries = [...prev.entries];

              entries[prev.index] = normalized;

              return { entries, index: prev.index };
            }

            const entries = [...prev.entries.slice(0, prev.index + 1), normalized];

            return { entries, index: entries.length - 1 };
          });
        }
      },
      [pages],
    );

    const openNewTab = useCallback(
      (url: string) => {
        const normalized = url.replace(/^\/+/, '');
        const matchedPage = findMatchingPage(pages, stripQuery(normalized));

        if (matchedPage) {
          setActiveTab(matchedPage.api_name);

          setNavVersions((prev) => ({
            ...prev,
            [matchedPage.api_name]: (prev[matchedPage.api_name] ?? 0) + 1,
          }));

          return;
        }

        tabIdCounter.current += 1;

        const id = `__tab_${String(tabIdCounter.current)}`;

        setDynamicTabs((prev) => [...prev, { id, url, title: tabTitleFromUrl(url) }]);

        setActiveTab(id);
      },
      [pages],
    );

    const closeTab = useCallback(
      (id: string) => {
        setDynamicTabs((prev) => prev.filter((t) => t.id !== id));

        if (activeTab === id) {
          setActiveTab('home');
        }
      },
      [activeTab],
    );

    useImperativeHandle(ref, () => ({ navigate, openNewTab }), [navigate, openNewTab]);

    const activeDynamicTab = dynamicTabs.find((t) => t.id === activeTab) ?? null;
    const homeSessionDataKey = parseSessionDataKey(currentHomePath);

    const [navLogOpen, setNavLogOpen] = useState(false);
    // Length is a primitive, so this snapshot is referentially stable per store
    // version — safe for useSyncExternalStore without memoization.
    const navEventCount = useSyncExternalStore(
      subscribeNavigation,
      () => getNavigationEvents().length,
    );

    return (
      <div className="mt-1.5 overflow-hidden rounded border border-black/10 bg-white">
        {/* Browser chrome */}
        <div className="flex items-center gap-2 border-b border-black/8 bg-neutral-50 px-3 py-1.5">
          <div className="flex shrink-0 gap-1">
            <div className="h-3 w-3 rounded-full bg-red-400/60" />
            <div className="h-3 w-3 rounded-full bg-yellow-400/60" />
            <div className="h-3 w-3 rounded-full bg-green-400/60" />
          </div>
          <button
            onClick={() => {
              setHomeHistory((prev) => ({ ...prev, index: prev.index - 1 }));
            }}
            disabled={!canGoBack}
            className={`px-0.5 font-mono text-[15px] leading-none transition-colors ${canGoBack ? 'text-neutral-600 hover:text-neutral-900' : 'cursor-default text-neutral-300'}`}
          >
            ‹
          </button>
          <button
            onClick={() => {
              setHomeHistory((prev) => ({ ...prev, index: prev.index + 1 }));
            }}
            disabled={!canGoForward}
            className={`px-0.5 font-mono text-[15px] leading-none transition-colors ${canGoForward ? 'text-neutral-600 hover:text-neutral-900' : 'cursor-default text-neutral-300'}`}
          >
            ›
          </button>
          <div className="min-w-0 flex-1 truncate rounded border border-black/8 bg-white px-2 py-0.5 font-mono text-[11px] text-neutral-400">
            {activeDynamicTab ? activeDynamicTab.url : `app://sandbox/${displayPath}`}
          </div>
          <button
            onClick={() => {
              setNavLogOpen((prev) => !prev);
            }}
            title="Navigation context log"
            className={`flex shrink-0 items-center gap-1 rounded border border-black/8 px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
              navLogOpen
                ? 'bg-neutral-200 text-neutral-700'
                : 'bg-white text-neutral-400 hover:text-neutral-700'
            }`}
          >
            context
            {navEventCount > 0 && (
              <span className="rounded bg-neutral-500 px-1 text-[9px] leading-4 text-white">
                {navEventCount}
              </span>
            )}
          </button>
        </div>

        {/* Tabs */}
        <div className="relative border-b border-black/8 bg-neutral-50">
          {canScrollLeft && (
            <div className="pointer-events-none absolute inset-y-0 left-0 z-10 flex items-center pl-1 pr-6 bg-gradient-to-r from-neutral-50 to-transparent">
              <span className="font-mono text-[13px] leading-none text-neutral-400">‹</span>
            </div>
          )}
          {canScrollRight && (
            <div className="pointer-events-none absolute inset-y-0 right-0 z-10 flex items-center pl-6 pr-1 bg-gradient-to-l from-neutral-50 to-transparent">
              <span className="font-mono text-[13px] leading-none text-neutral-400">›</span>
            </div>
          )}
          <div ref={tabBarRef} className="overflow-x-auto">
            <div className="flex min-w-max">
              <button
                onClick={() => {
                  setActiveTab('home');
                }}
                className={`border-r border-black/8 px-3 py-1.5 font-mono text-[11px] transition-colors ${
                  activeTab === 'home'
                    ? 'bg-white font-medium text-neutral-900'
                    : 'text-neutral-500 hover:bg-black/5'
                }`}
              >
                home
              </button>
              {pages.map((page) => (
                <button
                  key={page.api_name}
                  onClick={() => {
                    setActiveTab(page.api_name);
                  }}
                  className={`border-r border-black/8 px-3 py-1.5 font-mono text-[11px] transition-colors ${
                    activeTab === page.api_name
                      ? 'bg-white font-medium text-neutral-900'
                      : 'text-neutral-500 hover:bg-black/5'
                  }`}
                >
                  {page.toolbar_icon &&
                    (ICON_MAP[page.toolbar_icon] ? (
                      <FontAwesomeIcon
                        icon={ICON_MAP[page.toolbar_icon]}
                        className="mr-1 text-[10px] text-neutral-400"
                      />
                    ) : (
                      <span
                        className={`mr-1 rounded px-1 font-mono text-[9px] ${VALID_ICONS.has(page.toolbar_icon) || CUSTOM_ICON_NAMES.has(page.toolbar_icon) ? 'bg-neutral-100 text-neutral-400' : 'bg-amber-100 text-amber-600'}`}
                      >
                        {page.toolbar_icon}
                      </span>
                    ))}
                  {page.name}
                </button>
              ))}
              {dynamicTabs.map((tab) => (
                <div
                  key={tab.id}
                  className={`flex items-center border-r border-black/8 ${activeTab === tab.id ? 'bg-white' : 'hover:bg-black/5'}`}
                >
                  <button
                    onClick={() => {
                      setActiveTab(tab.id);
                    }}
                    className={`py-1.5 pl-3 pr-1 font-mono text-[11px] transition-colors ${
                      activeTab === tab.id ? 'font-medium text-neutral-900' : 'text-neutral-500'
                    }`}
                  >
                    {tab.title}
                  </button>
                  <button
                    onClick={() => {
                      closeTab(tab.id);
                    }}
                    className="px-1.5 py-1.5 font-mono text-[11px] text-neutral-300 transition-colors hover:text-neutral-600"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="relative h-[500px] overflow-hidden">
          {activeTab === 'home' && currentHomePath === '' && (
            <div className="flex flex-col gap-2 p-6 font-mono text-[11px]">
              <div className="text-neutral-400">app://sandbox/</div>
              <div className="mt-1 text-[13px] font-medium text-neutral-700">App Homepage</div>
              <div className="text-neutral-400">
                {pages.length > 0
                  ? 'This is the index page of your app. Navigate to a routable page using the tabs above.'
                  : 'This app has no routable pages defined. Add a routable_page artifact to your plugin to see it here.'}
              </div>
            </div>
          )}
          {activeTab === 'home' &&
            currentHomePath !== '' &&
            (homeSessionDataKey ? (
              // key: the home tab reuses this tree position across _self
              // navigations, so without a remount NavigationDestination's
              // read-once context state would show one destination's payload
              // while Consume/Clear acted on another's sessionStorage entry.
              <NavigationDestination
                key={currentHomePath}
                url={currentHomePath}
                sessionDataKey={homeSessionDataKey}
              />
            ) : (
              <div className="flex flex-col gap-2 p-6 font-mono text-[11px]">
                <div className="text-neutral-400">app://sandbox/{stripQuery(currentHomePath)}</div>
                <div className="mt-1 text-[13px] font-medium text-neutral-500">Page not found</div>
                <div className="text-neutral-400">
                  No routable page with api_name{' '}
                  <code className="rounded bg-neutral-100 px-1">{stripQuery(currentHomePath)}</code>{' '}
                  is defined in this plugin.
                </div>
              </div>
            ))}
          {pages.map((page) => (
            <RoutablePageView
              key={`${page.api_name}-${String(navVersions[page.api_name] ?? 0)}`}
              page={page}
              isActive={activeTab === page.api_name}
            />
          ))}
          {dynamicTabs.map((tab) => (
            <div
              key={tab.id}
              style={{ display: activeTab === tab.id ? 'block' : 'none' }}
              className="h-full w-full"
            >
              <DynamicTabContent tab={tab} />
            </div>
          ))}

          {/* Slide-out navigation-context log */}
          <div
            className={`absolute inset-y-0 right-0 z-10 flex w-80 max-w-full flex-col border-l border-black/10 bg-white shadow-lg transition-transform duration-200 ${
              navLogOpen ? 'translate-x-0' : 'translate-x-full'
            }`}
          >
            <div className="flex items-center justify-between border-b border-black/8 bg-neutral-50 px-3 py-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-neutral-600">
                Navigation Context
              </span>
              <button
                onClick={() => {
                  setNavLogOpen(false);
                }}
                className="px-1 font-mono text-[13px] leading-none text-neutral-300 transition-colors hover:text-neutral-600"
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              <NavigationLogSection />
            </div>
          </div>
        </div>
      </div>
    );
  },
);

RoutablePageBrowser.displayName = 'RoutablePageBrowser';
