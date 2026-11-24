import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MachiCamera, resolveMachiDrift } from '@/components/visualizer/machi/engine/camera';

// test/unit/visualizer/machi/camera.test.ts
// 町景的运镜：相对静止位置的偏移有界（转角、俯仰、缩放、平移都不大），走得慢，但一两分钟里确实转开了；
// 快慢按倍数走（两倍速走十秒与一倍速走二十秒到同一处），中途改快慢不跳。

const samples = (seconds: number, step: number) => Array.from({ length: Math.round(seconds / step) }, (_, index) => resolveMachiDrift(index * step));

describe('resolveMachiDrift', () => {
    it('stays near the resting view', () => {
        samples(900, 0.25).forEach(drift => {
            expect(Math.abs(drift.azimuth)).toBeLessThanOrEqual(20);
            expect(Math.abs(drift.elevation)).toBeLessThanOrEqual(4);
            expect(Math.abs(Math.log(drift.zoom))).toBeLessThanOrEqual(0.08 + 1e-9);
            expect(Math.abs(drift.panX)).toBeLessThanOrEqual(0.45);
            expect(Math.abs(drift.panZ)).toBeLessThanOrEqual(0.3);
        });
    });

    it('moves slowly but does get around', () => {
        const step = 0.05;
        const path = samples(600, step);
        const fastest = Math.max(...path.slice(1).map((drift, index) => Math.abs(drift.azimuth - path[index]!.azimuth) / step));
        expect(fastest).toBeLessThan(2.5);
        const firstMinutes = path.slice(0, Math.round(120 / step)).map(drift => drift.azimuth);
        expect(Math.max(...firstMinutes) - Math.min(...firstMinutes)).toBeGreaterThan(25);
    });
});

describe('MachiCamera drift speed', () => {
    const DEG = Math.PI / 180;
    const create = () => {
        const camera = new MachiCamera();
        camera.setAspect(1600, 900);
        const points = [-6, 6].flatMap(x => [-6, 6].flatMap(z => [new THREE.Vector3(x, 0, z), new THREE.Vector3(x, 6, z)]));
        camera.setFraming({ points, view: { azimuth: 30 * DEG, elevation: 30 * DEG, zoom: 1.5 } }, null);
        return camera;
    };
    const run = (camera: MachiCamera, seconds: number) => {
        for (let frame = 0; frame < Math.round(seconds * 30); frame += 1) camera.update(1 / 30, 1 / 30);
    };

    it('drifts through the same path faster at a higher speed', () => {
        const slow = create();
        slow.setMotion(true, 1);
        run(slow, 20);
        const fast = create();
        fast.setMotion(true, 2);
        run(fast, 10);
        expect(fast.offset().azimuth).toBeCloseTo(slow.offset().azimuth, 3);
        expect(fast.offset().zoom).toBeCloseTo(slow.offset().zoom, 5);
        expect(Math.abs(slow.offset().azimuth)).toBeGreaterThan(1);
    });

    it('changes speed without a jump', () => {
        const camera = create();
        camera.setMotion(true, 1);
        run(camera, 8);
        const before = camera.offset().azimuth;
        camera.setMotion(true, 3);
        camera.update(1 / 30, 1 / 30);
        expect(Math.abs(camera.offset().azimuth - before)).toBeLessThan(0.2);
    });
});

describe('MachiCamera safe insets', () => {
    const DEG = Math.PI / 180;
    const create = (width: number, height: number) => {
        const camera = new MachiCamera();
        camera.setAspect(width, height);
        const points = [-6, 6].flatMap(x => [-6, 6].flatMap(z => [new THREE.Vector3(x, 0, z), new THREE.Vector3(x, 6, z)]));
        camera.setFraming({ points, view: { azimuth: 30 * DEG, elevation: 30 * DEG, zoom: 1 } }, null);
        return camera;
    };

    it('keeps the symmetric frustum with no insets', () => {
        const camera = create(852, 393);
        camera.setSafeInsets(0, 0);
        const { left, right, top, bottom } = camera.camera;
        expect(left).toBe(-right);
        // The full-width aspect, unchanged: top − bottom is 2·halfHeight.
        expect((right - left) / (top - bottom)).toBeCloseTo(852 / 393, 9);
    });

    it('frames the composition into the safe span and centres it there, still full-bleed', () => {
        const plain = create(852, 393).camera;
        const camera = create(852, 393);
        camera.setSafeInsets(59, 30);
        const { left, right, top, bottom } = camera.camera;
        // No stretch: the frustum still covers the whole viewport at its aspect.
        expect((right - left) / (top - bottom)).toBeCloseTo(852 / 393, 9);
        // The camera centre (the composition's centre) lands mid-way between the insets.
        const centrePx = (-left / (right - left)) * 852;
        expect(centrePx).toBeCloseTo(59 + (852 - 59 - 30) / 2, 6);
        // Fitting into a narrower span can only zoom out (landscape is height-bound, so it may not change).
        expect(top - bottom).toBeGreaterThanOrEqual(plain.top - plain.bottom - 1e-9);
    });
});
