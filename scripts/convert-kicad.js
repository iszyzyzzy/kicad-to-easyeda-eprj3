#!/usr/bin/env node
'use strict';
/**
 * convert-kicad.js — Convert a KiCad project (.kicad_pro + .kicad_sch + .kicad_pcb)
 *                    into an eprj3 project.
 *
 * Usage:
 *   node scripts/convert-kicad.js convert <KiCadProjectDir> <eprj3Dir> [--project-name <name>]
 *
 * The converter emits:
 *   - <dst>/<name>.eprj3                    project index
 *   - <dst>/sch/<Schematic1>/{P1.esch2,<name>.ecfg,<name>.evar}
 *         .esch2 embeds one SYMBOL doc + one DEVICE doc per used lib_id, then the
 *         SCH_PAGE doc whose DOCHEAD uuid equals the index' sheet uuid
 *   - <dst>/pcb/<PCB1>.epcb2
 *         embeds FOOTPRINT + DEVICE docs per used footprint, then the PCB doc
 *         (uuid == index' pcb uuid)
 *
 * Primitive coverage (per KiCad file-format docs → EasyEDA file-format docs):
 *   Schematic: wire→WIRE+LINE, bus→BUS+LINE, bus_entry→BUSENTRY, junction→CIRCLE,
 *     no_connect→引脚 NO_CONNECT ATTR, label/global_label/hierarchical_label→_NETLABEL_ ATTR,
 *     text/text_box→TEXT(+RECT), polyline/rectangle/circle/arc/bezier→POLY/RECT/
 *     CIRCLE/ARC/BEZIER, image→OBJ, hierarchical sheet→RECT+TEXT+ATTR,
 *     symbol→COMPONENT(+ATTR)
 *   PCB: segment→LINE (copper track), arc(track)→ARC, via→VIA, footprint→FOOTPRINT doc
 *     + COMPONENT + PAD_NET, gr_line→LINE, gr_arc→ARC, gr_rect/gr_poly/gr_circle/
 *     bezier→POLY, gr_text→STRING, zone→POUR+POURED (keepout→REGION),
 *     dimension→DIMENSION, Edge.Cuts→POLY BOARD_OUTLINE
 * Not migrated: 3D models, net classes, SPICE models, custom rules; anything
 * unrecognized is skipped with a warning.
 */
const fs = require('fs');
const path = require('path');
const { parse: parseSex, nodeSymbol, extractPts } = require('./lib/kicad');
const {
  buildSymbolRecords, buildFootprintRecords, pcbPolygonPath, kicadToEprj3, flipY, flipRot,
  kicadToSchUnit, flipYSch, circumcenter, arcSweep, mapStroke, mapFill
} = require('./lib/kicad-to-eprj3');
const { Project, uuid, randId, writeRecords, sheetDocRecords } = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const schema = [
  { name: 'project-name', hasValue: true, desc: 'Override project name' }
];

// PCB positions are mil; schematic positions are 0.254 mm units.
function toMil(x) { return kicadToEprj3(parseFloat(x)); }
function toSch(x) { return kicadToSchUnit(parseFloat(x)); }

// eprj3 page height in sch units per KiCad paper size. A4 (1170×825) is
// verified against official exports; the rest follow the same √2 A-series
// proportions the EasyEDA template uses.
const PAGE_HEIGHT_UNITS = { A4: 825, A3: 1167, A2: 1651, A1: 2334, A0: 3301, A: 550, B: 848, C: 1100, D: 1550, E: 2200 };
// KiCad paper sizes in mm (page_info.cpp / standardPageSizes)
const PAPER_SIZE_MM = {
  A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841],
  A: [279.4, 215.9], B: [431.8, 279.4], C: [558.8, 431.8], D: [863.6, 558.8], E: [1117.6, 863.6]
};
const MAGIC_PART_ID = 'pid8a0e77bacb214e'; // built-in power flags & sheet frame share this part id
const FRAME_TEMPLATE = require('./lib/frame-a4.json'); // extracted from a real EasyEDA export
// Static PCB editor config (PRIMITIVE/LAYER_PHYS/RULE*/SILK_OPTS/D3_ATTRIBUTE/
// PREFERENCE/PANELIZE) — the client hangs without it; extracted from a real export.
const PCB_CONFIG = require('./lib/pcb-config.json');
const { FOOTPRINT_CANVAS, FOOTPRINT_LAYERS } = require('./lib/elibz2');

function footprintLayerRecords() {
  const types = new Set(FOOTPRINT_LAYERS.map(layer => layer[0]));
  return PCB_CONFIG.filter(r => r.type === 'LAYER' && types.has(r.body.layerType))
    .map(r => ({ head: { type: 'LAYER', ticket: 1, id: r.id }, body: { ...r.body, use: true } }));
}

function docHead(docType, docUuid) {
  return { head: { type: 'DOCHEAD' }, body: { docType, client: uuid(16), uuid: docUuid, updateTime: Date.now(), version: String(Date.now()), editVersion: '4.1.36', user: {} } };
}

function metaRec(title, extra = {}) {
  return { head: { type: 'META', ticket: 1, id: 'META' }, body: { title, description: '', tags: [], source: '', ...extra } };
}

function findSub(node, key) {
  for (const it of node.slice(1)) if (Array.isArray(it) && it[0].v === key) return it.slice(1).map(x => x.v);
  return null;
}

function findSubNode(node, key) {
  for (const it of node.slice(1)) if (Array.isArray(it) && it[0].v === key) return it;
  return null;
}

function findChildValue(node, key) {
  for (const it of node.slice(1)) if (Array.isArray(it) && it[0].v === key && it[1]) return it[1].v;
  return null;
}

let ggeCounter = 0;
let warnCounter = 0;
function warn(msg) {
  if (++warnCounter <= 30) console.warn(`  warn: ${msg}`);
}

async function main() {
  const usage = 'convert-kicad.js convert <KiCadProjectDir> <eprj3Dir> [--project-name <name>]';
  const sub = process.argv[2];
  if (!sub || sub === 'help') { printHelp(usage, schema); process.exit(sub ? 0 : 1); }
  if (sub !== 'convert') die(`Unknown command: ${sub}`);
  const { opts, positional } = parseArgs(process.argv.slice(3), schema);
  const [srcArg, dstArg] = positional;
  if (!srcArg || !dstArg) { printHelp(usage, schema); die('Missing <KiCadProjectDir> or <eprj3Dir>', 1); }

  const src = path.resolve(srcArg);
  const dst = path.resolve(dstArg);
  if (!fs.existsSync(src)) die(`Source not found: ${src}`);
  const projectName = opts['project-name'] || path.basename(src);
  const project = await Project.create(dst, projectName);
  console.log(`Created eprj3 project at ${dst}`);

  // 先创建原理图所属的板卡，PCB 和原理图才能共享同一个 board。
  const schematicFiles = fs.readdirSync(src).filter(f => f.endsWith('.kicad_sch'));
  if (schematicFiles.length) project.ensureSchematic('Schematic1');

  // Walk PCBs
  const pcbs = fs.readdirSync(src).filter(f => f.endsWith('.kicad_pcb'));
  let pcbIdx = 1;
  const footprintLibrary = new Map();
  const footprintDocs = [];
  for (const pcbFile of pcbs) {
    const pcb = project.ensurePcb(`PCB${pcbIdx++}`);
    const file = project.pcbFile(pcb);
    const converted = convertPcb(path.join(src, pcbFile), file, pcb);
    footprintDocs.push(...converted.docs);
    for (const fp of converted.footprints) if (!footprintLibrary.has(fp.name)) footprintLibrary.set(fp.name, fp);
    project.save();
    console.log(`  pcb: ${pcbFile} -> ${file}`);
  }

  // PCB 未使用的封装从项目库或本机 KiCad 库读取，不能以空 UUID 冒充绑定。
  const roots = [src, path.join(src, 'footprints'), ...Object.entries(process.env)
    .filter(([k]) => /^KICAD\d+_FOOTPRINT_DIR$/.test(k)).map(([, v]) => v)];
  if (process.platform === 'win32') {
    const base = path.join(process.env.ProgramFiles || 'C:/Program Files', 'KiCad');
    if (fs.existsSync(base)) for (const ver of fs.readdirSync(base)) roots.push(path.join(base, ver, 'share/kicad/footprints'));
  } else roots.push('/usr/share/kicad/footprints', '/usr/local/share/kicad/footprints');
  const libraryPaths = new Map();
  const tableFile = path.join(src, 'fp-lib-table');
  if (fs.existsSync(tableFile)) {
    const table = parseSex(fs.readFileSync(tableFile, 'utf8'));
    for (const lib of table.filter(n => Array.isArray(n) && n[0].v === 'lib')) {
      const uri = findChildValue(lib, 'uri')?.replace(/\$\{([^}]+)\}/g, (_, key) => key === 'KIPRJMOD' ? src : process.env[key] || '');
      if (uri) libraryPaths.set(findChildValue(lib, 'name'), path.resolve(src, uri));
    }
  }
  for (const schFile of schematicFiles) {
    const root = parseSex(fs.readFileSync(path.join(src, schFile), 'utf8'));
    for (const n of root.filter(n => Array.isArray(n) && n[0].v === 'symbol')) {
      const name = collectProperties(n).Footprint;
      if (!name || footprintLibrary.has(name)) continue;
      const [library, item] = name.split(':');
      const candidates = roots.map(dir => path.join(dir, library + '.pretty', item + '.kicad_mod'));
      if (libraryPaths.has(library)) candidates.unshift(path.join(libraryPaths.get(library), item + '.kicad_mod'));
      const file = candidates.find(f => fs.existsSync(f));
      if (!file) { warn(`找不到原理图封装库：${name}`); continue; }
      const fp = require('./lib/kicad').parseFootprintFile(file);
      const docUuid = uuid(16), built = buildFootprintRecords(fp, { includePart: false, canvasBody: FOOTPRINT_CANVAS });
      built.records.unshift(...footprintLayerRecords());
      footprintDocs.push(docHead('FOOTPRINT', docUuid), metaRec(name), ...built.records);
      footprintLibrary.set(name, { name, docUuid });
    }
  }

  // Walk schematics
  const schs = fs.readdirSync(src).filter(f => f.endsWith('.kicad_sch'));
  let schIdx = 1;
  for (const schFile of schs) {
    const sch = project.ensureSchematic(`Schematic${schIdx++}`);
    const sheet = project.ensureSheet(sch, 'P1');
    const file = project.sheetFile(sheet);
    convertSchematic(path.join(src, schFile), file, sch, sheet, { projectName, pageCount: schs.length, footprintLibrary, footprintDocs });
    project.save();
    console.log(`  sch: ${schFile} -> ${file}`);
  }

  if (warnCounter > 30) console.warn(`  warn: ... ${warnCounter} warnings total`);
}

// ---------------------------------------------------------------- schematic

