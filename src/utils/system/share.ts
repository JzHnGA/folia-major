// src/utils/system/share.ts
// 系统分享的统一入口：原生壳走 Capacitor Share 插件的系统分享面板，支持 Web Share API 的
// 环境用 navigator.share，其余退化为复制到剪贴板。返回实际走的通路，提示语由调用方决定。

export interface SharePayload {
    title: string;
    text?: string;
    url?: string;
}

export type ShareOutcome = 'native' | 'web' | 'clipboard' | 'failed';

export const sharePayload = async (payload: SharePayload): Promise<ShareOutcome> => {
    const nativeShare = window.Capacitor?.isNativePlatform?.() === true ? window.Capacitor.Plugins?.Share : undefined;
    if (nativeShare) {
        try {
            await nativeShare.share({ ...payload, dialogTitle: payload.title });
        } catch (error) {
            // 取消也走 rejection，没有办法也不必区分：对面板来说这件事已经结束了。
            console.info('[Share] Native sheet closed', error);
        }
        return 'native';
    }
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        try {
            await navigator.share(payload);
        } catch {
            // AbortError 是用户取消，同样不需要上报。
        }
        return 'web';
    }
    try {
        await navigator.clipboard.writeText([payload.text, payload.url].filter(Boolean).join(' ') || payload.title);
        return 'clipboard';
    } catch (error) {
        console.warn('[Share] Clipboard fallback failed', error);
        return 'failed';
    }
};
