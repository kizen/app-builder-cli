import type { FC, ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  className?: string;
}

export const Card: FC<CardProps> = ({ children, className = '' }) => (
  <div className={`rounded-xl bg-white p-5 shadow-sm ${className}`}>{children}</div>
);
