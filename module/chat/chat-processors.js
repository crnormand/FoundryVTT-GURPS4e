'use strict'

import ChatProcessor from './chat-processor.js'
import { ChatProcessors } from '../../module/chat.js'
import { parselink, parseForRollOrDamage } from '../../lib/parselink.js'
import { NpcInput } from '../../lib/npc-input.js'
import { FrightCheckChatProcessor } from './frightcheck.js'
import {
	EveryoneAChatProcessor,
	EveryoneBChatProcessor,
	EveryoneCChatProcessor,
	RemoteChatProcessor,
} from './everything.js'
import { IfChatProcessor } from './if.js'
import {
	isNiceDiceEnabled,
	i18n,
	i18n_f,
	splitArgs,
	makeRegexPatternFrom,
	wait,
	zeroFill,
	locateToken,
	requestFpHp,
} from '../../lib/utilities.js'
import StatusChatProcessor from '../chat/status.js'
import SlamChatProcessor from '../chat/slam.js'
import TrackerChatProcessor from '../chat/tracker.js'
import { Migration } from '../../lib/migration.js'
import { AnimChatProcessor } from '../chat/anim.js'
import Maneuvers from '../actor/maneuver.js'

export default function RegisterChatProcessors() {
	ChatProcessors.registerProcessor(new RollAgainstChatProcessor())
	ChatProcessors.registerProcessor(new MookChatProcessor())
	ChatProcessors.registerProcessor(new SelectChatProcessor())
	ChatProcessors.registerProcessor(new EveryoneAChatProcessor())
	ChatProcessors.registerProcessor(new EveryoneBChatProcessor())
	ChatProcessors.registerProcessor(new EveryoneCChatProcessor())
	ChatProcessors.registerProcessor(new RollChatProcessor())
	ChatProcessors.registerProcessor(new ShowMBsChatProcessor())
	ChatProcessors.registerProcessor(new ClearMBsChatProcessor())
	ChatProcessors.registerProcessor(new StatusChatProcessor())
	ChatProcessors.registerProcessor(new FrightCheckChatProcessor())
	ChatProcessors.registerProcessor(new UsesChatProcessor())
	ChatProcessors.registerProcessor(new QtyChatProcessor())
	ChatProcessors.registerProcessor(new FpHpChatProcessor())
	ChatProcessors.registerProcessor(new SendMBChatProcessor())
	ChatProcessors.registerProcessor(new ChatExecuteChatProcessor())
	ChatProcessors.registerProcessor(new TrackerChatProcessor())
	ChatProcessors.registerProcessor(new IfChatProcessor())
	ChatProcessors.registerProcessor(new SetEventFlagsChatProcessor())
	ChatProcessors.registerProcessor(new RemoteChatProcessor())
	ChatProcessors.registerProcessor(new SlamChatProcessor())
	ChatProcessors.registerProcessor(new LightChatProcessor())
	ChatProcessors.registerProcessor(new ForceMigrateChatProcessor())
	ChatProcessors.registerProcessor(new ReimportChatProcessor())
	ChatProcessors.registerProcessor(new ShowChatProcessor())
	ChatProcessors.registerProcessor(new AnimChatProcessor())
	ChatProcessors.registerProcessor(new WaitChatProcessor())
	ChatProcessors.registerProcessor(new WhisperChatProcessor())
	ChatProcessors.registerProcessor(new RolltableChatProcessor())
	ChatProcessors.registerProcessor(new RefreshItemsChatProcessor())
	ChatProcessors.registerProcessor(new QuickDamageChatProcessor())
	ChatProcessors.registerProcessor(new SoundChatProcessor())
	ChatProcessors.registerProcessor(new DevChatProcessor())
	ChatProcessors.registerProcessor(new ManeuverChatProcessor())
	ChatProcessors.registerProcessor(new RepeatChatProcessor())
	ChatProcessors.registerProcessor(new StopChatProcessor())
}

class SoundChatProcessor extends ChatProcessor {
	help() {
		return '/sound &lt;path-to-sound&gt;'
	}

	matches(line) {
		this.match = line.match(/^\/sound +(?<wait>w[\d\.]+)? *(?<vol>v[\d\.]+)? *(?<file>.*)/i)
		return !!this.match
	}
	usagematches(line) {
		return line.match(/^[\/\?]sound$/i)
	}
	usage() {
		return i18n('GURPS.chatHelpSound')
	}

	async process(line) {
		let v = 0.8
		if (this.match.groups.vol) v = parseFloat(this.match.groups.vol.substr(1))
		if (this.match.groups.wait) await wait(parseFloat(this.match.groups.wait.substr(1)) * 1000)
		let data = {
			src: this.match.groups.file.trim(),
			volume: v,
			loop: false,
		}
		AudioHelper.play(data, true).then(sound => {
			if (sound.failed) ui.notifications.warn('Unable to play: ' + data.src)
		})
	}
}

