import { useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { type FC } from 'react';
import { bundleQueryOptions } from '../bundleQuery.js';
import { Card } from '../components/Card.js';

interface ReleaseNote {
  version: string;
  notes: string;
}

export const VersionsPage: FC = () => {
  const { apiName } = useParams({ from: '/$apiName/versions' });
  const { data: bundle, isLoading, isError } = useQuery(bundleQueryOptions);

  if (isLoading) {
    return (
      <Card>
        <p className="text-[13px] text-neutral-400">Loading...</p>
      </Card>
    );
  }

  if (isError || !bundle) {
    return (
      <Card>
        <p className="text-[13px] text-red-500">Error loading bundle.</p>
      </Card>
    );
  }

  const app = bundle.find((a) => (a as Record<string, unknown>).api_name === apiName) as
    | { allReleaseNotes?: ReleaseNote[]; version?: string }
    | undefined;

  const currentVersion = app?.version ?? '';
  const notes = Array.isArray(app?.allReleaseNotes) ? app.allReleaseNotes : [];

  if (notes.length === 0) {
    return (
      <Card>
        <p className="text-[13px] text-neutral-400">No release notes found.</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {notes.map(({ version, notes: content }) => (
        <Card key={version}>
          <div className="mb-3 flex items-center gap-2">
            <span className="rounded bg-neutral-100 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-neutral-600">
              v{version}
            </span>
            {version === currentVersion && (
              <span className="rounded bg-green-100 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-green-700">
                current
              </span>
            )}
          </div>
          <div className="mb-3 border-t border-black/5" />
          <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-neutral-700">
            {content}
          </pre>
        </Card>
      ))}
    </div>
  );
};
