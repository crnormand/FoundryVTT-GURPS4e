import { i18n, recurselist } from '../lib/utilities.js'
import Maneuvers, {
  MOVE_FULL,
  MOVE_HALF,
  MOVE_NONE,
  MOVE_ONE,
  MOVE_ONETHIRD,
  MOVE_STEP,
  MOVE_TWO_STEPS,
  MOVE_TWOTHIRDS,
} from './actor/maneuver.js'
import * as Settings from '../lib/miscellaneous-settings.js'

/**
 * # Actor Actions Class
 *
 * This class handles and represents the available actions
 * for an actor's token, as per GURPS rules below:
 *
 * ### Number of Turns available per second (or Foundry Turn)
 * * 1 Turn per second + Altered Time Rate (ATR) Levels
 *
 * ### Choice Maneuver
 * * 1 maneuver per turn
 *
 * ### Attacks per turn
 * * 1 attack + Extra Attacks, modified per Maneuver or Effect
 *
 * ### Defenses per Turn
 * * Dodge: Unlimited, modified per Maneuver or Effect.
 * * Parry: 1 per turn, subsequent parries at -4, modified per Maneuver or Effect.
 * * Block: 1 per turn, modified per Maneuver or Effect.
 *
 * ### Movement per Turn
 * * Current Actor Basic Move, modified per Maneuver or Effect
 *
 * ### Concentrate per turn
 * * +1, modified per Maneuver or Effect
 *
 * ### Evaluate
 * * +1, modified per Maneuver or Effect, max: +3
 *
 * ### Aim
 * * +Acc, modified per Maneuver or Effect, +1 after first turn.
 *
 * @param {Token} token - The token to control.
 */
export class TokenActions {
  constructor(token) {
    this.token = token
    this.actor = token?.actor
    this.initValues()
  }

  static async fromToken(token) {
    const tokenActions = new TokenActions(token)
    return await tokenActions.init()
  }

  _getNewLastManeuvers() {
    return {
      maneuver: 'do_nothing',
      nextTurnEffects: [],
    }
  }

  _getInitialLastManeuvers() {
    return {
      0: this._getNewLastManeuvers(),
    }
  }

  initValues() {
    this.maxActions = 1
    this.maxBlocks = 1
    this.maxParries = Infinity
    this.maxMove = this.getMaxMove()
    this.currentTurn = 0
    this.lastManeuvers = this._getInitialLastManeuvers()

    // Trackable resources per Turn
    this.totalActions = 0
    this.totalAttacks = 0
    this.totalBlocks = 0
    this.totalParries = 0
    this.totalMoves = 0

    this.extraBlocks = 0
    this.extraAttacks = 0
    this.extraActions = 0
    this.rapidStrikeBonus = 0

    this.canDefend = undefined
    this.canAttack = undefined
    this.canMove = undefined

    this.toHitBonus = 0
    this.defenseBonus = 0

    // Accumulative resources per Turn
    this.concentrateTurns = 0
    this.currentAim = this._getInitialAim()
    this.currentParry = this._getInitialParry()
    this.evaluateTurns = 0
    this.readyTurns = 0
    this.moveTurns = 0

    this.blindAsDefault = game.user.isGM
    this.lastAttack = {}
  }

  get currentManeuver() {
    if (!this.lastManeuvers) {
      this.lastManeuvers = this._getInitialLastManeuvers()
    }
    return this.lastManeuvers[this.currentTurn || 0]?.maneuver || 'do_nothing'
  }

  async clear() {
    this.initValues()
    await this.removeManeuverModifiers()
    await this.removeCombatTempMods()
    await this.token.document.unsetFlag('gurps', 'tokenActions')
    await this.save()
    await this.token.setManeuver('do_nothing')
  }

  async removeManeuverModifiers() {
    const allModifiers = await foundry.utils.getProperty(this.actor, 'system.conditions.usermods')
    const validModifiers = allModifiers.filter(m => !m.includes('#maneuver'))
    await this.actor.update({ 'system.conditions.usermods': validModifiers })
  }

