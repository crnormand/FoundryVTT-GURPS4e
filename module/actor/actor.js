'use strict'

import {
  recurselist,
  makeRegexPatternFrom,
  i18n,
  i18n_f,
  splitArgs,
  generateUniqueId,
  objectToArray,
  arrayToObject,
  zeroFill,
} from '../../lib/utilities.js'
import { parselink, COSTS_REGEX } from '../../lib/parselink.js'
import { ResourceTrackerManager } from './resource-tracker-manager.js'
import ApplyDamageDialog from '../damage/applydamage.js'
import * as HitLocations from '../hitlocation/hitlocation.js'
import Maneuvers, {
  MOVE_NONE,
  MOVE_ONE,
  MOVE_STEP,
  MOVE_TWO_STEPS,
  MOVE_ONETHIRD,
  MOVE_HALF,
  MOVE_TWOTHIRDS,
  PROPERTY_MOVEOVERRIDE_MANEUVER,
  PROPERTY_MOVEOVERRIDE_POSTURE,
} from './maneuver.js'
import { GurpsItem } from '../item.js'
import { Advantage, Equipment, HitLocationEntry, Melee, Ranged, Skill, Spell } from './actor-components.js'
import { multiplyDice } from '../utilities/damage-utils.js'
import * as settings from '../../lib/miscellaneous-settings.js'
import { ActorImporter } from './actor-importer.js'
import { HitLocation } from '../hitlocation/hitlocation.js'
import * as Settings from '../../lib/miscellaneous-settings.js'
import { TokenActions } from '../token-actions.js'
import { cleanTags, getRangedModifier } from './effect-modifier-popout.js'

// Ensure that ALL actors has the current version loaded into them (for migration purposes)
Hooks.on('createActor', async function (/** @type {Actor} */ actor) {
  await actor.internalUpdate({ '_stats.systemVersion': game.system.version })
})

export const MoveModes = {
  Ground: 'GURPS.moveModeGround',
  Air: 'GURPS.moveModeAir',
  Water: 'GURPS.moveModeWater',
  Space: 'GURPS.moveModeSpace',
}

export class GurpsActor extends Actor {
  /** @override */
  getRollData() {
    const data = super.getRollData()
    return data
  }

  /**
   * @returns {GurpsActor}
   */
  asGurpsActor() {
    // @ts-ignore
    return /** @type {GurpsActor} */ (this)
  }

  // Return collection os Users that have ownership on this actor
  getOwners() {
    return game.users?.contents.filter(u => this.getUserLevel(u) >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)
  }

  // 0.8.x added steps necessary to switch sheets
  /**
   * @param {Application} newSheet
   */
  async openSheet(newSheet) {
    const sheet = this.sheet
    if (sheet) {
      await sheet.close()
      this._sheet = null
      delete this.apps[sheet.appId]
      await this.setFlag('core', 'sheetClass', newSheet)
      this.ignoreRender = false
      this.sheet.render(true)
    }
  }

  prepareData() {
    super.prepareData()
    // By default, it does this:
    // this.data.reset()
    // this.prepareBaseData()
    // this.prepareEmbeddedEntities()
    // this.prepareDerivedData()
  }

  prepareBaseData() {
    super.prepareBaseData()

    this.system.conditions.posture = 'standing'
    this.system.conditions.self = { modifiers: [] }
    this.system.conditions.target = { modifiers: [] }
    this.system.conditions.exhausted = false
    this.system.conditions.reeling = false

    {
      // Oh how I wish we had a typesafe model!
      // I hate treating everything as "maybe its a number, maybe its a string...?!"

      let sizemod = this.system.traits?.sizemod?.toString() || '+0'
      if (sizemod.match(/^\d/g)) sizemod = `+${sizemod}`
      if (sizemod !== '0' && sizemod !== '+0') {
        this.system.conditions.target.modifiers.push(
          i18n_f('GURPS.modifiersSize', { sm: sizemod }, '{sm} for Size Modifier')
        )
      }
    }

    let attributes = this.system.attributes
    if (foundry.utils.getType(attributes.ST.import) === 'string')
      this.system.attributes.ST.import = parseInt(attributes.ST.import)

    this.system.hitlocationNames = this.hitLocationByWhere
    for (const location in this.system.hitlocationNames) {
      if (typeof this.system.hitlocationNames[location].import === 'string') {
        this.system.hitlocationNames[location].import = parseInt(this.system.hitlocationNames[location].import)
      }
    }

    this.system.trackersByName = this.trackersByName
  }

  prepareEmbeddedEntities() {
    // Calls this.applyActiveEffects()
    super.prepareEmbeddedEntities()
  }

  prepareDerivedData() {
    super.prepareDerivedData()

    // Handle new move data -- if data.move exists, use the default value in that object to set the move
    // value in the first entry of the encumbrance object.
    if (this.system.encumbrance) {
      let move = this.system.move
      if (!move) {
        let currentMove = this.system.encumbrance['00000'].move ?? this.system.basicmove.value
        let value = { mode: MoveModes.Ground, basic: currentMove, default: true }
        foundry.utils.setProperty(this.system, 'move.00000', value)
        move = this.system.move
      }

      let current = Object.values(move).find(it => it.default)
      if (current) {
        // This is nonpersistent, derived values only.
        this.system.encumbrance['00000'].move = current.basic
      }
    }

    this.calculateDerivedValues()
  }

  // execute after every import.
  async postImport() {
    this.calculateDerivedValues()

    // Convoluted code to add Items (and features) into the equipment list
    // @ts-ignore
    let orig = /** @type {GurpsItem[]} */ (
      this.items.contents
        .filter(i => i.type === 'equipment')
        .slice()
        .sort((a, b) => b.name.localeCompare(a.name))
    ) // in case items are in the same list... add them alphabetically
    /**
     * @type {any[]}
     */
    let good = []
    while (orig.length > 0) {
      // We are trying to place 'parent' items before we place 'children' items
      let left = []
      let atLeastOne = false
      for (const i of orig) {
        // @ts-ignore
        if (!i.system.eqt.parentuuid || good.find(e => e.system.eqt.uuid == i.system.eqt.parentuuid)) {
          atLeastOne = true
          good.push(i) // Add items in 'parent' order... parents before children (so children can find parent when inserted into list)
        } else left.push(i)
      }
      if (atLeastOne) orig = left
      else {
        // if unable to move at least one, just copy the rest and hope for the best
        good = [...good, ...left]
        orig = []
      }
    }
    for (const item of good) await this.addItemData(item) // re-add the item equipment and features

    await this.internalUpdate({ '_stats.systemVersion': game.system.version }, { diff: false, render: false })
    // Set custom trackers based on templates.  should be last because it may need other data to initialize...
    await this.setResourceTrackers()
    await this.syncLanguages()

    // If using Foundry Items we can remove Modifier Effects from Actor Components
    const userMods = foundry.utils.getProperty(this.system, 'conditions.usermods') || []
    if (game.settings.get(settings.SYSTEM_NAME, settings.SETTING_USE_FOUNDRY_ITEMS)) {
      const validMods = userMods.filter(m => !m.includes('@system.'))
      await this.update({ 'system.conditions.usermods': validMods })
    } else {
      // If not using Foundry Items, we can remove Modifier Effects from Item Effects
      const validMods = userMods.filter(m => m.includes('@system.') || m.includes('@man:') || m.includes('@custom'))
      await this.update({ 'system.conditions.usermods': validMods })
    }
    // If Actor does not have system.conditions.actions, create it
    if (!this.system.conditions.actions) {
      await this.internalUpdate({
        'system.conditions.actions': {
          maxActions: 1,
          maxBlocks: 1,
        },
      })
    }

    if (canvas.tokens.controlled.length > 0) {
      await canvas.tokens.controlled[0].document.setFlag('gurps', 'lastUpdate', new Date().getTime().toString())
    }
  }

  // Ensure Language Advantages conform to a standard (for Polygot module)
  async syncLanguages() {
    if (this.system.languages) {
      let updated = false
      let newads = { ...this.system.ads }
      let langn = /Language:?/i
      let langt = new RegExp(i18n('GURPS.language') + ':?', 'i')
      recurselist(this.system.languages, (e, _k, _d) => {
        let a = GURPS.findAdDisad(this, '*' + e.name) // is there an Adv including the same name
        if (a) {
          if (!a.name.match(langn) && !a.name.match(langt)) {
            // GCA4/GCS style
            a.name = i18n('GURPS.language') + ': ' + a.name
            updated = true
          }
        } else {
          // GCA5 style (Language without Adv)
          let n = i18n('GURPS.language') + ': ' + e.name
          if (e.spoken == e.written)
            // If equal, then just report single level
            n += ' (' + e.spoken + ')'
          else if (e.spoken)
            // Otherwise, report type and level (like GCA4)
            n += ' (' + i18n('GURPS.spoken') + ') (' + e.spoken + ')'
          else n += ' (' + i18n('GURPS.written') + ') (' + e.written + ')'
          let a = new Advantage()
          a.name = n
          a.points = e.points
          GURPS.put(newads, a)
          updated = true
        }
      })
      if (updated) {
        await this.internalUpdate({ 'system.ads': newads })
      }
    }
  }

  // This will ensure that every character at least starts with these new data values. actor-sheet.js may change them.
  calculateDerivedValues() {
    let saved = !!this.ignoreRender
    this.ignoreRender = true
    this._initializeStartingValues()
    this._applyItemBonuses()

    // Must be done after bonuses, but before weights
    this._calculateEncumbranceIssues()

    // Must be after bonuses and encumbrance effects on ST
    this._recalcItemFeatures()
    this._calculateRangedRanges()

    // Must be done at end
    this._calculateWeights()

    let maneuver = this.effects.contents.find(it => it.statuses.find(s => s === 'maneuver'))
    this.system.conditions.maneuver = maneuver ? maneuver.flags.gurps.name : 'undefined'

    if (!this.system.equippedparry) this.system.equippedparry = this.getEquippedParry()
    if (!this.system.equippedblock) this.system.equippedblock = this.getEquippedBlock()
    // Catch for older actors that may not have these values set.
    if (!this.system.currentmove) this.system.currentmove = parseInt(this.system.basicmove.value.toString())
    if (!this.system.currentdodge && this.system.dodge.value)
      this.system.currentdodge = parseInt(this.system.dodge.value.toString())
    if (!this.system.currentflight) this.system.currentflight = parseFloat(this.system.basicspeed.value.toString()) * 2

    // Look for Defense bonuses.
    if (!this.system.defenses) this.system.defenses = this.getEquippedDefenseBonuses()

    this.ignoreRender = saved
    if (!saved) setTimeout(() => this._forceRender(), 333)
  }

  // Initialize the attribute starting values/levels.   The code is expecting 'value' or 'level' for many things, and instead of changing all of the GUIs and OTF logic
  // we are just going to switch the rug out from underneath.   "Import" data will be in the 'import' key and then we will calculate value/level when the actor is loaded.
  _initializeStartingValues() {
    const data = this.system
    data.currentdodge = 0 // start at zero, and bonuses will add, and then they will be finalized later
    if (!!data.equipment && !data.equipment.carried) data.equipment.carried = {} // data protection
    if (!!data.equipment && !data.equipment.other) data.equipment.other = {}

    // Attributes need to have 'value' set because Foundry expects objs with value and max to be attributes (so we can't use currentvalue)
    // Need to protect against data errors
    for (const attr in data.attributes) {
      if (typeof data.attributes[attr] === 'object' && data.attributes[attr] !== null)
        if (isNaN(data.attributes[attr].import)) data.attributes[attr].value = 0
        else data.attributes[attr].value = parseInt(data.attributes[attr].import)
    }
    // After all of the attributes are copied over, apply tired to ST
    // if (!!data.conditions.exhausted)
    //   data.attributes.ST.value = Math.ceil(parseInt(data.attributes.ST.value.toString()) / 2)
    recurselist(data.skills, (e, _k, _d) => {
      // @ts-ignore
      if (e.import) e.level = parseInt(+e.import)
    })
    recurselist(data.spells, (e, _k, _d) => {
      // @ts-ignore
      if (e.import) e.level = parseInt(+e.import)
    })

    // we don't really need to use recurselist for melee/ranged... but who knows, they may become hierarchical in the future
    recurselist(data.melee, (e, _k, _d) => {
      if (e.import) {
        e.level = parseInt(e.import)
        if (!isNaN(parseInt(e.parry))) {
          // allows for '14f' and 'no'
          let base = 3 + Math.floor(e.level / 2)
          let bonus = parseInt(e.parry) - base
          if (bonus != 0) {
            e.parrybonus = (bonus > 0 ? '+' : '') + bonus
          }
        }
        if (!isNaN(parseInt(e.block))) {
          let base = 3 + Math.floor(e.level / 2)
          let bonus = parseInt(e.block) - base
          if (bonus != 0) {
            e.blockbonus = (bonus > 0 ? '+' : '') + bonus
          }
        }
      } else {
        e.parrybonus = e.parry
        e.blockbonus = e.block
      }
    })

    recurselist(data.ranged, (e, _k, _d) => {
      e.level = parseInt(e.import)
    })

    recurselist(data.hitlocations, (e, _k, _d) => {
      if (!e.dr) e.dr = e.import
    })
  }

  /**
   * Remove Item Effects for informed reference
   * @param {string} reference - item.id or system.<path>
   * @returns {Promise<void>}
   */
  async removeModEffectFor(reference) {
    let userMods = foundry.utils.getProperty(this.system, 'conditions.usermods') || []
    let newMods = userMods.filter(m => !m.includes(reference) || m.includes('@man:') || !m.includes('@eft:'))
    await this.internalUpdate({ 'system.conditions.usermods': newMods })
  }

  /**
   * Add Actor Modifier Effects from Character Sheet
   * @param {object} commit
   * @param {boolean} append
   * @returns {object}
   */
  applyItemModEffects(commit, append = false) {
    const allUserMods = append ? foundry.utils.getProperty(this.system, 'conditions.usermods') || [] : []
    const userMods = allUserMods.filter(m => !m.includes('@eft:'))
    let newMods = []

    if (game.settings.get(settings.SYSTEM_NAME, settings.SETTING_USE_FOUNDRY_ITEMS)) {
      // First Resolve Actor Items
      for (const item of this.items.contents) {
        const itemData = GurpsItem.asGurpsItem(item)
        if (itemData.system.itemModifiers?.length > 0) {
          const allEffects = itemData.system.itemModifiers.split('\n').map(m => m.trim())
          for (const effect of allEffects) {
            const fullDesc = `${effect} @${item.id}`
            if (!userMods.includes(fullDesc)) {
              newMods.push(fullDesc)
            }
          }
        }
      }
      // Then Melee and Ranged Actor Components
      const paths = ['melee', 'ranged']
      for (const path of paths) {
        recurselist(this.system[path], (e, _k, _d) => {
          if (!!e.itemModifiers) {
            const allEffects = e.itemModifiers.split('\n').map(m => m.trim())
            for (const effect of allEffects) {
              const fullDesc = `${effect} @system.${path}.${_k}`
              if (!userMods.includes(fullDesc)) {
                newMods.push(fullDesc)
              }
            }
          }
        })
      }
    } else {
      const paths = ['melee', 'ranged', 'ads', 'skills', 'spells', 'equipment.carried', 'equipment.other']
      for (const path of paths) {
        const fullPath = `system.${path}`
        const data = foundry.utils.getProperty(this, fullPath)
        recurselist(data, (e, _k, _d) => {
          if (!!e.itemModifiers) {
            const allEffects = e.itemModifiers.split('\n').map(m => m.trim())
            for (const effect of allEffects) {
              const fullDesc = `${effect} @system.${path}.${_k}`
              if (!userMods.includes(fullDesc)) {
                newMods.push(fullDesc)
              }
            }
          }
        })
      }
    }
    return {
      ...commit,
      'system.conditions.usermods': [...userMods, ...newMods],
    }
  }

