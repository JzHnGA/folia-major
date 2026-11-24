import React, { useEffect, useMemo, useRef } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import { useReducedMotionFor } from '../../../hooks/useReducedMotionFor';
import { useMobileTutorialStore } from '../../../stores/useMobileTutorialStore';
import { Check, FoldHorizontal, ListFilter, Maximize2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BravaisLayer, BravaisSeamTab } from './bravaisLayer';
import type { BravaisHomeShortcut } from './bravaisHomeModels';
import type { BravaisSeamLevel } from './bravaisSeamLevel';
import BravaisSeamHomeTools from './BravaisSeamHomeTools';
import BravaisSeamAccountSwitcher from './BravaisSeamAccountSwitcher';
import { BravaisSeamAccountSlot, HomeSeamSections, HomeSeamShortcuts } from './BravaisSeamHome';
import { BravaisSeamFlipText, useBravaisSeamFade } from './BravaisSeamFlip';
import { useBravaisReducedTransitions } from './bravaisMotion';
import { bravaisRevealMotion } from './bravaisSeamMotion';
import { abbreviateSeamTabLabels } from './bravaisSeamTabLabels';
import BravaisSeamFilterField from './BravaisSeamFilterField';
import { useBravaisUiStore } from './bravaisUiStore';
import { clearBravaisHomeTab, revealBravaisHomeTab, useBravaisHomeUiStore } from './bravaisHomeUiStore';
import { openBravaisFilter } from './useBravaisSeamFilter';
import { useBravaisSeamRowFit } from './useBravaisSeamRowFit';
import './bravaisHome.css';
import './bravaisSeamRow.css';

// src/library/suites/bravais/BravaisSeamHomeRow.tsx
// 信息条横向时的首页窄缝 / 首页书脊（横条，见 bravaisSeamRow.css）：一行从左到右是折叠、导航段（「书库」、横排的一级页签、
// 扫描进度、二级切换、直达入口、管理隐藏、状态）、过滤输入位（正在输入或有过滤词时）、账户入口、工具格。书脊（compact）
// 的导航段只有页签，末尾多一个展开。
// 放不下时与竖的窄缝同一套退让（useBravaisSeamRowFit 按宽度量）：先藏「书库」（读屏仍读得到）→ 直达入口挪进「⋯」→
// 账户入口只留头像 → 页签与激活的二级切换缩成一个字（bravaisSeamTabLabels，全名在 title / aria-label）→ 还放不下，
// 导航段在里面横向滚（右边淡出提示）。
// 控件、文案、data 属性与竖的窄缝（BravaisSeamHome）相同。

// 页签被缩成字母时，点开后全名停留多久。到点收起，点别处也收起。
const REVEAL_DURATION_MS = 2500;

// 字母页签展开 / 收起的宽度补间：欠阻尼的弹簧，展开的那格慢慢长宽、收起时慢慢缩回，左右的字母被它推开后
// 略过头再弹回（同一组页签都带 layout，跟着一起补间）。只动 transform，不改退让级别的度量。
const TAB_REVEAL_SPRING = { type: 'spring', stiffness: 150, damping: 15, mass: 1 } as const;
const TAB_LABEL_FADE = { duration: 0.28, ease: 'easeOut' } as const;

