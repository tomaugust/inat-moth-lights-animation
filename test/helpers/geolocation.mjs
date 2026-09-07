// Deterministically fakes navigator.geolocation for a Playwright page,
// bypassing headless Chromium's real permission-prompt plumbing entirely
// (which, with no stub and no granted permission, never invokes either
// getCurrentPosition callback and hangs indefinitely instead of erroring).
export async function stubGeolocation(page, { latitude = 51.5074, longitude = -0.1278, error } = {}) {
  await page.addInitScript(
    ({ lat, lng, geoError }) => {
      // navigator.geolocation is a getter-only accessor on the prototype, so
      // a plain assignment silently no-ops — defineProperty is required to
      // actually replace it with a deterministic fake.
      Object.defineProperty(window.navigator, "geolocation", {
        configurable: true,
        value: {
          getCurrentPosition(onSuccess, onError) {
            if (geoError) {
              onError(geoError);
            } else {
              onSuccess({ coords: { latitude: lat, longitude: lng } });
            }
          }
        }
      });
    },
    { lat: latitude, lng: longitude, geoError: error }
  );
}
