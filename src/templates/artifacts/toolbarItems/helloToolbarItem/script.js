// Runs when someone picks this item from the global toolbar. Toolbar items
// render no UI of their own, so do your work through side effects like the
// toast below.
//
// Keep this file non-empty. Publishing an app requires a non-blank script for
// toolbar items.

this.showToast('Hello from a toolbar item.', { variant: 'success' });