/** 一级页签：真按钮，或测量副本（span，不可聚焦、不进无障碍树）。 */
const RowTabs: React.FC<{
    tabs: readonly BravaisSeamTab[];
    label: string;
    shorts: readonly string[] | null;
    onSelect?: (key: string) => void;
    /** 已经展开成全名的那个页签；只在短形档里出现。 */
    revealedKey?: string | null;
    /** 教程在演示页签：当前页签不画激活底色，只让演示的那一格亮（aria-selected 照旧）。 */
    hideActive?: boolean;
    measure?: boolean;
}> = ({ tabs, label, shorts, onSelect, revealedKey = null, hideActive = false, measure = false }) => {
    const calm = useReducedMotionFor('uiMicroMotion');
    const layoutTransition = calm ? { duration: 0 } : TAB_REVEAL_SPRING;
    const labelTransition = calm ? { duration: 0 } : TAB_LABEL_FADE;
    if (tabs.length === 0) return null;
    const className = `bravais-seam-tabs${shorts ? ' is-short' : ''}`;
    if (measure) {
        return (
            <div className={className}>
                {tabs.map((tab, index) => <span key={tab.key} className="bravais-seam-home-tab">{shorts ? shorts[index] : tab.label}</span>)}
            </div>
        );
    }
    return (
        <LayoutGroup>
            <div className={className} role="tablist" aria-label={label} aria-orientation="horizontal">
                {tabs.map((tab, index) => {
                    const revealed = revealedKey === tab.key;
                    const text = shorts ? shorts[index] : tab.label;
                    return (
                        <motion.button
                            key={tab.key}
                            layout
                            transition={layoutTransition}
                            // framer 的 layout 用 scale 补宽度：圆角写在 style 上它才会一起校正，不被拉扁。
                            style={{ borderRadius: 10 }}
                            type="button"
                            role="tab"
                            aria-selected={tab.active}
                            aria-label={shorts ? tab.label : undefined}
                            title={tab.label}
                            disabled={tab.disabled}
                            data-bravais-tab={tab.key}
                            data-bravais-tab-short={shorts ? 'true' : undefined}
                            data-bravais-tab-revealed={revealed || undefined}
                            className={`bravais-seam-home-tab${tab.active && !hideActive ? ' is-active' : ''}${revealed ? ' is-revealed' : ''}`}
                            onClick={() => onSelect?.(tab.key)}
                        >
                            {/* 字母 ↔ 全名交叉淡化；文字也带 layout，按钮补宽度时它不跟着被拉伸。淡出的那份裁在
                                按钮里（clip 层），收起时长名字不会溢到邻居身上。 */}
                            <motion.span layout className="bravais-seam-home-tab-clip">
                                <AnimatePresence mode="popLayout" initial={false}>
                                    <motion.span
                                        key={text}
                                        layout="position"
                                        className="bravais-seam-home-tab-text"
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                        transition={labelTransition}
                                    >
                                        {text}
                                    </motion.span>
                                </AnimatePresence>
                            </motion.span>
                        </motion.button>
                    );
                })}
            </div>
        </LayoutGroup>
    );
};

