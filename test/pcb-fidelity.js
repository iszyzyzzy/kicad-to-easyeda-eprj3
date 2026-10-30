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
    (footprint "SAME" (layer "F.Cu") (at 10 20 90)
      (property "Reference" "U1" (at 2 3 90) (layer "F.SilkS")
        (effects (font (size 1 1) (thickness 0.1))))
      (pad "1" smd rect (at 1 2 120) (size 2 1) (layers "F.Cu") (net "GND")))
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
  console.log('PCB 保真回归检查通过：旋转、局部焊盘角度、底层镜像、位号位置/隐藏、实心图形、换行。');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
