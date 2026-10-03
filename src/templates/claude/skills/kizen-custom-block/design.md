# Designing a Kizen custom block

With host chrome (the default), a block must look like a native Kizen dashlet. Follow every rule here exactly. Where a rule says "use judgment", pick the option that looks most native. A block whose `config.json` sets `"host_chrome": false` follows section M for its card and outer box, and skips every rule marked "with host chrome".

## A. Card and outer box (with host chrome)

The host paints the card. Background, border, border radius and drop shadow all come from the dashboard's style settings, the same as native dashlets.

- Never paint a card. The block root has no background (it stays transparent), no border, no `border-radius`, no `box-shadow` and no outer margin.
- The block's content box starts at the card's top-left corner (0,0) and fills the whole card. The host body padding is 0. The root is always `width: 100%; height: 100%; box-sizing: border-box;`.
- The host draws a 46px header overlay (`position: absolute`, padding `11px 15px 15px`) over the block's top edge. The dashlet menu appears at its top right on hover. The top-right strip, 60px wide and 46px tall from the card's top edge, must hold no interactive controls and no text. Non-interactive chart marks may pass under it.
- The native grid has a 10px gap between cards and around the grid. Row height is 105px (100px at the mobile, 2-column breakpoint), so a card is `rows * 105 + (rows - 1) * 10` px tall. Width depends on the breakpoint's column count.
- Blocks are fluid. Never assume a pixel size. Use percentages, flex or grid, and an SVG `viewBox`.
- Set `default_w` (columns) and `default_h` (rows) in `config.json` so the content fits comfortably at its starting size: roughly 3×2 for a KPI tile, 6×4 for a chart, and 6×5 for a table or list. A card `rows` tall is `rows * 105 + (rows - 1) * 10` px, so 2 rows is 220px, 4 rows is 440px and 5 rows is 565px. Keep each default within any `min_*` and `max_*` the block sets.

## B. Inner spacing

With host chrome, measure these insets from the card's edge. With chrome off, measure them from the edge of the block-owned card, or follow section M for full bleed.

- Horizontal inset: 15px left and right, matching the native body padding `0 15px`.
- With a header, use the native header band (section C). Content under a header starts at 35px from the top. The header overlay still covers the card down to 46px, so the top-right strip 60px wide from 35px to 46px must hold no interactive controls or text.
- Without a header, use 15px top padding. The same top-right strip, 60px wide down to 46px, stays free of controls and text.
- Bottom padding: 15px.
- Major gaps use 15px: between a KPI value and its comparison row, and between sections.
- Minor gaps use 10px: legend rows, list-row vertical padding, and the padding above a legend.

```css
.kz-block {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  padding: 15px;
  display: flex;
  flex-direction: column;
  font-family: var(--font-family-sans-serif);
  color: var(--color-font-primary);
}
.kz-block--with-header {
  padding-top: 0;
}
```

## C. Header (optional; use judgment)

A block doesn't need a header, and it may use a different kind of header when the content calls for one. When it shows a native-style title, match native exactly:

- A band 35px tall with padding `7.5px 60px 7.5px 15px`. The 60px right padding keeps long titles out from under the hover menu.
- Title text 12px, weight 100 (Proxima Nova Light), `text-transform: uppercase`, `color: var(--color-font-primary)`, `line-height: 20px`, left-aligned at 15px.
- Blocks can't read per-dashboard title-style settings, so always use these defaults.
- Copy `.kz-header` from the example below. Its `margin: 0 -15px` cancels the root's side padding so the title lands at 15px.

## D. Typography

