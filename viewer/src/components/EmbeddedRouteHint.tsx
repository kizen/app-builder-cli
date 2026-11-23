import type { FC } from 'react';

// Rendered when the viewer itself is loaded inside an iframe at a path that
// isn't a bundle app route. That happens when a plugin frame iframes
// `${this.location.origin}/...` (e.g. /embed/ai-chat): in the dev viewer that
// origin is the viewer's own localhost, not the Kizen app. The copy is
// path-neutral because any non-app path (including `/`) can land here. Plain
// text rather than a Card: the host frame already draws its own border.
export const EmbeddedRouteHint: FC<{ path: string }> = ({ path }) => (
  // PLACEHOLDER COPY (KZN-19663): replace
  <p className="m-0 text-[12px] leading-relaxed text-neutral-500">
    The dev viewer can&apos;t show{' '}
    <code className="rounded bg-neutral-100 px-1 py-0.5">{path}</code> inside a plugin frame. Kizen
    routes like <code className="rounded bg-neutral-100 px-1 py-0.5">/embed/...</code> only exist in
    the Kizen app, so a frame that loads{' '}
    <code className="rounded bg-neutral-100 px-1 py-0.5">{'${this.location.origin}'}/...</code> gets
    this viewer instead.
  </p>
);
