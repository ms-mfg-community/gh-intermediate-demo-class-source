import { Grid } from './grid.js'
import type { Tile } from './tile.js'
import type { GameState, Position } from './types.js'

/**
 * HTML Actuator
 *
 * Singleton class that manages HTML updates.
 */
export class HTMLActuator {
  /** Best Score Container */
  static bestContainer = document.querySelector('.best-container') as Element
  /** Message Container */
  static messageContainer = document.querySelector('.game-message') as Element
  /** Score */
  static score: number = 0
  /** Score Container */
  static scoreContainer = document.querySelector('.score-container') as Element
  /** Tile Container */
  static tileContainer = document.querySelector('.tile-container') as Element

  constructor() {}

  /**
   * Updates the UI based on game state changes.
   *
   * @param metadata Game Metadata
   */
  static actuate(metadata: GameState): void {
    window.requestAnimationFrame(function () {
      HTMLActuator.clearContainer(HTMLActuator.tileContainer)

      Grid.cells.forEach(function (column) {
        column.forEach(function (cell) {
          if (cell) HTMLActuator.addTile(cell)
        })
      })

      HTMLActuator.updateScore(metadata.score)
      HTMLActuator.updateBestScore(metadata.bestScore)

      if (metadata.terminated && metadata.gameOver) HTMLActuator.message(false)
      else if (metadata.terminated && metadata.won) HTMLActuator.message(true)
    })
  }

  /**
   * Continues the game.
   *
   * Affects both restarts and keep playing.
   */
  static continueGame(): void {
    HTMLActuator.clearMessage()
  }

  /**
   * Clears the tile container.
   *
   * @param container Container
   */
  static clearContainer(container: Element): void {
    while (container.firstChild) container.removeChild(container.firstChild)
  }

  /**
   * Adds a tile.
   *
   * @param tile Tile
   */
  static addTile(tile: Tile): void {
    const wrapper = document.createElement('div')
    const inner = document.createElement('div')
    const position = tile.previousPosition || tile.position
    const positionClass = HTMLActuator.positionClass(position)
    const classes = ['tile', `tile-${tile.value}`, positionClass]

    if (tile.value > 2048) classes.push('tile-super')

    HTMLActuator.applyClasses(wrapper, classes)

    inner.classList.add('tile-inner')
    inner.textContent = tile.value.toString()

    if (tile.previousPosition) {
      // Make sure that the tile gets rendered in the previous position first
      window.requestAnimationFrame(function () {
        classes[2] = HTMLActuator.positionClass(tile.position)
        HTMLActuator.applyClasses(wrapper, classes)
      })
    } else if (tile.mergedFrom) {
      classes.push('tile-merged')
      HTMLActuator.applyClasses(wrapper, classes)

      // Render the tiles that merged
      tile.mergedFrom.forEach(function (merged) {
        HTMLActuator.addTile(merged)
      })
    } else {
      classes.push('tile-new')
      HTMLActuator.applyClasses(wrapper, classes)
    }

    // Add the inner part of the tile to the wrapper
    wrapper.appendChild(inner)

    // Put the tile on the board
    HTMLActuator.tileContainer.appendChild(wrapper)
  }

  /**
   * Applies classes to an element.
   *
   * @param element Element to Apply Classes
   * @param classes Classes to Apply
   */
  static applyClasses(element: any, classes: string[]): void {
    element.setAttribute('class', classes.join(' '))
  }

  /**
   * Normalizes the position.
   *
   * @param position Position
   * @returns Normalized Position
   */
  static normalizePosition(position: Position): Position {
    return { x: position.x + 1, y: position.y + 1 }
  }

  /**
   * Creates a class name for a position.
   *
   * @param position Position
   * @returns Class Name
   */
  static positionClass(position: Position): string {
    position = HTMLActuator.normalizePosition(position)
    return `tile-position-${position.x}-${position.y}`
  }

  /**
   * Updates the Score
   *
   * @todo The score update should be animated
   *
   * @param score Score
   */
  static updateScore(score: number): void {
    // Clear the current score
    HTMLActuator.clearContainer(HTMLActuator.scoreContainer)

    // Get the difference between the current score and the new score
    const difference = score - HTMLActuator.score

    // Set the new score
    HTMLActuator.score = score

    // Update the score
    HTMLActuator.scoreContainer.textContent = HTMLActuator.score.toString()

    // Lab 4: Animate the score update
    if (difference > 0) {
      const addition = document.createElement('div')
      addition.classList.add('score-addition')
      addition.textContent = '+' + difference

      HTMLActuator.scoreContainer.appendChild(addition)
    }
  }

  /**
   * Updates the best score.
   *
   * @param bestScore Best Score
   */
  static updateBestScore(bestScore: number): void {
    HTMLActuator.bestContainer.textContent = bestScore.toString()
  }

  /**
   * Sets the message.
   *
   * @param won Won Status
   */
  static message(won: boolean): void {
    HTMLActuator.messageContainer.classList.add(won ? 'game-won' : 'game-over')
    HTMLActuator.messageContainer.getElementsByTagName('p')[0].textContent = won
      ? 'You win!'
      : 'Game over!'
  }

  /**
   * Clears the message.
   */
  static clearMessage(): void {
    HTMLActuator.messageContainer.classList.remove('game-won')
    HTMLActuator.messageContainer.classList.remove('game-over')
  }
}
