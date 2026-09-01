// script.js calls runEventScript('greet') on mount, and each form below
// re-runs this file on submit because it carries `data-script="greet"`. All
// of the page's markup comes from this one script.
//
// Every run is a fresh worker. Nothing you assign to `this` survives to the
// next run, and scripts share no modules, so a helper both scripts need has to
// be copied into each file. The only thing that carries over is the markup the
// previous run painted.
//
// Submitted form values arrive array-wrapped: a field named "tone" reads as
// `formData.tone[0]`.

const tone = this.args?.formData?.tone?.[0] ?? 'plain';

const greeting = tone === 'cheer' ? 'Hello, and good to see you!' : 'Hello from a routable page.';

// DOMPurify sanitizes outputUI markup. Its DOM-clobbering protection strips
// any name or id attribute whose VALUE is a property of document or of a form
// element, so an <input name="name"> loses its name with no warning.
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
