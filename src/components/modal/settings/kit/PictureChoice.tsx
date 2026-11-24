import React, { useId } from 'react';
import { motion } from 'framer-motion';
import { kitTransition, useKitReducedMotion } from './motion';
import { useRowAria } from './Row';
import { useSettingsDevice } from './device';

// src/components/modal/settings/kit/PictureChoice.tsx
// A choice between options that differ in look: each is a small picture with its name under it,
// and a frame in the accent colour marks the chosen one and slides to a new choice. The kit gives
// the 96 by 64 frame; the page draws what is in it, in code and with the kit's colour variables.

type PictureChoiceProps<T extends string> = {
    value: T;
    options: ReadonlyArray<{ value: T; label: string; picture: React.ReactNode }>;
    /** Called for a new choice, not for a click on the one already chosen. */
    onChange: (value: T) => void;
    disabled?: boolean;
    /**
     * Fit every option on one line in this many equal columns, shrinking the pictures with the
     * row. For a short, fixed set of choices (three views); long labels wrap under their picture.
     * Left out, the options keep their picture size and wrap onto further lines.
     */
    columns?: number;
};

export const PictureChoice = <T extends string>({ value, options, onChange, disabled, columns }: PictureChoiceProps<T>): React.ReactElement => {
    const markId = useId();
    const reduced = useKitReducedMotion();
    const { isMobile } = useSettingsDevice();
    const inline = columns !== undefined;
    // On a phone the wrapping layout would right-align fixed 96px tiles and leave the left of the row
    // empty; there the options fill the row's width instead, as many 6rem-or-wider columns as fit.
    const fill = !inline && isMobile;

    return (
        <div
            role="group"
            {...useRowAria()}
            aria-disabled={disabled || undefined}
            className={`${inline ? 'mt-4 grid w-[360px] max-w-full md:mt-0' : fill ? 'grid w-[100vw] max-w-full' : 'flex max-w-full flex-wrap justify-end'} gap-3 py-1${disabled ? ' pointer-events-none opacity-40' : ''}`}
            style={inline
                ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }
                : fill ? { gridTemplateColumns: 'repeat(auto-fill, minmax(6rem, 1fr))' } : undefined}
        >
            {options.map(option => {
                const selected = option.value === value;
                return (
                    <button
                        key={option.value}
                        type="button"
                        aria-pressed={selected}
                        disabled={disabled}
                        onClick={() => {
                            if (!selected) onChange(option.value);
                        }}
                        className={`group flex flex-col items-center gap-1.5 rounded-lg ${inline || fill ? 'w-full min-w-0' : 'min-w-24 max-w-[136px]'}`}
                    >
                        <span className={`relative block ${inline || fill ? 'aspect-[3/2] w-full' : 'h-16 w-24'}`}>
                            <span
                                aria-hidden
                                className={`st-t-fast absolute inset-0 overflow-hidden rounded-lg bg-[var(--st-pv)] shadow-[inset_0_0_0_1px_var(--st-line)] transition-opacity ${selected ? '' : 'opacity-70 group-hover:opacity-100'}`}
                            >
                                {option.picture}
                            </span>
                            {selected && (
                                // One frame shared by the options: framer-motion moves it to the new
                                // choice, and only when the choice changes.
                                <motion.span
                                    layoutId={markId}
                                    layoutDependency={value}
                                    transition={kitTransition('move', reduced)}
                                    className="absolute -inset-[3px] rounded-[11px] shadow-[inset_0_0_0_2px_var(--st-accent)]"
                                />
                            )}
                        </span>
                        <span className={`st-t-fast max-w-full text-center text-xs leading-4 transition-colors ${selected ? 'text-[color:var(--st-t1)]' : 'text-[color:var(--st-t2)] group-hover:text-[color:var(--st-t1)]'}`}>
                            {option.label}
                        </span>
                    </button>
                );
            })}
        </div>
    );
};

export default PictureChoice;
