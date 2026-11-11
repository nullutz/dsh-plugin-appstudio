import type { StarterBlock, StarterBlockPosition } from './protocol.ts'

export const starterColumns = 12
export const starterRows = 128

export function starterBlockPosition(block: StarterBlock, index: number): StarterBlockPosition {
  return block.position ?? { row: index, column: 0, span: starterColumns }
}

export function validStarterBlockPositions(blocks: readonly StarterBlock[]): boolean {
  const occupied = new Set<number>()
  return blocks.every((block, index) => {
    const { row, column, span } = starterBlockPosition(block, index)
    if (!Number.isInteger(row) || row < 0 || row >= starterRows ||
        !Number.isInteger(column) || column < 0 || !Number.isInteger(span) || span < 1 || column + span > starterColumns) {
      return false
    }
    for (let offset = 0; offset < span; offset++) {
      const cell = row * starterColumns + column + offset
      if (occupied.has(cell)) return false
      occupied.add(cell)
    }
    return true
  })
}
