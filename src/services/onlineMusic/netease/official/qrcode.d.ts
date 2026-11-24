// src/services/onlineMusic/netease/official/qrcode.d.ts
// The one function of the `qrcode` package the official login uses (the package ships no types).
declare module 'qrcode' {
    export function toDataURL(text: string, options?: { width?: number; margin?: number; errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' }): Promise<string>;
}
