#!/usr/bin/env python3
"""Generate a house-style swimlane sequence diagram (.drawio) from a data module.

    python3 build_sequence.py deposit_data.py out.drawio

One generator for the five vault flows (deposit, withdraw, swap, supply, redeem). This
file holds only layout: a fixed lane pitch, a row pitch that grows only where the text
of two rows in one lane gap needs the room, one label column per lane gap. Styles and
icons are copied from the palette card at PALETTE. It prints WARN lines for text that
will not fit and for notes or cards that overlap; a clean build prints none.

DATA FORMAT (one Python module per flow, e.g. deposit_data.py)
--------------------------------------------------------------
TITLE          str   diagram name.
LANES          list of dict(id, title, icon, sub=None), left to right.
                     title may hold '\\n' (two lines; only without sub).
                     icon: user | contract | signet | server | mpc-cluster | chain.
                     sub: a quiet second header line.
GROUPS         list of dict(id, icon, lanes=[lane ids]): a rail over those header cards.
BANDS          list of dict(title, phase, rows=[...]), top to bottom. phase picks the
                     band colour (see PHASE below).
OUTCOME_TITLE  str   the caption on the closing card.
OUTCOME        list of str, one line each, in the closing card.
FOOTNOTE       str   one quiet line under the closing card.

Row kinds (each row is a dict with kind and phase):
  arrow  frm, to, label=[3 or 5 lines], step='1' or None.
         step: the circle number at the arrow's start (None = continues a step).
         side: optional dict(lane, lines, dy=0): a dotted note in the gap right of
               that lane's lifeline, on this row. dy nudges it off the row line
               (to part two notes stacked in one lane).
         rows: row slots the arrow takes (default 1).
  fork   step, frm, to, arms=[[3 or 5 lines], [3 or 5 lines]]: one circle, two arms
         (a choice). It takes two row slots.
  note   lane, lines, rows=1: a solid card on one lifeline, centred over its rows.
         phase 'pre' = a precondition (not a step): neutral grey stroke.
         overlay: the card takes no row slot of its own. True = it sits over this
               row and the ones after it; an int n = it starts n rows back.

Mini-markup in labels, notes and outcome lines:
  **text**    bold (acting-party prefix, colon-led keywords, greppable names)
  `call(...)` code font; the name before '(' is bold (a bare `NAME` is bold whole;
              a bare fragment with ',' or ')' and no '(' is plain code: the tail
              of a call wrapped onto the next line)
  {text}      plain code font, spaces kept (the continuation lines of a call)
  ~text~      quiet grey text
Each edge label is a list of THREE or FIVE lines (the arrow runs through the middle line):
the bold acting party alone, then the body.
"""
import importlib.util, re, sys, os
sys.dont_write_bytecode = True   # loading a data table leaves no __pycache__ in the repository
from PIL import ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
PALETTE = os.path.join(HERE, '..', '..', '..', '..', 'docs', 'diagram-palette.drawio')

# ---- grid ------------------------------------------------------------------------------
W = 240          # lane pitch (lifeline to lifeline)
X0 = 20          # left edge of the first lane
HDR_Y, HDR_H = 20, 72   # header cards (pushed down by RAIL when the data has GROUPS)
RAIL = 34        # height of the group rail above the header cards
LINE = 17        # line pitch inside notes and cards
P = 82           # least row pitch
BAND_TITLE = 54  # band top to first row
BAND_TAIL = 34   # last row to band bottom
BAND_GAP = 10
L = 36           # label column: lifeline + L, in every lane gap
CIRCLE = 36
FORK = 32        # where a fork's second arm turns down, from the lifeline
FONT = 14
CODE = 12
SMALL = 13

