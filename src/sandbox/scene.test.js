import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createScene } from './scene.js';
import { heightAt } from './walk.js';

const mocks = vi.hoisted(() => ({ renderer: null, observer: null, texture: null, loadedUrl: null }));
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    WebGLRenderer: class {
      constructor() {
        this.domElement = { style: {}, setAttribute: vi.fn(), remove: vi.fn() };
        this.setPixelRatio = vi.fn();
        this.setSize = vi.fn();
        this.render = vi.fn();
        this.dispose = vi.fn();
        mocks.renderer = this;
      }
    },
    TextureLoader: class {
      load(url) {
        mocks.loadedUrl = url;
        mocks.texture = new actual.Texture();
        return mocks.texture;
      }
    },
  };
});

const site = {
  width: 9, height: 7, cellSizeM: 10,
  elevationM: Array.from({ length: 63 }, (_, index) => index % 9 === 4 && Math.floor(index / 9) >= 2 && Math.floor(index / 9) <= 4 ? 4 : 0),
  base: { col: 1, row: 3 },
  stations: [
    { id: 'ridge', name: 'Ridge', cell: { col: 7, row: 2 } },
    { id: 'rock', name: 'Rock', cell: { col: 7, row: 4 } },
  ],
  textureUrl: '/missions/test/orbital.jpg',
};
const route = { cells: [site.base, { col: 4, row: 3 }, site.stations[0].cell, site.base] };
let view;

beforeEach(() => {
  vi.stubGlobal('window', { devicePixelRatio: 3 });
  vi.stubGlobal('document', {
    createElement: () => ({ getContext: () => ({ fillRect() {}, fillText() {} }) }),
  });
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback) { this.callback = callback; this.disconnect = vi.fn(); mocks.observer = this; }
    observe() { this.callback(); }
  });
});
afterEach(() => { view?.dispose(); view = null; vi.unstubAllGlobals(); });

function open(visibility = 'clear') {
  view = createScene({ clientWidth: 900, clientHeight: 600, append: vi.fn() }, { site, route, visibility });
  view.render({ x: 10, z: 30, observedStationIds: ['ridge'] }, Math.PI / 2);
  return mocks.renderer.render.mock.calls.at(-1);
}

describe('sandbox scene', () => {
  it('matches grid landmarks, eye height and clockwise-from-north heading', () => {
    const [scene, camera] = open();
    const markers = scene.children.filter((child) => child.userData.stationId);
    expect(markers.map((marker) => [marker.position.x, marker.position.z])).toEqual([[10, 30], [70, 20], [70, 40]]);
    expect(camera.position.toArray()).toEqual([10, 1.7, 30]);
    const direction = camera.getWorldDirection(new THREE.Vector3());
    expect(direction.x).toBeGreaterThan(0.99);
    expect(Math.abs(direction.z)).toBeLessThan(0.001);
    expect(markers[1].children[0].material.color.getHex()).toBe(0x78ffc1);
    expect(markers[1].children[0].material.fog).toBe(false);
    expect(mocks.renderer.setSize).toHaveBeenCalledWith(900, 600, false);
    expect(mocks.renderer.setPixelRatio).toHaveBeenCalledWith(2);
  });

  it('loads the supplied image and conforms its route ribbon to the terrain', () => {
    const [scene] = open();
    expect(mocks.loadedUrl).toBe(site.textureUrl);
    const terrain = scene.children.find((child) => child.material?.map === mocks.texture);
    expect(terrain.material.map.colorSpace).toBe(THREE.SRGBColorSpace);
    const ribbon = scene.children.find((child) => child.material?.color?.getHex() === 0x96dfc3);
    const positions = ribbon.geometry.attributes.position;
    expect(positions.count).toBeGreaterThan(100);
    let highest = 0;
    for (let index = 0; index < positions.count; index++) {
      const ground = heightAt(site, positions.getX(index), positions.getZ(index));
      expect(positions.getY(index)).toBeCloseTo(ground + 0.06, 4);
      highest = Math.max(highest, positions.getY(index));
    }
    expect(highest).toBeGreaterThan(3.8);
  });

  it('uses much shorter terrain visibility without hiding the navigation labels', () => {
    const [scene] = open('poor');
    expect(scene.fog.near).toBe(4);
    expect(scene.fog.far).toBe(32);
    const marker = scene.children.find((child) => child.userData.stationId === 'ridge');
    expect(marker.children.at(-1).material.fog).toBe(false);
  });

  it('releases geometry, image, resize observer and renderer on exit', () => {
    const [scene] = open();
    const terrain = scene.children.find((child) => child.material?.map === mocks.texture);
    const geometryDispose = vi.spyOn(terrain.geometry, 'dispose');
    const textureDispose = vi.spyOn(mocks.texture, 'dispose');
    view.dispose();
    view = null;
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(textureDispose).toHaveBeenCalledOnce();
    expect(mocks.observer.disconnect).toHaveBeenCalledOnce();
    expect(mocks.renderer.dispose).toHaveBeenCalledOnce();
    expect(mocks.renderer.domElement.remove).toHaveBeenCalledOnce();
  });
});
