import { describe, expect, it } from 'vitest';
import { renderCallbackPage } from './callbackPage.js';

/** Every absolute URL in the page except the SVG namespace, which is an identifier, not a fetch. */
const remoteReferences = (html: string): string[] =>
  (html.match(/https?:\/\/[^\s"')]+/g) ?? []).filter((url) => url !== 'http://www.w3.org/2000/svg');

describe('renderCallbackPage', () => {
  it('marks the card with the success or error styling hook', () => {
    const success = renderCallbackPage('success', 'h', 'b');
    const error = renderCallbackPage('error', 'h', 'b');

    expect(success).toContain('<section class="card success" data-status="success">');
    expect(success).not.toContain('class="card error"');
    expect(error).toContain('<section class="card error" data-status="error">');
    expect(error).not.toContain('class="card success"');
    // Different glyphs, so the icon itself differs too.
    expect(success).toContain('<path d="M6 12.5l4 4 8-9"/>');
    expect(error).toContain('<path d="M8 8l8 8M16 8l-8 8"/>');
  });

  it('loads nothing from the network', () => {
    for (const kind of ['success', 'error'] as const) {
      const html = renderCallbackPage(kind, 'h', 'b');

      expect(remoteReferences(html)).toStrictEqual([]);
      expect(html).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(html).not.toMatch(/<script|<link|<img|@import|url\((?!#)/i);
    }
  });

  it('escapes heading and body so they cannot inject markup', () => {
    const html = renderCallbackPage(
      'error',
      '<img src=x onerror=alert(1)>',
      'a & b "c" \'d\' </p><script>x</script>',
    );

    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('<h1>&lt;img src=x onerror=alert(1)&gt;</h1>');
    expect(html).toContain(
      '<p>a &amp; b &quot;c&quot; &#39;d&#39; &lt;/p&gt;&lt;script&gt;x&lt;/script&gt;</p>',
    );
  });
});
