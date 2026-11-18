import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import './style.css'

type Info = { id: string; name: string; kind: 'orchestrator' | 'agent' | 'shell'; provider: string; bypass?: boolean; parent: string | null; cwd: string; state: string; theme?: string }
type Box = { x: number; y: number; w: number; h: number } // coordenadas "do mundo" (sem zoom)
type Prov = { id: string; name: string; command: string; clear?: string; orchestrator_command?: string }
type Win = { chatBox?: HTMLElement; poll?: number; workSince?: number; notified?: boolean; retry?: number; info: Info; el: HTMLElement; dot: HTMLElement; title: HTMLElement; sel: HTMLSelectElement; box: Box; term: Terminal; fit: FitAddon; ws: WebSocket; state: string }

const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T
const viewport = $('#viewport'), canvas = $('#canvas'), links = document.querySelector('#links') as unknown as SVGSVGElement
const wins = new Map<string, Win>()
const BASE_FONT = 14
let fontScale = 1
let pan = { x: 0, y: 0 }, zoom = 1, zTop = 10
let layout: Record<string, Box> = {}
let providers: Prov[] = [], defaultProvider = 'claude'
try {
  layout = JSON.parse(localStorage.getItem('orq.layout') || '{}'); pan = JSON.parse(localStorage.getItem('orq.pan') || '{"x":0,"y":0}')
  zoom = Number(localStorage.getItem('orq.zoom')) || 1
  fontScale = Number(localStorage.getItem('orq.font')) || 1
} catch {}
const save = () => { try { localStorage.setItem('orq.layout', JSON.stringify(layout)); localStorage.setItem('orq.pan', JSON.stringify(pan)); localStorage.setItem('orq.zoom', String(zoom)); localStorage.setItem('orq.font', String(fontScale)) } catch {} }
const applyPan = () => { canvas.style.transform = `translate(${pan.x}px,${pan.y}px)`; viewport.style.backgroundPosition = `${pan.x}px ${pan.y}px`; placeMaxed() }
// Janela maximizada ocupa toda a área visível. O #canvas tem transform (pan), então posicionamos em coordenadas dele.
function placeMaxed() {
  wins.forEach(w => {
    if (!w.el.classList.contains('max')) return
    const s = w.el.style
    s.minWidth = s.minHeight = '0'; s.left = -pan.x + 'px'; s.top = -pan.y + 'px'; s.width = viewport.clientWidth + 'px'; s.height = viewport.clientHeight + 'px'
  })
}
window.addEventListener('resize', () => { placeMaxed(); wins.forEach(refit) })

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
  const mates = info.theme ? [...wins.values()].filter(o => o.info.theme === info.theme && o.info.kind !== 'orchestrator') : []
  if (mates.length) {
    const x1 = Math.max(...mates.map(m => m.box.x + m.box.w)), y0 = Math.min(...mates.map(m => m.box.y)), x0 = Math.min(...mates.map(m => m.box.x))
    const w = 480, h = 320, g = 24, perRow = 3
    return mates.length % perRow === 0 ? { w, h, x: x0, y: Math.max(...mates.map(m => m.box.y + m.box.h)) + g } : { w, h, x: x1 + g, y: y0 }
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
  if (w.el.classList.contains('max')) { placeMaxed(); return }
  const s = w.el.style
  s.minWidth = 260 * zoom + 'px'; s.minHeight = 140 * zoom + 'px'
  s.left = w.box.x * zoom + 'px'; s.top = w.box.y * zoom + 'px'; s.width = w.box.w * zoom + 'px'; s.height = w.box.h * zoom + 'px'
}
function focus(w: Win) {
  wins.forEach(o => o.el.classList.remove('focus'))
  w.el.classList.add('focus'); w.el.style.zIndex = String(++zTop)
  renderDrawer()
}
function refit(w: Win) { try { w.fit.fit() } catch {} }

function applyZoom() {
  suppress = true
  $('#zlabel').textContent = Math.round(zoom * 100) + '%'
  wins.forEach(w => { place(w); w.term.options.fontSize = Math.max(5, BASE_FONT * fontScale * zoom) })
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
    drawGroups()
  })
}

// ---------- janelas ----------
function connect(w: Win) {
  const ws = new WebSocket(`ws://${location.host}/ws/term/${w.info.id}`)
  ws.binaryType = 'arraybuffer'
  // Reconecta sozinho (o servidor reenvia a tela inteira): evita o chat "congelado" depois de uma queda do socket.
  ws.onclose = () => {
    if (!wins.has(w.info.id) || w.ws !== ws || w.state === 'exited') return
    w.retry = window.setTimeout(() => { if (wins.get(w.info.id) === w && w.ws === ws) connect(w) }, 1000)
  }
  ws.onmessage = e => { if (e.data instanceof ArrayBuffer) w.term.write(new Uint8Array(e.data)) }
  ws.onopen = () => { refit(w); ws.send(JSON.stringify({ t: 'resize', cols: w.term.cols, rows: w.term.rows })) }
  w.ws = ws
}
const enc = new TextEncoder()

