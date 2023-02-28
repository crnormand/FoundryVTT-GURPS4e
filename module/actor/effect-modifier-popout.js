import GurpsWiring from '../gurps-wiring.js'
import { i18n, i18n_f } from '../../lib/utilities.js'
import { gurpslink } from '../../module/utilities/gurpslink.js'

export class EffectModifierPopout extends Application {
	constructor(token, callback, options = {}) {
		super(options)
		this._token = token
		this._callback = callback
	}

	/** @override */
	static get defaultOptions() {
		return mergeObject(super.defaultOptions, {
			template: 'systems/gurps/templates/actor/effect-modifier-popout.hbs',
			classes: ['sidebar-popout effect-modifiers-app'],
			popOut: true,
			top: 0,
			width: 400,
			height: 'auto',
			minimizable: true,
			jQuery: true,
			resizable: true,
			title: i18n('GURPS.effectModifierPopout', 'Effect Modifiers'),
		})
	}

	/** @override */
	getData(options) {
		return mergeObject(super.getData(options), {
			selected: this.selectedToken,
			selfmodifiers: this._token ? this.convertModifiers(this._token.actor.data.data.conditions.self.modifiers) : [],
			targetmodifiers: this._token ? this.convertModifiers(this._token.actor.data.data.conditions.target.modifiers) : [],
			targets: this.targets,
		})
	}

	get targets() {
		let results = []
		for (const target of Array.from(game.user.targets)) {
			let result = {}
			result.name = target.data.name
			result.targetmodifiers = target.actor
				? this.convertModifiers(target.actor.data.data.conditions.target.modifiers)
				: []
			results.push(result)
		}
		return results
	}

	convertModifiers(list) {
		return list.map(it => `[${i18n(it)}]`).map(it => gurpslink(it))
	}

	get selectedToken() {
		return this._token?.name ?? i18n('GURPS.effectModNoTokenSelected')
	}

	getToken() {
		return this._token
	}

	async setToken(value) {
		this._token = value
		await this.render(false)
	}

	/** @override */
	activateListeners(html) {
		GurpsWiring.hookupAllEvents(html)
		GurpsWiring.hookupGurpsRightClick(html)

		html
			.closest('div.effect-modifiers-app')
			.find('.window-title')
			.text(i18n_f('GURPS.effectModifierPopout', { name: this.selectedToken }, 'Effect Modifiers: {name}'))
	}

	/** @override */
	async close(options) {
		this._callback.close(options)
	}

	async closeApp(options) {
		super.close(options)
	}
}
