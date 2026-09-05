// One-shot escape hatch for a programmatic navigation/reload that's already
// been confirmed by the user through some other prompt (e.g. App.js's
// logOut, right after its own in-app <Prompt> was answered "leave"). Set
// immediately before the reload; a route component's own `beforeunload`
// listener consumes it so it doesn't ask the same question a second time --
// necessary because that component isn't guaranteed to have unmounted (and
// torn down its own listener) synchronously by the time reload() runs.
let skip = false;

export const skipNextUnsavedWarning = () => {
  skip = true;
};

export const consumeSkipUnsavedWarning = () => {
  const value = skip;
  skip = false;
  return value;
};
