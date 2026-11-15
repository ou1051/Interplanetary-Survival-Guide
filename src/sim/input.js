// Keyboard, mouse-look and on-screen (touch) controls in one place.

export class Input {
  constructor(dom) {
    this.keys = new Set();
    this.pressed = new Set(); // edge-triggered this frame
    this.virtual = { throttle: false, brake: false, left: false, right: false, action: false, boost: false };
    this.look = { yaw: 0, pitch: 0, dragging: false };
    this.dom = dom;

    window.addEventListener('keydown', (e) => {
      if (e.target.closest?.('#habitat, #sourcesDialog, input, textarea, select')) return;
      const k = e.key.toLowerCase();
      if ((k === 'enter' || k === ' ') && e.target.closest?.('button')) return;
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
      if (!this.keys.has(k)) this.pressed.add(k);
      this.keys.add(k);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => {
      this.keys.clear();
      Object.keys(this.virtual).forEach((k) => (this.virtual[k] = false));
    });

    // Drag anywhere on the 3D view to look around the cabin.
    let lastX = 0;
    let lastY = 0;
    dom.addEventListener('pointerdown', (e) => {
      this.look.dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointermove', (e) => {
      if (!this.look.dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      this.look.yaw = Math.max(-2.3, Math.min(2.3, this.look.yaw - dx * 0.0042));
      this.look.pitch = Math.max(-0.75, Math.min(0.6, this.look.pitch - dy * 0.0036));
    });
    const end = () => (this.look.dragging = false);
    dom.addEventListener('pointerup', end);
    dom.addEventListener('pointercancel', end);
    dom.addEventListener('dblclick', () => this.resetLook());
  }

  resetLook() {
    this.look.yaw = 0;
    this.look.pitch = 0;
  }

  bindButton(el, name) {
    const on = (e) => {
      e.preventDefault();
      this.virtual[name] = true;
      el.classList.add('down');
    };
    const off = () => {
      this.virtual[name] = false;
      el.classList.remove('down');
    };
    el.addEventListener('pointerdown', on);
    el.addEventListener('pointerup', off);
    el.addEventListener('pointerleave', off);
    el.addEventListener('pointercancel', off);
  }

  down(...names) {
    return names.some((n) => this.keys.has(n));
  }

  hit(...names) {
    return names.some((n) => this.pressed.has(n));
  }

  get throttle() {
    return this.down('w', 'arrowup') || this.virtual.throttle;
  }
  get brake() {
    return this.down('s', 'arrowdown', ' ') || this.virtual.brake;
  }
  get steer() {
    let s = 0;
    if (this.down('a', 'arrowleft') || this.virtual.left) s -= 1;
    if (this.down('d', 'arrowright') || this.virtual.right) s += 1;
    return s;
  }
  get action() {
    return this.down('e') || this.virtual.action;
  }
  get boost() {
    return this.down('shift') || this.virtual.boost;
  }

  endFrame() {
    this.pressed.clear();
  }
}
