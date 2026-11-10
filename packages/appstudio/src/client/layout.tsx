import { useId, useRef, useState, type DragEvent } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { StarterBlockKind, StarterLayout } from '../shared/protocol.ts'
import type { namespace } from './copy.ts'
import { StudioIcon } from './icons.tsx'

export const starterBlockKinds = ['heading', 'text', 'image', 'input', 'button', 'list', 'divider'] as const satisfies readonly StarterBlockKind[]
const maxScreens = 8
const maxScreenBlocks = 12
const maxBlocks = 24
type Screen = StarterLayout['screens'][number]
type Block = Screen['blocks'][number]
type DragItem = { kind: StarterBlockKind } | { id: string }
type LayoutProps = PropsLocale<typeof namespace> & {
  layout: StarterLayout
  disabled: boolean
  onChange: (value: StarterLayout) => void
}

export function newStarterLayout(title: string): StarterLayout {
  return { screens: [{ id: crypto.randomUUID(), title, blocks: [] }] }
}

export function canGenerateLayout(layout: StarterLayout): boolean {
  return layout.screens.every(screen => screen.title.trim()) &&
    layout.screens.some(screen => screen.blocks.length > 0)
}

export function LayoutEditor({ layout, disabled, onChange, t }: LayoutProps) {
  const [screenId, selectScreen] = useState('')
  const [blockId, selectBlock] = useState('')
  const [dropIndex, setDropIndex] = useState<number>()
  const [announcement, setAnnouncement] = useState('')
  const dragged = useRef<DragItem>()
  const fields = useId()
  const screen = layout.screens.find(item => item.id === screenId) ?? layout.screens[0]!
  const blockIndex = screen.blocks.findIndex(item => item.id === blockId)
  const block = screen.blocks[blockIndex]
  const canInsert = screen.blocks.length < maxScreenBlocks &&
    layout.screens.reduce((total, item) => total + item.blocks.length, 0) < maxBlocks

  function updateScreen(change: Partial<Pick<Screen, 'title' | 'blocks'>>): void {
    onChange({ screens: layout.screens.map(item => item.id === screen.id ? { ...item, ...change } : item) })
  }

  function addScreen(): void {
    const next = { id: crypto.randomUUID(), title: t('starterScreenDefault') + ' ' + (layout.screens.length + 1), blocks: [] }
    onChange({ screens: [...layout.screens, next] })
    selectScreen(next.id)
    selectBlock('')
  }

  function removeScreen(): void {
    const remaining = layout.screens.filter(item => item.id !== screen.id)
    onChange({ screens: remaining })
    selectScreen(remaining[0]!.id)
    selectBlock('')
  }

  function insert(kind: StarterBlockKind, index = screen.blocks.length): void {
    if (disabled || !canInsert) return
    const next: Block = { id: crypto.randomUUID(), kind, text: kind === 'divider' ? '' : t(`block.${kind}.example`) }
    const blocks = screen.blocks.slice()
    blocks.splice(index, 0, next)
    updateScreen({ blocks })
    selectBlock(next.id)
    setAnnouncement(t(`block.${kind}`) + ' · ' + t('starterBlockAdded'))
  }

  function reorder(id: string, position: number): void {
    if (disabled) return
    const current = screen.blocks.findIndex(item => item.id === id)
    if (current < 0 || position < 0 || position >= screen.blocks.length || current === position) return
    const blocks = screen.blocks.slice()
    const [item] = blocks.splice(current, 1)
    blocks.splice(position, 0, item!)
    updateScreen({ blocks })
    selectBlock(id)
    setAnnouncement(t(`block.${item!.kind}`) + ' · ' + t('starterBlockMoved') + ' ' + (position + 1))
  }

  function removeBlock(): void {
    const remaining = screen.blocks.filter(item => item.id !== blockId)
    updateScreen({ blocks: remaining })
    selectBlock(remaining[Math.min(blockIndex, remaining.length - 1)]?.id ?? '')
    setAnnouncement(t('starterBlockRemoved'))
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
    setDropIndex(undefined)
  }

  function over(event: DragEvent, index: number): void {
    const item = dragged.current
    if (!item || disabled || ('kind' in item && !canInsert)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'kind' in item ? 'copy' : 'move'
    setDropIndex(index)
  }

  function drop(event: DragEvent, index: number): void {
    const item = dragged.current
    if (!item || disabled) return
    event.preventDefault()
    event.stopPropagation()
    if ('kind' in item) insert(item.kind, index)
    else {
      const current = screen.blocks.findIndex(entry => entry.id === item.id)
      reorder(item.id, index - Number(current >= 0 && current < index))
    }
    endDrag()
  }

  function position(event: DragEvent<HTMLLIElement>, index: number): number {
    const rect = event.currentTarget.getBoundingClientRect()
    return index + Number(event.clientY > rect.top + rect.height / 2)
  }

  return (
    <div className="appstudio-layout-editor" data-appstudio-layout="">
      <div className="appstudio-layout-toolbar">
        <div className="appstudio-layout-screens" role="group" aria-label={t('starterScreens')}>
          {layout.screens.map(item => (
            <button type="button" key={item.id} data-appstudio-layout-screen={item.id}
              aria-pressed={item.id === screen.id} disabled={disabled}
              onClick={() => { selectScreen(item.id); selectBlock('') }}>
              {item.title.trim() || t('starterUntitledScreen')}
            </button>
          ))}
          <button type="button" data-appstudio-layout-add-screen="" disabled={disabled || layout.screens.length >= maxScreens} onClick={addScreen}>
            <StudioIcon name="plus" size={15} /> {t('starterAddScreen')}
          </button>
        </div>
        <div className="appstudio-inline-field">
          <label htmlFor={fields + '-screen'}>{t('starterScreenTitle')}</label>
          <input id={fields + '-screen'} data-appstudio-layout-screen-title="" value={screen.title}
            maxLength={80} disabled={disabled} onChange={event => updateScreen({ title: event.target.value })} />
          {layout.screens.length > 1 && (
            <button type="button" className="appstudio-icon-button" aria-label={t('starterRemoveScreen')}
              title={t('starterRemoveScreen')} disabled={disabled} onClick={removeScreen}><StudioIcon name="remove" size={16} /></button>
          )}
        </div>
      </div>
      <div className="appstudio-layout-area">
        <div className="appstudio-layout-tools">
          <h3>{t('starterComponents')}</h3>
          <p>{t('starterLayoutHint')}</p>
          <div className="appstudio-layout-palette">
            {starterBlockKinds.map(kind => (
              <button type="button" key={kind} data-appstudio-layout-palette={kind} disabled={disabled || !canInsert}
                draggable={!disabled && canInsert} onDragStart={event => startDrag(event, { kind })} onDragEnd={endDrag}
                onClick={() => insert(kind)}><StudioIcon name={kind} size={17} />{t(`block.${kind}`)}</button>
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
                      const value = event.target.value
                      updateScreen({ blocks: screen.blocks.map(item => item.id === block.id ? { ...item, text: value } : item) })
                    }} />
                </label>
              )}
              <div className="appstudio-actions">
                <button type="button" className="appstudio-icon-button" title={t('starterMoveUp')} aria-label={t('starterMoveUp')}
                  data-appstudio-layout-move="up" disabled={disabled || blockIndex === 0} onClick={() => reorder(block.id, blockIndex - 1)}>
                  <StudioIcon name="up" size={16} />
                </button>
                <button type="button" className="appstudio-icon-button" title={t('starterMoveDown')} aria-label={t('starterMoveDown')}
                  data-appstudio-layout-move="down" disabled={disabled || blockIndex === screen.blocks.length - 1}
                  onClick={() => reorder(block.id, blockIndex + 1)}><StudioIcon name="down" size={16} /></button>
                <button type="button" disabled={disabled} onClick={removeBlock}>{t('commentRemove')}</button>
              </div>
            </div>
          )}
        </div>
        <div className="appstudio-layout-board" onDragOver={event => over(event, screen.blocks.length)}
          onDrop={event => drop(event, screen.blocks.length)}
          onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropIndex(undefined) }}>
          <div className="appstudio-layout-preview" aria-label={t('starterPreview')} data-appstudio-layout-preview="">
            <div className="appstudio-layout-phone-top"><span /><span /><span /></div>
            <div className="appstudio-layout-preview-title">{screen.title.trim() || t('starterUntitledScreen')}</div>
            {!screen.blocks.length && <div className="appstudio-layout-drop-empty"><StudioIcon name="plus" size={21} />{t('starterLayoutDrop')}</div>}
            <ol className="appstudio-layout-blocks">
              {screen.blocks.map((item, index) => (
                <li key={item.id} data-drop-before={dropIndex === index}
                  onDragOver={event => over(event, position(event, index))} onDrop={event => drop(event, position(event, index))}>
                  <button type="button" className="appstudio-layout-block" data-appstudio-layout-block={item.kind}
                    draggable={!disabled} disabled={disabled} aria-pressed={item.id === blockId}
                    aria-label={t(`block.${item.kind}`) + (item.text ? ' · ' + item.text : '')}
                    onClick={() => selectBlock(item.id)} onDragStart={event => startDrag(event, { id: item.id })} onDragEnd={endDrag}
                    onKeyDown={event => {
                      if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
                      event.preventDefault()
                      event.stopPropagation()
                      reorder(item.id, index + (event.key === 'ArrowUp' ? -1 : 1))
                    }}>
                    <StudioIcon name="grip" size={12} />
                    <span className="appstudio-layout-block-content">
                      {(item.kind === 'image' || item.kind === 'list') && <StudioIcon name={item.kind} size={19} />}
                      <span>{item.kind !== 'divider' && (item.text || t(`block.${item.kind}`))}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
            <div className="appstudio-layout-drop-tail" data-drop-active={dropIndex === screen.blocks.length} />
          </div>
        </div>
      </div>
      <p className="appstudio-sr-only" role="status">{announcement}</p>
    </div>
  )
}
