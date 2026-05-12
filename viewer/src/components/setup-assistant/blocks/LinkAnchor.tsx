import { useMemo, type FC, type ReactNode } from 'react';
import type { IncludeOption } from '@kizenapps/engine';
import { useAuthParams } from './util.js';
import { getLinkValue } from '@kizenapps/engine/util';

interface LinkAnchorProps {
  link: { href?: string; include?: IncludeOption[] };
  children: ReactNode;
  className?: string;
}

export const LinkAnchor: FC<LinkAnchorProps> = ({ link, children, className }) => {
  const getParam = useAuthParams();

  const linkValue = useMemo(
    () => getLinkValue(link.href, link.include, getParam),
    [link.href, link.include, getParam],
  );

  return (
    <a href={linkValue} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  );
};
