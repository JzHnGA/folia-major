import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, ScanFace, ShieldCheck, X, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Theme } from '../../types';
import { useSafeAreaBottomPx } from '../../hooks/useSafeAreaBottomPx';
import { useIsLandscape } from '../nightstand/useIsLandscape';
import { useAppViewStore } from '../../stores/useAppViewStore';
import { closeSettings, openSettings, useSettingsModalStore } from '../../stores/useSettingsModalStore';
import { hasBlockingWindow, hasOpenSheet } from '../../utils/keyboardTargets';
import { useMobileTutorialStore } from '../../stores/useMobileTutorialStore';
import ScratchpadDragDemo from './ScratchpadDragDemo';

// src/components/mobile-tutorial/MobileTutorialHost.tsx
// iOS 的手机新手教程（Ponder 在 iOS 构建里不挂载）：首启自动打开一次，之后可在设置里重播。
// 每一步高亮真实控件：四周压暗、目标留一个亮框，说明卡贴在目标的反方向（目标在下半屏就放顶部）。
// 目标不在（例如还没有在播歌曲）时退回居中卡片，步骤照常走。
// 直达按钮打开设置时教程不收起：去掉压暗、让触摸穿透到设置页，只留一张精简卡片在底部，用户看完再继续下一步。

type TutorialStep = {
    id: 'tabs' | 'account' | 'sync' | 'faceId' | 'search' | 'tools' | 'scratchpad' | 'player';
    target: string | null;
    titleKey: string;
    bodyKey: string;
    /** 这一步自带的去处：按下后打开对应的设置页，教程缩成底部的小卡片继续陪着走完。 */
    action?: {
        labelKey: string;
        icon: LucideIcon;
        open: () => void;
        /** 打开设置后要指给用户看的那一行：教程在设置上方给它套一个一直闪的框，滚到卡片上方看得见的地方。 */
        visitTarget?: string;
        /** 设置里的精简卡片上那一句「做什么」。 */
        visitHintKey?: string;
    };
};

const STEPS: readonly TutorialStep[] = [
    {
        id: 'tabs',
        target: '[data-bravais-home-seam]',
        titleKey: 'mobileTutorial.steps.tabs.title',
        bodyKey: 'mobileTutorial.steps.tabs.body',
    },
    {
        id: 'account',
        target: '[data-bravais-account-toggle]',
        titleKey: 'mobileTutorial.steps.account.title',
        bodyKey: 'mobileTutorial.steps.account.body',
    },
    {
        // 云端账户同步在「设置 › 账户与安全」，首页没有对应控件可高亮，用居中卡片加一个直达按钮。
        id: 'sync',
        target: null,
        titleKey: 'mobileTutorial.steps.sync.title',
        bodyKey: 'mobileTutorial.steps.sync.body',
        action: {
            labelKey: 'mobileTutorial.steps.sync.action',
            icon: ShieldCheck,
            open: () => openSettings('account', null, 'securityAccount', 'securityGoogle'),
            visitTarget: '[data-settings-row="securityGoogle"]',
            visitHintKey: 'mobileTutorial.steps.sync.visitHint',
        },
    },
    {
        // Face ID 锁在同一页的「Face ID 锁」分组；直达按钮落到那一组的开关上，而不是页顶。
        id: 'faceId',
        target: null,
        titleKey: 'mobileTutorial.steps.faceId.title',
        bodyKey: 'mobileTutorial.steps.faceId.body',
        action: {
            labelKey: 'mobileTutorial.steps.faceId.action',
            icon: ScanFace,
            open: () => openSettings('account', null, 'securityLock', 'securityLockToggle'),
            visitTarget: '[data-settings-row="securityLockToggle"]',
            visitHintKey: 'mobileTutorial.steps.faceId.visitHint',
        },
    },
    {
        id: 'search',
        target: '[data-bravais-seam-action="search"]',
        titleKey: 'mobileTutorial.steps.search.title',
        bodyKey: 'mobileTutorial.steps.search.body',
    },
    {
        id: 'tools',
        target: '[data-bravais-seam-action="queue"]',
        titleKey: 'mobileTutorial.steps.tools.title',
        bodyKey: 'mobileTutorial.steps.tools.body',
    },
    {
        // 速记簿的把手（ScratchpadTouchTab）：高亮它，另放一段循环的示范——手指按住、拖着它的影子挪到别的边上（ScratchpadDragDemo）。
        id: 'scratchpad',
        target: '[data-mobile-tutorial="scratchpad"]',
        titleKey: 'mobileTutorial.steps.scratchpad.title',
        bodyKey: 'mobileTutorial.steps.scratchpad.body',
    },
    {
        id: 'player',
        target: '[data-mobile-tutorial="player"]',
        titleKey: 'mobileTutorial.steps.player.title',
        bodyKey: 'mobileTutorial.steps.player.body',
    },
];

