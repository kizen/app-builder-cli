import type { FC, ReactNode } from 'react';
import type { LinkField } from '../../../lib/setupAssistantTypes.js';

const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

interface LinkAnchorProps {
  link: LinkField;
  children: ReactNode;
  className?: string;
}

export const LinkAnchor: FC<LinkAnchorProps> = ({ link, children, className }) => {
  const isAbsolute = ABSOLUTE_URL.test(link.href);
  const opensNewTab = isAbsolute || link.target === '_blank';
  const target = opensNewTab ? '_blank' : undefined;
  const rel = opensNewTab ? 'noopener noreferrer' : undefined;

  return (
    <a href={link.href} target={target} rel={rel} className={className}>
      {children}
    </a>
  );
};
