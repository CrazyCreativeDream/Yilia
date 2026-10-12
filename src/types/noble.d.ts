/**
 * Minimal ambient declaration for the optional @abandonware/noble package.
 * It is only imported lazily on platforms where it is installed (Windows),
 * so we intentionally type it loosely here.
 */
declare module '@abandonware/noble' {
  const noble: any
  export = noble
}
