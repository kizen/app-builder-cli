import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { type FC, useEffect } from 'react';
import { bundleQueryOptions } from '../bundleQuery.js';
import { Card } from '../components/Card.js';

export const SummaryPage: FC = () => {
  const { data: bundle, isLoading, isError } = useQuery(bundleQueryOptions);

  const navigate = useNavigate();

  useEffect(() => {
    const first = bundle?.[0];

    if (first) {
      void navigate({
        to: '/$apiName/summary',
        params: { apiName: first.api_name },
      });
    }
  }, [bundle, navigate]);

  if (isLoading) {
    return (
      <Card>
        <p className="m-0 text-[13px] text-neutral-400">Fetching bundle.json…</p>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card>
        <p className="m-0 text-[13px] text-red-700">
          Could not load bundle.json. Make sure the dev server is running from a plugin directory.
        </p>
      </Card>
    );
  }

  if (!bundle || bundle.length === 0) {
    return (
      <Card>
        <p className="m-0 text-[13px] text-yellow-700">
          bundle.json is empty. Run{' '}
          <code className="rounded bg-neutral-100 px-1 py-0.5">appbuilder build</code> to generate
          it.
        </p>
      </Card>
    );
  }

  return null;
};
