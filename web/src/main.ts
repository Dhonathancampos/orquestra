import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import './style.css'

type Info = { id: string; name: string; kind: 'orchestrator' | 'agent' | 'shell'; provider: string; bypass?: boolean; parent: string | null; cwd: string; state: string }
type Box = { x: number; y: number; w: number; h: number } // coordenadas "do mundo" (sem zoom)
type Prov = { id: string; name: string; command: string; clear?: string; orchestrator_command?: string }
type Win = { info: Info; el: HTMLElement; dot: HTMLElement; title: HTMLElement; sel: HTMLSelectElement; box: Box; term: Terminal; fit: FitAddon; ws: WebSocket; state: string }

const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T
const viewport = $('#viewport'), canvas = $('#canvas'), links = document.querySelector('#links') as unknown as SVGSVGElement
const wins = new Map<string, Win>()
const BASE_FONT = 13
let pan = { x: 0, y: 0 }, zoom = 1, zTop = 10
let layout: Record<string, Box> = {}
let providers: Prov[] = [], defaultProvider = 'claude'
try {
  layout = JSON.parse(localStorage.getItem('orq.layout') || '{}'); pan = JSON.parse(localStorage.getItem('orq.pan') || '{"x":0,"y":0}')
  zoom = Number(localStorage.getItem('orq.zoom')) || 1
} catch {}
const save = () => { try { localStorage.setItem('orq.layout', JSON.stringify(layout)); localStorage.setItem('orq.pan', JSON.stringify(pan)); localStorage.setItem('orq.zoom', String(zoom)) } catch {} }
const applyPan = () => { canvas.style.transform = `translate(${pan.x}px,${pan.y}px)`; viewport.style.backgroundPosition = `${pan.x}px ${pan.y}px` }

const api = async (path: string, init?: RequestInit) => {
  const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...init })
  if (!r.ok) throw new Error(await r.text())
  return r.status === 204 ? null : r.json()
}
const orchestrator = () => [...wins.values()].find(w => w.info.kind === 'orchestrator')
const provName = (id: string) => providers.find(p => p.id === id)?.name ?? id

// ---------- posicionamento (mundo → tela: x*zoom) ----------
const vw = () => viewport.clientWidth, vh = () => viewport.clientHeight
function defaultBox(info: Info): Box {
  if (info.kind === 'orchestrator') {
    const w = 720, h = 480
    return { w, h, x: ((vw() - w * zoom) / 2 - pan.x) / zoom, y: ((vh() - h * zoom) / 2 - pan.y) / zoom }
  }
  const parent = info.parent && wins.get(info.parent)
  if (parent) {
    // 8 "slots" retangulares ao redor do pai (sem sobreposição); anéis seguintes ficam mais longe.
    const n = [...wins.values()].filter(w => w.info.parent === info.parent).length
    const ring = Math.floor(n / 8) + 1, slot = [[0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1]][n % 8]
    const w = 480, h = 320, g = 40, pb = parent.box
    const dx = (pb.w / 2 + w / 2 + g) * ring, dy = (pb.h / 2 + h / 2 + g) * ring
    return { w, h, x: pb.x + pb.w / 2 + slot[0] * dx - w / 2, y: pb.y + pb.h / 2 + slot[1] * dy - h / 2 }
  }
  return { w: 560, h: 360, x: (40 - pan.x) / zoom, y: (40 - pan.y) / zoom }
}
let suppress = false
function place(w: Win) {
  if (w.el.classList.contains('max')) return
  const s = w.el.style
  s.left = w.box.x * zoom + 'px'; s.top = w.box.y * zoom + 'px'; s.width = w.box.w * zoom + 'px'; s.height = w.box.h * zoom + 'px'
}
function focus(w: Win) {
  wins.forEach(o => o.el.classList.remove('focus'))
  w.el.classList.add('focus'); w.el.style.zIndex = String(++zTop)
}
function refit(w: Win) { try { w.fit.fit() } catch {} }

