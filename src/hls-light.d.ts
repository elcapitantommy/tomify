// hls.js publishes its light build without types; it has the same API as the full build.
declare module 'hls.js/light' {
  export * from 'hls.js'
  export { default } from 'hls.js'
}