- Font: Proxima Nova through `font-family: var(--font-family-sans-serif)`. The host already loads it.
- The host applies `* { font-size: 10px; line-height: 1 }`. Set an explicit px `font-size` on every text element.
- Scale (px): hero 32, header 24, subheader 18, body 14, button 13, label 12, small 11, micro 10.
- Weights: 100 light, 400 regular, 600 bold, 900 black.
- Text colors: `var(--color-font-primary)` (#4A5660) for primary text, `var(--color-font-secondary)` (#7E8C98) for secondary text, `var(--color-font-placeholder)` (#A8B3BC) for muted text and captions.
- Header titles and category or axis labels are uppercase. Legend labels use sentence case.

## E. Color tokens

Always use CSS custom properties. Never write raw hex, because themes can change the values. The hex values below are reference only.

| Use                      | Token                                        | Default |
| ------------------------ | -------------------------------------------- | ------- |
| Surface                  | `--color-background-white`                   | #FFFFFF |
| Surface                  | `--color-background-light`                   | #F5F6F7 |
| Surface                  | `--color-background-lighter`                 | #F9FAFB |
| Surface                  | `--color-background-medium`                  | #D8DDE1 |
| Surface                  | `--color-background-dark`                    | #A8B3BC |
| Surface                  | `--color-background-darker`                  | #4A5660 |
| Surface                  | `--color-background-hover`                   | #D8EAFD |
| Border, divider          | `--color-border-medium`                      | #D8DDE1 |
| Border, divider          | `--color-border-medium-light`                | #ECEEF0 |
| Border, divider          | `--color-border-light`                       | #F5F6F7 |
| Links, secondary actions | `--color-button-secondary-default`, `-hover` | #4090F7 |
| Primary actions          | `--color-button-primary-default`, `-hover`   | #4BC7B4 |
| Status good              | `--color-viz-cat-1-primary`                  | #32C055 |
| Status bad               | `--color-viz-cat-7-primary`                  | #EB272B |

Color SVG through CSS classes in `styles.css`, for example `.bar-1 { fill: var(--color-viz-cat-1-primary); }`. Never use `fill="var(...)"` attributes; they aren't reliable.

## F. Charts

Native dashlets use amCharts 5. Blocks hand-build SVG that mimics it.

- Series palette, in order: `--color-viz-cat-N-primary` for N = 1 to 10 (the tokens native charts read). The paired light shade `--color-viz-cat-N-secondary` is for backgrounds, tracks and comparison series.
- Defaults (primary / secondary): 1 #32C055 / #ADE6BB, 2 #285DE4 / #6FB2F9, 3 #F3A800 / #FADC99, 4 #4926CC / #B7A6EA, 5 #38B3B9 / #9BD9DB, 6 #F26C56 / #F4A63A, 7 #EB272B / #FF8A8A, 8 #D100A0 / #FF85E2, 9 #AE764A / #D6BAA4, 10 #7A7A7A / #BCBCBC.
- Axis labels: `fill: var(--color-background-dark)`, 10 to 11 user units, small and muted.
- Gridlines: `stroke: var(--color-border-medium-light)`, 1px.
- Tooltip, if you draw one: background `var(--color-background-darker)`, text `var(--color-background-white)`.
- Donut: 2px white gaps between segments (`stroke: var(--color-background-white); stroke-width: 2;`).
- Dashed forecast or incomplete segments: `stroke-dasharray: 4 4;`.
- Legend: 8px circular dots, 10px gap to a 10px label, 20px column gap between items, 10px row gap when wrapping, 10px padding above the legend.
- Put chart labels inside the SVG as `<text>` so they scale with the `viewBox`.

## G. KPI tiles

The value is hero 32px, weight 400, `var(--color-font-primary)`, centered when it stands alone. A comparison or delta row sits 15px below it, `var(--color-viz-cat-1-primary)` when good and `var(--color-viz-cat-7-primary)` when bad.

## H. Number formatting

Match the native `collapseNumber` rules:

- Not a number: `0`.
- |n| < 1: up to 4 decimals, trailing zeros removed.
- |n| < 1,000: up to 5 significant digits, trailing zeros removed.
- 1,000 to 9,999: an integer with a thousands separator.
- 10,000 and up: round to 4 significant digits first, then show K, M or B.
- 1 trillion and up: `999B+`, with no sign.
- Currency: prefix the symbol, for example `$`.

Never copy or rewrite this helper. Import it from the CLI-managed data lib:

```js
import { formatNumber } from '../../lib/kizenData.js';
```

## I. States

- Loading: a centered, subtle "Loading…" line on a transparent background (with chrome off, on whatever background the block paints). Render it with `this.outputUI` first, before any data fetch.
- Empty: centered "No Data", 32px, `color: var(--color-background-medium)`.
- Error: a centered 14px message in `var(--color-font-secondary)`, for example "Couldn't load data." Never show raw error objects.

## J. Icons

Inline SVG only, with `fill: currentColor` or a token applied through a class. Icon fonts and host icon classes aren't available.

## K. Scrollbars

Every scroll container uses the app's expanding scrollbar. Add the `kds-expanding-scrollbar` class to the element that scrolls, for example `<div class="kz-list kds-expanding-scrollbar">`. The host finds these containers on its own, including ones that render later, and attaches the native thin bar that widens on hover.

- Put the class on the element that has `overflow: auto`, not on its parent. Give that element a bounded height, usually a flex child with `flex: 1; min-height: 0`.
- Never style scrollbars yourself: no `::-webkit-scrollbar` rules, `scrollbar-width` or `scrollbar-color`.
- Only scroll when the content really is a list. Otherwise fit the content to the card.

## L. Don'ts

- With host chrome, don't paint an outer card, shadow or border.
- Don't use fixed pixel widths.
- Don't use raw hex colors.
- Don't use `em` or `rem` units. The base is 10px, so they surprise.
- Don't load custom web fonts.
- Don't put content under the top-right menu area.
- Don't add a scroll container without `kds-expanding-scrollbar` (section K).

## M. Chrome off (`"host_chrome": false`)

The host paints no background, border, radius or shadow. The block root is still `width: 100%; height: 100%; box-sizing: border-box;` and starts at the card's top-left corner (0,0) with no host padding. Pick one of these layouts:

- Transparent full bleed: the root fills the card edge to edge and the dashboard background shows through wherever the block paints nothing. Use it for heroes and imagery, for example a `background-image` with `background-size: cover` on the root.
- Block-owned card: the block paints its own card with its own background, `border-radius`, border and `box-shadow`, using tokens. The host card still clips at its edges (`overflow: hidden`), so inset the card from the root by at least its shadow's blur plus offset, usually 8 to 12px (for example `padding: 10px` on the root with the card inside). A card with no inset loses its shadow.

The host adds no backdrop behind its controls, so keep two areas visually quiet, with no dark or busy art directly under them:

- The top-right menu strip, 60px wide and 46px tall. It still holds no interactive controls and no text.
- The top-left drag-handle area in edit mode, about 30px square. The handle icon sits 5px from the left and 10px from the top and is 15px tall.

Section A's grid, fluid-size and default-size rules, section C (when you show a native-style header), sections D to K and the rest of section L still apply. Inside a block-owned card, use section B's spacing.

## Example: header, bar chart and legend

The block counts Contacts by their `status` dropdown for the current dashboard filters, with the helpers from `src/lib/kizenData.js` (see "Reading Kizen data" in `SKILL.md`). Swap `OBJECT` and `FIELD` for the object and field the user asked about. The chart's only text is the y-axis labels at the left edge and the category labels along the bottom, so nothing lands in the top-right strip under the menu.

`script.js`:

```js
import {
  blockFilters,
  countBy,
  escapeHtml,
  fieldByName,
  formatNumber,
  getFields,
  searchRecords,
} from '../../lib/kizenData.js';

const OBJECT = 'client_client';
const FIELD = 'status';

const render = (body) =>
  this.outputUI(
    `<div class="kz-block kz-block--with-header"><div class="kz-header">Contacts by status</div>${body}</div>`,
  );

render('<div class="kz-state">Loading…</div>');

let rows;
let notes;
try {
  const fields = await getFields(this, OBJECT);
  const field = fieldByName(fields, FIELD);
  if (!field) throw new Error(`${OBJECT} has no ${FIELD} field`);
  const { filters, unapplied } = blockFilters(this.args, fields);
  const { records, count, truncated } = await searchRecords(this, {
    object: OBJECT,
    fieldNames: [FIELD],
    filters,
  });
  rows = countBy(records, FIELD, field).filter((row) => row.key !== '');
  notes = [
    truncated ? `Showing first ${formatNumber(records.length)} of ${formatNumber(count)}` : '',
    unapplied.includes('teamFilter') ? '(team filter not applied)' : '',
  ].filter(Boolean);
} catch {
  render('<div class="kz-state kz-state--error">Couldn\'t load data.</div>');
  return;
}

if (rows.length === 0) {
  render('<div class="kz-state kz-state--empty">No Data</div>');
  return;
}

const W = 300,
  H = 150,
  left = 36,
  top = 6,
  bottom = 18;
const plot = H - top - bottom;
const max = Math.max(...rows.map((r) => r.count)) || 1;
const y = (v) => top + plot - (v / max) * plot;
const step = (W - left) / rows.length;
const barW = Math.min(20, step / 2);

const grid = [0, 0.5, 1]
  .map((f) => f * max)
  .map(
    (t) =>
      `<line class="grid" x1="${left}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/>` +
      `<text class="axis" x="${left - 6}" y="${y(t) + 3}" text-anchor="end">${formatNumber(t)}</text>`,
  )
  .join('');