  async init() {
    const savedTokenData = (await this.token.document.getFlag('gurps', 'tokenActions')) || {}

    // Current (used) Values per Turn
    this.totalActions = savedTokenData.totalActions || 0
    this.totalAttacks = savedTokenData.totalAttacks || 0
    this.totalBlocks = savedTokenData.totalBlocks || 0
    this.totalParries = savedTokenData.totalParries || 0
    this.totalMoves = savedTokenData.totalMoves || 0

    // Extra Values per Turn
    this.extraActions = savedTokenData.extraActions || 0
    this.extraAttacks = savedTokenData.extraAttacks || 0
    this.extraBlocks = savedTokenData.extraBlocks || 0
    this.rapidStrikeBonus = savedTokenData.rapidStrikeBonus || 0

    // Max Values per Turn
    this.maxActions = foundry.utils.getProperty(this.actor, 'system.conditions.actions.maxActions') || 1
    this.maxBlocks = foundry.utils.getProperty(this.actor, 'system.conditions.actions.maxBlocks') || 1
    this.maxParries = savedTokenData.maxParries || Infinity
    this.maxMove = savedTokenData.maxMove || this.getMaxMove()

    // Turn Data
    this.currentTurn = game.combat?.round || 0
    this.lastManeuvers = savedTokenData.lastManeuvers || this._getInitialLastManeuvers()
    this.lastAttack = savedTokenData.lastAttack || {}

    // Flags
    this.canDefend = savedTokenData.canDefend
    this.canAttack = savedTokenData.canAttack
    this.canMove = savedTokenData.canMove

    // Modifiers
    this.toHitBonus = savedTokenData.toHitBonus || 0
    this.defenseBonus = savedTokenData.defenseBonus || 0
    this.concentrateTurns = savedTokenData.concentrateTurns || 0
    this.currentAim = savedTokenData.currentAim || this._getInitialAim()
    this.currentParry = savedTokenData.currentParry || this._getInitialParry()
    this.evaluateTurns = savedTokenData.evaluateTurns || 0
    this.readyTurns = savedTokenData.readyTurns || 0
    this.moveTurns = savedTokenData.moveTurns || 0
    this.blindAsDefault = savedTokenData.blindAsDefault !== undefined ? savedTokenData.blindAsDefault : game.user.isGM

    return this
  }

  async save() {
    const newData = {
      totalActions: this.totalActions,
      totalAttacks: this.totalAttacks,
      totalBlocks: this.totalBlocks,
      totalParries: this.totalParries,
      totalMoves: this.totalMoves,

      extraActions: this.extraActions,
      extraAttacks: this.extraAttacks,
      extraBlocks: this.extraBlocks,
      rapidStrikeBonus: this.rapidStrikeBonus,

      maxParries: this.maxParries,
      maxMove: this.maxMove,

      lastManeuvers: this.lastManeuvers,
      lastAttack: this.lastAttack,

      canDefend: this.canDefend,
      canAttack: this.canAttack,
      canMove: this.canMove,

      toHitBonus: this.toHitBonus,
      defenseBonus: this.defenseBonus,
      concentrateTurns: this.concentrateTurns,
      currentAim: this.currentAim,
      currentParry: this.currentParry,
      evaluateTurns: this.evaluateTurns,
      readyTurns: this.readyTurns,
      moveTurns: this.moveTurns,
      blindAsDefault: this.blindAsDefault,
    }
    await this.token.document.setFlag('gurps', 'tokenActions', newData)
  }

  async saveLastAttack(chatThing, attacker) {
    this.lastAttack = { chatThing, attacker }
    await this.save()
  }

  async clearLastAttack() {
    this.lastAttack = {
      chatThing: null,
      attacker: null,
    }
    await this.save()
  }

  get currentMoveModifier() {
    return this.actor.system.conditions.move
  }
  get currentEffects() {
    return this.actor.system.conditions.self?.modifiers
  }

  _getInitialAim() {
    let currentAim = {}
    recurselist(this.actor.system.ranged, (e, _k, _d) => {
      currentAim[_k] = {
        aimBonus: 0,
        acc: parseInt(e.acc),
        uuid: e.uuid,
        name: e.name,
        originalName: e.originalName,
        startAt: undefined,
        targetToken: undefined,
        key: `system.ranged.${_k}`,
      }
    })
    return currentAim
  }