  _applyItemBonuses() {
    let pi = (/** @type {string | undefined} */ n) => (!!n ? parseInt(n) : 0)
    /** @type {string[]} */
    let gids = [] //only allow each global bonus to add once
    const data = this.system

    for (const item of this.items.contents) {
      let itemData = GurpsItem.asGurpsItem(item).system

      if (
        (item.type !== 'equipment' || (itemData.equipped && itemData.carried)) &&
        !!itemData.bonuses &&
        !gids.includes(itemData.globalid)
      ) {
        gids.push(itemData.globalid)
        let bonuses = itemData.bonuses.split('\n')

        for (let bonus of bonuses) {
          let m = bonus.match(/\[(.*)\]/)
          if (m) bonus = m[1] // remove extranious  [ ]
          let link = parselink(bonus) // ATM, we only support attribute and skill

          if (link.action) {
            // start OTF
            recurselist(data.melee, (e, _k, _d) => {
              e.level = pi(e.level)
              if (link.action.type == 'attribute' && link.action.attrkey == 'DX') {
                // All melee attack skills affected by DX
                e.level += pi(link.action.mod)
                if (!isNaN(parseInt(e.parry))) {
                  // handles '11f'
                  let m = (e.parry + '').match(/(\d+)(.*)/)
                  e.parry = 3 + Math.floor(e.level / 2)
                  if (!!e.parrybonus) e.parry += pi(e.parrybonus)
                  if (!!m) e.parry += m[2]
                }

                if (!isNaN(parseInt(e.block))) {
                  // handles 'no'
                  e.block = 3 + Math.floor(e.level / 2)
                  if (!!e.blockbonus) e.block += pi(e.blockbonus)
                }
              }
              if (link.action.type == 'attack' && !!link.action.isMelee) {
                if (e.name.match(makeRegexPatternFrom(link.action.name, false))) {
                  e.level += pi(link.action.mod)
                  if (!isNaN(parseInt(e.parry))) {
                    // handles '11f'
                    let m = (e.parry + '').match(/(\d+)(.*)/)
                    e.parry = 3 + Math.floor(e.level / 2)
                    if (!!e.parrybonus) e.parry += pi(e.parrybonus)
                    if (!!m) e.parry += m[2]
                  }
                  if (!isNaN(parseInt(e.block))) {
                    // handles 'no'
                    e.block = 3 + Math.floor(e.level / 2)
                    if (!!e.blockbonus) e.block += pi(e.blockbonus)
                  }
                }
              }
            }) // end melee

            recurselist(data.ranged, (e, _k, _d) => {
              e.level = pi(e.level)
              if (link.action.type == 'attribute' && link.action.attrkey == 'DX') e.level += pi(link.action.mod)
              if (link.action.type == 'attack' && !!link.action.isRanged) {
                if (e.name.match(makeRegexPatternFrom(link.action.name, false))) e.level += pi(link.action.mod)
              }
            }) // end ranged

            recurselist(data.skills, (e, _k, _d) => {
              e.level = pi(e.level)
              if (link.action.type == 'attribute') {
                // skills affected by attribute changes
                if (e.relativelevel?.toUpperCase().startsWith(link.action.attrkey)) e.level += pi(link.action.mod)
              }
              if (link.action.type == 'skill-spell' && !link.action.isSpellOnly) {
                if (e.name.match(makeRegexPatternFrom(link.action.name, false))) e.level += pi(link.action.mod)
              }
            }) // end skills

            recurselist(data.spells, (e, _k, _d) => {
              e.level = pi(e.level)
              if (link.action.type == 'attribute') {
                // spells affected by attribute changes
                if (e.relativelevel?.toUpperCase().startsWith(link.action.attrkey)) e.level += pi(link.action.mod)
              }
              if (link.action.type == 'skill-spell' && !link.action.isSkillOnly) {
                if (e.name.match(makeRegexPatternFrom(link.action.name, false))) e.level += pi(link.action.mod)
              }
            }) // end spells

            if (link.action.type == 'attribute') {
              let paths = link.action.path.split('.')
              let last = paths.pop()
              let data = this.system
              if (paths.length > 0) data = foundry.utils.getProperty(data, paths.join('.'))
              // regular attributes have a path
              else {
                // only accept DODGE
                if (link.action.attrkey != 'DODGE') break
              }
              data[last] = pi(data[last]) + pi(link.action.mod) // enforce that attribute is int
            } // end attributes & Dodge
          } // end OTF

          // parse bonus for other forms, DR+x?
          m = bonus.match(/DR *([+-]\d+) *(.*)/) // DR+1 *Arms "Left Leg" ...
          if (!!m) {
            let delta = parseInt(m[1])
            let locpatterns = null
            if (!!m[2]) {
              let locs = splitArgs(m[2])
              locpatterns = locs.map(l => new RegExp(makeRegexPatternFrom(l), 'i'))
            }
            recurselist(data.hitlocations, (e, _k, _d) => {
              // console.log(e, _k, _d)
              if (!locpatterns || locpatterns.find(p => !!e.where && e.where.match(p)) != null) {
                let dr = e.dr ?? ''
                dr += ''
                let m = dr.match(/(\d+) *([/\|]) *(\d+)/) // check for split DR 5|3 or 5/3
                if (!!m) {
                  dr = parseInt(m[1]) + delta
                  let dr2 = parseInt(m[3]) + delta
                  e.dr = dr + m[2] + dr2
                } else if (!isNaN(parseInt(dr))) {
                  e.dr = parseInt(dr) + delta
                  if (!!e.drCap && e.dr > e.drCap) e.dr = e.drCap
                }
                //console.warn(e.where, e.dr)
              }
            })
          } // end DR
        }
      }
    }
  }

  /**
   * @param {string} key
   * @param {any} id
   * @returns {string | undefined}
   */
  _findEqtkeyForId(key, id) {
    var eqtkey
    let data = this.system
    recurselist(data.equipment.carried, (e, k, _d) => {
      if (e[key] == id) eqtkey = 'system.equipment.carried.' + k
    })
    if (!eqtkey)
      recurselist(data.equipment.other, (e, k, _d) => {
        if (e[key] == id) eqtkey = 'system.equipment.other.' + k
      })
    return eqtkey
  }

  /**
   * Finds the actor component key corresponding to the given ID.
   *
   * @param {string} key - The key to search for in the trait objects.
   * @param {string | number} id - The ID to match within the trait objects.
   * @param {string} sysKey - The system.<key> to use for the search.
   * @param {boolean} include - Whether to check equal or include in the search
   * @return {string | undefined} The trait key if found, otherwise undefined.
   */
  _findSysKeyForId(key, id, sysKey, include = false) {
    let traitKey
    let data = this.system
    recurselist(data[sysKey], (e, k, _d) => {
      const exists = include ? !!e[key]?.includes(id) : e[key] === id
      if (exists) traitKey = `system.${sysKey}.` + k
    })
    return traitKey
  }

  /**
   * @param {{ [key: string]: any }} dict
   * @param {string} type
   * @returns {number}
   */
  _sumeqt(dict, type, checkEquipped = false) {
    if (!dict) return 0.0
    let flt = (/** @type {string} */ str) => (!!str ? parseFloat(str) : 0)
    let sum = 0
    for (let k in dict) {
      let e = dict[k]
      let c = flt(e.count)
      let t = flt(e[type])
      if (!checkEquipped || !!e.equipped) sum += c * t
      sum += this._sumeqt(e.contains, type, checkEquipped)
      sum += this._sumeqt(e.collapsed, type, checkEquipped)
    }
    // @ts-ignore
    return parseInt(sum * 100) / 100
  }

  _calculateWeights() {
    let data = this.system
    let eqt = data.equipment || {}
    let eqtsummary = {
      eqtcost: this._sumeqt(eqt.carried, 'cost'),
      eqtlbs: this._sumeqt(
        eqt.carried,
        'weight',
        game.settings.get(settings.SYSTEM_NAME, settings.SETTING_CHECK_EQUIPPED)
      ),
      othercost: this._sumeqt(eqt.other, 'cost'),
      otherlbs: this._sumeqt(eqt.other, 'weight'),
    }
    if (game.settings.get(settings.SYSTEM_NAME, settings.SETTING_AUTOMATIC_ENCUMBRANCE))
      this.checkEncumbance(eqtsummary.eqtlbs)
    data.eqtsummary = eqtsummary
  }

  _calculateEncumbranceIssues() {
    const data = this.system
    const encs = data.encumbrance
    const isReeling = !!data.conditions.reeling
    const isTired = !!data.conditions.exhausted

    // We must assume that the first level of encumbrance has the finally calculated move and dodge settings
    if (!!encs) {
      const level0 = encs[zeroFill(0)] // if there are encumbrances, there will always be a level0
      let effectiveMove = parseInt(level0.move)
      let effectiveDodge = isNaN(parseInt(level0.dodge)) ? '–' : parseInt(level0.dodge) + data.currentdodge
      let effectiveSprint = this._getSprintMove()

      if (isReeling) {
        effectiveMove = Math.ceil(effectiveMove / 2)
        effectiveDodge = isNaN(effectiveDodge) ? '–' : Math.ceil(effectiveDodge / 2)
        effectiveSprint = Math.ceil(effectiveSprint / 2)
      }

      if (isTired) {
        effectiveMove = Math.ceil(effectiveMove / 2)
        effectiveDodge = isNaN(effectiveDodge) ? '–' : Math.ceil(effectiveDodge / 2)
        effectiveSprint = Math.ceil(effectiveSprint / 2)
      }

      for (let enckey in encs) {
        let enc = encs[enckey]
        if (!enc.level) enc.level = parseInt(enckey) // FIXME: Why enc.level=NaN after GCA import?
        let threshold = 10 - 2 * parseInt(enc.level) // each encumbrance level reduces move by 20%
        threshold /= 10 // JS likes to calculate 0.2*3 = 3.99999, but handles 2*3/10 fine.
        enc.currentmove = this._getCurrentMove(effectiveMove, threshold) //Math.max(1, Math.floor(m * t))
        enc.currentdodge = isNaN(effectiveDodge) ? '–' : Math.max(1, effectiveDodge - parseInt(enc.level))
        enc.currentsprint = Math.max(1, Math.floor(effectiveSprint * threshold))
        enc.currentmovedisplay = enc.currentmove
        // TODO remove additionalresources.showflightmove
        // if (!!data.additionalresources?.showflightmove)
        enc.currentmovedisplay = this._isEnhancedMove() ? enc.currentmove + '/' + enc.currentsprint : enc.currentmove
        if (enc.current) {
          // Save the global move/dodge
          data.currentmove = enc.currentmove
          data.currentdodge = enc.currentdodge
          data.currentsprint = enc.currentsprint
        }
      }
    }
  }

  _isEnhancedMove() {
    return !!this._getCurrentMoveMode()?.enhanced
  }

  _getSprintMove() {
    let current = this._getCurrentMoveMode()
    if (!current) return 0
    if (current?.enhanced) return current.enhanced
    return Math.floor(current.basic * 1.2)
  }

  _getCurrentMoveMode() {
    let move = this.system.move
    let current = Object.values(move).find(it => it.default)
    if (!current && Object.keys(move).length > 0) return move['00000']
    return current
  }

  /**
   * @param {number} move
   * @param {number} threshold
   * @returns {number}
   */
  _getCurrentMove(move, threshold) {
    let inCombat = false
    try {
      inCombat = !!game.combat?.combatants.filter(c => c.actorId == this.id)
    } catch (err) {} // During game startup, an exception is being thrown trying to access 'game.combat'
    let updateMove = game.settings.get(settings.SYSTEM_NAME, settings.SETTING_MANEUVER_UPDATES_MOVE) && inCombat

    let maneuver = this._getMoveAdjustedForManeuver(move, threshold)
    let posture = this._getMoveAdjustedForPosture(move, threshold)

    if (threshold == 1.0) this.system.conditions.move = maneuver.move < posture.move ? maneuver.text : posture.text
    return updateMove
      ? maneuver.move < posture.move
        ? maneuver.move
        : posture.move
      : Math.max(1, Math.floor(move * threshold))
  }

  _getMoveAdjustedForManeuver(move, threshold) {
    let adjustment = null

    if (foundry.utils.getProperty(this, PROPERTY_MOVEOVERRIDE_MANEUVER)) {
      let value = foundry.utils.getProperty(this, PROPERTY_MOVEOVERRIDE_MANEUVER)
      let mv = GURPS.Maneuvers.get(this.system.conditions.maneuver)
      let reason = !!mv ? i18n(mv.label) : ''

      adjustment = this._adjustMove(move, threshold, value, reason)
    }
    return !!adjustment
      ? adjustment
      : {
          move: Math.max(1, Math.floor(move * threshold)),
          text: i18n('GURPS.moveFull'),
        }
  }

  _adjustMove(move, threshold, value, reason) {
    switch (value.toString()) {
      case MOVE_NONE:
        return {
          move: 0,
          // text: i18n_f('GURPS.moveNone', { reason: reason })
          text: i18n_f('None'),
        }

      case MOVE_ONE:
        return {
          move: 1,
          text: '1 yd/sec',
          //          text: i18n_f('GURPS.moveConstant', { value: 1, unit: 'yard', reason: reason }, '1 {unit}/second'),
        }

      case MOVE_STEP:
        return {
          move: this._getStep(),
          text: 'Step',
          //  text: i18n_f('GURPS.moveStep', { reason: reason })
        }

      case MOVE_TWO_STEPS:
        return {
          move: this._getStep() * 2,
          text: 'Step or Two',
          //          text: i18n_f('GURPS.moveTwoSteps', { reason: reason })
        }

      case MOVE_ONETHIRD:
        return {
          move: Math.max(1, Math.ceil((move / 3) * threshold)),
          text: '×1/3',
          //          text: i18n_f('GURPS.moveOneThird', { reason: reason }),
        }

      case MOVE_HALF:
        return {
          move: Math.max(1, Math.ceil((move / 2) * threshold)),
          text: 'Half',
          //          text: i18n_f('GURPS.moveHalf', { reason: reason }),
        }

      case MOVE_TWOTHIRDS:
        return {
          move: Math.max(1, Math.ceil(((2 * move) / 3) * threshold)),
          text: '×2/3',
          //          text: i18n_f('GURPS.moveTwoThirds', { reason: reason }),
        }
    }

    return null
  }

  _getMoveAdjustedForPosture(move, threshold) {
    let adjustment = null

    if (foundry.utils.getProperty(this, PROPERTY_MOVEOVERRIDE_POSTURE)) {
      let value = foundry.utils.getProperty(this, PROPERTY_MOVEOVERRIDE_POSTURE)
      let reason = i18n(GURPS.StatusEffect.lookup(this.system.conditions.posture).name)
      adjustment = this._adjustMove(move, threshold, value, reason)
    }

    return !!adjustment
      ? adjustment
      : {
          move: Math.max(1, Math.floor(move * threshold)),
          text: i18n('GURPS.moveFull'),
        }
  }

  _calculateRangedRanges() {
    if (!game.settings.get(settings.SYSTEM_NAME, settings.SETTING_CONVERT_RANGED)) return
    let st = +this.system.attributes.ST.value
    recurselist(this.system.ranged, r => {
      let rng = r.range || '' // Data protection
      rng = rng + '' // force to string
      let m = rng.match(/^ *[xX]([\d\.]+) *$/)
      if (m) {
        rng = parseFloat(m[1]) * st
      } else {
        m = rng.match(/^ *[xX]([\d\.]+) *\/ *[xX]([\d\.]+) *$/)
        if (m) {
          let r1 = parseFloat(m[1]) * st
          let r2 = parseFloat(m[2]) * st
          rng = `${parseInt(r1)}/${parseInt(r2)}`
        }
      }
      r.range = rng
    })
  }

  // Once all of the bonuses are applied, determine the actual level for each feature
  _recalcItemFeatures() {
    let data = this.system
    this._collapseQuantumEq(data.melee, true)
    this._collapseQuantumEq(data.ranged)
    this._collapseQuantumEq(data.skills)
    this._collapseQuantumEq(data.spells)
  }

