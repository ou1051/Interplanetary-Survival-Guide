// Must be imported before 'cesium' so Workers / Assets resolve next to the page.
// vite.config copies node_modules/cesium/Build/Cesium/{Workers,ThirdParty,Assets,Widgets}
// to ./cesium/ (served in dev, emitted in build).
declare global {
  interface Window {
    CESIUM_BASE_URL?: string;
  }
}
if (typeof window !== 'undefined' && !window.CESIUM_BASE_URL) {
  window.CESIUM_BASE_URL = new URL('./cesium/', document.baseURI).href;
}
export {};
