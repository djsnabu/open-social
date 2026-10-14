import test from 'node:test';
import assert from 'node:assert/strict';
import { cropRect } from '../public/crop.js';

test('crop stays inside portrait, landscape and square images at every edge and zoom', () => {
  for (const [width, height] of [[300, 1200], [1600, 400], [800, 800]]) {
    for (const ratio of [0.8, 1, 1.91]) for (const zoom of [1, 1.7, 3]) {
      for (const x of [0, 0.5, 1]) for (const y of [0, 0.5, 1]) {
        const r = cropRect(width, height, ratio, zoom, x, y);
        assert.ok(Math.abs(r.width / r.height - ratio) < 1e-10);
        assert.ok(r.x >= -1e-10 && r.y >= -1e-10);
        assert.ok(r.x + r.width <= width + 1e-10 && r.y + r.height <= height + 1e-10);
      }
    }
  }
  assert.deepEqual(cropRect(1000, 1000, 1, 2, 0.5, 0.5), { x: 250, y: 250, width: 500, height: 500 });
});