  // convert Item feature OTF formulas into actual skill levels.
  /**
   * @param {Object} list
   */
  _collapseQuantumEq(list, isMelee = false) {
    recurselist(list, async e => {
      let otf = e.otf
      if (!!otf) {
        let m = otf.match(/\[(.*)\]/)
        if (!!m) otf = m[1] // remove extranious  [ ]
        if (otf.match(/^ *\d+ *$/)) {
          // just a number
          e.import = parseInt(otf)
        } else {
          let action = parselink(otf)
          if (!!action.action) {
            this.ignoreRender = true
            action.action.calcOnly = true
            GURPS.performAction(action.action, this).then(ret => {
              // @ts-ignore
              e.level = ret.target
              if (isMelee) {
                if (!isNaN(parseInt(e.parry))) {
                  let p = '' + e.parry
                  let m = p.match(/([+-]\d+)(.*)/)
                  // @ts-ignore
                  if (!m && p.trim() == '0') m = [0, 0] // allow '0' to mean 'no bonus', not skill level = 0
                  if (!!m) {
                    e.parrybonus = parseInt(m[1])
                    e.parry = e.parrybonus + 3 + Math.floor(e.level / 2)
                  }
                  if (!!m && !!m[2]) e.parry = `${e.parry}${m[2]}`
                }
                if (!isNaN(parseInt(e.block))) {
                  let b = '' + e.block
                  let m = b.match(/([+-]\d+)(.*)/)
                  // @ts-ignore
                  if (!m && b.trim() == '0') m = [0, 0] // allow '0' to mean 'no bonus', not skill level = 0
                  if (!!m) {
                    e.blockbonus = parseInt(m[1])
                    e.block = e.blockbonus + 3 + Math.floor(e.level / 2)
                  }
                  if (!!m && !!m[2]) e.block = `${e.block}${m[2]}`
                }
              }
            })
          }
        }
      }
    })
  }

  _getStep() {
    let step = Math.ceil(parseInt(this.system.basicmove.value.toString()) / 10)
    return Math.max(1, step)
  }

  /**
   * For every application associated to this actor, refresh it to reflect any updates.
   */
  _renderAllApps() {
    Object.values(this.apps).forEach(it => it.render(false))
  }

  /**
   * Update this Document using incremental data, saving it to the database.
   * @see {@link Document.updateDocuments}
   * @param {any} data - Differential update data which modifies the existing values of this document data
   *                     (default: `{}`)
   * @param {any} [context] - Additional context which customizes the update workflow (default: `{}`)
   * @returns {Promise<this | undefined>} The updated Document instance
   * @remarks If no document has actually been updated, the returned {@link Promise} resolves to `undefined`.
   */
  async update(data, context) {
    if (game.settings.get(settings.SYSTEM_NAME, settings.SETTING_AUTOMATIC_ONETHIRD)) {
      if (data.hasOwnProperty('system.HP.value')) {
        let flag = data['system.HP.value'] < this.system.HP.max / 3
        if (!!this.system.conditions.reeling != flag) {
          this.toggleEffectByName('reeling', flag)

          if (game.settings.get(settings.SYSTEM_NAME, settings.SETTING_SHOW_CHAT_FOR_REELING_TIRED)) {
            // send the chat message
            let tag = flag ? 'GURPS.chatTurnOnReeling' : 'GURPS.chatTurnOffReeling'
            let msg = i18n_f(tag, { name: this.displayname, pdfref: i18n('GURPS.pdfReeling') })
            this.sendChatMessage(msg)
          }

          // update the combat tracker to show/remove condition
          ui.combat?.render()
        }
      }
      if (data.hasOwnProperty('system.FP.value')) {
        let flag = data['system.FP.value'] < this.system.FP.max / 3
        if (!!this.system.conditions.exhausted != flag) {
          this.toggleEffectByName('exhausted', flag)

          // send the chat message
          if (game.settings.get(settings.SYSTEM_NAME, settings.SETTING_SHOW_CHAT_FOR_REELING_TIRED)) {
            let tag = flag ? 'GURPS.chatTurnOnTired' : 'GURPS.chatTurnOffTired'
            let msg = i18n_f(tag, { name: this.displayname, pdfref: i18n('GURPS.pdfTired') })
            this.sendChatMessage(msg)
          }

          // update the combat tracker to show/remove condition
          ui.combat?.render()
        }
      }
    }

    if (!Array.isArray(data) && !data._id) data._id = this.id
    return await super.update(data, context)
  }

  sendChatMessage(msg) {
    let self = this

    renderTemplate('systems/gurps/templates/chat-processing.html', { lines: [msg] }).then(content => {
      let users = self.getOwners()
      let ids = /** @type {string[] | undefined} */ (users?.map(it => it.id))

      let messageData = {
        content: content,
        whisper: ids || null,
      }
      ChatMessage.create(messageData)
    })
  }

  async internalUpdate(data, context) {
    //let ctx = { render: !this.ignoreRender }
    let ctx = { render: false }
    if (!!context) ctx = { ...context, ...ctx }
    await this.update(data, ctx)
  }

  async toggleStatusEffect(statusId, { active, overlay = false } = {}) {
    const status = CONFIG.statusEffects.find(e => e.id === statusId)
    if (!status) throw new Error(`Invalid status ID "${statusId}" provided to Actor#toggleStatusEffect`)

    if (foundry.utils.getProperty(status, 'flags.gurps.effect.type') === 'posture') {
      let existing = this.getAllActivePostureEffects()
      existing = existing.filter(e => e.statuses.find(s => s !== statusId))

      for (const it of existing) {
        console.log(it)
        await super.toggleStatusEffect(it.statuses.first())
      }
    }

    await super.toggleStatusEffect(statusId, { active, overlay })
  }

  getAllActivePostureEffects() {
    return this.effects.filter(e => e.getFlag('gurps', 'effect.type') === 'posture')
  }

  /**
   * This method is called when "system.conditions.maneuver" changes on the actor (via the update method)
   * @param {string} maneuverText
   */
  async replaceManeuver(maneuverText) {
    let tokens = this._findTokens()
    if (tokens && tokens.length) for (const t of tokens) await t.setManeuver(maneuverText)
  }

  async replacePosture(changeData) {
    let tokens = this._findTokens()
    if (tokens)
      for (const t of tokens) {
        let id = changeData === GURPS.StatusEffectStanding ? this.system.conditions.posture : changeData
        await this.toggleStatusEffect(id)
      }
  }

  /**
   * @returns {GurpsToken[]}
   */
  _findTokens() {
    if (this.isToken && this.token?.layer) {
      let token = this.token.object
      return token ? [token] : null
    }
    return this.getActiveTokens()
  }

  /**
   * @param {{ id: unknown; }} effect
   */
  isEffectActive(effect) {
    for (const it of this.effects) {
      if (it.statuses.find(s => s === effect.id)) return true
      // let statusId = it.getFlag('core', 'statusId')
      // if (statusId === effect.id) return true
    }

    return false
  }

  get _additionalResources() {
    return this.system.additionalresources
  }

  get displayname() {
    let n = this.name
    if (!!this.token && this.token.name != n) n = this.token.name + '(' + n + ')'
    return n
  }

  /**
   *
   * @param {Object} action
   * @param {string} action.orig - the original OTF string
   * @param {string} action.costs - "*(per|cost) ${number} ${resource}" -- resource can be '@resource' to prompt user
   * @param {string} action.formula - the basic die formula, such as '2d', '1d-2', '3d-1x2', etc.
   * @param {string} action.damagetype - one of the recognized damage types (cr, cut, imp, etc)
   * @param {string} action.extdamagetype - optional extra damage type, such as 'ex'
   * @param {string} action.hitlocation - optional hit location
   * @param {boolean} action.accumulate
   */
  async accumulateDamageRoll(action) {
    // define a new actor property, damageAccumulators, which is an array of object:
    // {
    //  otf: action.orig,
    //  dieroll: action.formula,
    //  damagetype: action.damagetype,
    //  damagemod: action.extdamagetype,
    //  cost: the <cost> value parsed out of action.cost, optional
    //  resource: the <resource> value parsed out of action.cost, optional
    //  count: <number> -- the accumulator, i.e., how many times this damage is to be invoked.
    // }

    // initialize the damageAccumulators property if it doesn't exist:
    if (!this.system.conditions.damageAccumulators) this.system.conditions.damageAccumulators = []

    let accumulators = this.system.conditions.damageAccumulators

    // first, try to find an existing accumulator, and increment if found
    let existing = accumulators.findIndex(it => it.orig === action.orig)
    if (existing !== -1) return this.incrementDamageAccumulator(existing)

    // an existing accumulator is not found, create one
    action.count = 1
    delete action.accumulate
    accumulators.push(action)
    await this.internalUpdate({ 'system.conditions.damageAccumulators': accumulators })
    GURPS.ModifierBucket.render()
    //console.log(accumulators)
  }

  get damageAccumulators() {
    return this.system.conditions.damageAccumulators
  }

  async incrementDamageAccumulator(index) {
    this.damageAccumulators[index].count++
    await this.internalUpdate({ 'system.conditions.damageAccumulators': this.damageAccumulators })
    GURPS.ModifierBucket.render()
  }

  async decrementDamageAccumulator(index) {
    this.damageAccumulators[index].count--
    if (this.damageAccumulators[index].count < 1) this.damageAccumulators.splice(index, 1)
    await this.internalUpdate({ 'system.conditions.damageAccumulators': this.damageAccumulators })
    GURPS.ModifierBucket.render()
  }

  async clearDamageAccumulator(index) {
    this.damageAccumulators.splice(index, 1)
    await this.internalUpdate({ 'system.conditions.damageAccumulators': this.damageAccumulators })
    GURPS.ModifierBucket.render()
  }

  async applyDamageAccumulator(index) {
    let accumulator = this.damageAccumulators[index]
    let roll = multiplyDice(accumulator.formula, accumulator.count)
    if (accumulator.costs) {
      let costs = accumulator.costs.match(COSTS_REGEX)
      if (!!costs) {
        accumulator.costs = `*${costs.groups.verb} ${accumulator.count * costs.groups.cost} ${costs.groups.type}`
      }
    }
    accumulator.formula = roll
    this.damageAccumulators.splice(index, 1)
    await this.internalUpdate({ 'system.conditions.damageAccumulators': this.damageAccumulators })
    await GURPS.performAction(accumulator, GURPS.LastActor)
  }

  getPortraitPath() {
    if (game.settings.get(settings.SYSTEM_NAME, settings.SETTING_PORTRAIT_PATH) == 'global') return 'images/portraits/'
    return `worlds/${game.world.id}/images/portraits`
  }

  removeAccents(str) {
    return str
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // Remove accents
      .replace(/([^\w]+|\s+)/g, '-') // Replace space and other characters by hyphen
      .replace(/\-\-+/g, '-') // Replaces multiple hyphens by one hyphen
      .replace(/(^-+|-+$)/g, '')
  }

  /**
   * Adds any assigned resource trackers to the actor data and sheet.
   */
  async setResourceTrackers() {
    // find those with non-blank slots
    let templates = ResourceTrackerManager.getAllTemplates()
      .filter(it => !!it.slot)
      .filter(it => it.slot !== 'none')

    for (const template of templates) {
      // find the matching data on this actor
      let index = zeroFill(template.slot, 4)
      let path = `additionalresources.tracker.${index}`
      let tracker = foundry.utils.getProperty(this, 'system.' + path)

      while (!tracker) {
        await this.addTracker()
        tracker = foundry.utils.getProperty(this, 'system.' + path)
      }

      // skip if already set
      if (!!tracker && tracker.name === template.tracker.name) {
        return
      }

      // if not blank, don't overwrite
      if (!!tracker && !!tracker.name) {
        ui.notifications?.warn(
          `Will not overwrite Tracker ${template.slot} as its name is set to ${tracker.name}. Create Tracker for ${template.tracker.name} failed.`
        )
        return
      }

      await this.applyTrackerTemplate(path, template)
    }
  }

  /**
   * Update this tracker slot with the contents of the template.
   * @param {String} path JSON data path to the tracker; must start with 'additionalresources.tracker.'
   * @param {*} template to apply
   */
  async applyTrackerTemplate(path, template) {
    // is there an initializer? If so calculate its value
    let value = template.tracker.value
    if (!!template.initialValue) {
      value = parseInt(template.initialValue, 10)
      if (Number.isNaN(value)) {
        // try to use initialValue as a path to another value
        value = foundry.utils.getProperty(this, 'system.' + template.initialValue)
      }
    }
    template.tracker.max = value
    template.tracker.value = template.tracker.isDamageTracker ? template.tracker.min : value

    // remove whatever is there
    await this.clearTracker(path)

    // add the new tracker
    /** @type {{ [key: string]: any }} */
    let update = {}
    update[`system.${path}`] = template.tracker
    await this.update(update)
  }

  /**
   * Overwrites the tracker pointed to by the path with default/blank values.
   * @param {String} path JSON data path to the tracker; must start with 'additionalresources.tracker.'
   */
  async clearTracker(path) {
    // verify that this is a Tracker
    const prefix = 'additionalresources.tracker.'
    if (!path.startsWith(prefix)) throw `Invalid actor data path, actor=[${this.id}] path=[${path}]`

    /** @type {{[key: string]: string}} */
    let update = {}
    update[`system.${path}`] = {
      name: '',
      alias: '',
      pdf: '',
      max: 0,
      min: 0,
      value: 0,
      isDamageTracker: false,
      isDamageType: false,
      initialValue: '',
      thresholds: [],
    }
    await this.update(update)
  }

  /**
   * Removes the indicated tracker from the object, reindexing the keys.
   * @param {String} path JSON data path to the tracker; must start with 'additionalresources.tracker.'
   */
  async removeTracker(path) {
    this.ignoreRender = true
    const prefix = 'additionalresources.tracker.'

    // verify that this is a Tracker
    if (!path.startsWith(prefix)) throw `Invalid actor data path, actor=[${this.id}] path=[${path}]`

    let key = path.replace(prefix, '')
    let trackerData = this.system.additionalresources.tracker
    delete trackerData[key]
    let trackers = objectToArray(trackerData)
    let data = arrayToObject(trackers)

    // remove all trackers
    await this.update({ 'system.additionalresources.-=tracker': null })
    // add the new "array" of trackers
    if (data) this.update({ 'system.additionalresources.tracker': data })
    else this.update('system.additionalresources.tracker', {})

    this._forceRender()
  }

  async addTracker() {
    this.ignoreRender = true

    let trackerData = { name: '', value: 0, min: 0, max: 0, points: 0 }
    let data = GurpsActor.addTrackerToDataObject(this.system, trackerData)

    await this.update({ 'system.additionalresources.-=tracker': null })
    await this.update({ 'system.additionalresources.tracker': data })

    this._forceRender()
  }

  static addTrackerToDataObject(data, trackerData) {
    let trackers = GurpsActor.getTrackersAsArray(data)
    trackers.push(trackerData)
    return arrayToObject(trackers)
  }

  static getTrackersAsArray(data) {
    let trackerArray = data.additionalresources.tracker
    if (!trackerArray) trackerArray = {}
    return objectToArray(trackerArray)
  }

  get trackersByName() {
    // Convert this.system.hitlocations into an object keyed by location.where.
    const byName = {}
    for (const [_key, value] of Object.entries(this.system.additionalresources.tracker ?? {})) {
      byName[`${value.name}`] = value
    }
    return byName
  }

  async setMoveDefault(value) {
    this.ignoreRender = true
    let move = this.system.move
    for (const key in move) {
      move[key].default = value === key
    }
    await this.update({ 'system.-=move': null })
    await this.update({ 'system.move': move })
    this._forceRender()
  }

  async addMoveMode(mode, basic, enhanced = basic, isDefault = false) {
    // copy existing entries
    let move = {}
    const moveData = this.system.move
    for (const k in moveData)
      foundry.utils.setProperty(move, k, {
        mode: moveData[k].mode,
        basic: moveData[k].basic,
        enhanced: moveData[k].enhanced,
        default: moveData[k].default,
      })

    // if mode already exists, abandon update.
    for (const k in move) {
      if (move[k].mode === mode) {
        return
      }
    }

    // add a new entry at the end.
    let empty = Object.values(moveData).length === 0
    GURPS.put(move, {
      mode: mode,
      basic: basic ?? this.system.basicmove.value * 2,
      enhanced: enhanced,
      default: empty || isDefault,
    })

    // remove existing entries
    await this.update({ 'system.-=move': null })

    // add the new entries
    await this.update({ 'system.move': move })
  }