  _getInitialParry() {
    let currentParry = {}
    recurselist(this.actor.system.melee, (e, _k, _d) => {
      if (!!e.parry) {
        currentParry[_k] = {
          currentPenalty: 0,
          uuid: e.uuid,
          name: e.name,
          originalName: e.originalName,
          mode: e.mode,
          startAt: undefined,
          basePenalty: e.baseParryPenalty,
          key: `system.melee.${_k}`,
        }
      }
    })
    return currentParry
  }

  getMaxMove() {
    let currentMove = this.actor.system.currentmove
    const maneuver = Maneuvers.getManeuver(this.currentManeuver || 'do_nothing')
    const move = maneuver.flags.gurps.move
    switch (move) {
      case MOVE_NONE:
        return 0
      case MOVE_ONE:
        return 1
      case MOVE_STEP:
        return game.i18n.format('GURPS.moveStep', { reason: game.i18n.localize(maneuver.label) })
      case MOVE_TWO_STEPS:
        return game.i18n.format('GURPS.moveTwoSteps', { reason: game.i18n.localize(maneuver.label) })
      case MOVE_ONETHIRD:
        return Math.max(Math.floor(currentMove / 3), 1)
      case MOVE_HALF:
        return Math.max(Math.floor(currentMove / 2), 1)
      case MOVE_TWOTHIRDS:
        return Math.max(Math.floor((currentMove / 3) * 2), 1)
      case MOVE_FULL:
        if (this.currentManeuver === 'move' && this.lastManeuvers[this.currentTurn]?.maneuver === 'move') {
          return currentMove + Math.max(Math.floor(currentMove * 0.2), 1)
        }
        return currentMove
    }
    return currentMove
  }

  /**
   * Return Strong Damage for AoA - Strong (B366)
   *
   * Some examples of damage expected:
   * 1d-1 cr, 2d+1 cut, 1d+2 imp, 1d-1 pi+
   *
   * Rule is to increase damage +2 or +1 per die, which is greater, for ST based damage only.
   *
   * After that, we will use the optional rule (B377) to round damage: +4 points = +1d
   *
   * @param {string} damage
   * @returns {string}
   */
  getStrongDamage(damage) {
    const validTypes = [
      'cr',
      'crush',
      'crushing',
      'piercing',
      'pi',
      'pi+',
      'pi-',
      'pi++',
      'small piercing',
      'piercing-',
      'large piercing',
      'piercing+',
      'huge piercing',
      'piercing++',
      'imp',
      'impaling',
      'cut',
      'cutting',
      'sw',
      'swing',
    ]
    let dice = parseInt(damage.match(/(\d+)d/)?.[1] || 1)
    const add = damage.match(/d([+-]\d+)/)?.[1] || 0
    const damageType = damage.match(/\d\s(.+)/)?.[0] || ''
    if (!validTypes.includes(damageType)) return damage
    let newAdd = parseInt(add) + Math.max(dice, 2)
    while (newAdd >= 4) {
      newAdd -= 4
      dice += 1
    }
    const plus = newAdd > 0 ? '+' : ''
    return `${dice}d${plus}${newAdd !== 0 ? newAdd : ''} ${damageType}`.trim()
  }

  /**
   * Return current Skill level for Move and Attack (B365)
   *
   * @param {int} skillLevel
   * @param {string} attackType
   * @param {int} weaponBulk
   * @returns {number}
   */
  getMoveAndAttackLevel(skillLevel, attackType, weaponBulk = 0) {
    if (attackType === 'melee') {
      return Math.min(skillLevel - 4, 9)
    }
    return Math.min(skillLevel - Math.max(2, weaponBulk), 9)
  }

  /**
   * Remove Effect Modifiers created by the Maneuver.
   *
   * We found the maneuver modifiers by the '#maneuver' tag in effect description.
   *
   * @returns {Promise<void>}
   */
  async removeModifiers() {
    const allModifiers = (await foundry.utils.getProperty(this.actor, 'system.conditions.usermods')) || []
    const nonManeuverModifiers = allModifiers.filter(m => !m.includes('#maneuver'))
    await this.actor.update({ 'system.conditions.usermods': nonManeuverModifiers })
  }