function convertSchematic(srcFile, dst, sch, sheet, opts = {}) {
  const root = parseSex(fs.readFileSync(srcFile, 'utf8'));

  const paper = findChildValue(root, 'paper') || 'A4';
  // 保持图纸偏移落在 50 mil 格点上，不能让整张图离格。
  const pageH = Math.round((PAGE_HEIGHT_UNITS[paper] || PAGE_HEIGHT_UNITS.A4) / 5) * 5;
  if (!PAGE_HEIGHT_UNITS[paper]) warn(`unknown paper "${paper}", using A4 page height`);
  const pageCount = opts.pageCount || 1;

  // KiCad title_block → the frame's title-block attrs (Company/Drawed/Version).
  const titleBlock = root.slice(1).find(n => Array.isArray(n) && n[0].v === 'title_block');
  const tb = {};
  if (titleBlock) {
    const company = findChildValue(titleBlock, 'company');
    const date = findChildValue(titleBlock, 'date');
    const rev = findChildValue(titleBlock, 'rev');
    if (company) tb.Company = company;
    if (date) tb.Drawed = date;
    if (rev) tb.Version = rev;
  }
  // Values for the KiCad default title-block texts (%x format substitutions).
  const kicadFrameFields = {
    date: (titleBlock && findChildValue(titleBlock, 'date')) || '',
    rev: (titleBlock && findChildValue(titleBlock, 'rev')) || '',
    title: (titleBlock && findChildValue(titleBlock, 'title')) || '',
    company: (titleBlock && findChildValue(titleBlock, 'company')) || '',
    version: findChildValue(root, 'generator_version') || '',
    file: srcFile.split(/[\\/]/).pop() || '',
    comments: (() => {
      const out = {};
      if (titleBlock) for (const it of titleBlock.slice(1)) {
        if (Array.isArray(it) && it[0].v === 'comment') out[it[1]?.v] = it[2]?.v || '';
      }
      return out;
    })()
  };
  // KiCad sheet (Y-down, origin top-left) → eprj3 page (Y-down, origin at the
  // frame's bottom-left corner): only a constant downward shift, no flip.
  const pageY = v => flipYSch(v, pageH);

  // lib_symbols: top-level entries are keyed by full lib_id (e.g. "Device:R")
  const libs = {};
  for (const node of root.slice(1)) {
    if (Array.isArray(node) && node[0].v === 'lib_symbols') {
      for (const symNode of node.slice(1)) {
        if (Array.isArray(symNode) && symNode[0].v === 'symbol') {
          const sym = nodeSymbol(symNode);
          if (sym.name) libs[sym.name] = sym;
        }
      }
    }
  }

  const libDocs = [];
  const usedLibs = {};
  function ensureSymbolDoc(libId) {
    if (usedLibs[libId]) return usedLibs[libId];
    const shortName = libId.split(':').pop();
    const libSym = libs[libId] || libs[shortName];
    const name = (libSym && libSym.name) || shortName;
    const isPower = /^power:/i.test(libId);
    const netName = isPower ? ((libSym && libSym.properties && libSym.properties.Value) || shortName) : null;
    const symDocUuid = uuid(16);
    const devUuid = uuid(16);
    const partId = isPower ? MAGIC_PART_ID : name + '.1';
    const { records: symRecs, nameOff } = buildSymbolRecords(libSym || { name, pins: [], shapes: [] }, {
      partId,
      partTitle: isPower ? '' : partId,
      isPower,
      netName
    });
    libDocs.push(
      docHead('SYMBOL', symDocUuid),
      isPower
        ? { head: { type: 'META', ticket: 1, id: 'META' }, body: { title: name, description: '', tags: ['特殊器件', '网络标识'], docType: 18, source: '' } }
        : metaRec(name, { docType: 2 }),
      ...symRecs
    );
    libDocs.push(
      docHead('DEVICE', devUuid),
      metaRec(name, {
        images: [],
        attributes: isPower
          ? { Symbol: symDocUuid, 'Global Net Name': netName, Description: '', Name: netName, SymbolName: JSON.stringify({ name, uuid: symDocUuid, source: '' }) }
          : { Symbol: symDocUuid, SymbolName: JSON.stringify({ name, uuid: symDocUuid, source: '' }) }
      })
    );
    usedLibs[libId] = { symDocUuid, devUuid, partId, name, isPower, netName, nameOff, records: symRecs };
    return usedLibs[libId];
  }

  const pageRecords = sheetDocRecords(sch, sheet); // DOCHEAD SCH_PAGE + META + CANVAS
  let ticket = 2;
  let busEntryOrder = 0;
  const noConnects = [];
  const netLabels = [];
  const placedPins = [];
  let componentZ = 0; // placed components need a real zIndex (official exports use 1,2,3…)
  const rec = (type, body, id) => {
    ticket++;
    pageRecords.push({ head: { type, ticket, id: id || randId() }, body: { ...body, zIndex: body.zIndex != null ? body.zIndex : ticket } });
  };

  for (const node of root.slice(1)) {
    if (!Array.isArray(node)) continue;
    const head = node[0].v;

    if (head === 'wire' || head === 'bus') {
      // Official structure: the WIRE/BUS head id IS the shared lineGroup id of
      // its LINE children.
      const groupId = randId();
      ticket++;
      pageRecords.push({ head: { type: head === 'wire' ? 'WIRE' : 'BUS', ticket, id: groupId }, body: { groupId: '', locked: false, zIndex: ticket } });
      const pts = extractWirePoints(node);
      for (let i = 0; i < pts.length - 1; i++) {
        ticket++;
        pageRecords.push({
          head: { type: 'LINE', ticket, id: randId() },
          body: {
            fillColor: null, fillStyle: 'NONE', strokeColor: null, strokeStyle: 'SOLID', strokeWidth: null,
            startX: toSch(pts[i][0]), startY: pageY(pts[i][1]),
            endX: toSch(pts[i + 1][0]), endY: pageY(pts[i + 1][1]),
            lineGroup: groupId
          }
        });
      }
    } else if (head === 'bus_entry') {
      const at = findSub(node, 'at');
      const size = findSub(node, 'size');
      if (!at || !size) { warn('bus_entry without at/size'); continue; }
      const x1 = toSch(at[0]), y1 = pageY(at[1]);
      const x2 = toSch(parseFloat(at[0]) + parseFloat(size[0])), y2 = pageY(parseFloat(at[1]) + parseFloat(size[1]));
      const rot = Math.round((((Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI) % 360) + 360) % 360 / 90) * 90 % 360;
      ticket++;
      pageRecords.push({
        head: { type: 'BUSENTRY', ticket, id: randId() },
        body: { order: ++busEntryOrder, pointX: x2, pointY: y2, rotation: rot, groupId: '', locked: false, zIndex: ticket }
      });
    } else if (head === 'junction') {
      const [x, y] = findAtXY(node);
      const dArr = findSub(node, 'diameter');
      const d = dArr && parseFloat(dArr[0]) > 0 ? parseFloat(dArr[0]) : 1.016; // KiCad diameter 0 = auto (default mm)
      rec('CIRCLE', {
        partId: '', groupId: '', locked: false,
        centerX: toSch(x), centerY: pageY(y), radius: toSch(d) / 2,
        strokeColor: null, strokeStyle: 'SOLID', fillColor: '#000000', strokeWidth: null, fillStyle: 'SOLID'
      });
    } else if (head === 'no_connect') {
      const [x, y] = findAtXY(node);
      const cx = toSch(x), cy = pageY(y);
      noConnects.push([cx, cy]);
    } else if (head === 'label' || head === 'global_label' || head === 'hierarchical_label') {
      const [x, y] = findAtXY(node);
      const val = findValue(node);
      const fx = textEffects(node);
      const rot = findAtXY(node)[2] || 0;
      netLabels.push({ x: toSch(x), y: pageY(y), value: val, rotation: Number(rot), size: fx.size || 5 });
    } else if (head === 'text' || head === 'text_box') {
      const [x, y, rot] = findAtXY(node);
      const val = findValue(node);
      if (!val) continue;
      const fx = textEffects(node);
      if (head === 'text_box') {
        const s = findSub(node, 'start');
        const e = findSub(node, 'end');
        const pts = findPtsSub(node);
        let x1, y1, x2, y2;
        if (pts && pts.length >= 4) {
          x1 = toSch(pts[0][0]); y1 = pageY(pts[0][1]); x2 = toSch(pts[2][0]); y2 = pageY(pts[2][1]);
        } else if (s && e) {
          x1 = toSch(s[0]); y1 = pageY(s[1]); x2 = toSch(e[0]); y2 = pageY(e[1]);
        } else { x1 = x2 = toSch(x); y1 = y2 = pageY(y); }
        rec('RECT', {
          partId: '', groupId: '', locked: false,
          dotX1: x1, dotY1: y1, dotX2: x2, dotY2: y2,
          radiusX: 0, radiusY: 0, rotation: 0,
          strokeColor: null, strokeStyle: null, fillColor: '', strokeWidth: 1, fillStyle: 'NONE'
        });
      }
      ticket++;
      pageRecords.push({
        head: { type: 'TEXT', ticket, id: randId() },
        body: {
          groupId: '', x: toSch(x), y: pageY(y), rotation: ((rot || 0) % 360 + 360) % 360, color: null, fontFamily: null,
          fontSize: fx.size || 5, fontWeight: fx.bold || null, italic: fx.italic || null,
          underline: null, strikeout: null, align: fx.align || 'CENTER_MIDDLE', value: val, fillColor: null,
          locked: false, zIndex: ticket
        }
      });
    } else if (head === 'polyline') {
      const pts = extractWirePoints(node);
      if (pts.length < 2) continue;
      rec('POLY', shapeCommon(node, {
        points: pts.map(p => ({ x: toSch(p[0]), y: pageY(p[1]) })),
        closed: false, startShape: 'NONE', endShape: 'NONE'
      }));
    } else if (head === 'rectangle') {
      const s = findSub(node, 'start');
      const e = findSub(node, 'end');
      if (!s || !e) continue;
      rec('RECT', shapeCommon(node, {
        dotX1: toSch(s[0]), dotY1: pageY(s[1]), dotX2: toSch(e[0]), dotY2: pageY(e[1]),
        radiusX: 0, radiusY: 0, rotation: 0
      }));
    } else if (head === 'circle') {
      const c = findSub(node, 'center');
      const r = findSub(node, 'radius');
      if (!c || !r) continue;
      rec('CIRCLE', shapeCommon(node, {
        centerX: toSch(c[0]), centerY: pageY(c[1]), radius: toSch(r[0])
      }));
    } else if (head === 'arc') {
      const a = require('./lib/kicad').extractArc(node);
      if (a.mx == null) continue;
      const cx1 = toSch(a.x1), cy1 = pageY(a.y1);
      const cxm = toSch(a.mx), cym = pageY(a.my);
      const cx2 = toSch(a.x2), cy2 = pageY(a.y2);
      rec('ARC', shapeCommon(node, {
        startX: cx1, startY: cy1, referX: cxm, referY: cym, endX: cx2, endY: cy2
      }));
    } else if (head === 'bezier') {
      const pts = extractWirePoints(node);
      if (pts.length < 4) continue;
      rec('BEZIER', shapeCommon(node, {
        controls: pts.flatMap(p => [toSch(p[0]), pageY(p[1])])
      }));
    } else if (head === 'image') {
      const [x, y] = findAtXY(node);
      const dataArr = findSub(node, 'data');
      const sc = findSub(node, 'scale');
      const sx = sc ? parseFloat(sc[0]) || 1 : 1;
      const sy = sc ? parseFloat(sc[1]) || 1 : 1;
      if (!dataArr || !dataArr[0]) { warn('image without embedded data'); continue; }
      ticket++;
      pageRecords.push({
        head: { type: 'OBJ', ticket, id: randId() },
        body: {
          partId: '', groupId: '', locked: false, zIndex: ticket,
          fileName: 'image.png', startX: toSch(x), startY: pageY(y),
          width: Math.round(20 * sx), height: Math.round(20 * sy),
          rotation: 0, isMirror: false,
          content: 'data:image/png;base64,' + dataArr[0]
        }
      });
    } else if (head === 'sheet') {
      convertHierSheet(node, rec, pageY);
    } else if (head === 'symbol') {
      const libId = findChildValue(node, 'lib_id');
      if (!libId) continue;
      const lib = ensureSymbolDoc(libId);
      const [x, y, rot] = findAtXY(node);
      const props = collectProperties(node);
      const mirrors = findFlags(node, 'mirror');
      // KiCad (mirror y) = left-right flip = eprj3 isMirror; (mirror x) = top-bottom
      // flip = isMirror + 180°. Sheet angles are CCW-on-screen like eprj3 — no flip.
      let isMirror = mirrors.includes('y');
      let rotation = (((rot || 0) % 360) + 360) % 360;
      // KiCad 镜像发生在图纸坐标系，旋转与镜像不能交换顺序。
      if (mirrors.length) rotation = (360 - rotation) % 360;
      if (mirrors.includes('x')) { isMirror = !isMirror; rotation = (rotation + 180) % 360; }
      const compId = randId();
      const compX = toSch(x), compY = pageY(y);
      const rad = rotation * Math.PI / 180;
      for (const pin of lib.records.filter(r => r.head.type === 'PIN')) {
        const px = pin.body.x * (isMirror ? -1 : 1), py = pin.body.y;
        const pinRad = pin.body.rotation * Math.PI / 180;
        const dx = -Math.cos(pinRad) * (isMirror ? -1 : 1), dy = Math.sin(pinRad);
        placedPins.push({ id: compId + pin.head.id,
          dx: Math.round(dx * Math.cos(rad) + dy * Math.sin(rad)),
          dy: Math.round(-dx * Math.sin(rad) + dy * Math.cos(rad)),
          x: Math.round((compX + px * Math.cos(rad) + py * Math.sin(rad)) * 1e6) / 1e6,
          y: Math.round((compY - px * Math.sin(rad) + py * Math.cos(rad)) * 1e6) / 1e6 });
      }

      // KiCad property positions are absolute page coords — reuse them so
      // Designator/Name land exactly where KiCad drew them (user issue: big ICs
      // overlapped a fixed +10/+10 offset).
      const propPos = {};
      const propStyles = {};
      for (const it of node.slice(1)) {
        if (!(Array.isArray(it) && it[0].v === 'property')) continue;
        const at = findSub(it, 'at');
        if (at && at.length >= 2 && /^[\d.-]+$/.test(String(at[0])) && /^[\d.-]+$/.test(String(at[1]))) {
          propPos[it[1]?.v] = [toSch(at[0]), pageY(at[1])];
          const fx = textEffects(it), eff = findSubNode(it, 'effects') || [];
          propStyles[it[1]?.v] = { // KiCad 属性位置已经是图纸坐标，但角度仍需叠加符号旋转。
            rotation: ((Number(at[2]) + Number(rot || 0)) % 180 + 180) % 180, fontSize: fx.size, align: fx.align || 'CENTER_MIDDLE', valueVisible: !(findChildValue(it, 'hide') === 'yes' || findFlags(eff, 'hide').includes('yes') || eff.some(n => !Array.isArray(n) && n.v === 'hide')), fontWeight: fx.bold, italic: fx.italic };
        }
      }
      ticket++;
      pageRecords.push({
        head: { type: 'COMPONENT', ticket, id: compId },
        body: {
          partId: lib.partId,
          // 客户端先旋转再镜像；本地几何计算采用先镜像再旋转。
          x: compX, y: compY, rotation: isMirror ? (360 - rotation) % 360 : rotation, isMirror,
          attrs: lib.isPower
            ? { Footprints: '[]', Devices: '[]', DeviceName: null, FootprintName: null }
            : {
                Footprints: '[]', Devices: '[]',
                DeviceName: JSON.stringify({ uuid: lib.devUuid, name: props.Value || lib.name || libId, source: '' }),
                FootprintName: null, pinClass: {}, differentialPairClass: {}, Symbols: '[]'
              },
          zIndex: ++componentZ
        }
      });
      if (lib.isPower) {
        // 电源的显示名称与电气网络名分开绑定，名称位置由符号朝向决定。
        pageRecords.push(pageLinkAttr(compId, ++ticket, 'Symbol', lib.symDocUuid));
        pageRecords.push(pageLinkAttr(compId, ++ticket, 'Device', lib.devUuid));
        pageRecords.push(pageLinkAttr(compId, ++ticket, 'Relevance', '[]'));
        // 名称跟随实际符号方向，放在图形外侧，不沿用可能落在导线上的字段偏移。
        const coords = [];
        for (const r of lib.records) {
          const b = r.body;
          if (r.head.type === 'POLY') coords.push(...b.points);
          else if (r.head.type === 'RECT') coords.push({ x: b.dotX1, y: b.dotY1 }, { x: b.dotX2, y: b.dotY2 });
          else if (r.head.type === 'CIRCLE') coords.push({ x: b.centerX - b.radius, y: b.centerY - b.radius }, { x: b.centerX + b.radius, y: b.centerY + b.radius });
        }
        const world = coords.map(p => {
          const x = p.x * (isMirror ? -1 : 1), y = p.y;
          return { x: x * Math.cos(rad) + y * Math.sin(rad), y: -x * Math.sin(rad) + y * Math.cos(rad) };
        });
        const xs = world.map(p => p.x), ys = world.map(p => p.y);
        const minX = Math.min(0, ...xs), maxX = Math.max(0, ...xs), minY = Math.min(0, ...ys), maxY = Math.max(0, ...ys);
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        const horizontal = Math.abs(cx) > Math.abs(cy);
        const nameX = compX + (horizontal ? (cx > 0 ? maxX + 3 : minX - 3) : 0);
        const nameY = compY + (horizontal ? 0 : (cy > 0 ? maxY + 3 : minY - 3));
        const align = horizontal ? (cx > 0 ? 'LEFT_MIDDLE' : 'RIGHT_MIDDLE') : (cy > 0 ? 'CENTER_TOP' : 'CENTER_BOTTOM');
        pageRecords.push(pageAttr(compId, ++ticket, 'Name', props.Value || lib.netName || lib.name,
          nameX, nameY, align, { ...propStyles.Value, rotation: 0, align, fontSize: propStyles.Value?.fontSize || 5 }));
        pageRecords.push(pageLinkAttr(compId, ++ticket, 'Global Net Name', props.Value || lib.netName || lib.name));
      } else {
        // Binding ATTRs, as in official app exports: EasyEDA resolves the placed
        // symbol through them (Symbol = SYMBOL doc uuid, Device = DEVICE doc uuid);
        // without them the instance renders empty.
        pageRecords.push(pageLinkAttr(compId, ++ticket, 'Symbol', lib.symDocUuid));
        pageRecords.push(pageLinkAttr(compId, ++ticket, 'Device', lib.devUuid));
        pageRecords.push(pageLinkAttr(compId, ++ticket, 'Unique ID', props.Reference || 'gge' + (++ggeCounter)));
        // Designator/Name at the KiCad property positions when present,
        // otherwise just right of the origin like official exports.
        const [dsgX, dsgY] = propPos.Reference || [compX + 10, compY];
        const [valX, valY] = propPos.Value || [compX + 10, compY + 10];
        if (props.Reference) pageRecords.push(pageAttr(compId, ++ticket, 'Designator', props.Reference, dsgX, dsgY, null, propStyles.Reference || { fontSize: null }));
        pageRecords.push(pageLinkAttr(compId, ++ticket, 'Footprint', opts.footprintLibrary?.get(props.Footprint)?.docUuid || ''));
        if (props.Value) pageRecords.push(pageAttr(compId, ++ticket, 'Name', props.Value, valX, valY, null, propStyles.Value || { fontSize: null }));
        pageRecords.push(pageLinkAttr(compId, ++ticket, 'Reuse Block', ''));
        pageRecords.push(pageLinkAttr(compId, ++ticket, 'Group ID', ''));
        pageRecords.push(pageLinkAttr(compId, ++ticket, 'Channel ID', ''));
      }
    } else if (!['lib_symbols', 'uuid', 'paper', 'title_block', 'version', 'generator', 'generator_version', 'junction', 'at', 'instances', 'path', 'sheet_instances', 'embedded_fonts'].includes(head)) {
      warn(`schematic: unhandled "${head}" skipped`);
    }
  }

  // 网络名挂在真实导线上。引脚直贴标签先沿引脚向外引出 100 mil，避免文字压住引脚。
  const onLine = (p, b) => Math.abs((p.x - b.startX) * (b.endY - b.startY) - (p.y - b.startY) * (b.endX - b.startX)) < 1e-5
    && p.x >= Math.min(b.startX, b.endX) - 1e-5 && p.x <= Math.max(b.startX, b.endX) + 1e-5
    && p.y >= Math.min(b.startY, b.endY) - 1e-5 && p.y <= Math.max(b.startY, b.endY) + 1e-5;
  for (const label of netLabels) {
    const pin = placedPins.find(p => Math.abs(p.x - label.x) < 1e-5 && Math.abs(p.y - label.y) < 1e-5);
    let wire = pageRecords.find(r => r.head.type === 'LINE' && onLine(label, r.body));
    let { x, y } = label;
    let dx = Math.round(Math.cos(label.rotation * Math.PI / 180));
    let dy = -Math.round(Math.sin(label.rotation * Math.PI / 180));
    if (!wire) {
      if (pin) { dx = pin.dx; dy = pin.dy; }
      const gid = randId();
      rec('WIRE', { groupId: '', locked: false }, gid);
      // 紧邻其他引脚或导线时缩短引线，不能为了排版制造短路。
      const obstacles = [...placedPins, ...netLabels, ...pageRecords.filter(r => r.head.type === 'LINE')
        .flatMap(r => [{ x: r.body.startX, y: r.body.startY }, { x: r.body.endX, y: r.body.endY }])]
        .filter(p => Math.abs(p.x - x) > 1e-5 || Math.abs(p.y - y) > 1e-5);
      const length = [10, 5, 2.5, 1.25].find(len => {
        const seg = { startX: x, startY: y, endX: x + dx * len, endY: y + dy * len };
        return !obstacles.some(p => onLine(p, seg)) && !pageRecords.some(r => r.head.type === 'LINE' && onLine({ x: seg.endX, y: seg.endY }, r.body));
      });
      if (!length) throw new Error(`网络 ${label.value} 没有安全的短引线空间 (${x}, ${y})`);
      const endX = x + dx * length, endY = y + dy * length;
      rec('LINE', { startX: x, startY: y, endX, endY, lineGroup: gid,
        strokeColor: null, strokeStyle: 'SOLID', strokeWidth: null, fillColor: null, fillStyle: 'NONE' });
      wire = pageRecords.at(-1);
      x = endX; y = endY;
    }
    const b = wire.body;
    if (Math.abs(x - b.startX) < 1e-5 && Math.abs(y - b.startY) < 1e-5) {
      dx = Math.sign(b.startX - b.endX); dy = Math.sign(b.startY - b.endY);
    } else if (Math.abs(x - b.endX) < 1e-5 && Math.abs(y - b.endY) < 1e-5) {
      dx = Math.sign(b.endX - b.startX); dy = Math.sign(b.endY - b.startY);
    }
    const vertical = dy !== 0;
    const align = vertical ? (dy < 0 ? 'LEFT_BOTTOM' : 'RIGHT_BOTTOM') : (dx < 0 ? 'RIGHT_BOTTOM' : 'LEFT_BOTTOM');
    pageRecords.push(pageAttr(wire.body.lineGroup, ++ticket, 'NET', label.value,
      x + dx * 2, y + dy * 2, align, { rotation: vertical ? 90 : 0, fontSize: label.size }));
  }

  for (const [x, y] of noConnects) {
    const pin = placedPins.find(p => Math.abs(p.x - x) < 1e-5 && Math.abs(p.y - y) < 1e-5);
    if (pin) pageRecords.push(pageAttr(pin.id, ++ticket, 'NO_CONNECT', 'yes', x, y, null, { valueVisible: false }));
    else warn(`未连接标记未找到引脚：${x}, ${y}`);
  }

  // Sheet frame (docType 20 "Drawing-Symbol_A4"): the app renders the border
  // from this built-in template; we embed its SYMBOL + DEVICE docs verbatim and
  // place a frame COMPONENT at the page origin with the title-block ATTRs.
  const frameCompId = randId();
  const frameDeviceUuid = (FRAME_TEMPLATE.device.find(r => r.type === 'DOCHEAD').body).uuid;
  const frameSymbolUuid = (FRAME_TEMPLATE.symbol.find(r => r.type === 'DOCHEAD').body).uuid;
  const now = new Date();
  const pad2 = n => String(n).padStart(2, '0');
  const dateStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const timeStr = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  const frameValueOverrides = {
    '@Project Name': opts.projectName || 'KiCad Project',
    '@Schematic Name': sch.title || 'Schematic1',
    '@Page Name': sheet.title,
    '@Page No': String(sheet.zIndex || 1),
    '@Page Count': String(pageCount),
    '@Create Date': dateStr, '@Update Date': dateStr,
    '@Create Time': timeStr, '@Update Time': timeStr,
    // The built-in frame graphics are suppressed; KiCad's own frame is drawn
    // below as native records instead (keeps the A4 page size handling).
    Border: '0', 'Title Block': '0',
    ...tb
  };
  pageRecords.push({
    head: { type: 'COMPONENT', ticket: ++ticket, id: frameCompId },
    body: {
      partId: MAGIC_PART_ID, x: 0, y: 0, rotation: 0, isMirror: false,
      attrs: {
        Footprints: '[]', Devices: '[]',
        DeviceName: JSON.stringify({ uuid: frameDeviceUuid, name: 'Drawing-Symbol_A4', source: '' })
      },
      zIndex: null
    }
  });
  for (const r of FRAME_TEMPLATE.pageAttrs) {
    ticket++;
    pageRecords.push({
      head: { type: 'ATTR', ticket, id: randId() },
      body: { ...r.body, parentId: frameCompId, value: frameValueOverrides[r.body.key] != null ? frameValueOverrides[r.body.key] : r.body.value, zIndex: ticket }
    });
  }
  drawKicadFrame(rec, paper, pageH, {
    ...kicadFrameFields,
    sheetNo: String(sheet.zIndex || 1),
    sheetCount: String(pageCount),
    paper,
    sheetPath: '/'
  });

  writeRecords(dst, [
    ...FRAME_TEMPLATE.symbol, ...FRAME_TEMPLATE.device,
    ...(opts.footprintDocs || []), ...libDocs, ...pageRecords
  ]);
}