PHASE = {   # colour, palette circle id, palette edge id, band tint
    'fund':        ('#008695', 'circ6', 'edge6', '#EEF6F7'),
    'request':     ('#E73F74', 'circ1', 'edge1', '#FDF2F5'),
    'signature':   ('#3969AC', 'circ2', 'edge2', '#F1F5FA'),
    'broadcast':   ('#11A579', 'circ3', 'edge3', '#F1F5FA'),
    'attestation': ('#FDAE61', 'circ4', 'edge4', '#F6F2F7'),
    'settle':      ('#7F3C8D', 'circ5', 'edge5', '#F6F2F7'),
    # a precondition card (not a step of this flow): neutral card stroke, never a band or edge
    'pre':         ('#D3D3D3', None, None, None),
}
LIFELINE = '#D3D3D3'
CARD_STROKE = '#D3D3D3'
QUIET = '#6E6E6E'
NOTE_PAD = 10
NOTE_STYLE = ('text;whiteSpace=wrap;html=1;horizontal=1;verticalAlign=middle;align=left;spacing=0;spacingLeft=10;spacingRight=6;fontSize=%d;'
              'dashed=1;dashPattern=1 2;strokeColor=default;fillColor=#FFFFFF;' % FONT)   # palette 'note' plus a white fill
CODE_STYLE = "font-family: Menlo, Monaco, 'Courier New', monospace; font-size: %dpx; color: rgb(32, 32, 32);" % CODE

# ---- text ------------------------------------------------------------------------------
# Text is measured with the macOS fonts the pictures are drawn in (Helvetica, Menlo).
# FONT_DIR names a folder that holds Helvetica.ttc and Menlo.ttc; macOS has them in
# /System/Library/Fonts.
def _font_dir():
    for d in (os.environ.get('FONT_DIR'), '/System/Library/Fonts',
              os.path.expanduser('~/.local/share/fonts/mac')):
        if d and os.path.isfile(os.path.join(d, 'Helvetica.ttc')) and os.path.isfile(os.path.join(d, 'Menlo.ttc')):
            return d
    sys.exit('Helvetica.ttc and Menlo.ttc not found: set FONT_DIR to the folder that holds them')
_F = _font_dir()
FONTS = {
    'r': ImageFont.truetype(os.path.join(_F, 'Helvetica.ttc'), FONT, index=0),
    'b': ImageFont.truetype(os.path.join(_F, 'Helvetica.ttc'), FONT, index=1),
    'c': ImageFont.truetype(os.path.join(_F, 'Menlo.ttc'), CODE, index=0),
    'cb': ImageFont.truetype(os.path.join(_F, 'Menlo.ttc'), CODE, index=1),
}

def tokens(line):
    """Split mini-markup into (kind, text).

    kind: r regular, b bold, q quiet, cb code bold (a call's name),
          c code (the rest of that call), p plain code (a continuation line).
    """
    out = []
    for m in re.finditer(r'\*\*(.+?)\*\*|`(.+?)`|~(.+?)~|\{(.+?)\}|([^*`~{]+)', line):
        b, c, q, pc, r = m.groups()
        if b: out.append(('b', b))
        elif q: out.append(('q', q))
        elif pc: out.append(('p', pc))
        elif r: out.append(('r', r))
        elif c:
            i = c.find('(')
            if i < 0 and (',' in c or ')' in c):
                out.append(('p', c))   # the tail of a wrapped call: no bold name
                continue
            name, rest = (c[:i], c[i:]) if i > 0 else (c, '')
            out.append(('cb', name))
            if rest: out.append(('c', rest))
    return out

def html_line(line):
    h = ''
    toks = tokens(line)
    i = 0
    while i < len(toks):
        k, t = toks[i]
        if k == 'cb':
            rest = toks[i + 1][1] if i + 1 < len(toks) and toks[i + 1][0] == 'c' else ''
            h += '<span style="%s"><b>%s</b>%s</span>' % (CODE_STYLE, esc(t), esc(rest))
            i += 2 if rest else 1
            continue
        if k == 'p':
            h += '<span style="%s">%s</span>' % (CODE_STYLE, esc(t).replace(' ', '&nbsp;'))
        elif k == 'b': h += '<b>%s</b>' % esc(t)
        elif k == 'q': h += '<span style="color: %s;">%s</span>' % (QUIET, esc(t))
        else: h += esc(t)
        i += 1
    return h

def esc(t):
    return t.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

def html(lines, pad=False):
    if not pad:
        return '<br>'.join(html_line(l) for l in lines)
    return '<br>'.join(PAD + html_line(l) + PAD for l in lines)

PAD = '&nbsp;&nbsp;'   # widens an edge label's knockout so the line stops short of the text
PAD_W = 2 * FONTS['r'].getlength('\u00a0')