function applyZoom() {
  suppress = true
  $('#zlabel').textContent = Math.round(zoom * 100) + '%'
  wins.forEach(w => { place(w); w.term.options.fontSize = Math.max(5, BASE_FONT * zoom) })
  requestAnimationFrame(() => { wins.forEach(refit); drawLinks(); setTimeout(() => { suppress = false }, 60) })
  save()
}
function zoomAt(cx: number, cy: number, factor: number) {
  const nz = Math.min(1.8, Math.max(0.3, zoom * factor))
  if (nz === zoom) return
  const r = viewport.getBoundingClientRect(), px = cx - r.left, py = cy - r.top
  pan = { x: px - (px - pan.x) * (nz / zoom), y: py - (py - pan.y) * (nz / zoom) }
  zoom = nz; applyPan(); applyZoom()
}
// Scroll = zoom. Exceção: sobre o terminal em foco (clicado), o scroll rola o histórico dele.
// Ctrl+scroll sempre dá zoom. O zoom é acumulado e aplicado uma vez por frame.
let wheelAcc = 0, wheelX = 0, wheelY = 0, wheelRaf = 0
document.addEventListener('wheel', e => {
  const overFocusedTerm = (e.target as HTMLElement).closest('.win.focus .body')
  if (overFocusedTerm && !e.ctrlKey) return
  if ((e.target as HTMLElement).closest('.modal,#palette,#bar')) return
  e.preventDefault()
  const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY
  wheelAcc += dy; wheelX = e.clientX; wheelY = e.clientY
  if (!wheelRaf) wheelRaf = requestAnimationFrame(() => {
    wheelRaf = 0
    const f = Math.exp(-Math.max(-300, Math.min(300, wheelAcc)) * 0.0015); wheelAcc = 0
    zoomAt(wheelX, wheelY, f)
  })
}, { passive: false, capture: true })

// ---------- linhas orquestrador → filhos ----------
let linkRaf = 0
function drawLinks() {
  cancelAnimationFrame(linkRaf)
  linkRaf = requestAnimationFrame(() => {
    let html = ''
    wins.forEach(w => {
      const p = w.info.parent && wins.get(w.info.parent)
      if (!p || w.el.classList.contains('max')) return
      const a = { x: (p.box.x + p.box.w / 2) * zoom, y: (p.box.y + p.box.h / 2) * zoom }, b = { x: (w.box.x + w.box.w / 2) * zoom, y: (w.box.y + w.box.h / 2) * zoom }
      const dx = (b.x - a.x) / 2
      html += `<path class="${w.state}" d="M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}"/>`
    })
    links.innerHTML = html
  })
}

// ---------- janelas ----------
function connect(w: Win) {
  const ws = new WebSocket(`ws://${location.host}/ws/term/${w.info.id}`)
  ws.binaryType = 'arraybuffer'
  ws.onmessage = e => { if (e.data instanceof ArrayBuffer) w.term.write(new Uint8Array(e.data)) }
  ws.onopen = () => { refit(w); ws.send(JSON.stringify({ t: 'resize', cols: w.term.cols, rows: w.term.rows })) }
  w.ws = ws
}
const enc = new TextEncoder()

function fillSelect(w: Win) {
  const opts = providers.filter(p => w.info.kind === 'orchestrator' ? !!p.orchestrator_command : true)
  w.sel.innerHTML = opts.map(p => `<option value="${p.id}">${p.name}</option>`).join('')
  if (!opts.some(p => p.id === w.info.provider)) w.sel.insertAdjacentHTML('afterbegin', `<option value="${w.info.provider}">${w.info.provider}</option>`)
  w.sel.value = w.info.provider
}