// Draw KiCad's default worksheet frame (double border, 50 mm grid references,
// title block) as native LINE/TEXT records — a faithful port of
// kicad-source-mirror common/page_layout/page_layout_default_description.cpp:
// margins 10 mm, ref pitch 50 mm, title block 108×32 mm at the bottom-right,
// all coordinates relative to the corners (default = bottom-right).
function drawKicadFrame(rec, paper, pageH, f) {
  const [W, H] = PAPER_SIZE_MM[paper] || PAPER_SIZE_MM.A4;
  const M = 10; // margins in mm
  const X = mm => toSch(mm);
  const Y = mm => flipYSch(mm, pageH);
  const LW = 0.59; // KiCad default 0.15 mm stroke
  // 图框是装饰图形，不能编码成电气导线，否则 DRC 会报游离网络。
  const line = (x1, y1, x2, y2) => rec('POLY', {
    groupId: '', locked: false, fillColor: '', fillStyle: 'NONE',
    strokeColor: null, strokeStyle: 'SOLID', strokeWidth: LW,
    points: [{ x: X(x1), y: Y(y1) }, { x: X(x2), y: Y(y2) }],
    closed: false, startShape: 'NONE', endShape: 'NONE'
  });
  const text = (value, xmm, ymm, fontSize, opts = {}) => {
    if (!value) return;
    rec('TEXT', {
      groupId: '', x: X(xmm), y: Y(ymm), rotation: 0, color: null, fontFamily: null,
      fontSize, fontWeight: opts.bold || null, italic: opts.italic || null,
      underline: null, strikeout: null, align: opts.align || 'LEFT_MIDDLE',
      value, fillColor: null, locked: false
    });
  };
  const nextNum = v => (/\d/.test(v) ? String(parseInt(v, 10) + 1) : String.fromCharCode(v.charCodeAt(0) + 1));

  // double border: (M,M)-(W-M,H-M) and (M+2,M+2)-(W-M-2,H-M-2)
  line(M, M, W - M, M); line(W - M, M, W - M, H - M); line(W - M, H - M, M, H - M); line(M, H - M, M, M);
  line(M + 2, M + 2, W - M - 2, M + 2); line(W - M - 2, M + 2, W - M - 2, H - M - 2); line(W - M - 2, H - M - 2, M + 2, H - M - 2); line(M + 2, H - M - 2, M + 2, M + 2);

  // grid reference bands: ticks + auto-incrementing refs (1,2,3... / A,B,C...).
  // Top/bottom refs count from the left; left counts from the top, right from
  // the bottom (ltcorner/lbcorner/rtcorner origins in the KiCad description).
  const refSize = 5.1; // 1.3 mm
  for (let x = M + 50; x < W - M; x += 50) { line(x, M, x, M + 2); line(x, H - M - 2, x, H - M); }
  for (let y = M + 50; y < H - M; y += 50) line(M, y, M + 2, y);
  for (let y = H - M - 50; y > M; y -= 50) line(W - M - 2, y, W - M, y);
  for (let x = M + 25, n = '1'; x <= W - M; x += 50, n = nextNum(n)) {
    text(n, x, M + 1, refSize, { align: 'CENTER_MIDDLE' });
    text(n, x, H - M - 1, refSize, { align: 'CENTER_MIDDLE' });
  }
  for (let y = M + 25, n = 'A'; y <= H - M; y += 50, n = nextNum(n)) {
    text(n, M + 1, y, refSize, { align: 'CENTER_MIDDLE' });
    text(n, W - M - 1, H - y, refSize, { align: 'CENTER_MIDDLE' });
  }

  // title block
  const TX = W - 110, TY = H - 34, BX = W - 2, BY = H - 2;
  line(TX, TY, BX, TY); line(BX, TY, BX, BY); line(BX, BY, TX, BY); line(TX, BY, TX, TY);
  line(TX, H - 5.5, BX, H - 5.5);
  line(TX, H - 8.5, BX, H - 8.5);
  line(TX, H - 12.5, BX, H - 12.5);
  line(TX, H - 18.5, BX, H - 18.5);
  line(W - 90, H - 8.5, W - 90, H - 5.5);
  line(W - 26, H - 8.5, W - 26, BY);
  const ts = 5.9;  // 1.5 mm default text
  text(`Id: ${f.sheetNo}/${f.sheetCount}`, W - 24, H - 4.1, ts);
  text(f.version, W - 109, H - 4.1, ts);
  text(`Date: ${f.date}`, W - 87, H - 6.9, ts);
  text(`Rev: ${f.rev}`, W - 24, H - 6.9, ts, { bold: true });
  text(`Size: ${f.paper}`, W - 109, H - 6.9, ts);
  text(`Title: ${f.title}`, W - 109, H - 10.7, 7.9, { bold: true, italic: true });
  text(`File: ${f.file}`, W - 109, H - 14.3, ts);
  text(`Sheet: ${f.sheetPath}`, W - 109, H - 17, ts);
  text(f.company, W - 109, H - 20, ts, { bold: true });
  for (let i = 0; i < 4; i++) text(f.comments[i] || '', W - 109, H - 23 - 3 * i, ts);
}

