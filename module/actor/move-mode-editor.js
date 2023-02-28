import { i18n_f } from '../../lib/utilities.js'

export default class MoveModeEditor extends Application {
	constructor(actor, options) {
		super(options)

		this.actor = actor
	}

	static get defaultOptions() {
		return mergeObject(super.defaultOptions, {
			classes: ['sheet'],
			width: 400,
			height: 'auto',
			resizable: false,
		})
	}

	get template() {
		return 'systems/gurps/templates/actor/move-mode-editor.hbs'
	}

	getData() {
		const sheetData = super.getData()
		sheetData.modes = this.actor.data.data.move
		return sheetData
	}

	get title() {
		let name = this.actor?.name || 'UNKNOWN'
		return i18n_f('GURPS.moveModeEditor.Title', { name: name }, 'Movement Modes for {name}')
	}

	activateListeners(html) {
		super.activateListeners(html)

		html.find('.move-mode-control').on('change click keyup', this._onEffectControl.bind(this, html))
	}

	async _onEffectControl(html, event) {
		event.preventDefault()
		const a = event.currentTarget
		const key = a.dataset.key ?? null
		const value = a.value ?? null
		const action = a.dataset.action ?? null

		if (event.type === 'change') this._change(action, key, value, html)
		if (event.type === 'click') this._click(action, key, value, html)
		if (event.type === 'keyup') this._keyup(action, key, event.key, html)
	}

	async _keyup(action, key, value, html) {
		if (action === 'other' && value === 'Escape') {
			html.find(`#expand-contract-${key}`).removeClass('contracted')
			this.render(true)
		}
	}

	/** Since the default move object may not actually be part of the DB,
		  (laissez-faire init), we need to update the full move object. 
	  */
	async _updateMoveData(moveId, attrib, value) {
		let old = this.moveData[moveId]
		old[attrib] = value
		await this.actor.update({ [`data.move.${moveId}`]: old })
	}

	async _change(action, key, value, html) {
		switch (action) {
			// change: action [mode] key [00000] value [Ground]
			case 'mode':
				{
					// if 'other', don't trigger an update ... just display the hidden field
					if (value === 'other') {
						html.find(`#expand-contract-${key}`).removeClass('contracted')
						return
					}

					// hide the field and update the actor
					html.find(`#expand-contract-${key}`).addClass('contracted')
					await this._updateMoveData(key, action, value)
				}
				break

			// change: action [value] key [00000] value [6]
			case 'basic':
				await this._updateMoveData(key, action, value)
				break

			// change: action [value] key [00000] value [6]
			case 'enhanced':
				await this._updateMoveData(key, action, value)
				break

			case 'other':
				html.find(`#expand-contract-${key}`).removeClass('contracted')
				await this._updateMoveData(key, 'mode', value)
				break

			default:
				return
		}
		this.render(true)
	}

	get moveData() {
		return this.actor.data.data.move
	}

	async _click(action, key, value) {
		switch (action) {
			// click:  action [create] key [null] value [null]
			case 'create':
				{
					// copy existing entries
					let move = {}
					for (const k in this.moveData)
						setProperty(move, k, {
							mode: this.moveData[k].mode,
							basic: this.moveData[k].basic,
							enhanced: this.moveData[k].enhanced,
							default: this.moveData[k].default,
						})

					// add a new entry at the end.
					let empty = Object.values(this.moveData).length === 0
					GURPS.put(move, { mode: 'other', basic: 0, default: empty ? true : false })

					// remove existing entries
					await this.actor.update({ 'data.-=move': null })

					// add the new entries
					await this.actor.update({ 'data.move': move })
				}
				break

			// click:  action [default] key [00000] value [on|off]
			case 'default':
				{
					let state = getProperty(this.moveData, `${key}.default`)
					if (getType(state) === 'string') state = state === 'true'

					// only handle changing from false to true
					if (!state) {
						let json = []
						// turn off everything whose key isn't 'k'
						for (const k in this.moveData) json.push(`"data.move.${k}.default": ${key === k}`)
						let text = '{ ' + json.join(',') + ' }'
						await this.actor.update(JSON.parse(text))
					}
				}
				break

			// click:  action [delete] key [00000] value [null]
			case 'delete':
				{
					let move = {}
					// Copy every entry except the one to delete.
					for (const k in this.moveData) {
						if (k !== key)
							GURPS.put(move, {
								mode: this.moveData[k].mode,
								basic: this.moveData[k].basic,
								enhanced: this.moveData[k].enhanced,
								default: this.moveData[k].default,
							})
					}
					// remove existing entries
					await this.actor.update({ 'data.-=move': null })
					// add the new entries
					await this.actor.update({ 'data.move': move })
				}
				break

			default:
				return
		}
		this.render(true)
	}
}
