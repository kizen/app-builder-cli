// An admin places a block on a dashboard, homepage, chart or record page.
// `types` in config.json controls which of those surfaces offer it.
//
// The packager ships styles.css next to this file as the block's `styles`.
// The host draws no card around a block, so the padding and background in
// that stylesheet are all the block gets.

this.outputUI(`
  <div class="hello-block">
    <h2 class="hello-block__title">Hello from a block</h2>
    <p class="hello-block__body">Edit src/blocks/helloBlock/script.js to change this.</p>
  </div>
`);
