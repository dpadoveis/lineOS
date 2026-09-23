import { META_GAP, META_HEAD_HEIGHT, META_ROW_HEIGHT } from './constants.js';
import { clipToBorder, metaPanelHeight, nodeHeight, nodeWidth, shade } from './geometry.js';
import { download } from './payload.js';

// Draws the plane onto a canvas. Shared by the download and the upload to the
// server, so the stored PNG is the same one the user downloads.
function renderFlowCanvas(nodes, edges, groups, heights, accent, icons) {
  const cs = getComputedStyle(document.documentElement);
  const T = (k) => (cs.getPropertyValue('--' + k) || '').trim() || '#000';
  // The same fix as on screen: in the light theme the tool colour is darkened
  // before it becomes text.
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  const tint = (color) => (light ? shade(color, 0.62) : color);

  // A flow that is only boxes still has something to draw.
  if (!nodes.length && !(groups || []).length) return null;

  const nh = (n) => nodeHeight(n, heights);
  const nw = (n) => nodeWidth(n);
  const pad = 70;
  // A group can stick out past the nodes it holds (and an empty one has none),
  // so the boxes take part in the framing.
  const boxes = (groups || []).map((g) => ({ x: g.x, y: g.y, x1: g.x + g.w, y1: g.y + g.h }));
  const minX = Math.min.apply(null, nodes.map((n) => n.x).concat(boxes.map((b) => b.x))) - pad;
  const minY = Math.min.apply(null, nodes.map((n) => n.y).concat(boxes.map((b) => b.y))) - pad;
  const maxX = Math.max.apply(null, nodes.map((n) => n.x + nw(n)).concat(boxes.map((b) => b.x1))) + pad;
  // The metadata panel hangs below the card: it enters the framing, but not
  // the node's height.
  const maxY =
    Math.max.apply(null, nodes.map((n) => n.y + nh(n) + metaPanelHeight(n)).concat(boxes.map((b) => b.y1))) + pad;
  const w = Math.max(400, maxX - minX), hgt = Math.max(300, maxY - minY), dpr = 2;

  const cv = document.createElement('canvas');
  cv.width = w * dpr;
  cv.height = hgt * dpr;
  const c = cv.getContext('2d');
  c.scale(dpr, dpr);
  c.fillStyle = T('bg');
  c.fillRect(0, 0, w, hgt);
  c.translate(-minX, -minY);

  c.fillStyle = T('grid');
  for (let gx = Math.ceil(minX / 24) * 24; gx < maxX; gx += 24) {
    for (let gy = Math.ceil(minY / 24) * 24; gy < maxY; gy += 24) {
      c.beginPath();
      c.arc(gx, gy, 1, 0, 6.284);
      c.fill();
    }
  }

  c.strokeStyle = T('axis');
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(minX, 0);
  c.lineTo(maxX, 0);
  c.moveTo(0, minY);
  c.lineTo(0, maxY);
  c.stroke();

  // The boxes go down first, in their own order: on the plane they are behind
  // the edges and the cards, and the PNG keeps that stacking.
  (groups || []).forEach((g) => {
    const col = g.col || '#9aa4b0';
    c.save();
    c.beginPath();
    if (c.roundRect) c.roundRect(g.x, g.y, g.w, g.h, 14);
    else c.rect(g.x, g.y, g.w, g.h);
    // The same tenth-strength fill as on screen; the canvas has no #rrggbbaa
    // shorthand, hence globalAlpha.
    c.globalAlpha = 0.08;
    c.fillStyle = col;
    c.fill();
    c.globalAlpha = 1;
    c.strokeStyle = col;
    c.lineWidth = 1.5;
    c.setLineDash([7, 5]);
    c.stroke();
    c.restore();
    c.font = "600 11.5px 'IBM Plex Sans', sans-serif";
    c.fillStyle = tint(col);
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    c.fillText(g.name || 'Group', g.x + 12, g.y + 17);
  });

  const byId = {};
  nodes.forEach((n) => (byId[n.id] = n));

  edges.forEach((e) => {
    const a = byId[e.from], b = byId[e.to];
    if (!a || !b) return;
    const ca = { x: a.x + nw(a) / 2, y: a.y + nh(a) / 2 };
    const cb = { x: b.x + nw(b) / 2, y: b.y + nh(b) / 2 };
    const s = clipToBorder(ca, cb, nh(a), nw(a)), t = clipToBorder(cb, ca, nh(b), nw(b));
    c.strokeStyle = accent;
    c.lineWidth = 1.7;
    c.beginPath();
    c.moveTo(s.x, s.y);
    c.lineTo(t.x, t.y);
    c.stroke();
    const ang = Math.atan2(t.y - s.y, t.x - s.x);
    c.fillStyle = accent;
    c.beginPath();
    c.moveTo(t.x, t.y);
    c.lineTo(t.x - 11 * Math.cos(ang - 0.4), t.y - 11 * Math.sin(ang - 0.4));
    c.lineTo(t.x - 11 * Math.cos(ang + 0.4), t.y - 11 * Math.sin(ang + 0.4));
    c.closePath();
    c.fill();
    if (e.label) {
      const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
      c.font = '500 11px monospace';
      const tw = c.measureText(e.label).width + 14;
      c.fillStyle = T('card');
      c.fillRect(mx - tw / 2, my - 11, tw, 22);
      c.strokeStyle = T('edge1');
      c.lineWidth = 1;
      c.strokeRect(mx - tw / 2, my - 11, tw, 22);
      c.fillStyle = T('txt');
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(e.label, mx, my);
    }
  });

  // Trims the text to the space available -- nodes now have variable widths,
  // and a long name on a narrow node would run over the border.
  const fit = (txt, maxW) => {
    const s0 = String(txt);
    if (c.measureText(s0).width <= maxW) return s0;
    let corte = s0;
    while (corte.length > 1 && c.measureText(corte + '…').width > maxW) corte = corte.slice(0, -1);
    return corte + '…';
  };

  nodes.forEach((n) => {
    const h = nh(n);
    const wid = nw(n);
    c.fillStyle = T('card');
    c.strokeStyle = T('edge1');
    c.lineWidth = 1;
    // The same elevation the node has on screen (--nodesh), so the PNG does
    // not come out flat -- above all in the light theme, where the card is
    // white.
    c.save();
    c.shadowColor = T('pngsh');
    c.shadowBlur = 14;
    c.shadowOffsetY = 5;
    if (c.roundRect) {
      c.beginPath();
      c.roundRect(n.x, n.y, wid, h, 9);
      c.fill();
      c.restore();
      c.stroke();
    } else {
      c.fillRect(n.x, n.y, wid, h);
      c.restore();
      c.strokeRect(n.x, n.y, wid, h);
    }
    // Content clipped to the card: a node with a fixed height cuts the excess
    // in the PNG the same way it does on screen.
    c.save();
    c.beginPath();
    if (c.roundRect) c.roundRect(n.x, n.y, wid, h, 9);
    else c.rect(n.x, n.y, wid, h);
    c.clip();
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    // The custom tool's icon when there is one; otherwise the tinted square
    // with the initials, as it always was.
    const img = n.tool && icons ? icons[n.tool] : null;
    if (img) {
      c.drawImage(img, n.x + 12, n.y + 11, 30, 30);
    } else {
      c.fillStyle = n.col + '2a';
      if (c.roundRect) {
        c.beginPath();
        c.roundRect(n.x + 12, n.y + 11, 30, 30, 7);
        c.fill();
      } else {
        c.fillRect(n.x + 12, n.y + 11, 30, 30);
      }
      c.fillStyle = n.col;
      c.font = '600 11px monospace';
      c.fillText(n.k, n.x + 27, n.y + 27);
    }
    c.textAlign = 'left';
    const textWidth = wid - 64;
    c.fillStyle = T('txt');
    c.font = '500 13px sans-serif';
    // Nome exibido: o apelido, quando o node foi renomeado.
    c.fillText(fit(n.label || n.n, textWidth), n.x + 52, n.y + 21);
    c.font = '400 9.5px monospace';
    if (n.label) {
      // The technical stack name sits right below the nickname, tinted with
      // the tool's colour, before the category -- as on screen.
      const name = fit(n.n, textWidth);
      c.fillStyle = tint(n.col);
      c.fillText(name, n.x + 52, n.y + 36);
      const dx = c.measureText(name).width;
      c.fillStyle = T('mut2');
      c.fillText(fit(' · ' + n.c, textWidth - dx), n.x + 52 + dx, n.y + 36);
    } else {
      c.fillStyle = T('mut2');
      c.fillText(fit(n.c, textWidth), n.x + 52, n.y + 36);
    }
    let y = n.y + 62;
    if (n.desc) {
      c.fillStyle = T('txt2');
      c.font = '400 11px sans-serif';
      c.fillText(fit(n.desc, wid - 24), n.x + 12, y);
      y += 20;
    }
    c.fillStyle = T('mut3');
    c.font = '400 9.5px monospace';
    c.fillText('(' + Math.round(n.x + wid / 2) + ', ' + Math.round(-(n.y + h / 2)) + ')', n.x + 12, n.y + h - 14);
    c.restore();

    // Metadata panel, drawn below the card exactly like .fe-meta-drop on
    // screen: same gap, same header strip, same key/value columns.
    const painel = metaPanelHeight(n);
    if (painel) {
      const px = n.x;
      const py = n.y + h + META_GAP;
      const ph = painel - META_GAP;
      c.fillStyle = T('card');
      c.strokeStyle = T('line');
      c.lineWidth = 1;
      if (c.roundRect) {
        c.beginPath();
        c.roundRect(px, py, wid, ph, 6);
        c.fill();
        c.stroke();
      } else {
        c.fillRect(px, py, wid, ph);
        c.strokeRect(px, py, wid, ph);
      }
      // The stroke joining the panel to the node's footer.
      c.strokeStyle = T('edge1');
      c.beginPath();
      c.moveTo(px + wid / 2, n.y + h);
      c.lineTo(px + wid / 2, py);
      c.stroke();

      c.save();
      c.beginPath();
      if (c.roundRect) c.roundRect(px, py, wid, ph, 6);
      else c.rect(px, py, wid, ph);
      c.clip();
      c.textAlign = 'left';
      c.textBaseline = 'middle';
      c.fillStyle = T('head');
      c.fillRect(px, py, wid, META_HEAD_HEIGHT);
      c.strokeStyle = T('line');
      c.beginPath();
      c.moveTo(px, py + META_HEAD_HEIGHT);
      c.lineTo(px + wid, py + META_HEAD_HEIGHT);
      c.stroke();
      c.fillStyle = T('mut3');
      c.font = '600 8.5px monospace';
      c.fillText('KEY', px + 8, py + META_HEAD_HEIGHT / 2);
      c.fillText('VALUE', px + 88, py + META_HEAD_HEIGHT / 2);
      n.meta.forEach((m, i) => {
        const ry = py + META_HEAD_HEIGHT + i * META_ROW_HEIGHT;
        if (i) {
          c.strokeStyle = T('line3');
          c.beginPath();
          c.moveTo(px, ry);
          c.lineTo(px + wid, ry);
          c.stroke();
        }
        c.font = '500 10.5px monospace';
        c.fillStyle = T('mut');
        c.fillText(fit(m.k || '—', 72), px + 8, ry + META_ROW_HEIGHT / 2);
        c.font = '400 10.5px monospace';
        c.fillStyle = T('txt');
        c.fillText(fit(m.v || '', wid - 96), px + 88, ry + META_ROW_HEIGHT / 2);
      });
      c.restore();
    }
  });

  return cv;
}