  /**
   * Add Effect Modifiers created by the Maneuver.
   *
   * We mark the maneuver modifiers with the '#maneuver' tag in effect description.
   * And to the source reference, we use the '@man:<maneuverName>' identifier.
   *
   * @returns {Promise<void>}
   */
  async addModifiers() {
    const addModifier = mod => {
      if (!maneuverModifiers.includes(mod) && !allModifiers.includes(mod)) {
        maneuverModifiers.push(mod)
      }
    }

    const allModifiers = await foundry.utils
      .getProperty(this.actor, 'system.conditions.usermods')
      .filter(m => !m.includes('#maneuver') && !m.includes('@eft:'))
    const maneuverModifiers = []
    if (this.toHitBonus !== 0) {
      const signal = this.toHitBonus > 0 ? '+' : '-'
      const signalLabel = game.i18n.localize(signal === '+' ? 'GURPS.toHitBonus' : 'GURPS.toHitPenalty')
      if (this.currentManeuver === 'move_and_attack') {
        addModifier(
          `${signal}${Math.abs(this.toHitBonus)} ${signalLabel} *Max:9 #melee #maneuver @man:${this.currentManeuver}`
        )
        addModifier(
          `${signal}${Math.abs(this.toHitBonus / 2)} ${signalLabel} #ranged #maneuver @man:${this.currentManeuver}`
        )
      } else {
        addModifier(`${signal}${Math.abs(this.toHitBonus)} ${signalLabel} #hit #maneuver @man:${this.currentManeuver}`)
      }
    }
    if (this.evaluateTurns > 0) {
      addModifier(`+${this.evaluateTurns} ${game.i18n.localize('GURPS.toHitBonus')} #hit #maneuver @man:evaluate`)
    }
    if (this.defenseBonus !== 0) {
      const signal = this.defenseBonus > 0 ? '+' : '-'
      const signalLabel = game.i18n.localize(signal === '+' ? 'GURPS.toDefenseBonus' : 'GURPS.toDefensePenalty')
      addModifier(
        `${signal}${Math.abs(this.defenseBonus)} ${signalLabel} #parry #block #dodge #maneuver @man:${this.currentManeuver}`
      )
    }
    if (this.evaluateTurns > 0) {
      addModifier(`+${this.evaluateTurns} ${i18n('GURPS.toHitBonus')} #hit #maneuver @man:evaluate`)
    }
    Object.keys(this.currentParry).map(k => {
      const parry = this.currentParry[k]
      if (parry.currentPenalty !== 0) {
        const signal = parry.currentPenalty > 0 ? '+' : '-'
        const signalLabel = game.i18n.localize(signal === '+' ? 'GURPS.toParryBonus' : 'GURPS.toParryPenalty')
        addModifier(
          `${signal}${Math.abs(parry.currentPenalty)} ${signalLabel} ${parry.name} #parry #maneuver #${parry.mode} @${parry.key}`
        )
      }
    })
    Object.keys(this.currentAim).map(k => {
      const aim = this.currentAim[k]
      if (aim.aimBonus !== 0) {
        const signal = aim.aimBonus > 0 ? '+' : '-'
        const signalLabel = game.i18n.localize(signal === '+' ? 'GURPS.toAimBonus' : 'GURPS.toAimPenalty')
        addModifier(`${signal}${Math.abs(aim.aimBonus)} ${signalLabel} ${aim.name} #hit #maneuver @${aim.key}`)
      }
    })
    await this.actor.update({
      'system.conditions.usermods': [...allModifiers, ...maneuverModifiers],
    })
  }

  resetTurnValues() {
    this.totalMoves = 0
    this.totalBlocks = 0
    this.totalParries = 0
    this.totalActions = 0
    this.totalAttacks = 0
    this.extraAttacks = 0
    this.extraActions = 0
    this.extraBlocks = 0
    this.rapidStrikeBonus = 0
    this.currentParry = this._getInitialParry()
  }

