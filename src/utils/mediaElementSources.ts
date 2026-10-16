// src/utils/mediaElementSources.ts

/** True while any media element on the page still has this URL as its source. */
export const isUrlOnAudioElement = (url: string) => {
    if (typeof document === 'undefined') return false;
    return Array.from(document.querySelectorAll('audio'))
        .some(element => element.getAttribute('src') === url || element.currentSrc === url);
};
