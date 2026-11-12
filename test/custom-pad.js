'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { parse, extractPads } = require('../scripts/lib/kicad');
const { footprintPadRecord } = require('../scripts/lib/kicad-to-eprj3');
const { readRecords } = require('../scripts/lib/eprj3');
const shape = `(pad "1" smd custom (at 2 3 120) (size 0.05 0.05) (layers "B.Cu") (net 1 "ROW")
  (options (anchor rect)) (primitives
  (gr_poly (pts (xy -0.15 -1.75) (xy 0.15 -1.75) (xy 0.15 1.75) (xy -0.15 1.75)) (width 0) (fill yes))))`;
const pad = extractPads(parse(`(footprint "F" ${shape})`))[0];
const body = footprintPadRecord(pad).body;
assert.equal(body.defaultPad.padType, 'RECT');
assert(Math.abs(body.defaultPad.width / 39.3700787 - 0.3) < 1e-6);
assert(Math.abs(body.defaultPad.height / 39.3700787 - 3.5) < 1e-6);
const xs = pad.polygon.map(p=>p.x), ys=pad.polygon.map(p=>p.y);
assert.equal(Math.max(...xs)-Math.min(...xs),0.3);
assert.equal(Math.max(...ys)-Math.min(...ys),3.5);
assert.equal(body.netName,'ROW');
// 检查指状电极的空隙，包围盒矩形会错误地短接这些区域。
const comb = extractPads(parse(`(footprint "C" (pad "2" smd custom (at 0 0) (size 0.05 0.05) (layers "F.Cu")
 (options (anchor circle)) (primitives
 (gr_line (start 0 -0.8) (end 0 0.8) (width 0.2))
 (gr_line (start 0 -0.8) (end 1.3 -0.8) (width 0.2))
 (gr_line (start 0 0.8) (end 1.3 0.8) (width 0.2)))))`))[0];
function inside(pts,x,y){let result=false;for(let i=0,j=pts.length-1;i<pts.length;j=i++){const a=pts[i],b=pts[j];if((a.y>y)!=(b.y>y)&&x<(b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x)result=!result;}return result;}
assert(inside(comb.polygon,1,0.8));
assert(inside(comb.polygon,0,0));
assert(!inside(comb.polygon,1,0));
assert(inside(comb.polygon,1.39,0.8));
const boardShape = shape.replace('(xy -0.15 -1.75)', '(xy -0.15 -1.7) (xy -0.1 -1.75)');
const boardPad = extractPads(parse(`(footprint "F" ${boardShape})`))[0];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'custom-pad-'));
try {
 fs.mkdirSync(path.join(tmp,'src'));
 const footprint = (x,net) => `(footprint "F" (layer "B.Cu") (at ${x} 20 90) ${boardShape.replace('"ROW"',`"${net}"`)}
 (fp_rect (start 0 0) (end 1 2) (fill solid) (layer "B.Mask"))
 (fp_rect (start -3 -4) (end 3 4) (layer "Edge.Cuts")))`;
 fs.writeFileSync(path.join(tmp,'src/board.kicad_pcb'), `(kicad_pcb (version 20211014) (net 1 "ROW") (net 2 "COL")
 ${footprint(10,'ROW')} ${footprint(30,'COL')})`);
 execFileSync(process.execPath,[path.resolve(__dirname,'../scripts/convert-kicad.js'),'convert',path.join(tmp,'src'),path.join(tmp,'out')],{stdio:'pipe'});
 const records=readRecords(path.join(tmp,'out/pcb/PCB1.epcb2'));
 assert(!records.some(r=>r.type==='PART'));
 const physical = records.filter(r=>r.type==='LAYER_PHYS').map(r=>JSON.parse(r.id)[1]);
 assert.deepEqual(physical,[3,7,5,1,361,2,6,8,4]);
 const docs=[];
 for(const r of records) { if(r.type==='DOCHEAD') docs.push({type:r.body.docType,records:[]}); else docs.at(-1).records.push(r); }
 const footprints=docs.filter(d=>d.type==='FOOTPRINT');
 assert.equal(footprints.length,1, '不同网络的实例共用同一份几何');
 for(const doc of footprints) {
   const layers=new Set(doc.records.filter(r=>r.type==='LAYER').map(r=>r.body.layerId));
   for(const r of doc.records) if(r.body?.layerId) assert(layers.has(r.body.layerId));
 }
 assert(records.some(r=>r.type==='PAD_NET'&&r.body.padNet==='COL'));
 const actual=records.find(r=>r.type==='PAD').body;
 assert.equal(actual.padAngle,330);
 // 客户端直接使用路径坐标，不会按 PAD.center 再平移或旋转。
 const expected=boardPad.polygon.map(p=>[(2+p.x*Math.cos(Math.PI/6)+p.y*Math.sin(Math.PI/6))*39.3700787,
   (3-p.x*Math.sin(Math.PI/6)+p.y*Math.cos(Math.PI/6))*39.3700787]).flat();
 const actualCoords=actual.defaultPad.path.filter(p=>typeof p==='number').slice(0,-2);
 assert.equal(actualCoords.length,expected.length);
 actualCoords.forEach((v,i)=>assert(Math.abs(v-expected[i])<1e-5));
 assert(records.some(r=>r.type==='FILL'&&r.body.layerId===5));
 assert(records.some(r=>r.type==='PAD_NET'&&r.body.padNet==='ROW'));
 assert.equal(records.filter(r=>r.type==='POLY'&&r.body.polyType==='BOARD_OUTLINE').length,2);
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
console.log('自定义焊盘回归通过：接触指尺寸、圆头电极间隙、底层旋转、网络、开窗及封装板边。');
