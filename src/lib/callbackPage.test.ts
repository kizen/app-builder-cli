import { describe, expect, it } from 'vitest';
import { escapeHtml, renderCallbackPage } from './callbackPage.js';

/** Every absolute URL in the page except the SVG namespace, which is an identifier, not a fetch. */
const remoteReferences = (html: string): string[] =>
  (html.match(/https?:\/\/[^\s"')]+/g) ?? []).filter((url) => url !== 'http://www.w3.org/2000/svg');

describe('renderCallbackPage', () => {
  it.each([
    ['success', 'You’re signed in', 'Sign-in complete. You can close this window.'],
    [
      'error',
      'Sign-in failed',
      'Sign-in failed. Return to the terminal for details. You can close this window.',
    ],
    [
      'error',
      'Outdated link',
      'This sign-in link is out of date. Use the latest link from the terminal.',
    ],
  ] as const)('%s page renders heading %j and its body', (kind, heading, body) => {
    const html = renderCallbackPage(kind, heading, body);

    expect(html).toContain(`<h1>${heading}</h1>`);
    expect(html).toContain(`<p>${body}</p>`);
    expect(html).toContain('<title>Kizen App Builder</title>');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('aria-label="Kizen"');
  });

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

  it('wordmark clip id is the one the clip-path references', () => {
    const html = renderCallbackPage('success', 'h', 'b');

    expect(html).toContain('<clipPath id="kizen-callback-wordmark-clip">');
    expect(html).toContain('clip-path="url(#kizen-callback-wordmark-clip)"');
    expect(html).not.toContain('clip0_7190_510154');
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

describe('escapeHtml', () => {
  it('leaves plain text unchanged and escapes each special character once', () => {
    expect(escapeHtml('Sign-in complete. You can close this window.')).toBe(
      'Sign-in complete. You can close this window.',
    );
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});
