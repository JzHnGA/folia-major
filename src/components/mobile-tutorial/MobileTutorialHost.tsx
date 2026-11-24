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
import NightstandRotateDemo from './NightstandRotateDemo';
import ScratchpadDragDemo from './ScratchpadDragDemo';
import { TutorialDemo, type TutorialDemoId } from './TutorialDemos';

// src/components/mobile-tutorial/MobileTutorialHost.tsx
// iOS 的手机新手教程（Ponder 在 iOS 构建里不挂载）：首启自动打开一次，之后可在设置里重播。
// 每一步高亮真实控件：四周压暗、目标留一个亮框，说明卡贴在目标的反方向（目标在下半屏就放顶部）。
// 目标不在（例如还没有在播歌曲）时退回居中卡片，步骤照常走。
// 直达按钮打开设置时教程不收起：去掉压暗、让触摸穿透到设置页，只留一张精简卡片在底部，用户看完再继续下一步。
// 多数步骤在卡片顶部带一段循环的示范动画（TutorialDemos）：手指点、划、拖，画面跟着变；按「认识 → 播放 → 整理 →
// 账户 → 床头钟」的顺序走，既教会基本操作，也把好看的部分演给人看。

type TutorialStep = {
    id: 'welcome' | 'tabs' | 'search' | 'wallPlay' | 'barTap' | 'barSwipe' | 'barExpand' | 'scratchpad' | 'tools'
        | 'account' | 'sync' | 'faceId' | 'nightstand' | 'widgets' | 'finish';
    target: string | null;
    /** 目标在信息条里：信息条折叠到屏幕边上（或被收起）时，先把它在屏内重新张开，再高亮。 */
    inStrip?: boolean;
    titleKey: string;
    bodyKey: string;
    /** 卡片顶部的示范动画。 */
    demo?: TutorialDemoId;
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
        // 开场：不指任何控件，先把墙和歌词演一遍，告诉用户接下来几步是什么。
        id: 'welcome',
        target: null,
        titleKey: 'mobileTutorial.steps.welcome.title',
        bodyKey: 'mobileTutorial.steps.welcome.body',
        demo: 'welcome',
    },
    {
        id: 'tabs',
        inStrip: true,
        target: '[data-bravais-home-seam]',
        titleKey: 'mobileTutorial.steps.tabs.title',
        bodyKey: 'mobileTutorial.steps.tabs.body',
    },
    {
        id: 'search',
        inStrip: true,
        target: '[data-bravais-seam-action="search"]',
        titleKey: 'mobileTutorial.steps.search.title',
        bodyKey: 'mobileTutorial.steps.search.body',
        demo: 'search',
    },
    {
        // 墙上点封面就地播放（「播放后进入的视图」默认留在原处）：示范画面里那张卡亮起暂停标记，不跳页。
        id: 'wallPlay',
        target: null,
        titleKey: 'mobileTutorial.steps.wallPlay.title',
        bodyKey: 'mobileTutorial.steps.wallPlay.body',
        demo: 'wallPlay',
    },
    {
        // 底部播放条：点它进可视化歌词；已经在播放页时这一下把它展开。还没有在播的歌时播放条不在，退回居中卡片。
        id: 'barTap',
        target: '[data-mobile-tutorial="player"]',
        titleKey: 'mobileTutorial.steps.barTap.title',
        bodyKey: 'mobileTutorial.steps.barTap.body',
        demo: 'barTap',
    },
    {
        // 播放条上左右划切歌，收起着也能划；播放页整屏左右划也一样。
        id: 'barSwipe',
        target: '[data-mobile-tutorial="player"]',
        titleKey: 'mobileTutorial.steps.barSwipe.title',
        bodyKey: 'mobileTutorial.steps.barSwipe.body',
        demo: 'barSwipe',
    },
    {
        // 播放条上滑展开（歌手、按钮那一排），下滑收起。
        id: 'barExpand',
        target: '[data-mobile-tutorial="player"]',
        titleKey: 'mobileTutorial.steps.barExpand.title',
        bodyKey: 'mobileTutorial.steps.barExpand.body',
        demo: 'barExpand',
    },
    {
        // 速记簿的把手（ScratchpadTouchTab）：高亮它，另放一段循环的示范——手指按住、拖着它的影子挪到别的边上（ScratchpadDragDemo）。
        id: 'scratchpad',
        target: '[data-mobile-tutorial="scratchpad"]',
        titleKey: 'mobileTutorial.steps.scratchpad.title',
        bodyKey: 'mobileTutorial.steps.scratchpad.body',
    },
    {
        id: 'tools',
        inStrip: true,
        target: '[data-bravais-seam-action="queue"]',
        titleKey: 'mobileTutorial.steps.tools.title',
        bodyKey: 'mobileTutorial.steps.tools.body',
    },
    {
        id: 'account',
        inStrip: true,
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
        // 横过来进床头钟：可视化歌词只在横屏里进，用转向示范动画（NightstandRotateDemo）画在卡片上方。
        id: 'nightstand',
        target: null,
        titleKey: 'mobileTutorial.steps.nightstand.title',
        bodyKey: 'mobileTutorial.steps.nightstand.body',
    },
    {
        // 床头钟的小组件：右上角按钮进编辑，拖卡换位、拖角改大小、− 收进右侧托盘。
        id: 'widgets',
        target: null,
        titleKey: 'mobileTutorial.steps.widgets.title',
        bodyKey: 'mobileTutorial.steps.widgets.body',
        demo: 'widgets',
    },
    {
        id: 'finish',
        target: null,
        titleKey: 'mobileTutorial.steps.finish.title',
        bodyKey: 'mobileTutorial.steps.finish.body',
        demo: 'finish',
    },
];

