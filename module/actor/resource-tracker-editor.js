import { i18n_f } from '../../lib/utilities.js'
export class ResourceTrackerEditor extends Application {
	/**
	 * Create a new Resource Tracker Editor
	 * @param {Tracker} tracker data to update
	 * @param {*} options
	 */
	constructor(tracker, isActor, options = {}) {
		super(options)

		this._tracker = tracker
		this._isActor = isActor
	}

	/**
	 *
	 * @param {*} actor
	 * @param {*} path
	 * @param {*} options
	 */
	static editForActor(actor, path, options) {
		let tracker = getProperty(actor.data.data, path)
		let temp = JSON.stringify(tracker)
		let dialog = new ResourceTrackerEditor(JSON.parse(temp), true, options)
		dialog._updateTracker = async () => {
			let update = {}
			update[`data.${path}`] = dialog._tracker
			actor.update(update)
			dialog.close()
		}
		dialog.render(true)
	}

	/** @override */
	static get defaultOptions() {
		return mergeObject(super.defaultOptions, {
			template: 'systems/gurps/templates/resource-editor-popup.hbs',
			width: 360,
			height: 472,
			popOut: true,
			minimizable: false,
			jQuery: true,
			resizable: false,
			title: game.i18n.localize('GURPS.resourceTrackerEditor'),
		})
	}

	/** @override */
	getData(options) {
		const data = super.getData(options)
		data.tracker = this._tracker
		data.isActor = this._isActor
		return data
	}

	/**
	 * By default, do nothing. Each specific use will need its own update method.
	 * @param {*} html
	 */
	async _updateTracker(html) { }

	/** @override */
	activateListeners(html) {
		super.activateListeners(html)

		html.find('.name input').change(ev => {
			this._tracker.name = ev.currentTarget.value
		})

		html.find('.inputs .alias').change(ev => {
			// change the regex from /(w+)(.*)/ to /([A-Za-z0-9_+-]+)(.*)/ to make sure we recognize pi-, pi+ and pi++
			let alias = ev.currentTarget.value
			if (/^[A-Za-z0-9_+-]+$/.test(alias)) this._tracker.alias = alias
			else {
				ui.notifications.warn(i18n_f('GURPS.resourceInvalidAlias', { alias: alias }))
				ev.currentTarget.value = this._tracker.alias
			}
		})

		html.find('[name="damage-type"]').click(ev => {
			let element = $(ev.currentTarget)
			this._tracker.isDamageType = element.is(':checked')
			this.render(false)
		})

		html.find('[name="enforce-minimum"]').click(ev => {
			let element = $(ev.currentTarget)
			this._tracker.isMinimumEnforced = element.is(':checked')
			this.render(false)
		})

		html.find('[name="enforce-maximum"]').click(ev => {
			let element = $(ev.currentTarget)
			this._tracker.isMaximumEnforced = element.is(':checked')
			this.render(false)
		})

		html.find('[name="damage-tracker"]').click(ev => {
			let element = $(ev.currentTarget)
			this._tracker.isDamageTracker = element.is(':checked')
			this.render(false)
		})

		html.find('.inputs .current').change(ev => {
			this._tracker.value = parseInt(ev.currentTarget.value)
		})

		html.find('.inputs .minimum').change(ev => {
			this._tracker.min = parseInt(ev.currentTarget.value)
		})

		html.find('.inputs .maximum').change(ev => {
			this._tracker.max = parseInt(ev.currentTarget.value)
		})

		html.find('.inputs .pdf-ref').change(ev => {
			this._tracker.pdf = ev.currentTarget.value
		})

		html.find('#threshold-add').click(() => {
			if (!this._tracker.thresholds) {
				this._tracker.thresholds = []
			}

			this._tracker.thresholds.push({
				comparison: '>',
				operator: '×',
				value: 1,
				condition: game.i18n.localize('GURPS.normal'),
				color: '#FFFFFF',
			})
			this.render(false)
		})

		html.find('[name="delete-threshold"]').click(ev => {
			let index = $(ev.currentTarget).attr('data')
			this._tracker.thresholds.splice(index, 1)
			this.render(false)
		})

		html.find('[name="comparison"]').change(ev => {
			let index = $(ev.currentTarget).attr('data')
			this._tracker.thresholds[index].comparison = ev.currentTarget.value
		})

		html.find('[name="operator"]').change(ev => {
			let index = $(ev.currentTarget).attr('data')
			this._tracker.thresholds[index].operator = ev.currentTarget.value
		})

		html.find('[name="value"]').change(ev => {
			let index = $(ev.currentTarget).attr('data')
			this._tracker.thresholds[index].value = parseFloat(ev.currentTarget.value)
		})

		html.find('[name="condition"]').change(ev => {
			let index = $(ev.currentTarget).attr('data')
			this._tracker.thresholds[index].condition = ev.currentTarget.value
		})

		html.find('[name="color"]').change(ev => {
			let index = $(ev.currentTarget).attr('data')
			this._tracker.thresholds[index].color = ev.currentTarget.value
		})

		html.find('#update').click(() => this._updateTracker())

		html.find('#reset').on('click', ev => {
			this._tracker = {
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
			this.render(false)
		})
	}
}
