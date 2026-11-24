// src/components/app/player-swipe/playerSwipeGesture.ts
// 播放页左右滑动切歌的判定（纯规则，单测直接喂数字）：横向意图、切歌门槛与箭头跟手的位移。
// 左滑下一首、右滑上一首；竖直分量更大的手势留给页面滚动，不认。

export type PlayerTrackSwipeDirection = 'next' | 'prev';

/** 认成切歌的最小水平位移（px）。 */
export const PLAYER_SWIPE_MIN_DISTANCE = 68;
/** 水平位移相对竖直位移的最小倍数：保证是左右划，不是上下滚歌词。 */
export const PLAYER_SWIPE_HORIZONTAL_RATIO = 1.6;
/** 箭头跟手位移的上限（px）。 */
export const PLAYER_SWIPE_MAX_SHIFT = 88;
/** 开始点亮箭头的最小水平位移（px），比切歌门槛低。 */
export const PLAYER_SWIPE_INTENT_DISTANCE = 12;

/** 横向意图：用来点亮箭头，还没到切歌的门槛。 */
export const hasPlayerSwipeIntent = (dx: number, dy: number): boolean => (
    Math.abs(dx) >= PLAYER_SWIPE_INTENT_DISTANCE
    && Math.abs(dx) >= Math.abs(dy) * PLAYER_SWIPE_HORIZONTAL_RATIO
);

/** 松手时决定切不切、切哪边；不到门槛或更像上下滚动时是 null。 */
export const resolvePlayerSwipeDirection = (dx: number, dy: number): PlayerTrackSwipeDirection | null => {
    if (!hasPlayerSwipeIntent(dx, dy)) return null;
    if (Math.abs(dx) < PLAYER_SWIPE_MIN_DISTANCE) return null;
    return dx < 0 ? 'next' : 'prev';
};

/** 0..1 的进度，给箭头的不透明度 / 大小。 */
export const resolvePlayerSwipeProgress = (dx: number): number => (
    Math.min(1, Math.abs(dx) / PLAYER_SWIPE_MIN_DISTANCE)
);

/** 箭头跟手的位移：手指的一小截，夹在 ±MAX 里（往哪边滑，哪边的箭头跟着走）。 */
export const resolvePlayerSwipeShift = (dx: number): number => (
    Math.max(-PLAYER_SWIPE_MAX_SHIFT, Math.min(PLAYER_SWIPE_MAX_SHIFT, dx * 0.25))
);