type SpotlightRect = { left: number; top: number; width: number; height: number };

/**
 * 信息条折叠时墙边上的那个标签（BravaisSeam 的 data-bravais-seam-tab，只在折叠或收起时显示）。按它和用户自己点一样：
 * 收起的恢复，折到屏外的在当前视口里重新裂开。detail 为 1 当作一次点按，焦点不被交进信息条，留在教程卡片上。
 */
const reopenFoldedStrip = (): boolean => {
    const tab = document.querySelector<HTMLButtonElement>('[data-bravais-seam-tab]');
    if (!tab || tab.style.display === 'none' || tab.getClientRects().length === 0) return false;
    tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    return true;
};

const readRect = (selector: string | null): SpotlightRect | null => {
    if (!selector || typeof document === 'undefined') return null;
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
};

/** 两次测量是不是同一个位置（半像素以内算没动，滚动和缩放动画的小数抖动不算）。 */
const sameRect = (a: SpotlightRect | null, b: SpotlightRect | null): boolean => {
    if (!a || !b) return a === b;
    return Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5
        && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
};

/** 目标连续这么多帧不动才算到位（约 130ms）。 */
const SETTLE_FRAMES = 8;

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
    const [targetSettled, setTargetSettled] = useState(false);
    /** 说明卡此刻的上下边（视口坐标）：床头钟那一步的示范动画画在卡片与高亮框之间的空处。 */
    const [cardBox, setCardBox] = useState<{ top: number; bottom: number } | null>(null);
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

    // 信息条里的那几步：信息条被拖到屏幕边上折叠了（只剩边上的标签）时，高亮会落在屏外 / 迷你播放条下面的一条细边上。
    // 进这一步时先把它在屏内重新张开；墙可能晚一拍挂上，短暂重试。
    useEffect(() => {
        if (!isOpen || visiting || !step.inStrip) return undefined;
        let attempts = 0;
        let timer = 0;
        // 按一次就停：张开的动画还在走时标签可能还显示着，再按会再裂开一次。信息条已在屏内（标签不显示）也停。
        const tryReopen = () => {
            attempts += 1;
            if (reopenFoldedStrip()) {
                console.info(`[mobileTutorial] reopened the folded info strip for step ${step.id}`);
                return;
            }
            if (document.querySelector('[data-bravais-home-seam]') || attempts >= 8) return;
            timer = window.setTimeout(tryReopen, 250);
        };
        tryReopen();
        return () => window.clearTimeout(timer);
    }, [isOpen, visiting, step.id, step.inStrip]);

    // 跟住目标：换步、转屏、墙的窄缝重排、设置弹窗的入场动画和把那一行滚过来都会移动它。每帧量一次（只在位置变了时
    // 才更新），框贴着目标走；原来 300ms 量一次，设置还在动时框先落在半路（偏上），再跳到正确位置。
    // targetSettled：目标连续几帧没动过才算到位；设置里那个闪烁框等它到位再出现，不在半路上闪一下。
    useLayoutEffect(() => {
        setTargetSettled(false);
        if (!isOpen) {
            setRect(null);
            return undefined;
        }
        const selector = visiting ? step.action?.visitTarget ?? null : step.target;
        // 换了要跟的目标就先清掉旧框：下面只在量到的位置变了时才更新，从设置回到一步没有目标的（同步、Face ID）时，
        // 「没有」和「没有」相同，旧的那一行的框会一直留在墙上。
        setRect(null);
        let last: SpotlightRect | null = null;
        let stillFrames = 0;
        let frame = 0;
        const tick = () => {
            const next = readRect(selector);
            if (!sameRect(next, last)) {
                last = next;
                stillFrames = 0;
                setRect(next);
                setTargetSettled(false);
            } else if (next && stillFrames < SETTLE_FRAMES) {
                stillFrames += 1;
                if (stillFrames === SETTLE_FRAMES) setTargetSettled(true);
            }
            frame = window.requestAnimationFrame(tick);
        };
        tick();
        return () => window.cancelAnimationFrame(frame);
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
        const readKeys = () => Array.from(document.querySelectorAll<HTMLElement>('[data-bravais-home-seam] [data-bravais-tab-short="true"]'))
            .map(element => element.dataset.bravaisTab)
            .filter((key): key is string => Boolean(key));
        let keys: string[] = [];
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
        // 信息条刚从边上重新张开时字母页签还没排好：等它们出现（最多约 3 秒）再开始。
        let waits = 0;
        const start = () => {
            keys = readKeys();
            if (keys.length > 0) {
                setPreviewingTabs(true);
                timer = window.setTimeout(showNext, 600);
            } else if (waits < 12) {
                waits += 1;
                timer = window.setTimeout(start, 250);
            }
        };
        start();
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

    // 量说明卡的上下边：只在床头钟那一步要用（示范动画放在卡片与高亮框之间）。卡片入场有一小段位移，落定后再量一次。
    useLayoutEffect(() => {
        if (!isOpen || visiting || step.id !== 'nightstand') {
            setCardBox(null);
            return undefined;
        }
        const measure = () => {
            const box = cardRef.current?.getBoundingClientRect();
            setCardBox(previous => (box && (previous?.top !== box.top || previous.bottom !== box.bottom)
                ? { top: box.top, bottom: box.bottom }
                : previous));
        };
        measure();
        const timer = window.setTimeout(measure, 400);
        window.addEventListener('resize', measure);
        return () => {
            window.clearTimeout(timer);
            window.removeEventListener('resize', measure);
        };
    }, [isOpen, visiting, step.id, rect]);

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
            {visiting ? (rect && targetSettled && (
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
            {step.id === 'nightstand' && !visiting && cardBox && (
                // 床头钟这一步不指控件（没有高亮框），卡片在底部：示范画在状态栏下面到卡片上沿之间。
                <NightstandRotateDemo area={{ top: 56, bottom: cardBox.top }} />
            )}

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
                {step.demo && !visiting && <TutorialDemo key={step.id} id={step.demo} accent={accent} />}
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