const BravaisSeamHomeRow: React.FC<{
    layer: BravaisLayer;
    compact: boolean;
    setLevel: (level: BravaisSeamLevel) => void;
    openShortcut?: (shortcut: BravaisHomeShortcut) => void;
}> = ({ layer, compact, setLevel, openShortcut }) => {
    const { t } = useTranslation();
    const { seam } = layer;
    const home = seam.home;
    const tabs = seam.tabs ?? [];
    // 书脊不画中段（二级切换、直达入口等），只排页签。
    const sections = !compact && home?.sections && home.sections.length > 0 ? home.sections : null;
    const shortcuts = home?.shortcuts && home.shortcuts.length > 0 ? home.shortcuts : null;
    const rowShortcuts = compact ? null : shortcuts;
    const rowEntries = !compact && home?.entries && home.entries.length > 0 ? home.entries : null;
    const hasRowJumps = rowShortcuts !== null || rowEntries !== null;
    const reveal = bravaisRevealMotion(useBravaisReducedTransitions());
    const filterEditing = useBravaisUiStore(state => state.filterEditing);
    const tabCount = tabs.length;
    const labelsKey = tabs.map(tab => tab.label).join('\u0000');
    // 页签全被关掉时 labelsKey 是空串，split 会得到 ['']（一个字母对零个页签），下面按下标取 tabs[i] 就崩了：零个页签就是零个短形。
    const shortLabels = useMemo(() => (tabCount === 0 ? [] : abbreviateSeamTabLabels(labelsKey.split('\u0000'))), [labelsKey, tabCount]);
    const revealedTabKey = useBravaisHomeUiStore(state => state.revealedTabKey);
    const revealedUntil = useBravaisHomeUiStore(state => state.revealedUntil);
    const calmTabs = useReducedMotionFor('uiMicroMotion');
    // iOS 新手教程第一步会依次「点开」每个字母做演示；用户自己点开的优先。
    const previewTabKey = useMobileTutorialStore(state => state.previewTabKey);
    const shownTabKey = revealedTabKey ?? previewTabKey;
    // 演示期间（用户没有自己点开时）当前页签不亮，否则它会和演示的那格一起显示成选中。
    const previewingTabs = useMobileTutorialStore(state => state.previewingTabs);
    const hideActiveTab = previewingTabs && revealedTabKey === null;

    const rowRef = useRef<HTMLDivElement>(null);
    const navRef = useRef<HTMLDivElement>(null);
    const accountRef = useRef<HTMLDivElement>(null);
    const measureRef = useRef<HTMLDivElement>(null);
    const fit = useBravaisSeamRowFit({ rowRef, navRef, accountRef, measureRef });
    const short = fit.level === 'short';
    const titled = !compact && fit.level === 'titled';
    const shortcutsInRow = hasRowJumps && fit.shortcuts;
    // 只有短形档才需要展开：全名已经在页签上时，点它只是切页签。
    const revealActive = short && shownTabKey !== null;
    // 展开的那一格显示全名，其余仍是单字母；测量副本继续用单字母（不改退让级别的度量）。
    const revealedShorts = useMemo(
        () => shortLabels.map((label, index) => (tabs[index]?.key === shownTabKey ? tabs[index].label : label)),
        [shownTabKey, shortLabels, tabs],
    );
    // 缩减级别变了：导航段淡入新的样子，不硬切。
    useBravaisSeamFade(`${fit.level}|${fit.shortcuts}|${fit.accountCompact}`, navRef);
    const expand = () => setLevel('full');

    /** 点页签：照常切换；短形档里把这一格展开成全名，再点同一格收起。 */
    const selectTab = (key: string) => {
        if (short) {
            if (revealedTabKey === key) {
                clearBravaisHomeTab();
            } else {
                revealBravaisHomeTab(key, Date.now() + REVEAL_DURATION_MS);
            }
        }
        seam.onSelectTab?.(key);
    };

    // 到点收起；换层 / 换页签后重挂也按同一个截止时刻接着计时。
    useEffect(() => {
        if (!revealedTabKey) return undefined;
        const remaining = Math.max(0, (revealedUntil ?? 0) - Date.now());
        const timer = window.setTimeout(clearBravaisHomeTab, remaining);
        return () => window.clearTimeout(timer);
    }, [revealedTabKey, revealedUntil]);

    // 点展开那一格之外（墙面、工具格、账户、别的页签）立即收起；别的页签的 click 随后再展开它自己。
    useEffect(() => {
        if (!revealedTabKey) return undefined;
        const onPointerDown = (event: PointerEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest('[data-bravais-tab-revealed]')) return;
            clearBravaisHomeTab();
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => document.removeEventListener('pointerdown', onPointerDown, true);
    }, [revealedTabKey]);

    // 展开项可能被横向导航裁掉：展开时把它滚到中间。平滑地滚，和页签的宽度弹簧一起走，而不是先跳一下。
    useEffect(() => {
        if (!shownTabKey) return;
        navRef.current?.querySelector<HTMLElement>('[data-bravais-tab-revealed]')
            ?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: calmTabs ? 'auto' : 'smooth' });
    }, [calmTabs, shownTabKey]);


    /** 导航段里随级别变的那几块（测量副本用；真的那份在下面按 fit 画）。 */
    const measureNav = (name: string, { title, jumps, abbreviated }: { title: boolean; jumps: boolean; abbreviated: boolean }) => (
        <div className="bravais-seam-home-row-nav" data-bravais-row-measure={name}>
            {title && !compact && <div className="bravais-seam-home-title">{seam.title}</div>}
            <RowTabs tabs={tabs} label={seam.title} shorts={abbreviated ? shortLabels : null} measure />
            {sections && (
                <div className="bravais-seam-sections-slot">
                    <HomeSeamSections sections={sections} short={abbreviated} measure />
                </div>
            )}
            {jumps && hasRowJumps && (
                <div className="bravais-seam-home-jumps">
                    <HomeSeamShortcuts shortcuts={rowShortcuts ?? []} entries={rowEntries} rule={Boolean(sections)} measure />
                </div>
            )}
        </div>
    );

    return (
        <div ref={rowRef} className={`bravais-seam-home-row${compact ? ' is-compact' : ''}${short ? ' has-short-tabs' : ''}${revealActive ? ' has-revealed-tab' : ''}`} data-bravais-home-seam
            data-bravais-home-fit={fit.level} data-bravais-home-shortcuts={hasRowJumps ? (shortcutsInRow ? 'column' : 'menu') : undefined}
            data-bravais-home-reveal={revealActive ? shownTabKey : undefined}>
            <button type="button" className="bravais-seam-icon" data-bravais-seam-action="hide" onClick={() => setLevel('hidden')}
                aria-label={t('libraryBravais.seamFold')} title={t('libraryBravais.seamFold')}>
                <FoldHorizontal aria-hidden />
            </button>
            {/* 导航段本身是横向滚动容器：layoutScroll 让页签的 layout 补间把滚动位移算进去，展开时不跳。 */}
            <motion.div layoutScroll ref={navRef} className={`bravais-seam-home-row-nav${fit.overflowing || revealActive ? ' is-overflowing' : ''}`}>
                {/* 「书库」放不下时视觉隐藏（读屏仍读得到，页签列的 aria-label 也是它）。 */}
                {!compact && (
                    <div className={`bravais-seam-home-title${titled ? '' : ' is-hidden'}`} data-bravais-home-title={titled ? 'shown' : 'hidden'}>
                        {seam.title}
                    </div>
                )}
                <RowTabs tabs={tabs} label={seam.title} shorts={short ? revealedShorts : null} revealedKey={revealActive ? shownTabKey : null} hideActive={hideActiveTab} onSelect={selectTab} />
                {!compact && !revealActive && (
                    <div className="bravais-seam-home-row-body" data-bravais-home-body>
                        <AnimatePresence initial={false}>
                            {home?.scan && <motion.div key="scan" className="bravais-seam-scan" data-bravais-scan data-bravais-row-extra {...reveal}>{home.scan}</motion.div>}
                        </AnimatePresence>
                        {sections && (
                            <div className="bravais-seam-sections-slot">
                                <HomeSeamSections sections={sections} label={seam.meta} short={short} onSelect={home?.onSelectSection} orientation="horizontal" />
                            </div>
                        )}
                        {shortcutsInRow && (
                            <div className="bravais-seam-home-jumps" data-bravais-home-jumps>
                                <HomeSeamShortcuts shortcuts={rowShortcuts ?? []} entries={rowEntries} label={home?.shortcutsLabel} rule={Boolean(sections)} onOpen={openShortcut} />
                            </div>
                        )}
                        <AnimatePresence initial={false}>
                            {home?.manage && (
                                <motion.div key="manage" className="bravais-seam-manage" data-bravais-manage={home.manage.mode} data-bravais-row-extra {...reveal}>
                                    <span>{home.manage.title}</span>
                                    <button type="button" aria-pressed={home.manage.mode === 'manage-hidden-only'} data-bravais-seam-action="hidden-only"
                                        className={home.manage.mode === 'manage-hidden-only' ? 'is-active' : undefined} onClick={home.manage.onToggleHiddenOnly}>
                                        {home.manage.mode === 'manage-hidden-only' && <Check aria-hidden />}{home.manage.hiddenOnlyLabel}
                                    </button>
                                    <button type="button" data-bravais-seam-action="manage-done" onClick={home.manage.onDone}>{home.manage.doneLabel}</button>
                                </motion.div>
                            )}
                        </AnimatePresence>
                        {seam.status && (
                            <BravaisSeamFlipText as="div" flipKey={seam.status} className="bravais-seam-row-status" data-bravais-seam-status data-bravais-row-extra>
                                {seam.status}
                            </BravaisSeamFlipText>
                        )}
                    </div>
                )}
            </motion.div>
            <AnimatePresence initial={false}>
                {seam.filter && !compact && (filterEditing || seam.filter.query) && (
                    <motion.div key="filter" className="bravais-seam-home-filter" {...reveal}>
                        <BravaisSeamFilterField filter={seam.filter} variant="home" />
                    </motion.div>
                )}
            </AnimatePresence>
            {seam.filter?.query && compact && (
                <button type="button" className="bravais-seam-icon is-filtering" data-bravais-seam-action="filter" onClick={openBravaisFilter}
                    aria-label={seam.filter.placeholder} title={`${seam.filter.placeholder} · ${seam.filter.query}`}>
                    <ListFilter aria-hidden />
                </button>
            )}
            {home?.account && (
                <div ref={accountRef} className="bravais-seam-row-account">
                    <BravaisSeamAccountSlot account={home.account} compact={compact || fit.accountCompact} />
                </div>
            )}
            {home && (
                <BravaisSeamHomeTools home={home} compact={compact} onExpand={expand}
                    menuShortcuts={rowShortcuts && !shortcutsInRow ? rowShortcuts : null} onOpenShortcut={openShortcut}
                    menuEntries={rowEntries && !shortcutsInRow ? rowEntries : null} />
            )}
            {compact && (
                <button type="button" className="bravais-seam-icon" data-bravais-seam-action="expand" onClick={expand}
                    aria-label={t('libraryBravais.seamExpand')} title={t('libraryBravais.seamExpand')}>
                    <Maximize2 aria-hidden />
                </button>
            )}
            {/* 各级导航段与两种账户入口的测量副本：绝对定位、看不见、不占位（useBravaisSeamRowFit 量它们）。 */}
            <div ref={measureRef} className="bravais-seam-home-row-measure" aria-hidden inert>
                {measureNav('titled', { title: true, jumps: true, abbreviated: false })}
                {measureNav('untitled', { title: false, jumps: true, abbreviated: false })}
                {measureNav('no-shortcuts', { title: false, jumps: false, abbreviated: false })}
                {measureNav('short', { title: false, jumps: false, abbreviated: true })}
                {home?.account && (
                    <>
                        <div data-bravais-row-measure="account-full"><BravaisSeamAccountSwitcher account={home.account} compact={compact} measure /></div>
                        <div data-bravais-row-measure="account-compact"><BravaisSeamAccountSwitcher account={home.account} compact measure /></div>
                    </>
                )}
            </div>
        </div>
    );
};

export default BravaisSeamHomeRow;
