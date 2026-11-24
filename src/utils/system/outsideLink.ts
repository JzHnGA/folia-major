// src/utils/system/outsideLink.ts
// Opening a page outside the app, the one place that knows how: the desktop app hands the address
// to the system browser (a plain link would load it inside the app's own window), the native shell
// (iOS) hands it to the system so a link the platform's own app has claimed opens that app, and
// the web build opens a new tab.

/** Whether an outside address has to be handed to the desktop app instead of followed. */
export const opensThroughDesktopApp = (): boolean => Boolean(window.electron?.openExternalUrl);

/**
 * Opens `url` outside the app. For a button or a row; text that is a link uses the settings kit's Link.
 * The promise ends when the desktop app has taken the address (at once in the web build) and
 * rejects when the desktop app could not take it: a place that tells of that waits for it or catches it.
 */
export const openOutsideLink = async (url: string): Promise<void> => {
    if (window.electron?.openExternalUrl) {
        await window.electron.openExternalUrl(url);
        return;
    }
    // Native shell (iOS): hand the address to the system, so a universal link opens the platform's
    // own app instead of a browser page. Without the plugin (an old shell, or a browser pretending
    // to be native) fall through to a new tab.
    const appLauncher = window.Capacitor?.isNativePlatform?.() === true ? window.Capacitor.Plugins?.AppLauncher : undefined;
    if (appLauncher) {
        await appLauncher.openUrl({ url });
        return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
};