function addWin(info: Info) {
  if (wins.has(info.id)) return
  const el = document.createElement('section')
  el.className = 'win' + (info.kind === 'orchestrator' ? ' orch' : '')
  el.innerHTML = `<header><span class="st"></span><span class="title"></span><span class="tag bypass" title="Este chat roda sem pedir confirmação de permissões" hidden>⚡ bypass</span><select title="Trocar a IA deste chat (reinicia a conversa)"></select><button data-a="clear" title="Limpar contexto com checkpoint (salva na memória, limpa e retoma)">🧹</button><button data-a="max" title="Maximizar">▢</button><button data-a="close" title="Fechar">✕</button></header><div class="body"></div>`
  const dot = el.querySelector('.st') as HTMLElement, title = el.querySelector('.title') as HTMLElement
  const sel = el.querySelector('select') as HTMLSelectElement
  title.textContent = info.name
  ;(el.querySelector('.bypass') as HTMLElement).hidden = !info.bypass
  canvas.appendChild(el)

  const term = new Terminal({
    fontFamily: '"JetBrains Mono","Fira Code","DejaVu Sans Mono",monospace', fontSize: Math.max(5, BASE_FONT * zoom), cursorBlink: true, scrollback: 5000, allowProposedApi: true,
    theme: { background: '#0b0d12', foreground: '#d7dce6', cursor: '#a78bfa', selectionBackground: '#3b3566' },
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(el.querySelector('.body') as HTMLElement)
  try { const g = new WebglAddon(); g.onContextLoss(() => g.dispose()); term.loadAddon(g) } catch {}
  term.attachCustomKeyEventHandler(e => !(e.ctrlKey && ['k', '=', '+', '-', '0'].includes(e.key.toLowerCase())))

  const box = layout[info.id] || defaultBox(info)
  const w = { info, el, dot, title, sel, box, term, fit, state: info.state, ws: null as unknown as WebSocket } as Win
  wins.set(info.id, w)
  layout[info.id] = box
  fillSelect(w); connect(w)
  term.onData(d => w.ws.readyState === 1 && w.ws.send(enc.encode(d)))
  term.onResize(() => w.ws.readyState === 1 && w.ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows })))
  place(w); focus(w); setState(w, info.state); drawLinks(); stats()

  new ResizeObserver(() => {
    if (!suppress && !el.classList.contains('max')) { w.box.w = el.offsetWidth / zoom; w.box.h = el.offsetHeight / zoom; layout[info.id] = w.box; save() }
    refit(w); drawLinks()
  }).observe(el)

  el.addEventListener('pointerdown', () => focus(w), true)
  const header = el.querySelector('header') as HTMLElement
  header.addEventListener('pointerdown', e => {
    if ((e.target as HTMLElement).closest('button,input,select')) return
    e.preventDefault()
    const sx = e.clientX, sy = e.clientY, ox = w.box.x, oy = w.box.y
    header.setPointerCapture(e.pointerId)
    const mv = (m: PointerEvent) => { w.box.x = ox + (m.clientX - sx) / zoom; w.box.y = oy + (m.clientY - sy) / zoom; place(w); drawLinks() }
    const up = () => { header.removeEventListener('pointermove', mv); header.removeEventListener('pointerup', up); layout[info.id] = w.box; save() }
    header.addEventListener('pointermove', mv); header.addEventListener('pointerup', up)
  })
  header.addEventListener('dblclick', e => { if (!(e.target as HTMLElement).closest('button,input,select,.title')) toggleMax(w) })
  title.addEventListener('dblclick', () => rename(w))
  el.querySelector('[data-a=max]')!.addEventListener('click', () => toggleMax(w))
  el.querySelector('[data-a=close]')!.addEventListener('click', () => closeWin(w))
  el.querySelector('[data-a=clear]')!.addEventListener('click', () => clearCtx(w))
  sel.addEventListener('change', () => switchProv(w, sel.value))
  term.focus()
}

async function clearCtx(w: Win) {
  try { await api(`/api/terms/${w.info.id}/clear`, { method: 'POST' }) } catch (e) { toast('Erro: ' + e) }
}
async function switchProv(w: Win, provider: string) {
  if (provider === w.info.provider) return
  if (!confirm(`Trocar ${w.info.name} para ${provName(provider)}?\nO processo reinicia e a conversa atual se perde.`)) { w.sel.value = w.info.provider; return }
  try { await api(`/api/terms/${w.info.id}/provider`, { method: 'POST', body: JSON.stringify({ provider }) }) } catch (e) { toast('Erro: ' + e); w.sel.value = w.info.provider }
}
function restarted(info: Info) {
  const w = wins.get(info.id); if (!w) return addWin(info)
  w.ws.onclose = null; w.ws.close()
  w.info = info; (w.el.querySelector('.bypass') as HTMLElement).hidden = !info.bypass; w.term.reset(); fillSelect(w); setState(w, info.state); connect(w); stats()
  toast(`🔁 ${info.name} agora usa ${provName(info.provider)}`)
}