def width(lines):
    best = 0
    for l in lines:
        w = 0
        for k, t in tokens(l):
            f = FONTS[{'q': 'r', 'p': 'c'}.get(k, k)]
            w += f.getlength(t)
        best = max(best, w)
    return best

# ---- palette ---------------------------------------------------------------------------
PAL = open(PALETTE, encoding='utf-8').read()
def pstyle(cid):
    # the style attribute of one palette cell, as the file spells it
    m = re.findall(r'<mxCell id="%s"([^>]*)>' % re.escape(cid), PAL)
    assert len(m) == 1, (cid, len(m))
    s = re.search(r' style="([^"]*)"', m[0])
    return s.group(1) if s else None

def enc(s):
    return (s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
             .replace('"', '&quot;').replace("'", '&#39;'))

def restyle(style, **kv):
    parts = [p for p in style.split(';') if p]
    keys = [p.split('=', 1)[0] for p in parts]
    for k, v in kv.items():
        if k in keys:
            i = keys.index(k)
            if v is None: parts.pop(i); keys.pop(i)
            else: parts[i] = '%s=%s' % (k, v)
        elif v is not None:
            parts.append('%s=%s' % (k, v)); keys.append(k)
    return ';'.join(parts) + ';'

# Composite icons: palette group, its native size, and its parts at native offsets.
COMPOSITE = {
    '@mpc-cluster': (121, 127, [('mpc-srv-1', 0, 0, 44, 55), ('mpc-srv-2', 77, 0, 44, 55),
                                ('mpc-srv-3', 38, 72, 44, 55), ('mpc-srv-logo', 41, 36, 34, 34)]),
}

ICON = {   # palette cell, width, height
    'user':     ('user-person', 22, 23),
    'contract': ('icon-contract-app.png', 24, 24),
    'signet':   ('icon-sig-network-logo.png', 24, 24),
    'server':   ('srv', 19, 24),
    # the palette's MPC server cluster group (three towers around the Sig Network badge), scaled
    'mpc-cluster': ('@mpc-cluster', 53, 56),
    'chain':    ('chain', 24, 24),
    'midnight': ('icon-midnight-logo.png', 78, 20),
}

# ---- builder ---------------------------------------------------------------------------
class B:
    def __init__(self):
        self.cells = []
        self.n = 0
    def nid(self, p):
        self.n += 1
        return '%s%d' % (p, self.n)
    def vertex(self, cid, value, style, x, y, w, h, parent='1'):
        self.cells.append('<mxCell id="%s" value="%s" style="%s" vertex="1" parent="%s">'
                          '<mxGeometry x="%g" y="%g" width="%g" height="%g" as="geometry" /></mxCell>'
                          % (cid, enc(value), enc_style(style), parent, x, y, w, h))
    def edge(self, cid, style, src, tgt, pts=()):
        arr = ''
        if pts:
            arr = '<Array as="points">%s</Array>' % ''.join('<mxPoint x="%g" y="%g" />' % p for p in pts)
        self.cells.append('<mxCell id="%s" style="%s" edge="1" parent="1" source="%s" target="%s">'
                          '<mxGeometry relative="1" as="geometry">%s</mxGeometry></mxCell>'
                          % (cid, enc_style(style), src, tgt, arr))
    def label(self, cid, edge, value, rel, bg, dy=0):
        style = 'edgeLabel;html=1;align=left;verticalAlign=middle;labelBackgroundColor=%s;spacing=0;fontSize=%d;' % (bg, FONT)
        self.cells.append('<mxCell id="%s" value="%s" style="%s" vertex="1" connectable="0" parent="%s">'
                          '<mxGeometry x="%.4f" relative="1" as="geometry"><mxPoint y="%g" as="offset" /></mxGeometry></mxCell>'
                          % (cid, enc(value), enc_style(style), edge, rel, dy))

def enc_style(s):
    # palette styles are already attribute-encoded where they came from the file
    return s.replace('"', '&quot;')

