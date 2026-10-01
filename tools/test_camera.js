// Camera geometry and pointer integration against the actual bundled Three.js math.
const assert = require('node:assert/strict');
const THREE = require('../public/vendor/three.min.js');
const Controller = require('../public/js/camera.js');

class Element {
  constructor() { this.handlers = new Map(); this.dataset = {}; this.captures = new Set(); this.classes = new Set(); this.classList = { add: c => this.classes.add(c), remove: c => this.classes.delete(c) }; }
  addEventListener(type, fn) { if (!this.handlers.has(type)) this.handlers.set(type, new Set()); this.handlers.get(type).add(fn); }
  removeEventListener(type, fn) { this.handlers.get(type)?.delete(fn); }
  emit(type, e = {}) { e.target ||= this; e.preventDefault ||= () => { e.prevented = true; }; for (const fn of this.handlers.get(type) || []) fn(e); return e; }
  closest() { return this.interactive ? this : null; }
  focus() {}
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
}
const elements = new Map(['cameraSelect', 'cameraPreset', 'cameraReset', 'cameraHint'].map(id => [id, new Element()]));
const stage = new Element(), view = new Element(), camera = new THREE.PerspectiveCamera(60, 16 / 9, .04, 4000), car = new THREE.Group();
stage.ownerDocument = { defaultView: view, getElementById: id => elements.get(id) };
const changes = [];
let allowDrag = true;
const controller = new Controller({ THREE, camera, stage, onChange: mode => changes.push(mode), canStartDrag: () => allowDrag });
const near = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-8, `${msg}: ${actual} != ${expected}`);
const point = (x, y, extra = {}) => ({ pointerId: 3, pointerType: 'mouse', button: 0, clientX: x, clientY: y, ...extra });

// Every preset is a valid finite pose; exterior cameras target the same point after a car turn.
car.position.set(100, 4, -50); car.rotation.y = Math.PI / 2; car.updateMatrixWorld(true);
for (const mode of Controller.order.filter(mode => mode !== 'cockpit')) {
  controller.setMode(mode); controller.update(car, 0);
  assert.ok(camera.position.toArray().every(Number.isFinite), mode);
  assert.ok(camera.position.y > car.position.y, `${mode} above the road`);
  const target = car.localToWorld(new THREE.Vector3().fromArray(Controller.presets[mode].target));
  const expected = target.sub(camera.position).normalize();
  near(camera.getWorldDirection(new THREE.Vector3()).dot(expected), 1, `${mode} points at local target`);
}

// A world reset snaps the follower to the new car instead of flying across the circuit.
controller.setMode('chase'); controller.update(car, 0);
const oldX = camera.position.x;
car.position.x += 1000; car.updateMatrixWorld(true);
controller.invalidate(); controller.update(car, 1 / 60);
near(camera.position.x - oldX, 1000, 'reset snap');

// Drag, zoom and reset are observable through the real camera rather than only stored state.
const initial = camera.position.clone();
stage.emit('pointerdown', point(0, 0)); stage.emit('pointermove', point(80, 40)); stage.emit('pointerup', point(80, 40));
controller.update(car, 0);
assert.ok(camera.position.distanceTo(initial) > 1, 'mouse drag changes the view');
assert.equal(stage.captures.size, 0);
const distance = controller.state().distance;
assert.equal(stage.emit('wheel', { deltaY: -100, deltaMode: 0 }).prevented, true);
assert.ok(controller.state().distance < distance, 'scroll zooms in');
for (let i = 0; i < 100; ++i) stage.emit('wheel', { deltaY: -1000, deltaMode: 0 });
near(controller.state().distance, Controller.presets.chase.min, 'exterior zoom limit');
stage.emit('dblclick'); controller.update(car, 0);
near(camera.position.distanceTo(initial), 0, 'double click restores preset');

// Cockpit adjustments compose with the supplied chassis rotation, with finite look/FOV limits.
controller.setMode('cockpit');
camera.position.copy(car.position); camera.quaternion.copy(car.quaternion);
const initialDirection = camera.getWorldDirection(new THREE.Vector3());
stage.emit('pointerdown', point(0, 0)); stage.emit('pointermove', point(2000, -2000));
view.emit('blur'); assert.equal(controller.drag, null, 'losing focus releases the drag');
controller.update(car, 1 / 60);
assert.ok(camera.getWorldDirection(new THREE.Vector3()).dot(initialDirection) < .8, 'cockpit mouse look');
near(controller.state().yaw, -1.45, 'yaw clamp'); near(controller.state().pitch, .7, 'pitch clamp');
for (let i = 0; i < 100; ++i) stage.emit('wheel', { deltaY: -1000, deltaMode: 0 });
controller.update(car, 0); near(camera.fov, 38, 'onboard FOV limit');

// Touch steering, controls and radar interactions must never move the camera.
controller.reset();
stage.emit('pointerdown', point(0, 0, { pointerType: 'touch' })); assert.equal(controller.drag, null);
const button = new Element(); button.interactive = true;
stage.emit('pointerdown', point(0, 0, { target: button })); assert.equal(controller.drag, null);
const blockedWheel = stage.emit('wheel', { target: button, deltaY: 100, deltaMode: 0 }); assert.equal(blockedWheel.prevented, undefined);
allowDrag = false; stage.emit('pointerdown', point(0, 0)); assert.equal(controller.drag, null); allowDrag = true;
stage.emit('pointerdown', point(0, 0)); stage.emit('pointercancel', point(0, 0)); assert.equal(controller.drag, null);

// Both selectors and the C-cycle integration share the same canonical mode.
elements.get('cameraSelect').value = 'wheel'; elements.get('cameraSelect').emit('change');
assert.equal(controller.mode, 'wheel'); assert.equal(elements.get('cameraPreset').value, 'wheel');
controller.cycle(); assert.equal(controller.mode, 'orbit');
assert.equal(controller.setMode('not-a-camera'), false); assert.equal(controller.mode, 'orbit');
assert.ok(changes.includes('wheel'));
controller.dispose();
assert.equal([...stage.handlers.values()].reduce((sum, set) => sum + set.size, 0), 0);
console.log('Camera tests passed: 7 presets, car transforms, reset, mouse look/orbit, zoom limits and input isolation.');