function toggleMax(w: Win) {
  w.el.classList.toggle('max'); place(w); drawLinks()
  setTimeout(() => { refit(w); w.term.focus() }, 30)
}
function rename(w: Win) {
  const inp = document.createElement('input'); inp.value = w.info.name
  w.title.textContent = ''; w.title.appendChild(inp); inp.focus(); inp.select()
  const done = (ok: boolean) => {
    const v = inp.value.trim(); if (ok && v) { w.info.name = v; api(`/api/terms/${w.info.id}`, { method: 'PATCH', body: JSON.stringify({ name: v }) }).catch(() => {}) }
    w.title.textContent = w.info.name; w.term.focus()
  }
  inp.onkeydown = e => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false) }
  inp.onblur = () => done(true)
}
async function closeWin(w: Win) {
  if (w.info.kind === 'orchestrator' && wins.size > 1 && !confirm('Fechar o orquestrador fecha também todos os outros chats. Continuar?')) return
  await api(`/api/terms/${w.info.id}`, { method: 'DELETE' }).catch(() => {}); dropWin(w.info.id)
}
function dropWin(id: string) {
  const w = wins.get(id); if (!w) return
  w.ws.onclose = null; w.ws.close(); w.term.dispose(); w.el.remove(); wins.delete(id); delete layout[id]; save(); drawLinks(); stats()
}

// ---------- estados / avisos ----------
function setState(w: Win, s: string) { w.state = s; w.dot.className = 'st ' + s; w.dot.title = s }
function stats() {
  const all = [...wins.values()], c = (s: string) => all.filter(w => w.state === s).length
  $('#stats').innerHTML = `<b>${all.length}</b> terminais · <b>${c('working')}</b> trabalhando · <b>${c('idle')}</b> ociosos`
  const has = !!orchestrator()
  ;($('#b-orch') as HTMLButtonElement).disabled = has
  document.querySelectorAll<HTMLButtonElement>('#prov-btns button').forEach(b => { b.disabled = !has; b.title = has ? '' : 'Crie o orquestrador primeiro' })
  document.title = (c('working') ? `⏳${c('working')} ` : '') + 'Orquestra'
}
function toast(msg: string) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg
  $('#toasts').appendChild(t); setTimeout(() => t.remove(), 5000)
}
function connectEvents() {
  const ws = new WebSocket(`ws://${location.host}/ws/events`)
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.e === 'created') addWin(m.term)
    else if (m.e === 'restarted') restarted(m.term)
    else if (m.e === 'clear_phase') { const w = wins.get(m.id); if (w) w.el.classList.toggle('busy', !['done', 'error'].includes(m.phase)); toast(m.msg) }
    else if (m.e === 'removed') dropWin(m.id)
    else if (m.e === 'exit') { const w = wins.get(m.id); if (w) { setState(w, 'exited'); stats() } }
    else if (m.e === 'states') {
      for (const s of m.states) {
        const w = wins.get(s.id); if (!w || w.state === 'exited') continue
        if (w.state === 'working' && s.state === 'idle' && w.info.kind !== 'shell') toast(`✔ ${w.info.name} parou — pode ter terminado`)
        if (w.state !== s.state) setState(w, s.state)
      }
      stats(); drawLinks()
    }
  }
  ws.onclose = () => setTimeout(connectEvents, 1500)
}