class QuickDamageChatProcessor extends ChatProcessor {
	help() {
		return '/&lt;damage formula&gt;'
	}

	matches(line) {
		this.match = line.match(/^[\.\/](.*?)( +[xX\*]?(?<num>\d+))?$/)
		if (!!this.match) {
			this.action = parselink(this.match[1])
			return this.action?.action?.type == 'damage' || this.action?.action?.type == 'roll'
		}
		return false
	}
	async process(line) {
		let event = {
			shiftKey: this.action.action.blindroll,
			data: {
				repeat: this.match.groups.num,
			},
		}
		await GURPS.performAction(this.action.action, GURPS.LastActor, event)
	}
}

class RefreshItemsChatProcessor extends ChatProcessor {
	help() {
		return null
	}

	matches(line) {
		this.match = line.match(/^\/refreshitems/i)
		return !!this.match
	}
	async process(line) {
		ui.notifications.info('Starting Item refresh...')
		for (const a of game.actors.contents) {
			console.log('Executeing postImport() on ' + a.name)
			await a.postImport()
		}
		ui.notifications.info('Item refresh done.')
	}
}

class ForceMigrateChatProcessor extends ChatProcessor {
	help() {
		return null
	}

	matches(line) {
		this.match = line.match(/^\/forcemigrate/i)
		return !!this.match
	}
	async process(line) {
		await Migration.migrateTo096()
		await Migration.migrateTo097()
		await Migration.migrateTo0104()
		await Migration.fixDataModelProblems()
	}
}

class RolltableChatProcessor extends ChatProcessor {
	help() {
		return '/rolltable &lt;tablename&gt;'
	}
	matches(line) {
		this.match = line.match(/^\/rolltable(.*)/)
		return !!this.match
	}

	async process(line) {
		let tblname = this.match[1].trim()
		let pat = new RegExp(makeRegexPatternFrom(tblname, false), 'i')
		let tables = game.tables.contents.filter(t => t.name.match(pat))
		if (tables.length == 0) {
			ui.notifications.error("No table found for '" + tblname + "'")
			return false
		}
		if (tables.length > 1) {
			ui.notifications.error("More than one table matched '" + tblname + "'")
			return false
		}
		let table = tables[0]
		let r = await table.roll()
		table.draw(r)
		return true
	}
}

class WhisperChatProcessor extends ChatProcessor {
	help() {
		return '/w [players] <i>or</i> @'
	}
	matches(line) {
		this.match = line.match(/^\/w +@ +(.+)$/)
		return !!this.match
	}
	usagematches(line) {
		return line.match(/^[\/\?]w$/i)
	}
	usage() {
		return i18n('GURPS.chatHelpW')
	}
	process(line) {
		let destTokens = Array.from(game.user.targets)
		if (destTokens.length == 0) destTokens = canvas.tokens.controlled
		if (destTokens.length == 0) return false
		let users = []
		for (const token of destTokens) {
			let owners = game.users.contents.filter(
				u => token.actor.getUserLevel(u) >= CONST.DOCUMENT_PERMISSION_LEVELS.OWNER
			)
			for (const user of owners) if (!user.isGM) users.push(user)
		}
		if (users.length == 0) return false
		this.registry.processLine('/w [' + users.map(u => u.name).join(',') + '] ' + this.match[1])
	}
}

class ReimportChatProcessor extends ChatProcessor {
	isGMOnly() {
		return true
	}
	help() {
		return '/reimport &lt;optional character names&gt;'
	}
	matches(line) {
		return line.startsWith('/reimport')
	}
	process(line) {
		this.priv(line)
		let actornames = line.replace(/^\/reimport/, '').trim()
		actornames = splitArgs(actornames)
		let allPlayerActors = game.actors.entities.filter(a => a.hasPlayerOwner)
		let actors = []
		for (const name of actornames) {
			let actor = allPlayerActors.find(a => a.name.match(makeRegexPattern(name, false)))
			if (!!actor) actors.push(actor)
		}
		if (actornames.length == 0) actors = allPlayerActors
		actors.forEach(e => e.importCharacter())
	}
}

class WaitChatProcessor extends ChatProcessor {
	help() {
		return '/wait &lt;milliseconds&gt;'
	}
	matches(line) {
		this.match = line.match(/^\/wait +(\d+)/)
		return this.match
	}
	usagematches(line) {
		return line.match(/^[\/\?]wait$/i)
	}
	usage() {
		return i18n('GURPS.chatHelpWait')
	}
	async process(line) {
		this.priv(line)
		await wait(+this.match[1])
	}
}

class SetEventFlagsChatProcessor extends ChatProcessor {
	help() {
		return null
	}
	matches(line) {
		return line.startsWith('/setEventFlags')
	}
	process(line) {
		let m = line.match(/\/setEventFlags (\w+) (\w+) (\w+)/)
		this.registry.setEventFlags(m[1] == 'true', m[2] == 'true', m[3] == 'true')
	}
}