  /**
   * Get Maneuver Modifiers
   *
   * Call this method every time a new maneuver is selected.
   *
   * Every time a maneuver is select, current totals for moves, blocks, parries, actions and attacks are reset.
   *
   * @param {Maneuver} maneuver
   * @param {integer} round
   * @returns {Promise<void>}
   */
  async selectManeuver(maneuver, round) {
    if (round === undefined || round === null) return
    this.currentTurn = round
    if (!this.lastManeuvers[round]) {
      this.lastManeuvers[round] = this._getNewLastManeuvers()
    }
    this.lastManeuvers[round].maneuver = maneuver.flags.gurps.name
    console.info(`Select Maneuver: '${this.currentManeuver}' for Token: ${this.token.name}`)

    await this.removeModifiers()

    this.maxMove = this.getMaxMove()
    this.maxParries = Infinity
    this.maxActions = foundry.utils.getProperty(this.actor, 'system.conditions.actions.maxActions') || 1
    this.maxBlocks = foundry.utils.getProperty(this.actor, 'system.conditions.actions.maxBlocks') || 1

    this.toHitBonus = 0
    this.defenseBonus = 0

    this.resetTurnValues()

    switch (this.currentManeuver) {
      case 'do_nothing':
      case 'change_posture':
      case 'concentrate':
      case 'ready':
        this.canAttack = false
        this.canDefend = true
        this.canMove = false
        break
      case 'move':
      case 'aim':
      case 'evaluate':
      case 'aod_double':
        this.canAttack = false
        this.canDefend = true
        this.canMove = true
        break
      case 'attack':
      case 'wait':
      case 'feint':
        this.canAttack = true
        this.canDefend = true
        this.canMove = true
        break
      case 'aoa_determined':
        this.canAttack = true
        this.canDefend = false
        this.canMove = true
        this.toHitBonus = 4
        break
      case 'aoa_double':
      case 'aoa_feint':
        this.extraAttacks = 1
        this.canAttack = true
        this.canDefend = false
        this.canMove = true
        break
      case 'aoa_strong':
      case 'aoa_suppress':
      case 'allout_attack':
        this.canAttack = true
        this.canDefend = false
        this.canMove = true
        break
      case 'aoa_ranged':
        this.canAttack = true
        this.canDefend = false
        this.canMove = true
        this.toHitBonus = 1
        break
      case 'move_and_attack':
        this.canAttack = true
        this.canDefend = true
        this.canMove = true
        this.maxParries = 0
        this.toHitBonus = -4
        break
      case 'allout_defense':
      case 'aod_dodge':
      case 'aod_parry':
      case 'aod_block':
        this.canAttack = false
        this.canDefend = true
        this.canMove = true
        this.defenseBonus = 2
        break
      // Optional Maneuvers from Pyramid 3/77
      case 'allout_aim':
        this.canAttack = false
        this.canDefend = false
        this.canMove = false
        this.toHitBonus = 4
        break
      case 'committed_aim':
        this.canAttack = false
        this.canDefend = true
        this.canMove = true
        this.defenseBonus = -2
        this.maxParries = 0
        this.maxBlocks = 0
        break
      case 'committed_attack_ranged':
        this.canAttack = true
        this.canDefend = true
        this.canMove = true
        this.defenseBonus = -2
        this.toHitBonus = 1
        break
    }
    await this.addModifiers()
    await this.save()
  }

