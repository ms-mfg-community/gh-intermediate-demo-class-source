import { Grid } from './grid.js'
import { HTMLActuator } from './html_actuator.js'
import { KeyboardInputManager } from './keyboard_input_manager.js'
import { LocalStorageManager } from './local_storage_manager.js'
import { Tile } from './tile.js'
import type { GameState, Position } from './types.js'

/**
 * Game Manager
 *
 * Singleton class that manages the game flow.
 */
export class GameManager {
  /** Grid Size */
  static size: number
  /** Game State */
  static state: GameState
  /** Start Tiles Count */
  static startTiles: number = 1

  constructor(size: number) {
    GameManager.size = size

    // Instantiate the singleton classes
    new LocalStorageManager()
    new KeyboardInputManager()
    new HTMLActuator()

    KeyboardInputManager.on('move', GameManager.move.bind(GameManager))
    KeyboardInputManager.on('restart', GameManager.restart.bind(GameManager))
    KeyboardInputManager.on(
      'keepPlaying',
      GameManager.keepPlaying.bind(GameManager)
    )

    GameManager.setup()
  }

  /**
   * Restarts the game.
   */
  static restart(): void {
    LocalStorageManager.clearGameState()
    HTMLActuator.continueGame()
    GameManager.setup()
  }

  /**
   * Keep playing after winning (allows going over 2048)
   */
  static keepPlaying(): void {
    GameManager.state.keepPlaying = true
    HTMLActuator.continueGame()
  }

  /**
   * Returns true if the game is lost or ended.
   *
   * @returns Game Terminated Status
   */
  static isGameTerminated(): boolean {
    return (
      GameManager.state.gameOver ||
      (GameManager.state.won && !GameManager.state.keepPlaying)
    )
  }

  /**
   * Sets up the game.
   */
  static setup(): void {
    const previousState = LocalStorageManager.getGameState()

    if (previousState !== null) {
      // Reload previous state.
      new Grid(previousState.grid.size, previousState.grid.cells)

      GameManager.state = {
        bestScore: previousState.bestScore,
        gameOver: previousState.gameOver,
        grid: previousState.grid,
        keepPlaying: previousState.keepPlaying,
        score: previousState.score,
        terminated: previousState.terminated,
        won: previousState.won
      }
    } else {
      // Create a new game state.
      new Grid(GameManager.size)

      GameManager.state = {
        bestScore: 0,
        gameOver: false,
        grid: Grid,
        keepPlaying: false,
        score: 0,
        terminated: false,
        won: false
      }

      // Add the initial tiles
      GameManager.addStartTiles()
    }

    // Update the actuator
    GameManager.actuate()
  }

  /**
   * Set up the starting tiles.
   */
  static addStartTiles(): void {
    for (let i = 0; i < GameManager.startTiles; i++) GameManager.addRandomTile()
  }

  /**
   * Adds a tile in a random position.
   */
  static addRandomTile(): void {
    if (Grid.cellsAvailable()) {
      const value = Math.random() < 0.5 ? 2 : 4
      const cell = Grid.randomAvailableCell()

      if (cell !== null) Grid.insertTile(new Tile(cell, value))
    }
  }

  /**
   * Sends the updated grid to the actuator.
   */
  static actuate() {
    if (LocalStorageManager.getBestScore() < GameManager.state.score)
      LocalStorageManager.setBestScore(GameManager.state.score)

    // Clear the state when the game is over (game over only, not won)
    if (GameManager.state.gameOver) LocalStorageManager.clearGameState()
    else LocalStorageManager.setGameState(GameManager.state)

    HTMLActuator.actuate({
      ...GameManager.state,
      bestScore: LocalStorageManager.getBestScore(),
      terminated: GameManager.isGameTerminated()
    })

    // Save the game state.
    GameManager.state.grid = Grid
    LocalStorageManager.setGameState(GameManager.state)
  }

  /**
   * Saves all tile positions and removes merge info.
   */
  static prepareTiles() {
    Grid.eachCell(function (position: Position, tile: Tile) {
      if (tile) {
        tile.mergedFrom = null
        tile.savePosition()
      }
    })
  }

  /**
   * Moves a tile and its representation
   *
   * @param tile Tile to Move
   * @param cell Destination Cell
   */
  static moveTile(tile: Tile, cell: Position) {
    Grid.cells[tile.position.x][tile.position.y] = null
    Grid.cells[cell.x][cell.y] = tile
    tile.updatePosition(cell)
  }