const bars = rows
  .map((r, i) => {
    const cx = left + i * step + step / 2;
    return (
      `<rect class="bar" x="${cx - barW / 2}" y="${y(r.count)}" width="${barW}" height="${top + plot - y(r.count)}"/>` +
      `<text class="axis" x="${cx}" y="${H - 4}" text-anchor="middle">${escapeHtml(r.label)}</text>`
    );
  })
  .join('');

render(
  `<div class="kz-chart"><svg viewBox="0 0 ${W} ${H}">${grid}${bars}</svg></div>` +
    '<div class="kz-legend">' +
    '<span class="kz-legend__item"><span class="kz-dot"></span>Contacts</span>' +
    notes.map((note) => `<span class="kz-note">${escapeHtml(note)}</span>`).join('') +
    '</div>',
);
```

`styles.css`:

```css
.kz-block {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  padding: 15px;
  display: flex;
  flex-direction: column;
  font-family: var(--font-family-sans-serif);
  color: var(--color-font-primary);
}
.kz-block--with-header {
  padding-top: 0;
}
.kz-header {
  flex: none;
  box-sizing: border-box;
  height: 35px;
  margin: 0 -15px;
  padding: 7.5px 60px 7.5px 15px;
  font-size: 12px;
  font-weight: 100;
  line-height: 20px;
  text-transform: uppercase;
  color: var(--color-font-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.kz-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  font-size: 14px;
  color: var(--color-font-placeholder);
}
.kz-state--empty {
  font-size: 32px;
  color: var(--color-background-medium);
}
.kz-state--error {
  font-size: 14px;
  color: var(--color-font-secondary);
}
.kz-chart {
  flex: 1;
  min-height: 0;
}
.kz-chart svg {
  display: block;
  width: 100%;
  height: 100%;
}
.grid {
  stroke: var(--color-border-medium-light);
  stroke-width: 1;
}
.axis {
  fill: var(--color-background-dark);
  font-size: 10px;
}
.bar {
  fill: var(--color-viz-cat-1-primary);
}
.kz-legend {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  column-gap: 20px;
  row-gap: 10px;
  padding-top: 10px;
}
.kz-legend__item {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 10px;
  color: var(--color-font-primary);
}
.kz-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-viz-cat-1-primary);
}
.kz-note {
  font-size: 10px;
  color: var(--color-font-placeholder);
}
```