// KiCad graphical-item stroke/fill → eprj3 schematic shape common fields
function shapeCommon(node, extra) {
  const strokeNode = findSubNode(node, 'stroke');
  const fillNode = findSubNode(node, 'fill');
  const s = strokeNode ? mapStroke({ width: parseFloat((findSub(strokeNode, 'width') || [null])[0]), type: (findSub(strokeNode, 'type') || [null])[0] }) : { strokeWidth: null, strokeStyle: 'SOLID' };
  const f = mapFill(fillNode ? (findSub(fillNode, 'type') || [null])[0] : null);
  return {
    partId: '', groupId: '', locked: false,
    strokeColor: null, strokeStyle: s.strokeStyle, fillColor: f.fillColor,
    strokeWidth: s.strokeWidth, fillStyle: f.fillStyle,
    ...extra
  };
}

// Hierarchical sheet: box + name text + per-pin net labels
function convertHierSheet(node, rec, pageY) {
  const at = findSub(node, 'at');
  const size = findSub(node, 'size');
  const props = collectProperties(node);
  if (!at || !size) { warn('sheet without at/size'); return; }
  const x = toSch(at[0]), y = pageY(at[1]);
  const x2 = toSch(parseFloat(at[0]) + parseFloat(size[0]));
  const y2 = pageY(parseFloat(at[1]) + parseFloat(size[1]));
  rec('RECT', {
    partId: '', groupId: '', locked: false,
    dotX1: x, dotY1: y, dotX2: x2, dotY2: y2,
    radiusX: 0, radiusY: 0, rotation: 0,
    strokeColor: null, strokeStyle: null, fillColor: '', strokeWidth: 2, fillStyle: 'NONE'
  });
  const name = props['Sheet name'] || props['SheetName'] || '';
  if (name) {
    rec('TEXT', {
      groupId: '', x: (x + x2) / 2, y: Math.max(y, y2) + 5, rotation: 0, color: null, fontFamily: null,
      fontSize: 5, fontWeight: null, italic: null, underline: null, strikeout: null, align: 'CENTER_BOTTOM',
      value: name, fillColor: null, locked: false
    });
  }
  for (const it of node.slice(1)) {
    if (Array.isArray(it) && it[0].v === 'pin') {
      const pinName = it[1]?.v || '';
      const atSub = findSub(it, 'at');
      if (!atSub) continue;
      rec('ATTR', {
        key: '_NETLABEL_', parentId: '', keyVisible: false, valueVisible: true, groupId: '', rotation: 0,
        x: toSch(atSub[0]), y: pageY(atSub[1]), color: '#0000FF', fontFamily: 'Arial',
        fontSize: 5, align: 'CENTER_MIDDLE', value: pinName, locked: false
      });
    }
  }
}

