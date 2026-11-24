import { useEffect, useRef, type MutableRefObject } from 'react';
import type { WallSlot } from '../../../components/wall/wallSlots';
import { isNightstandSupported } from '../../../components/nightstand/nightstandPlatform';
import { selectDisplayPlayerState, usePlaybackStore } from '../../../stores/usePlaybackStore';
import { PlayerState } from '../../../types';
import { resolveSlotItem, type BravaisDisplay } from './bravaisDisplay';
import { findDisplayItemSlot } from './bravaisItemSlots';
import {
    armBravaisPlayingCard,
    disarmBravaisPlayingCard,
    readBravaisPlayingCard,
    type BravaisPlayingCard,
} from './bravaisPlayingCard';
import { bravaisSlotFromKey } from './useBravaisInteractions';
import type { useBravaisFocus } from './useBravaisFocus';
import type { BravaisFrameState } from './useBravaisFrame';
import { seamPointOf } from './bravaisAnchor';

// src/library/suites/bravais/useBravaisPlayingCard.ts
// 实测反馈 fb3：从墙上播放之后，那首歌的聚焦卡保持展开；从播放页、Lattice、别的视图回来（stage 重新挂载）或返回到这一层时，
// 正在播放的那首也是展开的。记忆（层 key + 条目 key）在 bravaisPlayingCard（sessionStorage，跨 stage 卸载）。
// - 恢复：stage 挂载（first / enter）或回到一层（back / exit）之后，墙落定（翻牌 / 整墙入场放完）时，若记忆是这一层的、
//   这一层里有正在播放的那首，就在键盘焦点所在的那一份（它正是那首时）或离缝最近的那一份上展开，键盘焦点一并落上去
//   （焦点写回会话的 focusedEntryKey，与点开一张卡相同），相机最小平移让它可见（focus.expand 的 reveal）。正在播放的
//   换成了同一层里的另一首（自动切歌）时展开新的那首并改记它。这一层里没有正在播放的歌就不展开。push / replace
//   是新打开的层，不恢复。数据还没到（空层、首屏加载）时等它到了再看。
// - 失效：同一次显示里（没换层）聚焦卡被收起、或换成了别的歌（用户 Esc、点空白墙面、点开另一首），不再保持。换层时
//   stage 自己收起聚焦卡，那不算；记忆留着，返回时照样恢复。

type BravaisFocus = ReturnType<typeof useBravaisFocus>;

/** 换层之后要看一眼要不要恢复的几种：stage 挂载与回到一层。 */
const RESTORING_SHIFTS: ReadonlySet<string> = new Set(['first', 'enter', 'back', 'exit']);

export type BravaisPlayingCardRestore =
    | { kind: 'skip' }
    | { kind: 'wait' }
    | { kind: 'expand'; slot: WallSlot; entryKey: string };

/** 纯规则：这一次显示要不要、在哪一个 slot 上展开正在播放的那首。 */
export const resolveBravaisPlayingCardRestore = ({
    memory,
    display,
    focusedSlotKey,
    near,
}: {
    memory: BravaisPlayingCard | null;
    display: BravaisDisplay;
    focusedSlotKey: string | null;
    /** 缝的基准点（锚点 x 与视图中心 y）：没有合适的焦点时取离它最近的一份。 */
    near: { x: number; y: number };
}): BravaisPlayingCardRestore => {
    const { layer } = display;
    if (!memory || memory.layerKey !== layer.key) return { kind: 'skip' };
    if (layer.items.length === 0 || layer.wall?.loading) return { kind: 'wait' };
    const entryKey = layer.nowPlayingKey;
    if (!entryKey) return { kind: 'skip' };
    const focused = bravaisSlotFromKey(focusedSlotKey, display.shape);
    const slot = focused && resolveSlotItem(display, focused)?.key === entryKey
        ? focused
        : findDisplayItemSlot(display, entryKey, near);
    return slot ? { kind: 'expand', slot, entryKey } : { kind: 'skip' };
};