// Teclas mortas (´ ~ ^ ` + letra) e IME: no WebKitGTK a confirmação da composição chega em ordens de eventos
// diferentes (compositionend, input, keydown 229) e o xterm.js acaba enviando texto parcial/duplicado ("çã çã").
// Aqui a composição é "dona" do nosso código: bloqueamos esses eventos para o xterm, enviamos o texto final UMA vez
// (compositionend.data) e filtramos qualquer eco curto do xterm logo depois.
function hardenInput(term: Terminal, root: HTMLElement, out: (d: string) => void) {
  let composing = false, last = '', lastAt = 0, own = '', ownAt = -1e9
  const NONASCII = /[^\x00-\x7f]/
  const stop = (e: Event) => { e.stopPropagation(); e.stopImmediatePropagation() }
  const clear = () => { if (term.textarea) term.textarea.value = '' }
  const send = (d: string) => { last = d; lastAt = performance.now(); out(d) }
  root.addEventListener('compositionstart', e => { composing = true; stop(e) }, true)
  root.addEventListener('compositionupdate', e => { composing = true; stop(e) }, true)
  const commit = (t: string) => { own = t; ownAt = performance.now(); send(t) }
  root.addEventListener('compositionend', e => {
    composing = false; stop(e)
    const t = (e as CompositionEvent).data
    if (t) commit(t)
    clear()
  }, true)
  const inputish = (e: Event) => {
    const i = e as InputEvent
    // composição "pendente" (sem compositionend) que termina com um insertText normal: esse texto é a confirmação
    if (composing && !i.isComposing && i.inputType === 'insertText') {
      stop(e)
      if (e.type === 'input') { composing = false; if (i.data) commit(i.data); clear() }
      return
    }
    if (composing || i.isComposing || i.inputType === 'insertCompositionText') { stop(e); if (e.type === 'input') clear() }
  }
  root.addEventListener('beforeinput', inputish, true)
  root.addEventListener('input', inputish, true)
  root.addEventListener('keydown', e => {
    const k = e as KeyboardEvent
    if (composing || k.isComposing || k.keyCode === 229 || k.key === 'Dead') stop(e)
  }, true)
  // dados vindos do xterm: descarta eco/duplicata de texto acentuado (humanos não digitam o mesmo acento em < 60 ms)
  return (d: string) => {
    const now = performance.now()
    if (d.length <= 8 && NONASCII.test(d)) {
      if (d === last && now - lastAt < 60) return
      if (own && now - ownAt < 120 && (own.includes(d) || d.includes(own))) return
    }
    send(d)
  }
}

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
  el.innerHTML = `<header><span class="st"></span><span class="title"></span><span class="tag theme" title="Tema (clique para mudar)" hidden></span><span class="tag bypass" title="Este chat roda sem pedir confirmação de permissões" hidden>⚡ bypass</span><select title="Trocar a IA deste chat (reinicia a conversa)"></select><button data-a="view" title="Alternar entre visão de terminal e visão de chat">💬</button><button data-a="theme" title="Definir tema (agrupa chats do mesmo assunto)">🏷</button><button data-a="clear" title="Limpar contexto com checkpoint (salva na memória, limpa e retoma)">🧹</button><button data-a="size" title="Tamanho do chat: alterna pequeno → médio → grande (ou arraste as bordas/canto)">⤡</button><button data-a="max" title="Maximizar">▢</button><button data-a="close" title="Fechar">✕</button></header><div class="body"></div><div class="chatv"><div class="msgs"></div><button class="jump" hidden>↓ Novas mensagens</button><div class="perm" hidden></div><div class="cin"><textarea rows="1" placeholder="Mensagem… (Enter envia · Shift+Enter nova linha)" spellcheck="false"></textarea><div class="cbtns"><button class="pri" data-c="send" title="Enviar (Enter)">Enviar ➤</button><button data-c="esc" title="Enviar Esc: interrompe a IA / volta">Esc</button><button data-c="int" title="Enviar Ctrl+C">^C</button></div></div></div></div><i class="rz rz-e" data-rz="e" title="Arraste para alargar"></i><i class="rz rz-s" data-rz="s" title="Arraste para aumentar a altura"></i><i class="rz rz-se" data-rz="se" title="Arraste para redimensionar"></i>`
  const dot = el.querySelector('.st') as HTMLElement, title = el.querySelector('.title') as HTMLElement
  const sel = el.querySelector('select') as HTMLSelectElement
  title.textContent = info.name
  ;(el.querySelector('.bypass') as HTMLElement).hidden = !info.bypass
  canvas.appendChild(el)

  const term = new Terminal({
    fontFamily: '"JetBrains Mono","Fira Code","DejaVu Sans Mono",monospace', fontSize: Math.max(5, BASE_FONT * fontScale * zoom), cursorBlink: true, scrollback: 5000, allowProposedApi: true,
    theme: { background: '#0b0d12', foreground: '#d7dce6', cursor: '#a78bfa', selectionBackground: '#3b3566' },
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(el.querySelector('.body') as HTMLElement)
  try { const g = new WebglAddon(); g.onContextLoss(() => g.dispose()); term.loadAddon(g) } catch {}
  term.attachCustomKeyEventHandler(e => !(e.ctrlKey && ['k', 'b', '=', '+', '-', '0', '_'].includes(e.key.toLowerCase())))

  const box = layout[info.id] || defaultBox(info)
  const w = { info, el, dot, title, sel, box, term, fit, state: info.state, ws: null as unknown as WebSocket } as Win
  wins.set(info.id, w)
  layout[info.id] = box
  fillSelect(w); connect(w)
  term.onData(hardenInput(term, el.querySelector('.body') as HTMLElement, d => { if (w.ws.readyState === 1) w.ws.send(enc.encode(d)) }))
  term.onResize(() => w.ws.readyState === 1 && w.ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows })))
  place(w); focus(w); setState(w, info.state); drawLinks(); stats(); if (booted) ensureNoOverlap()

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
  el.querySelector('[data-a=size]')!.addEventListener('click', () => cycleSize(w))
  el.querySelectorAll<HTMLElement>('.rz').forEach(h => h.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation(); focus(w)
    const dir = h.dataset.rz!, sx = e.clientX, sy = e.clientY, ow = w.box.w, oh = w.box.h
    h.setPointerCapture(e.pointerId)
    const mv = (m: PointerEvent) => {
      if (dir.includes('e')) w.box.w = Math.max(MINW, ow + (m.clientX - sx) / zoom)
      if (dir.includes('s')) w.box.h = Math.max(MINH, oh + (m.clientY - sy) / zoom)
      place(w); drawLinks()
    }
    const up = () => { h.removeEventListener('pointermove', mv); h.removeEventListener('pointerup', up); layout[info.id] = w.box; save(); refit(w) }
    h.addEventListener('pointermove', mv); h.addEventListener('pointerup', up)
  }))
  el.querySelector('[data-a=close]')!.addEventListener('click', () => closeWin(w))
  el.querySelector('[data-a=clear]')!.addEventListener('click', () => clearCtx(w))
  sel.addEventListener('change', () => switchProv(w, sel.value))
  el.querySelector('[data-a=theme]')!.addEventListener('click', () => pickTheme(w))
  el.querySelector('.tag.theme')!.addEventListener('click', () => pickTheme(w))
  styleWin(w); setupChat(w)
  term.focus(); renderDrawer()
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
  w.ws.onclose = null; clearTimeout(w.retry); w.ws.close()
  w.info = info; (w.el.querySelector('.bypass') as HTMLElement).hidden = !info.bypass; w.term.reset(); fillSelect(w); setState(w, info.state); connect(w); stats()
  toast(`🔁 ${info.name} agora usa ${provName(info.provider)}`)
}