  // --- Functions to handle events on actor ---

  /**
   * @param {any[]} damageData
   */
  handleDamageDrop(damageData) {
    if (game.user.isGM || !game.settings.get(settings.SYSTEM_NAME, settings.SETTING_ONLY_GMS_OPEN_ADD)) {
      const dialog = new ApplyDamageDialog(this, damageData)
      dialog.render(true)
    } else ui.notifications?.warn(game.i18n.localize('GURPS.invalidUserForDamageWarning'))
  }

  // Drag and drop from Item colletion
  /**
   * Handle Drag and Drop on Actor
   *
   * ### Scenario 1: Use Foundry Items is disabled
   * We use the classic behavior: only works for equipment items
   *
   * ### Scenario 2: Use Foundry Items is enabled
   * Far more trick. We can handle equipments, spells, skills and features.
   * Current logic is:
   * 1. Check if the global item was already dragged. If yes, do not import again.
   * 2. Check if the Actor Component for this Item is already create. Same behavior.
   * 3. Create a new Actor Component, manually adding global image and OTFs.
   * 4. Create the correspondent Foundry Item.
   * 5. Process Item Additions (Child Items)
   *
   * The biggest trap here is to add something to Actor Component but not Foundry Item
   * and vice versa
   *
   * @param {{ type: any; x?: number; y?: number; payload?: any; pack?: any; id?: any; data?: any; }} dragData
   */
  async handleItemDrop(dragData) {
    console.log('handleItemDrop', dragData)
    if (!this.isOwner) {
      ui.notifications?.warn(i18n('GURPS.youDoNotHavePermssion'))
      return
    }
    // New item created in Foundry v12.331 dragData:
    // {
    //   "type": "Item",
    //   "uuid": "Item.542YuRvzxVx83kL1"
    // }
    let global = await fromUuid(dragData.uuid)
    let data = !!global ? global : dragData
    if (!data) {
      ui.notifications?.warn('NO ITEM DATA!')
      return
    }
    if (!data.globalid) await data.update({ _id: data._id, 'system.globalid': dragData.uuid })
    this.ignoreRender = true
    if (!game.settings.get(settings.SYSTEM_NAME, settings.SETTING_USE_FOUNDRY_ITEMS)) {
      // Scenario 1: Work only for Equipment dropped
      ui.notifications?.info(data.name + ' => ' + this.name)
      await this.addNewItemData(data)
    } else {
      // Scenario 2: Process Actor Component, Parent (dropped) Item and Child Items

      // 1. This global item was already dropped?
      const found = this.items.find(it => it.system.globalid === data.system.globalid)
      if (!!found) {
        ui.notifications?.warn(i18n('GURPS.cannotDropItemAlreadyExists'))
        return
      }
      ui.notifications?.info(
        game.i18n.format('GURPS.droppingItemNotification', { actorName: this.name, itemName: data.name })
      )

      // 2. Check if Actor Component exists
      const actorCompKey =
        data.type === 'equipment'
          ? this._findEqtkeyForId('globalid', data.system.globalid)
          : this._findSysKeyForId('globalid', data.system.globalid, data.actorComponentKey)
      const actorComp = foundry.utils.getProperty(this, actorCompKey)
      if (!!actorComp) {
        ui.notifications?.warn(i18n('GURPS.cannotDropItemAlreadyExists'))
      } else {
        // 3. Create Actor Component
        let actorComp
        let targetKey
        switch (data.type) {
          case 'equipment':
            actorComp = Equipment.fromObject({ name: data.name, ...data.system.eqt }, this)
            targetKey = 'system.equipment.carried'
            break
          case 'feature':
            actorComp = Advantage.fromObject({ name: data.name, ...data.system.fea }, this)
            targetKey = 'system.ads'
            break
          case 'skill':
            actorComp = Skill.fromObject({ name: data.name, ...data.system.ski }, this)
            targetKey = 'system.skills'
            break
          case 'spell':
            actorComp = Spell.fromObject({ name: data.name, ...data.system.spl }, this)
            targetKey = 'system.spells'
            break
        }
        actorComp.itemInfo.img = data.img
        actorComp.otf = data.system[data.itemSysKey].otf
        actorComp.checkotf = data.system[data.itemSysKey].checkotf
        actorComp.duringotf = data.system[data.itemSysKey].duringotf
        actorComp.passotf = data.system[data.itemSysKey].passotf
        actorComp.failotf = data.system[data.itemSysKey].failotf

        // 4. Create Parent Item
        const importer = new ActorImporter(this)
        actorComp = await importer._processItemFrom(actorComp, '')
        let parentItem = this.items.get(actorComp.itemid)
        const keys = ['melee', 'ranged', 'ads', 'spells', 'skills']
        for (const key of keys) {
          recurselist(data.system[key], e => {
            if (!e.uuid) e.uuid = foundry.utils.randomID(16)
          })
        }

        await this.updateEmbeddedDocuments('Item', [
          {
            _id: parentItem.id,
            'system.globalid': dragData.uuid,
            'system.melee': data.system.melee,
            'system.ranged': data.system.ranged,
            'system.ads': data.system.ads,
            'system.spells': data.system.spells,
            'system.skills': data.system.skills,
            'system.bonuses': data.system.bonuses,
          },
        ])

        // 5. Update Actor System with new Component
        const systemObject = foundry.utils.duplicate(foundry.utils.getProperty(this, targetKey))
        const removeKey = targetKey.replace(/(\w+)$/, '-=$1')
        await this.internalUpdate({ [removeKey]: null })
        await GURPS.put(systemObject, actorComp)
        await this.internalUpdate({ [targetKey]: systemObject })
        if (data.type === 'equipment') await Equipment.calc(actorComp)

        // 6. Process Child Items for created Item
        const actorCompKey =
          data.type === 'equipment'
            ? this._findEqtkeyForId('uuid', parentItem.system.eqt.uuid)
            : this._findSysKeyForId('uuid', parentItem.system[parentItem.itemSysKey].uuid, parentItem.actorComponentKey)
        await this._addItemAdditions(parentItem, actorCompKey)
      }
    }
    this._forceRender()
  }

  _forceRender() {
    this.ignoreRender = false
    //console.log("Force Render")
    this.render()
  }

  // Drag and drop from an equipment list
  /**
   * @param {{ type?: string; x?: number; y?: number; payload?: any; actorid?: any; itemid?: any; isLinked?: any; key?: any; itemData?: any; }} dragData
   */
  async handleEquipmentDrop(dragData) {
    if (dragData.actorid == this.id) return false // same sheet drag and drop handled elsewhere
    if (!dragData.itemid) {
      ui.notifications?.warn(i18n('GURPS.cannotDragNonFoundryEqt'))
      return
    }
    if (!dragData.isLinked) {
      ui.notifications?.warn("You cannot drag from an un-linked token. The source must have 'Linked Actor Data'")
      return
    }
    let srcActor = game.actors.get(dragData.actorid)
    let eqt = foundry.utils.getProperty(srcActor, dragData.key)
    if (
      (!!eqt.contains && Object.keys(eqt.contains).length > 0) ||
      (!!eqt.collapsed && Object.keys(eqt.collapsed).length > 0)
    ) {
      ui.notifications?.warn('You cannot transfer an Item that contains other equipment.')
      return
    }

    if (!!this.isOwner && !!srcActor.isOwner) {
      // same owner
      if (eqt.count < 2) {
        let destKey = this._findEqtkeyForId('name', eqt.name)
        if (!!destKey) {
          // already have some
          let destEqt = foundry.utils.getProperty(this, destKey)
          await this.updateEqtCount(destKey, +destEqt.count + +eqt.count)
          await srcActor.deleteEquipment(dragData.key)
        } else {
          let item = await srcActor.deleteEquipment(dragData.key)
          await this.addNewItemData(item)
        }
      } else {
        let content = await renderTemplate('systems/gurps/templates/transfer-equipment.html', { eqt: eqt })
        let callback = async (/** @type {JQuery<HTMLElement> | HTMLElement} */ html) => {
          // @ts-ignore
          let qty = parseInt(html.find('#qty').val())
          let destKey = this._findEqtkeyForId('name', eqt.name)
          if (!!destKey) {
            // already have some
            let destEqt = foundry.utils.getProperty(this, destKey)
            await this.updateEqtCount(destKey, +destEqt.count + qty)
          } else {
            let item = /** @type {GurpsItem} */ (srcActor.items.get(eqt.itemid))
            item.system.eqt.count = qty
            await this.addNewItemData(item)
          }
          if (qty >= eqt.count) await srcActor.deleteEquipment(dragData.key)
          else await srcActor.updateEqtCount(dragData.key, +eqt.count - qty)
        }

        Dialog.prompt({
          title: i18n('GURPS.TransferTo') + ' ' + this.name,
          label: i18n('GURPS.ok'),
          content: content,
          callback: callback,
          rejectClose: false, // Do not "reject" if the user presses the "close" gadget
        })
      }
    } else {
      // different owners
      let count = eqt.count
      if (eqt.count > 1) {
        let content = await renderTemplate('systems/gurps/templates/transfer-equipment.html', { eqt: eqt })
        let callback = async (/** @type {HTMLElement | JQuery<HTMLElement>} */ html) =>
          // @ts-ignore
          (count = parseInt(html.find('#qty').val()))
        await Dialog.prompt({
          title: i18n('GURPS.TransferTo') + ' ' + this.name,
          label: i18n('GURPS.ok'),
          content: content,
          callback: callback,
        })
      }
      if (count > eqt.count) count = eqt.count
      let destowner = game.users?.players.find(p => this.testUserPermission(p, 'OWNER'))
      if (!!destowner) {
        ui.notifications?.info(`Asking ${this.name} if they want ${eqt.name}`)
        dragData.itemData.system.eqt.count = count // They may not have given all of them
        game.socket.emit('system.gurps', {
          type: 'dragEquipment1',
          srckey: dragData.key,
          srcuserid: game.user.id,
          srcactorid: dragData.actorid,
          destuserid: destowner.id,
          destactorid: this.id,
          itemData: dragData.itemData,
          count: +count,
        })
      } else ui.notifications?.warn(i18n('GURPS.youDoNotHavePermssion'))
    }
  }

  // Called from the ItemEditor to let us know our personal Item has been modified
  /**
   * @param {Item} item
   */
  async updateItem(item) {
    // @ts-ignore
    delete item.editingActor
    this.ignoreRender = true
    if (item.id) await this._removeItemAdditions(item.id)
    // let _data = GurpsItem.asGurpsItem(item).system
    let oldkey = this._findEqtkeyForId('itemid', item.id)
    var oldeqt
    if (!!oldkey) oldeqt = foundry.utils.getProperty(this, oldkey)
    let other = item.id ? await this._removeItemElement(item.id, 'equipment.other') : null // try to remove from other
    if (!other) {
      // if not in other, remove from carried, and then re-add everything
      if (item.id) await this._removeItemElement(item.id, 'equipment.carried')
      await this.addItemData(item)
    } else {
      // If was in other... just add back to other (and forget addons)
      await this._addNewItemEquipment(item, 'system.equipment.other.' + zeroFill(0))
    }
    let newkey = this._findEqtkeyForId('itemid', item.id)
    if (!!oldeqt && (!!oldeqt.contains || !!oldeqt.collapsed)) {
      this.update({
        [newkey + '.contains']: oldeqt.contains,
        [newkey + '.collapsed']: oldeqt.collapsed,
      })
    }
    this._forceRender()
  }

  // create a new embedded item based on this item data and place in the carried list
  // This is how all Items are added originally.
  /**
   * @param {ItemData} itemData
   * @param {string | null} [targetkey]
   */
  async addNewItemData(itemData, targetkey = null) {
    let d = itemData
    // @ts-ignore
    if (typeof itemData.toObject === 'function') {
      d = itemData.toObject()
      d.system.eqt.count = itemData.system.eqt.count // For some reason the count isn't deepcopied correctly.
    }
    // @ts-ignore
    let localItems = await this.createEmbeddedDocuments('Item', [d]) // add a local Foundry Item based on some Item data
    let localItem = localItems[0]
    await this.updateEmbeddedDocuments('Item', [{ _id: localItem.id, 'system.eqt.uuid': generateUniqueId() }])
    await this.addItemData(localItem, targetkey) // only created 1 item
    if (game.settings.get(settings.SYSTEM_NAME, settings.SETTING_USE_FOUNDRY_ITEMS)) {
      const item = await this.items.get(localItem._id)
      return this._updateItemFromForm(item)
    }
  }

  // Once the Items has been added to our items list, add the equipment and any features
  /**
   * @param {ItemData} itemData
   * @param {string | null} [targetkey]
   */
  async addItemData(itemData, targetkey) {
    let [eqtkey, addFeatures] = await this._addNewItemEquipment(itemData, targetkey)
    if (addFeatures) {
      await this._addItemAdditions(itemData, eqtkey)
    }
  }

  // Make the initial equipment object (unless it already exists, saved in a user equipment)
  /**
   * @param {ItemData} itemData
   * @param {string | null} targetkey
   */
  async _addNewItemEquipment(itemData, targetkey) {
    let existing = this._findEqtkeyForId('itemid', itemData._id)
    if (!!existing) {
      // it may already exist (due to qty updates), so don't add it again
      let eqt = foundry.utils.getProperty(this, existing)
      return [existing, eqt.carried && eqt.equipped]
    }
    let _data = /** @type {GurpsItemData} */ (itemData)
    // HACK: ah, don't worry, we'll get rid of all this soon enough - M
    if (!!_data.system) _data = _data.system
    if (!!_data.eqt.parentuuid) {
      var found
      recurselist(this.system.equipment.carried, (e, k, _d) => {
        if (e.uuid == _data.eqt.parentuuid) found = 'system.equipment.carried.' + k
      })
      if (!found)
        recurselist(this.system.equipment.other, (e, k, _d) => {
          if (e.uuid == _data.eqt.parentuuid) found = 'system.equipment.other.' + k
        })
      if (!!found) {
        targetkey = found + '.contains.' + zeroFill(0)
      }
    }
    if (targetkey == null)
      if (_data.carried) {
        // new carried items go at the end
        targetkey = 'system.equipment.carried'
        let index = 0
        let list = foundry.utils.getProperty(this, targetkey)
        while (list.hasOwnProperty(zeroFill(index))) index++
        targetkey += '.' + zeroFill(index)
      } else targetkey = 'system.equipment.other'
    if (targetkey.match(/^system\.equipment\.\w+$/)) targetkey += '.' + zeroFill(0) //if just 'carried' or 'other'
    let eqt = _data.eqt
    if (!eqt) {
      ui.notifications?.warn('Item: ' + itemData._id + ' (Global:' + _data.globalid + ') missing equipment')
      return ['', false]
    } else {
      eqt.itemid = itemData._id
      eqt.globalid = _data.uuid
      //eqt.uuid = 'item-' + eqt.itemid
      eqt.equipped = !!_data.equipped ?? true
      eqt.img = itemData.img
      eqt.carried = !!_data.carried ?? true
      await GURPS.insertBeforeKey(this, targetkey, eqt)
      await this.updateParentOf(targetkey, true)
      return [targetkey, eqt.carried && eqt.equipped]
    }
  }