function textEffects(node) {
  const out = { size: null, bold: null, italic: null, align: null };
  const eff = findSubNode(node, 'effects');
  if (!eff) return out;
  const font = findSubNode(eff, 'font');
  if (font) {
    const size = findSub(font, 'size');
    if (size) out.size = Math.max(1, Math.round(toSch(size[0]) * 100) / 100);
    out.bold = findFlags(font, 'bold').length ? true : null;
    out.italic = findFlags(font, 'italic').length ? true : null;
  }
  const justify = findSub(eff, 'justify');
  if (justify) {
    const h = justify.includes('left') ? 'LEFT' : justify.includes('right') ? 'RIGHT' : 'CENTER';
    const v = justify.includes('top') ? 'TOP' : justify.includes('bottom') ? 'BOTTOM' : 'MIDDLE';
    out.align = `${h}_${v}`;
  }
  return out;
}

function pageAttr(parentId, ticket, key, value, x, y, align, extra = {}) {
  return {
    head: { type: 'ATTR', ticket, id: randId() },
    body: {
      x, y, rotation: 0, color: null, fontFamily: null, fontSize: 5,
      fontWeight: null, italic: null, underline: null, strikeout: null, align,
      value, keyVisible: false, valueVisible: true, key,
      fillColor: null, groupId: '', parentId, zIndex: ticket, locked: false,
      ...extra
    }
  };
}

// Non-visual binding ATTR (Symbol/Device/Unique ID): no position, as the
// official app writes them on placed components.
function pageLinkAttr(parentId, ticket, key, value) {
  return {
    head: { type: 'ATTR', ticket, id: randId() },
    body: {
      x: null, y: null, rotation: null, color: null, fontFamily: null, fontSize: null,
      fontWeight: null, italic: null, underline: null, strikeout: null, align: null,
      value, keyVisible: null, valueVisible: null, key,
      fillColor: null, parentId, zIndex: ticket
    }
  };
}

function extractWirePoints(node) {
  // wire/polyline nodes have (pts (xy x y) (xy x y) ...)
  const out = [];
  for (const it of node.slice(1)) {
    if (Array.isArray(it) && it[0].v === 'pts') {
      for (const xy of it.slice(1)) {
        if (Array.isArray(xy) && xy[0].v === 'xy') out.push([parseFloat(xy[1].v), parseFloat(xy[2].v)]);
      }
    }
  }
  return out;
}

function findPtsSub(node) {
  const ptsNode = findSubNode(node, 'pts');
  if (!ptsNode) return null;
  const out = [];
  for (const xy of ptsNode.slice(1)) {
    if (Array.isArray(xy) && xy[0].v === 'xy') out.push([parseFloat(xy[1].v), parseFloat(xy[2].v)]);
  }
  return out.length ? out : null;
}

function findAtXY(node) {
  for (const it of node.slice(1)) {
    if (Array.isArray(it) && it[0].v === 'at') return [parseFloat(it[1].v), parseFloat(it[2].v), parseFloat(it[3]?.v || 0)];
  }
  return [0, 0, 0];
}

function findValue(node) {
  // first bare quoted-string argument (token t === 'str')
  for (const it of node.slice(1)) {
    if (it && typeof it === 'object' && it.t === 'str') return it.v;
  }
  return '';
}

function findFlags(node, name) {
  const out = [];
  for (const it of node.slice(1)) {
    if (Array.isArray(it) && it[0].v === name) {
      for (const x of it.slice(1)) if (x && typeof x.v === 'string') out.push(x.v);
    }
  }
  return out;
}

function collectProperties(node) {
  const out = {};
  for (const it of node.slice(1)) {
    if (Array.isArray(it) && it[0].v === 'property') out[it[1]?.v] = it[2]?.v;
  }
  return out;
}

// ---------------------------------------------------------------------- pcb

// KiCad canonical layer → eprj3 layerId (official 60-layer table)
const LAYER_IDS = {
  'F.Cu': 1, 'B.Cu': 2, 'F.SilkS': 3, 'B.SilkS': 4,
  'F.Mask': 5, 'B.Mask': 6, 'F.Paste': 7, 'B.Paste': 8,
  'F.Adhes': 9, 'B.Adhes': 10, 'Edge.Cuts': 11,
  'F.CrtYd': 13, 'B.CrtYd': 13, 'Dwgs.User': 13, 'Cmts.User': 13,
  'F.Fab': 9, 'B.Fab': 10, 'Eco1.User': 14, 'Eco2.User': 14
};

function layerToId(name) {
  if (!name) return 1;
  if (LAYER_IDS[name] !== undefined) return LAYER_IDS[name];
  const m = /^In(\d+)\.Cu$/.exec(name);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 32) return 14 + n;
  }
  if (/^User\.\d+$/.test(name)) return 14;
  return 1;
}

function pcbConfigFor(root) {
  const config = structuredClone(PCB_CONFIG);
  const table = findSubNode(root, 'layers');
  const copper = new Set([1, 2]);
  // 已声明但没有走线的内层同样属于板层，不能按图元数量推测层数。
  if (table) for (const layer of table.slice(1)) {
    if (Array.isArray(layer) && /^(F|B|In\d+)\.Cu$/.test(layer[1]?.v || ''))
      copper.add(layerToId(layer[1].v));
  }
  if (!table) {
    const visit = node => {
      if (!Array.isArray(node)) return;
      if (['layer', 'layers'].includes(node[0]?.v))
        for (const token of node.slice(1))
          if (/^In\d+\.Cu$/.test(token?.v || '')) copper.add(layerToId(token.v));
      for (const child of node) if (Array.isArray(child)) visit(child);
    };
    visit(root);
  }
  for (const rec of config) if (rec.type === 'LAYER' && rec.body.layerId >= 15 && rec.body.layerId <= 46) {
    rec.body.use = copper.has(rec.body.layerId);
    rec.body.show = rec.body.use;
  }

  const setup = findSubNode(root, 'setup');
  const stackup = setup && findSubNode(setup, 'stackup');
  const physical = [];
  let dielectric = 361;
  const addPhys = (id, props) => physical.push({ type: 'LAYER_PHYS',
    id: JSON.stringify(['LAYER_PHYS', id]), body: { material: '', thickness: 0,
      permittivity: 0, lossTangent: 0, isKeepIsland: true, ...props, zIndex: physical.length + 1 } });
  const addDielectric = id => {
    const existing = config.find(r => r.type === 'LAYER' && r.body.layerId === id);
    if (existing) { existing.body.use = true; return; }
    const body = structuredClone(config.find(r => r.type === 'LAYER' && r.body.layerId === 361).body);
    Object.assign(body, { layerId: id, layerName: `Dielectric${id - 360}`, use: true });
    config.push({ type: 'LAYER', id: JSON.stringify(['LAYER', id]), body });
  };
  if (stackup) for (const layer of stackup.slice(1)) {
    if (!Array.isArray(layer) || layer[0]?.v !== 'layer') continue;
    const name = layer[1]?.v || '';
    let id;
    if (/^dielectric \d+$/.test(name)) { id = dielectric++; addDielectric(id); }
    else if (LAYER_IDS[name] !== undefined || /^In\d+\.Cu$/.test(name)) id = layerToId(name);
    else continue;
    addPhys(id, { material: findSub(layer, 'material')?.[0] || '',
      // LAYER_PHYS 使用 0.1 mm 单位，与图形坐标的 mil 不同。
      thickness: Number(findSub(layer, 'thickness')?.[0] || 0) * 10,
      permittivity: Number(findSub(layer, 'epsilon_r')?.[0] || 0),
      lossTangent: Number(findSub(layer, 'loss_tangent')?.[0] || 0) });
  }
  if (!physical.length) {
    const order = [1, ...[...copper].filter(id => id >= 15).sort((a, b) => a - b), 2];
    const total = Number(findSub(findSubNode(root, 'general') || [], 'thickness')?.[0] || 1.6);
    for (let i = 0; i < order.length; i++) {
      addPhys(order[i], { thickness: 0.35 });
      if (i < order.length - 1) {
        const id = dielectric++;
        addDielectric(id);
        addPhys(id, { material: 'FR4', thickness: (total - order.length * 0.035) / (order.length - 1) * 10,
          permittivity: 4.5 });
      }
    }
  }
  return [...config.filter(r => r.type !== 'LAYER_PHYS'), ...physical];
}