export const useBravaisPlayingCard = ({
    display,
    isSettling,
    focus,
    frameRef,
}: {
    display: BravaisDisplay | null;
    isSettling: boolean;
    focus: BravaisFocus;
    frameRef: MutableRefObject<BravaisFrameState>;
}) => {
    const seq = display?.shift?.seq ?? null;
    const kind = display?.shift?.kind ?? null;
    /** 等着恢复的那一次换层（序号）；处理过就清掉。 */
    const pendingSeqRef = useRef<number | null>(null);
    const { focusSlot, expand, focusedRef, expandedSlotKey } = focus;

    useEffect(() => {
        pendingSeqRef.current = seq !== null && kind !== null && RESTORING_SHIFTS.has(kind) ? seq : null;
    }, [kind, seq]);

    useEffect(() => {
        if (!display || isSettling || seq === null || pendingSeqRef.current !== seq) return;
        const memory = readBravaisPlayingCard();
        const decision = resolveBravaisPlayingCardRestore({
            memory,
            display,
            focusedSlotKey: focusedRef.current,
            near: seamPointOf(frameRef.current),
        });
        if (decision.kind === 'wait') return;
        pendingSeqRef.current = null;
        if (decision.kind !== 'expand') return;
        if (memory?.entryKey !== decision.entryKey) armBravaisPlayingCard(display.layer.key, decision.entryKey);
        focusSlot(decision.slot);
        expand(decision.slot);
    }, [display, expand, focusSlot, focusedRef, frameRef, isSettling, seq]);

    // Nightstand（iOS 壳 / ?nightstand=1）：音乐一播放就自动展开正在播放的那张聚焦卡（含自动切歌换到新的一首），
    // 不用先离开再回来。用户在同一首歌期间手动收起或点开别的卡，这首歌就不再强行展开；换歌后重新允许。
    const playerState = usePlaybackStore(selectDisplayPlayerState);
    /** 本次自动展开的是哪一首（用来分辨「用户收起了我们展开的卡」）。 */
    const autoExpandedEntryRef = useRef<string | null>(null);
    /** 被用户收起过、不再自动展开的那一首。 */
    const suppressedEntryRef = useRef<string | null>(null);

    useEffect(() => {
        if (!isNightstandSupported()) return;
        const entryKey = display?.layer.nowPlayingKey ?? null;
        if (!entryKey) {
            autoExpandedEntryRef.current = null;
            suppressedEntryRef.current = null;
            return;
        }
        // 换歌：上一首的收起记录作废。
        if (suppressedEntryRef.current && suppressedEntryRef.current !== entryKey) {
            suppressedEntryRef.current = null;
        }
        if (!display) return;
        const slot = bravaisSlotFromKey(expandedSlotKey, display.shape);
        const expandedKey = slot ? resolveSlotItem(display, slot)?.key ?? null : null;
        if (expandedKey === entryKey) return;
        // 展开的不再是这首：若这张卡是我们自动展开的，说明用户手动收起/移开了，这首歌期间尊重他。
        if (autoExpandedEntryRef.current === entryKey) {
            autoExpandedEntryRef.current = null;
            suppressedEntryRef.current = entryKey;
        }
    }, [display, expandedSlotKey]);

    useEffect(() => {
        if (!isNightstandSupported()) return;
        if (!display || isSettling || playerState !== PlayerState.PLAYING) return;
        const entryKey = display.layer.nowPlayingKey;
        if (!entryKey || suppressedEntryRef.current === entryKey) return;
        const expandedSlot = bravaisSlotFromKey(expandedSlotKey, display.shape);
        if (expandedSlot && resolveSlotItem(display, expandedSlot)?.key === entryKey) return;
        const slot = findDisplayItemSlot(display, entryKey, seamPointOf(frameRef.current));
        if (!slot) return;
        armBravaisPlayingCard(display.layer.key, entryKey);
        autoExpandedEntryRef.current = entryKey;
        focusSlot(slot);
        expand(slot);
    }, [display, expand, expandedSlotKey, focusSlot, frameRef, isSettling, playerState]);

    // 失效：只看同一次显示里聚焦卡的变化（换层那次提交里 stage 收起聚焦卡，序号也变了，跳过）。
    const observedRef = useRef<{ seq: number | null; expanded: string | null }>({ seq, expanded: expandedSlotKey });
    const displayRef = useRef(display);
    displayRef.current = display;
    useEffect(() => {
        const observed = observedRef.current;
        observedRef.current = { seq, expanded: expandedSlotKey };
        if (observed.seq !== seq || observed.expanded === expandedSlotKey) return;
        const current = displayRef.current;
        const memory = readBravaisPlayingCard();
        if (!current || !memory || memory.layerKey !== current.layer.key) return;
        const slot = bravaisSlotFromKey(expandedSlotKey, current.shape);
        const key = slot ? resolveSlotItem(current, slot)?.key ?? null : null;
        if (key !== memory.entryKey) disarmBravaisPlayingCard();
    }, [expandedSlotKey, seq]);
};