  /**
   * Two scenarios here:
   *
   * ### Use Foundry Items is disabled.
   * In this scenario if Actor Component has a itemId it's because this
   * component is already a child item from a parent Equipment item.
   *
   * ### Use Foundry Items is enabled.
   * In this scenario, the ItemData received is the Parent Item. We need to check
   * for child items created with the `fromItem` equal to Parent itemId.
   *
   * @param {GurpsItemData} itemData
   * @param {string} eqtkey
   */
  async _addItemAdditions(itemData, eqtkey) {
    let commit = {}
    const subTypes = ['melee', 'ranged', 'ads', 'skills', 'spells']
    if (!game.settings.get(settings.SYSTEM_NAME, settings.SETTING_USE_FOUNDRY_ITEMS)) {
      for (const subType of subTypes) {
        commit = { ...commit, ...(await this._addItemElement(itemData, eqtkey, subType)) }
      }
    } else {
      const parentItem = await this.items.get(itemData._id)
      let newList = {}
      for (const subType of subTypes) {
        newList = { ...foundry.utils.getProperty(this, `system.${subType}`) }
        if (!!parentItem.system[subType] && typeof parentItem.system[subType] === 'object') {
          for (const key in parentItem.system[subType]) {
            if (parentItem.system[subType].hasOwnProperty(key)) {
              const childItemData = parentItem.system[subType][key]
              const commitData = await this._addChildItemElement(parentItem, childItemData, subType, newList)
              commit = { ...commit, ...commitData }
              newList = commitData[`system.${subType}`]
            }
          }
        }
      }
    }
    commit = this.applyItemModEffects(commit, true)
    if (!!commit) await this.update(commit, { diff: false })
    this.calculateDerivedValues() // new skills and bonuses may affect other items... force a recalc
  }

  /**
   * Called when equipment is being moved or equipped
   * @param {Equipment} eqt equipment.
   * @param {string} targetPath equipment target path.
   */
  async updateItemAdditionsBasedOn(eqt, targetPath) {
    await this._updateEqtStatus(eqt, targetPath, targetPath.includes('.carried'), eqt.equipped)
  }

  /**
   * Equipment may carry other eqt, so we must adjust the carried and equipped status all the way down.
   * @param {Equipment} eqt equipment object.
   * @param {string} eqtkey equipment key.
   * @param {boolean} carried container item's carried status.
   * @param {boolean} equipped container item's equipped status.
   */
  async _updateEqtStatus(eqt, eqtkey, carried, equipped) {
    eqt.carried = carried
    eqt.equipped = equipped

    if (!!eqt.itemid) {
      let item = /** @type {Item} */ (await this.items.get(eqt.itemid))
      await this.updateEmbeddedDocuments('Item', [
        { _id: item.id, 'system.equipped': equipped, 'system.carried': carried },
      ])
      if (!carried || !equipped) await this._removeItemAdditions(eqt.itemid)
      if (carried && equipped) await this._addItemAdditions(item, eqtkey)
    }

    for (const k in eqt.contains)
      await this._updateEqtStatus(eqt.contains[k], eqtkey + '.contains.' + k, carried, equipped)
    for (const k in eqt.collapsed)
      await this._updateEqtStatus(eqt.collapsed[k], eqtkey + '.collapsed.' + k, carried, equipped)
  }

  /**
   * @param {ItemData} itemData
   * @param {string} eqtkey
   * @param {string} key
   */
  async _addItemElement(itemData, eqtkey, key) {
    let found = false
    // @ts-ignore
    recurselist(this.system[key], (e, _k, _d) => {
      if (e.itemid == itemData._id) found = true
    })
    if (found) return
    // @ts-ignore
    let list = { ...this.system[key] } // shallow copy
    let i = 0
    // @ts-ignore
    for (const k in itemData.system[key]) {
      // @ts-ignore
      let e = foundry.utils.duplicate(itemData.system[key][k])
      e.itemid = itemData._id
      e.uuid = key + '-' + i++ + '-' + e.itemid
      e.eqtkey = eqtkey
      e.img = itemData.img
      GURPS.put(list, e)
    }
    return i == 0 ? {} : { ['system.' + key]: list }
  }

  /**
   *  Calculate Skill Level per OTF.
   *
   *  On Skills and Spells item sheets, if you define the `otf` field
   *  and leave the `import` field blank, system will try to calculate
   *  the skill level based on the OTF formula informed.
   *
   *  BTW, `import` is the name for the base skill level. I know, naming is hard.
   *
   * @param otf
   * @returns {Promise<*>}
   * @private
   */
  async _getSkillLevelFromOTF(otf) {
    if (!otf) return
    let skillAction = parselink(otf).action
    if (!skillAction) return
    skillAction.calcOnly = true
    const results = await GURPS.performAction(skillAction, this)
    return results?.target
  }

  /**
   * Process Child Items from Parent Item.
   *
   * Why I did not use the original code? Too complex to add new scenarios.
   *
   * @param parentItem
   * @param childItemData
   * @param key
   * @returns {Promise<{[p: string]: *}|{}>}
   * @private
   */
  async _addChildItemElement(parentItem, childItemData, key, list) {
    let found = false
    if (found) {
      // Use existing actor component uuid
      let existingActorComponent = this.system[key].find(e => e.fromItem === parentItem._id)
      childItemData.uuid = existingActorComponent?.uuid || ''
    }
    // Let's (re)create the child Item with updated Child Item information
    let actorComp
    switch (key) {
      case 'ads':
        actorComp = Advantage.fromObject(childItemData, this)
        break
      case 'skills':
        actorComp = Skill.fromObject(childItemData, this)
        actorComp['import'] = await this._getSkillLevelFromOTF(childItemData.otf)
        break
      case 'spells':
        actorComp = Spell.fromObject(childItemData, this)
        actorComp['import'] = await this._getSkillLevelFromOTF(childItemData.otf)
        break
      case 'melee':
        actorComp = Melee.fromObject(childItemData, this)
        actorComp['import'] = await this._getSkillLevelFromOTF(childItemData.otf)
        actorComp.name = `${parentItem.name} - ${actorComp.mode}`
        actorComp.fromItem = parentItem.uuid
        break
      case 'ranged':
        actorComp = Ranged.fromObject(childItemData, this)
        actorComp['import'] = await this._getSkillLevelFromOTF(childItemData.otf)
        actorComp.name = `${parentItem.name} - ${actorComp.mode}`
        actorComp.fromItem = parentItem.uuid
        break
    }
    if (!actorComp) return {}
    actorComp.fromItem = parentItem._id
    const importer = new ActorImporter(this)
    actorComp = await importer._processItemFrom(actorComp, '')
    GURPS.put(list, actorComp)
    return { ['system.' + key]: list }
  }

  // return the item data that was deleted (since it might be transferred)
  /**
   * @param {string} path
   */
  async deleteEquipment(path, depth = 0) {
    let eqt = foundry.utils.getProperty(this, path)
    if (!eqt) return eqt
    if (depth == 0) this.ignoreRender = true

    // Delete in reverse order so the keys don't get messed up
    if (!!eqt.contains)
      for (const k of Object.keys(eqt.contains).sort().reverse())
        await this.deleteEquipment(path + '.contains.' + k, depth + 1)
    if (!!eqt.collpased)
      for (const k of Object.keys(eqt.collapsed).sort().reverse())
        await this.deleteEquipment(path + '.collapsed.' + k, depth + 1)

    var item
    if (!!eqt.itemid) {
      item = await this.items.get(eqt.itemid)
      if (!!item) await item.delete() // data protect for messed up mooks
      await this._removeItemAdditions(eqt.itemid)
    }
    await GURPS.removeKey(this, path)
    if (depth == 0) this._forceRender()
    return item
  }

  /**
   * @param {string} itemid
   */
  async _removeItemAdditions(itemid) {
    let saved = this.ignoreRender
    this.ignoreRender = true
    await this._removeItemElement(itemid, 'melee')
    await this._removeItemElement(itemid, 'ranged')
    await this._removeItemElement(itemid, 'ads')
    await this._removeItemElement(itemid, 'skills')
    await this._removeItemElement(itemid, 'spells')
    await this._removeItemEffect(itemid)
    this.ignoreRender = saved
  }

  /**
   * Remove Item Effect from Actor system.conditions.usermods
   *
   * @param {string} itemId
   * @private
   */
  async _removeItemEffect(itemId) {
    let userMods = foundry.utils.getProperty(this, 'system.conditions.usermods')
    const mods = [...userMods.filter(mod => !mod.includes(`@${itemId}`))]
    await this.update({ 'system.conditions.usermods': mods })
  }

  /**
   * Remove Item Element
   *
   * This is the original comment (still valid):
   *
   *   `// We have to remove matching items after we searched through the list`
   *
   *   `// because we cannot safely modify the list why iterating over it`
   *
   *   `// and as such, we can only remove 1 key at a time and must use thw while loop to check again`
   *
   *  When Use Foundry Items is enabled, we just find the item using their `fromItem`
   *  instead their `itemId`. This is because now every child item has the Id for their
   *  parent item in that field.
   *
   *  The trick here: always remove Item before Actor Component.
   *
   * @param {string} itemid
   * @param {string} key
   */
  async _removeItemElement(itemid, key) {
    let found = true
    let any = false
    if (!key.startsWith('system.')) key = 'system.' + key
    while (!!found) {
      found = false
      let list = foundry.utils.getProperty(this, key)
      recurselist(list, (e, k, _d) => {
        if (!game.settings.get(settings.SYSTEM_NAME, settings.SETTING_USE_FOUNDRY_ITEMS)) {
          if (e.itemid === itemid) found = k
        } else {
          if (e.fromItem === itemid) found = k
        }
      })
      if (!!found) {
        any = true
        const actorKey = key + '.' + found
        if (!!game.settings.get(settings.SYSTEM_NAME, settings.SETTING_USE_FOUNDRY_ITEMS)) {
          // We need to remove the child item from the actor
          const childActorComponent = foundry.utils.getProperty(this, actorKey)
          const existingChildItem = await this.items.get(childActorComponent.itemid)
          if (!!existingChildItem) await existingChildItem.delete()
        }
        await GURPS.removeKey(this, actorKey)
      }
    }
    return any
  }

  /**
   * @param {string} srckey
   * @param {string} targetkey
   * @param {boolean} shiftkey
   */
  async moveEquipment(srckey, targetkey, shiftkey) {
    if (srckey == targetkey) return
    if (shiftkey && (await this._splitEquipment(srckey, targetkey))) return
    // Because we may be modifing the same list, we have to check the order of the keys and
    // apply the operation that occurs later in the list, first (to keep the indexes the same)
    let srca = srckey.split('.')
    srca.splice(0, 3)
    let tara = targetkey.split('.')
    tara.splice(0, 3)
    let max = Math.min(srca.length, tara.length)
    let isSrcFirst = max == 0 ? srca.length > tara.length : false
    for (let i = 0; i < max; i++) {
      if (parseInt(srca[i]) < parseInt(tara[i])) isSrcFirst = true
    }
    let object = foundry.utils.getProperty(this, srckey)
    if (targetkey.match(/^system\.equipment\.\w+$/)) {
      this.ignoreRender = true
      object.parentuuid = ''
      if (!!object.itemid) {
        let item = /** @type {Item} */ (this.items.get(object.itemid))
        await this.updateEmbeddedDocuments('Item', [{ _id: item.id, 'system.eqt.parentuuid': '' }])
      }
      let target = { ...GURPS.decode(this, targetkey) } // shallow copy the list
      if (!isSrcFirst) await GURPS.removeKey(this, srckey)
      let eqtkey = GURPS.put(target, object)
      await this.updateItemAdditionsBasedOn(object, targetkey + '.' + eqtkey)
      await this.update({ [targetkey]: target })
      if (isSrcFirst) await GURPS.removeKey(this, srckey)
      return this._forceRender()
    }
    if (await this._checkForMerging(srckey, targetkey)) return
    if (srckey.includes(targetkey) || targetkey.includes(srckey)) {
      ui.notifications.error('Unable to drag and drop withing the same hierarchy. Try moving it elsewhere first.')
      return
    }
    this.toggleExpand(targetkey, true)
    let d = new Dialog({
      title: object.name,
      content: '<p>Where do you want to place this?</p>',
      buttons: {
        one: {
          icon: '<i class="fas fa-level-up-alt"></i>',
          label: 'Before',
          callback: async () => {
            this.ignoreRender = true
            if (!isSrcFirst) {
              await GURPS.removeKey(this, srckey)
              await this.updateParentOf(srckey, false)
            }
            await this.updateItemAdditionsBasedOn(object, targetkey)
            await GURPS.insertBeforeKey(this, targetkey, object)
            await this.updateParentOf(targetkey, true)
            if (isSrcFirst) {
              await GURPS.removeKey(this, srckey)
              await this.updateParentOf(srckey, false)
            }
            this._forceRender()
          },
        },
        two: {
          icon: '<i class="fas fa-sign-in-alt"></i>',
          label: 'In',
          callback: async () => {
            this.ignoreRender = true
            if (!isSrcFirst) {
              await GURPS.removeKey(this, srckey)
              await this.updateParentOf(srckey, false)
            }
            let k = targetkey + '.contains.' + zeroFill(0)
            // let targ = foundry.utils.getProperty(this, targetkey)

            await this.updateItemAdditionsBasedOn(object, targetkey)
            await GURPS.insertBeforeKey(this, k, object)
            await this.updateParentOf(k, true)
            if (isSrcFirst) {
              await GURPS.removeKey(this, srckey)
              await this.updateParentOf(srckey, false)
            }
            this._forceRender()
          },
        },
      },
      default: 'one',
    })
    d.render(true)
  }

  /**
   * @param {string} path
   */
  async toggleExpand(path, expandOnly = false) {
    let obj = foundry.utils.getProperty(this, path)
    if (!!obj.collapsed && Object.keys(obj.collapsed).length > 0) {
      let temp = { ...obj.contains, ...obj.collapsed }
      let update = {
        [path + '.-=collapsed']: null,
        [path + '.collapsed']: {},
        [path + '.contains']: temp,
      }
      await this.update(update)
    } else if (!expandOnly && !!obj.contains && Object.keys(obj.contains).length > 0) {
      let temp = { ...obj.contains, ...obj.collapsed }
      let update = {
        [path + '.-=contains']: null,
        [path + '.contains']: {},
        [path + '.collapsed']: temp,
      }
      await this.update(update)
    }
  }

  /**
   * @param {string} srckey
   * @param {string} targetkey
   */
  async _splitEquipment(srckey, targetkey) {
    let srceqt = foundry.utils.getProperty(this, srckey)
    if (srceqt.count <= 1) return false // nothing to split
    let content = await renderTemplate('systems/gurps/templates/transfer-equipment.html', { eqt: srceqt })
    let count = 0
    let callback = async (/** @type {JQuery<HTMLElement>} */ html) =>
      (count = parseInt(html.find('#qty').val()?.toString() || '0'))
    await Dialog.prompt({
      title: 'Split stack',
      label: i18n('GURPS.ok'),
      content: content,
      callback: callback,
    })
    if (count <= 0) return true // didn't want to split
    if (count >= srceqt.count) return false // not a split, but a move
    if (targetkey.match(/^data\.equipment\.\w+$/)) targetkey += '.' + zeroFill(0)
    if (!!srceqt.globalid) {
      this.ignoreRender = true
      await this.updateEqtCount(srckey, srceqt.count - count)
      let rawItem = this.items.get(srceqt.itemid)
      if (rawItem) {
        let item = GurpsItem.asGurpsItem(rawItem)
        item.system.eqt.count = count
        await this.addNewItemData(item, targetkey)
        await this.updateParentOf(targetkey, true)
      }
      this._forceRender()
      return true
    } else {
      // simple eqt
      let neqt = foundry.utils.duplicate(srceqt)
      neqt.count = count
      this.ignoreRender = true
      await this.updateEqtCount(srckey, srceqt.count - count)
      await GURPS.insertBeforeKey(this, targetkey, neqt)
      await this.updateParentOf(targetkey, true)
      this._forceRender()
      return true
    }
  }

  /**
   * @param {string} srckey
   * @param {string} targetkey
   */
  async _checkForMerging(srckey, targetkey) {
    let srceqt = foundry.utils.getProperty(this, srckey)
    let desteqt = foundry.utils.getProperty(this, targetkey)
    if (
      (!!srceqt.globalid && srceqt.globalid == desteqt.globalid) ||
      (!srceqt.globalid && srceqt.name == desteqt.name)
    ) {
      this.ignoreRender = true
      await this.updateEqtCount(targetkey, parseInt(srceqt.count) + parseInt(desteqt.count))
      //if (srckey.includes('.carried') && targetkey.includes('.other')) await this._removeItemAdditionsBasedOn(desteqt)
      await this.deleteEquipment(srckey)
      this._forceRender()
      return true
    }
    return false
  }