function convertPcb(srcFile, dst, pcb) {
  const root = parseSex(fs.readFileSync(srcFile, 'utf8'));

  // (net <num> "<name>") table at board level
  const netNames = {};
  for (const node of root.slice(1)) {
    if (Array.isArray(node) && node[0].v === 'net' && node[1] && /^\d+$/.test(node[1].v || '')) {
      const name = normNet(node[2]?.v || '');
      if (name) netNames[node[1].v] = name;
    }
  }

  const libDocs = [];
  const usedFps = {};
  function ensureFootprintDoc(name, fpData) {
    // 同名封装可能有实例修改和底层镜像，不能仅按库名复用第一份几何。
    const anonymized = { ...fpData, pads: fpData.pads.map(p => ({ ...p, netName: '' })) };
    const key = name + JSON.stringify(anonymized);
    if (usedFps[key]) return usedFps[key];
    const docUuid = uuid(16);
    const devUuid = uuid(16);
    // 网络属于实例，几何相同的阵列单元共用封装。
    const { records: fpRecs, pads } = buildFootprintRecords({ name, pads: anonymized.pads, shapes: anonymized.shapes, value: fpData.value }, { includePart: false, canvasBody: FOOTPRINT_CANVAS });
    libDocs.push(docHead('FOOTPRINT', docUuid), metaRec(name), ...footprintLayerRecords(), ...fpRecs);
    libDocs.push(docHead('DEVICE', devUuid), metaRec(name, { images: [], attributes: { Symbol: '', Footprint: docUuid } }));
    usedFps[key] = { name, docUuid, devUuid, pads };
    return usedFps[key];
  }

  // DOCHEAD + META + the static editor config block the client requires.
  const docRecords = [
    docHead('PCB', pcb.uuid),
    { head: { type: 'META', ticket: 1, id: 'META' }, body: { title: pcb.title, parent: '', source: '', board: pcb.board, zIndex: null } },
    ...pcbConfigFor(root).map((r, i) => ({ head: { type: r.type, ticket: 2 + i, id: r.id }, body: r.body }))
  ];
  let ticket = docRecords.length + 1;
  const body = [];
  const compBody = [];
  const usedNets = new Set();
  const outlinePaths = [];
  const openSegments = [];
  const nextTicket = () => ++ticket;
  const push = (type, recBody, id) => {
    body.push({ head: { type, ticket: nextTicket(), id: id || randId() }, body: recBody });
    return ticket;
  };
  const pcbLineCommon = { partitionId: '', groupId: 0, locked: false, zIndex: -1 };
  // 封装也可承载板边，必须与板级轮廓一起闭合。
  const boardNodes = root.slice(1);
  for (const fp of root.slice(1)) {
    if (!Array.isArray(fp) || fp[0]?.v !== 'footprint') continue;
    const at = findSub(fp, 'at') || [0, 0, 0];
    const angle = Number(at[2] || 0) * Math.PI / 180;
    for (const shape of fp.slice(1)) {
      if (!Array.isArray(shape) || findSub(shape, 'layer')?.[0] !== 'Edge.Cuts') continue;
      if (!['fp_line', 'fp_arc', 'fp_poly', 'fp_circle', 'fp_rect'].includes(shape[0]?.v)) continue;
      const transformed = structuredClone(shape);
      transformed[0].v = shape[0].v.replace('fp_', 'gr_');
      if (shape[0].v === 'fp_rect') {
        const a = findSub(shape, 'start'), b = findSub(shape, 'end');
        transformed[0].v = 'gr_poly';
        transformed.push([{v:'pts'}, ...[[a[0],a[1]],[b[0],a[1]],[b[0],b[1]],[a[0],b[1]]].map(p => [{v:'xy'},{v:p[0]},{v:p[1]}])]);
      }
      const transform = n => {
        if (!Array.isArray(n)) return;
        if (['start','end','mid','center','xy'].includes(n[0]?.v)) {
          const x = Number(n[1].v), y = Number(n[2].v);
          n[1].v = String(Number(at[0]) + x * Math.cos(angle) + y * Math.sin(angle));
          n[2].v = String(Number(at[1]) - x * Math.sin(angle) + y * Math.cos(angle));
        } else n.forEach(transform);
      };
      transform(transformed);
      boardNodes.push(transformed);
    }
  }


  for (const node of boardNodes) {
    if (!Array.isArray(node)) continue;
    const head = node[0].v;

    if (head === 'segment') {
      const start = findSub(node, 'start');
      const end = findSub(node, 'end');
      if (!start || !end) continue;
      const widthArr = findSub(node, 'width');
      const width = widthArr ? parseFloat(widthArr[0]) : 0.25;
      const layerArr = findSub(node, 'layer');
      const layerId = layerToId(layerArr ? layerArr[0] : 'F.Cu');
      const netName = netOf(node, netNames);
      if (netName) usedNets.add(netName);
      push('LINE', {
        ...pcbLineCommon, netName, layerId,
        startX: toMil(start[0]), startY: flipY(start[1]),
        endX: toMil(end[0]), endY: flipY(end[1]),
        width: toMil(width)
      });
    } else if (head === 'arc') {
      // track arc: start/mid/end → ARC (start/end + CCW-positive sweep angle)
      const s = findSub(node, 'start');
      const m = findSub(node, 'mid');
      const e = findSub(node, 'end');
      if (!s || !m || !e) { warn('track arc without start/mid/end'); continue; }
      const widthArr = findSub(node, 'width');
      const width = widthArr ? parseFloat(widthArr[0]) : 0.25;
      const layerArr = findSub(node, 'layer');
      const layerId = layerToId(layerArr ? layerArr[0] : 'F.Cu');
      const netName = netOf(node, netNames);
      if (netName) usedNets.add(netName);
      const x1 = toMil(s[0]), y1 = flipY(s[1]);
      const mx = toMil(m[0]), my = flipY(m[1]);
      const x2 = toMil(e[0]), y2 = flipY(e[1]);
      const { sweep } = arcSweep(x1, y1, mx, my, x2, y2);
      push('ARC', {
        ...pcbLineCommon, netName, layerId,
        startX: x1, startY: y1, endX: x2, endY: y2,
        angle: r2(sweep), arcType: 'DOT', width: toMil(width)
      });
    } else if (head === 'via') {
      const at = findSub(node, 'at');
      const sizeArr = findSub(node, 'size');
      const drillArr = findSub(node, 'drill');
      if (!at) continue;
      const netName = netOf(node, netNames);
      if (netName) usedNets.add(netName);
      push('VIA', {
        ...pcbLineCommon, groupId: '0', netName, ruleName: '',
        centerX: toMil(at[0]), centerY: flipY(at[1]),
        holeDiameter: drillArr ? toMil(drillArr[0]) : 0,
        viaDiameter: sizeArr ? toMil(sizeArr[0]) : 0,
        viaType: 'NORMAL', topSolderExpansion: null, bottomSolderExpansion: null,
        unusedInnerLayers: [], propagationDelay: 0
      });
    } else if (head === 'footprint') {
      const pushComp = (type, recBody, id) => {
        compBody.push({ head: { type, ticket: nextTicket(), id: id || randId() }, body: recBody });
        return ticket;
      };
      convertFootprint(node, {
        netNames, usedNets, usedFps, ensureFootprintDoc, nextTicket, push: pushComp, body: compBody
      });
    } else if (head === 'gr_line' || head === 'gr_arc' || head === 'gr_rect' || head === 'gr_circle' || head === 'gr_poly' || head === 'bezier') {
      const layerArr = findSub(node, 'layer');
      const lname = layerArr ? layerArr[0] : '';
      const isEdge = lname === 'Edge.Cuts';
      if (head === 'gr_line') {
        const s = findSub(node, 'start');
        const e = findSub(node, 'end');
        if (!s || !e) continue;
        const width = strokeWidthOf(node, 0.15);
        if (isEdge) {
          openSegments.push([toMil(s[0]), flipY(s[1]), 'L', toMil(e[0]), flipY(e[1])]);
        } else {
          push('LINE', {
            ...pcbLineCommon, netName: '', layerId: layerToId(lname),
            startX: toMil(s[0]), startY: flipY(s[1]), endX: toMil(e[0]), endY: flipY(e[1]),
            width: toMil(width)
          });
        }
      } else if (head === 'gr_arc') {
        const s = findSub(node, 'start');
        const m = findSub(node, 'mid');
        const e = findSub(node, 'end');
        if (!s || !m || !e) { warn('gr_arc without start/mid/end'); continue; }
        const width = strokeWidthOf(node, 0.15);
        if (isEdge) {
          openSegments.push(arcOutlinePath(s, m, e));
        } else {
          const x1 = toMil(s[0]), y1 = flipY(s[1]);
          const mx = toMil(m[0]), my = flipY(m[1]);
          const x2 = toMil(e[0]), y2 = flipY(e[1]);
          const { sweep } = arcSweep(x1, y1, mx, my, x2, y2);
          push('ARC', {
            ...pcbLineCommon, netName: '', layerId: layerToId(lname),
            startX: x1, startY: y1, endX: x2, endY: y2,
            angle: r2(sweep), arcType: 'DOT', width: toMil(width)
          });
        }
      } else if (head === 'gr_rect') {
        const s = findSub(node, 'start');
        const e = findSub(node, 'end');
        if (!s || !e) continue;
        const x1 = toMil(s[0]), y1 = flipY(s[1]), x2 = toMil(e[0]), y2 = flipY(e[1]);
        const path = [x1, y1, 'L', x2, y1, x2, y2, x1, y2, x1, y1];
        if (isEdge) outlinePaths.push(path);
        else push('POLY', { ...pcbLineCommon, netName: '', layerId: layerToId(lname), width: toMil(strokeWidthOf(node, 0.15)), path, polyType: 'NORMAL' });
      } else if (head === 'gr_circle') {
        const c = findSub(node, 'center');
        const e = findSub(node, 'end');
        if (!c || !e) continue;
        const cx = toMil(c[0]), cy = flipY(c[1]);
        const r = Math.hypot(toMil(e[0]) - cx, flipY(e[1]) - cy);
        if (isEdge) {
          outlinePaths.push([['CIRCLE', cx, cy, r, 1]]);
        } else {
          push('POLY', { ...pcbLineCommon, netName: '', layerId: layerToId(lname), width: toMil(strokeWidthOf(node, 0.15)), path: [['CIRCLE', cx, cy, r, 1]], polyType: 'NORMAL' });
        }
      } else if (head === 'gr_poly') {
        const pts = extractPts(node);
        if (!pts || pts.length < 3) continue;
        const flat = [];
        for (const p of pts) flat.push(toMil(p.x), flipY(p.y));
        const path = pcbPolygonPath(flat);
        if (!path) continue;
        if (isEdge) outlinePaths.push(path);
        else push('POLY', { ...pcbLineCommon, netName: '', layerId: layerToId(lname), width: toMil(strokeWidthOf(node, 0.15)), path, polyType: 'NORMAL' });
      } else if (head === 'bezier') {
        const pts = extractPts(node);
        if (!pts || pts.length < 4) continue;
        const flat = [];
        for (const p of pts) flat.push(toMil(p.x), flipY(p.y));
        push('POLY', {
          ...pcbLineCommon, netName: '', layerId: layerToId(lname), width: toMil(strokeWidthOf(node, 0.15)),
          path: [flat[0], flat[1], 'C', ...flat.slice(2)], polyType: 'NORMAL'
        });
      }
      if (!isEdge && ['solid', 'yes'].includes(findSub(node, 'fill')?.[0]) && ['gr_rect', 'gr_poly', 'gr_circle'].includes(head)) {
        const rec = body.at(-1);
        if (rec?.head.type === 'POLY') {
          const path = rec.body.path;
          rec.head.type = 'FILL';
          delete rec.body.polyType;
          Object.assign(rec.body, { fillStyle: 'SOLID', width: 0,
            path: Array.isArray(path[0]) ? path : [path] });
        }
      }
    } else if (head === 'gr_text') {
      const val = typeof node[1]?.v === 'string' ? node[1].v : '';
      if (!val) continue;
      push('STRING', pcbString(node, val));
    } else if (head === 'dimension') {
      convertDimension(node, push);
    } else if (head === 'zone') {
      convertZone(node, { netNames, usedNets, push });
    } else if (!['kicad_pcb', 'version', 'generator', 'generator_version', 'general', 'paper', 'layers', 'setup', 'net', 'property', 'images', 'group', 'embedded_fonts'].includes(head)) {
      warn(`pcb: unhandled "${head}" skipped`);
    }
  }

  // 直线和圆弧必须共同组成闭合轮廓，不能把每段强行闭合成板框。
  for (const chain of chainSegments(openSegments)) {
    const closed = Math.hypot(chain[0] - chain.at(-2), chain[1] - chain.at(-1)) < 0.01;
    if (closed) outlinePaths.push(chain);
    else {
      warn('PCB 板框存在未闭合路径，保留为普通线条');
      push('POLY', { ...pcbLineCommon, netName: '', layerId: 11, width: 10, path: chain, polyType: 'NORMAL' });
    }
  }
  for (const path of outlinePaths) {
    const outPath = rectDescriptor(path) || path;
    push('POLY', { ...pcbLineCommon, netName: '', layerId: 11, width: 10, path: outPath, polyType: 'BOARD_OUTLINE' });
  }

  // NET index records — the official head id is the JSON array ["NET",<name>]
  // and the default net "" has an empty payload.
  const netRecords = [{ head: { type: 'NET', ticket: nextTicket(), id: JSON.stringify(['NET', '']) }, body: null }];
  for (const netName of [...usedNets].sort()) {
    if (!netName) continue;
    netRecords.push({
      head: { type: 'NET', ticket: nextTicket(), id: JSON.stringify(['NET', netName]) },
      body: { netType: null, specialColor: null, retLine: true, differentialName: null, isPositiveNet: false, equalLengthGroupName: null }
    });
  }

  // File order mirrors real exports: config → NETs → components(+PAD_NET/ATTR) →
  // default RULE_SELECTOR → drawing items. Tickets are renumbered to match.
  const ordered = [
    ...docRecords,
    ...netRecords,
    ...compBody,
    { head: { type: 'RULE_SELECTOR', ticket: 0, id: JSON.stringify(['RULE_SELECTOR', ['NET', '']]) }, body: {} },
    ...body
  ];
  let t = 1;
  for (const rec of ordered) {
    if (rec.head.type === 'DOCHEAD') continue;
    rec.head.ticket = ++t;
  }
  writeRecords(dst, [...libDocs, ...ordered]);
  return { docs: libDocs, footprints: Object.values(usedFps) };
}

// 保留 KiCad 为未连接引脚生成的独立网络名，避免同号引脚的网络身份被合并。
function normNet(name) {
  if (!name) return '';
  return name.replace(/\{slash\}/g, '/');
}

function r2(v) { return Math.round(v * 100) / 100; }