const MINW = 260, MINH = 140, SIZES: [number, number][] = [[480, 320], [720, 480], [1000, 640]]
// Move o fundo (pan) o mínimo necessário para a janela inteira ficar visível na área do canvas.
function revealWin(w: Win) {
  const l = w.box.x * zoom + pan.x, t = w.box.y * zoom + pan.y, r = l + w.box.w * zoom, b = t + w.box.h * zoom, m = 16
  let dx = 0, dy = 0
  if (r > vw() - m) dx = vw() - m - r
  if (l + dx < m) dx = m - l
  if (b > vh() - m) dy = vh() - m - b
  if (t + dy < m) dy = m - t
  if (dx || dy) { pan = { x: pan.x + dx, y: pan.y + dy }; applyPan(); save() }
}
function cycleSize(w: Win) {
  w.el.classList.remove('max')
  const i = SIZES.findIndex(([sw]) => sw > w.box.w + 8)
  const [nw, nh] = SIZES[i < 0 ? 0 : i]
  w.box.w = nw; w.box.h = nh; layout[w.info.id] = w.box; save(); place(w); drawLinks(); revealWin(w)
  setTimeout(() => refit(w), 30)
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
  w.ws.onclose = null; clearTimeout(w.retry); clearInterval(w.poll); w.ws.close(); w.term.dispose(); w.el.remove(); wins.delete(id); delete layout[id]; save(); drawLinks(); stats(); renderDrawer()
}