  // This function merges the 'where' and 'dr' properties of this actor's hitlocations
  // with the roll value from the  HitLocations.hitlocationRolls, converting the
  // roll from a string to an array of numbers (see the _convertRollStringToArrayOfInt
  // function).
  //
  // return value is an object with the following structure:
  // 	{
  //  	where: string value from the hitlocations table,
  //  	dr: int DR value from the hitlocations table,
  //  	rollText: string value of the roll from the hitlocations table (examples: '5', '6-9', '-')
  //  	roll: array of int of the values that match rollText (examples: [5], [6,7,8,9], [])
  // 	}
  get hitLocationsWithDR() {
    let myhitlocations = []
    let table = this._hitLocationRolls
    for (const [_key, value] of Object.entries(this.system.hitlocations)) {
      let rollText = value.roll
      if (!value.roll && !!table[value.where])
        // Can happen if manually edited
        rollText = table[value.where].roll
      if (!rollText) rollText = HitLocations.HitLocation.DEFAULT
      let dr = parseInt(value.dr)
      if (isNaN(dr)) dr = 0
      let entry = new HitLocationEntry(value.where, dr, rollText, value?.split)
      myhitlocations.push(entry)
    }
    return myhitlocations
  }

  /**
   * @returns an object where each property is a hitlocation, keyed by location.where.
   */
  get hitLocationByWhere() {
    const byWhere = {}
    if (this.system.hitlocations) {
      // Convert this.system.hitlocations into an object keyed by location.where.
      for (const [_key, value] of Object.entries(this.system.hitlocations)) {
        byWhere[`${value.where}`] = value
      }
    }
    return byWhere
  }

  /**
   * @returns the appropriate hitlocation table based on the actor's bodyplan
   */
  get _hitLocationRolls() {
    return HitLocations.HitLocation.getHitLocationRolls(this.system.additionalresources?.bodyplan)
  }

  // Return the 'where' value of the default hit location, or 'Random'
  // NOTE: could also return 'Large-Area'?
  get defaultHitLocation() {
    // TODO implement a system setting but (potentially) allow it to be overridden
    return game.settings.get('gurps', 'default-hitlocation')
  }

  getCurrentDodge() {
    return this.system.currentdodge
  }

  getCurrentMove() {
    return this.system.currentmove
  }

  getTorsoDr() {
    if (!this.system.hitlocations) return 0
    let hl = Object.values(this.system.hitlocations).find(h => h.penalty == 0)
    return !!hl ? hl : { dr: 0 }
  }

  /**
   * @param {string} key
   */
  getEquipped(key) {
    let val = 0
    let txt = ''

    if (!!this.system.melee && !!this.system.equipment?.carried) {
      // Go through each melee attack...
      Object.values(this.system.melee).forEach(melee => {
        // ...and see if there's a matching piece of carried equipment.
        recurselist(this.system.equipment.carried, (equipment, _k, _d) => {
          if (equipment?.equipped && !!namesMatch(melee, equipment)) {
            let t = parseInt(melee[key])
            if (!isNaN(t)) {
              if (t > val || (t === val && /f$/i.test(melee[key]))) {
                val = t
                txt = '' + melee[key]
              }
            }
          }
        })
      })
    }

    // Find any parry/block in the melee attacks that do NOT match any equipment.
    Object.values(this.system?.melee ?? {}).forEach(melee => {
      // If the current melee attack has a defense (parry|block) ...
      if (/\d+.*/.test(melee[key])) {
        let matched = false
        const equipment = this.system.equipment

        recurselist(equipment.carried, (item, _k, _d) => {
          if (!matched && namesMatch(melee, item)) {
            matched = true
          }
        })

        recurselist(equipment.other, (item, _k, _d) => {
          if (!matched && namesMatch(melee, item)) {
            matched = true
          }
        })

        if (!matched) {
          let t = parseInt(melee[key])
          if (!isNaN(t)) {
            if (t > val) {
              val = t
              txt = '' + melee[key]
            }
          }
        }
      }
    })

    if (!val && !!this.system[key]) {
      txt = '' + this.system[key]
      val = parseInt(txt)
    }
    return [txt, val]

    function namesMatch(melee, equipment) {
      return melee.name.match(makeRegexPatternFrom(equipment.name, false))
    }
  }

  getEquippedParry() {
    let [txt, val] = this.getEquipped('parry')
    this.system.equippedparryisfencing = !!txt && /f$/i.test(txt)
    return val
  }

  getEquippedBlock() {
    return this.getEquipped('block')[1]
  }

  getEquippedDefenseBonuses() {
    let defenses = { parry: {}, block: {}, dodge: {} }
    const carried = this.system.equipment?.carried

    if (carried) {
      recurselist(carried, (item, _k, _d) => {
        if (item?.equipped) {
          const match = item.notes.match(/\[(?<bonus>[+-]\d+)\s*DB\]/)
          if (match) {
            const bonus = parseInt(match.groups.bonus)
            defenses.parry = { bonus: bonus }
            defenses.block = { bonus: bonus }
            defenses.dodge = { bonus: bonus }
          }
        }
      })
    }

    return defenses
  }

  /**
   * @override Sort Maneuvers to the front of the temporary effects.
   * @since Foundry v12
   */
  get temporaryEffects() {
    const effects = super.temporaryEffects
    const results = [...effects.filter(e => e.isManeuver), ...effects.filter(e => !e.isManeuver)]
    return results
  }

  /**
   *
   * @param {string} name of the status effect
   * @param {boolean} active (desired) state - true or false
   */
  toggleEffectByName(name, active) {
    let tokens = this.getActiveTokens(true)
    for (const token of tokens) {
      token.setEffectActive(name, active)
    }
  }

  /**
   * @param {string} pattern
   */
  findEquipmentByName(pattern, otherFirst = false) {
    while (pattern[0] == '/') pattern = pattern.substring(1)
    pattern = makeRegexPatternFrom(pattern, false)
    let pats = pattern
      .substring(1) // remove the ^ from the beginning of the string
      .split('/')
      .map(e => new RegExp('^' + e, 'i')) // and apply it to each pattern
    /**
     * @type {any}
     */
    var eqt, key
    let list1 = otherFirst ? this.system.equipment.other : this.system.equipment.carried
    let list2 = otherFirst ? this.system.equipment.carried : this.system.equipment.other
    let pkey1 = otherFirst ? 'system.equipment.other.' : 'system.equipment.carried.'
    let pkey2 = otherFirst ? 'system.equipment.carried.' : 'system.equipment.other.'
    recurselist(
      list1,
      (e, k, d) => {
        let l = pats.length - 1
        let p = pats[Math.min(d, l)]
        if (e.name.match(p)) {
          if (!eqt && (d == l || pats.length == 1)) {
            eqt = e
            key = k
          }
        } else return pats.length == 1
      },
      pkey1
    )
    recurselist(
      list2,
      (e, k, d) => {
        let l = pats.length - 1
        let p = pats[Math.min(d, l)]
        if (e.name.match(p)) {
          if (!eqt && (d == l || pats.length == 1)) {
            eqt = e
            key = k
          }
        } else return pats.length == 1
      },
      pkey2
    )
    return [eqt, key]
  }

  /**
   * @param {number} currentWeight
   */
  checkEncumbance(currentWeight) {
    /** @type {{ [key: string]: any }} */
    let encs = this.system.encumbrance
    let last = zeroFill(0) // if there are encumbrances, there will always be a level0
    var best, prev
    for (let key in encs) {
      let enc = encs[key]
      if (enc.current) prev = key
      let w = parseFloat(enc.weight)
      if (w > 0) {
        last = key
        if (currentWeight <= w) {
          best = key
          break
        }
      }
    }
    if (!best) best = last // that has a weight
    if (best != prev) {
      for (let key in encs) {
        let enc = encs[key]
        // let t = 'system.encumbrance.' + key + '.current'
        if (key === best) {
          enc.current = true
          this.system.currentmove = parseInt(enc.currentmove)
          this.system.currentdodge = parseInt(enc.currentdodge)
        } else if (enc.current) {
          enc.current = false
        }
      }
    }
  }

  // Set the equipment count to 'count' and then recalc sums
  /**
   * @param {string} eqtkey
   * @param {number} count
   */
  async updateEqtCount(eqtkey, count) {
    /** @type {{ [key: string]: any }} */
    let eqt = foundry.utils.getProperty(this, eqtkey)
    if (!(await this._sanityCheckItemSettings(eqt))) return
    let update = { [eqtkey + '.count']: count }
    if (game.settings.get(settings.SYSTEM_NAME, settings.SETTING_AUTOMATICALLY_SET_IGNOREQTY))
      update[eqtkey + '.ignoreImportQty'] = true
    await this.update(update)
    if (!game.settings.get(settings.SYSTEM_NAME, settings.SETTING_USE_FOUNDRY_ITEMS)) {
      eqt = foundry.utils.getProperty(this, eqtkey)
      await this.updateParentOf(eqtkey, false)
      if (!!eqt.itemid) {
        let item = this.items.get(eqt.itemid)
        if (!!item) await this.updateEmbeddedDocuments('Item', [{ _id: item.id, 'system.eqt.count': count }])
        else {
          ui.notifications?.warn('Invalid Item in Actor... removing all features')
          await this._removeItemAdditions(eqt.itemid)
        }
      }
    } else {
      let item = this.items.get(eqt.itemid)
      if (!!item) {
        item.system.eqt.count = count
        if (game.settings.get(settings.SYSTEM_NAME, settings.SETTING_AUTOMATICALLY_SET_IGNOREQTY))
          item.system.eqt.ignoreImportQty = true
        await item.actor._updateItemFromForm(item)
      }
      await this.updateParentOf(eqtkey, false)
    }
  }

  // Used to recalculate weight and cost sums for a whole tree.
  /**
   * @param {string} srckey
   */
  async updateParentOf(srckey, updatePuuid = true) {
    // pindex = 4 for equipment
    let pindex = 4
    let paths = srckey.split('.')
    let sp = paths.slice(0, pindex).join('.') // find the top level key in this list
    // But count may have changed... if (srckey == sp) return // no parent for this eqt
    let parent = foundry.utils.getProperty(this, sp)
    if (!!parent) {
      // data protection
      await Equipment.calcUpdate(this, parent, sp) // and re-calc cost and weight sums from the top down
      if (updatePuuid) {
        let puuid = ''
        if (paths.length >= 6) {
          sp = paths.slice(0, -2).join('.')
          puuid = foundry.utils.getProperty(this, sp).uuid
        }
        await this.internalUpdate({ [srckey + '.parentuuid']: puuid })
        let eqt = foundry.utils.getProperty(this, srckey)
        if (!!eqt.itemid) {
          let item = this.items.get(eqt.itemid)
          if (item) await this.updateEmbeddedDocuments('Item', [{ _id: item.id, 'system.eqt.parentuuid': puuid }])
        }
      }
    }
  }

  isEmptyActor() {
    let d = this.system
    let chkAttr = (/** @type {string} */ attr) => {
      return d.attributes[attr].import != 10
    }

    if (d.HP.max != 0) return false
    if (d.HP.value != 0) return false
    if (d.FP.max != 0) return false
    if (d.FP.value != 0) return false
    if (chkAttr('ST')) return false
    if (chkAttr('DX')) return false
    if (chkAttr('IQ')) return false
    if (chkAttr('HT')) return false
    if (chkAttr('WILL')) return false
    if (chkAttr('PER')) return false

    return true
  }

  async _updateEquipmentCalc(equipKey) {
    if (!equipKey.includes('system.eqt.')) return
    const equip = foundry.utils.getProperty(this, equipKey)
    await Equipment.calc(equip)
    if (!!equip.parentuuid) {
      const parentKey = this._findEqtkeyForId('itemid', equip.parentuuid)
      if (parentKey) {
        await this._updateEquipmentCalc(parentKey)
      }
    }
  }

  async _updateItemFromForm(item) {
    const sysKey =
      item.type === 'equipment'
        ? this._findEqtkeyForId('itemid', item.id)
        : this._findSysKeyForId('itemid', item.id, item.actorComponentKey)

    const actorComp = foundry.utils.getProperty(this, sysKey)

    if (!(await this._sanityCheckItemSettings(actorComp))) return

    if (!!item.editingActor) delete item.editingActor

    await this._removeItemAdditions(item.id)

    // Check for Equipment changed count
    // If originalCount exists, let's check if the count has changed
    // If changed and ignoreImportQty is true, we need to add the flag to the item
    if (
      item.type === 'equipment' &&
      game.settings.get(settings.SYSTEM_NAME, settings.SETTING_AUTOMATICALLY_SET_IGNOREQTY) &&
      !!item.system.eqt.originalCount &&
      !isNaN(item.system.eqt.originalCount) &&
      item.system.eqt.originalCount !== item.system.eqt.count
    ) {
      item.system.eqt.ignoreImportQty = true
    }

    // Update Item
    item.system.modifierTags = cleanTags(item.system.modifierTags).join(', ')
    await this.updateEmbeddedDocuments('Item', [{ _id: item.id, system: item.system, name: item.name }])

    // Update Actor Component
    const itemInfo = item.getItemInfo()
    await this.internalUpdate({
      [sysKey]: {
        ...item.system[item.itemSysKey],
        uuid: actorComp.uuid,
        parentuuid: actorComp.parentuuid,
        itemInfo,
        addToQuickRoll: item.system.addToQuickRoll,
        modifierTags: item.system.modifierTags,
        itemModifiers: item.system.itemModifiers,
      },
    })
    await this._addItemAdditions(item, sysKey)
    if (item.type === 'equipment') {
      await this.updateParentOf(sysKey, true)
      await this._updateEquipmentCalc(sysKey)
    }
  }

  async _sanityCheckItemSettings(actorComp) {
    let canEdit = false
    let message

    if (!!game.settings.get(settings.SYSTEM_NAME, settings.SETTING_USE_FOUNDRY_ITEMS)) {
      message = 'GURPS.settingNoEquipAllowedHint'
      if (!!actorComp.itemid) canEdit = true
    } else {
      message = 'GURPS.settingNoItemAllowedHint'
      if (!actorComp.itemid) {
        canEdit = true
      } else {
        const item = this.items.get(actorComp.itemid)
        if (!!item && item.type === 'equipment') canEdit = true
      }
    }

    if (!canEdit) {
      const phrases = game.i18n
        .localize(message)
        .split('.')
        .filter(p => !!p)
        .map(p => `${p.trim()}.`)
      const body = phrases.join('</p><p>')
      const dialog = new Dialog(
        {
          title: game.i18n.localize('GURPS.settingNoEditAllowed'),
          content: `<p>${body}</p>`,
          buttons: {
            ok: {
              label: 'OK',
            },
          },
        },
        {
          width: 400,
        }
      )
      await dialog.render(true)
    }
    return canEdit
  }

  /**
   * Executes a GURPS action parsed from a given OTF string.
   *
   * This is intended for external libraries like Argon Combat HUD.
   *
   * @param {string} otf - The On-The-Fly (OTF) string representing the action to be performed.
   * @return {Promise<void>} A promise that resolves once the action has been performed.
   */
  async runOTF(otf) {
    const action = parselink(otf)
    await GURPS.performAction(action.action, this)
  }

  /**
   * Retrieves the value of the 'usingQuintessence' setting from the game settings.
   *
   * This is intended for external libraries like Argon Combat HUD.
   *
   * @return {boolean} The value of the 'usingQuintessence' setting.
   */
  get usingQuintessence() {
    return game.settings.get(settings.SYSTEM_NAME, settings.SETTING_USE_QUINTESSENCE)
  }