function netOf(node, netNames) {
  const netArr = findSub(node, 'net');
  // KiCad 10 直接存网络名；旧格式仍通过编号查表，数字名称用引号区分。
  const netNode = findSubNode(node, 'net');
  if (!netArr) return '';
  return netNode[1]?.t === 'str' ? normNet(netArr[0]) : (netNames[netArr[0]] || normNet(netArr[1] || ''));
}



function strokeWidthOf(node, fallback) {
  const w = findSub(node, 'width');
  if (w) return parseFloat(w[0]);
  const stroke = findSubNode(node, 'stroke');
  if (stroke) {
    const sw = findSub(stroke, 'width');
    if (sw) return parseFloat(sw[0]);
  }
  return fallback;
}

// Edge.Cuts arc → closed outline single-polygon with an ARC segment
function arcOutlinePath(s, m, e) {
  const x1 = toMil(s[0]), y1 = flipY(s[1]);
  const mx = toMil(m[0]), my = flipY(m[1]);
  const x2 = toMil(e[0]), y2 = flipY(e[1]);
  const { sweep } = arcSweep(x1, y1, mx, my, x2, y2);
  return [x1, y1, 'ARC', r2(sweep), x2, y2];
}

// gr_text → PCB STRING record body
function pcbString(node, val) {
  const at = findSub(node, 'at');
  const layerArr = findSub(node, 'layer');
  const layerId = layerToId(layerArr ? layerArr[0].replace(/ knockout$/, '') : 'F.SilkS');
  const eff = findSubNode(node, 'effects');
  const font = eff ? findSubNode(eff, 'font') : null;
  const size = font ? findSub(font, 'size') : null;
  const fontSize = size ? Math.max(5, toMil(size[0])) : 25;
  const thick = font ? findSub(font, 'thickness') : null;
  const justify = eff ? findSub(eff, 'justify') : null;
  const h = justify && justify.includes('left') ? 'LEFT' : justify && justify.includes('right') ? 'RIGHT' : 'CENTER';
  const v = justify && justify.includes('top') ? 'TOP' : justify && justify.includes('bottom') ? 'BOTTOM' : 'MIDDLE';
  const knockout = layerArr && layerArr[0] && /knockout/.test(layerArr[0]);
  return {
    partitionId: '', groupId: 0, locked: false, zIndex: -1, layerId,
    x: at ? toMil(at[0]) : 0, y: at ? flipY(at[1]) : 0,
    text: val, fontFamily: 'default', fontSize,
    strokeWidth: thick ? Math.max(1, toMil(thick[0])) : 6,
    bold: font && findFlags(font, 'bold').length ? 1 : 0,
    italic: font && findFlags(font, 'italic').length ? 1 : 0,
    origin: `${h}_${v}`,
    angle: ((Number(at && at[2]) || 0) % 360 + 360) % 360,
    reverse: !!knockout, expansion: 0,
    mirror: !!justify?.includes('mirror'),
    specialColor: null
  };
}

// KiCad dimension → eprj3 DIMENSION (payload shape follows real app exports:
// dimensionType "LENGTH-CONSTRAINT" + controlDot, not the TS-shape schema)
function convertDimension(node, push) {
  const typeArr = findSub(node, 'type');
  const ktype = typeArr ? typeArr[0] : 'aligned';
  const layerArr = findSub(node, 'layer');
  const layerId = layerToId(layerArr ? layerArr[0] : 'Cmts.User');
  const ptsNode = findSubNode(node, 'pts');
  const pts = [];
  if (ptsNode) {
    for (const xy of ptsNode.slice(1)) {
      if (Array.isArray(xy) && xy[0].v === 'xy') pts.push([toMil(xy[1].v), flipY(xy[2].v)]);
    }
  }
  const style = findSubNode(node, 'style');
  const thick = style ? findSub(style, 'thickness') : null;
  const common = {
    partitionId: '', groupId: 0, layerId, type: 'LENGTH', unit: 'mm',
    strokeWidth: thick ? toMil(thick[0]) : 2, precision: 4,
    textFollow: true, locked: false, zIndex: -1
  };
  let controlDot = null;
  if ((ktype === 'aligned' || ktype === 'orthogonal') && pts.length >= 2) {
    const heightArr = findSub(node, 'height');
    const hMm = heightArr ? parseFloat(heightArr[0]) : 0;
    const [p1, p2] = pts;
    const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
    const L = Math.hypot(dx, dy) || 1;
    const nx = -dy / L * toMil(hMm), ny = dx / L * toMil(hMm);
    controlDot = [p1[0], p1[1], p2[0], p2[1], r2(p2[0] + nx), r2(p2[1] + ny), r2(p1[0] + nx), r2(p1[1] + ny)];
  } else if (ktype === 'leader' && pts.length >= 2) {
    controlDot = [pts[0][0], pts[0][1], pts[1][0], pts[1][1], pts[1][0], pts[1][1], pts[0][0], pts[0][1]];
  } else if (ktype === 'radial' && pts.length >= 2) {
    controlDot = [pts[0][0], pts[0][1], pts[1][0], pts[1][1], pts[1][0], pts[1][1], pts[0][0], pts[0][1]];
  } else {
    warn(`dimension type "${ktype}" not convertible`);
    return;
  }
  const textNode = findSubNode(node, 'gr_text');
  const text = textNode ? pcbString(textNode, textNode[1]?.v || '') : pcbString(node, '');
  text.layerId = layerId;
  if (!textNode) { text.x = null; text.y = null; }
  const format = findSubNode(node, 'format');
  common.precision = Number((format && findSub(format, 'precision')?.[0]) ?? 4);
  let coords = [...controlDot.slice(6, 8), ...controlDot.slice(0, 4), ...controlDot.slice(4, 6)];
  if (ktype === 'radial') {
    common.type = 'RADIUS';
    coords = [...pts[1], ...pts[0], Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1])];
  }
  // 保存压缩器也会扫描内嵌文字的字体，缺失 text 会使整个 PCB 导出失败。
  push('DIMENSION', { ...common, coords, text });
}

// zone → POUR (+POURED per filled_polygon) or REGION for keepouts
function convertZone(node, { netNames, usedNets, push }) {
  // POUR.width is stored in mm in eprj3 files (real exports: 0.2) even though
  // every other PCB coordinate is mil.
  const minThick = findSub(node, 'min_thickness');
  const width = minThick ? parseFloat(minThick[0]) || 0.2 : 0.2;
  const nameArr = findSub(node, 'name');
  const prioArr = findSub(node, 'priority');
  const keepout = findSubNode(node, 'keepout');

  // polygons: one or more (polygon (pts ...)) → "L"-token polyline sub-paths
  const polys = [];
  for (const it of node.slice(1)) {
    if (Array.isArray(it) && it[0].v === 'polygon') {
      const pts = extractPts(it);
      if (pts && pts.length > 2) {
        const flat = [];
        for (const p of pts) flat.push(r2(toMil(p.x)), r2(flipY(p.y)));
        polys.push([flat[0], flat[1], 'L', ...flat.slice(2), flat[0], flat[1]]);
      }
    }
  }
  // Real exports write rectangular pour borders as the "R" rect descriptor
  // [minX, maxY, w, h, 0, 0] (second value is the TOP edge on the Y-up canvas),
  // not as a polyline.
  polys.forEach((poly, i) => {
    const rect = rectDescriptor(poly);
    if (rect) polys[i] = rect;
  });

  const layers = [];
  const layerArr = findSub(node, 'layer');
  const layersArr = findSub(node, 'layerS') || findSub(node, 'layers');
  if (layerArr) layers.push(layerArr[0]);
  if (layersArr) for (const l of layersArr) layers.push(l);
  if (!layers.length) layers.push('F.Cu');

  if (keepout) {
    const prohibit = [];
    for (const it of keepout.slice(1)) {
      if (!Array.isArray(it)) continue;
      const kind = it[0].v;
      const blocked = it[1]?.v === 'not_allowed';
      if (!blocked) continue;
      if (kind === 'tracks') prohibit.push('TRACK');
      else if (kind === 'vias') prohibit.push('VIA');
      else if (kind === 'pads' || kind === 'footprints') prohibit.push('COMPONENT');
      else if (kind === 'copperpour') prohibit.push('COPPER');
    }
    for (const lname of layers) {
      for (const poly of polys) {
        push('REGION', {
          partitionId: '', groupId: 0, locked: false, zIndex: -1,
          layerId: layerToId(lname), width, prohibitType: [...new Set(prohibit)],
          path: [poly], name: nameArr ? nameArr[0] : '', regionType: 'PROHIBIT'
        });
      }
    }
    return;
  }

  const netNameArr = findSub(node, 'net_name');
  const netName = normNet(netNameArr?.[0] || netOf(node, netNames));
  if (netName) usedNets.add(netName);

  if (!polys.length) { warn('zone without polygon'); return; }

  for (const lname of layers) {
    const pourId = randId();
    const order = prioArr ? parseInt(prioArr[0], 10) || 0 : 0;
    push('POUR', {
      partitionId: '', groupId: 0, locked: false, zIndex: -1,
      netName, layerId: layerToId(lname), width,
      name: (nameArr && nameArr[0]) || `POUR${order + 1}`, order,
      path: polys, pourType: { pourType: 'SOLID', fineness: 8 }, keepIsland: false
    }, pourId);
    // poured fill results: one POURED per zone+layer, head id = ["POURED", pourId].
    // POURED.pourFill paths use the 0.254 mm unit (10 mil, like schematic data),
    // NOT the mil of the surrounding PCB document — verified against a real
    // export where fill·10 mil sits exactly clearance-inside the board outline
    // and fill arcs land on component pads.
    const pourFill = [];
    for (const it of node.slice(1)) {
      if (!(Array.isArray(it) && it[0].v === 'filled_polygon')) continue;
      const fpLayer = findSub(it, 'layer');
      if (fpLayer && fpLayer[0] !== lname) continue;
      const pts = extractPts(it);
      if (!pts || pts.length < 3) continue;
      const flat = [];
      for (const p of pts) flat.push(r2(toFillUnit(p.x)), r2(-toFillUnit(p.y)));
      pourFill.push({ id: randId(), strokeWidth: 0, fill: true, path: [[flat[0], flat[1], 'L', ...flat.slice(2), flat[0], flat[1]]] });
    }
    if (pourFill.length) {
      push('POURED', { pourFill }, JSON.stringify(['POURED', pourId]));
    }
  }
}

// mil-unit closed polyline (bare start + "L" tokens) → "R" descriptor when the
// path is an axis-aligned rectangle, else null.
function rectDescriptor(poly) {
  if (poly[2] !== 'L') return null;
  const rest = poly.slice(3);
  if (rest.length % 2 !== 0 || rest.some(v => typeof v !== 'number')) return null;
  const pts = [[poly[0], poly[1]]];
  for (let i = 0; i < rest.length; i += 2) pts.push([rest[i], rest[i + 1]]);
  if (pts.length !== 5) return null;
  const [x0, y0] = pts[0];
  if (pts[4][0] !== x0 || pts[4][1] !== y0) return null;
  const xs = new Set(pts.slice(0, 4).map(p => p[0])), ys = new Set(pts.slice(0, 4).map(p => p[1]));
  if (xs.size !== 2 || ys.size !== 2) return null;
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  return ['R', minX, maxY, r2(maxX - minX), r2(maxY - minY), 0, 0];
}

