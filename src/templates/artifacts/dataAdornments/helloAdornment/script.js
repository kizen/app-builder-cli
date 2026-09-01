// A data adornment is the small icon next to every field whose type matches
// `field_type` in config.json. Clicking the icon runs this script. The host
// discards the return value, so do your work through side effects like the
// toast below.

this.showToast('Hello from a data adornment.', { variant: 'success' });
