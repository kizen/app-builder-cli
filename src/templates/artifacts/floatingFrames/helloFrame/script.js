// A floating frame is a small panel anchored to one corner of the page. The
// engine opens the frame; `this.outputUI` fills it.
//
// The class names below live in styles.css next to this file. The host
// injects that stylesheet when the frame renders, so plain class selectors
// work with no build step.
//
// In config.json, keep `default_position` non-fixed, or pair a `*-fixed`
// position with `minimized_style: "circle"`. Any other combination fails the
// build with structure/fixed-frame-minimized-style.

this.outputUI(`
  <div class="hello-frame">
    <h2 class="hello-frame__title">Hello from a floating frame</h2>
    <p class="hello-frame__body">Edit src/floatingFrames/helloFrame/script.js to change this.</p>
  </div>
`);
