'use strict'

import ChatProcessor from './chat-processor.js'
import { parselink } from '../../lib/parselink.js'
import { isNiceDiceEnabled, splitArgs, i18n } from '../../lib/utilities.js'

export class EveryoneAChatProcessor extends ChatProcessor {
	help() {
		return '/everyone (or /ev) &lt;formula&gt;'
	}
	isGMOnly() {
		return true
	}

	matches(line) {
		this.match = line.match(/^\/(everyone|ev) ([fh]p) reset/i)
		return !!this.match
	}
	usagematches(line) {
		return line.match(/^[\/\?](everyone|ev)$/i)
	}
	usage() {
		return i18n('GURPS.chatHelpEveryone')
	}

	async process(line) {
		let m = this.match
		let any = false
		for (const t of canvas.tokens.ownedTokens) {
			let actor = t.actor
			if (actor.hasPlayerOwner) {
				any = true
				let attr = m[2].toUpperCase()
				let max = actor.data.data[attr].max
				await actor.update({ ['data.' + attr + '.value']: max })
				this.priv(`${actor.displayname} ${attr} reset to ${max}`)
			}
		}
		if (!any) this.priv(`There are no player owned characters!`)
	}
}

export class EveryoneBChatProcessor extends ChatProcessor {
	help() {
		return null
	} // Don't display a help line for this processor.  Useful if you have multiple processors for essentially the same command
	isGMOnly() {
		return true
	}

	matches(line) {
		this.match = line.match(/^\/(everyone|ev) \[(.*)\]/i)
		return !!this.match
	}

	async process(line) {
		let m = this.match
		let any = false
		let action = parselink(m[2].trim())
		if (!!action.action) {
			if (!['modifier', 'chat', 'pdf'].includes(action.action.type)) {
				for (const t of canvas.tokens.ownedTokens) {
					let actor = t.actor
					if (actor.hasPlayerOwner) {
						any = true
						let event = { data: {} }
						event.blind = this.msgs().quiet
						await GURPS.performAction(action.action, actor, event)
					}
				}
				if (!any) this.priv(`There are no player owned characters!`)
			} else this.priv(`Not allowed to execute Modifier, Chat or PDF links [${m[2].trim()}]`)
		} else this.priv(`Unable to parse On-the-Fly formula: [${m[2].trim()}]`)
	}
}

export class EveryoneCChatProcessor extends ChatProcessor {
	help() {
		return null
	} // Don't display a help line for this processor.  Useful if you have multiple processors for essentially the same command
	isGMOnly() {
		return true
	}

	matches(line) {
		// /everyone +1 fp or /everyone -2d-1 fp
		this.match = line.match(/^\/(everyone|ev) ([fh]p) *([+-]\d+d\d*)?([+-=]\d+)?(!)?/i)
		return !!this.match
	}

	async process(line) {
		let m = this.match
		if (!!m[3] || !!m[4]) {
			let any = false
			for (const t of canvas.tokens.ownedTokens) {
				let actor = t.actor
				if (actor.hasPlayerOwner) {
					any = true
					let mod = m[4] || ''
					let value = mod
					let dice = m[3] || ''
					let txt = ''
					let attr = m[2].toUpperCase()

					if (!!dice) {
						let sign = dice[0] == '-' ? -1 : 1
						let d = dice.match(/[+-](\d+)d(\d*)/)
						let r = d[1] + 'd' + (!!d[2] ? d[2] : '6') + `[/ev ${attr}]`
						let roll = Roll.create(r)
						await roll.evaluate({ async: true })
						if (isNiceDiceEnabled()) {
							let throws = []
							let dc = []
							roll.dice.forEach(die => {
								let type = 'd' + die.faces
								die.results.forEach(s =>
									dc.push({
										result: s.result,
										resultLabel: s.result,
										type: type,
										vectors: [],
										options: {},
									})
								)
							})
							throws.push({ dice: dc })
							if (dc.length > 0) {
								// The user made a "multi-damage" roll... let them see the dice!
								// @ts-ignore
								game.dice3d.show({ throws: throws })
							}
						}
						value = roll.total
						if (!!mod)
							if (isNaN(mod)) {
								ui.notifications.warn(`Unrecognized format for '${line}'`)
								return
							} else value += parseInt(mod)
						value = Math.max(value, !!m[5] ? 1 : 0)
						value *= sign
						txt = `(${value}) `
					}
					let cur = actor.data.data[attr].value
					let newval = parseInt(value)
					if (isNaN(newval)) {
						// only happens on =10
						newval = parseInt(value.substr(1))
						if (isNaN(newval)) {
							ui.notifications.warn(`Unrecognized format for '${line}'`)
							return
						}
					} else newval += cur
					let mtxt = ''
					let max = actor.data.data[attr].max
					if (newval > max) {
						newval = max
						mtxt = `(max: ${max})`
					}
					await actor.update({ ['data.' + attr + '.value']: newval })
					this.priv(`${actor.displayname} ${attr} ${dice}${mod} ${txt}${mtxt}`)
				}
			}
			if (!any) this.priv(`There are no player owned characters!`)
		} // Didn't provide dice or scalar, so maybe someone else wants to handle it
		else ui.notifications.warn(`There was no dice or number formula to apply '${line}'`)
	}
}

export class RemoteChatProcessor extends ChatProcessor {
	help() {
		return '/remote [OtF] &lt;user list&gt;'
	}
	isGMOnly() {
		return true
	}

	matches(line) {
		this.match = line.match(/^\/(remote|rem) \[(.*)\](.*)/i)
		return !!this.match
	}

	usagematches(line) {
		return line.match(/^[\/\?](remote|rem)$/i)
	}
	usage() {
		return i18n('GURPS.chatHelpRemote')
	}

	async process(line) {
		let m = this.match
		let action = parselink(m[2].trim())
		if (!!action.action) {
			let users = !!m[3] ? splitArgs(m[3]) : [] // empty array means everyone
			this.priv(line)
			game.socket.emit('system.gurps', {
				type: 'executeOtF',
				action: action.action,
				users: users,
			})
		} else this.priv(`Unable to parse On-the-Fly formula: [${m[2].trim()}]`)
	}
}
