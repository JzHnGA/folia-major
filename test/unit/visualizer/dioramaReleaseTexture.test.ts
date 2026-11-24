import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { releaseDioramaTexture } from '../../../src/components/visualizer/diorama/dioramaTextRaster';

// test/unit/visualizer/dioramaReleaseTexture.test.ts
// Releasing a Diorama raster frees the GPU copy AND empties the canvas it was painted on, so a song
// change does not leave each line's pixel buffer to the garbage collector (iOS killed the web process
// at its 2 GB limit while those piled up).

class FakeCanvas {
    width = 1200;
    height = 360;
}

describe('releaseDioramaTexture', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('disposes the texture and zeroes its canvas', () => {
        vi.stubGlobal('HTMLCanvasElement', FakeCanvas);
        const canvas = new FakeCanvas();
        const texture = new THREE.Texture(canvas as unknown as HTMLCanvasElement);
        const dispose = vi.spyOn(texture, 'dispose');

        releaseDioramaTexture(texture);

        expect(dispose).toHaveBeenCalledTimes(1);
        expect(canvas.width).toBe(0);
        expect(canvas.height).toBe(0);
    });

    it('only disposes a texture whose image is not a canvas', () => {
        vi.stubGlobal('HTMLCanvasElement', FakeCanvas);
        const image = { width: 64, height: 64 };
        const texture = new THREE.Texture(image as unknown as HTMLImageElement);
        const dispose = vi.spyOn(texture, 'dispose');

        releaseDioramaTexture(texture);

        expect(dispose).toHaveBeenCalledTimes(1);
        expect(image.width).toBe(64);
    });
});
