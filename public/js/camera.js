/* Camera presets and pointer controls. Physics and steering remain independent of the view. */
(function (root) {
  'use strict';
  const PRESETS = Object.freeze({
    cockpit: { label: 'Cockpit', mounted: true, fov: 60 },
    chase: { label: 'Chase', eye: [0, 2.6, 8.2], target: [0, .8, -1.8], fov: 58, min: 4, max: 25 },
    tv: { label: 'TV pod', mounted: true, eye: [0, 1.65, .35], target: [0, .8, -14], fov: 64 },
    nose: { label: 'Nose', mounted: true, eye: [0, .55, -2.8], target: [0, .5, -20], fov: 70 },
    wheel: { label: 'Tyre view', eye: [2.6, .7, -2.7], target: [.4, .42, -.9], fov: 65, min: 2.2, max: 12 },
    orbit: { label: 'Orbit', eye: [6, 3.2, 6], target: [0, .65, 0], fov: 50, min: 4, max: 35 },
    overhead: { label: 'Overhead', eye: [.01, 17, 1.5], target: [0, 0, 0], fov: 52, min: 7, max: 55 }
  });
  const ORDER = Object.freeze(Object.keys(PRESETS));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const NO_DRAG = '.card,.touch,.drop,.stagebtns,.camera-panel,button,a,select,input,textarea,label,[role="button"],[contenteditable="true"]';

  class RacingCameraController {
    constructor({ THREE, camera, stage, onChange = () => {}, canStartDrag = () => true }) {
      this.THREE = THREE;
      this.camera = camera;
      this.stage = stage;
      this.onChange = onChange;
      this.canStartDrag = canStartDrag;
      this.mode = 'cockpit';
      this.states = {};
      this.drag = null;
      this.initialized = false;
      this.eye = new THREE.Vector3();
      this.look = new THREE.Vector3();
      this.smoothEye = new THREE.Vector3();
      this.smoothLook = new THREE.Vector3();
      this.listeners = [];
      this.document = stage.ownerDocument;
      this.selects = ['cameraSelect', 'cameraPreset'].map(id => this.document && this.document.getElementById(id)).filter(Boolean);
      for (const select of this.selects) this.listen(select, 'change', () => this.setMode(select.value));
      const reset = this.document && this.document.getElementById('cameraReset');
      if (reset) this.listen(reset, 'click', () => this.reset());
      this.listen(stage, 'pointerdown', e => this.pointerDown(e));
      this.listen(stage, 'pointermove', e => this.pointerMove(e));
      this.listen(stage, 'pointerup', e => this.pointerEnd(e));
      this.listen(stage, 'pointercancel', e => this.pointerEnd(e));
      this.listen(stage, 'lostpointercapture', e => this.pointerEnd(e));
      this.listen(stage, 'wheel', e => this.wheel(e), { passive: false });
      this.listen(stage, 'dblclick', e => {
        if (this.allowed(e)) { e.preventDefault(); this.reset(); }
      });
      const view = this.document && this.document.defaultView;
      if (view) this.listen(view, 'blur', () => this.pointerEnd());
      this.syncUI();
    }
    listen(target, type, fn, options) {
      target.addEventListener(type, fn, options);
      this.listeners.push([target, type, fn, options]);
    }
    state() {
      if (!this.states[this.mode]) {
        const p = PRESETS[this.mode], s = { yaw: 0, pitch: 0, fov: p.fov };
        if (!p.mounted) {
          const dx = p.eye[0] - p.target[0], dy = p.eye[1] - p.target[1], dz = p.eye[2] - p.target[2];
          s.distance = Math.hypot(dx, dy, dz);
          s.yaw = Math.atan2(dx, dz);
          s.pitch = Math.asin(dy / s.distance);
        }
        this.states[this.mode] = s;
      }
      return this.states[this.mode];
    }
    syncUI() {
      for (const select of this.selects) select.value = this.mode;
      const hint = this.document && this.document.getElementById('cameraHint');
      if (hint) hint.textContent = PRESETS[this.mode].mounted ? 'Drag to look · scroll to zoom · double-click to reset' : 'Drag to orbit · scroll to zoom · double-click to reset';
      this.stage.dataset.camera = this.mode;
    }
    setMode(mode) {
      if (!Object.prototype.hasOwnProperty.call(PRESETS, mode)) return false;
      if (this.mode === mode) { this.syncUI(); return true; }
      this.pointerEnd();
      this.mode = mode;
      this.invalidate();
      this.syncUI();
      this.onChange(mode);
      return true;
    }
    cycle() { this.setMode(ORDER[(ORDER.indexOf(this.mode) + 1) % ORDER.length]); }
    reset() { delete this.states[this.mode]; this.invalidate(); this.syncUI(); }
    invalidate() { this.initialized = false; }
    allowed(e) {
      return !(e.target && e.target.closest && e.target.closest(NO_DRAG)) && this.canStartDrag(e) !== false;
    }
    pointerDown(e) {
      if (this.drag || e.button !== 0 || (e.pointerType && e.pointerType !== 'mouse' && e.pointerType !== 'pen') || !this.allowed(e)) return;
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      try { this.stage.setPointerCapture(e.pointerId); } catch (_) { /* The pointer may have been cancelled. */ }
      this.stage.classList.add('camera-dragging');
      this.stage.focus({ preventScroll: true });
      e.preventDefault();
    }
    pointerMove(e) {
      if (!this.drag || this.drag.id !== e.pointerId) return;
      const s = this.state(), mounted = PRESETS[this.mode].mounted;
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      this.drag.x = e.clientX; this.drag.y = e.clientY;
      // Looking right turns the onboard view right; exterior drag rotates around the car.
      s.yaw += dx * (mounted ? -.004 : -.005);
      s.pitch = clamp(s.pitch + dy * (mounted ? -.004 : .004), mounted ? -.7 : -.035, mounted ? .7 : 1.52);
      if (mounted) s.yaw = clamp(s.yaw, -1.45, 1.45);
      else s.yaw = Math.atan2(Math.sin(s.yaw), Math.cos(s.yaw));
      e.preventDefault();
    }
    pointerEnd(e) {
      if (!this.drag || (e && e.pointerId !== this.drag.id)) return;
      const id = this.drag.id;
      this.drag = null;
      this.stage.classList.remove('camera-dragging');
      try { if (this.stage.hasPointerCapture(id)) this.stage.releasePointerCapture(id); } catch (_) { /* Already released. */ }
    }
    wheel(e) {
      if (!this.allowed(e)) return;
      const s = this.state(), p = PRESETS[this.mode];
      const delta = clamp(e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 800 : 1), -200, 200);
      if (p.mounted) s.fov = clamp(s.fov + delta * .055, 38, 85);
      else s.distance = clamp(s.distance * Math.exp(delta * .0015), p.min, p.max);
      e.preventDefault();
    }
    update(player, dt, mode = this.mode) {
      if (mode !== this.mode) this.setMode(mode);
      const p = PRESETS[this.mode], s = this.state(), camera = this.camera;
      if (camera.fov !== s.fov) { camera.fov = s.fov; camera.updateProjectionMatrix(); }
      if (this.mode === 'cockpit') {
        // The caller supplies the base cockpit pose including suspension movement on every frame.
        camera.rotateY(s.yaw);
        camera.rotateX(s.pitch);
        return;
      }
      this.look.fromArray(p.target);
      if (p.mounted) this.eye.fromArray(p.eye);
      else {
        const flat = s.distance * Math.cos(s.pitch);
        this.eye.set(p.target[0] + Math.sin(s.yaw) * flat, Math.max(.2, p.target[1] + Math.sin(s.pitch) * s.distance), p.target[2] + Math.cos(s.yaw) * flat);
      }
      player.localToWorld(this.eye);
      player.localToWorld(this.look);
      // Mounted cameras stay on the chassis. Following views soften movement without changing physics.
      const alpha = p.mounted || !this.initialized || !(dt > 0) ? 1 : 1 - Math.exp(-Math.min(dt, .25) * 10);
      this.smoothEye.lerp(this.eye, alpha);
      this.smoothLook.lerp(this.look, alpha);
      camera.position.copy(this.smoothEye);
      camera.up.set(0, 1, 0);
      camera.lookAt(this.smoothLook);
      if (p.mounted) { camera.rotateY(s.yaw); camera.rotateX(s.pitch); }
      this.initialized = true;
    }
    dispose() {
      this.pointerEnd();
      for (const [target, type, fn, options] of this.listeners) target.removeEventListener(type, fn, options);
      this.listeners.length = 0;
    }
  }
  RacingCameraController.presets = PRESETS;
  RacingCameraController.order = ORDER;
  root.RacingCameraController = RacingCameraController;
  if (typeof module !== 'undefined' && module.exports) module.exports = RacingCameraController;
})(typeof window !== 'undefined' ? window : globalThis);