// ---------- estados / avisos ----------
function setState(w: Win, s: string) { w.state = s; w.dot.className = 'st ' + s; w.dot.title = s; renderDrawer() }
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
    else if (m.e === 'updated') applyUpdate(m.term)
    else if (m.e === 'clear_phase') { const w = wins.get(m.id); if (w) w.el.classList.toggle('busy', !['done', 'error'].includes(m.phase)); toast(m.msg) }
    else if (m.e === 'removed') dropWin(m.id)
    else if (m.e === 'exit') { const w = wins.get(m.id); if (w) { setState(w, 'exited'); stats() } }
    else if (m.e === 'states') {
      for (const s of m.states) {
        const w = wins.get(s.id); if (!w || w.state === 'exited') continue
        // Aviso só quando houve trabalho de verdade (>= 8s), o silêncio se confirmou (>= 6s) e você não está olhando para o chat.
        if (s.state === 'working') { if (!w.workSince) w.workSince = Date.now(); w.notified = false }
        else if (s.state === 'idle' && w.workSince && !w.notified && (s.idle_ms ?? 0) >= 6000) {
          const worked = Date.now() - w.workSince - (s.idle_ms ?? 0)
          w.notified = true; w.workSince = undefined
          const watching = document.hasFocus() && w.el.classList.contains('focus')
          if (worked >= 8000 && w.info.kind !== 'shell' && !watching) toast(`✔ ${w.info.name} terminou de trabalhar`)
        }
        if (w.state !== s.state) setState(w, s.state)
      }
      stats(); drawLinks()
    }
  }
  ws.onclose = () => setTimeout(connectEvents, 1500)
  ws.onopen = () => { if (booted) resync() }
}
let booted = false
async function resync() {
  try {
    const list: Info[] = await api('/api/terms'), ids = new Set(list.map(i => i.id))
    list.forEach(addWin); [...wins.keys()].forEach(id => { if (!ids.has(id)) dropWin(id) })
  } catch {}
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
// ---------- temas (grupos) ----------
const themeColor = (t: string) => { let h = 0; for (const c of t) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 70% 62%)` }
const themes = () => [...new Set([...wins.values()].map(w => w.info.theme || '').filter(Boolean))].sort((a, b) => a.localeCompare(b))
// ---------- visão de chat ----------
// A tela do terminal (histórico + tela atual) é lida do servidor e convertida em mensagens: heurística para a
// saída do Claude Code / Codex (marcadores ❯ > › do usuário, ● • da IA, ⎿ └ de ferramentas, caixas e rodapés ignorados).
type Msg = { role: 'user' | 'ai' | 'tool' | 'raw'; text: string; out?: string }
type Perm = { question: string; options: { key: string; label: string; enter: boolean }[] }
const BOXLINE = /^[\s╭╮╰╯─━═│┃┌┐└┘├┤┬┴┼╌╍┄┅]*$/
const TOOLHEAD = /^(?:[A-Z][A-Za-z]+\(|(?:Ran|Explored|Edited|Added|Read|Searched|Updated|Called|Listed|Wrote|Created|Deleted)\b)/
const isFooter = (l: string) => /\? for shortcuts|bypass permissions|auto-accept edits|shift\+tab to|ctrl\+[a-z] to|Context left|\/help for help|accept edits on|plan mode on/i.test(l)
const isStatus = (l: string) => /esc to interrupt|^\s*[✻✢✶✳✽]\s+\S/.test(l)
function parseChat(raw: string): { msgs: Msg[]; status: string; perm?: Perm } {
  let lines = raw.split('\n').map(l => { const m = l.match(/^\s*│ ?(.*?) ?│\s*$/); return (m ? m[1] : l.replace(/^\s*│ ?/, '')).replace(/\s+$/, '') })
  // pedido de confirmação ativo (nas últimas linhas)?
  let perm: Perm | undefined
  const from = Math.max(0, lines.length - 16)
  for (let i = from; i < lines.length && !perm; i++) {
    if (!/(Do you want|Would you like|Deseja|Permitir|Allow |proceed\?|\(y\/n\)|\[y\/n\]|\[Y\/n\]|\[y\/N\])/i.test(lines[i])) continue
    const options: Perm['options'] = []
    for (const l of lines.slice(i + 1)) { const m = l.match(/^\s*[❯›>]?\s*(\d)[.)]\s+(.+)$/); if (m) options.push({ key: m[1], label: m[2], enter: false }) }
    if (!options.length && /\((?:y\/n|Y\/n|y\/N)\)|\[(?:y\/n|Y\/n|y\/N)\]/i.test(lines[i])) options.push({ key: 'y', label: 'Sim (y)', enter: true }, { key: 'n', label: 'Não (n)', enter: true })
    if (options.length) { perm = { question: lines[i].trim(), options }; lines = lines.slice(0, i) }
  }
  let status = ''; const msgs: Msg[] = []; let cur = null as Msg | null; let blank = false
  const push = (role: Msg['role'], text: string, out?: string) => { cur = { role, text, out }; msgs.push(cur); blank = false }
  for (const l of lines) {
    if (!l.trim()) { blank = true; continue }
    if (BOXLINE.test(l) || isFooter(l)) continue
    if (isStatus(l)) { status = l.trim().replace(/^[✻✢✶✳✽]\s*/, ''); continue }
    let m: RegExpMatchArray | null
    if ((m = l.match(/^\s{0,2}[>❯›](?:\s(.*))?$/))) { const t = (m[1] || '').trim(); if (!t) { cur = null; continue } push('user', t); continue }
    if ((m = l.match(/^\s{0,2}[●⏺•]\s+(.*)$/))) { push(TOOLHEAD.test(m[1]) ? 'tool' : 'ai', m[1]); continue }
    if ((m = l.match(/^\s*[⎿└├]\s*(.*)$/))) {
      if (cur?.role === 'tool') cur.out = (cur.out ? cur.out + '\n' : '') + m[1]; else push('tool', '', m[1])
      blank = false; continue
    }
    const ind = l.match(/^\s*/)![0].length
    if (cur?.role === 'user' && ind >= 2 && !blank) { cur.text += '\n' + l.trim(); continue }
    if (cur?.role === 'ai') { cur.text += (blank ? '\n\n' : '\n') + l.replace(/^ {1,2}/, ''); blank = false; continue }
    if (cur?.role === 'tool' && !blank && ind >= 3) { cur.out = (cur.out ? cur.out + '\n' : '') + l.trim(); continue }
    if (cur?.role === 'raw') cur.text += (blank ? '\n\n' : '\n') + l; else push('raw', l)
    blank = false
  }
  return { msgs: msgs.filter(x => x.text.trim() || x.out), status, perm }
}
const escH = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
const inlineMd = (t: string) => escH(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
function codeBlock(p: string) {
  const nl = p.indexOf('\n'), head = nl >= 0 ? p.slice(0, nl).trim() : ''
  const lang = /^[\w+#.-]{1,16}$/.test(head) ? head : '', body = lang ? p.slice(nl + 1) : p.replace(/^\n/, '')
  return `<div class="code"><div class="ch"><span>${escH(lang || 'código')}</span><button data-copy>Copiar</button></div><pre>${escH(body.replace(/\n$/, ''))}</pre></div>`
}
function proseMd(p: string) {
  const out: string[] = []; let para: string[] = [], list: string[] = [], lt = 'ul', pre: string[] = []
  const fP = () => { if (para.length) { out.push('<p>' + inlineMd(para.join(' ')) + '</p>'); para = [] } }
  const fL = () => { if (list.length) { out.push(`<${lt}>` + list.map(x => '<li>' + inlineMd(x) + '</li>').join('') + `</${lt}>`); list = [] } }
  const fR = () => { if (pre.length) { out.push('<pre class="tbl">' + escH(pre.join('\n')) + '</pre>'); pre = [] } }
  const all = () => { fP(); fL(); fR() }
  for (const l of p.split('\n')) {
    let m: RegExpMatchArray | null
    if (!l.trim()) { all(); continue }
    if ((m = l.match(/^\s*#{1,4}\s+(.*)/))) { all(); out.push(`<h4>${inlineMd(m[1])}</h4>`); continue }
    if ((m = l.match(/^\s*[-*•]\s+(.*)/))) { fP(); fR(); if (lt !== 'ul') fL(); lt = 'ul'; list.push(m[1]); continue }
    if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) { fP(); fR(); if (lt !== 'ol') fL(); lt = 'ol'; list.push(m[1]); continue }
    if (/^\s*[|┌├└│]/.test(l) || /^ {4,}\S/.test(l)) { fP(); fL(); pre.push(l); continue }
    if (list.length && /^\s{2,}\S/.test(l)) { list[list.length - 1] += ' ' + l.trim(); continue }
    fL(); fR(); para.push(l.trim())
  }
  all(); return out.join('')
}
const mdHtml = (src: string) => src.split('```').map((p, i) => i % 2 ? codeBlock(p) : proseMd(p)).join('')
const copyText = (t: string) => { try { navigator.clipboard.writeText(t).catch(() => legacyCopy(t)) } catch { legacyCopy(t) } }
const legacyCopy = (t: string) => { const a = document.createElement('textarea'); a.value = t; document.body.appendChild(a); a.select(); try { document.execCommand('copy') } catch {} a.remove() }

function setupChat(w: Win) {
  const el = w.el, box = el.querySelector('.msgs') as HTMLElement, ta = el.querySelector('.chatv textarea') as HTMLTextAreaElement
  const btn = el.querySelector('[data-a=view]') as HTMLButtonElement, jump = el.querySelector('.jump') as HTMLButtonElement, permEl = el.querySelector('.perm') as HTMLElement
  const opened = new Set<number>(); let lastRaw = '\u0000', stick = true
  const sendRaw = (text: string, enter: boolean) => api(`/api/terms/${w.info.id}/input`, { method: 'POST', body: JSON.stringify({ text, enter }) }).then(() => setTimeout(refresh, 250)).catch(e => toast('Erro: ' + e))
  const render = (raw: string) => {
    const { msgs, status, perm } = parseChat(raw), working = w.state === 'working' || !!status
    const dialog = msgs.some(m => m.role !== 'raw')
    let html = ''
    if (!msgs.length && !working) html = '<div class="empty">Sem mensagens ainda. Escreva abaixo para começar.</div>'
    else if (!dialog) html = `<div class="m r"><pre>${escH(msgs.map(m => m.text).join('\n\n'))}</pre></div>`
    else msgs.forEach((m, i) => {
      if (m.role === 'user') html += `<div class="m u"><div class="b">${mdHtml(m.text)}</div></div>`
      else if (m.role === 'ai') html += `<div class="m a"><div class="av" title="${escH(provName(w.info.provider))}">${escH(provName(w.info.provider).slice(0, 1).toUpperCase())}</div><div class="b">${mdHtml(m.text)}<button class="cp" data-copymsg="${i}" title="Copiar mensagem">⧉</button></div></div>`
      else if (m.role === 'tool') {
        const n = m.out ? m.out.split('\n').length : 0
        html += m.out
          ? `<div class="m t"><details data-k="${i}"${opened.has(i) ? ' open' : ''}><summary><span class="ti">⚙</span><span class="tn">${escH(m.text || 'resultado')}</span><span class="tc">${n} linha${n > 1 ? 's' : ''}</span></summary><pre>${escH(m.out)}</pre></details></div>`
          : `<div class="m t"><div class="tr"><span class="ti">⚙</span><span class="tn">${escH(m.text)}</span></div></div>`
      } else html += `<div class="m r"><pre>${escH(m.text)}</pre></div>`
    })
    if (working && dialog) html += `<div class="m a"><div class="av">${escH(provName(w.info.provider).slice(0, 1).toUpperCase())}</div><div class="b typing"><i></i><i></i><i></i><span>${escH(status || 'trabalhando…')}</span></div></div>`
    const prevTop = box.scrollTop
    box.innerHTML = html; (box as any)._msgs = msgs
    box.scrollTop = stick ? box.scrollHeight : prevTop
    jump.hidden = stick || box.scrollHeight - box.scrollTop - box.clientHeight < 30
    if (perm) {
      permEl.hidden = false
      permEl.innerHTML = `<div class="pq">⚠ ${escH(perm.question)}</div><div class="po">${perm.options.map((o, i) => `<button data-o="${i}" class="${i === 0 ? 'pri' : ''}">${escH(o.key.length === 1 && /\d/.test(o.key) ? o.key + '. ' : '')}${escH(o.label.slice(0, 60))}</button>`).join('')}<button data-esc>Esc</button></div>`
      ;(permEl as any)._perm = perm
    } else { permEl.hidden = true; permEl.innerHTML = '' }
  }
  const refresh = async () => {
    try {
      const r = await api(`/api/terms/${w.info.id}/screen?full=1`)
      const key = r.text + '|' + w.state
      if (key !== lastRaw) { lastRaw = key; render(r.text) }
    } catch {}
  }
  const apply = (chat: boolean) => {
    el.classList.toggle('chat', chat); btn.textContent = chat ? '🖥' : '💬'
    clearInterval(w.poll)
    if (chat) { lastRaw = '\u0000'; stick = true; refresh(); w.poll = window.setInterval(refresh, 700); ta.focus() } else { setTimeout(() => { refit(w); w.term.focus() }, 30) }
    try { const v = JSON.parse(localStorage.getItem('orq.view') || '{}'); v[w.info.id] = chat ? 'chat' : 'term'; localStorage.setItem('orq.view', JSON.stringify(v)) } catch {}
  }
  const send = async () => {
    const t = ta.value; if (!t.trim()) return
    ta.value = ''; grow(); stick = true
    try { await api(`/api/terms/${w.info.id}/input`, { method: 'POST', body: JSON.stringify({ text: t, enter: true }) }); setTimeout(refresh, 300) } catch (e) { toast('Erro: ' + e); ta.value = t; grow() }
  }
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(160, Math.max(40, ta.scrollHeight)) + 'px' }
  ta.addEventListener('input', grow)
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send() } })
  el.querySelector('[data-c=send]')!.addEventListener('click', send)
  el.querySelector('[data-c=esc]')!.addEventListener('click', () => sendRaw('\x1b', false))
  el.querySelector('[data-c=int]')!.addEventListener('click', () => sendRaw('\x03', false))
  box.addEventListener('scroll', () => { stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40; if (stick) jump.hidden = true })
  jump.addEventListener('click', () => { stick = true; box.scrollTop = box.scrollHeight; jump.hidden = true })
  box.addEventListener('toggle', e => { const d = e.target as HTMLElement; if (d.tagName === 'DETAILS') { const k = Number(d.dataset.k); (d as HTMLDetailsElement).open ? opened.add(k) : opened.delete(k) } }, true)
  box.addEventListener('click', e => {
    const t = e.target as HTMLElement
    const c = t.closest<HTMLElement>('[data-copy]'); if (c) { copyText(c.closest('.code')!.querySelector('pre')!.textContent || ''); c.textContent = 'Copiado ✔'; setTimeout(() => { c.textContent = 'Copiar' }, 1200); return }
    const m = t.closest<HTMLElement>('[data-copymsg]'); if (m) copyText(((box as any)._msgs as Msg[])[Number(m.dataset.copymsg)].text)
  })
  permEl.addEventListener('click', e => {
    const t = e.target as HTMLElement, o = t.closest<HTMLElement>('[data-o]'), perm: Perm = (permEl as any)._perm
    if (o) { const op = perm.options[Number(o.dataset.o)]; sendRaw(op.key, op.enter) } else if (t.closest('[data-esc]')) sendRaw('\x1b', false)
  })
  btn.addEventListener('click', () => apply(!el.classList.contains('chat')))
  try { if (JSON.parse(localStorage.getItem('orq.view') || '{}')[w.info.id] === 'chat') apply(true) } catch {}
}
function styleWin(w: Win) {
  const t = w.info.theme || ''
  w.el.dataset.theme = t
  if (t) w.el.style.setProperty('--gc', themeColor(t)); else w.el.style.removeProperty('--gc')
  const tag = w.el.querySelector('.tag.theme') as HTMLElement
  tag.hidden = !t; tag.textContent = t
}
const groupEls = new Map<string, HTMLElement>()
const PAD = 22, LABEL = 18
function drawGroups() {
  const by = new Map<string, Win[]>()
  wins.forEach(w => { const t = w.info.kind === 'orchestrator' ? '' : w.info.theme; if (t && !w.el.classList.contains('max')) (by.get(t) || by.set(t, []).get(t)!).push(w) })
  groupEls.forEach((el, t) => { if (!by.has(t)) { el.remove(); groupEls.delete(t) } })
  by.forEach((ws, t) => {
    let el = groupEls.get(t)
    if (!el) {
      el = document.createElement('div'); el.className = 'grp'; el.innerHTML = '<span class="gl" title="Arraste para mover o grupo todo; duplo clique renomeia o tema"></span>'
      canvas.prepend(el); groupEls.set(t, el)
      const lab = el.querySelector('.gl') as HTMLElement
      lab.addEventListener('pointerdown', e => dragGroup(e, t, lab))
      lab.addEventListener('dblclick', () => renameTheme(t))
    }
    const x0 = Math.min(...ws.map(w => w.box.x)) - PAD, y0 = Math.min(...ws.map(w => w.box.y)) - PAD - LABEL
    const x1 = Math.max(...ws.map(w => w.box.x + w.box.w)) + PAD, y1 = Math.max(...ws.map(w => w.box.y + w.box.h)) + PAD
    const s = el.style
    s.left = x0 * zoom + 'px'; s.top = y0 * zoom + 'px'; s.width = (x1 - x0) * zoom + 'px'; s.height = (y1 - y0) * zoom + 'px'
    s.setProperty('--gc', themeColor(t)); (el.firstChild as HTMLElement).textContent = `${t} · ${ws.length}`
  })
}
function dragGroup(e: PointerEvent, theme: string, lab: HTMLElement) {
  e.preventDefault(); lab.setPointerCapture(e.pointerId)
  const members = [...wins.values()].filter(w => w.info.theme === theme), sx = e.clientX, sy = e.clientY, o = members.map(w => ({ x: w.box.x, y: w.box.y }))
  const mv = (m: PointerEvent) => { members.forEach((w, i) => { w.box.x = o[i].x + (m.clientX - sx) / zoom; w.box.y = o[i].y + (m.clientY - sy) / zoom; place(w) }); drawLinks() }
  const up = () => { lab.removeEventListener('pointermove', mv); lab.removeEventListener('pointerup', up); members.forEach(w => { layout[w.info.id] = w.box }); save() }
  lab.addEventListener('pointermove', mv); lab.addEventListener('pointerup', up)
}
async function setTheme(w: Win, theme: string) {
  try { await api(`/api/terms/${w.info.id}`, { method: 'PATCH', body: JSON.stringify({ theme }) }) } catch (e) { toast('Erro: ' + e) }
}
function applyUpdate(info: Info) {
  const w = wins.get(info.id); if (!w) return
  const changed = w.info.theme !== info.theme
  w.info = info; styleWin(w); if (changed) { drawLinks(); renderDrawer(); ensureNoOverlap() }
}
async function renameTheme(old: string) {
  const n = prompt(`Novo nome para o tema "${old}" (vazio = desfazer o grupo):`, old); if (n === null) return
  await Promise.all([...wins.values()].filter(w => w.info.theme === old).map(w => setTheme(w, n)))
}
function pickTheme(w: Win) {
  openModal('🏷 Tema do chat · ' + w.info.name)
  const ex = themes()
  mBody.innerHTML = `<div class="hint">Chats com o mesmo tema ficam juntos dentro de um contorno colorido. Deixe vazio para tirar do grupo.</div>
  <div class="row"><input id="th-in" list="th-list" placeholder="Ex.: login, relatório, bug 123…" maxlength="40" value="${esc(w.info.theme || '')}"/><button id="th-ok" class="pri">Salvar</button></div>
  <datalist id="th-list">${ex.map(t => `<option value="${esc(t)}">`).join('')}</datalist>
  <div class="chips">${ex.map(t => `<span class="chip" data-t="${esc(t)}" style="border-color:${themeColor(t)};color:${themeColor(t)}">${esc(t)}</span>`).join('')}</div>`
  const inp = $('#th-in') as HTMLInputElement; inp.focus(); inp.select()
  const ok = async () => { await setTheme(w, inp.value.trim()); closeModal() }
  $('#th-ok').onclick = ok; inp.onkeydown = e => { if (e.key === 'Enter') ok() }
  mBody.querySelectorAll<HTMLElement>('.chip').forEach(c => c.onclick = () => { inp.value = c.dataset.t!; ok() })
}
// ---------- organizar: orquestrador no centro, temas em volta, nada sobreposto ----------
type R = { x: number; y: number; w: number; h: number }
const hit = (a: R, b: R, g = 0) => a.x < b.x + b.w + g && b.x < a.x + a.w + g && a.y < b.y + b.h + g && b.y < a.y + a.h + g
const outlineOf = (ws: Win[]): R => {
  const x0 = Math.min(...ws.map(w => w.box.x)) - PAD, y0 = Math.min(...ws.map(w => w.box.y)) - PAD - LABEL
  return { x: x0, y: y0, w: Math.max(...ws.map(w => w.box.x + w.box.w)) + PAD - x0, h: Math.max(...ws.map(w => w.box.y + w.box.h)) + PAD - y0 }
}
// Unidades visuais: contorno de cada tema (que é o que o usuário enxerga) + cada janela sem tema + orquestrador.
function visualUnits(): { key: string; r: R }[] {
  const u: { key: string; r: R }[] = [], by = new Map<string, Win[]>()
  wins.forEach(w => {
    if (w.el.classList.contains('max')) return
    const t = w.info.kind === 'orchestrator' ? '' : w.info.theme || ''
    if (t) (by.get(t) || by.set(t, []).get(t)!).push(w); else u.push({ key: w.info.id, r: { ...w.box } })
  })
  by.forEach((ws, t) => u.push({ key: 'theme:' + t, r: outlineOf(ws) }))
  return u
}
function overlapping(): boolean {
  const u = visualUnits()
  for (let i = 0; i < u.length; i++) for (let j = i + 1; j < u.length; j++) if (hit(u[i].r, u[j].r)) return true
  return false
}
function arrange(fit = true) {
  const orch = orchestrator(), list = [...wins.values()].filter(w => w.info.kind !== 'orchestrator')
  if (!orch && !list.length) return
  wins.forEach(w => w.el.classList.remove('max'))
  const IN = 16, GAP = 40
  type Blk = { ws: Win[]; cols: number; cw: number; ch: number; w: number; h: number; themed: boolean; x?: number; y?: number }
  const mk = (ws: Win[], themed: boolean): Blk => {
    const cols = Math.min(ws.length, Math.ceil(Math.sqrt(ws.length))), rows = Math.ceil(ws.length / cols)
    const cw = Math.max(...ws.map(w => w.box.w)), ch = Math.max(...ws.map(w => w.box.h))
    const pw = themed ? 2 * PAD : 0, ph = themed ? 2 * PAD + LABEL : 0
    return { ws, cols, cw, ch, themed, w: cols * cw + (cols - 1) * IN + pw, h: rows * ch + (rows - 1) * IN + ph }
  }
  const blocks: Blk[] = themes().map(t => mk(list.filter(w => w.info.theme === t), true)).filter(b => b.ws.length)
  list.filter(w => !w.info.theme).forEach(w => blocks.push(mk([w], false)))
  blocks.sort((a, b) => b.w * b.h - a.w * a.h)
  // o orquestrador fica onde está; tudo se organiza em volta do centro dele
  const o: R = orch ? { ...orch.box } : { x: 0, y: 0, w: 0, h: 0 }
  const ox = o.x + o.w / 2, oy = o.y + o.h / 2
  const placed: R[] = orch ? [o] : []
  const angles = Array.from({ length: 16 }, (_, i) => [0, 180, 90, 270, 45, 225, 135, 315, 22.5, 202.5, 112.5, 292.5, 67.5, 247.5, 157.5, 337.5][i] * Math.PI / 180)
  const bbox = (rs: R[]) => {
    const x0 = Math.min(...rs.map(r => r.x)), y0 = Math.min(...rs.map(r => r.y)), x1 = Math.max(...rs.map(r => r.x + r.w)), y1 = Math.max(...rs.map(r => r.y + r.h))
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 }
  }
  const target = vw() / vh()
  blocks.forEach(b => {
    let best: { r: R; score: number } | null = null
    for (const a of angles) for (let rad = 0; rad < 8000; rad += 10) {
      const cx = ox + Math.cos(a) * rad, cy = oy + Math.sin(a) * rad, r: R = { x: cx - b.w / 2, y: cy - b.h / 2, w: b.w, h: b.h }
      if (placed.some(p => hit(r, p, GAP))) continue
      const c = bbox([...placed, r]), score = Math.hypot(c.cx - ox, c.cy - oy) * 2 + rad * 0.5 + Math.abs(Math.log((c.w / c.h) / target)) * 400
      if (!best || score < best.score) best = { r, score }
      break
    }
    const r = best!.r; placed.push(r); b.x = r.x; b.y = r.y
  })
  blocks.forEach(b => {
    const px = b.themed ? PAD : 0, py = b.themed ? PAD + LABEL : 0
    b.ws.forEach((w, i) => {
      w.box = { x: b.x! + px + (i % b.cols) * (b.cw + IN), y: b.y! + py + Math.floor(i / b.cols) * (b.ch + IN), w: b.cw, h: b.ch }
      layout[w.info.id] = w.box
    })
  })
  applyZoom()
  if (fit) fitAll(); else { drawLinks(); save() }
}
// Depois de criar/mudar tema de um chat, se algo ficou sobreposto, reorganiza sozinho (com aviso).
let ovTimer = 0
function ensureNoOverlap() {
  clearTimeout(ovTimer)
  ovTimer = window.setTimeout(() => { if (overlapping()) { arrange(false); toast('🗂 Reorganizei os chats para nenhum tema ficar sobreposto') } }, 300)
}