// Custom tool icons are data URLs; the canvas only draws already decoded
// images, so they are loaded before rendering. An icon that fails to load
// simply does not enter the map, and the node falls back to its initials.
function loadIcons(nodes, iconBySlug) {
  const slugs = [];
  nodes.forEach((n) => {
    if (n.tool && iconBySlug && iconBySlug[n.tool] && slugs.indexOf(n.tool) === -1) slugs.push(n.tool);
  });
  if (!slugs.length) return Promise.resolve({});
  return Promise.all(
    slugs.map(
      (slug) =>
        new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve([slug, img]);
          img.onerror = () => resolve(null);
          img.src = iconBySlug[slug];
        })
    )
  ).then((pares) => {
    const mapa = {};
    pares.forEach((p) => {
      if (p) mapa[p[0]] = p[1];
    });
    return mapa;
  });
}

export async function saveFlowAsPng(nodes, edges, groups, heights, accent, iconBySlug) {
  const icons = await loadIcons(nodes, iconBySlug);
  const cv = renderFlowCanvas(nodes, edges, groups, heights, accent, icons);
  if (!cv) return false;
  cv.toBlob((b) => download(b, 'flow.png'));
  return true;
}

// The same drawing, handed over as a Blob for the upload to the API
// (flowPngBlob -> POST
// /api/flows/{id}/files).
export async function flowPngBlob(nodes, edges, groups, heights, accent, iconBySlug) {
  const icons = await loadIcons(nodes, iconBySlug);
  const cv = renderFlowCanvas(nodes, edges, groups, heights, accent, icons);
  if (!cv) return null;
  return new Promise((resolve) => cv.toBlob(resolve));
}
