const tone = this.args?.formData?.tone?.[0] ?? 'plain';

const greeting = tone === 'cheer' ? 'Hello, and good to see you!' : 'Hello from a routable page.';

this.outputUI(`
  <div class="hello-page">
    <h1 class="hello-page__title">${greeting}</h1>
    <p class="hello-page__body">
      This markup came from eventScripts/greet.js. Either button re-runs it and
      repaints the page with a different greeting.
    </p>
    <div class="hello-page__actions">
      <form data-script="greet">
        <input type="hidden" name="tone" value="plain" />
        <button class="hello-page__button" type="submit">Plain</button>
      </form>
      <form data-script="greet">
        <input type="hidden" name="tone" value="cheer" />
        <button class="hello-page__button" type="submit">Cheerful</button>
      </form>
    </div>
  </div>
`);