function setFont(f: number) {
  fontScale = Math.min(2.5, Math.max(0.6, Math.round(f * 10) / 10))
  $('#flabel').textContent = Math.round(fontScale * 100) + '%'
  wins.forEach(w => { w.term.options.fontSize = Math.max(5, BASE_FONT * fontScale * zoom) })
  requestAnimationFrame(() => wins.forEach(refit)); save()
}
function toggleDrawer(force?: boolean) {
  const on = force ?? !document.body.classList.contains('dr-open')
  document.body.classList.toggle('dr-open', on)
  try { localStorage.setItem('orq.drawer', on ? '1' : '0') } catch {}
  setTimeout(() => { placeMaxed(); wins.forEach(refit); drawLinks() }, 200)
}
function goTo(w: Win) { w.el.classList.remove('max'); place(w); centerOn(w); focus(w); w.term.focus(); renderDrawer() }
let dirs: { recent: { path: string; last: number; count: number }[]; favorites: string[]; workspace: string } = { recent: [], favorites: [], workspace: '' }
const loadDirs = async () => { try { dirs = await api('/api/dirs'); renderDrawer() } catch {} }
const shortPath = (p: string) => p.replace(/^\/home\/[^/]+/, '~')
function renderDrawer() {
  const list = [...wins.values()]
  const orch = list.filter(w => w.info.kind === 'orchestrator'), rest = list.filter(w => w.info.kind !== 'orchestrator')
  const row = (w: Win, cls: string) => `<div class="dr-item ${cls} ${w.el.classList.contains('focus') ? 'focus' : ''}" data-id="${w.info.id}"><span class="st ${w.state}"></span><div class="nm">${esc(w.info.name)}<small>${esc(provName(w.info.provider))} · ${esc(shortPath(w.info.cwd))}</small></div><button class="x" data-x="${w.info.id}" title="Fechar">✕</button></div>`
  const sect = (t: string) => { const m = rest.filter(w => (w.info.theme || '') === t); return m.length ? (t ? `<div class="dr-theme" style="--gc:${themeColor(t)}">${esc(t)} (${m.length})</div>` : (themes().length ? '<div class="dr-theme" style="--gc:var(--dim)">Sem tema</div>' : '')) + m.map(w => row(w, orch.length ? 'child' : '')).join('') : '' }
  $('#dr-chats').innerHTML = `<div class="dr-h"><span>Chats (${list.length})</span></div>` + (list.length ? orch.map(w => row(w, 'orch')).join('') + [...themes(), ''].map(sect).join('') : '<div class="dr-empty">Nenhum chat aberto.</div>')
  const favs = dirs.favorites, rec = dirs.recent.filter(r => !favs.includes(r.path)).slice(0, 10)
  const pr = (p: string, star: boolean) => `<div class="dr-item" data-dir="${esc(p)}" title="Novo chat em ${esc(p)}"><div class="nm">${star ? '★ ' : ''}${esc(shortPath(p).split('/').filter(Boolean).pop() || p)}<small>${esc(shortPath(p))}</small></div></div>`
  $('#dr-projects').innerHTML = `<div class="dr-h"><span>Projetos</span></div>` + (favs.length || rec.length ? favs.map(p => pr(p, true)).join('') + rec.map(r => pr(r.path, false)).join('') : '<div class="dr-empty">O histórico aparece aqui.</div>')
}
$('#drawer').addEventListener('click', e => {
  const t = e.target as HTMLElement
  const x = t.closest<HTMLElement>('[data-x]'); if (x) { const w = wins.get(x.dataset.x!); if (w) closeWin(w); return }
  const d = t.closest<HTMLElement>('[data-dir]'); if (d) { openNewIn(d.dataset.dir); return }
  const c = t.closest<HTMLElement>('[data-id]'); if (c) { const w = wins.get(c.dataset.id!); if (w) goTo(w) }
})
async function openNewIn(prefill?: string) {
  await loadDirs()
  openModal('📁 Novo chat em uma pasta')
  const opts = providers.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')
  const projRow = (p: string) => `<div class="proj" data-p="${esc(p)}"><span title="${esc(p)}">${esc(shortPath(p))}</span><button data-fav="${esc(p)}" class="${dirs.favorites.includes(p) ? 'on' : ''}" title="Favoritar">★</button><button data-forget="${esc(p)}" title="Remover do histórico">✕</button></div>`
  const all = [...dirs.favorites, ...dirs.recent.map(r => r.path).filter(p => !dirs.favorites.includes(p))]
  mBody.innerHTML = `<div class="row"><select id="nd-prov">${opts}</select><input id="nd-path" placeholder="Pasta de início (vazio = pasta segura padrão)" value="${esc(prefill || '')}" spellcheck="false"/></div>
  <div class="row"><input id="nd-theme" list="nd-themes" placeholder="Tema (opcional) — agrupa com chats do mesmo assunto" maxlength="40"/><datalist id="nd-themes">${themes().map(t => `<option value="${esc(t)}">`).join('')}</datalist></div>
  <label class="hint"><input type="checkbox" id="nd-trust"/> Confiar nesta pasta no Claude Code (evita o pedido de confiança; só marque para pastas suas)</label>
  <div class="hint">Padrão: <code>${esc(dirs.workspace)}</code>. Aceita <code>~</code>.</div>
  <div><button id="nd-go" class="pri">Abrir chat</button> <span id="nd-msg" class="err"></span></div>
  <div class="dr-h"><span>Favoritas e recentes</span></div>
  <div id="nd-list">${all.length ? all.map(projRow).join('') : '<span class="hint">Nenhum projeto ainda.</span>'}</div>`
  const path = $('#nd-path') as HTMLInputElement, sel = $('#nd-prov') as HTMLSelectElement
  sel.value = defaultProvider; path.focus()
  const go = async () => {
    const provider = sel.value
    if (!orchestrator()) { $('#nd-msg').textContent = 'Crie o orquestrador primeiro.'; return }
    try {
      await api('/api/terms', { method: 'POST', body: JSON.stringify({ kind: provider === 'shell' ? 'shell' : 'agent', provider, cwd: path.value.trim(), theme: ($('#nd-theme') as HTMLInputElement).value.trim(), trust: ($('#nd-trust') as HTMLInputElement).checked }) })
      closeModal(); loadDirs()
    } catch (er) { $('#nd-msg').textContent = String((er as Error).message) }
  }
  $('#nd-go').onclick = go
  path.onkeydown = e => { if (e.key === 'Enter') go() }
  $('#nd-list').onclick = async e => {
    const t = e.target as HTMLElement
    const f = t.closest<HTMLElement>('[data-fav]'), r = t.closest<HTMLElement>('[data-forget]')
    if (f) { dirs = await api('/api/dirs', { method: 'POST', body: JSON.stringify({ path: f.dataset.fav, favorite: !dirs.favorites.includes(f.dataset.fav!) }) }); openNewIn(path.value); return }
    if (r) { dirs = await api('/api/dirs', { method: 'POST', body: JSON.stringify({ path: r.dataset.forget, forget: true }) }); openNewIn(path.value); return }
    const p = t.closest<HTMLElement>('[data-p]'); if (p) path.value = p.dataset.p!
  }
}
const zc = () => { const r = viewport.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] as const }
const actions: Record<string, () => void> = {
  orch: () => spawn('orchestrator'), tile: arrange, fit: fitAll, center: () => centerOn(), palette: () => openPalette(),
  zin: () => zoomAt(...zc(), 1.15), zout: () => zoomAt(...zc(), 1 / 1.15), zreset: () => zoomAt(...zc(), 1 / zoom),
  memory: () => openMemory(), config: () => openConfig(),
  group: arrange, drawer: () => toggleDrawer(), newin: () => openNewIn(), fin: () => setFont(fontScale + 0.1), fout: () => setFont(fontScale - 0.1), freset: () => setFont(1),
}
document.querySelector('#bar')!.addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null
  if (!b) return
  if (b.dataset.prov) spawn('agent', b.dataset.prov); else if (b.dataset.act) actions[b.dataset.act]()
})
document.addEventListener('keydown', e => {
  if (!e.ctrlKey) return
  if (e.shiftKey && (e.key === '+' || e.key === '=')) { e.preventDefault(); actions.fin(); return }
  if (e.shiftKey && (e.key === '_' || e.key === '-')) { e.preventDefault(); actions.fout(); return }
  if (!e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); actions.drawer(); return }
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
    { label: 'Organizar (orquestrador no centro, temas em volta)', hint: '▦', run: arrange },
    { label: 'Ajustar tudo à tela', hint: '⤢', run: fitAll },
    { label: 'Centralizar no orquestrador', hint: '⌖', run: () => centerOn() },
    { label: 'Limpar contexto de todos os agentes', hint: '💾→🧹→↩', run: () => wins.forEach(w => { if (w.info.kind === 'agent') clearCtx(w) }) },
    { label: 'Fechar agentes ociosos', hint: 'limpeza', run: () => wins.forEach(w => { if (w.state === 'idle' && w.info.kind === 'agent') closeWin(w) }) },
    { label: 'Novo chat em uma pasta…', hint: '📁', run: () => openNewIn() },
    { label: 'Alternar lista lateral', hint: 'Ctrl+B', run: () => toggleDrawer() },
    { label: 'Aumentar letra dos terminais', hint: 'A＋', run: () => setFont(fontScale + 0.1) },
    { label: 'Reduzir letra dos terminais', hint: 'A−', run: () => setFont(fontScale - 0.1) },
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
applyPan(); $('#zlabel').textContent = Math.round(zoom * 100) + '%'; $('#flabel').textContent = Math.round(fontScale * 100) + '%'
try { if (localStorage.getItem('orq.drawer') !== '0') document.body.classList.add('dr-open') } catch {}
;(async () => {
  await loadProviders(); loadDirs()
  const list: Info[] = await api('/api/terms')
  list.sort((a, b) => (a.kind === 'orchestrator' ? -1 : 0) - (b.kind === 'orchestrator' ? -1 : 0)).forEach(addWin)
  if (!list.length) toast('Comece pelo ◉ Orquestrador: nenhum chat existe sem ele.')
  connectEvents(); booted = true; stats()
  checkUpdate(); setInterval(() => checkUpdate(), 6 * 3600 * 1000)
})()
