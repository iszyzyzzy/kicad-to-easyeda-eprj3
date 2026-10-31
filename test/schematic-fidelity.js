'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { execFileSync } = require('child_process');
const { readRecords } = require('../scripts/lib/eprj3');
const { parseFootprintFile } = require('../scripts/lib/kicad');
const { buildFootprintRecords } = require('../scripts/lib/kicad-to-eprj3');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-slot-'));
try {
  const pretty = path.join(tmp, 'real.pretty');
  fs.mkdirSync(pretty);
  const mod = path.join(pretty, 'SLOT.kicad_mod');
  fs.writeFileSync(mod, `(footprint "SLOT"
    (pad "1" thru_hole oval (at 0 0 30) (size 3 2) (drill oval 2 1) (layers "*.Cu" "*.Mask"))
    (pad "2" np_thru_hole oval (at 4 0) (size 2 3) (drill oval 1 2) (layers "*.Cu" "*.Mask")))`);
  const pads = buildFootprintRecords(parseFootprintFile(mod)).records.filter(r => r.head.type === 'PAD');
  assert.equal(pads[0].body.hole.holeType, 'SLOT');
  assert.equal(pads[0].body.relativeAngle, 0);
  assert.equal(pads[0].body.padAngle, 30);
  assert.equal(pads[1].body.relativeAngle, 90);
  assert.equal(pads[1].body.plated, false);
  assert.ok(Math.abs(pads[1].body.hole.width / pads[1].body.hole.height - 2) < 1e-6);
  fs.writeFileSync(path.join(tmp, 'fp-lib-table'), '(fp_lib_table (lib (name "alias") (uri "${KIPRJMOD}/real.pretty")))');
  fs.writeFileSync(path.join(tmp, 'board.kicad_sch'), `(kicad_sch (paper "A2")
    (lib_symbols (symbol "TEST"
      (symbol "TEST_1_1" (pin passive line (at 2.54 0 180) (length 1.27)
        (name "P" (effects (font (size 1.27 1.27)))) (number "1")))))
    (symbol (lib_id "TEST") (at 25.4 25.4 90) (mirror x)
      (property "Reference" "J1" (at 25.4 25.4 90) (effects (font (size 1.27 1.27)) (hide yes)))
      (property "Value" "V" (at 25.4 25.4 0) (effects (font (size 1.27 1.27)) (hide no)))
      (property "Footprint" "alias:SLOT"))
    (wire (pts (xy 25.4 27.94) (xy 25.4 30.48)))
    (no_connect (at 25.4 27.94))
    (label "SIG" (at 25.4 30.48 90) (effects (font (size 1.27 1.27)))))`);
  const dst = path.join(tmp, 'out');
  execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/convert-kicad.js'), 'convert', tmp, dst]);
  const records = readRecords(path.join(dst, 'sch/Schematic1/P1.esch2'));
  const nc = records.find(r => r.type === 'ATTR' && r.body.key === 'NO_CONNECT');
  assert.ok(nc?.body.parentId);
  assert.equal(records.filter(r => r.type === 'WIRE').length, 1, '图框不能产生电气网络');
  assert.equal(records.find(r => r.type === 'ATTR' && r.body.key === 'Designator' && r.body.value === 'J1').body.valueVisible, false);
  assert.equal(records.find(r => r.type === 'ATTR' && r.body.key === 'Name' && r.body.value === 'V').body.valueVisible, true);
  assert.ok(records.find(r => r.type === 'ATTR' && r.body.key === 'Footprint')?.body.value);
  assert.equal(records.find(r => r.type === 'ATTR' && r.body.key === '_NETLABEL_').body.rotation, 90);
  assert.equal(records.find(r => r.type === 'ATTR' && r.body.key === 'Pin Name').body.fontSize, 5);
  const component = records.find(r => r.type === 'COMPONENT' && r.body.partId === 'TEST.1');
  assert.ok(component.body.y % 5 === 0);
  console.log('原理图与槽孔回归通过：镜像、格点、网络标签、NC、属性样式、库映射和槽孔轴向。');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

