'use strict'

import {
	xmlTextToJson,
	// convertRollStringToArrayOfInt,
	recurselist,
	makeRegexPatternFrom,
	i18n,
	i18n_f,
	splitArgs,
	generateUniqueId,
	objectToArray,
	arrayToObject,
	zeroFill,
	arrayBuffertoBase64,
} from '../../lib/utilities.js'
import { parselink, COSTS_REGEX } from '../../lib/parselink.js'
import { ResourceTrackerManager } from './resource-tracker-manager.js'
import ApplyDamageDialog from '../damage/applydamage.js'
import * as HitLocations from '../hitlocation/hitlocation.js'
import * as settings from '../../lib/miscellaneous-settings.js'
// import { SemanticVersion } from '../../lib/semver.js'
import {
	MOVE_NONE,
	MOVE_ONE,
	MOVE_STEP,
	MOVE_ONETHIRD,
	MOVE_HALF,
	MOVE_TWOTHIRDS,
	PROPERTY_MOVEOVERRIDE_MANEUVER,
	PROPERTY_MOVEOVERRIDE_POSTURE,
} from './maneuver.js'
import { SmartImporter } from '../smart-importer.js'
import { GurpsItem } from '../item.js'
import GurpsToken from '../token.js'
import { parseDecimalNumber } from '../../lib/parse-decimal-number/parse-decimal-number.js'
import {
	_Base,
	Skill,
	Spell,
	Advantage,
	Ranged,
	Note,
	Encumbrance,
	Equipment,
	Reaction,
	Modifier,
	Melee,
	HitLocationEntry,
	Language,
} from './actor-components.js'
import { multiplyDice } from '../utilities/damage-utils.js'

