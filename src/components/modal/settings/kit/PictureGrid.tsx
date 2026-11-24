import React, { memo, useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { kitTransition, useKitReducedMotion } from './motion';
import { usePicturesInView } from './usePicturesInView';

// src/components/modal/settings/kit/PictureGrid.tsx
// A choice among many options that differ in look: pictures in a fixed number of columns, each
// with its name under it. One ring in the accent colour marks the chosen picture and slides to a
// new choice. The grid gives the 16 by 10 frame and the caller draws what is in it; for each
// picture the caller is told whether a person can see it at this moment, so a picture that moves
// can run only then. With more rows than its height holds, the grid scrolls inside itself and the
// last row in view fades. A row that scrolls sideways fades at each end that has more pictures past
// it and shows an arrow there; a press on an arrow scrolls that way by about a row. One arrow nudges:
// the one the person is scrolling towards, or, at either end of the row, the one pointing back in.
//
// It keeps 16px free at both sides: room for the ring and for its scrollbar. Where that room is
// there already, `className="-mx-4"` lines the pictures up with what is above them.
//
// Keyboard: Tab reaches the chosen picture only; the four arrows move the choice from the picture
// that has focus, Home and End jump to the first and the last picture. A grid whose choices are not
// to be passed through on the way (`arrowKeys="focus"`) moves only the focus with those keys: Enter,
// Space or a press chooses, and Tab stays with the picture that has focus.

/** Around the pictures, inside the grid: the ring is drawn 3px outside its picture. */
const RING_ROOM = 4;
/** How much of the grid's lower end fades while more rows follow. */
const FADE = 40;
const FADE_MASK = `linear-gradient(#000 calc(100% - ${FADE}px), transparent)`;
/** A sideways row's fade, at the ends that have more pictures past them. */
const horizontalFadeMask = (start: boolean, end: boolean) =>
    `linear-gradient(to right, ${start ? `transparent, #000 ${FADE}px` : '#000'}, ${end ? `#000 calc(100% - ${FADE}px), transparent` : '#000'})`;
/** Where the arrow of a sideways row sits: on the middle of the pictures (6.5rem wide, 16 by 10), past the 4px padding. */
const ARROW_TOP = 'calc(4px + 6.5rem * 5 / 16)';

export type PictureState = {
    /** On screen at this moment: in the part of the grid that shows, in a grid that is itself in view. */
    visible: boolean;
    chosen: boolean;
    /** The pointer is on it. */
    active: boolean;
};

type PictureGridProps<T extends string> = {
    value: T;
    options: ReadonlyArray<{ value: T; label: string }>;
    /**
     * Draws what is in a picture's frame. It is called again when that picture's state changes, and
     * for every picture when the function itself is a new one: give the same function each time (one
     * defined outside the component, or a useCallback).
     */
    picture: (value: T, state: PictureState) => React.ReactNode;
    columns: number;
    /** Called for a new choice, not for a click on the one already chosen. */
    onChange: (value: T) => void;
    /** What the grid chooses, for a screen reader. */
    label: string;
    /** The tallest the grid gets, in px. Left out in horizontal mode. */
    maxHeight?: number;
    /** One row that scrolls sideways, for a short set on a phone. Left out, it wraps into columns. */
    horizontal?: boolean;
    /** 'focus': the arrow keys, Home and End move the focus and choose nothing. Left out, they choose. */
    arrowKeys?: 'choose' | 'focus';
    className?: string;
};

type TileProps<T extends string> = PictureState & {
    value: T;
    label: string;
    picture: (value: T, state: PictureState) => React.ReactNode;
    /** Tab lands here. */
    tabStop: boolean;
    markId: string;
    reduced: boolean;
};

/** One picture with its name. It draws again only when its own state changes, not with every other tile. */
const Tile = memo(<T extends string>({ value, label, picture, tabStop, markId, reduced, ...state }: TileProps<T>) => (
    <button
        type="button"
        role="radio"
        aria-checked={state.chosen}
        data-value={value}
        tabIndex={tabStop ? 0 : -1}
        className="group flex min-w-0 flex-col rounded-lg text-xs leading-[18px]"
    >
        <span className="relative block aspect-[16/10] w-full">
            <span aria-hidden className="st-t-fast absolute inset-0 overflow-hidden rounded-lg bg-[var(--st-pv)] transition-transform group-active:scale-[0.97]">
                {picture(value, state)}
                <span className="pointer-events-none absolute inset-0 rounded-lg shadow-[inset_0_0_0_1px_var(--st-line)]" />
            </span>
            {state.chosen && (
                // One ring shared by the pictures: framer-motion moves it to the new choice.
                <motion.span
                    layoutId={markId}
                    layoutDependency={value}
                    transition={kitTransition('move', reduced)}
                    className="absolute -inset-[3px] rounded-[11px] shadow-[inset_0_0_0_2px_var(--st-accent)]"
                />
            )}
        </span>
        <span className={`st-t-fast mt-1.5 block w-full truncate text-center transition-colors ${state.chosen ? 'font-semibold text-[color:var(--st-t1)]' : 'text-[color:var(--st-t2)] group-hover:text-[color:var(--st-t1)]'}`}>
            {label}
        </span>
    </button>
)) as <T extends string>(props: TileProps<T>) => React.ReactElement;

export const PictureGrid = <T extends string>({ value, options, picture, columns, onChange, label, maxHeight, horizontal = false, arrowKeys = 'choose', className = '' }: PictureGridProps<T>): React.ReactElement => {
    const markId = useId();
    const reduced = useKitReducedMotion();
    const rootRef = useRef<HTMLDivElement>(null);
    const [pointed, setPointed] = useState<string | null>(null);
    const [more, setMore] = useState(false);
    // A sideways row only: more pictures to the left, and which of the two arrows nudges.
    const [back, setBack] = useState(false);
    const [nudge, setNudge] = useState<'back' | 'on'>('on');
    // Where the keys only move the focus: the picture that has it, while the focus is in the grid.
    const [focused, setFocused] = useState<string | null>(null);
    // The options as one text: what the effects below depend on, whatever array holds them.
    const values = options.map(option => option.value).join('\n');
    const chosenAt = options.findIndex(option => option.value === value);
    const focusedAt = focused === null ? -1 : options.findIndex(option => option.value === focused);
    const tabStopAt = focusedAt >= 0 ? focusedAt : Math.max(0, chosenAt);

    // Which pictures are on screen (usePicturesInView.ts).
    const seen = usePicturesInView(rootRef, values);

    // Where `settle` left the grid's scroll; null once a person has scrolled it since.
    const settledScroll = useRef<number | null>(null);
    // A sideways row: where it was scrolled to last, and the way it went then. Refs, so a scroll sets
    // state only when an arrow comes, goes or takes over the nudge.
    const lastScroll = useRef(0);
    const lastWay = useRef<'back' | 'on'>('on');

    // Brings the chosen picture into the part of the grid that shows, clear of the fade, and says
    // whether more rows follow under that part.
    const settle = useCallback((reveal: boolean) => {
        const root = rootRef.current;
        const tile = root?.querySelector<HTMLElement>('[aria-checked="true"]');
        if (!root) {
            return;
        }
        if (reveal && tile) {
            if (horizontal) {
                if (tile.offsetLeft - FADE < root.scrollLeft) {
                    root.scrollLeft = tile.offsetLeft - FADE;
                } else if (tile.offsetLeft + tile.offsetWidth > root.scrollLeft + root.clientWidth - FADE) {
                    root.scrollLeft = tile.offsetLeft + tile.offsetWidth - root.clientWidth + FADE;
                }
            } else if (tile.offsetTop - RING_ROOM < root.scrollTop) {
                root.scrollTop = tile.offsetTop - RING_ROOM;
            } else if (tile.offsetTop + tile.offsetHeight > root.scrollTop + root.clientHeight - FADE) {
                root.scrollTop = tile.offsetTop + tile.offsetHeight - root.clientHeight + FADE;
            }
        }
        if (reveal) {
            settledScroll.current = horizontal ? root.scrollLeft : root.scrollTop;
        }
        // Sideways, the gutters kept at both ends sit outside clientWidth but count in how far the row
        // scrolls, so the end is measured against the whole width of the grid.
        if (!horizontal) {
            setMore(root.scrollHeight - root.scrollTop - root.clientHeight > 2);
            return;
        }
        const left = root.scrollLeft;
        if (left !== lastScroll.current) {
            lastWay.current = left > lastScroll.current ? 'on' : 'back';
            lastScroll.current = left;
        }
        const on = root.scrollWidth - left - root.offsetWidth > 2;
        const backward = left > 2;
        setMore(on);
        setBack(backward);
        setNudge(!backward ? 'on' : !on ? 'back' : lastWay.current);
    }, [horizontal]);

    // On a new choice and a new set of options. A new size of the grid (a popover that is placed
    // after its grid was drawn gives it a smaller height) brings the chosen picture back into view
    // only while nobody has scrolled the grid: it does not scroll a grid a person is looking through.
    useLayoutEffect(() => {
        const root = rootRef.current;
        settle(true);
        if (!root || typeof ResizeObserver === 'undefined') {
            return undefined;
        }
        const observer = new ResizeObserver(() => settle(settledScroll.current !== null));
        observer.observe(root);
        return () => observer.disconnect();
    }, [value, values, columns, settle]);

    const valueAt = (target: EventTarget) => (target as Element).closest<HTMLElement>('[data-value]')?.dataset.value as T | undefined;

    // The keys the grid uses stop here, so nothing behind it acts on them as well.
    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        const { key } = event;
        // Enter and Space press the picture that has focus: nothing behind the grid acts on them (the
        // playing page's own keys), and the press itself is left to the browser.
        if (key === 'Enter' || key === ' ') {
            event.stopPropagation();
            return;
        }
        const last = options.length - 1;
        if (horizontal && (key === 'ArrowDown' || key === 'ArrowUp')) return;
        const step = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : key === 'ArrowDown' ? columns : key === 'ArrowUp' ? -columns : 0;
        if ((!step && key !== 'Home' && key !== 'End') || event.altKey || event.ctrlKey || event.metaKey) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        // Counted from the picture that has focus: the chosen one, unless the caller has not taken the last choice yet.
        const keyAt = options.findIndex(option => option.value === valueAt(event.target));
        const from = keyAt >= 0 ? keyAt : chosenAt;
        let next = key === 'Home' ? 0 : key === 'End' ? last : Math.max(0, from) + (from < 0 ? 0 : step);
        // Down from above a shorter last row goes to the last picture.
        if (step === columns && next > last && Math.floor(from / columns) < Math.floor(last / columns)) {
            next = last;
        }
        if (next < 0 || next > last || next === from) {
            return;
        }
        event.currentTarget.querySelectorAll<HTMLElement>('[data-value]')[next].focus();
        if (arrowKeys === 'choose' && next !== chosenAt) onChange(options[next].value);
    };

    // Scrolls a sideways row by most of what shows, so the picture cut off at that edge comes in whole.
    const scrollWay = (way: 'back' | 'on') => {
        const root = rootRef.current;
        if (!root) return;
        const by = Math.max(root.clientWidth - FADE * 2, root.clientWidth / 2);
        root.scrollBy({ left: way === 'on' ? by : -by, behavior: reduced ? 'auto' : 'smooth' });
    };
    const arrowClass = (shown: boolean) => `st-t-fast absolute z-10 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full bg-[var(--st-raise)] text-[color:var(--st-t1)] shadow-[0_0_0_1px_var(--st-line),0_2px_8px_rgba(0,0,0,0.18)] transition-opacity active:scale-95 ${shown ? 'opacity-100' : 'pointer-events-none opacity-0'}`;

    const grid = (
        // layoutScroll: the ring is measured inside a grid that may be scrolled.
        <motion.div
            ref={rootRef}
            layoutScroll
            role="radiogroup"
            aria-label={label}
            onClick={(event) => {
                const next = valueAt(event.target);
                if (next !== undefined && next !== value) onChange(next);
            }}
            onKeyDown={handleKeyDown}
            onFocus={arrowKeys === 'focus' ? event => setFocused(valueAt(event.target) ?? null) : undefined}
            onBlur={arrowKeys === 'focus' ? (event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setFocused(null);
            } : undefined}
            onPointerOver={event => setPointed(valueAt(event.target) ?? null)}
            onPointerLeave={() => setPointed(null)}
            onScroll={(event) => {
                const scroll = horizontal ? event.currentTarget.scrollLeft : event.currentTarget.scrollTop;
                if (settledScroll.current !== null && Math.abs(scroll - settledScroll.current) > 1) {
                    settledScroll.current = null;
                }
                settle(false);
            }}
            style={{
                ...(horizontal
                    ? { gridAutoFlow: 'column', gridAutoColumns: '6.5rem' }
                    : { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, maxHeight }),
                ...(horizontal
                    ? (more || back ? { maskImage: horizontalFadeMask(back, more), WebkitMaskImage: horizontalFadeMask(back, more) } : {})
                    : (more ? { maskImage: FADE_MASK, WebkitMaskImage: FADE_MASK } : {})),
            }}
            className={`st-scroll relative grid min-h-0 content-start gap-3 overscroll-contain p-1 [scrollbar-gutter:stable_both-edges] ${horizontal ? 'overflow-x-auto overflow-y-hidden' : 'overflow-y-auto'} ${className}`}
        >
            {options.map((option, index) => (
                <Tile
                    key={option.value}
                    value={option.value}
                    label={option.label}
                    picture={picture}
                    visible={seen.has(option.value)}
                    chosen={index === chosenAt}
                    active={option.value === pointed}
                    tabStop={index === tabStopAt}
                    markId={markId}
                    reduced={reduced}
                />
            ))}
        </motion.div>
    );

    if (!horizontal) {
        return grid;
    }
    return (
        <div className="relative min-w-0">
            {grid}
            {/* For the pointer only: the arrow keys already move along the row. */}
            <button type="button" tabIndex={-1} aria-hidden onClick={() => scrollWay('back')} style={{ top: ARROW_TOP }} className={`left-1 ${arrowClass(back)}`}>
                <ChevronLeft size={16} strokeWidth={2.4} className={back && nudge === 'back' && !reduced ? 'st-nudge-back' : undefined} />
            </button>
            <button type="button" tabIndex={-1} aria-hidden onClick={() => scrollWay('on')} style={{ top: ARROW_TOP }} className={`right-1 ${arrowClass(more)}`}>
                <ChevronRight size={16} strokeWidth={2.4} className={more && nudge === 'on' && !reduced ? 'st-nudge' : undefined} />
            </button>
        </div>
    );
};

export default PictureGrid;