def load(path):
    spec = importlib.util.spec_from_file_location('flowdata', path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

def build(data, out):
    b = B()
    lanes = data.LANES
    lx = {ln['id']: X0 + W * i + W / 2 for i, ln in enumerate(lanes)}
    idx = {ln['id']: i for i, ln in enumerate(lanes)}
    total_w = W * len(lanes)
    warnings = []

    groups = getattr(data, 'GROUPS', [])
    hdr_y = HDR_Y + (RAIL if groups else 0)
    # -- pass 1: rows -> y positions
    y = hdr_y + HDR_H + 22
    bands = []
    for band in data.BANDS:
        top = y
        ry = top + BAND_TITLE
        slots, placed, prev, low = [], [], [], 0
        for r in band['rows']:
            ov = r.get('overlay')
            if ov is not None and ov is not False:
                # a card over rows that have their own arrows: takes no row slot.
                # True = over this row and the next; an int n = starts n rows back.
                back = 0 if ov is True else ov
                placed.append((r, len(slots) - back))
                continue
            items = []
            if r['kind'] in ('arrow', 'fork'):
                gap = lanes[min(idx[r['frm']], idx[r['to']])]['id']
                for k, lab in enumerate([r['label']] if r['kind'] == 'arrow' else r['arms']):
                    hl = len(lab) * FONT * 0.6
                    items.append((gap, P * k - hl, P * k + hl, 30))
            sd = r.get('side')
            if sd:
                h = LINE * len(sd['lines']) + 12
                items.append((sd['lane'], sd.get('dy', 0) - h / 2, sd.get('dy', 0) + h / 2, 8))
            for g, up, down, head in items:
                if not slots:
                    ry = max(ry, top + head - up)
                for pg, pdown in prev:
                    if pg == g:
                        ry = max(ry, pdown + 8 - up)
            placed.append((r, len(slots)))
            n = 2 if r['kind'] == 'fork' else r.get('rows', 1)
            slots += [ry + P * k for k in range(n)]
            prev = [(g, ry + down) for g, up, down, head in items]
            low = max([low] + [d for g, d in prev])
            ry += P * n
        rows = [(r, slots[i], slots[min(i + r.get('rows', 1), len(slots)) - 1]) for r, i in placed]
        bottom = max(ry - P + BAND_TAIL, low + 8)
        bands.append((band, top, bottom, rows))
        y = bottom + BAND_GAP
    ll_top, ll_bot = hdr_y + HDR_H, bands[-1][2]

    # -- bands (back layer)
    for band, top, bottom, rows in bands:
        col, _, _, tint = PHASE[band['phase']]
        b.vertex('band-' + slug(band['title']), '', 'rounded=1;arcSize=4;absoluteArcSize=0;whiteSpace=wrap;html=1;fillColor=%s;strokeColor=none;' % tint,
                 X0, top, total_w, bottom - top)
        bid = 'band-' + slug(band['title'])
        tw = FONTS['b'].getlength(band['title']) * SMALL / FONT + 4
        b.vertex(bid + '-title', '<b>%s</b>' % esc(band['title']),
                 'text;html=1;align=left;verticalAlign=middle;spacing=0;fontSize=%d;fontColor=%s;' % (SMALL, col),
                 16, 10, tw, SMALL + 5, parent=bid)

    # -- lifelines and headers
    for ln in lanes:
        x = lx[ln['id']]
        b.vertex('ll-' + ln['id'], '', 'rounded=0;html=1;fillColor=%s;strokeColor=none;' % LIFELINE,
                 x - 0.75, ll_top, 1.5, ll_bot - ll_top)
        b.vertex('hdr-' + ln['id'], '', 'rounded=1;arcSize=18;whiteSpace=wrap;html=1;fillColor=#FFFFFF;strokeColor=%s;' % CARD_STROKE,
                 x - W / 2 + 14, hdr_y, W - 28, HDR_H)
        pid, iw, ih = ICON[ln['icon']]
        sub = ln.get('sub')
        tlines = ln['title'].split('\n')   # a title may wrap onto two lines
        tw = max(max(FONTS['b'].getlength(t) for t in tlines), FONTS['r'].getlength(sub) * SMALL / FONT if sub else 0) + 4
        title_html = '<b>%s</b>' % '<br>'.join(esc(t) for t in tlines)
        th = (LINE + 1) * len(tlines)
        unit = iw + 8 + tw
        ux = x - unit / 2
        iy = hdr_y + (HDR_H - ih) / 2
        if pid in COMPOSITE:
            nw, nh, parts = COMPOSITE[pid]
            k = min(iw / nw, ih / nh)
            for part, dx, dy, pw, ph_ in parts:
                b.vertex('hdr-icon-%s-%s' % (ln['id'], part), '', restyle(pstyle(part), verticalLabelPosition=None),
                         round(ux + dx * k, 2), round(iy + dy * k, 2), round(pw * k, 2), round(ph_ * k, 2))
        else:
            b.vertex('hdr-icon-' + ln['id'], '', restyle(pstyle(pid), verticalLabelPosition=None), ux, iy, iw, ih)
        if sub:
            b.vertex('hdr-title-' + ln['id'], '<b>%s</b>' % esc(ln['title']),
                     'text;html=1;align=left;verticalAlign=middle;spacing=0;fontSize=%d;' % FONT, ux + iw + 8, hdr_y + HDR_H / 2 - LINE - 2, tw, LINE + 2)
            b.vertex('hdr-sub-' + ln['id'], esc(sub),
                     'text;html=1;align=left;verticalAlign=middle;spacing=0;fontSize=%d;fontColor=%s;' % (SMALL, QUIET), ux + iw + 8, hdr_y + HDR_H / 2, tw, SMALL + 5)
        else:
            b.vertex('hdr-title-' + ln['id'], title_html,
                     'text;html=1;align=left;verticalAlign=middle;spacing=0;fontSize=%d;' % FONT, ux + iw + 8, hdr_y + (HDR_H - th) / 2, tw, th)
        if unit > W - 28 - 16:
            warnings.append('header %s too wide (%d)' % (ln['id'], unit))

    # -- group rail: a bracket over the header cards of lanes that share a chain
    for g in groups:
        xs = [lx[i] for i in g['lanes']]
        left, right = min(xs) - W / 2 + 14, max(xs) + W / 2 - 14
        ry_ = HDR_Y + RAIL / 2 - 4
        pid, iw, ih = ICON[g['icon']]
        cx = (left + right) / 2
        gid = 'grp-' + g['id']
        for side, (x1, x2) in (('l', (left, cx - iw / 2 - 12)), ('r', (cx + iw / 2 + 12, right))):
            b.vertex('%s-rail-%s' % (gid, side), '', 'rounded=0;html=1;fillColor=%s;strokeColor=none;' % CARD_STROKE, x1, ry_, x2 - x1, 1.5)
        for side, x1 in (('l', left), ('r', right - 1.5)):
            b.vertex('%s-tick-%s' % (gid, side), '', 'rounded=0;html=1;fillColor=%s;strokeColor=none;' % CARD_STROKE, x1, ry_, 1.5, hdr_y - ry_ - 6)
        b.vertex(gid + '-icon', '', restyle(pstyle(pid), verticalLabelPosition=None), cx - iw / 2, ry_ - ih / 2, iw, ih)

    def frac(ry):
        return (ry - ll_top) / (ll_bot - ll_top)

    def edge_style(phase, exit_x, exit_y, entry_y, exit_perim=0):
        st = pstyle(PHASE[phase][2])
        return restyle(st, exitX=exit_x, exitY='%.5f' % exit_y, exitDx=0, exitDy=0, exitPerimeter=0,
                       entryX=0.5, entryY='%.5f' % entry_y, entryDx=0, entryDy=0, entryPerimeter=0,
                       endSize=7, jumpStyle=None)

    def circle(step, phase, x, ry, tint):
        cid = 'c' + step
        st = restyle(pstyle(PHASE[phase][1]), fillColor=tint, fontSize=20,
                     spacingLeft=2 if len(step) == 1 else 1, spacingTop=-1)
        b.vertex(cid, step + '.', st, x - CIRCLE / 2, ry - CIRCLE / 2, CIRCLE, CIRCLE)
        return cid

    def check_label(lines, gap_left, avail, name):
        w = width(lines)
        if w > avail:
            warnings.append('label %s is %d wide, room %d: %r' % (name, w, avail, lines))

    edges_out, circles_out = [], []
    boxes = []   # (name, x, y, w, h) of every side note and card, for the overlap check
    for band, top, bottom, rows in bands:
        tint = PHASE[band['phase']][3]
        for r, ry, ry_end in rows:
            ph = r['phase']
            if r['kind'] in ('arrow', 'fork'):
                a, z = lx[r['frm']], lx[r['to']]
                right = z > a
                gap_left = min(a, z)
                lab_x = gap_left + L - PAD_W
                if r.get('step'):
                    src = circle(r['step'], ph, a, ry, tint)
                    circles_out.append(src)
                    sx = a + CIRCLE / 2 if right else a - CIRCLE / 2
                    exit_x, exit_y = (1 if right else 0), 0.5
                else:
                    src = 'll-' + r['frm']
                    sx = a
                    exit_x, exit_y = 0.5, frac(ry)
                arms = [r['label']] if r['kind'] == 'arrow' else r['arms']
                for k, lab in enumerate(arms):
                    ay = ry + P * k
                    eid = 'e%s%s' % (r.get('step') or b.nid('x'), 'ab'[k] if r['kind'] == 'fork' else '')
                    pts = []
                    st = edge_style(ph, exit_x, exit_y, frac(ay))
                    if k == 1:
                        # second arm: drops from the circle's bottom, turns toward the target
                        pts = [(a, ay)]
                        st = restyle(st, exitX=0.5, exitY=1)
                    b.edge(eid, st, src, 'll-' + r['to'], pts)
                    # label seat as a fraction of the path length
                    if pts:
                        segs = [ay - (ry + CIRCLE / 2), abs(z - a)]
                        before = segs[0] + abs(lab_x - a)
                        total = sum(segs)
                    else:
                        total = abs(z - sx)
                        before = abs(lab_x - sx) if right else abs(sx - lab_x) - width(lab)
                    rel = 2 * before / total - 1
                    if not right and not pts:
                        # align=left seats the left edge: measure from the source going left
                        rel = 2 * (abs(sx - lab_x)) / total - 1
                    # the run crosses the label's vertical midpoint (house rule): give labels an odd line count
                    if len(lab) % 2 == 0:
                        warnings.append('label %s has %d lines: the line will run between two lines' % (eid, len(lab)))
                    b.label(eid + 'l', eid, html(lab, pad=True), rel, tint)
                    room = W - L - 18 if abs(z - a) <= W or not right else 10 ** 6
                    if r['frm'] == data.LANES[0]['id'] and abs(z - a) > W:
                        room = abs(z - a) - L - 30
                    check_label(lab, gap_left, room, eid)
                if r.get('side'):
                    sd = r['side']
                    x = lx[sd['lane']]
                    i = idx[sd['lane']]
                    # the gap right of that lifeline must be free of this row's arrow
                    if min(a, z) <= x < max(a, z):
                        warnings.append('side note at %s sits on its own arrow' % sd['lane'])
                    on_circle = r.get('step') and r['frm'] == sd['lane']
                    nx = x + (CIRCLE / 2 + 12 if on_circle else 16)
                    w = width(sd['lines']) + 2 * NOTE_PAD
                    h = LINE * len(sd['lines']) + 12
                    limit = (lx[lanes[i + 1]['id']] if i + 1 < len(lanes) else X0 + total_w) - 16
                    if nx + w > limit:
                        warnings.append('side note at %s is %d too wide' % (sd['lane'], nx + w - limit))
                    ny = ry - h / 2 + sd.get('dy', 0)
                    if ny < top + 4 or ny + h > bottom - 4:
                        warnings.append('side note at %s row %d leaves its band' % (sd['lane'], ry))
                    boxes.append(('side note at %s row %d' % (sd['lane'], ry), nx, ny, w, h))
                    b.vertex('side-%s-%d' % (sd['lane'], ry), html(sd['lines']), NOTE_STYLE, nx, ny, w, h)
            elif r['kind'] == 'note':
                # a card on one lifeline (an actor acting on, or describing, itself)
                x = lx[r['lane']]
                i = idx[r['lane']]
                col = PHASE[ph][0]
                w = width(r['lines']) + 2 * NOTE_PAD
                h = LINE * len(r['lines']) + 16
                cy = (ry + ry_end) / 2
                lo = (lx[lanes[i - 1]['id']] + 16) if i > 0 else X0 + 8
                hi = (lx[lanes[i + 1]['id']] - 16) if i + 1 < len(lanes) else X0 + total_w - 14  # header card edge
                nx = min(max(x - w / 2, lo), hi - w)
                if nx < lo or w > hi - lo:
                    warnings.append('card on %s does not fit between its neighbours (%d wide)' % (r['lane'], w))
                if h > ry_end - ry + P - 10:
                    warnings.append('card on %s is %d tall for %d rows' % (r['lane'], h, r.get('rows', 1)))
                boxes.append(('card on %s row %d' % (r['lane'], ry), nx, cy - h / 2, w, h))
                b.vertex('card-%s-%d' % (r['lane'], ry), html(r['lines']),
                         'rounded=1;arcSize=8;whiteSpace=wrap;html=1;align=left;verticalAlign=middle;fillColor=#FFFFFF;strokeColor=%s;strokeWidth=1.5;spacing=0;spacingLeft=%d;spacingRight=%d;fontSize=%d;' % (col, NOTE_PAD, NOTE_PAD, FONT),
                         nx, cy - h / 2, w, h)

    # notes and cards must keep GAP units apart
    GAP = 4
    for i_, (n1, x1, y1, w1, h1) in enumerate(boxes):
        for n2, x2, y2, w2, h2 in boxes[i_ + 1:]:
            if x1 < x2 + w2 + GAP and x2 < x1 + w1 + GAP and y1 < y2 + h2 + GAP and y2 < y1 + h1 + GAP:
                warnings.append('%s overlaps %s' % (n1, n2))

    # -- outcome card
    if getattr(data, 'OUTCOME', None):
        oy = bands[-1][2] + 22
        text = '<br>'.join(html_line(l) for l in data.OUTCOME)
        h = 24 + (LINE + 1) * len(data.OUTCOME)   # LINE + 1: a line with a code span is taller than LINE
        if max(width([l]) for l in data.OUTCOME) + 40 > total_w:
            warnings.append('outcome card is wider than the lanes')
        b.vertex('outcome', text,
                 'rounded=1;arcSize=10;whiteSpace=wrap;html=1;align=left;verticalAlign=middle;fillColor=#FFFFFF;strokeColor=%s;spacingLeft=16;spacingRight=16;fontSize=%d;' % (CARD_STROKE, FONT),
                 X0, oy, max(width([l]) for l in data.OUTCOME) + 40, h)
        if getattr(data, 'FOOTNOTE', None):
            b.vertex('footnote', html_line(data.FOOTNOTE),
                     'text;html=1;align=left;verticalAlign=middle;spacing=0;fontSize=%d;fontColor=%s;' % (SMALL, QUIET),
                     X0 + 16, oy + h + 10, width([data.FOOTNOTE]) * SMALL / FONT + 20, SMALL + 5)
        b.vertex('outcome-title', '<b>%s</b>' % esc(data.OUTCOME_TITLE),
                 'text;html=1;align=left;verticalAlign=middle;spacing=0;fontSize=%d;labelBackgroundColor=#FFFFFF;fontColor=%s;spacingLeft=4;spacingRight=4;' % (SMALL, QUIET),
                 X0 + 12, oy - 9, FONTS['b'].getlength(data.OUTCOME_TITLE) * SMALL / FONT + 12, SMALL + 5)

    # z-order: bands, lifelines, headers, edges (with labels), circles last
    head = [c for c in b.cells if 'edge="1"' not in c and not c.startswith('<mxCell id="c') and 'connectable="0"' not in c]
    edges = [c for c in b.cells if 'edge="1"' in c or 'connectable="0"' in c]
    circs = [c for c in b.cells if c.startswith('<mxCell id="c') and 'vertex="1"' in c and 'connectable' not in c]
    body = '\n'.join(head + edges + circs)
    xml = ('<mxfile host="build_sequence.py">\n<diagram name="%s" id="%s">\n'
           '<mxGraphModel dx="1200" dy="800" grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" '
           'fold="1" page="1" pageScale="1" pageWidth="1700" pageHeight="1500" background="#FFFFFF" math="0" shadow="0">\n'
           '<root>\n<mxCell id="0" />\n<mxCell id="1" parent="0" />\n%s\n</root>\n</mxGraphModel>\n</diagram>\n</mxfile>\n'
           % (data.TITLE, data.TITLE, body))
    open(out, 'w', encoding='utf-8').write(xml)
    for w_ in warnings:
        print('WARN', w_)
    print('wrote', out)

def slug(s):
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')

if __name__ == '__main__':
    build(load(sys.argv[1]), sys.argv[2])
