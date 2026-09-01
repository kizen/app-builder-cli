// A JS action shows up in the Perform Action menu of the object named by
// `hint_object_name` in config.json. Set that field to a real object api_name
// from your business; publishing an app with a blank value fails.
//
// To write to the record, call `this.patchWithErrors`, then
// `this.refreshEntity()` so the record page repaints with the new values.

this.showToast('Hello from a JS action.', { variant: 'success' });
