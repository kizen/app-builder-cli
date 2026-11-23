import type { FC } from 'react';
import { Card } from './Card.js';

// The one not-found state for `/$apiName/...` routes whose app isn't in the
// loaded bundle. App.tsx renders it in place of the routed page.
export const AppNotFound: FC<{ apiName: string }> = ({ apiName }) => (
  <Card>
    <p className="m-0 text-[13px] text-neutral-500">
      No app found with api_name{' '}
      <code className="rounded bg-neutral-100 px-1 py-0.5">{apiName}</code>.
    </p>
  </Card>
);