type SpotlightRect = { left: number; top: number; width: number; height: number };

const readRect = (selector: string | null): SpotlightRect | null => {
    if (!selector || typeof document === 'undefined') return null;
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
};

export const MobileTutorialHost: React.FC<{ theme: Theme; isDaylight: boolean }> = ({ theme, isDaylight }) => {
    const { t } = useTranslation();
    const isOpen = useMobileTutorialStore(state => state.isOpen);
    const hasSeen = useMobileTutorialStore(state => state.hasSeen);
    const stepIndex = useMobileTutorialStore(state => state.step);
    const close = useMobileTutorialStore(state => state.close);
    const next = useMobileTutorialStore(state => state.next);
    const back = useMobileTutorialStore(state => state.back);
    const view = useAppViewStore(state => state.view);
    const isLandscape = useIsLandscape();
    const safeBottom = useSafeAreaBottomPx();
    const cardRef = useRef<HTMLDivElement>(null);
    const [rect, setRect] = useState<SpotlightRect | null>(null);
    const step = STEPS[Math.min(stepIndex, STEPS.length - 1)];
    const isLast = stepIndex >= STEPS.length - 1;
    const action = step.action;
    // 设置开着（多半是这一步的直达按钮打开的）：教程让出屏幕，只留精简卡片。
    const settingsOpen = useSettingsModalStore(state => state.settingsModalState.isOpen);
    const visiting = isOpen && settingsOpen;

    // 首启：首页、竖屏、没有弹窗时打开一次。墙/信息条可能晚一拍挂上，短暂重试。
    useEffect(() => {
        if (hasSeen || isOpen || isLandscape || view !== 'home') return undefined;
        let attempts = 0;
        const timer = window.setInterval(() => {
            const state = useMobileTutorialStore.getState();
            if (state.isOpen) {
                window.clearInterval(timer);
                return;
            }
            if (hasBlockingWindow() || hasOpenSheet()) return;
            if (document.querySelector('[data-bravais-home-seam]')) {
                window.clearInterval(timer);
                state.open();
                return;
            }
            attempts += 1;
            if (attempts >= 12) window.clearInterval(timer);
        }, 400);
        return () => window.clearInterval(timer);
    }, [hasSeen, isLandscape, isOpen, view]);

    // 跟住目标：换步、转屏、墙的窄缝重排都会移动它。
    useLayoutEffect(() => {
        if (!isOpen) {
            setRect(null);
            return undefined;
        }
        const measure = () => setRect(readRect(visiting ? step.action?.visitTarget ?? null : step.target));
        measure();
        const timer = window.setInterval(measure, 300);
        window.addEventListener('resize', measure);
        window.addEventListener('orientationchange', measure);
        return () => {
            window.clearInterval(timer);
            window.removeEventListener('resize', measure);
            window.removeEventListener('orientationchange', measure);
        };
    }, [isOpen, step.target, step.action?.visitTarget, visiting]);

    // 在设置里：等目标那一行画出来，把它滚到精简卡片上方看得见的地方（只滚一次，之后由用户自己滚）。
    useEffect(() => {
        const selector = visiting ? step.action?.visitTarget : undefined;
        if (!selector) return undefined;
        let attempts = 0;
        const timer = window.setInterval(() => {
            attempts += 1;
            const row = document.querySelector<HTMLElement>(selector);
            if (row) {
                window.clearInterval(timer);
                const cardTop = cardRef.current?.getBoundingClientRect().top ?? window.innerHeight;
                const box = row.getBoundingClientRect();
                if (box.top < 80 || box.bottom > cardTop - 16) {
                    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
                }
            } else if (attempts > 20) {
                window.clearInterval(timer);
            }
        }, 250);
        return () => window.clearInterval(timer);
    }, [visiting, step.action?.visitTarget]);

    useEffect(() => {
        if (!isOpen) return undefined;
        const onKeyDown = (event: KeyboardEvent) => {
            // 设置开着时 Escape 交给设置自己关掉，教程留着。
            if (event.key === 'Escape' && !useSettingsModalStore.getState().settingsModalState.isOpen) {
                event.preventDefault();
                close();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [close, isOpen]);

    useEffect(() => {
        if (isOpen) cardRef.current?.focus({ preventScroll: true });
    }, [isOpen, stepIndex]);

    // 第一步（信息条）：依次把每个缩成字母的页签展开成全名再收回，用动作告诉用户字母是什么；循环到离开这一步。
    useEffect(() => {
        if (!isOpen || step.id !== 'tabs') return undefined;
        const { setPreviewTabKey, setPreviewingTabs } = useMobileTutorialStore.getState();
        const keys = Array.from(document.querySelectorAll<HTMLElement>('[data-bravais-home-seam] [data-bravais-tab-short="true"]'))
            .map(element => element.dataset.bravaisTab)
            .filter((key): key is string => Boolean(key));
        if (keys.length === 0) return undefined;
        setPreviewingTabs(true);
        let index = 0;
        let timer = 0;
        const showNext = () => {
            setPreviewTabKey(keys[index % keys.length]);
            index += 1;
            timer = window.setTimeout(() => {
                setPreviewTabKey(null);
                timer = window.setTimeout(showNext, 450);
            }, 1500);
        };
        timer = window.setTimeout(showNext, 600);
        return () => {
            window.clearTimeout(timer);
            setPreviewTabKey(null);
            setPreviewingTabs(false);
        };
    }, [isOpen, step.id]);

    // 设置开着时换步：要去的那一步若有自己在设置里的去处（同步 → Face ID），直接把设置带到那里，用户不必回首页
    // 再按一次直达按钮（在设置里时精简卡片上没有那个按钮）；没有去处的那一步先关掉设置，好让它高亮首页上的控件。
    const leaveSettingsFor = useCallback((targetIndex: number) => {
        if (!useSettingsModalStore.getState().settingsModalState.isOpen) return;
        const target = STEPS[Math.min(Math.max(0, targetIndex), STEPS.length - 1)];
        if (target.action) {
            target.action.open();
        } else {
            closeSettings();
        }
    }, []);

    const goNext = useCallback(() => {
        if (isLast) {
            close();
        } else {
            leaveSettingsFor(stepIndex + 1);
            next(STEPS.length);
        }
    }, [close, isLast, leaveSettingsFor, next, stepIndex]);

    const goBack = useCallback(() => {
        leaveSettingsFor(stepIndex - 1);
        back();
    }, [back, leaveSettingsFor, stepIndex]);

    if (!isOpen || typeof document === 'undefined') return null;

    // 目标在下半屏时说明卡放上面，避免盖住正在高亮的控件。
    const cardAtTop = !visiting && rect !== null && rect.top > window.innerHeight * 0.55;
    const accent = theme.accentColor || (isDaylight ? '#18181b' : '#f4f4f5');
    const cardBg = isDaylight ? 'rgba(255,255,255,0.96)' : 'rgba(24,24,27,0.94)';
    const cardInk = isDaylight ? '#18181b' : '#f4f4f5';

    return createPortal(
        <div
            data-testid="mobile-tutorial"
            data-mobile-tutorial-step={step.id}
            data-mobile-tutorial-visiting={visiting ? 'true' : undefined}
            data-folia-keyboard-window={visiting ? undefined : 'true'}
            role="dialog"
            aria-modal={visiting ? undefined : 'true'}
            aria-labelledby="mobile-tutorial-title"
            className={`fixed inset-0 z-[210] overflow-hidden${visiting ? ' pointer-events-none' : ''}`}
            style={{ color: cardInk }}
        >
            {/* 压暗层：目标留一个洞；没有目标时整屏压暗；在设置里时不压暗，只给要找的那一行套一个一直闪的框。 */}
            {visiting ? (rect && (
                <motion.div
                    aria-hidden="true"
                    data-testid="mobile-tutorial-visit-ring"
                    className="pointer-events-none absolute rounded-2xl"
                    style={{
                        left: rect.left - 6,
                        top: rect.top - 6,
                        width: rect.width + 12,
                        height: rect.height + 12,
                        border: `2px solid color-mix(in srgb, ${accent} 78%, white)`,
                    }}
                    initial={{ opacity: 0 }}
                    animate={{
                        opacity: [0.35, 1, 0.35],
                        boxShadow: [
                            `0 0 0 0px color-mix(in srgb, ${accent} 40%, transparent)`,
                            `0 0 0 8px color-mix(in srgb, ${accent} 0%, transparent)`,
                            `0 0 0 0px color-mix(in srgb, ${accent} 0%, transparent)`,
                        ],
                    }}
                    transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
                />
            )) : rect ? (
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute rounded-2xl"
                    style={{
                        left: rect.left - 8,
                        top: rect.top - 8,
                        width: rect.width + 16,
                        height: rect.height + 16,
                        boxShadow: '0 0 0 9999px rgba(0,0,0,0.74)',
                        border: `2px solid color-mix(in srgb, ${accent} 78%, white)`,
                    }}
                />
            ) : (
                <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-black/74" />
            )}

            {step.id === 'scratchpad' && !visiting && <ScratchpadDragDemo from={rect} cardAtTop={cardAtTop} />}

            <motion.div
                ref={cardRef}
                tabIndex={-1}
                initial={{ opacity: 0, y: cardAtTop ? -10 : 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className={`pointer-events-auto absolute inset-x-0 mx-auto flex w-[min(28rem,calc(100vw-1.5rem))] flex-col rounded-3xl border shadow-2xl backdrop-blur-2xl outline-none ${visiting ? 'p-4' : 'p-5'}`}
                style={{
                    top: cardAtTop ? 'max(1.25rem, env(safe-area-inset-top))' : undefined,
                    bottom: cardAtTop ? undefined : `max(1.25rem, calc(${safeBottom}px + 0.75rem))`,
                    backgroundColor: cardBg,
                    borderColor: 'color-mix(in srgb, currentColor 16%, transparent)',
                }}
            >
                <div className="flex items-start justify-between gap-3">
                    <span className="text-xs font-semibold uppercase tracking-[0.14em] opacity-50">
                        {t('mobileTutorial.step', { current: stepIndex + 1, total: STEPS.length })}
                    </span>
                    <button
                        type="button"
                        onClick={close}
                        aria-label={t('mobileTutorial.skip')}
                        className="-mr-1 -mt-1 grid h-11 w-11 place-items-center rounded-full opacity-60 transition-opacity hover:opacity-100"
                    >
                        <X size={18} aria-hidden="true" />
                    </button>
                </div>
                <h2 id="mobile-tutorial-title" className="mt-2 text-xl font-bold leading-7">
                    {t(step.titleKey)}
                </h2>
                {!visiting && <p className="mt-2 text-sm leading-6 opacity-70">{t(step.bodyKey)}</p>}
                {visiting && action?.visitHintKey && <p className="mt-1.5 text-sm leading-6 opacity-75">{t(action.visitHintKey)}</p>}

                {action && !visiting && (
                    <button
                        type="button"
                        data-testid={`mobile-tutorial-action-${step.id}`}
                        onClick={action.open}
                        className="mt-4 inline-flex h-11 items-center justify-center gap-2 self-start rounded-full border px-4 text-sm font-medium transition-transform active:scale-95"
                        style={{ borderColor: accent, color: accent }}
                    >
                        <action.icon size={17} aria-hidden="true" />
                        {t(action.labelKey)}
                    </button>
                )}

                <div className="mt-4 flex items-center gap-1.5" aria-hidden="true">
                    {STEPS.map((item, index) => (
                        <span
                            key={item.id}
                            className="h-1.5 rounded-full transition-all"
                            style={{
                                width: index === stepIndex ? 18 : 6,
                                backgroundColor: index === stepIndex ? accent : 'color-mix(in srgb, currentColor 24%, transparent)',
                            }}
                        />
                    ))}
                </div>

                <div className="mt-4 flex items-center justify-between gap-2">
                    <button
                        type="button"
                        onClick={goBack}
                        disabled={stepIndex === 0}
                        className="inline-flex h-11 items-center gap-1 rounded-full px-3 text-sm font-medium opacity-70 transition-opacity disabled:opacity-25"
                    >
                        <ChevronLeft size={18} aria-hidden="true" />
                        {t('mobileTutorial.back')}
                    </button>
                    <button
                        type="button"
                        onClick={goNext}
                        className="inline-flex h-11 items-center gap-1.5 rounded-full px-5 text-sm font-semibold"
                        style={{ backgroundColor: accent, color: isDaylight ? '#fff' : '#09090b' }}
                    >
                        {isLast ? t('mobileTutorial.done') : t('mobileTutorial.next')}
                        {!isLast && <ChevronRight size={18} aria-hidden="true" />}
                    </button>
                </div>
            </motion.div>
        </div>,
        document.body,
    );
};

export default MobileTutorialHost;