  /**
   * Create a new turn for the token.
   *
   * Call this method every time a new player turn is started.
   *
   * @param {integer} round
   * @returns {Promise<void>}
   */
  async newTurn(round) {
    // If lastManeuvers[round] exists, it means GM rolls back the turn.
    if (!!this.lastManeuvers[round]) {
      console.info(`Recovering Combat Turn (Foundry Round: ${round}) for Token: ${this.token.name}`)
      await this.selectManeuver(Maneuvers.getManeuver(this.lastManeuvers[round].maneuver), round)
      // Check for Effects marked for this turn
      const effects = this.lastManeuvers[Math.max(round - 1, 0)].nextTurnEffects || []
      for (const effect of effects) {
        await this.token.setEffectActive(effect, true)
      }
      return
    }
    if (!this.lastManeuvers[round]) {
      this.lastManeuvers[round] = this._getNewLastManeuvers()
    }
    console.info(`Starting New Combat Turn (Foundry Round: ${round}) for Token: ${this.token.name}`)
    this.currentTurn = round
    const lastManeuver = foundry.utils.getProperty(this.actor, 'system.conditions.maneuver')
    this.lastManeuvers[round].maneuver = lastManeuver
    this.resetTurnValues()
    this.extraActions = 0
    this.extraAttacks = 0
    this.extraBlocks = 0
    this.maxParries = Infinity
    Object.keys(this.currentParry).map(k => {
      const p = this.currentParry[k]
      p.currentPenalty = 0
    })
    switch (lastManeuver) {
      case 'concentrate':
        console.log(`Add +1 Concentrate bonus to ${this.token.name}`)
        this.concentrateTurns += 1
        break
      case 'ready':
        console.log(`Add +1 Ready bonus to ${this.token.name})`)
        this.readyTurns += 1
        break
      case 'evaluate':
        this.evaluateTurns += 1
        if (this.evaluateTurns > 3) {
          this.evaluateTurns = 3
        } else {
          console.log(`Add +1 Evaluate bonus to ${this.token.name})`)
        }
        break
      case 'move':
        this.moveTurns += 1
        console.log(`Add +1 Move bonus to ${this.token.name})`)
        break
      case 'aim':
        Object.keys(this.currentAim).map(k => {
          const a = this.currentAim[k]
          if (a.startAt === undefined) a.startAt = this.currentTurn - 1
          const acc = parseInt(a.acc || 0)
          const maxAccBonus = acc + 2 // Add here an Acc bonus field on Item like Extra Attack?
          const dif = this.currentTurn - a.startAt
          if (dif === 1) {
            a.aimBonus = acc
          } else if (a.aimBonus < maxAccBonus) {
            a.aimBonus += 1
          }
        })
        break
    }
    if (lastManeuver !== 'evaluate' && this.evaluateTurns > 0) {
      this.evaluateTurns = 0
    }
    if (lastManeuver !== 'aim') {
      this.currentAim = this._getInitialAim()
    }
    if (lastManeuver !== 'move' && this.moveTurns > 0) {
      this.moveTurns = 0
    }
    if (lastManeuver !== 'ready' && this.readyTurns > 0) {
      this.readyTurns = 0
    }
    if (lastManeuver !== 'concentrate' && this.concentrateTurns > 0) {
      this.concentrateTurns = 0
    }
    // Check for Effects marked for this turn
    const effects = this.lastManeuvers[Math.max(round - 1, 0)]?.nextTurnEffects || []
    for (const effect of effects) {
      await this.token.setEffectActive(effect, true)
    }

    await this.addModifiers()
    await this.save()
  }

