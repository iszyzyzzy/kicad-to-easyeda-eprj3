'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { execFileSync } = require('child_process');
const { readRecords } = require('../scripts/lib/eprj3');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-fidelity-'));
try {
  const src = path.join(tmp, 'source');
  const dst = path.join(tmp, 'output');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'board.kicad_pcb'), String.raw`(kicad_pcb (version 20260206)
    (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal))
    (setup (stackup
      (layer "F.Cu" (type "copper") (thickness 0.035))
      (layer "dielectric 1" (type "prepreg") (thickness 0.1) (material "FR4") (epsilon_r 4.5))
      (layer "In1.Cu" (type "copper") (thickness 0.035))
      (layer "dielectric 2" (type "core") (thickness 1.24) (material "FR4"))
      (layer "In2.Cu" (type "copper") (thickness 0.035))
      (layer "dielectric 3" (type "prepreg") (thickness 0.1) (material "FR4"))
      (layer "B.Cu" (type "copper") (thickness 0.035))))
    (segment (start 1 2) (end 3 4) (width 0.25) (layer "In1.Cu") (net "GND"))
    (zone (net "GND") (layers "In1.Cu" "In2.Cu")
      (polygon (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10))))
    (footprint "SAME" (layer "F.Cu") (at 10 20 90)
      (property "Reference" "U1" (at 2 3 90) (layer "F.SilkS")
        (effects (font (size 1 1) (thickness 0.1))))
      (pad "" smd roundrect (at 1 2 120) (size 1 0.5) (layers "F.Paste") (roundrect_rratio 0.2))
      (pad "1" smd rect (at 1 2 120) (size 2 1) (layers "F.Cu") (net "GND"))
      (pad "" smd rect (at -1 -2 90) (size 1 1) (layers "F.Mask"))
      (pad "2" smd rect (at -1 -2 90) (size 2 1) (layers "F.Cu") (net "VCC"))
      (pad "3" smd rect (at 3 4 90) (size 1 1) (layers "F.Cu") (net "unconnected-(U1-Pad3)"))
      (pad "4" smd rect (at 5 6 90) (size 1 1) (layers "F.Cu")))
    (footprint "SAME" (layer "F.Cu") (at 30 40 -90)
      (property "Reference" "U2" (at 2 3 90) (layer "F.SilkS") (hide yes))
      (pad "1" smd rect (at 1 2 -60) (size 2 1) (layers "F.Cu") (net "GND")))
    (footprint "SAME" (layer "B.Cu") (at 50 60 30)
      (property "Reference" "U3" (at 2 3 30) (layer "B.SilkS")
        (effects (font (size 1 1)) (justify mirror)))
      (pad "1" smd rect (at -1 2 75) (size 2 1) (layers "B.Cu") (net "GND"))
      (fp_rect (start 0 0) (end 1 1) (fill yes) (layer "B.SilkS")))
    (gr_rect (start 5 6) (end 7 8) (stroke (width 0)) (fill yes) (layer "B.SilkS"))
    (gr_text "A\nB" (at 2 3 90) (layer "B.SilkS")
      (effects (font (size 1 1)) (justify mirror))))`);
  execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/convert-kicad.js'),
    'convert', src, dst], { stdio: 'pipe' });
  const docs = [];
  for (const rec of readRecords(path.join(dst, 'pcb/PCB1.epcb2'))) {
    if (rec.type === 'DOCHEAD') docs.push({ head: rec.body, records: [] });
    else docs.at(-1).records.push(rec);
  }
  const main = docs.find(d => d.head.docType === 'PCB').records;
  const attrs = main.filter(r => r.type === 'ATTR');
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);
  const mm = 1 / 39.3700787;
  const expected = { U1: [90, 30, 12, 19, 13, 18], U2: [270, 30, 28, 41, 27, 42] };
  for (const [ref, [angle, padAngle, px, py, tx, ty]] of Object.entries(expected)) {
    const comp = main.find(r => r.type === 'COMPONENT' && r.body.attrs['Unique ID'] === ref);
    close(comp.body.angle, angle);
    const binding = attrs.find(r => r.body.parentId === comp.id && r.body.key === 'Footprint');
    const pad = docs.find(d => d.head.uuid === binding.body.value).records.find(r => r.type === 'PAD');
    close(pad.body.padAngle, padAngle);
    const rad = angle * Math.PI / 180;
    close((comp.body.x + pad.body.centerX * Math.cos(rad) - pad.body.centerY * Math.sin(rad)) * mm, px);
    close(-(comp.body.y + pad.body.centerX * Math.sin(rad) + pad.body.centerY * Math.cos(rad)) * mm, py);
    const attr = attrs.find(r => r.body.parentId === comp.id && r.body.key === 'Designator').body;
    close(attr.x * mm, tx); close(-attr.y * mm, ty);
    assert.equal(attr.valueVisible, ref === 'U1');
  }
  const back = main.find(r => r.type === 'COMPONENT' && r.body.attrs['Unique ID'] === 'U3');
  const binding = attrs.find(r => r.body.parentId === back.id && r.body.key === 'Footprint');
  const backDoc = docs.find(d => d.head.uuid === binding.body.value);
  const pad = backDoc.records.find(r => r.type === 'PAD').body;
  close(back.body.angle, 30); close(pad.padAngle, 315);
  close(pad.centerX * mm, -1); close(pad.centerY * mm, 2);
  assert.equal(pad.layerId, 1);
  assert.ok(backDoc.records.some(r => r.type === 'FILL' && r.body.layerId === 3));
  assert.ok(main.some(r => r.type === 'FILL' && r.body.layerId === 4 && r.body.fillStyle === 'SOLID'));
  const text = main.find(r => r.type === 'STRING' && r.body.text === 'A\nB').body;
  assert.equal(text.mirror, true); close(text.angle, 90);
  for (const id of [15, 16]) {
    const layer = main.find(r => r.type === 'LAYER' && r.body.layerId === id).body;
    assert.equal(layer.use, true); assert.equal(layer.show, true);
    assert.ok(main.some(r => r.type === 'POUR' && r.body.layerId === id && r.body.netName === 'GND'));
  }
  assert.equal(main.find(r => r.type === 'LAYER' && r.body.layerId === 17).body.use, false);
  const stack = main.filter(r => r.type === 'LAYER_PHYS').sort((a, b) => a.body.zIndex - b.body.zIndex);
  assert.deepEqual(stack.map(r => JSON.parse(r.id)[1]), [3, 7, 5, 1, 361, 15, 362, 16, 363, 2, 6, 8, 4]);
  close(stack[3].body.thickness, 0.35); close(stack[6].body.thickness, 12.4);
  assert.ok(main.some(r => r.type === 'LINE' && r.body.layerId === 15 && r.body.netName === 'GND'));
  const u1 = main.find(r => r.type === 'COMPONENT' && r.body.attrs['Unique ID'] === 'U1');
  const u1lib = docs.find(d => d.head.uuid === attrs.find(r => r.body.parentId === u1.id && r.body.key === 'Footprint').body.value);
  const realPads = u1lib.records.filter(r => r.type === 'PAD');
  assert.equal(realPads.length, 4);
  assert.ok(u1lib.records.some(r => r.type === 'FILL' && r.body.layerId === 7));
  assert.ok(u1lib.records.some(r => r.type === 'FILL' && r.body.layerId === 5));
  for (const [num, net] of [['1', 'GND'], ['2', 'VCC'], ['3', 'unconnected-(U1-Pad3)'], ['4', '']]) {
    const pad = realPads.find(r => r.body.num === num);
    const binding = main.find(r => r.type === 'PAD_NET' && r.id === JSON.stringify(['PAD_NET', u1.id, num, pad.id]));
    assert.equal(binding.body.padNet, net);
    assert.ok(pad.body.topPasteExpansion < 0);
  }
  console.log('PCB 保真回归检查通过：旋转、丝印、四层叠层、铺铜和非铜开口/焊盘网络索引。');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
