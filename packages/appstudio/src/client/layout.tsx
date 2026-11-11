import { useEffect, useId, useLayoutEffect, useRef, useState, type DragEvent, type PointerEvent } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { StarterBlockKind, StarterBlockPosition, StarterLayout } from '../shared/protocol.ts'
import { starterBlockPosition, starterColumns, starterRows, validStarterBlockPositions } from '../shared/starter-layout.ts'
import type { namespace } from './copy.ts'
import { StudioIcon } from './icons.tsx'

export const starterBlockKinds = ['heading', 'text', 'image', 'input', 'button', 'list', 'divider'] as const satisfies readonly StarterBlockKind[]
const maxScreens = 8
const maxScreenBlocks = 12
const maxBlocks = 24
const artboardWidth = 396
const rowHeight = 68
const widths = [3, 4, 6, 8, 9, 12]
const directions = [
  { id: 'left', key: 'ArrowLeft', label: 'starterMoveLeft', x: -1, y: 0, angle: -90 },
  { id: 'up', key: 'ArrowUp', label: 'starterMoveUp', x: 0, y: -1, angle: 0 },
  { id: 'down', key: 'ArrowDown', label: 'starterMoveDown', x: 0, y: 1, angle: 180 },
  { id: 'right', key: 'ArrowRight', label: 'starterMoveRight', x: 1, y: 0, angle: 90 },
] as const

type Screen = StarterLayout['screens'][number]
type Block = Screen['blocks'][number]
type PlacedBlock = Block & { position: StarterBlockPosition }
type DragItem = { kind: StarterBlockKind } | { id: string }
type DropPlan = { position: StarterBlockPosition; remaining: PlacedBlock[] }
type Camera = { x: number; y: number; zoom: number }
const initialCamera: Camera = { x: 0, y: 0, zoom: 1 }
type LayoutProps = PropsLocale<typeof namespace> & {
  layout: StarterLayout
  disabled: boolean
  onChange: (value: StarterLayout) => void
}

export function newStarterLayout(title: string): StarterLayout {
  return { screens: [{ id: crypto.randomUUID(), title, blocks: [] }] }
}

export function canGenerateLayout(layout: StarterLayout): boolean {
  return layout.screens.every(screen => screen.title.trim() && validStarterBlockPositions(screen.blocks)) &&
    layout.screens.some(screen => screen.blocks.length > 0)
}

function rowAfter(blocks: readonly PlacedBlock[]): number {
  return Math.max(-1, ...blocks.map(item => item.position.row)) + 1
}

function fits(position: StarterBlockPosition, blocks: readonly PlacedBlock[]): boolean {
  const { row, column, span } = position
  return row >= 0 && row < starterRows && column >= 0 && column + span <= starterColumns &&
    !blocks.some(({ position: other }) => other.row === row &&
      column < other.column + other.span && other.column < column + span)
}

function nextRow(blocks: readonly PlacedBlock[]): number {
  const row = rowAfter(blocks)
  if (row < starterRows) return row
  return Array.from({ length: starterRows }, (_, index) => index)
    .find(index => !blocks.some(item => item.position.row === index)) ?? row
}

function byPosition(a: PlacedBlock, b: PlacedBlock): number {
  return a.position.row - b.position.row || a.position.column - b.position.column
}

function dropAt(
  blocks: PlacedBlock[], source: PlacedBlock | undefined, row: number, column: number, rowFraction: number, columnFraction: number,
): DropPlan | undefined {
  const inRow = blocks.filter(item => item.position.row === row)
  const span = source?.position.span ?? starterColumns
  if (inRow.length && (rowFraction < .17 || rowFraction > .92)) {
    const insertRow = row + Number(rowFraction > .92)
    const remaining = blocks.map(item => item.position.row < insertRow ? item :
      { ...item, position: { ...item.position, row: item.position.row + 1 } })
    if (insertRow < starterRows && rowAfter(remaining) <= starterRows) {
      return { position: { row: insertRow, column: Math.min(column, starterColumns - span), span }, remaining }
    }
  }
  const partCount = inRow.length + 1
  if (partCount >= 2 && partCount <= 4 && (!source || span === starterColumns) &&
      inRow.every((item, index) => item.position.span * inRow.length === starterColumns &&
        item.position.column === index * item.position.span)) {
    const part = columnFraction * inRow.length
    const offset = part - Math.floor(part)
    if (offset < .26 || offset > .74) {
      const insertAt = Math.min(inRow.length, Math.max(0, Math.round(part)))
      const newSpan = starterColumns / partCount
      const remaining = blocks.map(item => {
        const index = inRow.indexOf(item)
        return index < 0 ? item : { ...item, position: { row, column: (index + Number(index >= insertAt)) * newSpan, span: newSpan } }
      })
      return { position: { row, column: insertAt * newSpan, span: newSpan }, remaining }
    }
  }
  const order = Array.from({ length: starterColumns }, (_, index) => index)
    .sort((a, b) => Math.abs(a - column) - Math.abs(b - column))
  for (let size = span; size >= (source ? span : 1); size--) {
    const start = order.find(candidate => fits({ row, column: candidate, span: size }, inRow))
    if (start !== undefined) return { position: { row, column: start, span: size }, remaining: blocks }
  }
  return undefined
}