  static getManeuverIcons(maneuverName) {
    const step = `<i class="fa-solid fa-shoe-prints can-do-icon" title="Step"></i>`
    const half = `<i class="fa-solid fa-lg fa-person-running can-do-icon" title="Half Move"></i>`
    const full = `<i class="fa-solid fa-lg fa-rabbit-running can-do-icon" title="Full Move"></i>`
    const noMove = `<i class="fa-solid fa-ban cant-do-icon" title="No Move"></i>`
    const canAttack = `<i class="fa-solid fa-sword can-do-icon" title="Can Attack"></i>`
    const NoAttack = `<i class="fa-solid fa-ban cant-do-icon" title="Can Not Attack"></i>`
    const canDefend = `<i class="fa-solid fa-shield-check can-do-icon" title="Can Defend"></i>`
    const NoDefense = `<i class="fa-solid fa-ban cant-do-icon" title="Can Not Defend"></i>`

    let icon
    switch (maneuverName) {
      case 'do_nothing':
        icon = `${noMove}${NoAttack}${canDefend}`
        break
      case 'move':
        icon = `${full}${NoAttack}${canDefend}`
        break
      case 'feint':
      case 'evaluate':
      case 'aim':
      case 'concentrate':
      case 'ready':
      case 'committed_aim':
        icon = `${step}${NoAttack}${canDefend}`
        break
      case 'attack':
      case 'committed_attack_ranged':
        icon = `${step}${canAttack}${canDefend}`
        break
      case 'aoa_double':
      case 'aoa_feint':
      case 'aoa_strong':
      case 'aoa_suppress':
      case 'allout_attack':
      case 'aoa_determined':
      case 'allout_aim':
      case 'aoa_ranged':
        icon = `${half}${canAttack}${NoDefense}`
        break
      case 'move_and_attack':
        icon = `${full}${canAttack}${canDefend}`
        break
      case 'aod_double':
      case 'allout_defense':
      case 'aod_dodge':
      case 'aod_parry':
      case 'aod_block':
        icon = `${half}${NoAttack}${canDefend}`
        break
      case 'change_posture':
        icon = `${noMove}${NoAttack}${canDefend}`
        break
      case 'wait':
        icon = `${full}${canAttack}${canDefend}`
        break
      default:
        icon = `${noMove}${NoAttack}${canDefend}` // Do nothing
    }
    return icon
  }
  async removeCombatTempMods() {
    const taggedSettings = game.settings.get(Settings.SYSTEM_NAME, Settings.SETTING_USE_TAGGED_MODIFIERS)
    const combatTempTags = taggedSettings.combatTempTag
      .split(',')
      .map(it => it.trim().toLowerCase())
      .filter(it => !!it)
    if (!combatTempTags.length) return
    const userMods = foundry.utils.getProperty(this.actor, 'system.conditions.usermods')
    const validMods = userMods.filter(m => {
      const tags = m.match(/#(\S+)/g) || []
      return tags.every(t => !combatTempTags.includes(t.toLowerCase()))
    })
    await this.actor.update({ 'system.conditions.usermods': validMods })
  }

  /**
   * Consume Action in Token
   *
   * @param {object} [action]
   * @param {string} chatThing
   * @param {object} [actionObj]
   * @param {boolean} [usingRapidStrike]
   * @returns {Promise<void>}
   */
  async consumeAction(action, chatThing, actionObj, usingRapidStrike = false) {
    if (!this.actor.canConsumeAction(action, chatThing, actionObj)) return
    const actionType = chatThing.match(/(?<=@|)(\w+)(?=:)/g)?.[0].toLowerCase()
    switch (actionType) {
      case 'b':
        this.totalBlocks += 1
        break
      case 'p':
        const settingsAddParryMods = game.settings.get(
          Settings.SYSTEM_NAME,
          Settings.SETTING_ADD_CUMULATIVE_PARRY_PENALTIES
        )
        if (settingsAddParryMods) {
          this.totalParries += 1
          const nameRegex = /(?<="|:).+(?=\s\(|"|])/gm
          let name = chatThing.match(nameRegex)?.[0]
          if (name) name = name.replace(/"/g, '').split('(')[0].trim()
          const modeRegex = /(?<=\().+(?=\))/gm
          let mode = chatThing.match(modeRegex)?.[0] || ''
          this.currentParry = Object.keys(this.currentParry).reduce((acc, k) => {
            let parry = this.currentParry[k]
            if (name.includes(parry.name) && mode.includes(parry.mode)) {
              parry.currentPenalty += parry.basePenalty
            }
            acc[k] = parry
            return acc
          }, {})
        }
        break
      case 'm':
      case 'r':
        this.totalActions += 1
        this.totalAttacks += 1
        if (usingRapidStrike && this.rapidStrikeBonus < 1) {
          console.log(`Adding Rapid Strike Bonus to token: ${this.token.name}`)
          this.rapidStrikeBonus += 1
        }
        break
      default:
        this.totalActions += 1
        break
    }
    await this.addModifiers()
    await this.save()
  }

  /**
   * Include Effects for next turn
   *
   * @param {string[]} effectNames
   * @returns {Promise<boolean>}
   */
  async addToNextTurn(effectNames) {
    const index = Math.max(this.currentTurn, 0)
    if (!this.lastManeuvers[index]) this.lastManeuvers[index] = this._getNewLastManeuvers()
    if (!this.lastManeuvers[index]?.nextTurnEffects) {
      this.lastManeuvers[index].nextTurnEffects = effectNames
    } else {
      for (const effectName of effectNames) {
        if (!this.lastManeuvers[index].nextTurnEffects.includes(effectName)) {
          this.lastManeuvers[index].nextTurnEffects.push(effectName)
        }
      }
    }
    await this.save()
  }

  getNextTurnEffects() {
    return this.lastManeuvers[this.currentTurn]?.nextTurnEffects || []
  }

  /**
   * Remove Effects marked for next turn
   *
   * @param {string[]} effectNames
   * @returns {Promise<void>}
   */
  async removeFromNextTurn(effectNames) {
    if (!this.lastManeuvers[this.currentTurn]) this.lastManeuvers[this.currentTurn] = this._getNewLastManeuvers()
    const markedEffects = this.lastManeuvers[this.currentTurn]?.nextTurnEffects || []
    this.lastManeuvers[this.currentTurn].nextTurnEffects = markedEffects.filter(e => !effectNames.includes(e))
    await this.save()
  }
}
