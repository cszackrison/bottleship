#!/usr/bin/env bun
// scmscx.com map database client (reverse-engineered from the site's SPA bundle).
//   bun tools/scmscx.ts search [query] [--players 2-4] [--tileset jungle,ice] [--size 64-128] [--sort relevancy|scenario|filename|timeuploadednew|timeuploadedold|lastmodifiednew|lastmodifiedold]
//                                 [--limit 50] [--details] [--classic] [--no-eud] [--json] [--include broken,outdated,unfinished,nsfw] [--by <uploader>] [--fields scenario,filenames,units,forces,descriptions]
//   bun tools/scmscx.ts info <id>
//   bun tools/scmscx.ts download <id...> [--out dir]  |  download --list tools/scmscx-ums.txt [--out dir]
//   bun tools/scmscx.ts bundle <list> <base.wgb> <out.wgb> [--folder rom/Maps/UMS]   (copy base, add every listed map)
//   bun tools/scmscx.ts fetch [query] [search flags...] --out dir     (search + download every match)
// ver: 59 = original SC, 63 = Brood War (1.00-1.03), 205 = Brood War, 206 = Remastered (won't load in 1.16.1).
import { mkdirSync, existsSync, writeFileSync, readFileSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const API = 'https://scmscx.com/api'
const TILESETS = ['badlands', 'space_platform', 'installation', 'ashworld', 'jungle', 'desert', 'ice', 'twilight']
const TILESET_BY_ID = ['badlands', 'space_platform', 'installation', 'ashworld', 'jungle', 'desert', 'ice', 'twilight']
const FIELDS: Record<string, string> = { units: 'unit_names', forces: 'force_names', filenames: 'file_names', scenario: 'scenario_names', descriptions: 'scenario_descriptions' }
const VER_NAME: Record<number, string> = { 59: 'SC', 63: 'BW-1.03', 205: 'BW', 206: 'SCR' }

type Hit = { id: string, filename: string, scenario_name: string, last_modified: number, uploaded_time: number }
type Info = { meta: { mpq_hash: string, mpq_size: number, downloads: number, views: number, uploaded_by: string }, properties: { ver: number, width: number, height: number, tileset: number, triggers: number, eups: number, get_death_euds: number, set_death_euds: number, trigger_list_reads: number, trigger_list_writes: number }, scenario: string, scenario_description: string, forces: unknown, player_owners: unknown }
type Row = Hit & { filenames: string[], info?: Info }

const { positionals, flags } = parseArgs(process.argv.slice(2))
const cmd = positionals.shift()

const getJson = async <T>(path: string): Promise<T> => { const r = await fetch(API + path); if (!r.ok) throw new Error(`${path} → ${r.status}`); return r.json() as Promise<T> }
const clean = (s: string) => s.replace(/[\x00-\x1f]/g, '').trim()
const range = (v: string | undefined, dflt: [number, number]): [number, number] => { if (!v) return dflt; const [a, b] = v.split('-'); return [Number(a || dflt[0]), Number(b ?? a ?? dflt[1])] }
const isEud = (p: Info['properties']) => p.eups + p.get_death_euds + p.set_death_euds + p.trigger_list_reads + p.trigger_list_writes > 0
const safeName = (s: string) => s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
const CJK = /[\u1100-\u11ff\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/
const nameScore = (f: string, n: number) => n - (CJK.test(f) ? 1000 : 0) - (/_[A-Z0-9]{3}\.sc[mx]$/i.test(f) ? 100 : 0) - (/(\(\d\)|\[\d\])\.sc[mx]$/i.test(f) ? 50 : 0) - (/_/.test(f) && !/ /.test(f) ? 10 : 0)
const bestName = (names: string[]) => { const n = new Map<string, number>(); for (const f of names) n.set(f, (n.get(f) ?? 0) + 1); return [...n].sort((a, b) => nameScore(b[0], b[1]) - nameScore(a[0], a[1]))[0]?.[0] }

function parseArgs(argv: string[]) {
  const positionals: string[] = [], flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { positionals.push(a); continue }
    const [k, v] = a.slice(2).split('=', 2)
    if (v !== undefined) flags[k] = v
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i]
    else flags[k] = 'true'
  }
  return { positionals, flags }
}

function searchParams(offset: number) {
  const p = new URLSearchParams()
  if (flags.sort) p.set('sort', flags.sort)
  const [pmin, pmax] = range(flags.players, [0, 12]); if (pmin !== 0) p.set('minimum_human_players', `${pmin}`); if (pmax !== 12) p.set('maximum_human_players', `${pmax}`)
  const [cmin, cmax] = range(flags.computers, [0, 12]); if (cmin !== 0) p.set('minimum_computer_players', `${cmin}`); if (cmax !== 12) p.set('maximum_computer_players', `${cmax}`)
  const [wmin, wmax] = range(flags.width ?? flags.size, [0, 256]); if (wmin !== 0) p.set('minimum_map_width', `${wmin}`); if (wmax !== 256) p.set('maximum_map_width', `${wmax}`)
  const [hmin, hmax] = range(flags.height ?? flags.size, [0, 256]); if (hmin !== 0) p.set('minimum_map_height', `${hmin}`); if (hmax !== 256) p.set('maximum_map_height', `${hmax}`)
  if (flags.tileset) { const want = new Set(flags.tileset.split(',')); for (const t of TILESETS) if (!want.has(t)) p.set(`tileset_${t}`, 'false') }
  if (flags.fields) { const want = new Set(flags.fields.split(',')); for (const [k, v] of Object.entries(FIELDS)) if (!want.has(k)) p.set(v, 'false') }
  for (const inc of (flags.include ?? '').split(',').filter(Boolean)) p.set(`include_${inc}`, 'true')
  if (flags.by) p.set('uploaded_by', flags.by)
  if (offset) p.set('offset', `${offset}`)
  return p
}