// ---------- providers / ações ----------
async function loadProviders() {
  const cfg = await api('/api/providers')
  providers = cfg.providers; defaultProvider = cfg.default_provider || providers[0]?.id
  $('#prov-btns').innerHTML = providers.map(p => `<button data-prov="${p.id}">＋ ${p.name}</button>`).join('')
  wins.forEach(fillSelect); stats()
}
async function spawn(kind: 'orchestrator' | 'agent', provider?: string) {
  try {
    if (kind === 'orchestrator') provider = providers.find(p => p.id === defaultProvider && p.orchestrator_command)?.id ?? providers.find(p => p.orchestrator_command)?.id
    await api('/api/terms', { method: 'POST', body: JSON.stringify({ kind: provider === 'shell' ? 'shell' : kind, provider }) })
  } catch (e) { toast('Erro: ' + e) }
}
function tile() {
  const list = [...wins.values()].sort((a, b) => (a.info.kind === 'orchestrator' ? -1 : 0) - (b.info.kind === 'orchestrator' ? -1 : 0))
  if (!list.length) return
  zoom = 1; pan = { x: 0, y: 0 }; applyPan()
  const cols = Math.ceil(Math.sqrt(list.length * vw() / vh())), rows = Math.ceil(list.length / cols), g = 10
  const cw = (vw() - g * (cols + 1)) / cols, ch = (vh() - g * (rows + 1)) / rows
  list.forEach((w, i) => {
    w.el.classList.remove('max')
    w.box = { x: g + (i % cols) * (cw + g), y: g + Math.floor(i / cols) * (ch + g), w: cw, h: ch }
    layout[w.info.id] = w.box
  })
  applyZoom()
}
function fitAll() {
  const l = [...wins.values()].filter(w => !w.el.classList.contains('max')); if (!l.length) return
  const x0 = Math.min(...l.map(w => w.box.x)), y0 = Math.min(...l.map(w => w.box.y))
  const x1 = Math.max(...l.map(w => w.box.x + w.box.w)), y1 = Math.max(...l.map(w => w.box.y + w.box.h))
  zoom = Math.min(1.2, Math.max(0.3, Math.min((vw() - 60) / (x1 - x0), (vh() - 60) / (y1 - y0))))
  pan = { x: (vw() - (x1 - x0) * zoom) / 2 - x0 * zoom, y: (vh() - (y1 - y0) * zoom) / 2 - y0 * zoom }
  applyPan(); applyZoom()
}
function centerOn(w?: Win) {
  w = w || orchestrator() || [...wins.values()][0]
  pan = w ? { x: vw() / 2 - (w.box.x + w.box.w / 2) * zoom, y: vh() / 2 - (w.box.y + w.box.h / 2) * zoom } : { x: 0, y: 0 }
  applyPan(); save()
}
const zc = () => { const r = viewport.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] as const }
const actions: Record<string, () => void> = {
  orch: () => spawn('orchestrator'), tile, fit: fitAll, center: () => centerOn(), palette: () => openPalette(),
  zin: () => zoomAt(...zc(), 1.15), zout: () => zoomAt(...zc(), 1 / 1.15), zreset: () => zoomAt(...zc(), 1 / zoom),
  memory: () => openMemory(), config: () => openConfig(),
}
document.querySelector('#bar')!.addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null
  if (!b) return
  if (b.dataset.prov) spawn('agent', b.dataset.prov); else if (b.dataset.act) actions[b.dataset.act]()
})
document.addEventListener('keydown', e => {
  if (!e.ctrlKey) return
  if (e.key === '=' || e.key === '+') { e.preventDefault(); actions.zin() }
  else if (e.key === '-') { e.preventDefault(); actions.zout() }
  else if (e.key === '0') { e.preventDefault(); actions.zreset() }
}, true)

// pan do fundo
viewport.addEventListener('pointerdown', e => {
  if (e.target !== viewport && e.target !== canvas) return
  wins.forEach(o => o.el.classList.remove('focus'))
  viewport.classList.add('panning'); viewport.setPointerCapture(e.pointerId)
  const sx = e.clientX, sy = e.clientY, ox = pan.x, oy = pan.y
  const mv = (m: PointerEvent) => { pan = { x: ox + m.clientX - sx, y: oy + m.clientY - sy }; applyPan() }
  const up = () => { viewport.classList.remove('panning'); viewport.removeEventListener('pointermove', mv); viewport.removeEventListener('pointerup', up); save() }
  viewport.addEventListener('pointermove', mv); viewport.addEventListener('pointerup', up)
})