// Ensure that ALL actors has the current version loaded into them (for migration purposes)
Hooks.on('createActor', async function(/** @type {Actor} */ actor) {
	await actor.update({ '_stats.systemVersion': game.system.version })
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
		return game.users?.contents.filter(u => this.getUserLevel(u) >= CONST.DOCUMENT_PERMISSION_LEVELS.OWNER)
	}

	// 0.8.x added steps necessary to switch sheets
	/**
	 * @param {Application} newSheet
	 */
	async openSheet(newSheet) {
		const sheet = this.sheet
		if (!!sheet) {
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

		this.data.data.conditions.posture = 'standing'
		this.data.data.conditions.self = { modifiers: [] }
		this.data.data.conditions.target = { modifiers: [] }
		this.data.data.conditions.exhausted = false
		this.data.data.conditions.reeling = false

		{
			// Oh how I wish we had a typesafe model!
			// I hate treating everything as "maybe its a number, maybe its a string...?!"

			let sizemod = this.data.data.traits?.sizemod.toString() || '+0'
			if (sizemod.match(/^\d/g)) sizemod = `+${sizemod}`
			if (sizemod !== '0' && sizemod !== '+0') {
				this.data.data.conditions.target.modifiers.push(
					i18n_f('GURPS.modifiersSize', { sm: sizemod }, '{sm} for Size Modifier')
				)
			}
		}

		let attributes = this.data.data.attributes
		if (foundry.utils.getType(attributes.ST.import) === 'string')
			this.data.data.attributes.ST.import = parseInt(attributes.ST.import)
	}

	prepareEmbeddedEntities() {
		// Calls this.applyActiveEffects()
		super.prepareEmbeddedEntities()
	}

	prepareDerivedData() {
		super.prepareDerivedData()

		// Handle new move data -- if data.move exists, use the default value in that object to set the move
		// value in the first entry of the encumbrance object.
		if (this.data.data.encumbrance) {
			let move = this.data.data.move
			if (!move) {
				let currentMove = this.data.data.encumbrance['00000'].move ?? this.data.data.basicmove.value
				let value = { mode: MoveModes.Ground, basic: currentMove, default: true }
				setProperty(this.data.data, 'move.00000', value)
				move = this.data.data.move
			}

			let current = Object.values(move).find(it => it.default)
			if (current) {
				// This is nonpersistent, derived values only.
				this.data.data.encumbrance['00000'].move = current.basic
			}
		}

		this.calculateDerivedValues()
	}

	// execute after every import.
	async postImport() {
		this.calculateDerivedValues()

		// Convoluted code to add Items (and features) into the equipment list
		// @ts-ignore
		let orig = /** @type {GurpsItem[]} */ (this.items.contents.slice().sort((a, b) => b.name.localeCompare(a.name))) // in case items are in the same list... add them alphabetically
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
		for (const item of good) await this.addItemData(item.data.data) // re-add the item equipment and features

		await this.update({ '_stats.systemVersion': game.system.version }, { diff: false, render: false })
		// Set custom trackers based on templates.  should be last because it may need other data to initialize...
		await this.setResourceTrackers()
		await this.syncLanguages()
	}

	// Ensure Language Advantages conform to a standard (for Polygot module)
	async syncLanguages() {
		if (this.data.data.languages) {
			let updated = false
			let newads = { ...this.data.data.ads }
			let langn = new RegExp('Language:?', 'i')
			let langt = new RegExp(i18n('GURPS.language') + ':?', 'i')
			recurselist(this.data.data.languages, (e, k, d) => {
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
					else if (!!e.spoken)
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
				await this.update({ 'system.ads': newads })
			}
		}
	}

	// This will ensure that every characater at least starts with these new data values.  actor-sheet.js may change them.
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

		let maneuver = this.effects.contents.find(it => it.flags?.core?.statusId === 'maneuver')
		this.data.data.conditions.maneuver = !!maneuver ? maneuver.flags.gurps.name : 'undefined'
		this.ignoreRender = saved
		if (!saved) setTimeout(() => this._forceRender(), 500)
	}

	// Initialize the attribute starting values/levels.   The code is expecting 'value' or 'level' for many things, and instead of changing all of the GUIs and OTF logic
	// we are just going to switch the rug out from underneath.   "Import" data will be in the 'import' key and then we will calculate value/level when the actor is loaded.
	_initializeStartingValues() {
		const data = this.data.data
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
		recurselist(data.skills, (e, k, d) => {
			// @ts-ignore
			if (!!e.import) e.level = parseInt(+e.import)
		})
		recurselist(data.spells, (e, k, d) => {
			// @ts-ignore
			if (!!e.import) e.level = parseInt(+e.import)
		})

		// we don't really need to use recurselist for melee/ranged... but who knows, they may become hierarchical in the future
		recurselist(data.melee, (e, k, d) => {
			if (!!e.import) {
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

		recurselist(data.ranged, (e, k, d) => {
			e.level = parseInt(e.import)
		})

		recurselist(data.hitlocations, (e, k, d) => {
			e.dr = e.import
		})
	}

	_applyItemBonuses() {
		let pi = (/** @type {string | undefined} */ n) => (!!n ? parseInt(n) : 0)
		/** @type {string[]} */
		let gids = [] //only allow each global bonus to add once
		const data = this.data.data
		for (const item of this.items.contents) {
			let itemData = GurpsItem.asGurpsItem(item).system
			if (itemData.equipped && itemData.carried && !!itemData.bonuses && !gids.includes(itemData.globalid)) {
				gids.push(itemData.globalid)
				let bonuses = itemData.bonuses.split('\n')
				for (let bonus of bonuses) {
					let m = bonus.match(/\[(.*)\]/)
					if (!!m) bonus = m[1] // remove extranious  [ ]
					let link = parselink(bonus) // ATM, we only support attribute and skill
					if (!!link.action) {
						// start OTF
						recurselist(data.melee, (e, k, d) => {
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
						recurselist(data.ranged, (e, k, d) => {
							e.level = pi(e.level)
							if (link.action.type == 'attribute' && link.action.attrkey == 'DX') e.level += pi(link.action.mod)
							if (link.action.type == 'attack' && !!link.action.isRanged) {
								if (e.name.match(makeRegexPatternFrom(link.action.name, false))) e.level += pi(link.action.mod)
							}
						}) // end ranged
						recurselist(data.skills, (e, k, d) => {
							e.level = pi(e.level)
							if (link.action.type == 'attribute') {
								// skills affected by attribute changes
								if (e.relativelevel?.toUpperCase().startsWith(link.action.attrkey)) e.level += pi(link.action.mod)
							}
							if (link.action.type == 'skill-spell' && !link.action.isSpellOnly) {
								if (e.name.match(makeRegexPatternFrom(link.action.name, false))) e.level += pi(link.action.mod)
							}
						}) // end skills
						recurselist(data.spells, (e, k, d) => {
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
							let data = this.data.data
							if (paths.length > 0) data = getProperty(data, paths.join('.'))
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
						recurselist(data.hitlocations, (e, k, d) => {
							if (!locpatterns || locpatterns.find(p => !!e.where && e.where.match(p)) != null) {
								let dr = e.dr ?? ''
								dr += ''
								let m = dr.match(/(\d+) *([/\|]) *(\d+)/) // check for split DR 5|3 or 5/3
								if (!!m) {
									dr = parseInt(m[1]) + delta
									let dr2 = parseInt(m[3]) + delta
									e.dr = dr + m[2] + dr2
								} else if (!isNaN(parseInt(dr))) e.dr = parseInt(dr) + delta
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
		let data = this.data.data
		recurselist(data.equipment.carried, (e, k, d) => {
			if (e[key] == id) eqtkey = 'system.equipment.carried.' + k
		})
		if (!eqtkey)
			recurselist(data.equipment.other, (e, k, d) => {
				if (e[key] == id) eqtkey = 'system.equipment.other.' + k
			})
		return eqtkey
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
		let data = this.data.data
		let eqt = data.equipment || {}
		let eqtsummary = {
			eqtcost: this._sumeqt(eqt.carried, 'cost'),
			eqtlbs: this._sumeqt(
				eqt.carried,
				'weight',
				game.settings.get(settings.SYSTEM_NAME, settings.SETTING_CHECK_EQUIPPED)
			),
			othercost: this._sumeqt(eqt.other, 'cost'),
		}
		if (game.settings.get(settings.SYSTEM_NAME, settings.SETTING_AUTOMATIC_ENCUMBRANCE))
			this.checkEncumbance(eqtsummary.eqtlbs)
		data.eqtsummary = eqtsummary
	}

	_calculateEncumbranceIssues() {
		const data = this.data.data
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
				let threshold = 1.0 - 0.2 * parseInt(enc.level) // each encumbrance level reduces move by 20%
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

		if (!data.equippedparry) data.equippedparry = this.getEquippedParry()
		if (!data.equippedblock) data.equippedblock = this.getEquippedBlock()
		// catch for older actors that may not have these values set
		if (!data.currentmove) data.currentmove = parseInt(data.basicmove.value.toString())
		if (!data.currentdodge && data.dodge.value) data.currentdodge = parseInt(data.dodge.value.toString())
		if (!data.currentflight) data.currentflight = parseFloat(data.basicspeed.value.toString()) * 2
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
		let move = this.data.data.move
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
		} catch (err) { } // During game startup, an exception is being thrown trying to access 'game.combat'
		let updateMove = game.settings.get(settings.SYSTEM_NAME, settings.SETTING_MANEUVER_UPDATES_MOVE) && inCombat

		let maneuver = this._getMoveAdjustedForManeuver(move, threshold)
		let posture = this._getMoveAdjustedForPosture(move, threshold)

		if (threshold == 1.0) this.data.data.conditions.move = maneuver.move < posture.move ? maneuver.text : posture.text
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
			let mv = GURPS.Maneuvers.get(this.data.data.conditions.maneuver)
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
		switch (value) {
			case MOVE_NONE:
				return { move: 0, text: i18n_f('GURPS.moveNone', { reason: reason }) }

			case MOVE_ONE:
				return {
					move: 1,
					text: i18n_f('GURPS.moveConstant', { value: 1, unit: 'yard', reason: reason }, '1 {unit}/second'),
				}

			case MOVE_STEP:
				return { move: this._getStep(), text: i18n_f('GURPS.moveStep', { reason: reason }) }

			case MOVE_ONETHIRD:
				return {
					move: Math.max(1, Math.ceil((move / 3) * threshold)),
					text: i18n_f('GURPS.moveOneThird', { reason: reason }),
				}

			case MOVE_HALF:
				return {
					move: Math.max(1, Math.ceil((move / 2) * threshold)),
					text: i18n_f('GURPS.moveHalf', { reason: reason }),
				}

			case MOVE_TWOTHIRDS:
				return {
					move: Math.max(1, Math.ceil(((2 * move) / 3) * threshold)),
					text: i18n_f('GURPS.moveTwoThirds', { reason: reason }),
				}
		}

		return null
	}

	_getMoveAdjustedForPosture(move, threshold) {
		let adjustment = null

		if (foundry.utils.getProperty(this, PROPERTY_MOVEOVERRIDE_POSTURE)) {
			let value = foundry.utils.getProperty(this, PROPERTY_MOVEOVERRIDE_POSTURE)
			let reason = i18n(GURPS.StatusEffect.lookup(this.data.data.conditions.posture).label)
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
		let st = +this.data.data.attributes.ST.value
		recurselist(this.data.data.ranged, r => {
			let rng = r.range || '' // Data protection
			rng = rng + '' // force to string
			let m = rng.match(/^ *[xX]([\d\.]+) *$/)
			if (m) {
				rng = parseFloat(m[1]) * st
			} else {
				m = rng.match(/^ *[xX]([\d\.]+) *\/ *[xX]([\d\.]+) *$/)
				if (m) {
					rng = `${parseFloat(m[1]) * st}/${parseFloat(m[2]) * st}`
				}
			}
			r.range = rng
		})
	}

	// Once all of the bonuses are applied, determine the actual level for each feature
	_recalcItemFeatures() {
		let data = this.data.data
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
		let step = Math.ceil(parseInt(this.data.data.basicmove.value.toString()) / 10)
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
				let flag = data['system.HP.value'] < this.data.data.HP.max / 3
				if (!!this.data.data.conditions.reeling != flag) {
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
				let flag = data['system.FP.value'] < this.data.data.FP.max / 3
				if (!!this.data.data.conditions.exhausted != flag) {
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
				type: CONST.CHAT_MESSAGE_TYPES.WHISPER,
			}
			ChatMessage.create(messageData)
		})
	}

	async internalUpdate(data, context) {
		let ctx = { render: !this.ignoreRender }
		if (!!context) ctx = { ...context, ...ctx }
		await this.update(data, ctx)
	}

	/**
	 * This method is called when "system.conditions.maneuver" changes on the actor (via the update method)
	 * @param {string} maneuverText
	 */
	async replaceManeuver(maneuverText) {
		let tokens = this._findTokens()
		if (tokens) for (const t of tokens) await t.setManeuver(maneuverText)
	}

	async replacePosture(changeData) {
		let tokens = this._findTokens()
		if (tokens)
			for (const t of tokens) {
				let id = changeData === 'standing' ? this.data.data.conditions.posture : changeData
				await t.toggleEffect(GURPS.StatusEffect.lookup(id))
			}
	}

	/**
	 * @returns {GurpsToken[]}
	 */
	_findTokens() {
		if (this.isToken && this.token?.layer) {
			let token = /** @type {GurpsToken} */ (this.token.object)
			return [token]
		}
		return this.getActiveTokens().map(it => /** @type {GurpsToken} */(it))
	}

	/**
	 * @param {{ id: unknown; }} effect
	 */
	isEffectActive(effect) {
		for (const it of this.effects) {
			let statusId = it.getFlag('core', 'statusId')
			if (statusId === effect.id) return true
		}

		return false
	}

	get _additionalResources() {
		return this.data.data.additionalresources
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
		if (!this.data.data.conditions.damageAccumulators) this.data.data.conditions.damageAccumulators = []

		let accumulators = this.data.data.conditions.damageAccumulators

		// first, try to find an existing accumulator, and increment if found
		let existing = accumulators.findIndex(it => it.orig === action.orig)
		if (existing !== -1) return this.incrementDamageAccumulator(existing)

		// an existing accumulator is not found, create one
		action.count = 1
		delete action.accumulate
		accumulators.push(action)
		await this.update({ 'system.conditions.damageAccumulators': accumulators })
		GURPS.ModifierBucket.render()
		//console.log(accumulators)
	}

	get damageAccumulators() {
		return this.data.data.conditions.damageAccumulators
	}

	async incrementDamageAccumulator(index) {
		this.damageAccumulators[index].count++
		await this.update({ 'system.conditions.damageAccumulators': this.damageAccumulators })
		GURPS.ModifierBucket.render()
	}

	async decrementDamageAccumulator(index) {
		this.damageAccumulators[index].count--
		if (this.damageAccumulators[index].count < 1) this.damageAccumulators.splice(index, 1)
		await this.update({ 'system.conditions.damageAccumulators': this.damageAccumulators })
		GURPS.ModifierBucket.render()
	}

	async clearDamageAccumulator(index) {
		this.damageAccumulators.splice(index, 1)
		await this.update({ 'system.conditions.damageAccumulators': this.damageAccumulators })
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
		await this.update({ 'system.conditions.damageAccumulators': this.damageAccumulators })
		await GURPS.performAction(accumulator, GURPS.LastActor)
	}

	async importCharacter() {
		let p = this.data.data.additionalresources.importpath
		if (!!p) {
			let m = p.match(/.*[/\\]Data[/\\](.*)/)
			if (!!m) {
				let f = m[1].replace(/\\/g, '/')
				let xhr = new XMLHttpRequest()
				xhr.responseType = 'arraybuffer'
				xhr.open('GET', f)

				let promise = new Promise(resolve => {
					xhr.onload = () => {
						if (xhr.status === 200) {
							// @ts-ignore
							let s = arrayBuffertoBase64(xhr.response)
							// @ts-ignore
							this.importFromGCSv1(s, m[1], p)
						} else this._openImportDialog()
						resolve(this)
					}
				})
				xhr.send(null)
			} else this._openImportDialog()
		} else this._openImportDialog()
	}

	async _openImportDialog() {
		if (game.settings.get(settings.SYSTEM_NAME, settings.SETTING_USE_BROWSER_IMPORTER))
			this._openNonLocallyHostedImportDialog()
		else this._openLocallyHostedImportDialog()
	}

	async _openNonLocallyHostedImportDialog() {
		try {
			const file = await SmartImporter.getFileForActor(this)
			const res = await this.importFromGCSv1(await file.text(), file.name)
			if (res) SmartImporter.setFileForActor(this, file)
		} catch (e) {
			ui.notifications?.error(e)
			throw e
		}
	}

	async _openLocallyHostedImportDialog() {
		setTimeout(async () => {
			new Dialog(
				{
					title: `Import character data for: ${this.name}`,
					content: await renderTemplate('systems/gurps/templates/import-gcs-v1-data.html', {
						name: '"' + this.name + '"',
					}),
					buttons: {
						import: {
							icon: '<i class="fas fa-file-import"></i>',
							label: 'Import',
							callback: html => {
								const form = html.find('form')[0]
								let files = form.data.files
								let file = null
								if (!files.length) {
									return ui.notifications.error('You did not upload a data file!')
								} else {
									file = files[0]
									GURPS.readTextFromFile(file).then(text => this.importFromGCSv1(text, file.name, file.path))
								}
							},
						},
						no: {
							icon: '<i class="fas fa-times"></i>',
							label: 'Cancel',
						},
					},
					default: 'import',
				},
				{
					width: 400,
				}
			).render(true)
		}, 200)
	}

	/**
	 *
	 * @param {{ [key: string]: any}} json
	 */
	async importAttributesFromGCSv2(atts, eqp, calc) {
		if (!atts) return
		let data = this.data.data
		let att = data.attributes
		if (!att.QN) {
			// upgrade older actors to include Q
			att.QN = {}
			data.QP = {}
		}

		att.ST.import = atts.find(e => e.attr_id === 'st')?.calc?.value || 0
		att.ST.points = atts.find(e => e.attr_id === 'st')?.calc?.points || 0
		att.DX.import = atts.find(e => e.attr_id === 'dx')?.calc?.value || 0
		att.DX.points = atts.find(e => e.attr_id === 'dx')?.calc?.points || 0
		att.IQ.import = atts.find(e => e.attr_id === 'iq')?.calc?.value || 0
		att.IQ.points = atts.find(e => e.attr_id === 'iq')?.calc?.points || 0
		att.HT.import = atts.find(e => e.attr_id === 'ht')?.calc?.value || 0
		att.HT.points = atts.find(e => e.attr_id === 'ht')?.calc?.points || 0
		att.WILL.import = atts.find(e => e.attr_id === 'will')?.calc?.value || 0
		att.WILL.points = atts.find(e => e.attr_id === 'will')?.calc?.points || 0
		att.PER.import = atts.find(e => e.attr_id === 'per')?.calc?.value || 0
		att.PER.points = atts.find(e => e.attr_id === 'per')?.calc?.points || 0
		att.QN.import = atts.find(e => e.attr_id === 'qn')?.calc?.value || 0
		att.QN.points = atts.find(e => e.attr_id === 'qn')?.calc?.points || 0

		data.HP.max = atts.find(e => e.attr_id === 'hp')?.calc?.value || 0
		data.HP.points = atts.find(e => e.attr_id === 'hp')?.calc?.points || 0
		data.FP.max = atts.find(e => e.attr_id === 'fp')?.calc?.value || 0
		data.FP.points = atts.find(e => e.attr_id === 'fp')?.calc?.points || 0
		data.QP.max = atts.find(e => e.attr_id === 'qp')?.calc?.value || 0
		data.QP.points = atts.find(e => e.attr_id === 'qp')?.calc?.points || 0
		let hp = atts.find(e => e.attr_id === 'hp')?.calc?.current || 0
		let fp = atts.find(e => e.attr_id === 'fp')?.calc?.current || 0
		let qp = atts.find(e => e.attr_id === 'qp')?.calc?.current || 0

		let saveCurrent = false

		if (!!data.lastImport && (data.HP.value != hp || data.FP.value != fp)) {
			let option = game.settings.get(settings.SYSTEM_NAME, settings.SETTING_IMPORT_HP_FP)
			if (option == 0) {
				saveCurrent = true
			}
			if (option == 2) {
				saveCurrent = await new Promise((resolve, reject) => {
					let d = new Dialog({
						title: 'Current HP & FP',
						content: `Do you want to <br><br><b>Save</b> the current HP (${data.HP.value}) & FP (${data.FP.value}) values or <br><br><b>Overwrite</b> it with the import data, HP (${hp}) & FP (${fp})?<br><br>&nbsp;`,
						buttons: {
							save: {
								icon: '<i class="far fa-square"></i>',
								label: 'Save',
								callback: () => resolve(true),
							},
							overwrite: {
								icon: '<i class="fas fa-edit"></i>',
								label: 'Overwrite',
								callback: () => resolve(false),
							},
						},
						default: 'save',
						close: () => resolve(false), // just assume overwrite.   Error handling would be too much work right now.
					})
					d.render(true)
				})
			}
		}
		if (!saveCurrent) {
			data.HP.value = hp
			data.FP.value = fp
		}
		data.QP.value = qp

		let bl_value = parseFloat(calc?.basic_lift.match(/[\d\.]+/g))
		let bl_unit = calc?.basic_lift.replace(bl_value + ' ', '')

		let lm = {}
		lm.basiclift = (bl_value * 1).toString() + ' ' + bl_unit
		lm.carryonback = (bl_value * 15).toString() + ' ' + bl_unit
		lm.onehandedlift = (bl_value * 2).toString() + ' ' + bl_unit
		lm.runningshove = (bl_value * 24).toString() + ' ' + bl_unit
		lm.shiftslightly = (bl_value * 50).toString() + ' ' + bl_unit
		lm.shove = (bl_value * 12).toString() + ' ' + bl_unit
		lm.twohandedlift = (bl_value * 8).toString() + ' ' + bl_unit

		let bm = atts.find(e => e.attr_id === 'basic_move')?.calc?.value || 0
		data.basicmove.value = bm.toString()
		data.basicmove.points = atts.find(e => e.attr_id === 'basic_move')?.calc?.points || 0
		let bs = atts.find(e => e.attr_id === 'basic_speed')?.calc?.value || 0
		data.basicspeed.value = bs.toString()
		data.basicspeed.points = atts.find(e => e.attr_id === 'basic_speed')?.calc?.points || 0

		data.thrust = calc?.thrust
		data.swing = calc?.swing
		data.currentmove = data.basicmove.value
		data.frightcheck = atts.find(e => e.attr_id === 'fright_check')?.calc?.value || 0

		data.hearing = atts.find(e => e.attr_id === 'hearing')?.calc?.value || 0
		data.tastesmell = atts.find(e => e.attr_id === 'taste_smell')?.calc?.value || 0
		data.touch = atts.find(e => e.attr_id === 'touch')?.calc?.value || 0
		data.vision = atts.find(e => e.attr_id === 'vision')?.calc?.value || 0

		let cm = 0
		let cd = 0
		let es = {}
		let ew = [1, 2, 3, 6, 10]
		let index = 0
		let total_carried = this.calcTotalCarried(eqp)
		for (let i = 0; i <= 4; i++) {
			let e = new Encumbrance()
			e.level = i
			e.current = false
			e.key = 'enc' + i
			let weight_value = bl_value * ew[i]
			// e.current = total_carried <= weight_value && (i == 4 || total_carried < bl_value*ew[i+1]);
			e.current =
				(total_carried < weight_value || i == 4 || bl_value == 0) && (i == 0 || total_carried > bl_value * ew[i - 1])
			e.weight = weight_value.toString() + ' ' + bl_unit
			e.move = calc?.move[i].toString()
			e.dodge = calc?.dodge[i]
			if (e.current) {
				cm = e.move
				cd = e.dodge
			}
			GURPS.put(es, e, index++)
		}

		return {
			'system.attributes': att,
			'system.HP': data.HP,
			'system.FP': data.FP,
			'system.basiclift': data.basiclift,
			'system.basicmove': data.basicmove,
			'system.basicspeed': data.basicspeed,
			'system.thrust': data.thrust,
			'system.swing': data.swing,
			'system.currentmove': data.currentmove,
			'system.frightcheck': data.frightcheck,
			'system.hearing': data.hearing,
			'system.tastesmell': data.tastesmell,
			'system.touch': data.touch,
			'system.vision': data.vision,
			'system.liftingmoving': lm,
			'system.currentmove': cm,
			'system.currentdodge': cd,
			'system.-=encumbrance': null,
			'system.encumbrance': es,
			'system.QP': data.QP,
		}
	}

	calcTotalCarried(eqp) {
		let t = 0
		if (!eqp) return t
		for (let i of eqp) {
			let w = 0
			w += parseFloat(i.weight || '0') * (i.type == 'equipment_container' ? 1 : i.quantity || 0)
			if (i.children?.length) w += this.calcTotalCarried(i.children)
			t += w
		}
		return t
	}

	async importTraitsFromGCSv2(p, cd, md) {
		if (!p) return
		let ts = {}
		ts.race = ''
		ts.height = p.height || ''
		ts.weight = p.weight || ''
		ts.age = p.age || ''
		ts.title = p.title || ''
		ts.player = p.player_name || ''
		ts.createdon =
			new Date(cd).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }).replace(' at', ',') || ''
		ts.modifiedon =
			new Date(md).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }).replace(' at', ',') || ''
		ts.religion = p.religion || ''
		ts.birthday = p.birthday || ''
		ts.hand = p.handedness || ''
		ts.techlevel = p.tech_level || ''
		ts.gender = p.gender || ''
		ts.eyes = p.eyes || ''
		ts.hair = p.hair || ''
		ts.skin = p.skin || ''

		const r = {
			'system.-=traits': null,
			'system.traits': ts,
		}

		if (!!p.portrait && game.settings.get(settings.SYSTEM_NAME, settings.SETTING_OVERWRITE_PORTRAITS)) {
			const path = this.getPortraitPath()
			let currentDir = ''
			for (let i = 0; i < path.split('/').length; i++) {
				try {
					currentDir += path.split('/')[i] + '/'
					await FilePicker.createDirectory('data', currentDir)
				} catch (err) {
					continue
				}
			}
			const filename = `${this.removeAccents(p.name)}${this.id}_portrait.png`.replaceAll(' ', '_')
			const url = `data:image/png;base64,${p.portrait}`
			await fetch(url)
				.then(res => res.blob())
				.then(blob => {
					const file = new File([blob], filename)
					FilePicker.upload('data', path, file, {}, { notify: false })
				})
			r.img = (path + '/' + filename).replaceAll(' ', '_').replaceAll('//', '/')
		}
		return r
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

	signedNum(x) {
		if (x >= 0) return `+${x}`
		else return x.toString()
	}

	importSizeFromGCSv1(commit, profile, ads, skills, equipment) {
		let ts = commit['system.traits']
		let final = profile.SM || 0
		let temp = [].concat(ads, skills, equipment)
		let all = []
		for (let i of temp) {
			all = all.concat(this.recursiveGet(i))
		}
		for (let i of all) {
			if (i.features?.length)
				for (let f of i.features) {
					if (f.type == 'attribute_bonus' && f.attribute == 'sm')
						final += f.amount * (!!i.levels ? parseFloat(i.levels) : 1)
				}
		}
		ts.sizemod = this.signedNum(final)
		return {
			'system.-=traits': null,
			'system.traits': ts,
		}
	}

	importAdsFromGCSv3(ads) {
		let temp = []
		if (!!ads)
			for (let i of ads) {
				temp = temp.concat(this.importAd(i, ''))
			}
		return {
			'system.-=ads': null,
			'system.ads': this.foldList(temp),
		}
	}

	importAd(i, p) {
		let a = new Advantage()
		a.name = i.name + (i.levels ? ' ' + i.levels.toString() : '') || 'Advantage'
		a.points = i.calc?.points
		a.note = i.notes
		a.userdesc = i.userdesc
		a.notes = ''

		if (i.cr != null) {
			a.notes = '[' + game.i18n.localize('GURPS.CR' + i.cr.toString()) + ': ' + a.name + ']'
		}
		if (i.modifiers?.length) {
			for (let j of i.modifiers)
				if (!j.disabled) a.notes += `${!!a.notes ? '; ' : ''}${j.name}${!!j.notes ? ' (' + j.notes + ')' : ''}`
		}
		if (!!a.note) a.notes += (!!a.notes ? '\n' : '') + a.note
		if (!!a.userdesc) a.notes += (!!a.notes ? '\n' : '') + a.userdesc
		a.pageRef(i.reference)
		a.uuid = i.id
		a.parentuuid = p

		let old = this._findElementIn('ads', a.uuid)
		this._migrateOtfsAndNotes(old, a, i.vtt_notes)

		let ch = []
		if (i.children?.length) {
			for (let j of i.children) ch = ch.concat(this.importAd(j, i.id))
		}
		return [a].concat(ch)
	}

	importSkillsFromGCSv2(sks) {
		if (!sks) return
		let temp = []
		for (let i of sks) {
			temp = temp.concat(this.importSk(i, ''))
		}
		return {
			'system.-=skills': null,
			'system.skills': this.foldList(temp),
		}
	}

	importSk(i, p) {
		let name =
			i.name + (!!i.tech_level ? `/TL${i.tech_level}` : '') + (!!i.specialization ? ` (${i.specialization})` : '') ||
			'Skill'
		if (i.type == 'technique' && !!i.default) {
			let addition = ''
			addition = ' (' + i.default.name
			if (!!i.default.specialization) {
				addition += ' (' + i.default.specialization + ')'
			}
			name += addition + ')'
		}
		let s = new Skill(name, '')
		s.pageRef(i.reference || '')
		s.uuid = i.id
		s.parentuuid = p
		if (['skill', 'technique'].includes(i.type)) {
			s.type = i.type.toUpperCase()
			s.import = !!i.calc ? i.calc.level : ''
			if (s.level == 0) s.level = ''
			s.points = i.points
			s.relativelevel = i.calc?.rsl
			s.notes = i.notes || ''
		} else {
			// Usually containers
			s.level = ''
		}
		let old = this._findElementIn('skills', s.uuid)
		this._migrateOtfsAndNotes(old, s, i.vtt_notes)

		let ch = []
		if (i.children?.length) {
			for (let j of i.children) ch = ch.concat(this.importSk(j, i.id))
		}
		return [s].concat(ch)
	}

	importSpellsFromGCSv2(sps) {
		if (!sps) return
		let temp = []
		for (let i of sps) {
			temp = temp.concat(this.importSp(i, ''))
		}
		return {
			'system.-=spells': null,
			'system.spells': this.foldList(temp),
		}
	}

	importSp(i, p) {
		let s = new Spell()
		s.name = i.name || 'Spell'
		s.uuid = i.id
		s.parentuuid = p
		s.pageRef(i.reference || '')
		if (['spell', 'ritual_magic_spell'].includes(i.type)) {
			s.class = i.spell_class || ''
			s.college = i.college || ''
			s.cost = i.casting_cost || ''
			s.maintain = i.maintenance_cost || ''
			s.difficulty = i.difficulty.toUpperCase()
			s.relativelevel = i.calc?.rsl
			s.notes = i.notes || ''
			s.duration = i.duration || ''
			s.points = i.points || ''
			s.casttime = i.casting_time || ''
			s.import = i.calc?.level || 0
		}

		let old = this._findElementIn('spells', s.uuid)
		this._migrateOtfsAndNotes(old, s, i.vtt_notes)

		let ch = []
		if (i.children?.length) {
			for (let j of i.children) ch = ch.concat(this.importSp(j, i.id))
		}
		return [s].concat(ch)
	}

	importEquipmentFromGCSv2(eq, oeq) {
		if (!eq && !oeq) return
		let temp = []
		if (!!eq)
			for (let i of eq) {
				temp = temp.concat(this.importEq(i, '', true))
			}
		if (!!oeq)
			for (let i of oeq) {
				temp = temp.concat(this.importEq(i, '', false))
			}

		recurselist(this.data.data.equipment?.carried, t => {
			t.carried = true
			if (!!t.save) temp.push(t)
		})
		recurselist(this.data.data.equipment?.other, t => {
			t.carried = false
			if (!!t.save) temp.push(t)
		})

		temp.forEach(e => {
			e.contains = {}
			e.collapsed = {}
		})

		temp.forEach(e => {
			if (!!e.parentuuid) {
				let parent = null
				parent = temp.find(f => f.uuid === e.parentuuid)
				if (!!parent) GURPS.put(parent.contains, e)
				else e.parentuuid = ''
			}
		})

		let equipment = {
			carried: {},
			other: {},
		}
		let cindex = 0
		let oindex = 0

		temp.forEach(eqt => {
			Equipment.calc(eqt)
			if (!eqt.parentuuid) {
				if (eqt.carried) GURPS.put(equipment.carried, eqt, cindex++)
				else GURPS.put(equipment.other, eqt, oindex++)
			}
		})
		return {
			'system.-=equipment': null,
			'system.equipment': equipment,
		}
	}

	importEq(i, p, carried) {
		let e = new Equipment()
		e.name = i.description || 'Equipment'
		e.count = i.type == 'equipment_container' ? '1' : i.quantity || '0'
		e.cost =
			(parseFloat(i.calc?.extended_value) / (i.type == 'equipment_container' ? 1 : i.quantity || 1)).toString() || ''
		e.carried = carried
		e.equipped = i.equipped
		e.techlevel = i.tech_level || ''
		e.legalityclass = i.legality_class || '4'
		e.categories = i.categories?.join(', ') || ''
		e.uses = i.uses || 0
		e.maxuses = i.max_uses || 0
		e.uuid = i.id
		e.parentuuid = p
		e.notes = ''
		e.note = i.notes || ''
		if (i.modifiers?.length) {
			for (let j of i.modifiers)
				if (!j.disabled) e.notes += `${!!e.notes ? '; ' : ''}${j.name}${!!j.notes ? ' (' + j.notes + ')' : ''}`
		}
		if (!!e.note) e.notes += (!!e.notes ? '\n' : '') + e.note
		e.weight =
			(parseFloat(i.calc?.extended_weight) / (i.type == 'equipment_container' ? 1 : i.quantity || 1)).toString() || '0'
		e.pageRef(i.reference || '')
		let old = this._findElementIn('equipment.carried', e.uuid)
		if (!old) old = this._findElementIn('equipment.other', e.uuid)
		this._migrateOtfsAndNotes(old, e, i.vtt_notes)
		if (!!old) {
			e.carried = old.carried
			e.equipped = old.equipped
			e.parentuuid = old.parentuuid
			if (old.ignoreImportQty) {
				e.count = old.count
				e.uses = old.uses
				e.maxuses = old.maxuses
				e.ignoreImportQty = true
			}
		}
		let ch = []
		if (i.children?.length) {
			for (let j of i.children) ch = ch.concat(this.importEq(j, i.id, carried))
			for (let j of ch) {
				e.cost -= j.cost * j.count
				e.weight -= j.weight * j.count
			}
			// let weight_reduction = 0;
			// if (!!i.modifiers?.length) for (let m of i.modifiers) if (!m.disabled && !!m.features?.length) for (let mf of m.features) if (mf.type == "contained_weight_reduction") weight_reduction += parseFloat(mf.reduction);
			// if (!!i.features?.length) for (let f of i.features) if (f.type == "contained_weight_reduction") weight_reduction += parseFloat(f.reduction);
			// for (let j of ch) {
			//   e.cost -= j.cost*j.count;
			//   if (weight_reduction == 0) e.weight -= j.weight*j.count;
			//   else {
			//     weight_reduction -= j.weight*j.count;
			//     if (weight_reduction < 0) {
			//       e.weight += weight_reduction;
			//       weight_reduction = 0;
			//     }
			//   }
			// }
		}
		return [e].concat(ch)
	}

	importNotesFromGCSv2(notes) {
		if (!notes) return
		let temp = []
		for (let i of notes) {
			temp = temp.concat(this.importNote(i, ''))
		}
		recurselist(this.data.data.notes, t => {
			if (!!t.save) temp.push(t)
		})
		return {
			'system.-=notes': null,
			'system.notes': this.foldList(temp),
		}
	}

	importNote(i, p) {
		let n = new Note()
		n.notes = i.text || ''
		n.uuid = i.id
		n.parentuuid = p
		n.pageRef(i.reference || '')
		let old = this._findElementIn('notes', n.uuid)
		this._migrateOtfsAndNotes(old, n)
		let ch = []
		if (i.children?.length) {
			for (let j of i.children) ch = ch.concat(this.importNote(j, i.id))
		}
		return [n].concat(ch)
	}

	async importProtectionFromGCSv2(hls) {
		if (!hls) return
		let data = this.data.data
		if (!!data.additionalresources.ignoreinputbodyplan) return

		/** @type {HitLocations.HitLocation[]} */
		let locations = []
		for (let i of hls.locations) {
			let l = new HitLocations.HitLocation(i.table_name)
			l.import = i.calc?.dr.all?.toString() || '0'
			for (let [key, value] of Object.entries(i.calc?.dr))
				if (key != 'all') {
					let damtype = GURPS.DamageTables.damageTypeMap[key]
					if (!l.split) l.split = {}
					l.split[damtype] = +l.import + value
				}
			l.penalty = i.hit_penalty.toString()
			while (locations.filter(it => it.where == l.where).length > 0) {
				l.where = l.where + '*'
			}
			locations.push(l)
		}
		let vitals = locations.filter(value => value.where === HitLocations.HitLocation.VITALS)
		if (vitals.length === 0) {
			let hl = new HitLocations.HitLocation(HitLocations.HitLocation.VITALS)
			hl.penalty = HitLocations.hitlocationRolls[HitLocations.HitLocation.VITALS].penalty
			hl.roll = HitLocations.hitlocationRolls[HitLocations.HitLocation.VITALS].roll
			hl.import = '0'
			locations.push(hl)
		}
		// Hit Locations MUST come from an existing bodyplan hit location table, or else ADD (and
		// potentially other features) will not work. Sometime in the future, we will look at
		// user-entered hit locations.
		let bodyplan = hls.id // Was a body plan actually in the import?
		if (bodyplan === 'snakemen') bodyplan = 'snakeman'
		let table = HitLocations.hitlocationDictionary[bodyplan] // If so, try to use it.

		/** @type {HitLocations.HitLocation[]}  */
		let locs = []
		locations.forEach(e => {
			if (!!table && !!table[e.where]) {
				// if e.where already exists in table, don't map
				locs.push(e)
			} else {
				// map to new name(s) ... sometimes we map 'Legs' to ['Right Leg', 'Left Leg'], for example.
				e.locations(false).forEach(l => locs.push(l)) // Map to new names
			}
		})
		locations = locs

		if (!table) {
			locs = []
			locations.forEach(e => {
				e.locations(true).forEach(l => locs.push(l)) // Map to new names, but include original to help match against tables
			})
			bodyplan = this._getBodyPlan(locs)
			table = HitLocations.hitlocationDictionary[bodyplan]
		}
		// update location's roll and penalty based on the bodyplan

		if (!!table) {
			Object.values(locations).forEach(it => {
				let [lbl, entry] = HitLocations.HitLocation.findTableEntry(table, it.where)
				if (!!entry) {
					it.where = lbl // It might be renamed (ex: Skull -> Brain)
					if (!it.penalty) it.penalty = entry.penalty
					if (!it.roll || it.roll.length === 0 || it.roll === HitLocations.HitLocation.DEFAULT) it.roll = entry.roll
				}
			})
		}

		// write the hit locations out in bodyplan hit location table order. If there are
		// other entries, append them at the end.
		/** @type {HitLocations.HitLocation[]}  */
		let temp = []
		Object.keys(table).forEach(key => {
			let results = Object.values(locations).filter(loc => loc.where === key)
			if (results.length > 0) {
				if (results.length > 1) {
					// If multiple locs have same where, concat the DRs.   Leg 7 & Leg 8 both map to "Leg 7-8"
					let d = ''

					/** @type {string | null} */
					let last = null
					results.forEach(r => {
						if (r.import != last) {
							d += '|' + r.import
							last = r.import
						}
					})

					if (!!d) d = d.substr(1)
					results[0].import = d
				}
				temp.push(results[0])
				locations = locations.filter(it => it.where !== key)
			} else {
				// Didn't find loc that should be in the table. Make a default entry
				temp.push(new HitLocations.HitLocation(key, '0', table[key].penalty, table[key].roll))
			}
		})
		locations.forEach(it => temp.push(it))

		let prot = {}
		let index = 0
		temp.forEach(it => GURPS.put(prot, it, index++))

		let saveprot = true
		if (!!data.lastImport && !!data.additionalresources.bodyplan && bodyplan != data.additionalresources.bodyplan) {
			let option = game.settings.get(settings.SYSTEM_NAME, settings.SETTING_IMPORT_BODYPLAN)
			if (option == 1) {
				saveprot = false
			}
			if (option == 2) {
				saveprot = await new Promise((resolve, reject) => {
					let d = new Dialog({
						title: 'Hit Location Body Plan',
						content:
							`Do you want to <br><br><b>Save</b> the current Body Plan (${game.i18n.localize(
								'GURPS.BODYPLAN' + data.additionalresources.bodyplan
							)}) or ` +
							`<br><br><b>Overwrite</b> it with the Body Plan from the import: (${game.i18n.localize(
								'GURPS.BODYPLAN' + bodyplan
							)})?<br><br>&nbsp;`,
						buttons: {
							save: {
								icon: '<i class="far fa-square"></i>',
								label: 'Save',
								callback: () => resolve(false),
							},
							overwrite: {
								icon: '<i class="fas fa-edit"></i>',
								label: 'Overwrite',
								callback: () => resolve(true),
							},
						},
						default: 'save',
						close: () => resolve(false), // just assume overwrite.   Error handling would be too much work right now.
					})
					d.render(true)
				})
			}
		}
		if (saveprot) {
			return {
				'system.-=hitlocations': null,
				'system.hitlocations': prot,
				'system.additionalresources.bodyplan': bodyplan,
			}
		} else return {}
	}

	importPointTotalsFromGCSv2(total, atts, ads, skills, spells) {
		if (!ads) ads = []
		if (!skills) skills = []
		if (!spells) spells = []
		let p_atts = 0
		let p_ads = 0
		let p_disads = 0
		let p_quirks = 0
		let p_skills = 0
		let p_spells = 0
		let p_unspent = total
		let p_total = total
		let p_race = 0
		for (let i of atts) p_atts += i.calc?.points
		for (let i of ads)
			[p_ads, p_disads, p_quirks, p_race] = this.adPointCount(i, p_ads, p_disads, p_quirks, p_race, true)
		for (let i of skills) p_skills = this.skPointCount(i, p_skills)
		for (let i of spells) p_spells = this.skPointCount(i, p_spells)
		p_unspent -= p_atts + p_ads + p_disads + p_quirks + p_skills + p_spells + p_race
		return {
			'system.totalpoints.attributes': p_atts,
			'system.totalpoints.ads': p_ads,
			'system.totalpoints.disads': p_disads,
			'system.totalpoints.quirks': p_quirks,
			'system.totalpoints.skills': p_skills,
			'system.totalpoints.spells': p_spells,
			'system.totalpoints.unspent': p_unspent,
			'system.totalpoints.total': p_total,
			'system.totalpoints.race': p_race,
		}
	}

	importReactionsFromGCSv3(ads, skills, equipment) {
		let rs = {}
		let cs = {}
		let index_r = 0
		let index_c = 0
		let temp = [].concat(ads, skills, equipment)
		let all = []
		for (let i of temp) {
			all = all.concat(this.recursiveGet(i))
		}
		let temp_r = []
		let temp_c = []
		for (let i of all) {
			if (i.features?.length)
				for (let f of i.features) {
					if (f.type == 'reaction_bonus') {
						temp_r.push({
							modifier: f.amount * (f.per_level && !!i.levels ? parseInt(i.levels) : 1),
							situation: f.situation,
						})
					} else if (f.type == 'conditional_modifier') {
						temp_c.push({
							modifier: f.amount * (f.per_level && !!i.levels ? parseInt(i.levels) : 1),
							situation: f.situation,
						})
					}
				}
		}
		let temp_r2 = []
		let temp_c2 = []
		for (let i of temp_r) {
			let existing_condition = temp_r2.find(e => e.situation == i.situation)
			if (!!existing_condition) existing_condition.modifier += i.modifier
			else temp_r2.push(i)
		}
		for (let i of temp_c) {
			let existing_condition = temp_c2.find(e => e.situation == i.situation)
			if (!!existing_condition) existing_condition.modifier += i.modifier
			else temp_c2.push(i)
		}
		for (let i of temp_r2) {
			let r = new Reaction()
			r.modifier = i.modifier.toString()
			r.situation = i.situation
			GURPS.put(rs, r, index_r++)
		}
		for (let i of temp_c2) {
			let c = new Modifier()
			c.modifier = i.modifier.toString()
			c.situation = i.situation
			GURPS.put(cs, c, index_c++)
		}
		return {
			'system.-=reactions': null,
			'system.reactions': rs,
			'system.-=conditionalmods': null,
			'system.conditionalmods': cs,
		}
	}

	importCombatFromGCSv2(ads, skills, spells, equipment) {
		let melee = {}
		let ranged = {}
		let m_index = 0
		let r_index = 0
		let temp = [].concat(ads, skills, spells, equipment)
		let all = []
		for (let i of temp) {
			all = all.concat(this.recursiveGet(i))
		}
		for (let i of all) {
			if (i.weapons?.length)
				for (let w of i.weapons) {
					if (w.type == 'melee_weapon') {
						let m = new Melee()
						m.name = i.name || i.description || ''
						m.st = w.strength || ''
						m.weight = i.weight || ''
						m.techlevel = i.tech_level || ''
						m.cost = i.value || ''
						m.notes = i.notes || ''
						if (!!m.notes && w.usage_notes) m.notes += '\n' + w.usage_notes
						m.pageRef(i.reference || '')
						m.mode = w.usage || ''
						m.import = w.calc?.level.toString() || '0'
						m.damage = w.calc?.damage || ''
						m.reach = w.reach || ''
						m.parry = w.calc?.parry || ''
						m.block = w.calc?.block || ''
						let old = this._findElementIn('melee', false, m.name, m.mode)
						this._migrateOtfsAndNotes(old, m, i.vtt_notes)

						GURPS.put(melee, m, m_index++)
					} else if (w.type == 'ranged_weapon') {
						let r = new Ranged()
						r.name = i.name || i.description || ''
						r.st = w.strength || ''
						r.bulk = w.bulk || ''
						r.legalityclass = i.legality_class || '4'
						r.ammo = 0
						r.notes = i.notes || ''
						if (!!r.notes && w.usage_notes) r.notes += '\n' + w.usage_notes
						r.pageRef(i.reference || '')
						r.mode = w.usage || ''
						r.import = w.calc?.level || '0'
						r.damage = w.calc?.damage || ''
						r.acc = w.accuracy || ''
						r.rof = w.rate_of_fire || ''
						r.shots = w.shots || ''
						r.rcl = w.recoil || ''
						r.range = w.calc?.range || ''
						let old = this._findElementIn('ranged', false, r.name, r.mode)
						this._migrateOtfsAndNotes(old, r, i.vtt_notes)

						GURPS.put(ranged, r, r_index++)
					}
				}
		}
		return {
			'system.-=melee': null,
			'system.melee': melee,
			'system.-=ranged': null,
			'system.ranged': ranged,
		}
	}

	recursiveGet(i) {
		if (!i) return []
		let ch = []
		if (i.children?.length) for (let j of i.children) ch = ch.concat(this.recursiveGet(j))
		if (i.modifiers?.length) for (let j of i.modifiers) ch = ch.concat(this.recursiveGet(j))
		if (!!i.disabled || (i.equipped != null && i.equipped == false)) return []
		return [i].concat(ch)
	}

	adPointCount(i, ads, disads, quirks, race, toplevel = false) {
		if (i.type == 'advantage_container' && i.container_type == 'race') race += i.calc?.points
		else if (i.type == 'advantage_container' && i.container_type == 'alternative_abilities') ads += i.calc?.points
		else if (i.type == 'advantage_container' && !!i.children?.length) {
			var [a, d] = [0, 0]
			for (let j of i.children) [a, d, quirks, race] = this.adPointCount(j, a, d, quirks, race)
			if (toplevel) {
				if (a > 0) ads += a
				else disads += a
			} else ads += a + d
		} else if (i.calc?.points == -1) quirks += i.calc?.points
		else if (i.calc?.points > 0) ads += i.calc?.points
		else disads += i.calc?.points
		return [ads, disads, quirks, race]
	}

	skPointCount(i, skills) {
		if (i.type == ('skill_container' || 'spell_container') && i.children?.length)
			for (let j of i.children) skills = this.skPointCount(j, skills)
		else skills += i.points
		return skills
	}

	/**
	 * @param {string} json
	 * @param {string} importname
	 * @param {string | undefined} [importpath]
	 */
	async importFromGCSv2(json, importname, importpath, suppressMessage = false, GCAVersion, GCSVersion) {
		let r
		let msg = []
		let version = 'Direct GCS Import'
		let exit = false
		try {
			r = JSON.parse(json)
		} catch (err) {
			msg.push(i18n('GURPS.importNoJSONDetected'))
			exit = true
		}
		if (!!r) {
			if (!r.calc) {
				msg.push(i18n('GURPS.importOldGCSFile'))
				exit = true
			}
		}

		if (msg.length > 0) {
			ui.notifications?.error(msg.join('<br>'))
			let content = await renderTemplate('systems/gurps/templates/chat-import-actor-errors.html', {
				lines: msg,
				version: version,
				GCAVersion: GCAVersion,
				GCSVersion: GCSVersion,
				url: GURPS.USER_GUIDE_URL,
			})
			ChatMessage.create({
				content: content,
				user: game.user.id,
				type: CONST.CHAT_MESSAGE_TYPES.WHISPER,
				whisper: [game.user.id],
			})
			if (exit) return false
		}

		let nm = r['profile']['name']
		console.log("Importing '" + nm + "'")
		let starttime = performance.now()
		let commit = {}

		commit = { ...commit, ...{ 'system.lastImport': new Date().toString().split(' ').splice(1, 4).join(' ') } }
		let ar = this.data.data.additionalresources || {}
		ar.importname = importname || ar.importname
		ar.importpath = importpath || ar.importpath
		try {
			commit = { ...commit, ...{ 'system.additionalresources': ar } }
			commit = { ...commit, ...(await this.importAttributesFromGCSv2(r.attributes, r.equipment, r.calc)) }
			commit = { ...commit, ...(await this.importTraitsFromGCSv2(r.profile, r.created_date, r.modified_date)) }
			commit = {
				...commit,
				...this.importSizeFromGCSv1(commit, r.profile, r.traits || t.advantages, r.skills, r.equipment),
			}
			commit = { ...commit, ...this.importAdsFromGCSv3(r.traits || t.advantages) }
			commit = { ...commit, ...this.importSkillsFromGCSv2(r.skills) }
			commit = { ...commit, ...this.importSpellsFromGCSv2(r.spells) }
			commit = { ...commit, ...this.importEquipmentFromGCSv2(r.equipment, r.other_equipment) }
			commit = { ...commit, ...this.importNotesFromGCSv2(r.notes) }

			commit = {
				...commit,
				...(await this.importProtectionFromGCSv2(r.settings.body_type || r.settings.hit_locations)),
			}
			commit = {
				...commit,
				...this.importPointTotalsFromGCSv2(r.total_points, r.attributes, r.traits || t.advantages, r.skills, r.spells),
			}
			commit = { ...commit, ...this.importReactionsFromGCSv3(r.traits || t.advantages, r.skills, r.equipment) }
			commit = { ...commit, ...this.importCombatFromGCSv2(r.traits || t.advantages, r.skills, r.spells, r.equipment) }
		} catch (err) {
			console.log(err.stack)
			msg.push(
				i18n_f('GURPS.importGenericError', {
					name: nm,
					error: err.name,
					message: err.message,
				})
			)
			let content = await renderTemplate('systems/gurps/templates/chat-import-actor-errors.html', {
				lines: [msg],
				version: version,
				GCAVersion: GCAVersion,
				GCSVersion: GCSVersion,
				url: GURPS.USER_GUIDE_URL,
			})
			ui.notifications?.warn(msg)
			let chatData = {
				user: game.user.id,
				type: CONST.CHAT_MESSAGE_TYPES.WHISPER,
				content: content,
				whisper: [game.user.id],
			}
			ChatMessage.create(chatData, {})
			// Don't return
		}

		console.log('Starting commit')
		let deletes = Object.fromEntries(Object.entries(commit).filter(([key, value]) => key.includes('.-=')))
		let adds = Object.fromEntries(Object.entries(commit).filter(([key, value]) => !key.includes('.-=')))

		try {
			this.ignoreRender = true
			await this.internalUpdate(deletes, { diff: false })
			await this.internalUpdate(adds, { diff: false })
			// This has to be done after everything is loaded
			await this.postImport()
			this._forceRender()

			// Must update name outside of protection so that Actors list (and other external views) update correctly
			if (!game.settings.get(settings.SYSTEM_NAME, settings.SETTING_IGNORE_IMPORT_NAME)) {
				await this.update({ name: nm, 'token.name': nm })
			}

			if (!suppressMessage) ui.notifications?.info(i18n_f('GURPS.importSuccessful', { name: nm }))
			console.log(
				'Done importing (' +
				Math.round(performance.now() - starttime) +
				'ms.)  You can inspect the character data below:'
			)
			console.log(this)
			return true
		} catch (err) {
			console.log(err.stack)
			let msg = [i18n_f('GURPS.importGenericError', { name: nm, error: err.name, message: err.message })]
			if (err.message == 'Maximum depth exceeded') msg.push(i18n('GURPS.importTooManyContainers'))
			ui.notifications?.warn(msg.join('<br>'))
			let content = await renderTemplate('systems/gurps/templates/chat-import-actor-errors.html', {
				lines: msg,
				version: 'GCS Direct',
				GCAVersion: GCAVersion,
				GCSVersion: GCSVersion,
				url: GURPS.USER_GUIDE_URL,
			})

			let user = game.user
			let chatData = {
				user: game.user.id,
				type: CONST.CHAT_MESSAGE_TYPES.WHISPER,
				content: content,
				whisper: [game.user.id],
			}
			ChatMessage.create(chatData, {})
			return false
		}
	}

	// First attempt at import GCS FG XML export data.
	/**
	 * @param {string} xml
	 * @param {string} importname
	 * @param {string | undefined} [importpath]
	 */
	async importFromGCSv1(xml, importname, importpath, suppressMessage = false) {
		const GCA5Version = 'GCA5-14'
		const GCAVersion = 'GCA-11'
		const GCSVersion = 'GCS-5'
		if (importname.endsWith('.gcs'))
			return this.importFromGCSv2(xml, importname, importpath, suppressMessage, GCAVersion, GCSVersion)
		var c, ra // The character json, release attributes
		let isFoundryGCS = false
		let isFoundryGCA = false
		let isFoundryGCA5 = false
		// need to remove <p> and replace </p> with newlines from "formatted text"
		let origx = GURPS.cleanUpP(xml)
		let x = xmlTextToJson(origx)
		// @ts-ignore
		let r = x.root
		let msg = []
		let version = 'unknown'
		let vernum = 1
		let exit = false
		if (!r) {
			if (importname.endsWith('.gca5')) msg.push(i18n('GURPS.importCannotImportGCADirectly'))
			if (importname.endsWith('.gca4')) msg.push(i18n('GURPS.importCannotImportGCADirectly'))
			else if (!xml.startsWith('<?xml')) msg.push(i18n('GURPS.importNoXMLDetected'))
			exit = true
		} else {
			// The character object starts here
			c = r.character
			if (!c) {
				msg.push(i18n('GURPS.importNoCharacterFormat'))
				exit = true
			}

			let parsererror = r.parsererror
			if (!!parsererror) {
				msg.push(i18n_f('GURPS.importErrorParsingXML', { text: this.textFrom(parsererror.div) }))
				exit = true
			}

			ra = r['@attributes']
			// Sorry for the horrible version checking... it sort of evolved organically
			isFoundryGCS = !!ra && ra.release == 'Foundry' && (ra.version == '1' || ra.version.startsWith('GCS'))
			isFoundryGCA = !!ra && ra.release == 'Foundry' && ra.version.startsWith('GCA')
			isFoundryGCA5 = !!ra && ra.release == 'Foundry' && ra.version.startsWith('GCA5')
			if (!(isFoundryGCS || isFoundryGCA || isFoundryGCA5)) {
				msg.push(i18n('GURPS.importFantasyGroundUnsupported'))
				exit = true
			}
			version = ra?.version || ''
			const v = !!ra?.version ? ra.version.split('-') : []
			if (isFoundryGCA) {
				if (isFoundryGCA5) {
					if (!!v[1]) vernum = parseInt(v[1])
					if (vernum < 12) {
						msg.push(i18n('GURPS.importGCA5ImprovedInventoryHandling'))
					}
					if (vernum < 13) {
						msg.push(i18n('GURPS.importGCA5ImprovedBlock'))
					}
				} else {
					if (!v[1]) {
						msg.push(i18n('GURPS.importGCANoBodyPlan'))
					}
					if (!!v[1]) vernum = parseInt(v[1])
					if (vernum < 2) {
						msg.push(i18n('GURPS.importGCANoInnateRangedAndParent'))
					}
					if (vernum < 3) {
						msg.push(i18n('GURPS.importGCANoSanitizedEquipmentPageRefs')) // Equipment Page ref's sanitized
					}
					if (vernum < 4) {
						msg.push(i18n('GURPS.importGCANoParent'))
					}
					if (vernum < 5) {
						msg.push(i18n('GURPS.importGCANoSanitizeNotes'))
					}
					if (vernum < 6) {
						msg.push(i18n('GURPS.importGCANoMeleeIfAlsoRanged'))
					}
					if (vernum < 7) {
						msg.push(i18n('GURPS.importGCABadBlockForDB'))
					}
					if (vernum < 8) {
						msg.push(i18n('GURPS.importGCANoHideFlag'))
					}
					if (vernum < 9) {
						msg.push(i18n('GURPS.importGCAChildrenWeights'))
					}
					if (vernum < 10) {
						msg.push(i18n('GURPS.importGCAAdvMods'))
					}
					if (vernum < 11) {
						msg.push(i18n('GURPS.importGCAConditionalModifiers'))
					}
				}
			}
			if (isFoundryGCS) {
				if (!!v[1]) vernum = parseInt(v[1])
				if (vernum < 2) {
					msg.push(i18n('GURPS.importGCSNoParent'))
				}
				if (vernum < 3) {
					msg.push(i18n('GURPS.importGCSNoSelfControl'))
				}
				if (vernum < 4) {
					msg.push(i18n('GURPS.importGCSNoUses'))
				}
				if (vernum < 5) {
					msg.push(i18n('GURPS.importGCSNoMeleeRangedNotesForSameItem'))
				}
			}
		}
		if (msg.length > 0) {
			ui.notifications?.error(msg.join('<br>'))
			let content = await renderTemplate('systems/gurps/templates/chat-import-actor-errors.html', {
				lines: msg,
				version: version,
				GCAVersion: GCAVersion,
				GCSVersion: GCSVersion,
				url: GURPS.USER_GUIDE_URL,
			})

			let user = game.user
			ChatMessage.create({
				content: content,
				user: game.user.id,
				type: CONST.CHAT_MESSAGE_TYPES.WHISPER,
				whisper: [game.user.id],
			})
			if (exit) return false // Some errors cannot be forgiven ;-)
		}
		let nm = this.textFrom(c.name)
		console.log("Importing '" + nm + "'")
		let starttime = performance.now()
		let commit = {}

		commit = { ...commit, ...{ 'system.lastImport': new Date().toString().split(' ').splice(1, 4).join(' ') } }
		let ar = this.data.data.additionalresources || {}
		ar.importname = importname || ar.importname
		ar.importpath = importpath || ar.importpath
		ar.importversion = ra.version
		commit = { ...commit, ...{ 'system.additionalresources': ar } }

		try {
			// This is going to get ugly, so break out various data into different methods
			commit = { ...commit, ...(await this.importAttributesFromCGSv1(c.attributes)) }
			commit = { ...commit, ...this.importSkillsFromGCSv1(c.abilities?.skilllist, isFoundryGCS) }
			commit = { ...commit, ...this.importTraitsfromGCSv1(c.traits) }
			commit = { ...commit, ...this.importCombatMeleeFromGCSv1(c.combat?.meleecombatlist, isFoundryGCS) }
			commit = { ...commit, ...this.importCombatRangedFromGCSv1(c.combat?.rangedcombatlist, isFoundryGCS) }
			commit = { ...commit, ...this.importSpellsFromGCSv1(c.abilities?.spelllist, isFoundryGCS) }
			if (isFoundryGCS) {
				commit = { ...commit, ...this.importAdsFromGCSv2(c.traits?.adslist) }
				commit = { ...commit, ...this.importReactionsFromGCSv2(c.reactions) }
				commit = { ...commit, ...this.importConditionalModifiersFromGCSv2(c.conditionalmods) }
			}
			if (isFoundryGCA) {
				commit = { ...commit, ...this.importLangFromGCA(c.traits?.languagelist) }
				commit = { ...commit, ...this.importAdsFromGCA(c.traits?.adslist, c.traits?.disadslist) }
				commit = { ...commit, ...this.importReactionsFromGCA(c.traits?.reactionmodifiers, vernum) }
			}
			commit = { ...commit, ...this.importEncumbranceFromGCSv1(c.encumbrance) }
			commit = { ...commit, ...this.importPointTotalsFromGCSv1(c.pointtotals) }
			commit = { ...commit, ...this.importNotesFromGCSv1(c.description, c.notelist) }
			commit = { ...commit, ...this.importEquipmentFromGCSv1(c.inventorylist, isFoundryGCS) }
			commit = { ...commit, ...(await this.importProtectionFromGCSv1(c.combat?.protectionlist, isFoundryGCA)) }
		} catch (err) {
			console.log(err.stack)
			let msg = i18n_f('GURPS.importGenericError', { name: nm, error: err.name, message: err.message })
			let content = await renderTemplate('systems/gurps/templates/chat-import-actor-errors.html', {
				lines: [msg],
				version: version,
				GCAVersion: GCAVersion,
				GCSVersion: GCSVersion,
				url: GURPS.USER_GUIDE_URL,
			})

			ui.notifications?.warn(msg)
			let user = game.user
			let chatData = {
				user: game.user.id,
				type: CONST.CHAT_MESSAGE_TYPES.WHISPER,
				content: content,
				whisper: [game.user.id],
			}
			ChatMessage.create(chatData, {})
			// Don't return, because we want to see how much actually gets committed.
		}
		console.log('Starting commit')

		let deletes = Object.fromEntries(Object.entries(commit).filter(([key, value]) => key.includes('.-=')))
		let adds = Object.fromEntries(Object.entries(commit).filter(([key, value]) => !key.includes('.-=')))

		try {
			this.ignoreRender = true
			await this.internalUpdate(deletes, { diff: false })
			await this.internalUpdate(adds, { diff: false })
			// This has to be done after everything is loaded
			await this.postImport()
			this._forceRender()

			// Must update name outside of protection so that Actors list (and other external views) update correctly
			if (!game.settings.get(settings.SYSTEM_NAME, settings.SETTING_IGNORE_IMPORT_NAME)) {
				await this.update({ name: nm, 'token.name': nm })
			}

			if (!suppressMessage) ui.notifications?.info(i18n_f('GURPS.importSuccessful', { name: nm }))
			console.log(
				'Done importing (' +
				Math.round(performance.now() - starttime) +
				'ms.)  You can inspect the character data below:'
			)
			console.log(this)
			return true
		} catch (err) {
			console.log(err.stack)
			let msg = [i18n_f('GURPS.importGenericError', { name: nm, error: err.name, message: err.message })]
			if (err.message == 'Maximum depth exceeded') msg.push(i18n('GURPS.importTooManyContainers'))
			if (!supressMessage) ui.notifications?.warn(msg.join('<br>'))
			let content = await renderTemplate('systems/gurps/templates/chat-import-actor-errors.html', {
				lines: msg,
				version: version,
				GCAVersion: GCAVersion,
				GCSVersion: GCSVersion,
				url: GURPS.USER_GUIDE_URL,
			})

			let user = game.user
			let chatData = {
				user: game.user.id,
				type: CONST.CHAT_MESSAGE_TYPES.WHISPER,
				content: content,
				whisper: [game.user.id],
			}
			ChatMessage.create(chatData, {})
			return false
		}
	}

	// hack to get to private text element created by xml->json method.
	/**
	 * @param {{ [key: string]: any }} o
	 */
	textFrom(o) {
		if (!o) return ''
		let t = o['#text']
		if (!t) return ''
		return t.trim()
	}

	// similar hack to get text as integer.
	/**
	 * @param {{ [key: string]: any }} o
	 */
	intFrom(o) {
		if (!o) return 0
		let i = o['#text']
		if (!i) return 0
		return parseInt(i)
	}

	/**
	 * @param {{[key: string] : any}} o
	 */
	floatFrom(o) {
		if (!o) return 0
		let f = o['#text'].trim()
		if (!f) return 0
		return f.includes(',') ? parseDecimalNumber(f, { thousands: '.', decimal: ',' }) : parseDecimalNumber(f)
	}

	/**
	 * @param {string} list
	 * @param {string|boolean} uuid
	 */
	_findElementIn(list, uuid, name = '', mode = '') {
		var foundkey
		let l = getProperty(this, list)
		recurselist(l, (e, k, d) => {
			if ((uuid && e.uuid == uuid) || (!!e.name && e.name.startsWith(name) && e.mode == mode)) foundkey = k
		})
		return foundkey == null ? foundkey : getProperty(this, list + '.' + foundkey)
	}

	/**
	 * @param {{ [key: string]: any }} json
	 */
	importReactionsFromGCSv2(json) {
		if (!json) return
		let t = this.textFrom
		let rs = {}
		let index = 0
		for (let key in json) {
			if (key.startsWith('id-')) {
				// Allows us to skip over junk elements created by xml->json code, and only select the skills.
				let j = json[key]
				let r = new Reaction()
				r.modifier = t(j.modifier)
				r.situation = t(j.situation)
				GURPS.put(rs, r, index++)
			}
		}
		return {
			'system.-=reactions': null,
			'system.reactions': rs,
		}
	}

	importConditionalModifiersFromGCSv2(json) {
		if (!json) return
		let t = this.textFrom
		let rs = {}
		let index = 0
		for (let key in json) {
			if (key.startsWith('id-')) {
				let j = json[key]
				let r = new Reaction() // ConditionalModifiers are the same format
				r.modifier = t(j.modifier)
				r.situation = t(j.situation)
				GURPS.put(rs, r, index++)
			}
		}
		return {
			'system.-=conditionalmods': null,
			'system.conditionalmods': rs,
		}
	}

	/**
	 * @param {{ [key: string]: any }} json
	 */
	importReactionsFromGCA(json, vernum) {
		if (!json) return
		let text = this.textFrom(json)
		let a = vernum <= 9 ? text.split(',') : text.split('|')
		let rs = {}
		let index = 0
		a.forEach((/** @type {string} */ m) => {
			if (!!m) {
				let t = m.trim()
				let i = t.indexOf(' ')
				let mod = t.substring(0, i)
				let sit = t.substr(i + 1)
				let r = new Reaction(mod, sit)
				GURPS.put(rs, r, index++)
			}
		})
		return {
			'system.-=reactions': null,
			'system.reactions': rs,
		}
	}

	importLangFromGCA(json) {
		if (!json) return
		let langs = {}
		let index = 0
		let t = this.textFrom
		for (let key in json) {
			if (key.startsWith('id-')) {
				let j = json[key]
				let n = t(j.name)
				let s = t(j.spoken)
				let w = t(j.written)
				let p = t(j.points)
				let l = new Language(n, s, w, p)
				GURPS.put(langs, l, index++)
			}
		}
		return {
			'system.-=languages': null,
			'system.languages': langs,
		}
	}

	/**
	 * @param {{ attributes: Record<string, any>; ads: Record<string, any>; disads: Record<string, any>; quirks: Record<string, any>; skills: Record<string, any>; spells: Record<string, any>; unspentpoints: Record<string, any>; totalpoints: Record<string, any>; race: Record<string, any>; }} json
	 */
	importPointTotalsFromGCSv1(json) {
		if (!json) return

		let i = this.intFrom
		return {
			'system.totalpoints.attributes': i(json.attributes),
			'system.totalpoints.ads': i(json.ads),
			'system.totalpoints.disads': i(json.disads),
			'system.totalpoints.quirks': i(json.quirks),
			'system.totalpoints.skills': i(json.skills),
			'system.totalpoints.spells': i(json.spells),
			'system.totalpoints.unspent': i(json.unspentpoints),
			'system.totalpoints.total': i(json.totalpoints),
			'system.totalpoints.race': i(json.race),
		}
	}

	/**
	 * @param {{ [key: string]: any }} descjson
	 * @param {{ [key: string]: any }} json
	 */
	importNotesFromGCSv1(descjson, json) {
		if (!json) return
		let t = this.textFrom
		let temp = []
		if (!!descjson) {
			// support for GCA description

			let n = new Note()
			n.notes = t(descjson).replace(/\\r/g, '\n')
			n.imported = true
			temp.push(n)
		}
		for (let key in json) {
			if (key.startsWith('id-')) {
				// Allows us to skip over junk elements created by xml->json code, and only select the skills.
				let j = json[key]
				let n = /** @type {Note & { imported: boolean, uuid: string, parentuuid: string }} */ (new Note())
				//n.setNotes(t(j.text));
				n.notes = t(j.name)
				let txt = t(j.text)
				if (!!txt) n.notes = n.notes + '\n' + txt.replace(/\\r/g, '\n')
				n.uuid = t(j.uuid)
				n.parentuuid = t(j.parentuuid)
				n.pageref = t(j.pageref)
				let old = this._findElementIn('notes', n.uuid)
				this._migrateOtfsAndNotes(old, n)
				temp.push(n)
			}
		}
		// Save the old User Entered Notes.
		recurselist(this.data.data.notes, t => {
			if (!!t.save) temp.push(t)
		})
		return {
			'system.-=notes': null,
			'system.notes': this.foldList(temp),
		}
	}

	/**
	 * @param {{ [x: string]: any; bodyplan: Record<string, any>; }} json
	 * @param {boolean} isFoundryGCA
	 */
	async importProtectionFromGCSv1(json, isFoundryGCA) {
		if (!json) return
		let t = this.textFrom
		let data = this.data.data
		if (!!data.additionalresources.ignoreinputbodyplan) return

		/** @type {HitLocations.HitLocation[]}  */
		let locations = []
		for (let key in json) {
			if (key.startsWith('id-')) {
				// Allows us to skip over junk elements created by xml->json code, and only select the skills.
				let j = json[key]
				let hl = new HitLocations.HitLocation(t(j.location))
				let i = t(j.dr)
				if (i.match(/^\d+ *(\+ *\d+ *)?$/)) i = eval(t(j.dr)) // supports "0 + 8"
				hl.import = !i ? 0 : i
				hl.penalty = t(j.db)
				hl.setEquipment(t(j.text))

				// Some hit location tables have two entries for the same location. The code requires
				// each location to be unique. Append an asterisk to the location name in that case.   Hexapods and ichthyoid
				while (locations.filter(it => it.where == hl.where).length > 0) {
					hl.where = hl.where + '*'
				}
				locations.push(hl)
			}
		}

		// Do the results contain vitals? If not, add it.
		let vitals = locations.filter(value => value.where === HitLocations.HitLocation.VITALS)
		if (vitals.length === 0) {
			let hl = new HitLocations.HitLocation(HitLocations.HitLocation.VITALS)
			hl.penalty = HitLocations.hitlocationRolls[HitLocations.HitLocation.VITALS].penalty
			hl.roll = HitLocations.hitlocationRolls[HitLocations.HitLocation.VITALS].roll
			hl.import = '0'
			locations.push(hl)
		}

		// Hit Locations MUST come from an existing bodyplan hit location table, or else ADD (and
		// potentially other features) will not work. Sometime in the future, we will look at
		// user-entered hit locations.
		let bodyplan = t(json.bodyplan)?.toLowerCase() // Was a body plan actually in the import?
		if (bodyplan === 'snakemen') bodyplan = 'snakeman'
		let table = HitLocations.hitlocationDictionary[bodyplan] // If so, try to use it.

		/** @type {HitLocations.HitLocation[]}  */
		let locs = []
		locations.forEach(e => {
			if (!!table && !!table[e.where]) {
				// if e.where already exists in table, don't map
				locs.push(e)
			} else {
				// map to new name(s) ... sometimes we map 'Legs' to ['Right Leg', 'Left Leg'], for example.
				e.locations(false).forEach(l => locs.push(l)) // Map to new names
			}
		})
		locations = locs

		if (!table) {
			locs = []
			locations.forEach(e => {
				e.locations(true).forEach(l => locs.push(l)) // Map to new names, but include original to help match against tables
			})
			bodyplan = this._getBodyPlan(locs)
			table = HitLocations.hitlocationDictionary[bodyplan]
		}
		// update location's roll and penalty based on the bodyplan

		if (!!table) {
			Object.values(locations).forEach(it => {
				let [lbl, entry] = HitLocations.HitLocation.findTableEntry(table, it.where)
				if (!!entry) {
					it.where = lbl // It might be renamed (ex: Skull -> Brain)
					if (!it.penalty) it.penalty = entry.penalty
					if (!it.roll || it.roll.length === 0 || it.roll === HitLocations.HitLocation.DEFAULT) it.roll = entry.roll
				}
			})
		}

		// write the hit locations out in bodyplan hit location table order. If there are
		// other entries, append them at the end.
		/** @type {HitLocations.HitLocation[]}  */
		let temp = []
		Object.keys(table).forEach(key => {
			let results = Object.values(locations).filter(loc => loc.where === key)
			if (results.length > 0) {
				if (results.length > 1) {
					// If multiple locs have same where, concat the DRs.   Leg 7 & Leg 8 both map to "Leg 7-8"
					let d = ''

					/** @type {string | null} */
					let last = null
					results.forEach(r => {
						if (r.import != last) {
							d += '|' + r.import
							last = r.import
						}
					})

					if (!!d) d = d.substr(1)
					results[0].import = d
				}
				temp.push(results[0])
				locations = locations.filter(it => it.where !== key)
			} else {
				// Didn't find loc that should be in the table. Make a default entry
				temp.push(new HitLocations.HitLocation(key, '0', table[key].penalty, table[key].roll))
			}
		})
		locations.forEach(it => temp.push(it))

		let prot = {}
		let index = 0
		temp.forEach(it => GURPS.put(prot, it, index++))

		let saveprot = true
		if (!!data.lastImport && !!data.additionalresources.bodyplan && bodyplan != data.additionalresources.bodyplan) {
			let option = game.settings.get(settings.SYSTEM_NAME, settings.SETTING_IMPORT_BODYPLAN)
			if (option == 1) {
				saveprot = false
			}
			if (option == 2) {
				saveprot = await new Promise((resolve, reject) => {
					let d = new Dialog({
						title: 'Hit Location Body Plan',
						content:
							`Do you want to <br><br><b>Save</b> the current Body Plan (${game.i18n.localize(
								'GURPS.BODYPLAN' + data.additionalresources.bodyplan
							)}) or ` +
							`<br><br><b>Overwrite</b> it with the Body Plan from the import: (${game.i18n.localize(
								'GURPS.BODYPLAN' + bodyplan
							)})?<br><br>&nbsp;`,
						buttons: {
							save: {
								icon: '<i class="far fa-square"></i>',
								label: 'Save',
								callback: () => resolve(false),
							},
							overwrite: {
								icon: '<i class="fas fa-edit"></i>',
								label: 'Overwrite',
								callback: () => resolve(true),
							},
						},
						default: 'save',
						close: () => resolve(false), // just assume overwrite.   Error handling would be too much work right now.
					})
					d.render(true)
				})
			}
		}
		if (saveprot)
			return {
				'system.-=hitlocations': null,
				'system.hitlocations': prot,
				'system.additionalresources.bodyplan': bodyplan,
			}
		else return {}
	}

	/**
	 *
	 * @param {Array<HitLocations.HitLocation>} locations
	 */
	_getBodyPlan(locations) {
		// each key is a "body plan" name like "humanoid" or "quadruped"
		let tableNames = Object.keys(HitLocations.hitlocationDictionary)

		// create a map of tableName:count
		/** @type {Record<string, number>} */
		let tableScores = {}
		tableNames.forEach(it => (tableScores[it] = 0))

		// increment the count for a tableScore if it contains the same hit location as "prot"
		locations.forEach(function(hitLocation) {
			tableNames.forEach(function(tableName) {
				if (HitLocations.hitlocationDictionary[tableName].hasOwnProperty(hitLocation.where)) {
					tableScores[tableName] = tableScores[tableName] + 1
				}
			})
		})

		// Select the tableScore with the highest score.
		let match = -1
		let name = HitLocations.HitLocation.HUMANOID
		Object.keys(tableScores).forEach(function(score) {
			if (tableScores[score] > match) {
				match = tableScores[score]
				name = score
			}
		})

		// In the case of a tie, select the one whose score is closest to the number of entries
		// in the table.
		let results = Object.keys(tableScores).filter(it => tableScores[it] === match)
		if (results.length > 1) {
			let diff = Number.MAX_SAFE_INTEGER
			results.forEach(key => {
				// find the smallest difference
				let table = HitLocations.hitlocationDictionary[key]
				if (Object.keys(table).length - match < diff) {
					diff = Object.keys(table).length - match
					name = key
				}
			})
		}

		return name
	}

	/**
	 * @param {{ [key: string]: any }} json
	 * @param {boolean} isFoundryGCS
	 */
	importEquipmentFromGCSv1(json, isFoundryGCS) {
		if (!json) return
		let t = this.textFrom
		let i = this.intFrom
		let f = this.floatFrom

		/**
		 * @type {Equipment[]}
		 */
		let temp = []
		for (let key in json) {
			if (key.startsWith('id-')) {
				// Allows us to skip over junk elements created by xml->json code, and only select the skills.
				let j = json[key]
				let eqt = new Equipment()
				eqt.name = t(j.name)
				eqt.count = t(j.count)
				eqt.cost = t(j.cost)
				eqt.location = t(j.location)
				let cstatus = i(j.carried)
				eqt.carried = cstatus >= 1
				eqt.equipped = cstatus == 2
				eqt.techlevel = t(j.tl)
				eqt.legalityclass = t(j.lc)
				eqt.categories = t(j.type)
				eqt.uses = t(j.uses)
				eqt.maxuses = t(j.maxuses)
				eqt.uuid = t(j.uuid)
				eqt.parentuuid = t(j.parentuuid)
				if (isFoundryGCS) {
					eqt.notes = t(j.notes)
					eqt.weight = t(j.weight)
				} else {
					eqt.setNotes(t(j.notes))
					eqt.weight = t(j.weightsum) // GCA sends calculated weight in 'weightsum'
				}
				eqt.pageRef(t(j.pageref))
				let old = this._findElementIn('equipment.carried', eqt.uuid)
				if (!old) old = this._findElementIn('equipment.other', eqt.uuid)
				this._migrateOtfsAndNotes(old, eqt)
				if (!!old) {
					eqt.carried = old.carried
					eqt.equipped = old.equipped
					eqt.parentuuid = old.parentuuid
					if (old.ignoreImportQty) {
						eqt.count = old.count
						eqt.uses = old.uses
						eqt.maxuses = old.maxuses
						eqt.ignoreImportQty = true
					}
				}
				temp.push(eqt)
			}
		}

		// Save the old User Entered Notes.
		recurselist(this.data.data.equipment?.carried, t => {
			t.carried = true
			if (!!t.save) temp.push(t)
		}) // Ensure carried eqt stays in carried
		recurselist(this.data.data.equipment?.other, t => {
			t.carried = false
			if (!!t.save) temp.push(t)
		})

		temp.forEach(eqt => {
			// Remove all entries from inside items because if they still exist, they will be added back in
			eqt.contains = {}
			eqt.collapsed = {}
		})

		// Put everything in it container (if found), otherwise at the top level
		temp.forEach(eqt => {
			if (!!eqt.parentuuid) {
				let parent = null
				parent = temp.find(e => e.uuid === eqt.parentuuid)
				if (!!parent) GURPS.put(parent.contains, eqt)
				else eqt.parentuuid = '' // Can't find a parent, so put it in the top list
			}
		})

		let equipment = {
			carried: {},
			other: {},
		}
		let cindex = 0
		let oindex = 0

		temp.forEach(eqt => {
			Equipment.calc(eqt)
			if (!eqt.parentuuid) {
				if (eqt.carried) GURPS.put(equipment.carried, eqt, cindex++)
				else GURPS.put(equipment.other, eqt, oindex++)
			}
		})
		return {
			'system.-=equipment': null,
			'system.equipment': equipment,
		}
	}

	// Fold a flat array into a hierarchical target object
	/**
	 * @param {any[]} flat
	 */
	foldList(flat, target = {}) {
		flat.forEach(obj => {
			if (!!obj.parentuuid) {
				const parent = flat.find(o => o.uuid == obj.parentuuid)
				if (!!parent) {
					if (!parent.contains) parent.contains = {} // lazy init for older characters
					GURPS.put(parent.contains, obj)
				} else obj.parentuuid = '' // Can't find a parent, so put it in the top list.  should never happen with GCS
			}
		})
		let index = 0
		flat.forEach(obj => {
			if (!obj.parentuuid) GURPS.put(target, obj, index++)
		})
		return target
	}

	/**
	 * @param {{ [x: string]: Record<string, any>; }} json
	 */
	importEncumbranceFromGCSv1(json) {
		if (!json) return
		let t = this.textFrom
		let es = {}
		let index = 0
		let cm = 0
		let cd = 0
		for (let i = 0; i < 5; i++) {
			let e = new Encumbrance()
			e.level = i
			let k = 'enc_' + i
			let c = t(json[k])
			e.current = c === '1'
			k = 'enc' + i
			e.key = k
			let k2 = k + '_weight'
			e.weight = t(json[k2])
			k2 = k + '_move'
			e.move = this.intFrom(json[k2])
			k2 = k + '_dodge'
			e.dodge = this.intFrom(json[k2])
			if (e.current) {
				cm = e.move
				cd = e.dodge
			}
			GURPS.put(es, e, index++)
		}
		return {
			'system.currentmove': cm,
			'system.currentdodge': cd,
			'system.-=encumbrance': null,
			'system.encumbrance': es,
		}
	}

	/**
	 * Copy old OTFs to the new object, and update the displayable notes
	 * @param {Skill|Spell|Ranged|Melee} oldobj
	 * @param {Skill|Spell|Ranged|Melee} newobj
	 */
	_migrateOtfsAndNotes(oldobj = {}, newobj, importvttnotes = '') {
		if (!!importvttnotes) newobj.notes += (!!newobj.notes ? ' ' : '') + importvttnotes
		this._updateOtf('check', oldobj, newobj)
		this._updateOtf('during', oldobj, newobj)
		this._updateOtf('pass', oldobj, newobj)
		this._updateOtf('fail', oldobj, newobj)
		if (oldobj.notes?.startsWith(newobj.notes))
			// Must be done AFTER OTFs have been stripped out
			newobj.notes = oldobj.notes
		if (oldobj.name?.startsWith(newobj.name)) newobj.name = oldobj.name
	}

	/**
	 *  Search for specific format OTF in the notes (and vttnotes).
	 *  If we find it in the notes, remove it and replace the notes with the shorter version
	 */
	_updateOtf(otfkey, oldobj, newobj) {
		let objkey = otfkey + 'otf'
		let oldotf = oldobj[objkey]
		newobj[objkey] = oldotf
		var notes, newotf
			;[notes, newotf] = this._removeOtf(otfkey, newobj.notes || '')
		if (!!newotf) newobj[objkey] = newotf
		newobj.notes = notes.trim()
	}

	// Looking for OTFs in text.  ex:   c:[/qty -1] during:[/anim healing c]
	_removeOtf(key, text) {
		if (!text) return [text, null]
		var start
		let patstart = text.toLowerCase().indexOf(key[0] + ':[')
		if (patstart < 0) {
			patstart = text.toLowerCase().indexOf(key + ':[')
			if (patstart < 0) return [text, null]
			else start = patstart + key.length + 2
		} else start = patstart + 3
		let cnt = 1
		let i = start
		if (i >= text.length) return [text, null]
		do {
			let ch = text[i++]
			if (ch == '[') cnt++
			if (ch == ']') cnt--
		} while (i < text.length && cnt > 0)
		if (cnt == 0) {
			let otf = text.substring(start, i - 1)
			let front = text.substring(0, patstart)
			let end = text.substr(i)
			if ((front == '' || front.endsWith(' ')) && end.startsWith(' ')) end = end.substring(1)
			return [front + end, otf]
		} else return [text, null]
	}

	/**
	 * @param {{ [key: string]: any }} json
	 * @param {boolean} isFoundryGCS
	 */
	importCombatMeleeFromGCSv1(json, isFoundryGCS) {
		if (!json) return
		let t = this.textFrom
		let melee = {}
		let index = 0
		for (let key in json) {
			if (key.startsWith('id-')) {
				// Allows us to skip over junk elements created by xml->json code, and only select the skills.
				let j = json[key]
				let oldnote = t(j.notes)
				for (let k2 in j.meleemodelist) {
					if (k2.startsWith('id-')) {
						let j2 = j.meleemodelist[k2]
						let m = new Melee()
						m.name = t(j.name)
						m.st = t(j.st)
						m.weight = t(j.weight)
						m.techlevel = t(j.tl)
						m.cost = t(j.cost)
						if (isFoundryGCS) {
							m.notes = t(j2.notes) || oldnote
							m.pageRef(t(j2.pageref))
						} else
							try {
								m.setNotes(t(j.text))
							} catch {
								console.log(m)
								console.log(t(j.text))
							}
						m.mode = t(j2.name)
						m.import = t(j2.level)
						m.damage = t(j2.damage)
						m.reach = t(j2.reach)
						m.parry = t(j2.parry)
						m.block = t(j2.block)
						let old = this._findElementIn('melee', false, m.name, m.mode)
						this._migrateOtfsAndNotes(old, m, t(j2.vtt_notes))

						GURPS.put(melee, m, index++)
					}
				}
			}
		}
		return {
			'system.-=melee': null,
			'system.melee': melee,
		}
	}

	/**
	 * @param {{ [key: string]: any }} json
	 * @param {boolean} isFoundryGCS
	 */
	importCombatRangedFromGCSv1(json, isFoundryGCS) {
		if (!json) return
		let t = this.textFrom
		let ranged = {}
		let index = 0
		for (let key in json) {
			if (key.startsWith('id-')) {
				// Allows us to skip over junk elements created by xml->json code, and only select the skills.
				let j = json[key]
				let oldnote = t(j.notes)
				for (let k2 in j.rangedmodelist) {
					if (k2.startsWith('id-')) {
						let j2 = j.rangedmodelist[k2]
						let r = new Ranged()
						r.name = t(j.name)
						r.st = t(j.st)
						r.bulk = t(j.bulk)
						r.legalityclass = t(j.lc)
						r.ammo = t(j.ammo)
						if (isFoundryGCS) {
							r.notes = t(j2.notes) || oldnote
							r.pageRef(t(j2.pageref))
						} else
							try {
								r.setNotes(t(j.text))
							} catch {
								console.log(r)
								console.log(t(j.text))
							}
						r.mode = t(j2.name)
						r.import = t(j2.level)
						r.damage = t(j2.damage)
						r.acc = t(j2.acc)
						r.rof = t(j2.rof)
						r.shots = t(j2.shots)
						r.rcl = t(j2.rcl)
						let rng = t(j2.range)
						r.range = rng
						let old = this._findElementIn('ranged', false, r.name, r.mode)
						this._migrateOtfsAndNotes(old, r, t(j2.vtt_notes))

						GURPS.put(ranged, r, index++)
					}
				}
			}
		}
		return {
			'system.-=ranged': null,
			'system.ranged': ranged,
		}
	}

	/**
	 * @param {{ race: Record<string, any>; height: Record<string, any>; weight: Record<string, any>; age: Record<string, any>; title: Record<string, any>; player: Record<string, any>; createdon: Record<string, any>; modifiedon: Record<string, any>; religion: Record<string, any>; birthday: Record<string, any>; hand: Record<string, any>; sizemodifier: Record<string, any>; tl: Record<string, any>; appearance: Record<string, any>; }} json
	 */
	importTraitsfromGCSv1(json) {
		if (!json) return
		let t = this.textFrom
		let ts = {}
		ts.race = t(json.race)
		ts.height = t(json.height)
		ts.weight = t(json.weight)
		ts.age = t(json.age)
		ts.title = t(json.title)
		ts.player = t(json.player)
		ts.createdon = t(json.createdon)
		ts.modifiedon = t(json.modifiedon)
		ts.religion = t(json.religion)
		ts.birthday = t(json.birthday)
		ts.hand = t(json.hand)
		ts.sizemod = t(json.sizemodifier)
		ts.techlevel = t(json.tl)
		// <appearance type="string">@GENDER, Eyes: @EYES, Hair: @HAIR, Skin: @SKIN</appearance>
		let a = t(json.appearance)
		ts.appearance = a
		try {
			let x = a.indexOf(', Eyes: ')
			if (x >= 0) {
				ts.gender = a.substring(0, x)
				let y = a.indexOf(', Hair: ')
				ts.eyes = a.substring(x + 8, y)
				x = a.indexOf(', Skin: ')
				ts.hair = a.substring(y + 8, x)
				ts.skin = a.substr(x + 8)
			}
		} catch {
			console.log('Unable to parse appearance traits for ')
			console.log(this)
		}
		return {
			'system.-=traits': null,
			'system.traits': ts,
		}
	}

	// Import the <attributes> section of the GCS FG XML file.
	/**
	 * @param {{ [key: string]: any }} json
	 */
	async importAttributesFromCGSv1(json) {
		if (!json) return
		let i = this.intFrom // shortcut to make code smaller -- I reject your attempt to make the code smaller. Why does it need to be smaller?
		let t = this.textFrom
		let data = this.data.data
		let att = data.attributes

		// attribute.values will be calculated in calculateDerivedValues()
		att.ST.import = i(json.strength)
		att.ST.points = i(json.strength_points)
		att.DX.import = i(json.dexterity)
		att.DX.points = i(json.dexterity_points)
		att.IQ.import = i(json.intelligence)
		att.IQ.points = i(json.intelligence_points)
		att.HT.import = i(json.health)
		att.HT.points = i(json.health_points)
		att.WILL.import = i(json.will)
		att.WILL.points = i(json.will_points)
		att.PER.import = i(json.perception)
		att.PER.points = i(json.perception_points)

		data.HP.max = i(json.hitpoints)
		data.HP.points = i(json.hitpoints_points)
		data.FP.max = i(json.fatiguepoints)
		data.FP.points = i(json.fatiguepoints_points)
		let hp = i(json.hps)
		let fp = i(json.fps)

		let saveCurrent = false
		if (!!data.lastImport && (data.HP.value != hp || data.FP.value != fp)) {
			let option = game.settings.get(settings.SYSTEM_NAME, settings.SETTING_IMPORT_HP_FP)
			if (option == 0) {
				saveCurrent = true
			}
			if (option == 2) {
				saveCurrent = await new Promise((resolve, reject) => {
					let d = new Dialog({
						title: 'Current HP & FP',
						content: `Do you want to <br><br><b>Save</b> the current HP (${data.HP.value}) & FP (${data.FP.value}) values or <br><br><b>Overwrite</b> it with the import data, HP (${hp}) & FP (${fp})?<br><br>&nbsp;`,
						buttons: {
							save: {
								icon: '<i class="far fa-square"></i>',
								label: 'Save',
								callback: () => resolve(true),
							},
							overwrite: {
								icon: '<i class="fas fa-edit"></i>',
								label: 'Overwrite',
								callback: () => resolve(false),
							},
						},
						default: 'save',
						close: () => resolve(false), // just assume overwrite.   Error handling would be too much work right now.
					})
					d.render(true)
				})
			}
		}
		if (!saveCurrent) {
			data.HP.value = hp
			data.FP.value = fp
		}

		let lm = {}
		lm.basiclift = t(json.basiclift)
		lm.carryonback = t(json.carryonback)
		lm.onehandedlift = t(json.onehandedlift)
		lm.runningshove = t(json.runningshove)
		lm.shiftslightly = t(json.shiftslightly)
		lm.shove = t(json.shove)
		lm.twohandedlift = t(json.twohandedlift)

		data.basicmove.value = t(json.basicmove)
		data.basicmove.points = i(json.basicmove_points)
		// data.basicspeed.value = t(json.basicspeed)
		data.basicspeed.value = this.floatFrom(json.basicspeed)

		data.basicspeed.points = i(json.basicspeed_points)
		data.thrust = t(json.thrust)
		data.swing = t(json.swing)
		data.currentmove = t(json.move)
		data.frightcheck = i(json.frightcheck)

		data.hearing = i(json.hearing)
		data.tastesmell = i(json.tastesmell)
		data.touch = i(json.touch)
		data.vision = i(json.vision)

		return {
			'system.attributes': att,
			'system.HP': data.HP,
			'system.FP': data.FP,
			'system.basiclift': data.basiclift,
			'system.basicmove': data.basicmove,
			'system.basicspeed': data.basicspeed,
			'system.thrust': data.thrust,
			'system.swing': data.swing,
			'system.currentmove': data.currentmove,
			'system.frightcheck': data.frightcheck,
			'system.hearing': data.hearing,
			'system.tastesmell': data.tastesmell,
			'system.touch': data.touch,
			'system.vision': data.vision,
			'system.liftingmoving': lm,
		}
	}

	// create/update the skills.
	// NOTE:  For the update to work correctly, no two skills can have the same name.
	// When reading data, use "this.data.data.skills", however, when updating, use "system.skills".
	/**
	 * @param {{ [key: string]: any }} json
	 * @param {boolean} isFoundryGCS
	 */
	importSkillsFromGCSv1(json, isFoundryGCS) {
		if (!json) return
		let temp = []
		let t = this.textFrom /// shortcut to make code smaller
		for (let key in json) {
			if (key.startsWith('id-')) {
				// Allows us to skip over junk elements created by xml->json code, and only select the skills.
				let j = json[key]
				let sk = new Skill()
				sk.name = t(j.name)
				sk.type = t(j.type)
				sk.import = t(j.level)
				if (sk.level == 0) sk.level = ''
				sk.points = this.intFrom(j.points)
				sk.relativelevel = t(j.relativelevel)
				if (isFoundryGCS) {
					sk.notes = t(j.notes)
					sk.pageRef(t(j.pageref))
				} else sk.setNotes(t(j.text))
				if (!!j.pageref) sk.pageRef(t(j.pageref))
				sk.uuid = t(j.uuid)
				sk.parentuuid = t(j.parentuuid)
				let old = this._findElementIn('skills', sk.uuid)
				this._migrateOtfsAndNotes(old, sk, t(j.vtt_notes))

				temp.push(sk)
			}
		}
		return {
			'system.-=skills': null,
			'system.skills': this.foldList(temp),
		}
	}

	// create/update the spells.
	// NOTE:  For the update to work correctly, no two spells can have the same name.
	// When reading data, use "this.data.data.spells", however, when updating, use "system.spells".
	/**
	 * @param {{ [key: string]: any }} json
	 * @param {boolean} isFoundryGCS
	 */
	importSpellsFromGCSv1(json, isFoundryGCS) {
		if (!json) return
		let temp = []
		let t = this.textFrom /// shortcut to make code smaller
		for (let key in json) {
			if (key.startsWith('id-')) {
				// Allows us to skip over junk elements created by xml->json code, and only select the skills.
				let j = json[key]
				let sp = new Spell()
				sp.name = t(j.name)
				sp.class = t(j.class)
				sp.college = t(j.college)
				if (isFoundryGCS) {
					sp.cost = t(j.cost)
					sp.maintain = t(j.maintain)
					sp.difficulty = t(j.difficulty)
					sp.relativelevel = t(j.relativelevel)
					sp.notes = t(j.notes)
				} else {
					let cm = t(j.costmaintain)
					let i = cm.indexOf('/')
					if (i >= 0) {
						sp.cost = cm.substring(0, i)
						sp.maintain = cm.substr(i + 1)
					} else {
						sp.cost = cm
					}
					sp.setNotes(t(j.text))
				}
				sp.pageRef(t(j.pageref))
				sp.duration = t(j.duration)
				sp.points = t(j.points)
				sp.casttime = t(j.time)
				sp.import = t(j.level)
				sp.uuid = t(j.uuid)
				sp.parentuuid = t(j.parentuuid)
				let old = this._findElementIn('spells', sp.uuid)
				this._migrateOtfsAndNotes(old, sp, t(j.vtt_notes))
				temp.push(sp)
			}
		}
		return {
			'system.-=spells': null,
			'system.spells': this.foldList(temp),
		}
	}

	/**
	 * @param {{ [key: string]: any }} adsjson
	 * @param {{ [key: string]: any }} disadsjson
	 */
	importAdsFromGCA(adsjson, disadsjson) {
		/** @type {Advantage[]} */
		let list = []
		this.importBaseAdvantages(list, adsjson)
		this.importBaseAdvantages(list, disadsjson)
		return {
			'system.-=ads': null,
			'system.ads': this.foldList(list),
		}
	}

	/**
	 * @param {Advantage[]} datalist
	 * @param {{ [key: string]: any }} json
	 */
	importBaseAdvantages(datalist, json) {
		if (!json) return
		let t = this.textFrom /// shortcut to make code smaller
		for (let key in json) {
			if (key.startsWith('id-')) {
				// Allows us to skip over junk elements created by xml->json code, and only select the skills.
				let j = json[key]
				let a = new Advantage()
				a.name = t(j.name)
				a.points = this.intFrom(j.points)
				a.setNotes(t(j.text))
				a.pageRef(t(j.pageref) || a.pageref)
				a.uuid = t(j.uuid)
				a.parentuuid = t(j.parentuuid)
				let old = this._findElementIn('ads', a.uuid)
				this._migrateOtfsAndNotes(old, a, t(j.vtt_notes))
				datalist.push(a)
			}
		}
	}

	// In the new GCS import, all ads/disad/quirks/perks are in one list.
	/**
	 * @param {{ [key: string]: any }} json
	 */
	importAdsFromGCSv2(json) {
		let t = this.textFrom /// shortcut to make code smaller
		let temp = []
		for (let key in json) {
			if (key.startsWith('id-')) {
				// Allows us to skip over junk elements created by xml->json code, and only select the skills.
				let j = json[key]
				let a = new Advantage()
				a.name = t(j.name)
				a.points = this.intFrom(j.points)
				a.note = t(j.notes)
				a.userdesc = t(j.userdesc)
				a.notes = ''
				if (!!a.note && !!a.userdesc) a.notes = a.note + '\n' + a.userdesc
				else if (!!a.note) a.notes = a.note
				else if (!!a.userdesc) a.notes = a.userdesc
				a.pageRef(t(j.pageref))
				a.uuid = t(j.uuid)
				a.parentuuid = t(j.parentuuid)
				let old = this._findElementIn('ads', a.uuid)
				this._migrateOtfsAndNotes(old, a, t(j.vtt_notes))
				temp.push(a)
			}
		}
		return {
			'system.-=ads': null,
			'system.ads': this.foldList(temp),
		}
	}

	/**
	 * Adds any assigned resource trackers to the actor data and sheet.
	 */
	async setResourceTrackers() {
		// find those with non-blank slots
		let templates = ResourceTrackerManager.getAllTemplates().filter(it => !!it.slot)

		for (const template of templates) {
			// find the matching data on this actor
			let index = zeroFill(template.slot, 4)
			let path = `additionalresources.tracker.${index}`
			let tracker = getProperty(this, path)

			while (!tracker) {
				await this.addTracker()
				tracker = getProperty(this, path)
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
		let value = 0
		if (!!template.initialValue) {
			value = parseInt(template.initialValue, 10)
			if (Number.isNaN(value)) {
				// try to use initialValue as a path to another value
				value = getProperty(this, template.initialValue)
			}
		}
		template.tracker.max = value
		template.tracker.value = template.tracker.isDamageTracker ? template.tracker.min : value

		// remove whatever is there
		await this.clearTracker(path)

		// add the new tracker
		/** @type {{ [key: string]: any }} */
		let update = {}
		update[`data.${path}`] = template.tracker
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
		update[`data.${path}`] = {
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
		let trackerData = this.data.data.additionalresources.tracker
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
		let data = GurpsActor.addTrackerToDataObject(this.data.data, trackerData)

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

	async setMoveDefault(value) {
		this.ignoreRender = true
		let move = this.data.data.move
		for (const key in move) {
			move[key].default = value === key
		}
		await this.update({ 'system.-=move': null })
		await this.update({ 'system.move': move })
		this._forceRender()
	}

	// --- Functions to handle events on actor ---

	/**
	 * @param {any[]} damageData
	 */
	handleDamageDrop(damageData) {
		if (game.user.isGM || !game.settings.get(settings.SYSTEM_NAME, settings.SETTING_ONLY_GMS_OPEN_ADD))
			new ApplyDamageDialog(this, damageData).render(true)
		else ui.notifications?.warn('Only GMs are allowed to Apply Damage.')
	}

	// Drag and drop from Item colletion
	/**
	 * @param {{ type: any; x?: number; y?: number; payload?: any; pack?: any; id?: any; data?: any; }} dragData
	 */
	async handleItemDrop(dragData) {
		if (!this.isOwner) {
			ui.notifications?.warn(i18n('GURPS.youDoNotHavePermssion'))
			return
		}
		const uuid =
			typeof dragData.pack === 'string'
				? `Compendium.${dragData.pack}.${dragData.id}`
				: `${dragData.type}.${dragData.id}`
		let global = await fromUuid(dragData.uuid)
		let data = !!global ? global : dragData
		if (!data) {
			ui.notifications?.warn('NO ITEM DATA!')
			return
		}
		ui.notifications?.info(data.name + ' => ' + this.name)
		if (!data.globalid) await data.update({ _id: data._id, 'system.globalid': uuid })
		this.ignoreRender = true
		await this.addNewItemData(data)
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
			ui.notifications?.warn("You cannot drag from an un-linked token.   The source must have 'Linked Actor Data'")
			return
		}
		let srcActor = game.actors.get(dragData.actorid)
		let eqt = getProperty(srcActor, dragData.key)
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
				let destKey = this._findEqtkeyForId('globalid', eqt.globalid)
				if (!!destKey) {
					// already have some
					let destEqt = getProperty(this, destKey)
					await this.updateEqtCount(destKey, destEqt.count + eqt.count)
					await srcActor.deleteEquipment(dragData.key)
				} else {
					let item = await srcActor.deleteEquipment(dragData.key)
					await this.addNewItemData(item.data)
				}
			} else {
				let content = await renderTemplate('systems/gurps/templates/transfer-equipment.html', { eqt: eqt })
				let callback = async (/** @type {JQuery<HTMLElement> | HTMLElement} */ html) => {
					// @ts-ignore
					let qty = parseInt(html.find('#qty').val())
					let destKey = this._findEqtkeyForId('globalid', eqt.globalid)
					if (!!destKey) {
						// already have some
						let destEqt = getProperty(this, destKey)
						await this.updateEqtCount(destKey, destEqt.count + qty)
					} else {
						let item = /** @type {GurpsItem} */ (srcActor.items.get(eqt.itemid))
						item.data.data.eqt.count = qty
						await this.addNewItemData(item.data)
					}
					if (qty >= eqt.count) await srcActor.deleteEquipment(dragData.key)
					else await srcActor.updateEqtCount(dragData.key, eqt.count - qty)
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
					count: count,
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
		let _data = GurpsItem.asGurpsItem(item).system
		let oldkey = this._findEqtkeyForId('globalid', _data.globalid)
		var oldeqt
		if (!!oldkey) oldeqt = getProperty(this, oldkey)
		let other = item.id ? await this._removeItemElement(item.id, 'equipment.other') : null // try to remove from other
		if (!other) {
			// if not in other, remove from carried, and then re-add everything
			if (item.id) await this._removeItemElement(item.id, 'equipment.carried')
			await this.addItemData(item.data)
		} else {
			// If was in other... just add back to other (and forget addons)
			await this._addNewItemEquipment(item.data, 'system.equipment.other.' + zeroFill(0))
		}
		let newkey = this._findEqtkeyForId('globalid', _data.globalid)
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
		if (typeof itemData.toObject === 'function') d = itemData.toObject()
		// @ts-ignore
		let localItems = await this.createEmbeddedDocuments('Item', [d]) // add a local Foundry Item based on some Item data
		let localItem = localItems[0]
		await this.updateEmbeddedDocuments('Item', [{ _id: localItem.id, 'system.eqt.uuid': generateUniqueId() }])
		await this.addItemData(localItem, targetkey) // only created 1 item
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
			let eqt = getProperty(this, existing)
			return [existing, eqt.carried && eqt.equipped]
		}
		let _data = /** @type {GurpsItemData} */ (itemData)
		// HACK: ah, don't worry, we'll get rid of all this soon enough - M
		if (!!_data.system) _data = _data.system
		if (!!_data.eqt.parentuuid) {
			var found
			recurselist(this.data.data.equipment.carried, (e, k, d) => {
				if (e.uuid == _data.eqt.parentuuid) found = 'system.equipment.carried.' + k
			})
			if (!found)
				recurselist(this.data.data.equipment.other, (e, k, d) => {
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
				let list = getProperty(this, targetkey)
				while (list.hasOwnProperty(zeroFill(index))) index++
				targetkey += '.' + zeroFill(index)
			} else targetkey = 'system.equipment.other'
		if (targetkey.match(/^data\.equipment\.\w+$/)) targetkey += '.' + zeroFill(0) //if just 'carried' or 'other'
		let eqt = _data.eqt
		if (!eqt) {
			ui.notifications?.warn('Item: ' + itemData._id + ' (Global:' + _data.globalid + ') missing equipment')
			return ['', false]
		} else {
			eqt.itemid = itemData._id
			eqt.globalid = _data.uuid
			//eqt.uuid = 'item-' + eqt.itemid
			eqt.equipped = !!itemData.equipped ?? true
			eqt.img = itemData.img
			eqt.carried = !!itemData.carried ?? true
			await GURPS.insertBeforeKey(this, targetkey, eqt)
			await this.updateParentOf(targetkey, true)
			return [targetkey, eqt.carried && eqt.equipped]
		}
	}

	/**
	 * @param {GurpsItemData} itemData
	 * @param {string} eqtkey
	 */
	async _addItemAdditions(itemData, eqtkey) {
		let commit = {}
		commit = { ...commit, ...(await this._addItemElement(itemData, eqtkey, 'melee')) }
		commit = { ...commit, ...(await this._addItemElement(itemData, eqtkey, 'ranged')) }
		commit = { ...commit, ...(await this._addItemElement(itemData, eqtkey, 'ads')) }
		commit = { ...commit, ...(await this._addItemElement(itemData, eqtkey, 'skills')) }
		commit = { ...commit, ...(await this._addItemElement(itemData, eqtkey, 'spells')) }
		await this.internalUpdate(commit, { diff: false })
		this.calculateDerivedValues() // new skills and bonuses may affect other items... force a recalc
	}

	// called when equipment is being moved
	/**
	 * @param {Equipment} eqt
	 * @param {string} targetPath
	 */
	async updateItemAdditionsBasedOn(eqt, targetPath) {
		await this._updateEqtStatus(eqt, targetPath, targetPath.includes('.carried'))
	}

	// Equipment may carry other eqt, so we must adjust the carried status all the way down.
	/**
	 * @param {Equipment} eqt
	 * @param {string} eqtkey
	 * @param {boolean} carried
	 */
	async _updateEqtStatus(eqt, eqtkey, carried) {
		eqt.carried = carried
		if (!!eqt.itemid) {
			let item = /** @type {Item} */ (await this.items.get(eqt.itemid))
			await this.updateEmbeddedDocuments('Item', [
				{ _id: item.id, 'system.equipped': eqt.equipped, 'system.carried': carried },
			])
			if (!carried || !eqt.equipped) await this._removeItemAdditions(eqt.itemid)
			if (carried && eqt.equipped) await this._addItemAdditions(item, eqtkey)
		}
		for (const k in eqt.contains) await this._updateEqtStatus(eqt.contains[k], eqtkey + '.contains.' + k, carried)
		for (const k in eqt.collapsed) await this._updateEqtStatus(eqt.collapsed[k], eqtkey + '.collapsed.' + k, carried)
	}

	/**
	 * @param {ItemData} itemData
	 * @param {string} eqtkey
	 * @param {string} key
	 */
	async _addItemElement(itemData, eqtkey, key) {
		let found = false
		// @ts-ignore
		recurselist(this.data.data[key], (e, k, d) => {
			if (e.itemid == itemData._id) found = true
		})
		if (found) return
		// @ts-ignore
		let list = { ...this.data.data[key] } // shallow copy
		let i = 0
		// @ts-ignore
		for (const k in itemData.system[key]) {
			// @ts-ignore
			let e = duplicate(itemData.system[key][k])
			e.itemid = itemData._id
			e.uuid = key + '-' + i++ + '-' + e.itemid
			e.eqtkey = eqtkey
			e.img = itemData.img
			GURPS.put(list, e)
		}
		return i == 0 ? {} : { ['system.' + key]: list }
	}

	// return the item data that was deleted (since it might be transferred)
	/**
	 * @param {string} path
	 */
	async deleteEquipment(path, depth = 0) {
		let eqt = getProperty(this, path)
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
		this.ignoreRender = saved
	}

	// We have to remove matching items after we searched through the list
	// because we cannot safely modify the list why iterating over it
	// and as such, we can only remove 1 key at a time and must use thw while loop to check again
	/**
	 * @param {string} itemid
	 * @param {string} key
	 */
	async _removeItemElement(itemid, key) {
		let found = true
		let any = false
		while (!!found) {
			found = false
			let list = getProperty(this, key)
			recurselist(list, (e, k, d) => {
				if (e.itemid == itemid) found = k
			})
			if (!!found) {
				any = true
				await GURPS.removeKey(this, 'system.' + key + '.' + found)
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
		let object = getProperty(this, srckey)
		if (targetkey.match(/^data\.equipment\.\w+$/)) {
			this.ignoreRender = true
			object.parentuuid = ''
			if (!!object.itemid) {
				let item = /** @type {Item} */ (this.items.get(object.itemid))
				await this.updateEmbeddedDocuments('Item', [{ _id: item.id, 'system.eqt.parentuuid': '' }])
			}
			let target = { ...GURPS.decode(this.data, targetkey) } // shallow copy the list
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
						let targ = getProperty(this, targetkey)

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
		let obj = getProperty(this, path)
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
		let srceqt = getProperty(this, srckey)
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
				item.data.data.eqt.count = count
				await this.addNewItemData(item.data, targetkey)
				await this.updateParentOf(targetkey, true)
			}
			this._forceRender()
			return true
		} else {
			// simple eqt
			let neqt = duplicate(srceqt)
			neqt.count = count
			this.ignoreRender = true
			await this.updateEqtCount(srckey, srceqt.count - count)
			await GURPS.insertBeforeKey(this, targetkey, neqt)
			await this.updateParentOf(targetkey, true)
			this._forceRender()
			return true
		}
		return false
	}

	/**
	 * @param {string} srckey
	 * @param {string} targetkey
	 */
	async _checkForMerging(srckey, targetkey) {
		let srceqt = getProperty(this, srckey)
		let desteqt = getProperty(this, targetkey)
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
		for (const [key, value] of Object.entries(this.data.data.hitlocations)) {
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
	 * @returns the appropriate hitlocation table based on the actor's bodyplan
	 */
	get _hitLocationRolls() {
		return HitLocations.HitLocation.getHitLocationRolls(this.data.data.additionalresources?.bodyplan)
	}

	// Return the 'where' value of the default hit location, or 'Random'
	// NOTE: could also return 'Large-Area'?
	get defaultHitLocation() {
		// TODO implement a system setting but (potentially) allow it to be overridden
		return game.settings.get('gurps', 'default-hitlocation')
	}

	getCurrentDodge() {
		return this.data.data.currentdodge
	}

	getCurrentMove() {
		return this.data.data.currentmove
	}

	getTorsoDr() {
		if (!this.data.data.hitlocations) return 0
		let hl = Object.values(this.data.data.hitlocations).find(h => h.penalty == 0)
		return !!hl ? hl : { dr: 0 }
	}

	/**
	 * @param {string} key
	 */
	getEquipped(key) {
		let val = 0
		let txt = ''
		if (!!this.data.data.melee && !!this.data.data.equipment?.carried)
			Object.values(this.data.data.melee).forEach(melee => {
				recurselist(this.data.data.equipment.carried, (e, k, d) => {
					if (!!e && !val && e.equipped && !!melee.name.match(makeRegexPatternFrom(e.name, false))) {
						let t = parseInt(melee[key])
						if (!isNaN(t)) {
							val = t
							txt = '' + melee[key]
						}
					}
				})
			})
		// @ts-ignore
		if (!val && !!this.data.data[key]) {
			txt = '' + this.data.data[key]
			val = parseInt(txt)
		}
		return [txt, val]
	}

	getEquippedParry() {
		let [txt, val] = this.getEquipped('parry')
		this.data.data.equippedparryisfencing = !!txt && txt.match(/f$/i)
		return val
	}

	getEquippedBlock() {
		return this.getEquipped('block')[1]
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
		while (pattern[0] == '/') pattern = pattern.substr(1)
		pattern = makeRegexPatternFrom(pattern, false)
		let pats = pattern
			.substr(1) // remove the ^ from the beginning of the string
			.split('/')
			.map(e => new RegExp('^' + e, 'i')) // and apply it to each pattern
		/**
		 * @type {any}
		 */
		var eqt, key
		let list1 = otherFirst ? this.data.data.equipment.other : this.data.data.equipment.carried
		let list2 = otherFirst ? this.data.data.equipment.carried : this.data.data.equipment.other
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
		let encs = this.data.data.encumbrance
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
				let t = 'system.encumbrance.' + key + '.current'
				if (key === best) {
					enc.current = true
					this.data.data.currentmove = parseInt(enc.currentmove)
					this.data.data.currentdodge = parseInt(enc.currentdodge)
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
		let update = { [eqtkey + '.count']: count }
		if (game.settings.get(settings.SYSTEM_NAME, settings.SETTING_AUTOMATICALLY_SET_IGNOREQTY))
			update[eqtkey + '.ignoreImportQty'] = true
		await this.update(update)
		let eqt = getProperty(this, eqtkey)
		await this.updateParentOf(eqtkey, false)
		if (!!eqt.itemid) {
			let item = this.items.get(eqt.itemid)
			if (!!item) await this.updateEmbeddedDocuments('Item', [{ _id: item.id, 'system.eqt.count': count }])
			else {
				ui.notifications?.warn('Invalid Item in Actor... removing all features')
				this._removeItemAdditions(eqt.itemid)
			}
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
		let parent = getProperty(this, sp)
		if (!!parent) {
			// data protection
			await Equipment.calcUpdate(this, parent, sp) // and re-calc cost and weight sums from the top down
			if (updatePuuid) {
				let puuid = ''
				if (paths.length >= 6) {
					sp = paths.slice(0, -2).join('.')
					puuid = getProperty(this, sp).uuid
				}
				await this.internalUpdate({ [srckey + '.parentuuid']: puuid })
				let eqt = getProperty(this, srckey)
				if (!!eqt.itemid) {
					let item = this.items.get(eqt.itemid)
					if (item) await this.updateEmbeddedDocuments('Item', [{ _id: item.id, 'system.eqt.parentuuid': puuid }])
				}
			}
		}
	}

	isEmptyActor() {
		let d = this.data.data
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
}