// KiCad mm → 0.254 mm canvas unit (10 mil) — the POURED fill coordinate unit.
function toFillUnit(mm) {
  return mm / 0.254;
}


function convertFootprint(node, ctx) {
  const { netNames, usedNets, ensureFootprintDoc, nextTicket, push, body } = ctx;
  const fpName = node[1]?.v || 'FP';
  const at = findSub(node, 'at');
  const layerArr = findSub(node, 'layer');
  const fpLayer = layerArr ? layerArr[0] : 'F.Cu';
  const pads = extractPads(node);
  const shapes = extractFpShapes(node).filter(s => s.layer !== 'Edge.Cuts');
  const rotation = Number(at?.[2]) || 0;
  const back = fpLayer === 'B.Cu';
  // KiCad 焊盘角度是绝对角度，中心坐标却是封装局部坐标。
  // EasyEDA 底层实例执行镜像 X，再旋转 angle-180°；先还原为正面库几何。
  const swapLayer = layer => layer?.replace(/^[FB]\./, c => c === 'F.' ? 'B.' : 'F.');
  for (const pad of pads) {
    pad.angle = (Number(pad.angle) - rotation) * (back ? -1 : 1);
    if (back) {
      pad.at[1] = -Number(pad.at[1]);
      if (pad.polygon) pad.polygon = pad.polygon.map(p => ({ x: p.x, y: -p.y }));
      pad.layers = pad.layers.map(swapLayer);
    }
  }
  if (back) for (const shape of shapes) {
    shape.layer = swapLayer(shape.layer);
    for (const key of ['y1', 'y2', 'cy', 'my']) if (shape[key] != null) shape[key] = -shape[key];
    if (shape.pts) shape.pts = shape.pts.map(p => ({ x: p.x, y: -p.y }));
  }
  const texts = extractFpTexts(node);
  const lib = ensureFootprintDoc(fpName, { pads, shapes, value: texts.Value || '' });
  for (const p of pads) { const n = normNet(p.netName); if (n) usedNets.add(n); }

  const compId = randId();
  const compAngle = ((rotation % 360) + 360) % 360;
  const cx = toMil(at && at[0] || 0);
  const cy = flipY(at && at[1] || 0);
  const pinSwapInfo = {};
  for (const p of lib.pads) pinSwapInfo[compId + p.id] = { pinClass: '', differentialPairClass: '' };
  const atTicket = push('COMPONENT', {
    partitionId: '', groupId: 0, layerId: /B\./.test(fpLayer) ? 2 : 1,
    x: cx, y: cy, angle: compAngle,
    attrs: {
      'Reuse Block': '', 'Group ID': '', 'Channel ID': '',
      'Unique ID': texts.Reference || 'gge' + (++ggeCounter),
      DeviceName: JSON.stringify({ uuid: lib.devUuid, name: fpName, source: '' })
    },
    locked: false, zIndex: -1, pinSwap: false, pinSwapInfo, footprintPrimitives: true
  }, compId);
  body.push(pcbAttr(nextTicket(), compId, 'Footprint', lib.docUuid, null, null, false, compAngle, atTicket));
  body.push(pcbAttr(nextTicket(), compId, 'Device', lib.devUuid, null, null, false, compAngle, -1));
  const designator = texts.Reference || '';
  const textNodes = node.slice(1).filter(n => Array.isArray(n) &&
    (n[0].v === 'property' || n[0].v === 'fp_text'));
  let hasDesignator = false;
  for (const textNode of textNodes) {
    const kind = textNode[1]?.v;
    const isReference = kind === 'Reference' || kind === 'reference';
    const value = textNode[2]?.v || '';
    const hide = textNode.some(n => n?.v === 'hide') || findSub(textNode, 'hide')?.[0] === 'yes';
    const layer = findSub(textNode, 'layer')?.[0];
    const visible = !hide && !!layer;
    const local = findSub(textNode, 'at') || [0, 0];
    const rad = rotation * Math.PI / 180;
    const x = cx + toMil(local[0]) * Math.cos(rad) + toMil(local[1]) * Math.sin(rad);
    const y = cy + toMil(local[0]) * Math.sin(rad) - toMil(local[1]) * Math.cos(rad);
    const text = pcbString(textNode, value.replace(/\$\{REFERENCE\}/g, designator));
    Object.assign(text, { x, y });
    // KiCad 默认保持封装文字正立，但不改变其放置位置。
    if (!textNode.some(n => Array.isArray(n) && n[0]?.v === 'unlocked'))
      text.angle = (text.angle + 90) % 180 - 90;
    if (isReference) {
      const rec = pcbAttr(nextTicket(), compId, 'Designator', designator, x, y, visible, text.angle, atTicket);
      const { text: ignored, ...style } = text;
      Object.assign(rec.body, style, { valueVisible: visible });
      body.push(rec);
      hasDesignator = true;
    } else if (visible) push('STRING', text);
  }
  if (designator && !hasDesignator)
    body.push(pcbAttr(nextTicket(), compId, 'Designator', designator, cx, cy, false, compAngle, atTicket));
  lib.pads.forEach(p => {
    const netName = normNet(pads[p.sourceIndex]?.netName);
    body.push({
      head: { type: 'PAD_NET', ticket: nextTicket(), id: JSON.stringify(['PAD_NET', compId, p.num, p.id]) },
      body: { partitionId: '', padNet: netName, padLen: null, propagationDelay: null, attrsMap: {} }
    });
  });
}

function pcbAttr(ticket, parentId, key, value, x, y, valueVisible, angle, zIndex) {
  return {
    head: { type: 'ATTR', ticket, id: randId() },
    body: {
      partitionId: '', groupID: 0, parentId, layerId: 3, x, y,
      key, value, keyVisible: false, valueVisible,
      fontFamily: 'default', fontSize: 45, strokeWidth: 6,
      bold: 0, italic: 0, origin: 'LEFT_BOTTOM', angle,
      reverse: false, expansion: 0, mirror: false, locked: false, zIndex, specialColor: null
    }
  };
}

function chainSegments(segments) {
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.01;
  const reverse = s => s[2] === 'ARC'
    ? [s[4], s[5], 'ARC', -s[3], s[0], s[1]]
    : [s[3], s[4], 'L', s[0], s[1]];
  const remaining = segments.map(s => s.slice());
  const chains = [];
  while (remaining.length) {
    let chain = remaining.shift();
    // 只从尾部延伸；闭合环中任意一段都可以作为起点。
    for (;;) {
      const end = chain.slice(-2);
      const i = remaining.findIndex(s => near(end, s.slice(0, 2)) || near(end, s.slice(-2)));
      if (i < 0 || near(chain.slice(0, 2), end)) break;
      let next = remaining.splice(i, 1)[0];
      if (!near(end, next.slice(0, 2))) next = reverse(next);
      chain.push(...next.slice(2));
    }
    chains.push(chain);
  }
  return chains;
}

function extractPads(node) {
  const pads = [];
  for (const it of node.slice(1)) if (Array.isArray(it) && it[0].v === 'pad') {
    // (pad "<num>" <smd|thru_hole|np_thru_hole> <rect|circle|oval|roundrect|custom|trapezoid> ...)
    const pad = { number: it[1]?.v || '', type: it[2]?.v || 'smd', shape: it[3]?.v || 'rect', at: [], size: [], layers: [], angle: 0, netName: '', drill: null, drillOval: null };
    for (const sub of it.slice(1)) {
      if (!Array.isArray(sub)) continue;
      const sh = sub[0].v;
      if (sh === 'at') { pad.at = sub.slice(1).map(x => x.v); if (pad.at.length > 2) pad.angle = parseFloat(pad.at[2]) || 0; }
      else if (sh === 'roundrect_rratio') pad.roundrectRatio = Number(sub[1]?.v) || 0;
      else if (sh === 'size') pad.size = sub.slice(1).map(x => x.v);
      else if (sh === 'layers') pad.layers = sub.slice(1).map(x => x.v);
      else if (sh === 'drill') {
        const nums = sub.slice(1).filter(x => typeof x.v === 'string' && /^[\d.]+$/.test(x.v)).map(x => x.v);
        const isOval = sub.slice(1).some(x => x.v === 'oval');
        pad.drill = nums[0];
        if (isOval && nums[1]) pad.drillOval = nums[1];
      }
      else if (sh === 'net') pad.netName = sub[2]?.v || (sub[1]?.t === 'str' ? sub[1].v : '');
    }
    if (pad.shape === 'custom') pad.polygon = require('./lib/custom-pad').customPadPolygon(it, pad, { findSub, findSubNode, extractPts, strokeWidthOf });
    pads.push(pad);
  }
  return pads;
}

function extractFpShapes(node) {
  const out = [];
  for (const it of node.slice(1)) {
    if (!Array.isArray(it)) continue;
    const h = it[0].v;
    if (h === 'fp_line' || h === 'fp_rect') {
      const xy = findSub(it, 'start');
      const xy2 = findSub(it, 'end');
      const layerArr = findSub(it, 'layer');
      out.push({
        kind: h,
        x1: xy ? +xy[0] : 0, y1: xy ? +xy[1] : 0,
        x2: xy2 ? +xy2[0] : 0, y2: xy2 ? +xy2[1] : 0,
        layer: layerArr ? layerArr[0] : 'F.SilkS',
        fill: ['solid', 'yes'].includes(findSub(it, 'fill')?.[0]), width: strokeWidthOf(it, 0.15)
      });
    } else if (h === 'fp_circle') {
      const c = findSub(it, 'center');
      const e = findSub(it, 'end');
      const layerArr = findSub(it, 'layer');
      if (!c || !e) continue;
      const r = Math.hypot(+e[0] - +c[0], +e[1] - +c[1]);
      out.push({ kind: h, cx: +c[0], cy: +c[1], r, layer: layerArr ? layerArr[0] : 'F.SilkS', fill: ['solid', 'yes'].includes(findSub(it, 'fill')?.[0]), width: strokeWidthOf(it, 0.15) });
    } else if (h === 'fp_arc') {
      const a = require('./lib/kicad').extractArc(it);
      const layerArr = findSub(it, 'layer');
      if (a.mx == null) continue;
      out.push({ kind: h, ...a, layer: layerArr ? layerArr[0] : 'F.SilkS', fill: ['solid', 'yes'].includes(findSub(it, 'fill')?.[0]), width: strokeWidthOf(it, 0.15) });
    } else if (h === 'fp_poly') {
      const layerArr = findSub(it, 'layer');
      out.push({ kind: h, pts: extractPts(it), layer: layerArr ? layerArr[0] : 'F.SilkS', fill: ['solid', 'yes'].includes(findSub(it, 'fill')?.[0]), width: strokeWidthOf(it, 0.15) });
    }
  }
  return out;
}

function extractFpTexts(node) {
  const out = {};
  for (const it of node.slice(1)) {
    if (!Array.isArray(it) || it[0].v !== 'fp_text') continue;
    const kind = it[1]?.v;       // reference | value | user
    const text = it[2]?.v || '';
    if ((kind === 'reference' || kind === 'value') && !out[kind === 'reference' ? 'Reference' : 'Value']) {
      out[kind === 'reference' ? 'Reference' : 'Value'] = text;
    }
  }
  // KiCad >= 8 stores reference/value as (property "Reference" "R1") too
  const props = collectProperties(node);
  if (props.Reference && !out.Reference) out.Reference = props.Reference;
  if (props.Value && !out.Value) out.Value = props.Value;
  return out;
}

main().catch(err => die(err.stack || err.message, 1));