export function LayoutEditor({ layout, disabled, onChange, t }: LayoutProps) {
  const [screenId, selectScreen] = useState('')
  const [blockId, selectBlock] = useState('')
  const [dropPlan, setDropPlan] = useState<DropPlan>()
  const [announcement, setAnnouncement] = useState('')
  const [camera, setCamera] = useState(initialCamera)
  const [fit, setFit] = useState(1)
  const [panning, setPanning] = useState(false)
  const dragged = useRef<DragItem>()
  const pan = useRef<{ pointer: number; x: number; y: number; camera: Camera }>()
  const board = useRef<HTMLDivElement>(null)
  const grid = useRef<HTMLOListElement>(null)
  const fields = useId()
  const screen = layout.screens.find(item => item.id === screenId) ?? layout.screens[0]!
  const placed: PlacedBlock[] = screen.blocks.map((item, index) => ({ ...item, position: starterBlockPosition(item, index) })).sort(byPosition)
  const block = placed.find(item => item.id === blockId)
  const rows = Math.min(starterRows, Math.max(6, rowAfter(placed) + 2))
  const scale = camera.zoom * fit
  const canInsert = screen.blocks.length < maxScreenBlocks &&
    layout.screens.reduce((total, item) => total + item.blocks.length, 0) < maxBlocks

  useLayoutEffect(() => {
    const stage = board.current
    if (!stage || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setFit(Math.min(1, Math.max(.42, (entry.contentRect.width - 36) / artboardWidth)))
    })
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const stage = board.current
    const element = grid.current?.querySelector('[aria-pressed="true"]')
    if (!stage || !element) return
    const view = stage.getBoundingClientRect()
    const item = element.getBoundingClientRect()
    const gutter = 20
    const x = item.left < view.left + gutter ? view.left + gutter - item.left :
      Math.min(0, view.right - gutter - item.right)
    const y = item.top < view.top + gutter ? view.top + gutter - item.top :
      Math.min(0, view.bottom - 55 - item.bottom)
    if (x || y) setCamera(previous => ({ ...previous, x: previous.x + x, y: previous.y + y }))
  }, [blockId, block?.position.row, block?.position.column, block?.position.span])

  useEffect(() => {
    const stage = board.current
    if (!stage) return
    const wheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const rect = stage.getBoundingClientRect()
      const point = { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - 42 }
      setCamera(previous => {
        const zoom = Math.min(2.5, Math.max(.45, previous.zoom * Math.exp(-event.deltaY * .004)))
        const ratio = zoom / previous.zoom
        return { zoom, x: point.x + (previous.x - point.x) * ratio, y: point.y + (previous.y - point.y) * ratio }
      })
    }
    stage.addEventListener('wheel', wheel, { passive: false })
    return () => stage.removeEventListener('wheel', wheel)
  }, [])

  function updateScreen(change: Partial<Pick<Screen, 'title' | 'blocks'>>): void {
    onChange({ screens: layout.screens.map(item => item.id === screen.id ? { ...item, ...change } : item) })
  }

  function select(item: Screen): void {
    selectScreen(item.id)
    selectBlock('')
    setCamera(initialCamera)
  }

  function addScreen(): void {
    const next = { id: crypto.randomUUID(), title: t('starterScreenDefault') + ' ' + (layout.screens.length + 1), blocks: [] }
    onChange({ screens: [...layout.screens, next] })
    select(next)
  }

  function removeScreen(): void {
    const remaining = layout.screens.filter(item => item.id !== screen.id)
    onChange({ screens: remaining })
    select(remaining[0]!)
  }

  function changeBlock(item: PlacedBlock, remaining: PlacedBlock[], added = false): void {
    updateScreen({ blocks: [...remaining, item].sort(byPosition) })
    selectBlock(item.id)
    setAnnouncement(t(`block.${item.kind}`) + ' · ' + t(added ? 'starterBlockAdded' : 'starterBlockMoved'))
  }

  function insert(kind: StarterBlockKind, plan?: DropPlan): void {
    if (disabled || !canInsert) return
    const position = plan?.position ?? { row: nextRow(placed), column: 0, span: starterColumns }
    const next = { id: crypto.randomUUID(), kind, text: kind === 'divider' ? '' : t(`block.${kind}.example`), position }
    changeBlock(next, plan?.remaining ?? placed, true)
  }

  function removeBlock(): void {
    const remaining = placed.filter(item => item.id !== blockId)
    updateScreen({ blocks: remaining })
    selectBlock(remaining[Math.min(placed.findIndex(item => item.id === blockId), remaining.length - 1)]?.id ?? '')
    setAnnouncement(t('starterBlockRemoved'))
  }

  function nudge(item: PlacedBlock, x: number, y: number): void {
    if (disabled) return
    const previous = item.position
    const position = { ...previous, row: previous.row + y, column: previous.column + x }
    const remaining = placed.filter(entry => entry.id !== item.id)
    if (fits(position, remaining)) {
      changeBlock({ ...item, position }, remaining)
      return
    }
    const swap = remaining.find(entry => entry.position.row === position.row &&
      entry.position.column === position.column && entry.position.span === position.span)
    if (swap) {
      changeBlock({ ...item, position }, remaining.map(entry => entry.id === swap.id ? { ...entry, position: previous } : entry))
    }
  }

  function resize(item: PlacedBlock, span: number): void {
    const remaining = placed.filter(entry => entry.id !== item.id)
    const position = { ...item.position, column: Math.min(item.position.column, starterColumns - span), span }
    if (fits(position, remaining)) changeBlock({ ...item, position }, remaining)
  }

  function startDrag(event: DragEvent, item: DragItem): void {
    if (disabled || ('kind' in item && !canInsert)) {
      event.preventDefault()
      return
    }
    dragged.current = item
    event.dataTransfer.effectAllowed = 'kind' in item ? 'copy' : 'move'
    event.dataTransfer.setData('application/x-dsh-appstudio-block', 'kind' in item ? item.kind : item.id)
  }

  function endDrag(): void {
    dragged.current = undefined
    setDropPlan(undefined)
  }

  function dragPosition(event: DragEvent): DropPlan | undefined {
    const item = dragged.current
    const rect = grid.current?.getBoundingClientRect()
    if (!item || !rect || !rect.width || disabled || ('kind' in item && !canInsert)) return
    const columnFraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    const rowAt = (event.clientY - rect.top) / (rowHeight * scale)
    const source = 'id' in item ? placed.find(entry => entry.id === item.id) : undefined
    return dropAt(placed.filter(entry => entry.id !== source?.id), source, Math.min(rows - 1, Math.max(0, Math.floor(rowAt))),
      Math.min(starterColumns - 1, Math.max(0, Math.floor(columnFraction * starterColumns))),
      Math.min(1, Math.max(0, rowAt) % 1), columnFraction)
  }

  function over(event: DragEvent): void {
    if (!dragged.current) return
    event.preventDefault()
    const plan = dragPosition(event)
    event.dataTransfer.dropEffect = plan ? 'kind' in dragged.current ? 'copy' : 'move' : 'none'
    setDropPlan(plan)
  }

  function drop(event: DragEvent): void {
    if (!dragged.current) return
    event.preventDefault()
    const item = dragged.current
    const plan = dragPosition(event)
    if (plan && 'kind' in item) insert(item.kind, plan)
    else if (plan && 'id' in item) {
      const moved = placed.find(entry => entry.id === item.id)
      if (moved) changeBlock({ ...moved, position: plan.position }, plan.remaining)
    }
    endDrag()
  }

  function beginPan(event: PointerEvent<HTMLDivElement>): void {
    if (!event.isPrimary || (event.button !== 0 && event.button !== 1)) return
    if (event.button === 0 && (event.target as HTMLElement).closest('.appstudio-layout-preview, .appstudio-layout-zoom')) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    pan.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, camera }
    setPanning(true)
  }

  function movePan(event: PointerEvent<HTMLDivElement>): void {
    const start = pan.current
    if (start?.pointer !== event.pointerId) return
    setCamera({ ...start.camera, x: start.camera.x + event.clientX - start.x, y: start.camera.y + event.clientY - start.y })
  }

  function endPan(event: PointerEvent<HTMLDivElement>): void {
    if (pan.current?.pointer !== event.pointerId) return
    pan.current = undefined
    setPanning(false)
  }

  function stepZoom(factor: number): void {
    setCamera(previous => ({ ...previous, zoom: Math.min(2.5, Math.max(.45, previous.zoom * factor)) }))
  }

  const otherBlocks = block ? placed.filter(item => item.id !== block.id) : []
  const displayed = dropPlan ? new Map(dropPlan.remaining.map(item => [item.id, item.position])) : undefined

  return (
    <div className="appstudio-layout-editor" data-appstudio-layout="">
      <div className="appstudio-layout-toolbar">
        <div className="appstudio-layout-screens" role="group" aria-label={t('starterScreens')}>
          {layout.screens.map(item => (
            <button type="button" key={item.id} data-appstudio-layout-screen={item.id}
              aria-pressed={item.id === screen.id} disabled={disabled} onClick={() => select(item)}>
              {item.title.trim() || t('starterUntitledScreen')}
            </button>
          ))}
          <button type="button" data-appstudio-layout-add-screen="" disabled={disabled || layout.screens.length >= maxScreens} onClick={addScreen}>
            <StudioIcon name="plus" size={17} /> {t('starterAddScreen')}
          </button>
        </div>
        <div className="appstudio-layout-screen-field">
          <input aria-label={t('starterScreenTitle')} data-appstudio-layout-screen-title="" value={screen.title}
            placeholder={t('starterUntitledScreen')} maxLength={80} disabled={disabled}
            onChange={event => updateScreen({ title: event.target.value })} />
          {layout.screens.length > 1 && (
            <button type="button" className="appstudio-icon-button" aria-label={t('starterRemoveScreen')}
              title={t('starterRemoveScreen')} disabled={disabled} onClick={removeScreen}><StudioIcon name="remove" size={17} /></button>
          )}
        </div>
      </div>
      <div className="appstudio-layout-area">
        <div className="appstudio-layout-tools">
          <h3>{t('starterComponents')}</h3>
          <div className="appstudio-layout-palette">
            {starterBlockKinds.map(kind => (
              <button type="button" key={kind} data-appstudio-layout-palette={kind} data-kind={kind} disabled={disabled || !canInsert}
                draggable={!disabled && canInsert} onDragStart={event => startDrag(event, { kind })} onDragEnd={endDrag}
                onClick={() => insert(kind)}>
                <span className="appstudio-layout-swatch"><StudioIcon name={kind} size={16} /></span>{t(`block.${kind}`)}
              </button>
            ))}
          </div>
          {!canInsert && <p role="status">{t('starterBlockLimit')}</p>}
          {block && (
            <div className="appstudio-layout-properties">
              <h3>{t(`block.${block.kind}`)}</h3>
              {block.kind !== 'divider' && (
                <label className="appstudio-field">
                  {t('starterBlockText')}
                  <textarea data-appstudio-layout-block-text="" maxLength={400} value={block.text} disabled={disabled}
                    onChange={event => {
                      const text = event.target.value
                      updateScreen({ blocks: screen.blocks.map(item => item.id === block.id ? { ...item, text } : item) })
                    }} />
                </label>
              )}
              <label className="appstudio-field">
                {t('starterBlockWidth')}
                <select data-appstudio-layout-block-width="" value={block.position.span} disabled={disabled}
                  onChange={event => resize(block, Number(event.target.value))}>
                  {[...new Set([...widths, block.position.span])].sort((a, b) => a - b).map(span => (
                    <option key={span} value={span} disabled={!fits({ ...block.position,
                      column: Math.min(block.position.column, starterColumns - span), span }, otherBlocks)}>
                      {span === starterColumns ? t('starterBlockFullWidth') : span + ' / ' + starterColumns}
                    </option>
                  ))}
                </select>
              </label>
              <div className="appstudio-layout-edit-actions">
                {directions.map(direction => (
                  <button type="button" key={direction.id} title={t(direction.label)} aria-label={t(direction.label)}
                    data-appstudio-layout-move={direction.id} disabled={disabled}
                    onClick={() => nudge(block, direction.x, direction.y)}>
                    <span style={{ transform: 'rotate(' + direction.angle + 'deg)' }}><StudioIcon name="up" size={15} /></span>
                  </button>
                ))}
                <button type="button" title={t('commentRemove')} aria-label={t('commentRemove')}
                  data-appstudio-layout-remove="" disabled={disabled} onClick={removeBlock}><StudioIcon name="remove" size={16} /></button>
              </div>
            </div>
          )}
        </div>
        <div className="appstudio-layout-board" ref={board} data-appstudio-layout-board="" data-panning={panning}
          role="region" aria-label={t('starterPreview')} aria-describedby={fields + '-hint'}
          style={{ backgroundPosition: `${camera.x}px ${camera.y}px, center` }}
          onPointerDown={beginPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan} onLostPointerCapture={endPan}>
          <div className="appstudio-layout-artboard" style={{ width: artboardWidth,
            transform: 'translate(calc(-50% + ' + camera.x + 'px), ' + camera.y + 'px) scale(' + scale + ')' }}>
            <div className="appstudio-layout-artboard-label">{screen.title.trim() || t('starterUntitledScreen')}</div>
            <div className="appstudio-layout-preview" data-appstudio-layout-preview=""
              data-dropping={!!dropPlan} onDragOver={over} onDrop={drop}
              onClick={event => { if (!(event.target as Element).closest('.appstudio-layout-block')) selectBlock('') }}
              onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropPlan(undefined) }}>
              {!screen.blocks.length && !dropPlan && (
                <div className="appstudio-layout-drop-empty"><StudioIcon name="plus" size={22} />{t('starterLayoutDrop')}</div>
              )}
              <ol className="appstudio-layout-blocks" ref={grid} data-appstudio-layout-grid=""
                style={{ gridTemplateRows: `repeat(${rows}, ${rowHeight}px)`, gridTemplateColumns: `repeat(${starterColumns}, minmax(0, 1fr))`,
                  backgroundSize: `calc(100% / ${starterColumns}) 100%, 100% ${rowHeight}px` }}>
                {placed.map(item => {
                  const position = displayed?.get(item.id) ?? item.position
                  return (
                    <li key={item.id} data-moving={!!displayed && !displayed.has(item.id)}
                      style={{ gridColumn: `${position.column + 1} / span ${position.span}`, gridRow: position.row + 1 }}>
                      <button type="button" className="appstudio-layout-block" data-appstudio-layout-block={item.kind}
                        data-kind={item.kind} data-row={item.position.row} data-column={item.position.column} data-span={item.position.span}
                        draggable={!disabled} disabled={disabled} aria-pressed={item.id === blockId}
                        aria-label={t(`block.${item.kind}`) + (item.text ? ' · ' + item.text : '')}
                        aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowUp Alt+ArrowDown Alt+ArrowRight"
                        onClick={() => selectBlock(item.id)} onDragStart={event => startDrag(event, { id: item.id })} onDragEnd={endDrag}
                        onKeyDown={event => {
                          if (!event.altKey) return
                          const direction = directions.find(entry => event.key === entry.key)
                          if (!direction) return
                          event.preventDefault()
                          event.stopPropagation()
                          nudge(item, direction.x, direction.y)
                        }}>
                        <StudioIcon name={item.kind} size={17} />
                        <span>{item.kind === 'divider' ? '' : item.text || t(`block.${item.kind}`)}</span>
                      </button>
                    </li>
                  )
                })}
                {dropPlan && <li className="appstudio-layout-drop-target" aria-hidden="true"
                  style={{ gridColumn: `${dropPlan.position.column + 1} / span ${dropPlan.position.span}`, gridRow: dropPlan.position.row + 1 }} />}
              </ol>
            </div>
          </div>
          <div className="appstudio-layout-zoom" role="group" aria-label={t('starterCanvasZoom')}>
            <button type="button" title={t('starterZoomOut')} aria-label={t('starterZoomOut')}
              disabled={camera.zoom <= .45} onClick={() => stepZoom(1 / 1.2)}>−</button>
            <button type="button" title={t('starterResetView')} aria-label={t('starterResetView')}
              onClick={() => setCamera(initialCamera)}>{Math.round(scale * 100)}%</button>
            <button type="button" title={t('starterZoomIn')} aria-label={t('starterZoomIn')}
              disabled={camera.zoom >= 2.5} onClick={() => stepZoom(1.2)}><StudioIcon name="plus" size={17} /></button>
          </div>
        </div>
      </div>
      <p className="appstudio-layout-hint" id={fields + '-hint'}>{t('starterLayoutHint')}</p>
      <p className="appstudio-sr-only" role="status">{announcement}</p>
    </div>
  )
}