  // TODO review and refactor
  _getDRFromItems(actorLocations, update = true) {
    let itemMap = {}
    if (update) {
      recurselist(actorLocations, (e, _k, _d) => {
        e.drItem = 0
      })
    }

    for (let item of this.items.filter(i => !!i.system.carried && !!i.system.equipped && !!i.system.bonuses)) {
      const bonusList = item.system.bonuses || ''
      let bonuses = bonusList.split('\n')

      for (let bonus of bonuses) {
        let m = bonus.match(/\[(.*)\]/)
        if (!!m) bonus = m[1] // remove extranious  [ ]

        m = bonus.match(/DR *([+-]\d+) *(.*)/)
        if (!!m) {
          let delta = parseInt(m[1])
          let locPatterns = null

          if (!!m[2]) {
            let locs = splitArgs(m[2])
            locPatterns = locs.map(l => new RegExp(makeRegexPatternFrom(l), 'i'))
            recurselist(actorLocations, (e, _k, _d) => {
              if (!locPatterns || locPatterns.find(p => !!e.where && e.where.match(p)) != null) {
                if (update) e.drItem += delta
                itemMap[e.where] = {
                  ...itemMap[e.key],
                  [item.name]: delta,
                }
              }
            })
          }
        }
      }
    }
    return itemMap
  }

  // TODO review and refactor
  _changeDR(drFormula, hitLocation) {
    if (drFormula === 'reset') {
      hitLocation.dr = hitLocation.import
      hitLocation.drMod = 0
      hitLocation.drCap = 0
      hitLocation.drItem = 0
      return hitLocation
    }
    if (!hitLocation.drItem) hitLocation.drItem = 0

    if (typeof hitLocation.import === 'string') hitLocation.import = parseInt(hitLocation.import)

    if (drFormula.startsWith('+') || drFormula.startsWith('-')) {
      hitLocation.drMod += parseInt(drFormula)
      hitLocation.dr = Math.max(hitLocation.import + hitLocation.drMod + hitLocation.drItem, 0)
      hitLocation.drCap = hitLocation.dr
    } else if (drFormula.startsWith('*')) {
      if (!hitLocation.drCap) hitLocation.drCap = Math.max(hitLocation.import + hitLocation.drItem, 0)
      hitLocation.drCap = hitLocation.drCap * parseInt(drFormula.slice(1))
      hitLocation.dr = hitLocation.drCap
      hitLocation.drMod = hitLocation.drCap - hitLocation.drItem - hitLocation.import
    } else if (drFormula.startsWith('/')) {
      if (!hitLocation.drCap) hitLocation.drCap = Math.max(hitLocation.import + hitLocation.drItem, 0)
      hitLocation.drCap = Math.max(Math.floor(hitLocation.drCap / parseInt(drFormula.slice(1))), 0)
      hitLocation.dr = hitLocation.drCap
      hitLocation.drMod = hitLocation.drCap - hitLocation.drItem - hitLocation.import
    } else if (drFormula.startsWith('!')) {
      hitLocation.drMod = parseInt(drFormula.slice(1))
      hitLocation.dr = parseInt(drFormula.slice(1))
      hitLocation.drCap = parseInt(drFormula.slice(1))
    } else {
      hitLocation.drMod = parseInt(drFormula)
      hitLocation.dr = Math.max(hitLocation.import + hitLocation.drMod + hitLocation.drItem, 0)
      hitLocation.drCap = hitLocation.dr
    }
    return hitLocation
  }

  async refreshDR() {
    await this.changeDR('+0', [])
  }

  // TODO review and refactor
  async changeDR(drFormula, drLocations) {
    let changed = false
    let actorLocations = { ...this.system.hitlocations }
    let affectedLocations = []
    let availableLocations = []

    this._getDRFromItems(actorLocations)

    if (drLocations.length > 0) {
      // Get Actor Body Plan
      let bodyPlan = this.system.additionalresources.bodyplan
      if (!bodyPlan) {
        return { changed, warn: 'No body plan found in actor.' }
      }
      const table = HitLocation.getHitLocationRolls(bodyPlan)

      // Humanoid Body Plan example: [
      //   "Eye",
      //   "Skull",
      //   "Face",
      //   "Right Leg",
      //   "Right Arm",
      //   "Torso",
      //   "Groin",
      //   "Left Arm",
      //   "Left Leg",
      //   "Hand",
      //   "Foot",
      //   "Neck",
      //   "Vitals"
      // ]
      availableLocations = Object.keys(table).map(l => l.toLowerCase())
      affectedLocations = availableLocations.filter(l => {
        for (let loc of drLocations) {
          if (l.includes(loc)) return true
        }
        return false
      })
      if (!affectedLocations.length) {
        let msg = `<p>No valid locations found using: <i>${drLocations.join(
          ', '
        )}</i>.</p><p>Available locations are: <ul><li>${availableLocations.join('</li><li>')}</li></ul>`
        let warn = 'No valid locations found. Available locations are: ' + availableLocations.join(', ')
        return { changed, msg, warn }
      }
    }

    for (let key in actorLocations) {
      let formula
      if (!drLocations.length || affectedLocations.includes(actorLocations[key].where.toLowerCase())) {
        changed = true
        formula = drFormula
      } else {
        formula = '+0'
      }
      actorLocations[key] = this._changeDR(formula, actorLocations[key])
    }
    if (changed) {
      // Exclude than rewrite the hitlocations on Actor
      await this.internalUpdate({ 'system.-=hitlocations': null })
      await this.update({ 'system.hitlocations': actorLocations })
      const msg = `${this.name}: DR ${drFormula} applied to ${
        affectedLocations.length > 0 ? affectedLocations.join(', ') : 'all locations'
      }`
      return { changed, msg, info: msg }
    }
  }

  // TODO: maybe this belongs in actorsheet.js ?
  getDRTooltip(locationKey) {
    const hitLocation = this.system.hitlocations[locationKey]
    if (!hitLocation) return ''
    const drBase = hitLocation.import
    const drMod = hitLocation.drMod || 0
    const drItem = hitLocation.drItem || 0
    const itemMap = this._getDRFromItems(this.system.hitlocations, false)
    const drLoc = itemMap[hitLocation.where] || {}
    const drItemLines = Object.keys(drLoc).map(k => `${k}: ${drLoc[k]}`)

    const context = { drBase, drMod, drItem, drItemLines }
    const template = Handlebars.partials['dr-tooltip']
    const compiledTemplate = Handlebars.compile(template)
    return new Handlebars.SafeString(compiledTemplate(context))
  }

  findByOriginalName(name, include = false) {
    let item = this.items.find(i => i.system.originalName === name)
    if (!item) item = this.items.find(i => i.system.name === name)
    if (!!item) return item

    const actorSysKeys = ['ads', 'skills', 'spells']
    for (let key of actorSysKeys) {
      let sysKey = this._findSysKeyForId('originalName', name, key, include)
      if (!sysKey) sysKey = this._findSysKeyForId('name', name, key, include)
      if (sysKey) return foundry.utils.getProperty(this, sysKey)
      const camelCaseName = name
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join('')
      const localizedKey = `GURPS.trait${camelCaseName}`
      const localizedName = game.i18n.localize(localizedKey)
      if (localizedName && localizedName !== localizedKey) {
        sysKey = this._findSysKeyForId('originalName', localizedName, key, include)
        if (!sysKey) sysKey = this._findSysKeyForId('name', localizedName, key, include)
        if (sysKey) return foundry.utils.getProperty(this, sysKey)
      }
    }
  }

  /**
   * Return all Checks of the given type.
   * @param {string} checkType
   * @returns {object} result
   * @returns {any[]} result.data - The checks
   * @returns {{integer}} result.size - The number of checks
   */
  getChecks(checkType) {
    const quickRollSettings = game.settings.get(Settings.SYSTEM_NAME, Settings.SETTING_USE_QUICK_ROLLS)
    if (!quickRollSettings[checkType]) {
      return { data: [], size: 0 }
    }
    let result = {}
    let checks = []
    const data = {}
    let size = 0

    switch (checkType) {
      case 'attributeChecks':
        const keys = ['ST', 'DX', 'IQ', 'HT', 'WILL', 'PER']
        for (const key of keys) {
          const attribute = this.system.attributes[key]
          checks.push({
            symbol: game.i18n.localize(`GURPS.attributes${key}`),
            label: game.i18n.localize(`GURPS.attributes${key}NAME`),
            value: attribute.import,
            otf: key,
          })
        }
        result.data = checks
        result.size = checks.length
        break
      case 'otherChecks':
        const icons = {
          checks: {
            vision: 'fa-solid fa-eye',
            hearing: 'fa-solid fa-ear',
            frightcheck: 'fa-solid fa-face-scream',
            tastesmell: 'fa-regular fa-nose',
            touch: 'fa-solid fa-hand-point-up',
          },
          dmg: {
            thrust: 'fa-solid fa-sword',
            swing: 'fa-solid fa-mace',
          },
        }
        for (const key of Object.keys(icons)) {
          let checks = []
          for (const subKey of Object.keys(icons[key])) {
            const value = this.system[subKey]
            checks.push({
              symbol: icons[key][subKey],
              label: game.i18n.localize(`GURPS.${subKey}`),
              value,
              otf: subKey,
            })
            size += 1
          }
          data[key] = checks
        }
        result.data = data
        result.size = size
        break
      case 'attackChecks':
        const attacks = ['melee', 'ranged']
        for (const key of attacks) {
          let checks = []
          recurselist(this.system[key], (attack, _k, _d) => {
            if (attack.addToQuickRoll) {
              let comp = this.findByOriginalName(attack.originalName || attack.name)
              if (!comp) comp = this.findEquipmentByName(attack.name)[0]
              const img = this.items.get(comp?.itemid)?.img
              const symbol = game.i18n.localize(`GURPS.${key}`)
              let otf = `${key.slice(0, 1)}:"${attack.name}"`
              if (attack.mode) otf += ` (${attack.mode})`
              let oftName = attack.name
              if (attack.mode) oftName += ` (${attack.mode})`
              checks.push({
                symbol,
                img,
                label: attack.name,
                value: attack.import,
                damage: attack.damage,
                mode: attack.mode,
                otf: `${key.slice(0, 1)}:"${oftName}"`,
                otfDamage: `d:${oftName}`,
              })
              size += 1
            }
          })
          data[key] = checks
        }
        result.data = data
        result.size = size
        break
      case 'defenseChecks':
        recurselist(this.system.encumbrance, (enc, _k, _d) => {
          if (enc.current) {
            data.dodge = {
              symbol: 'dodge',
              label: game.i18n.localize(`GURPS.dodge`),
              value: enc.dodge,
              otf: `dodge`,
            }
          }
        })
        const defenses = ['parry', 'block']
        for (const key of defenses) {
          let checks = []
          recurselist(this.system.melee, (defense, _k, _d) => {
            if (parseInt(defense[key] || 0) > 0 && defense.addToQuickRoll) {
              let comp = this.findByOriginalName(defense.originalName || defense.name)
              if (!comp) comp = this.findEquipmentByName(defense.name)[0]
              const img = this.items.get(comp?.itemid)?.img
              const symbol = game.i18n.localize(`GURPS.${key}`)
              let otf = `${key.slice(0, 1)}:"${defense.name}"`
              if (defense.mode) otf += ` (${defense.mode})`
              checks.push({
                symbol,
                img,
                label: defense.name,
                value: defense[key],
                mode: defense.mode,
                otf,
              })
              size += 1
            }
          })
          data[key] = checks
        }
        result.data = data
        result.size = size + 1
        break
      case 'markedChecks':
        const traits = ['skills', 'spells', 'ads']

        for (const traitType of traits) {
          recurselist(this.system[traitType], (trait, _k, _d) => {
            if (trait.addToQuickRoll) {
              let comp = this.findByOriginalName(trait.originalName || trait.name)
              const img = this.items.get(comp?.itemid)?.img
              const symbol = game.i18n.localize(`GURPS.${traitType.slice(0, -1)}`)
              if (trait.import) {
                checks.push({
                  symbol,
                  img,
                  label: trait.name,
                  value: trait.import,
                  notes: trait.notes,
                  otf: `${traitType.slice(0, 2)}:"${trait.name}"`,
                  isOTF: false,
                })
              }
              const possibleOTFs = trait.notes.match(/\[.*?\]/g) || []
              for (const otf of possibleOTFs) {
                const parsed = parselink(otf)
                if (parsed) {
                  checks.push({
                    symbol,
                    img,
                    label: parsed.text.replace(/[\[\]]/g, ''),
                    value: '',
                    notes: trait.notes,
                    otf: `/r ${parsed.text}`,
                    isOTF: true,
                  })
                }
              }
            }
          })
        }
        result.data = checks
        result.size = checks.length
        break
    }
    return result
  }

