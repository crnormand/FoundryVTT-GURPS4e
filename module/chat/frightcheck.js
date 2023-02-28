'use strict'

import { makeRegexPatternFrom } from '../../lib/utilities.js'
import ChatProcessor from './chat-processor.js'
import * as Settings from '../../lib/miscellaneous-settings.js'

export class FrightCheckChatProcessor extends ChatProcessor {
	help() {
		return '/frightcheck (or /fc)'
	}
	isGMOnly() {
		return true
	}

	matches(line) {
		this.match = line.match(/^\/(fc|frightcheck)/)
		return !!this.match
	}
	async process(line) {
		if (!GURPS.LastActor) {
			ui.notifications.error('Please select a token/character.')
			return
		}
		let actor = GURPS.LastActor
		let tblname = game.settings.get(Settings.SYSTEM_NAME, Settings.SETTING_FRIGHT_CHECK_TABLE) || 'Fright Check'

		// TODO reskin frightcheck UI
		renderTemplate('systems/gurps/templates/frightcheck-macro.html', { tblname: tblname }).then(dialogTemplate =>
			new Dialog(
				{
					title: 'Fright Check',
					content: dialogTemplate,
					buttons: {
						rollFrightCheck: {
							label: 'Roll Fright Check',
							callback: this.rollFrightCheckCallback.bind(this, actor),
						},
						close: {
							label: 'Close',
						},
					},
				},
				{ width: 650 }
			).render(true)
		)
	}

	/**
	 *
	 * @param {*} html
	 */
	async rollFrightCheckCallback(actor, html) {
		// { mod: -1, desc: 'Fearfulness 1' }
		let selectIds = [
			'#mod2',
			'#mod3',
			'#mod4',
			'#mod5',
			'#check1',
			'#check2',
			'#bodies1',
			'#bodies2',
			'#monster1',
			'#monster2',
			'#check4a',
			'#check4b',
			'#check4',
			'#check5',
			'#check6',
			'#check7',
			'#check3',
			'#check10',
			'#check8',
			'#check9',
			'#mod1',
		]
		let targetmods = []
		for (const id of selectIds) {
			//console.log(id)
			targetmods.push(this._getMod(html, id))
		}
		targetmods = targetmods.filter(it => it != null)

		let totalMod = targetmods.map(it => it.mod).reduce((a, b) => a + b, 0)
		let WILLVar = parseInt(actor.data.data.frightcheck || actor.data.data.attributes.WILL.value, 10)
		let finaltarget = totalMod + WILLVar

		// true or false?
		let ruleOf14 = finaltarget > 13
		finaltarget = ruleOf14 ? 13 : finaltarget

		let tblname = html.find('#tblname')[0].value
		game.settings.set(Settings.SYSTEM_NAME, Settings.SETTING_FRIGHT_CHECK_TABLE, tblname)

		let roll = Roll.create('3d6[Fright Check]')
		await roll.evaluate({ async: true })

		let margin = finaltarget - roll.total
		let failure = margin < 0
		let table = this._findFrightCheckTable(tblname)

		let content = await renderTemplate('systems/gurps/templates/frightcheck-results.hbs', {
			WILLVar: WILLVar,
			targetmods: targetmods,
			finaltarget: finaltarget,
			ruleOf14: ruleOf14,
			rtotal: roll.total,
			failure: failure,
			margin: finaltarget - roll.total,
			loaded: roll.isLoaded,
			rolls: roll.dice[0].results.map(it => it.result).join(),
		})

		await ChatMessage.create({
			type: CONST.CHAT_MESSAGE_TYPES.ROLL,
			speaker: ChatMessage.getSpeaker(actor),
			content: content,
			roll: JSON.stringify(roll),
			rollMode: game.settings.get('core', 'rollMode'),
		}).then(async html => {
			GURPS.setLastTargetedRoll({ margin: -margin }, actor)
			if (failure) {
				// Draw results using a custom roll formula.   use the negated margin for the rolltable only
				let tableRoll = Roll.create(`3d6[Fright Check table roll] + @margin`)
				table.draw({ roll: tableRoll }).then(() => GURPS.setLastTargetedRoll({ margin: margin }, actor)) // don't evaluate before passing
			}
		})
	}

	_getMod(html, id) {
		let mod = html.find(id)[0]
		if (mod.type === 'select' || mod.type === 'select-one') {
			if (parseInt(mod.value, 10) === 0) return null
			return { mod: parseInt(mod.value, 10), desc: mod.options[mod.selectedIndex].text }
		} else if (mod.type === 'checkbox') {
			if ($(mod).prop('checked')) {
				let label = html.find(`label[for="${mod.id}"]`)[0].innerText
				return { mod: parseInt(mod.value, 10), desc: label }
			}
		} else if (mod.type === 'number') {
			if (parseInt(mod.value, 10) === 0) return null
			let label = html.find(`label[for="${mod.id}"]`)[0].innerText
			return { mod: parseInt(mod.value, 10), desc: label }
		}

		return null
	}

	_findFrightCheckTable(tblname) {
		let pat = new RegExp(makeRegexPatternFrom(tblname, false), 'i')
		let tables = game.tables.contents.filter(t => t.name.match(pat))
		if (tables.length == 0) {
			ui.notifications.error("No table found for '" + tblname + "'")
		} else if (tables.length > 1) {
			ui.notifications.error("More than one table matched '" + tblname + "'")
		} else {
			return tables[0]
		}
		return null
	}
}
