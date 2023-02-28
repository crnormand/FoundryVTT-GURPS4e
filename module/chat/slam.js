'use strict'
import ChatProcessor from './chat-processor.js'
import { ChatProcessors } from '../../module/chat.js'
import selectTarget from '../../module/select-target.js'
import { i18n } from '../../lib/utilities.js'
import { SlamCalculator } from './slam-calc.js'

/**
 * Handle the '/slam' command. Must have a selected actor.
 */
export default class SlamChatProcessor extends ChatProcessor {
	static initialize() {
		ChatProcessors.registerProcessor(new SlamChatProcessor())
	}

	constructor() {
		super()
	}

	help() {
		return '/slam'
	}

	matches(line) {
		return line.startsWith('/slam')
	}

	async process(line) {
		let actor = GURPS.LastActor
		if (!actor) {
			ui.notifications.warn(i18n('GURPS.chatYouMustHaveACharacterSelected'))
			return
		}

		// see if there are any targets
		let targets = actor.getOwners().flatMap(u => [...u.targets])

		// try to find the attacker's token
		let attacker = actor.token || canvas.tokens.placeables.find(it => it.actor === actor)

		if (targets.length === 1) SlamCalculatorForm.process(attacker, [...targets][0])
		else if (targets.length > 1) selectTarget().then(target => SlamCalculatorForm.process(attacker, target))
		else SlamCalculatorForm.process(attacker, null)

		this.privateMessage('Opening Slam Calculator')
	}

	privateMessage(text) {
		this.priv(text)
	}
}

class SlamCalculatorForm extends FormApplication {
	static process(actor, target) {
		let calc = new SlamCalculatorForm(actor, target)
		calc.render(true)
	}

	/**
	 * Construct the dialog.
	 * @param {Token} attacker
	 * @param {Token} target
	 * @param {*} options
	 */
	constructor(attacker, target, options = {}) {
		super(options)

		this._attacker = attacker
		this._target = target

		this._calculator = new SlamCalculator()

		this._attackerHp = !!attacker ? attacker.actor.data.data.HP.max : 10
		this._attackerSpeed = !!attacker ? parseInt(attacker.actor.data.data.basicmove.value) : 5

		this._targetHp = !!target ? target.actor.data.data.HP.max : 10
		this._targetSpeed = 0

		this._isAoAStrong = false
		this._shieldDB = 0
	}

	/** @override */
	static get defaultOptions() {
		return mergeObject(super.defaultOptions, {
			template: 'systems/gurps/templates/slam-calculator.html',
			popOut: true,
			minimizable: false,
			jQuery: true,
			resizable: false,
			title: game.i18n.localize('GURPS.slamCalculator'),
		})
	}

	getData(options) {
		const data = super.getData(options)

		data.attackerToken = this._attacker
		data.targetToken = this._target || { name: i18n('GURPS.target') }
		data.isRealTarget = !!this._target

		data.attackerHp = this._attackerHp
		data.attackerSpeed = this._attackerSpeed

		data.targetHp = this._targetHp
		data.targetSpeed = this._targetSpeed

		data.relativeSpeed = this.relativeSpeed

		data.isAoAStrong = this._isAoAStrong
		data.shieldDB = this._shieldDB

		return data
	}

	get relativeSpeed() {
		return this._attackerSpeed + this._targetSpeed
	}

	_updateObject(event) {
		this._calculator.process(this.getData())
	}

	/** @override */
	activateListeners(html) {
		super.activateListeners(html)

		html.find('#aoa').click(ev => {
			this._isAoAStrong = $(ev.currentTarget).is(':checked')
		})

		html.find('#db').change(ev => {
			this._shieldDB = parseInt(ev.currentTarget.value)
		})

		html.find('#attacker-speed').change(ev => {
			this._attackerSpeed = parseInt(ev.currentTarget.value)
			this.render(false)
		})

		html.find('#target-speed').change(ev => {
			this._targetSpeed = parseInt(ev.currentTarget.value)
			this.render(false)
		})

		html.find('#attacker-hp').change(ev => {
			this._attackerHp = parseInt(ev.currentTarget.value)
		})

		html.find('#target-hp').change(ev => {
			this._targetHp = parseInt(ev.currentTarget.value)
		})
	}
}