// ---------- modais: IAs e memória ----------
const modal = $('#modal'), mBody = $('#m-body')
const openModal = (title: string) => { $('#m-title').textContent = title; modal.hidden = false }
const closeModal = () => { modal.hidden = true; mBody.innerHTML = '' }
$('#m-close').addEventListener('click', closeModal)
modal.addEventListener('pointerdown', e => { if (e.target === modal) closeModal() })
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

async function openConfig() {
  openModal('⚙ IAs e atalhos')
  const cfg = await api('/api/providers')
  mBody.innerHTML = `<div class="hint">Cada IA é um atalho: <code>command</code> roda no terminal, <code>clear</code> é enviado para limpar o contexto, e <code>orchestrator_command</code> (opcional) permite que ela seja o orquestrador. Adicione quantas quiser (ex.: <code>{"id":"aider","name":"Aider","command":"aider","clear":"/clear"}</code>).</div><textarea spellcheck="false"></textarea><div><button id="cfg-save">Salvar</button> <span id="cfg-msg" class="hint"></span></div>`
  const ta = mBody.querySelector('textarea') as HTMLTextAreaElement
  ta.value = JSON.stringify(cfg, null, 2)
  $('#cfg-save').onclick = async () => {
    const msg = $('#cfg-msg')
    try { await api('/api/providers', { method: 'PUT', body: ta.value, headers: {} }); await loadProviders(); msg.className = 'hint'; msg.textContent = 'Salvo ✔'; setTimeout(closeModal, 600) }
    catch (e) { msg.className = 'err'; msg.textContent = String((e as Error).message) }
  }
}
function openMemory() {
  openModal('🧠 Memória compartilhada (ai-memory)')
  mBody.innerHTML = `<input id="mem-q" placeholder="Buscar no wiki do projeto…"/><div class="hint">A busca usa o projeto da pasta de trabalho do orquestrador. Ao criar um agente com prompt, o orquestrador anexa automaticamente o contexto relevante.</div><div id="mem-res"></div>`
  const q = $('#mem-q') as HTMLInputElement; q.focus()
  q.onkeydown = async e => {
    if (e.key !== 'Enter' || !q.value.trim()) return
    const res = $('#mem-res'); res.textContent = 'Buscando…'
    try {
      const hits: { title: string; path: string; snippet: string }[] = await api('/api/memory?q=' + encodeURIComponent(q.value) + '&cwd=' + encodeURIComponent(orchestrator()?.info.cwd || ''))
      res.innerHTML = hits.length ? hits.map(h => `<div class="hit"><b>${esc(h.title)}</b><small>${esc(h.path)}</small><p>${esc(h.snippet)}</p></div>`).join('') : '<span class="hint">Nada encontrado.</span>'
    } catch (er) { res.innerHTML = `<span class="err">${esc(String(er))}</span>` }
  }
}

