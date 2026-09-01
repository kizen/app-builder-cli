// A routable page renders at /plugins/<plugin_api_name>/hello_page.
//
// This entry paints a placeholder, then hands off to eventScripts/greet.js,
// the only file that builds the real markup. That markup carries
// `data-script="greet"`, so each button re-runs greet.js in place and there
// is no second copy of the page to keep in sync.

this.outputUI(`
  <div class="hello-page">
    <p class="hello-page__loading">Loading…</p>
  </div>
`);

this.runEventScript('greet');