  /**
   * Moves tiles on the grid in the specified direction
   *
   * 0: up
   * 1: right
   * 2: down
   * 3: left
   *
   * @param direction Direction to Move
   */
  static move(direction: number) {
    // Don't do anything if the game is over
    if (GameManager.isGameTerminated()) return

    let cell, tile
    let moved = false

    const vector = GameManager.getVector(direction)
    const traversals = GameManager.buildTraversals(vector)

    // Save the current tile positions and remove merge information
    GameManager.prepareTiles()

    // Traverse the grid in the right direction and move tiles
    traversals.x.forEach(function (x: number) {
      traversals.y.forEach(function (y: number) {
        cell = { x, y }
        tile = Grid.cellContent(cell)

        if (tile !== null) {
          const positions = GameManager.findFarthestPosition(cell, vector)
          const next = Grid.cellContent(positions.next)

          // Only one merger per row traversal
          if (next && next.value === tile.value && !next.mergedFrom) {
            const merged = new Tile(positions.next, tile.value * 2)
            merged.mergedFrom = [tile, next]

            Grid.insertTile(merged)
            Grid.removeTile(tile)

            // Converge the two tiles' positions
            tile.updatePosition(positions.next)

            // Update the score
            GameManager.state.score += merged.value

            // The mighty 2048 tile
            if (merged.value === 2048) GameManager.state.won = true
          } else GameManager.moveTile(tile, positions.farthest)

          // The tile moved from its original cell!
          if (!GameManager.positionsEqual(cell, tile.position)) moved = true
        }
      })
    })

    if (moved) {
      GameManager.addRandomTile()

      if (!GameManager.movesAvailable()) GameManager.state.gameOver = true

      GameManager.actuate()
    }
  }

  /**
   * Gets the vector representing the chosen direction.
   *
   * @param direction Direction
   */
  static getVector(direction: number): Position {
    // Vectors representing tile movement
    const map = {
      0: { x: 0, y: -1 }, // Up
      1: { x: 1, y: 0 }, // Right
      2: { x: 0, y: 1 }, // Down
      3: { x: -1, y: 0 } // Left
    }

    return map[direction as keyof typeof map]
  }

  /**
   * Builds a list of positions to traverse in the right order.
   *
   * @param vector Vector
   */
  static buildTraversals(vector: Position) {
    const traversals: { [key: string]: number[] } = { x: [], y: [] }

    for (let pos = 0; pos < GameManager.size; pos++) {
      traversals.x.push(pos)
      traversals.y.push(pos)
    }

    // Always traverse from the farthest cell in the chosen direction
    if (vector.x === 1) traversals.x = traversals.x.reverse()
    if (vector.y === 1) traversals.y = traversals.y.reverse()

    return traversals
  }

  static findFarthestPosition(cell: Position, vector: Position) {
    let farthest

    // Progress towards the vector direction until an obstacle is found
    do {
      farthest = cell
      cell = { x: farthest.x + vector.x, y: farthest.y + vector.y }
    } while (Grid.withinBounds(cell) && Grid.cellAvailable(cell))

    return {
      farthest, // The farthest position this tile can move to
      next: cell // Used to check if a merge is required
    }
  }

  /**
   * Checks if moves are available.
   *
   * @returns Moves Available
   */
  static movesAvailable(): boolean {
    return Grid.cellsAvailable() || GameManager.tileMatchesAvailable()
  }

  /**
   * Checks for available matches between tiles
   */
  static tileMatchesAvailable() {
    let tile

    for (let x = 0; x < GameManager.size; x++) {
      for (let y = 0; y < GameManager.size; y++) {
        tile = Grid.cellContent({ x, y })

        if (tile !== null) {
          for (let direction = 0; direction < 4; direction++) {
            const vector = GameManager.getVector(direction)
            const cell = { x: x + vector.x, y: y + vector.y }

            const other = Grid.cellContent(cell)

            if (other && other.value === tile.value) {
              return true // These two tiles can be merged
            }
          }
        }
      }
    }

    return false
  }

  /**
   * Checks if the specified positions are equal.
   *
   * @param first First Position
   * @param second Second Position
   * @returns Position Equality
   */
  static positionsEqual(first: Position, second: Position): boolean {
    return first.x === second.x && first.y === second.y
  }
}