// ---------- paleta ----------
const pal = $('#palette'), palIn = $('#pal-input') as HTMLInputElement, palList = $('#pal-list')
let palItems: { label: string; hint: string; run: () => void }[] = [], palSel = 0
function items() {
  const base = [
    { label: 'Novo orquestrador', hint: 'chat central', run: actions.orch },
    ...providers.map(p => ({ label: `Novo chat: ${p.name}`, hint: p.id, run: () => spawn('agent', p.id) })),
    { label: 'Organizar em grade', hint: '▦', run: tile },
    { label: 'Ajustar tudo à tela', hint: '⤢', run: fitAll },
    { label: 'Centralizar no orquestrador', hint: '⌖', run: () => centerOn() },
    { label: 'Limpar contexto de todos os agentes', hint: '💾→🧹→↩', run: () => wins.forEach(w => { if (w.info.kind === 'agent') clearCtx(w) }) },
    { label: 'Fechar agentes ociosos', hint: 'limpeza', run: () => wins.forEach(w => { if (w.state === 'idle' && w.info.kind === 'agent') closeWin(w) }) },
    { label: 'Buscar na memória', hint: '🧠', run: openMemory },
    { label: 'Configurar IAs', hint: '⚙', run: openConfig },
  ]
  const ts = [...wins.values()].map(w => ({ label: 'Ir para: ' + w.info.name, hint: provName(w.info.provider) + ' · ' + w.state, run: () => { w.el.classList.remove('max'); centerOn(w); focus(w); w.term.focus() } }))
  return [...base, ...ts]
}
function renderPal() {
  const q = palIn.value.toLowerCase()
  palItems = items().filter(i => i.label.toLowerCase().includes(q)); palSel = Math.min(palSel, Math.max(0, palItems.length - 1))
  palList.innerHTML = palItems.map((i, n) => `<li class="${n === palSel ? 'sel' : ''}" data-n="${n}">${esc(i.label)}<small>${esc(i.hint)}</small></li>`).join('')
}
function openPalette() { pal.hidden = false; palIn.value = ''; palSel = 0; renderPal(); palIn.focus() }
function closePalette() { pal.hidden = true }
palIn.addEventListener('input', () => { palSel = 0; renderPal() })
palIn.addEventListener('keydown', e => {
  if (e.key === 'Escape') closePalette()
  else if (e.key === 'ArrowDown') { palSel = Math.min(palSel + 1, palItems.length - 1); renderPal(); e.preventDefault() }
  else if (e.key === 'ArrowUp') { palSel = Math.max(palSel - 1, 0); renderPal(); e.preventDefault() }
  else if (e.key === 'Enter') { const it = palItems[palSel]; closePalette(); it?.run() }
})
palList.addEventListener('click', e => { const n = (e.target as HTMLElement).closest('li')?.dataset.n; if (n != null) { const it = palItems[+n]; closePalette(); it.run() } })
pal.addEventListener('pointerdown', e => { if (e.target === pal) closePalette() })
document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key.toLowerCase() === 'k') { e.preventDefault(); pal.hidden ? openPalette() : closePalette() }
  if (e.key === 'Escape' && !modal.hidden) closeModal()
}, true)

// ---------- versão / atualização ----------
type Upd = { current: string; latest?: string; update_available: boolean; url?: string; asset_url?: string | null; notes?: string; error?: string; note?: string; disabled?: boolean }
const openExternal = (url: string) => api('/api/open', { method: 'POST', body: JSON.stringify({ url }) }).catch(() => toast('Não consegui abrir o link: ' + url))
async function checkUpdate(manual = false) {
  let u: Upd
  try { u = await api('/api/update' + (manual ? '?force=true' : '')) } catch { if (manual) toast('Não consegui verificar atualizações.'); return }
  const box = $('#update')
  if (u.update_available && u.latest && (manual || localStorage.getItem('orq.skipver') !== u.latest)) {
    box.hidden = false
    box.innerHTML = `<span>⬆ <b>Nova versão ${esc(u.latest)}</b> <small>(você está na ${esc(u.current)})</small></span><button class="pri" data-u="dl">Baixar</button><button data-u="notes">Novidades</button><button data-u="skip">Depois</button>`
    box.onclick = e => {
      const k = (e.target as HTMLElement).closest('button')?.dataset.u
      if (k === 'dl') openExternal(u.asset_url || u.url!)
      else if (k === 'notes') openExternal(u.url!)
      else if (k === 'skip') { try { localStorage.setItem('orq.skipver', u.latest!) } catch {}; box.hidden = true }
    }
  } else {
    box.hidden = true
    if (manual) toast(u.error ? `Sem conexão com o GitHub (${u.error})` : u.disabled ? 'Verificação de atualizações desativada.' : u.note ?? `✔ Você está na versão mais recente (${u.current}).`)
  }
}
$('#ver').addEventListener('click', () => checkUpdate(true))
api('/api/version').then(v => { $('#ver').textContent = 'v' + v.version }).catch(() => {})

// ---------- boot ----------
applyPan(); $('#zlabel').textContent = Math.round(zoom * 100) + '%'
;(async () => {
  await loadProviders()
  const list: Info[] = await api('/api/terms')
  list.sort((a, b) => (a.kind === 'orchestrator' ? -1 : 0) - (b.kind === 'orchestrator' ? -1 : 0)).forEach(addWin)
  if (!list.length) toast('Comece pelo ◉ Orquestrador: nenhum chat existe sem ele.')
  connectEvents(); stats()
  checkUpdate(); setInterval(() => checkUpdate(), 6 * 3600 * 1000)
})()
