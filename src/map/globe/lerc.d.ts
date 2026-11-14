// Esri lerc@3 (pure JS, Apache-2.0) ships no typings.
declare module 'lerc' {
  const Lerc: {
    decode(
      input: ArrayBuffer,
      options?: { inputOffset?: number; noDataValue?: number; returnMask?: boolean },
    ): { width: number; height: number; pixels: ArrayLike<number>[]; mask?: Uint8Array | null; pixelType?: string };
  };
  export default Lerc;
}