class ClearMBsChatProcessor extends ChatProcessor {
	help() {
		return '/clearmb'
	}
	matches(line) {
		return line.startsWith('/clearmb')
	}
	process(line) {
		this.priv(line)
		GURPS.ModifierBucket.clear(!line.endsWith('no-update'))
	}
}

class ShowMBsChatProcessor extends ChatProcessor {
	help() {
		return '/showmbs'
	}
	matches(line) {
		return line === '/showmbs'
	}
	process(line) {
		this.priv(line)
		// TODO Go to ModifierBucket and use chat-processor.html there too
		setTimeout(() => GURPS.ModifierBucket.showOthers(), 1000) // Need time for clients to update...and
	}
}

class RollAgainstChatProcessor extends ChatProcessor {
	help() {
		return '/ra N | Skillname-N'
	}
	matches(line) {
		this.match = line.match(/^([\.\/]p?ra) +([\w-'" ]+-)?(\d+)/i)
		return !!this.match
	}
	usagematches(line) {
		return line.match(/^[\/\?\.]p?ra$/i)
	}
	usage() {
		return i18n('GURPS.chatHelpRa')
	}
	async process(line) {
		let m = this.match
		let skill = m[2] || 'Default='
		skill = skill.replace('-', '=') + m[3]
		if (skill.includes(' ')) skill = '"' + skill + '"'
		let action = parselink('S:' + skill)
		this.send() // send what we have
		await GURPS.performAction(action.action, GURPS.LastActor, {
			shiftKey: line.substr(1).startsWith('pra') || this.msgs().event?.shiftKey,
		})
	}
}

class MookChatProcessor extends ChatProcessor {
	isGMOnly() {
		return true
	}
	help() {
		return '/mook'
	}
	matches(line) {
		this.match = line.match(/^\/mook/i)
		return !!this.match
	}
	process(line) {
		new NpcInput().render(true)
		this.priv('Opening Mook Generator')
	}
}

class ChatExecuteChatProcessor extends ChatProcessor {
	help() {
		return '/:&lt;macro name&gt args (arguments require "Advanced Macros" module)'
	}
	matches(line) {
		return line.startsWith('/:')
	}
	process(line) {
		GURPS.chatreturn = false
		let args = splitArgs(line.substr(2))
		GURPS.chatargs = args
		let m = Object.values(game.macros.contents).filter(m => m.name.startsWith(args[0]))
		if (m.length > 0) {
			this.send()
			GURPS.chatreturn = m[0].execute(args) ?? GURPS.chatreturn // if Advanced macros is loaded, take advantage of the return value
		} else this.priv(`${i18n('GURPS.chatUnableToFindMacro')} '${line.substr(2)}'`)
		return GURPS.chatreturn
	}
}

class SendMBChatProcessor extends ChatProcessor {
	isGMOnly() {
		return true
	}
	help() {
		return '/sendmb &lt;OtF&gt; &lt;playername(s)&gt;'
	}
	matches(line) {
		return line.startsWith('/sendmb')
	}
	process(line) {
		this.priv(line)
		let users = line.replace(/^\/sendmb/, '').trim()
		let m = users.match(/\[(.*)\](.*)/)
		if (!!m) {
			let otf = m[1]
			let t = parselink(otf)
			if (!!t.action && t.action.type == 'modifier') {
				GURPS.ModifierBucket.sendToPlayers(t.action, splitArgs(m[2]))
				return
			} else ui.notifications.warn(i18n('GURPS.chatYouMayOnlySendMod'))
		} else GURPS.ModifierBucket.sendToPlayers(null, splitArgs(users))
	}
}

class FpHpChatProcessor extends ChatProcessor {
	help() {
		return '/fp (or /hp) &lt;formula&gt;'
	}
	matches(line) {
		this.match = line.match(/^\/([fh]p) +([+-]\d+d\d*)?([+-=]\d+)?(!)?(reset)?(.*)/i)
		return !!this.match
	}
	usagematches(line) {
		return line.match(/^[\/\?][fh]p$/i)
	}
	usage() {
		return i18n('GURPS.chatHelpFpHp')
	}

	async process(line) {
		let m = this.match
		let actor = GURPS.LastActor
		if (!actor) {
			ui.notifications.warn(i18n('GURPS.chatYouMustHaveACharacterSelected'))
			return false
		}
		if (m[6]?.trim().toLowerCase() == '@target') {
			let targets = Array.from(game.user.targets).map(t => t.id)
			if (targets.length == 0) {
				ui.notifications.warn(i18n('GURPS.noTargetSelected'))
				return false
			}
			line = line.replace(/@target/gi, '')
			let remotes = []
			let locals = []
			targets.map(tid => {
				let ta = game.canvas.tokens.get(tid).actor
				let remote = false
				var any
				ta.getOwners().forEach(o => {
					if (!o.isGM && o.active && !any) {
						remote = true
						any = o
						remotes.push([o.id, tid])
					}
				})
				if (!remote) locals.push(['', tid])
				this.priv(`${i18n_f('GURPS.chatSentTo', { cmd: line, name: ta.name })}`)
			})

			game.socket?.emit('system.gurps', {
				type: 'playerFpHp',
				actorname: actor.name,
				targets: remotes,
				command: line,
			})

			requestFpHp({
				actorname: actor.name,
				targets: locals,
				command: line,
			})
			return true
		}

		let attr = m[1].toUpperCase()
		let delta = parseInt(m[3])
		const max = actor.data.data[attr].max
		let reset = ''
		if (!!m[5]) {
			await actor.update({ ['data.' + attr + '.value']: max })
			this.prnt(`${actor.displayname} reset to ${max} ${attr}`)
		} else if (isNaN(delta) && !!m[3]) {
			// only happens with '='
			delta = parseInt(m[3].substr(1))
			if (isNaN(delta)) ui.notifications.warn(`${i18n('GURPS.chatUnrecognizedFormat')} '${line}'`)
			else {
				let mtxt = ''
				if (delta > max) {
					delta = max
					mtxt = ` (max: ${max})`
				}
				await actor.update({ ['data.' + attr + '.value']: delta })
				this.prnt(`${actor.displayname} ${i18n('GURPS.chatSetTo')} ${delta} ${attr}${mtxt}`)
			}
		} else if (!!m[2] || !!m[3]) {
			let mtxt = ''
			let mod = m[3] || ''
			delta = parseInt(mod)
			let dice = m[2] || ''
			let txt = ''
			if (!!dice) {
				let sign = dice[0] == '-' ? -1 : 1
				let d = dice.match(/[+-](\d+)d(\d*)/)
				let r = d[1] + 'd' + (!!d[2] ? d[2] : '6') + `[/${attr}]`
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
				delta = roll.total
				if (!!mod)
					if (isNaN(mod)) {
						ui.notifications.warn(`${i18n('GURPS.chatUnrecognizedFormat')} '${line}'`)
						return
					} else delta += parseInt(mod)
				delta = Math.max(delta, !!m[4] ? 1 : 0)
				if (!!m[4]) mod += '!'
				delta *= sign
				txt = `(${delta}) `
			}
			delta += actor.data.data[attr].value
			if (delta > max) {
				delta = max
				mtxt = ` (max: ${max})`
			}
			await actor.update({ ['data.' + attr + '.value']: delta })
			this.prnt(`${actor.displayname} ${attr} ${dice}${mod} ${txt}${mtxt}`)
		} else ui.notifications.warn(`${i18n('GURPS.chatUnrecognizedFormat')} '${line}'`)
	}
}

class SelectChatProcessor extends ChatProcessor {
	help() {
		return '/select &lt;Actor name&gt'
	}
	matches(line) {
		this.match = line.match(/^\/(select|sel) ?(\@self)?([^!]*)(!)?/)
		return !!this.match
	}
	usagematches(line) {
		return line.match(/^\?(select|sel)$/i) // can't match on /select since that is a valid command
	}
	usage() {
		return i18n('GURPS.chatHelpSelect')
	}
	process(line) {
		let m = this.match
		if (!!m[2]) {
			// @self
			for (const a of game.actors.entities) {
				let users = a
					.getOwners()
					.filter(u => !u.isGM)
					.map(u => u.id)
				if (users.includes(game.user.id)) {
					let tokens = canvas.tokens.placeables.filter(t => t.actor == a)
					if (tokens.length == 1) {
						tokens[0].control({ releaseOthers: true }) // Foundry 'select'
						GURPS.SetLastActor(a, tokens[0].document)
					} else GURPS.SetLastActor(a)
					this.priv('Selecting ' + a.displayname)
					return
				}
			}
		} else if (!m[3]) {
			if (!!GURPS.LastActor) {
				let tokens = canvas.tokens.placeables.filter(t => t.actor == GURPS.LastActor)
				if (tokens.length == 1) tokens[0].release()
			}
			GURPS.ClearLastActor(GURPS.LastActor)
			this.priv(i18n('GURPS.chatClearingLastActor'))
		} else {
			let pat = makeRegexPatternFrom(m[3])

			let list =
				game.scenes.viewed?.tokens.map(t => {
					// get the token's actor which might be a synthetic actor
					if (t.actor) return t.actor
					// otherwise, get the 'canonical' actor (non-synthetic)
					return game.actors.get(t.actorId)
				}) || []

			if (!!m[4]) list = game.actors.entities // ! means check all actors, not just ones on scene
			let a = list.filter(a => a?.name?.match(pat))
			let msg = i18n('GURPS.chatMoreThanOneActor') + " '" + m[3] + "': " + a.map(e => e.name).join(', ')
			if (a.length == 0 || a.length > 1) {
				// No good match on actors, try token names
				a = canvas.tokens.placeables.filter(t => t.name.match(pat))
				msg = i18n('GURPS.chatMoreThanOneToken') + " '" + m[3] + "': " + a.map(e => e.name).join(', ')
				a = a.map(t => t.actor)
			}
			if (a.length == 0 || a.length > 1) {
				// No good match on token names -- is this a token ID?
				a = canvas.tokens.placeables.filter(t => t.id.match(pat))
				a = a.map(t => t.actor)
			}
			if (a.length == 0) ui.notifications.warn(i18n('GURPS.chatNoActorFound') + " '" + m[3] + "'")
			else if (a.length > 1) ui.notifications.warn(msg)
			else {
				GURPS.SetLastActor(a[0])
				let tokens = canvas.tokens.placeables.filter(t => t.actor == a[0])
				if (tokens.length == 1) tokens[0].control({ releaseOthers: true }) // Foundry 'select'
				this.priv('Selecting ' + a[0].displayname)
			}
		}
	}
}

class RollChatProcessor extends ChatProcessor {
	help() {
		return '/roll (or /r) [On-the-Fly formula]<br>/private (or /pr) [On-the-Fly formula] "Private"<br>/sr [On-the-Fly formula] "Selected Roll"<br>/psr [On-the-Fly formula] "Private Selected Roll"'
	}
	matches(line) {
		this.match = line.match(/^(\/roll|\/r|\/private|\/pr|\/sr|\/psr) \[(.+)\] *[xX\*]?(\d+)?/)
		return !!this.match
	}
	async process(line) {
		let m = this.match
		let action = parselink(m[2])
		if (!!action.action) {
			if (action.action.type === 'modifier')
				// only need to show modifiers, everything else does something.
				this.priv(line)
			else this.send() // send what we have

			let actors = [GURPS.LastActor]
			if (line.startsWith('/psr') || line.startsWith('/sr')) actors = canvas.tokens?.controlled.map(t => t.actor)
			let atLeastOne = false

			let last = GURPS.LastActor
			action.action.overridetxt = this.msgs().event?.data?.overridetxt
			let ev = {
				shiftKey: line.startsWith('/p') || action.action.blindroll,
				ctrlKey: false,
				data: {
					repeat: m[3],
					overridetxt: action.action.overridetxt,
					private: line.startsWith('/p'),
				},
			}
			for (const actor of actors) {
				GURPS.LastActor = actor
				let result = await GURPS.performAction(action.action, actor, ev)
				GURPS.LastActor = last
				atLeastOne = atLeastOne || result
			}
			return atLeastOne
		} // Looks like a /roll OtF, but didn't parse as one
		else ui.notifications.warn(`${i18n('GURPS.chatUnrecognizedFormat')} '[${m[2]}]'`)
		return false
	}
}

class UsesChatProcessor extends ChatProcessor {
	help() {
		return '/uses &lt;formula&gt; &lt;equipment name&gt;'
	}
	matches(line) {
		this.match = line.match(/^\/uses +([\+-=]\w+)?(reset)?(.*)/i)
		return !!this.match
	}
	usagematches(line) {
		return line.match(/^[\/\?]uses$/i)
	}
	usage() {
		return i18n('GURPS.chatHelpUses')
	}
	async process(line) {
		let answer = false
		let m = this.match
		let actor = GURPS.LastActor
		if (!actor) ui.notifications.warn(i18n('GURPS.chatYouMustHaveACharacterSelected'))
		else {
			var eqt, key
			let m2 = m[3].trim().match(/^(o[\.:])?(.*)/i)
			let pattern = m2[2].trim()
			if (!!pattern) [eqt, key] = actor.findEquipmentByName(pattern, !!m2[1])
			else if (this.msgs().event?.currentTarget) {
				pattern = '&lt;current equipment&gt;'
				let t = this.msgs().event?.currentTarget
				let k = $(t).closest('[data-key]').attr('data-key')
				// if we find a data-key, then we assume that we are on the character sheet, and if the target
				// is equipment, apply to that equipment.
				if (!!k) {
					key = k
					eqt = getProperty(actor, key)
					// if its not equipment, ignore.
					if (eqt.count == null) eqt = null
				}
			}
			if (!eqt) ui.notifications.warn(i18n('GURPS.chatNoEquipmentMatched') + " '" + pattern + "'")
			else {
				if (!m[1] && !m[2]) {
					// no +-= or reset
					ui.notifications.warn(`${i18n('GURPS.chatUnrecognizedFormat')} '${line}'`)
				} else {
					eqt = duplicate(eqt)
					let delta = parseInt(m[1])
					if (!!m[2]) {
						this.prnt(`${eqt.name} ${i18n('GURPS.chatUsesReset')} (${eqt.maxuses})`)
						eqt.uses = eqt.maxuses
						await actor.update({ [key]: eqt })
						answer = true
					} else if (isNaN(delta)) {
						// only happens with '='
						delta = m[1].substr(1)
						eqt.uses = delta
						await actor.update({ [key]: eqt })
						this.prnt(`${eqt.name} ${i18n('GURPS.chatUsesSet')} ${delta}`)
						answer = true
					} else {
						let q = parseInt(eqt.uses) + delta
						let max = parseInt(eqt.maxuses)
						if (isNaN(q)) ui.notifications.warn(eqt.name + ' ' + i18n('GURPS.chatUsesIsNaN'))
						else if (q < 0) ui.notifications.warn(eqt.name + ' ' + i18n('GURPS.chatDoesNotHaveEnough'))
						else if (!isNaN(max) && max > 0 && q > max)
							ui.notifications.warn(`${i18n('GURPS.chatExceededMaxUses')} (${max}) ${i18n('GURPS.for')} ` + eqt.name)
						else {
							this.prnt(`${eqt.name} ${i18n('GURPS.chatUses')} ${m[1]} = ${q}`)
							eqt.uses = q
							await actor.update({ [key]: eqt })
							answer = true
						}
					}
				}
			}
		}
		return answer
	}
}

class QtyChatProcessor extends ChatProcessor {
	help() {
		return '/qty &lt;formula&gt; &lt;equipment name&gt;'
	}
	matches(line) {
		this.match = line.match(/^\/qty +([\+-=] *\d+)(.*)/i)
		return !!this.match
	}
	usagematches(line) {
		return line.match(/^[\/\?]qty$/i)
	}
	usage() {
		return i18n('GURPS.chatHelpQty')
	}
	async process(line) {
		let answer = false
		let m = this.match
		let actor = GURPS.LastActor
		if (!actor) ui.notifications.warn(i18n('GURPS.chatYouMustHaveACharacterSelected'))
		else {
			var eqt, key
			let m2 = m[2].trim().match(/^(o[\.:])?(.*)/i)
			let pattern = m2[2].trim()
			if (!!pattern) [eqt, key] = actor.findEquipmentByName(pattern, !!m2[1])
			else if (this.msgs().event?.currentTarget) {
				pattern = '&lt;current equipment&gt;'
				let t = this.msgs().event?.currentTarget
				let k = $(t).closest('[data-key]').attr('data-key')
				// if we find a data-key, then we assume that we are on the character sheet, and if the target
				// is equipment, apply to that equipment.
				if (!!k) {
					key = k
					eqt = getProperty(actor, key)
					// if its not equipment, try to find equipment with that name
					if (eqt.count == null) [eqt, key] = actor.findEquipmentByName((pattern = eqt.name), !!m2[1])
				}
			}
			if (!eqt) ui.notifications.warn(i18n('GURPS.chatNoEquipmentMatched') + " '" + pattern + "'")
			else {
				eqt = duplicate(eqt)
				let delta = parseInt(m[1].replace(/ /g, ''))
				if (isNaN(delta)) {
					// only happens with '='
					delta = parseInt(m[1].substr(1).replace(/ /g, ''))
					if (isNaN(delta)) ui.notifications.warn(`${i18n('GURPS.chatUnrecognizedFormat')} '${m[1]}'`)
					else {
						answer = true
						await actor.updateEqtCount(key, delta)
						this.prnt(`${eqt.name} ${i18n('GURPS.chatQtySetTo')} ${delta}`)
					}
				} else {
					let q = parseInt(eqt.count) + delta
					if (q < 0) ui.notifications.warn(i18n('GURPS.chatYouDoNotHaveEnough') + " '" + eqt.name + "'")
					else {
						answer = true
						this.prnt(`${eqt.name} ${i18n('GURPS.chatQty')} ${m[1]}`)
						await actor.updateEqtCount(key, q)
					}
				}
			}
		}
		return answer
	}
}

class LightChatProcessor extends ChatProcessor {
	help() {
		return '/li &lt;dim dist&gt; &lt;bright dist&gt; &lt;angle&gt; &lt;anim&gt;|off '
	}
	matches(line) {
		// Could be this:
		// /^\/(light|li) *(?<off>none|off)? *(?<dim>\d+)? *(?<bright>\d+)? *(?<angle>\d+)? *(?<color>#[0-9a-fA-F]{6})? *(?<type>\w+)? *(?<speed>\d+)? *(?<intensity>\d+)?/i

		this.match = line.match(
			//      /^\/(light|li) *(none|off)? *(\d+)? *(\d+)? *(\d+)? *(#\w\w\w\w\w\w)? *(\w+)? *(\d+)? *(\d+)?/i
			/^\/(light|li) +(?<off>none|off)? *(?<dim>[\d\.]+)? *(?<bright>[\d\.]+)? *(?<angle>\d+)? *(?<color>#[0-9a-fA-F]{6})? *(?<colorint>[\d\.]+)? *(?<type>\w+)? *(?<speed>\d+)? *(?<intensity>\d+)?/i
		)
		return !!this.match
	}
	usagematches(line) {
		return line.match(/^[\/\?](light|li)$/i)
	}
	usage() {
		return i18n('GURPS.chatHelpLight')
	}
	async process(line) {
		if (canvas.tokens.controlled.length == 0) {
			ui.notifications.warn(i18n('GURPS.chatYouMustHaveACharacterSelected'))
			return
		}
		if (line.match(/^\/(light|li) *$/)) {
			this.priv('Possible animations: ' + Object.keys(CONFIG.Canvas.lightAnimations).join(', '))
			return
		}
		let type = this.match.groups.type || ''
		if (!!type) {
			let pat = new RegExp(makeRegexPatternFrom(type, false), 'i')
			let m = Object.keys(CONFIG.Canvas.lightAnimations).find(k => k.match(pat))
			if (!m) {
				ui.notifications.warn(
					"Unknown light animation '" + type + "'.  Expected: " + Object.keys(CONFIG.Canvas.lightAnimations).join(', ')
				)
				return
			}
			type = m
		}
		let anim = {
			type: type,
			speed: parseFloat(this.match.groups.speed) || 1,
			intensity: parseFloat(this.match.groups.intensity) || 1,
		}
		let data = {
			light: {
				dim: 0,
				bright: 0,
				angle: 360,
				animation: anim,
			},
		}

		if (this.match.groups.off) {
			data.light['-=color'] = null
		} else {
			if (this.match.groups.color) data.light.color = this.match.groups.color
			if (this.match.groups.colorint) data.light.alpha = parseFloat(this.match.groups.colorint)
			data.light.dim = parseFloat(this.match.groups.dim || 0)
			data.light.bright = parseFloat(this.match.groups.bright || 0)
			data.light.angle = parseFloat(this.match.groups.angle || 360)
		}
		console.log('Token Light update: ' + GURPS.objToString(data))
		for (const t of canvas.tokens.controlled) await t.document.update(data)
		this.priv(line)
	}
}

class ShowChatProcessor extends ChatProcessor {
	isGMOnly() {
		return true
	}

	help() {
		return '/show (/showa) &lt;skills or attributes&gt'
	}

	matches(line) {
		this.match = line.match(/^\/(show|sh) (.*)/i)
		return !!this.match
	}

	usagematches(line) {
		return line.match(/^[\/\?](show|sh)$/i)
	}
	usage() {
		return i18n('GURPS.chatHelpShow')
	}

	async process(line) {
		let args = splitArgs(this.match[2])
		this.priv(line)
		let alpha = false
		let pc = false
		let npc = false
		while (args[0].startsWith('-')) {
			if (args[0] == '-a') alpha = true
			if (args[0] == '-pc') pc = true
			if (args[0] == '-npc') npc = true
			args.shift()
		}
		for (const orig of args) {
			this.priv('<hr>')
			if (orig.toLowerCase() == 'move') this.priv('<b>Basic Move / Current Move</b>')
			if (orig.toLowerCase() == 'speed') this.priv('<b>Basic Speed</b>')
			if (orig.toLowerCase() == 'hp') this.priv('<b>Hit Points: Current / Max</b>')
			if (orig.toLowerCase() == 'fp') this.priv('<b>Fatigue Points: Current / Max</b>')
			let output = []
			for (const token of canvas.tokens.placeables) {
				let arg = orig
				let actor = token.actor
				let skip = (npc && actor.hasPlayerOwner) || (pc && !actor.hasPlayerOwner)
				if (!skip) {
					switch (orig.toLowerCase()) {
						case 'hp':
							output.push({
								value: actor.data.data.HP.value,
								text: `${actor.name}: ${actor.data.data.HP.value} / ${actor.data.data.HP.max}`,
								name: actor.name,
							})
							continue
						case 'fp':
							output.push({
								value: actor.data.data.FP.value,
								text: `${actor.name}: ${actor.data.data.FP.value} / ${actor.data.data.FP.max}`,
								name: actor.name,
							})
							continue
						case 'move':
							output.push({
								value: actor.data.data.currentmove,
								text: `${actor.name}: ${actor.data.data.basicmove.value} / ${actor.data.data.currentmove}`,
								name: actor.name,
							})
							continue
						case 'speed':
							output.push({
								value: actor.data.data.basicspeed.value,
								text: `${actor.name}: ${actor.data.data.basicspeed.value}`,
								name: actor.name,
							})
							continue
						case 'fright':
							arg = 'frightcheck'
							break
					}
					if (!GURPS.PARSELINK_MAPPINGS[arg.toUpperCase()]) {
						if (arg.includes(' ')) arg = '"' + arg + '"'
						arg = 'S:' + arg
					}
					let action = parselink(arg)
					if (!!action.action) {
						action.action.calcOnly = true
						let ret = await GURPS.performAction(action.action, actor)
						if (!!ret.target) {
							let lbl = `["${ret.thing} (${ret.target}) : ${actor.name}"!/sel ${token.id}\\\\/r [${arg}]]`
							output.push({ value: ret.target, text: lbl, name: actor.name })
							//this.priv(lbl)
						}
					}
				}
			}
			let sortfunc = (a, b) => {
				return a.value < b.value ? 1 : -1
			}
			if (alpha)
				sortfunc = (a, b) => {
					return a.name > b.name ? 1 : -1
				}
			output.sort(sortfunc).forEach(e => this.priv(e.text))
		}
	}
}

class DevChatProcessor extends ChatProcessor {
	isGMOnly() {
		return true
	}

	help() {
		return null
	}

	matches(line) {
		this.match = line.match(/^\/dev +(.*)/i)
		return !!this.match
	}
	async process(line) {
		let m = this.match[1].match(/(\w+)(.*)/)
		switch (m[1]) {
			case 'open': {
				// Open the full character sheet for an Actor
				let a = game.actors.getName(m[2].trim())
				if (a) a.openSheet('gurps.GurpsActorSheet')
				else ui.notifications.warn("Can't find Actor named '" + m[2] + "'")
				break
			}
			case 'clear': {
				// flush the chat log without confirming
				game.messages.documentClass.deleteDocuments([], { deleteAll: true })
				break
			}
		}
	}
}

class ManeuverChatProcessor extends ChatProcessor {
	help() {
		return '/man &lt;maneuver&gt'
	}

	matches(line) {
		this.match = line.match(/^\/(maneuver|man) *(.*)/i)
		return !!this.match
	}

	async process(line) {
		if (!this.match[2]) {
			this.priv(i18n('GURPS.chatHelpManeuver'))
			Object.values(Maneuvers.getAll())
				.map(e => i18n(e.data.label))
				.forEach(e => this.priv(e))
			return true
		}
		if (!game.combat) {
			ui.notifications.warn(i18n('GURPS.chatNotInCombat'))
			return false
		}
		let r = makeRegexPatternFrom(this.match[2].toLowerCase(), false)
		let m = Object.values(Maneuvers.getAll()).find(e => i18n(e.data.label).toLowerCase().match(r))
		if (!GURPS.LastActor) {
			ui.notifications.warn(i18n('GURPS.chatYouMustHaveACharacterSelected'))
			return false
		}
		if (!m) {
			ui.notifications.warn(i18n('GURPS.chatUnableToFindManeuver') + " '" + this.match[2] + "'")
			return false
		}
		GURPS.LastActor.replaceManeuver(m._data.name)
		return true
	}
}

class RepeatChatProcessor extends ChatProcessor {
	help() {
		return '/repeat &lt;anim command&gt'
	}

	matches(line) {
		this.match = line.match(/^\/(repeat|rpt) +([\d\.]+) *(.*)/i)
		return !!this.match
	}

	usagematches(line) {
		return line.match(/^\/(repeat|rpt)/i)
	}
	usage() {
		return i18n('GURPS.chatHelpRepeat')
	}

	async process(line) {
		if (!GURPS.LastActor) {
			ui.notifications.warn(i18n('GURPS.chatYouMustHaveACharacterSelected'))
			return false
		}
		this.repeatLoop(GURPS.LastActor, this.match[3].trim(), this.match[2]) // We are purposefully NOT waiting for this method, so that it can continue in the background
	}
	async repeatLoop(actor, anim, delay) {
		if (delay < 20) delay = delay * 1000
		const t = canvas.tokens.placeables.find(e => e.actor == actor)
		if (!t) {
			ui.notifications.warn("/repeat only works on 'linked' actors, " + actor.name)
			return false
		}
		actor.RepeatAnimation = true
		while (actor.RepeatAnimation) {
			let p = {
				x: t.position.x + t.w / 2,
				y: t.position.y + t.h / 2,
			}
			let s = anim + ' @' + p.x + ',' + p.y
			await GURPS.executeOTF(s)
			await GURPS.wait(delay)
		}
		ui.notifications.info('Stopped annimation for ' + actor.name)
	}
}

class StopChatProcessor extends ChatProcessor {
	help() {
		return '/stop'
	}

	matches(line) {
		this.match = line.match(/^\/stop/i)
		return !!this.match
	}

	async process(line) {
		if (!GURPS.LastActor) {
			ui.notifications.warn(i18n('GURPS.chatYouMustHaveACharacterSelected'))
			return false
		}
		GURPS.LastActor.RepeatAnimation = false
	}
}
