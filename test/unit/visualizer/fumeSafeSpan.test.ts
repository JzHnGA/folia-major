import { describe, expect, it } from 'vitest';
import type { FumeArticleLayout, FumeBlock } from '@/components/visualizer/fume/fumeTypes';
import { resolveArticleOverviewCamera, resolveFumeSafeSpan } from '@/components/visualizer/fume/fumeCamera';
import { isFumeBlockOnScreen } from '@/components/visualizer/fume/fumeBlockFrame';

// test/unit/visualizer/fumeSafeSpan.test.ts
// Fume keeps its write-head and its overview clear of the side safe areas (landscape iPhone's Dynamic
// Island); with no insets every result must match the old full-viewport maths.

const viewport = { width: 852, height: 393 };

const blockAt = (x: number, y: number, width: number, height: number) => ({ x, y, width, height }) as FumeBlock;

const article = {
    width: 4000,
    height: 3000,
    blocks: [blockAt(200, 300, 1400, 200), blockAt(1800, 900, 1200, 400)],
} as unknown as FumeArticleLayout;

describe('resolveFumeSafeSpan', () => {
    it('is the plain viewport centre with no insets', () => {
        expect(resolveFumeSafeSpan(viewport)).toEqual({ left: 0, right: 0, width: 852, centerX: 426 });
        expect(resolveFumeSafeSpan(viewport, { left: 0, right: 0 }).centerX).toBe(viewport.width * 0.5);
    });

    it('centres between the insets', () => {
        const span = resolveFumeSafeSpan(viewport, { left: 59, right: 20 });
        expect(span.width).toBe(852 - 79);
        expect(span.centerX).toBe(59 + (852 - 79) / 2);
    });
});

describe('resolveArticleOverviewCamera with safe sides', () => {
    it('matches the old shot with zero insets', () => {
        expect(resolveArticleOverviewCamera(article, viewport, { left: 0, right: 0 }))
            .toEqual(resolveArticleOverviewCamera(article, viewport));
    });

    it('fits the content into the safe width', () => {
        const plain = resolveArticleOverviewCamera(article, viewport);
        const safe = resolveArticleOverviewCamera(article, viewport, { left: 59, right: 59 });
        expect(safe.x).toBe(plain.x);
        expect(safe.y).toBe(plain.y);
        expect(safe.scale).toBeLessThanOrEqual(plain.scale);
        const contentWidth = (3000 - 200) * safe.scale;
        expect(contentWidth).toBeLessThanOrEqual(852 - 118);
    });
});

describe('isFumeBlockOnScreen with an off-centre look point', () => {
    const camera = { x: 1000, y: 1000, scale: 1 } as Parameters<typeof isFumeBlockOnScreen>[1];

    it('defaults to the viewport centre', () => {
        const block = blockAt(1000 + 426 + 150, 1000, 10, 10);
        expect(isFumeBlockOnScreen(block, camera, viewport)).toBe(isFumeBlockOnScreen(block, camera, viewport, 180, 426));
    });

    it('culls against the shifted projection', () => {
        // Just past the right overscan when the look point is pushed 100px right.
        const block = blockAt(1000 + (852 - 526) + 181, 1000, 10, 10);
        expect(isFumeBlockOnScreen(block, camera, viewport, 180, 426)).toBe(true);
        expect(isFumeBlockOnScreen(block, camera, viewport, 180, 526)).toBe(false);
    });
});