  /**
   * Resolve and add tagged Modifier Effects.
   *
   * System will lookup each roll modifiers inside system.conditions.usermods
   * against the Items.modifierTags and add the modifiers to the ModifierBucket.
   *
   * @param chatThing
   * @param optionalArgs
   * @returns {Promise<boolean>}
   */
  async addTaggedRollModifiers(chatThing, optionalArgs, attack) {
    let isDamageRoll = false
    const taggedSettings = game.settings.get(Settings.SYSTEM_NAME, Settings.SETTING_USE_TAGGED_MODIFIERS)
    const allRollTags = taggedSettings.allRolls.split(',').map(it => it.trim().toLowerCase())

    // First get Item or Attribute Effect Tags
    let modifierTags, itemRef, refTags
    if (optionalArgs.obj) {
      const ref = chatThing
        .split('@')
        .pop()
        .match(/(\S+):/)?.[1]
        .toLowerCase()
      switch (ref) {
        case 'm':
          refTags = taggedSettings.allAttackRolls.split(',').map(it => it.trim().toLowerCase())
          refTags = refTags.concat(taggedSettings.allMeleeRolls.split(',').map(it => it.trim().toLowerCase()))
          break
        case 'r':
          refTags = taggedSettings.allAttackRolls.split(',').map(it => it.trim().toLowerCase())
          refTags = refTags.concat(taggedSettings.allRangedRolls.split(',').map(it => it.trim().toLowerCase()))
          break
        case 'p':
          refTags = taggedSettings.allDefenseRolls.split(',').map(it => it.trim().toLowerCase())
          refTags = refTags.concat(taggedSettings.allParryRolls.split(',').map(it => it.trim().toLowerCase()))
          break
        case 'b':
          refTags = taggedSettings.allDefenseRolls.split(',').map(it => it.trim().toLowerCase())
          refTags = refTags.concat(taggedSettings.allBlockRolls.split(',').map(it => it.trim().toLowerCase()))
          break
        case 'd':
          refTags = taggedSettings.allDamageRolls.split(',').map(it => it.trim().toLowerCase())
          isDamageRoll = true
          break
        case 'sk':
          refTags = taggedSettings.allSkillRolls.split(',').map(it => it.trim().toLowerCase())
          break
        case 'sp':
          refTags = taggedSettings.allSpellRolls.split(',').map(it => it.trim().toLowerCase())
          if (taggedSettings.useSpellCollegeAsTag) {
            const spell = optionalArgs.obj
            const collegeTags = cleanTags(spell.college)
            refTags = refTags.concat(collegeTags)
          }
          break
        case 'p':
          refTags = taggedSettings.allDefenseRolls.split(',').map(it => it.trim().toLowerCase())
          refTags = refTags.concat(taggedSettings.allParryRolls.split(',').map(it => it.trim().toLowerCase()))
          break
        case 'b':
          refTags = taggedSettings.allDefenseRolls.split(',').map(it => it.trim().toLowerCase())
          refTags = refTags.concat(taggedSettings.allBlockRolls.split(',').map(it => it.trim().toLowerCase()))
          break
        default:
          refTags = []
      }
      // Item or Actor Component
      modifierTags =
        (optionalArgs.obj?.modifierTags || '')
          .split(',')
          .map(it => it.trim())
          .map(it => it.toLowerCase()) || []
      modifierTags = [...modifierTags, ...allRollTags, ...refTags].filter(m => !!m)
      itemRef = optionalArgs.obj.name || optionalArgs.obj.originalName
    } else if (chatThing) {
      // Targeted Roll or Attribute Check
      const ref = chatThing.split('@').pop().toLowerCase().replace(' ', '').slice(0, -1).toLowerCase().split(':')[0]
      let refTags
      let regex = /(?<="|:).+(?=\s\(|"|])/gm
      switch (ref) {
        case 'st':
        case 'dx':
        case 'iq':
        case 'ht':
          refTags = taggedSettings[`all${ref.toUpperCase()}Rolls`].split(',').map(it => it.trim().toLowerCase())
          refTags.concat(taggedSettings.allAttributesRolls.split(',').map(it => it.trim().toLowerCase()))
          break
        case 'will':
        case 'per':
        case 'frightcheck':
        case 'vision':
        case 'hearing':
        case 'tastesmell':
        case 'touch':
        case 'cr':
          refTags = taggedSettings[`all${ref.toUpperCase()}Rolls`].split(',').map(it => it.trim().toLowerCase())
          break
        case 'dodge':
          refTags = taggedSettings.allDefenseRolls.split(',').map(it => it.trim().toLowerCase())
          refTags = refTags.concat(
            taggedSettings[`all${ref.toUpperCase()}Rolls`].split(',').map(it => it.trim().toLowerCase())
          )
          break
        case 'p':
          refTags = taggedSettings.allDefenseRolls.split(',').map(it => it.trim().toLowerCase())
          refTags = refTags.concat(taggedSettings.allParryRolls.split(',').map(it => it.trim().toLowerCase()))
          itemRef = chatThing.match(regex)?.[0]
          if (itemRef) itemRef = itemRef.replace(/"/g, '').split('(')[0].trim()
          break
        case 'b':
          refTags = taggedSettings.allDefenseRolls.split(',').map(it => it.trim().toLowerCase())
          refTags = refTags.concat(taggedSettings.allBlockRolls.split(',').map(it => it.trim().toLowerCase()))

          itemRef = chatThing.match(regex)?.[0]
          if (itemRef) itemRef = itemRef.replace(/"/g, '').split('(')[0].trim()
          break
        default:
          refTags = []
      }
      modifierTags = [...allRollTags, ...refTags]
    } else {
      // Damage roll from OTF or Attack
      if (!attack) {
        refTags = taggedSettings.allDamageRolls.split(',').map(it => it.trim().toLowerCase())
        isDamageRoll = true
      } else {
        refTags = taggedSettings.allAttackRolls.split(',').map(it => it.trim().toLowerCase())
      }
      const attackMods = attack?.modifierTags || []
      modifierTags = [...allRollTags, ...attackMods, ...refTags]
      itemRef = attack?.name || attack?.originalName
    }

    // Then get the modifiers from:
    // Actor User Mods
    const userMods = foundry.utils.getProperty(this, 'system.conditions.usermods') || []
    // Actor Self Mods
    const selfMods =
      foundry.utils.getProperty(this, 'system.conditions.self.modifiers').map(mod => {
        const key = mod.match(/(GURPS.\w+)/)?.[1] || ''
        if (key) return game.i18n.localize(key) + mod.replace(key, '')
        return mod
      }) || []
    // Actor Targeted Mods
    let targetMods = []
    for (const target of Array.from(game.user.targets)) {
      const targetActor = target.actor
      const mods = targetActor ? foundry.utils.getProperty(targetActor, 'system.conditions.target.modifiers') : []
      for (const mod of mods) {
        const key = mod.match(/(GURPS.\w+)/)?.[1] || ''
        if (key) targetMods.push(game.i18n.localize(key) + mod.replace(key, ''))
        else targetMods.push(mod)
      }
      const actorToken = this.getActiveTokens()[0]
      const rangeMod = getRangedModifier(actorToken, target)
      if (rangeMod) targetMods.push(rangeMod)
    }
    const allMods = [...userMods, ...selfMods, ...targetMods]
    const actorInCombat = game.combat?.combatants.find(c => c.actor.id === this.id) && game.combat?.isActive

    for (const userMod of allMods) {
      const userModsTags = (userMod.match(/#(\S+)/g) || []).map(it => it.slice(1).toLowerCase())
      for (const tag of userModsTags) {
        let canApply = modifierTags.includes(tag)
        if (userMod.includes('#maneuver')) {
          canApply = canApply && (userMod.includes(itemRef) || userMod.includes('@man:'))
        }
        if (actorInCombat) {
          canApply =
            canApply && (!taggedSettings.nonCombatOnlyTag || !modifierTags.includes(taggedSettings.nonCombatOnlyTag))
        } else {
          canApply = canApply && (!taggedSettings.combatOnlyTag || !modifierTags.includes(taggedSettings.combatOnlyTag))
        }
        if (canApply) {
          const regex = new RegExp(/^[+-]\d+(.*?)(?=[#@])/)
          const desc = userMod.match(regex)?.[1].trim() || ''
          const mod = userMod.match(/[-+]\d+/)?.[0] || '0'
          await GURPS.ModifierBucket.addModifier(mod, desc, undefined, true)
        }
      }
    }
    return isDamageRoll
  }

  /**
   * Check if Action consume Action.
   *
   * Default is false to handle rolls like Attributes
   *
   * @param action - Action parsed from OTF/GurpsLink
   * @param chatThing - String Representation of the Action
   * @param actorComp - Actor Component for the Action
   * @returns {boolean}
   */
  canConsumeAction(action, chatThing, actorComp = {}) {
    if (!action && !chatThing) return false
    const settingsUseMaxActions = game.settings.get(Settings.SYSTEM_NAME, Settings.SETTING_USE_MAX_ACTIONS)
    if (settingsUseMaxActions === 'Disable') return false
    const isCombatant = !!game.combat?.combatants.find(c => c.actor.id === this.id)
    if (!isCombatant && settingsUseMaxActions === 'AllCombatant') return false
    const actionType = chatThing.match(/(?<=@|)(\w+)(?=:)/g)?.[0].toLowerCase()
    const isAttack = action?.type === 'attack' || ['m', 'r'].includes(actionType)
    const isDefense =
      action?.attribute === 'dodge' ||
      action?.type === 'weapon-parry' ||
      action?.type === 'weapon-block' ||
      ['dodge', 'p', 'b'].includes(actionType)
    const isDodge = action?.attribute === 'dodge' || actionType === 'dodge'
    const isSkill = (action?.type === 'skill-spell' && action.isSkillOnly) || actionType === 'sk'
    const isSpell = (action?.type === 'skill-spell' && action.isSpellOnly) || actionType === 'sp'
    if ((isSpell || isAttack || isDefense) && !isDodge) {
      return actorComp.consumeAction !== undefined ? actorComp.consumeAction : true
    } else if (isSkill) {
      return actorComp.consumeAction !== undefined ? actorComp.consumeAction : false
    }
    return false
  }

  /**
   * Check if Roll can be performed.
   *
   * @param {object} action - Action parsed from OTF/GurpsLink
   * @param {GurpsToken|Token} token - Actor Token
   * @param {string} [chatThing] - String representation of the action
   * @param {object} [actorComp] - Actor Component for the Action
   * @returns {Promise<{canRoll: boolean, [message]: string, [targetMessage]: string, [maxActionMessage]: string, [maxBlockMessage]: string, [maxParryMessage]: string }>}
   */
  async canRoll(action, token, chatThing = '', actorComp = {}) {
    const isAttack = action.type === 'attack'
    const isDefense = action.attribute === 'dodge' || action.type === 'weapon-parry' || action.type === 'weapon-block'
    const isAttribute = action.type === 'attribute'
    const isSlam = action.type === 'damage' && action.orig.includes('slam') && action.orig.includes('@')
    const combatIsActive = !!game.combat?.isActive
    const isCombatant = !!game.combat?.combatants.find(c => c.actor.id === this.id)
    const combatStarted = combatIsActive && game.combat?.turn !== null && game.combat?.turn !== undefined

    let result = {
      canRoll: true,
      isSlam,
      hasActions: true,
      isCombatant,
    }

    const consumeAction = this.canConsumeAction(action, chatThing, actorComp)

    if (!combatIsActive || !isCombatant) return result

    if (token && combatIsActive && isCombatant && !isSlam) {
      const actions = await TokenActions.fromToken(token)

      // Check Attack or Defense vs Maneuver
      if ((!actions.canAttack && isAttack) || (!actions.canDefend && isDefense)) {
        const maneuver = Maneuvers.getManeuver(actions.currentManeuver)
        const maneuverLabel = game.i18n.localize(maneuver.label)
        const roll = game.i18n.localize(isAttack ? 'GURPS.attackRoll' : 'GURPS.defenseRoll')
        const checkManeuverSettings = game.settings.get(
          Settings.SYSTEM_NAME,
          Settings.SETTING_ALLOW_ROLL_BASED_ON_MANEUVER
        )
        const message =
          checkManeuverSettings !== 'Allow' &&
          game.i18n.format(`GURPS.${checkManeuverSettings.toLowerCase()}CannotRollWithManeuver`, {
            roll,
            maneuver: maneuverLabel,
          })
        result = {
          ...result,
          canRoll: checkManeuverSettings !== 'Forbid',
          message,
        }
      }

      // Check for Max Actions
      const checkMaxActionSettings = game.settings.get(Settings.SYSTEM_NAME, Settings.SETTING_ALLOW_AFTER_MAX_ACTIONS)
      const maxActions = foundry.utils.getProperty(this, 'system.conditions.actions.maxActions') || 1
      const actorExtraActions = actions.extraActions || 0
      if (
        !isAttack &&
        !isDefense &&
        !isAttribute &&
        actions.totalActions >= maxActions + actorExtraActions &&
        consumeAction
      ) {
        result = {
          ...result,
          canRoll: result.canRoll && checkMaxActionSettings !== 'Forbid',
          hasActions: false,
          maxActionMessage:
            checkMaxActionSettings !== 'Allow' &&
            game.i18n.localize(`GURPS.${checkMaxActionSettings.toLowerCase()}MaxActionsReached`),
        }
      }
      // Check for Max Attacks
      const itemExtraAttacks = actorComp.extraAttacks || 0
      const rapidStrikeBonus = actions.rapidStrikeBonus || 0
      if (
        isAttack &&
        consumeAction &&
        Math.max(actions.totalAttacks, actions.totalActions) >=
          maxActions + actorExtraActions + (actions.extraAttacks || 0) + itemExtraAttacks + rapidStrikeBonus
      ) {
        result = {
          ...result,
          canRoll: result.canRoll && checkMaxActionSettings !== 'Forbid',
          hasActions: false,
          maxAttackMessage:
            checkMaxActionSettings !== 'Allow' &&
            game.i18n.localize(`GURPS.${checkMaxActionSettings.toLowerCase()}MaxAttacksReached`),
        }
      }

      // Check for Max Blocks
      const maxBlocks = foundry.utils.getProperty(this, 'system.conditions.actions.maxBlocks') || 1
      if (
        isDefense &&
        action.type === 'weapon-block' &&
        actions.totalBlocks >= maxBlocks + (action.extraBlocks || 0) + actorExtraActions &&
        consumeAction
      ) {
        result = {
          ...result,
          canRoll: result.canRoll && checkMaxActionSettings !== 'Forbid',
          hasActions: false,
          maxBlockMessage:
            checkMaxActionSettings !== 'Allow' &&
            game.i18n.localize(`GURPS.${checkMaxActionSettings.toLowerCase()}MaxBlocksReached`),
        }
      }
      // Check for Max Parries
      if (
        isDefense &&
        action.type === 'weapon-parry' &&
        actions.totalParries >= actorExtraActions + (actions.maxParries || 0) &&
        consumeAction
      ) {
        result = {
          ...result,
          canRoll: result.canRoll && checkMaxActionSettings !== 'Forbid',
          hasActions: false,
          maxParryMessage:
            checkMaxActionSettings !== 'Allow' &&
            game.i18n.localize(`GURPS.${checkMaxActionSettings.toLowerCase()}MaxParriesReached`),
        }
      }

      // Check if Combat is started
      if (!combatStarted) {
        const checkCombatSettings = game.settings.get(
          Settings.SYSTEM_NAME,
          Settings.SETTING_ALLOW_ROLLS_BEFORE_COMBAT_START
        )
        result = {
          ...result,
          canRoll: result.canRoll && checkCombatSettings !== 'Forbid',
          rollBeforeStartMessage:
            checkCombatSettings !== 'Allow' &&
            game.i18n.localize(`GURPS.${checkCombatSettings.toLowerCase()}RollsBeforeCombatStarted`),
        }
      }
    }
    // Check if roll need Target
    const needTarget = !isSlam && (isAttack || action.isSpellOnly || action.type === 'damage')
    const checkForTargetSettings = game.settings.get(Settings.SYSTEM_NAME, Settings.SETTING_ALLOW_TARGETED_ROLLS)
    if (isCombatant && needTarget && game.user.targets.size === 0) {
      result = {
        ...result,
        canRoll: result.canRoll && checkForTargetSettings !== 'Forbid',
        targetMessage:
          checkForTargetSettings !== 'Allow' &&
          game.i18n.localize(`GURPS.${checkForTargetSettings.toLowerCase()}NoTargetSelected`),
      }
    }
    return result
  }

  /**
   * Parse roll info based on action type.
   *
   * @param {object} action - Object from GURPS.parselink
   * @param {string} chatting - internal code for roll
   * @param {string} formula - formula for roll
   * @param {string} thing - name of the source of the roll
   * @returns {{}} result
   * @returns {string} result.name - Name of the action which originates the roll
   * @returns {[string]} result.uuid - UUID of the actor component that originates the roll
   * @returns {[string]} result.itemId - ID of the item that originates the roll
   * @returns {[string]} result.fromItem - ID of the parent item of the item that originates the roll
   * @returns {[string]} result.pageRef - Page reference of the item that originates the roll
   */
  findUsingAction(action, chatting, formula, thing) {
    const originType = action ? action.type : 'undefined'
    let result = {}
    let name, mode
    switch (originType) {
      case 'attack':
        name = action.name.split('(')[0].trim()
        mode = action.name.match(/\((.+)\)/)?.[1]
        const path = action.orig.toLowerCase().startsWith('m:') ? 'melee' : 'ranged'
        recurselist(this.system[path], (obj, _k, _d) => {
          if ((obj.originalName === name || obj.name === name) && (!mode || obj.mode === mode)) {
            result = {
              name: obj.name,
              uuid: obj.uuid,
              itemId: obj.itemid,
              fromItem: obj.fromItem,
              pageRef: obj.pageref,
            }
          }
        })
        if (!Object.keys(result).length) {
          result = {
            name: thing,
            uuid: null,
            itemId: null,
            fromItem: null,
            pageRef: null,
          }
        }
        break

      case 'weapon-block':
      case 'weapon-parry':
        name = action.name.split('(')[0].trim()
        mode = action.name.match(/\((.+?)\)/)?.[1]
        recurselist(this.system.melee, (melee, _k, _d) => {
          if ((melee.originalName === name || melee.name === name) && (!mode || melee.mode === mode)) {
            result = {
              name: melee.name,
              uuid: melee.uuid,
              itemId: melee.itemid,
              fromItem: melee.fromItem,
              pageRef: melee.pageref,
            }
          }
        })
        if (!Object.keys(result).length) {
          result = {
            name: thing,
            uuid: null,
            itemId: null,
            fromItem: null,
            pageRef: null,
          }
        }
        break
      case 'skill-spell':
        const item = this.findByOriginalName(action.name)
        if (!!item) {
          result = {
            name: item.name,
            uuid: item.uuid,
            itemId: item.itemid,
            fromItem: item.fromItem,
            pageRef: item.pageref,
          }
        } else {
          result = {
            name: action.name,
            uuid: null,
            itemId: null,
            fromItem: null,
            pageRef: null,
          }
        }
        break

      case 'attribute':
        let attrName = action?.overridetxt
        if (!attrName) attrName = game.i18n.localize(`GURPS.${action.attrkey.toLowerCase()}`)
        if (attrName.startsWith('GURPS')) attrName = game.i18n.localize(`GURPS.attributes${action.attrkey}NAME`)
        result = {
          name: attrName,
          uuid: null,
          itemId: null,
          fromItem: null,
          pageRef: null,
        }
        break

      case 'controlroll':
        result = {
          name: action.overridetxt || action.orig,
          uuid: null,
          itemId: null,
          fromItem: null,
          pageRef: null,
        }
        break

      default:
        result = {
          name: thing ? thing : chatting ? chatting.split('/[')[0] : formula,
          uuid: null,
          itemId: null,
          fromItem: null,
          pageRef: null,
        }
    }
    return result
  }
}
