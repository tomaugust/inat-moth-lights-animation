// Live binding shared by animation-engine.js, audio-engine.js and app.js.
// app.js calls setConfig() once the site config has been fetched; every
// other module reads the same up-to-date value through the `config` import.
export let config = null;

export function setConfig(value) {
  config = value;
}