async function search(): Promise<{ total: number, rows: Row[] }> {
  const query = positionals.join(' '), limit = Number(flags.limit ?? 50), needInfo = flags.details || flags.classic || flags['no-eud'] || flags.json
  const byId = new Map<string, Row>(), rows: Row[] = []
  let offset = 0, total = 0
  while (rows.length < limit) {
    const qs = searchParams(offset).toString()
    const page = await getJson<{ maps: Hit[], total_results: number }>(`/uiv2/search${query ? '/' + encodeURIComponent(query) : ''}${qs ? '?' + qs : ''}`)
    total = page.total_results
    if (!page.maps.length) break
    offset += page.maps.length
    const fresh: Row[] = []
    for (const h of page.maps) {
      const seen = byId.get(h.id)
      if (seen) { if (!seen.filenames.includes(h.filename)) seen.filenames.push(h.filename); continue }
      const row = { ...h, filenames: [h.filename] }; byId.set(h.id, row); fresh.push(row)
    }
    if (needInfo) await pool(fresh, 8, async r => { r.info = await getJson<Info>(`/uiv2/map_info/${r.id}`) })
    for (const r of fresh) {
      if (rows.length >= limit) break
      if (flags.classic && r.info!.properties.ver === 206) continue
      if (flags['no-eud'] && isEud(r.info!.properties)) continue
      rows.push(r)
    }
  }
  return { total, rows }
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]) }))
}

function printRow(r: Row) {
  const base = `${r.id}  ${clean(r.scenario_name).padEnd(40).slice(0, 40)}  ${r.filename}`
  if (!r.info) return console.log(base)
  const p = r.info.properties, m = r.info.meta
  console.log(`${base}\n          ${VER_NAME[p.ver] ?? p.ver} ${p.width}x${p.height} ${TILESET_BY_ID[p.tileset % 8]}  trig=${p.triggers}${isEud(p) ? ' EUD' : ''}  dl=${m.downloads} views=${m.views}  ${(m.mpq_size / 1024).toFixed(0)}KB  up=${new Date(r.uploaded_time * 1000).toISOString().slice(0, 10)}`)
}

const readList = (path: string) => readFileSync(path, 'utf8').split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean).map(l => { const [id, ...name] = l.split(/\s+/); return { id, name: name.join(' ') || undefined } })

async function download(id: string, out: string, name?: string) {
  const info = await getJson<Info>(`/uiv2/map_info/${id}`)
  const filename = name ?? bestName((await getJson<{ filename: string }[]>(`/uiv2/filenames2/${id}`)).map(f => f.filename)) ?? `${id}.scx`
  const bytes = new Uint8Array(await (await fetch(`${API}/maps/${info.meta.mpq_hash}`)).arrayBuffer())
  const hash = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
  if (hash !== info.meta.mpq_hash) throw new Error(`${id}: sha256 mismatch`)
  mkdirSync(out, { recursive: true })
  let path = join(out, safeName(filename))
  if (existsSync(path)) path = join(out, `${id}_${safeName(filename)}`)
  writeFileSync(path, bytes)
  console.log(`${id} → ${path} (${bytes.length} bytes, ${VER_NAME[info.properties.ver] ?? info.properties.ver})`)
}

if (cmd === 'search' || cmd === 'fetch') {
  const { total, rows } = await search()
  if (flags.json) console.log(JSON.stringify(rows, null, 2))
  else { console.error(`${total} results (showing ${rows.length} unique maps)`); for (const r of rows) printRow(r) }
  if (cmd === 'fetch') for (const r of rows) await download(r.id, flags.out ?? 'maps').catch(e => console.error(String(e)))
} else if (cmd === 'info') {
  const info = await getJson<Info>(`/uiv2/map_info/${positionals[0]}`)
  const names = await getJson<{ filename: string }[]>(`/uiv2/filenames2/${positionals[0]}`)
  console.log(JSON.stringify({ ...info, scenario: clean(info.scenario), scenario_description: clean(info.scenario_description), filenames: [...new Set(names.map(n => n.filename))], url: `https://scmscx.com/map/${positionals[0]}` }, null, 2))
} else if (cmd === 'download') {
  const items = [...positionals.map(id => ({ id, name: undefined })), ...(flags.list ? readList(flags.list) : [])]
  for (const { id, name } of items) await download(id, flags.out ?? 'maps', name).catch(e => console.error(String(e)))
} else if (cmd === 'bundle') {
  const [list, base, out] = positionals
  if (!list || !base || !out) throw new Error('usage: bundle <list> <base.wgb> <out.wgb> [--folder rom/Maps/UMS]')
  if (resolve(base) === resolve(out)) throw new Error('out.wgb must differ from base.wgb')
  const dir = mkdtempSync(join(tmpdir(), 'scmscx-'))
  try {
    for (const { id, name } of readList(list)) await download(id, dir, name)
    copyFileSync(base, out)
    const proc = Bun.spawnSync(['bun', join(import.meta.dir, 'wgb.ts'), 'add', out, flags.folder ?? 'rom/Maps/UMS', dir], { stdout: 'inherit', stderr: 'inherit' })
    if (proc.exitCode !== 0) throw new Error(`wgb.ts add failed (${proc.exitCode})`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
} else {
  console.log('usage: bun tools/scmscx.ts search|info|download|fetch|bundle ... (see header)')
}
