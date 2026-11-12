'use strict';

const Clipper = require('clipper-lib');
// 以微米细分圆头边界，避免把电极指的圆头变成方角。
const SCALE = 1e6;
const ARC_ERROR = 0.001;

function customPadPolygon(node, pad, { findSub, findSubNode, extractPts, strokeWidthOf }) {
  const paths = [];
  const point = (x, y) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) });
  const add = pts => {
    const p = pts.map(p => point(p.x, p.y));
    if (!Clipper.Clipper.Orientation(p)) p.reverse();
    paths.push(p);
  };
  const stroke = (pts, width, closed) => {
    if (width <= 0) return;
    const offset = new Clipper.ClipperOffset(2, ARC_ERROR * SCALE);
    offset.AddPath(pts.map(p => point(p.x, p.y)), Clipper.JoinType.jtRound,
      closed ? Clipper.EndType.etClosedLine : Clipper.EndType.etOpenRound);
    const expanded = [];
    offset.Execute(expanded, width * SCALE / 2);
    paths.push(...expanded);
  };
  const circle = (cx, cy, r) => {
    const count = Math.max(16, Math.ceil(Math.PI / Math.acos(1 - Math.min(ARC_ERROR / r, 1))));
    return Array.from({ length: count }, (_, i) => ({ x: cx + r * Math.cos(i * 2 * Math.PI / count), y: cy + r * Math.sin(i * 2 * Math.PI / count) }));
  };
  const [w, h] = pad.size.map(Number);
  const anchor = findSub(findSubNode(node, 'options') || [], 'anchor')?.[0];
  add(anchor === 'rect' ? [{x:-w/2,y:-h/2},{x:w/2,y:-h/2},{x:w/2,y:h/2},{x:-w/2,y:h/2}] : circle(0, 0, w / 2));
  const primitives = findSubNode(node, 'primitives');
  for (const primitive of primitives?.slice(1) || []) {
    const kind = primitive[0]?.v;
    const width = strokeWidthOf(primitive, 0);
    const filled = ['yes', 'solid'].includes(findSub(primitive, 'fill')?.[0]);
    const xy = key => { const p = findSub(primitive, key); return { x: Number(p[0]), y: Number(p[1]) }; };
    let pts;
    if (kind === 'gr_line') { stroke([xy('start'), xy('end')], width, false); continue; }
    if (kind === 'gr_poly') pts = extractPts(primitive);
    else if (kind === 'gr_rect') {
      const a = xy('start'), b = xy('end');
      pts = [a, {x:b.x,y:a.y}, b, {x:a.x,y:b.y}];
    } else if (kind === 'gr_circle') {
      const c = xy('center'), e = xy('end');
      pts = circle(c.x, c.y, Math.hypot(e.x-c.x, e.y-c.y));
    } else throw new Error(`自定义焊盘 ${pad.number} 暂不支持 ${kind}`);
    if (filled) add(pts);
    stroke(pts, width, true);
  }
  const clipper = new Clipper.Clipper();
  clipper.AddPaths(paths, Clipper.PolyType.ptSubject, true);
  const result = [];
  clipper.Execute(Clipper.ClipType.ctUnion, result, Clipper.PolyFillType.pftNonZero, Clipper.PolyFillType.pftNonZero);
  // EasyEDA 的单个焊盘只接受一条轮廓；不能丢掉内洞或分离的铜岛。
  if (result.length !== 1) throw new Error(`自定义焊盘 ${pad.number} 含内洞或分离轮廓，无法表示为单个多边形焊盘`);
  return result[0].map(p => ({ x: p.X / SCALE, y: p.Y / SCALE }));
}

module.exports = { customPadPolygon };
