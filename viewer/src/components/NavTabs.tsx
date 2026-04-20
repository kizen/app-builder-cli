import { type FC } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faChartSimple,
  faCode,
  faCodeBranch,
  faFlaskVial,
  faGear,
  faIcons,
  faListCheck,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons';

interface NavTabsProps {
  currentApiName: string;
  currentSubPage: string | undefined;
  hasCodeSteps: boolean;
}

interface Tab {
  id: string;
  label: string;
  icon: IconDefinition;
  order: number;
}

const BASE_TABS: readonly Tab[] = [
  { id: 'summary', label: 'Summary', icon: faChartSimple, order: 0 },
  { id: 'sandbox', label: 'Sandbox', icon: faFlaskVial, order: 1 },
  { id: 'configuration', label: 'Configuration', icon: faGear, order: 2 },
  { id: 'source', label: 'App Source', icon: faCode, order: 4 },
];

const CODE_STEPS_TAB: Tab = { id: 'code-steps', label: 'Code Steps', icon: faListCheck, order: 3 };

const TRAILING_TABS: readonly Tab[] = [
  { id: 'versions', label: 'Version History', icon: faCodeBranch, order: 5 },
  { id: 'icons', label: 'Icon Reference', icon: faIcons, order: 6 },
];

export const NavTabs: FC<NavTabsProps> = ({ currentApiName, currentSubPage, hasCodeSteps }) => {
  const navigate = useNavigate();

  const tabs: Tab[] = [
    ...BASE_TABS,
    ...(hasCodeSteps ? [CODE_STEPS_TAB] : []),
    ...TRAILING_TABS,
  ].sort((a, b) => a.order - b.order);

  const activeId = currentSubPage?.split('/')[0];

  return (
    <div className="sticky top-0 z-[9] flex items-center gap-1 overflow-x-auto border-b border-black/10 bg-white/85 px-3 backdrop-blur-sm lg:px-5">
      {tabs.map((tab) => {
        const isActive = tab.id === activeId;
        const stateClass = isActive
          ? 'text-neutral-900 border-neutral-900'
          : 'text-neutral-500 hover:text-neutral-800 border-transparent';

        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => {
              void navigate({ to: `/${currentApiName}/${tab.id}` });
            }}
            className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-[12px] font-medium transition-colors ${stateClass}`}
            aria-current={isActive ? 'page' : undefined}
          >
            <FontAwesomeIcon icon={tab.icon} className="text-[11px]" />
            <span className="hidden lg:inline">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
};
