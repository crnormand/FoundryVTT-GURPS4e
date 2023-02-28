import { arrayToObject, atou, i18n, i18n_f, objectToArray, zeroFill } from '../../lib/utilities.js'
import { HitLocation, hitlocationDictionary } from '../hitlocation/hitlocation.js'
import { parselink } from '../../lib/parselink.js'
import * as CI from '../injury/domain/ConditionalInjury.js'
import * as settings from '../../lib/miscellaneous-settings.js'
import { ResourceTrackerEditor } from './resource-tracker-editor.js'
import { ResourceTrackerManager } from './resource-tracker-manager.js'
import GurpsWiring from '../gurps-wiring.js'
import { isConfigurationAllowed } from '../game-utils.js'
import GurpsActiveEffectListSheet from '../effects/active-effect-list.js'
import MoveModeEditor from './move-mode-editor.js'
import { Advantage, Equipment, Melee, Modifier, Note, Ranged, Reaction, Skill, Spell } from './actor-components.js'
import SplitDREditor from './splitdr-editor.js'

/**
 * Extend the basic ActorSheet with some very simple modifications
 * @extends {ActorSheet}
 */
export class GurpsActorSheet extends ActorSheet {
	/** @override */
	static get defaultOptions() {
		return mergeObject(super.defaultOptions, {
			classes: ['gurps', 'sheet', 'actor'],
			width: 800,
			height: 800,
			tabs: [{ navSelector: '.gurps-sheet-tabs', contentSelector: '.sheet-body', initial: 'description' }],
			scrollY: [
				'.gurpsactorsheet #advantages #reactions #melee #ranged #skills #spells #equipmentcarried #equipmentother #notes',
			],
			dragDrop: [{ dragSelector: '.item-list .item', dropSelector: null }],
		})
	}

	/* -------------------------------------------- */

	/** @override */
	get template() {
		if (!game.user.isGM && this.actor.limited) return 'systems/gurps/templates/actor/actor-sheet-gcs-limited.hbs'
		return 'systems/gurps/templates/actor/actor-sheet-gcs.hbs'
	}

	/* -------------------------------------------- */

	async close(options = {}) {
		await super.close(options)
		GURPS.ClearLastActor(this.actor)
	}

	// Hack to keep sheet from flashing during multiple DB updates
	async _render(...args) {
		//console.log("IgnoreRender: " + this.object?.ignoreRender)
		if (!!this.object?.ignoreRender) return
		await super._render(...args)
	}

	update(data, options) {
		super.update(data, options)
	}

	/** @override */
	getData() {
		const sheetData = super.getData()
		sheetData.olddata = sheetData.data
		sheetData.data = this.actor.data.data
		sheetData.system = this.actor.data.data
		sheetData.ranges = GURPS.rangeObject.ranges
		sheetData.useCI = GURPS.ConditionalInjury.isInUse()
		sheetData.conditionalEffectsTable = GURPS.ConditionalInjury.conditionalEffectsTable()
		GURPS.SetLastActor(this.actor)
		sheetData.eqtsummary = this.actor.data.data.eqtsummary
		sheetData.navigateVisible = game.settings.get(settings.SYSTEM_NAME, settings.SETTING_SHOW_SHEET_NAVIGATION)
		sheetData.isGM = game.user.isGM
		sheetData._id = sheetData.olddata._id
		sheetData.effects = this.actor.getEmbeddedCollection('ActiveEffect').contents
		sheetData.useQN = game.settings.get(settings.SYSTEM_NAME, settings.SETTING_USE_QUINTESSENCE)

		return sheetData
	}

	/* -------------------------------------------- */

	/**
	 * @inheritdoc
	 * @param {JQuery<HTMLElement>} html
	 */
	activateListeners(html) {
		super.activateListeners(html)

		html.find('.gurpsactorsheet').click(ev => {
			this._onfocus(ev)
		})

		html
			.parent('.window-content')
			.siblings('.window-header')
			.click(ev => {
				this._onfocus(ev)
			})

		// Click on a navigation-link to scroll the sheet to that section.
		html.find('.navigation-link').click(this._onNavigate.bind(this))

		// Enable some fields to be a targeted roll without an OTF.
		html.find('.rollable').click(this._onClickRoll.bind(this))

		// Wire events to all OTFs on the sheet.
		GurpsWiring.hookupAllEvents(html)

		// Allow OTFs on this actor sheet to be draggable.
		html.find('[data-otf]').each((_, li) => {
			li.setAttribute('draggable', true)
			li.addEventListener('dragstart', ev => {
				let display = ''
				if (!!ev.currentTarget.dataset.action) display = ev.currentTarget.innerText
				return ev.dataTransfer.setData(
					'text/plain',
					JSON.stringify({
						otf: li.getAttribute('data-otf'),
						actor: this.actor.id,
						encodedAction: ev.currentTarget.dataset.action,
						displayname: display,
					})
				)
			})
		})

		// open the split DR dialog
		html.find('.dr button[data-key]').on('click', this._onClickSplit.bind(this))

		if (!isConfigurationAllowed(this.actor)) return // Only allow "owners" to be able to edit the sheet, but anyone can roll from the sheet

		this._createHeaderMenus(html)
		this._createEquipmentItemMenus(html)

		// if not doing automatic encumbrance calculations, allow a click on the Encumbrance table to set the current value.
		if (!game.settings.get(settings.SYSTEM_NAME, settings.SETTING_AUTOMATIC_ENCUMBRANCE)) {
			html.find('.enc').click(this._onClickEnc.bind(this))
		}

		// allow items in these lists to be draggable
		// TODO provide feedback about where the cursor is and whether you can drop it there.
		this.makelistdrag(html, '.condmoddraggable', 'condmod')
		this.makelistdrag(html, '.reactdraggable', 'reactions')
		this.makelistdrag(html, '.eqtdraggable', 'equipment')
		this.makelistdrag(html, '.adsdraggable', 'ads')
		this.makelistdrag(html, '.skldraggable', 'skills')
		this.makelistdrag(html, '.spldraggable', 'spells')
		this.makelistdrag(html, '.notedraggable', 'note')
		this.makelistdrag(html, '.meleedraggable', 'melee')
		this.makelistdrag(html, '.rangeddraggable', 'ranged')

		html.find('[data-operation="share-portrait"]').click(ev => {
			ev.preventDefault()
			let image = this.actor.data.data.fullimage ?? this.actor.img
			const ip = new ImagePopout(image, {
				title: this.actor.name,
				shareable: true,
				entity: this.actor,
			})

			// Display the image popout
			ip.render(true)
		})

		// Stop ENTER key in a Resource Tracker (HP, FP, others) from doing anything.
		// This prevents the inadvertant triggering of the inc/dec buttons.
		html.find('.spinner details summary input').keypress(ev => {
			if (ev.key === 'Enter') ev.preventDefault()
		})

		// Handle resource tracker "+" button.
		html.find('button[data-operation="resource-inc"]').click(async ev => {
			ev.preventDefault()
			let parent = $(ev.currentTarget).closest('[data-gurps-resource]')
			let path = parent.attr('data-gurps-resource')

			let tracker = getProperty(this.actor.data.data, path)
			let value = (+tracker.value || 0) + (ev.shiftKey ? 5 : 1)
			if (isNaN(value)) value = tracker.max || 0

			let json = `{ "data.${path}.value": ${value} }`
			this.actor.update(JSON.parse(json))
		})

		// Handle resource tracker "-" button.
		html.find('button[data-operation="resource-dec"]').click(ev => {
			ev.preventDefault()
			let parent = $(ev.currentTarget).closest('[data-gurps-resource]')
			let path = parent.attr('data-gurps-resource')

			let tracker = getProperty(this.actor.data.data, path)
			let value = (tracker.value || 0) - (ev.shiftKey ? 5 : 1)
			if (isNaN(value)) value = tracker.max || 0

			let json = `{ "data.${path}.value": ${value} }`
			this.actor.update(JSON.parse(json))
		})

		// Handle resource tracker "reset" button.
		html.find('button[data-operation="resource-reset"]').click(ev => {
			ev.preventDefault()
			let parent = $(ev.currentTarget).closest('[data-gurps-resource]')
			let path = parent.attr('data-gurps-resource')

			let tracker = getProperty(this.actor.data.data, path)
			let value = !!tracker.isDamageTracker ? tracker.min || 0 : tracker.max || 0

			let json = `{ "data.${path}.value": ${value} }`
			this.actor.update(JSON.parse(json))
		})

		// allow a click on the 'edit' icon to open the resource tracker editor.
		html.find('.tracked-resource .header.with-editor').click(this.editTracker.bind(this))

		// START CONDITIONAL INJURY

		const formatCIEmpty = val => (val === null ? '' : val)

		const updateActorWithChangedSeverity = changedSeverity => {
			console.log('updateActorWithChangedSeverity')
			this.actor.update({
				'data.conditionalinjury.injury.severity': formatCIEmpty(changedSeverity),
				'data.conditionalinjury.injury.daystoheal': formatCIEmpty(CI.daysToHealForSeverity(changedSeverity)),
			})
		}

		html.find('button[data-operation="ci-severity-inc"]').click(async ev => {
			ev.preventDefault()
			updateActorWithChangedSeverity(CI.incrementSeverity(this.actor.data.data.conditionalinjury.injury.severity))
		})

		html.find('button[data-operation="ci-severity-dec"]').click(ev => {
			ev.preventDefault()
			updateActorWithChangedSeverity(CI.decrementSeverity(this.actor.data.data.conditionalinjury.injury.severity))
		})

		const updateActorWithChangedDaysToHeal = changedDaysToHeal => {
			console.log('updateActorWithChangedDaysToHeal')
			this.actor.update({
				'data.conditionalinjury.injury.severity': formatCIEmpty(CI.severityForDaysToHeal(changedDaysToHeal)),
				'data.conditionalinjury.injury.daystoheal': formatCIEmpty(changedDaysToHeal),
			})
		}

		html.find('button[data-operation="ci-days-inc"]').click(async ev => {
			ev.preventDefault()
			updateActorWithChangedDaysToHeal(
				CI.incrementDaysToHeal(this.actor.data.data.conditionalinjury.injury.daystoheal, ev.shiftKey ? 5 : 1)
			)
		})

		html.find('button[data-operation="ci-days-dec"]').click(ev => {
			ev.preventDefault()
			updateActorWithChangedDaysToHeal(
				CI.decrementDaysToHeal(this.actor.data.data.conditionalinjury.injury.daystoheal, ev.shiftKey ? 5 : 1)
			)
		})

		html.find('button[data-operation="ci-reset"]').click(ev => {
			ev.preventDefault()
			updateActorWithChangedSeverity(null)
		})

		html.find('input[data-operation="ci-severity-set"]').change(ev => {
			ev.preventDefault()
			console.log('change severity', ev.target.value)
			updateActorWithChangedSeverity(CI.setSeverity(ev.target.value))
		})

		// TODO after this event resolves, the severity field briefly flashes with the correct value but then reverts to what was there before the change
		html.find('input[data-operation="ci-days-set"]').change(ev => {
			ev.preventDefault()
			console.log('change days', ev.target.value)
			updateActorWithChangedDaysToHeal(CI.setDaysToHeal(ev.target.value))
		})

		// END CONDITIONAL INJURY

		// If using the "enhanced" inputs for trackers, enable the ribbon popup.
		if (game.settings.get(settings.SYSTEM_NAME, settings.SETTING_ENHANCED_INPUT)) {
			// On Focus, initialize the ribbon popup and show it.
			html.find('.spinner details summary input').focus(ev => {
				let details = ev.currentTarget.closest('details')

				if (!details.open) {
					let parent = ev.currentTarget.closest('[data-gurps-resource]')
					let path = $(parent).attr('data-gurps-resource')
					let tracker = getProperty(this.actor.data.data, path)

					let restoreButton = $(details).find('button.restore')
					restoreButton.attr('data-value', `${tracker.value}`)
					restoreButton.text(tracker.value)
				}
				details.open = true
			})

			// Update the actor's data, set the restore button to the new value,
			// and close the popup.
			html.find('.spinner details summary input').focusout(ev => {
				ev.preventDefault()
				// set the restore button to the new value of the input field
				let details = ev.currentTarget.closest('details')
				let input = $(details).find('input')
				let newValue = input.val()

				let restoreButton = $(details).find('button.restore')
				restoreButton.attr('data-value', newValue)
				restoreButton.text(newValue)

				// update the actor's data to newValue
				let parent = ev.currentTarget.closest('[data-gurps-resource]')
				let path = $(parent).attr('data-gurps-resource')
				let value = parseInt(newValue)
				let json = `{ "data.${path}.value": ${value} }`
				this.actor.update(JSON.parse(json))

				details.open = false
			})

			// Prevent the popup from closing on a click.
			html.find('.spinner details .popup > *').mousedown(ev => {
				ev.preventDefault()
			})

			// On a click of the enhanced input popup, update the text input field, but do not update the actor's data.
			html.find('button[data-operation="resource-update"]').click(ev => {
				let dataValue = $(ev.currentTarget).attr('data-value')
				let details = $(ev.currentTarget).closest('details')
				let input = $(details).find('input')
				let value = parseInt(input.val())

				if (dataValue.charAt(0) === '-' || dataValue.charAt(0) === '+') {
					value += parseInt(dataValue)
				} else {
					value = parseInt(dataValue)
				}

				if (!isNaN(value)) {
					input.val(value)
				}
			})
		} // end enhanced input

		// On mouseover any item with the class .tooltip-manager which also has a child (image) of class .tooltippic,
		// display the tooltip in the correct position.
		html.find('.tooltip.gga-manual').mouseover(ev => {
			ev.preventDefault()

			let target = $(ev.currentTarget)
			if (target.hasNoChildren) {
				return
			}

			let tooltip = target.children('.tooltiptext.gga-manual')
			if (tooltip) {
				tooltip.css({ visibility: 'visible' })
			}
			tooltip = target.children('.tooltippic.gga-manual')
			if (tooltip) {
				tooltip.css({ visibility: 'visible' })
			}
		})

		// On mouseout, stop displaying the tooltip.
		html.find('.tooltip.gga-manual').mouseout(ev => {
			ev.preventDefault()
			let target = $(ev.currentTarget)
			if (target.hasNoChildren) {
				return
			}

			let tooltip = target.children('.tooltiptext.gga-manual')
			if (tooltip) {
				tooltip.css({ visibility: 'hidden' })
			}
			tooltip = target.children('.tooltippic.gga-manual')
			if (tooltip) {
				tooltip.css({ visibility: 'hidden' })
			}
		})

		// Equipment ===

		// On clicking the Equip column, toggle the equipped status of the item.
		html.find('.changeequip').click(this._onClickEquip.bind(this))

		// Simple trick, move 'contains' items into 'collapsed' and back. The html doesn't show 'collapsed'.
		html.find('.expandcollapseicon').click(async ev => {
			let actor = this.actor
			let element = ev.currentTarget
			let parent = $(element).closest('[data-key]')
			let path = parent.attr('data-key')
			actor.toggleExpand(path)
		})

		// On double-clicking an item, open its editor.
		html.find('.dblclkedit').dblclick(async ev => {
			ev.preventDefault()
			let parent = $(ev.currentTarget).closest('[data-key]')

			let path = parent[0].dataset.key
			let actor = this.actor
			let obj = duplicate(getProperty(actor, path)) // must dup so difference can be detected when updated
			if (!!obj.itemid) {
				let item = this.actor.items.get(obj.itemid)
				item.editingActor = this.actor
				item.sheet.render(true)
				return
			}

			if (path.includes('equipment')) this.editEquipment(actor, path, obj)
			if (path.includes('melee')) this.editMelee(actor, path, obj)
			if (path.includes('ranged')) this.editRanged(actor, path, obj)
			if (path.includes('ads')) this.editAds(actor, path, obj)
			if (path.includes('skills')) this.editSkills(actor, path, obj)
			if (path.includes('spells')) this.editSpells(actor, path, obj)
			if (path.includes('notes')) this.editNotes(actor, path, obj)
		})

		html.find('.dblclkedit').on('drop', this.handleDblclickeditDrop.bind(this))

		// On clicking equipment quantity increment, increase the amount.
		html.find('button[data-operation="equipment-inc"]').click(async ev => {
			ev.preventDefault()
			let parent = $(ev.currentTarget).closest('[data-key]')
			let path = parent.attr('data-key')
			let eqt = getProperty(this.actor, path)
			let value = parseInt(eqt.count) + (ev.shiftKey ? 5 : 1)
			if (isNaN(value)) value = 0
			await this.actor.updateEqtCount(path, value)
		})

		html.find('button[data-operation="equipment-inc-uses"]').click(async ev => {
			ev.preventDefault()
			let parent = $(ev.currentTarget).closest('[data-key]')
			let path = parent.attr('data-key')
			let eqt = getProperty(this.actor, path)
			let value = parseInt(eqt.uses) + (ev.shiftKey ? 5 : 1)
			if (isNaN(value)) value = eqt.uses
			await this.actor.update({ [path + '.uses']: value })
		})
		html.find('button[data-operation="equipment-dec-uses"]').click(async ev => {
			ev.preventDefault()
			let parent = $(ev.currentTarget).closest('[data-key]')
			let path = parent.attr('data-key')
			let eqt = getProperty(this.actor, path)
			let value = parseInt(eqt.uses) - (ev.shiftKey ? 5 : 1)
			if (isNaN(value)) value = eqt.uses
			if (value < 0) value = 0
			await this.actor.update({ [path + '.uses']: value })
		})

		// On clicking equipment quantity decrement, decrease the amount or remove from list.
		html.find('button[data-operation="equipment-dec"]').click(async ev => {
			ev.preventDefault()
			let parent = $(ev.currentTarget).closest('[data-key]')
			let path = parent.attr('data-key')
			let actor = this.actor
			let eqt = getProperty(actor, path)
			if (eqt.count == 0) {
				await Dialog.confirm({
					title: i18n('GURPS.removeItem'),
					content: i18n_f('GURPS.confirmRemoveItem', { name: eqt.name }, 'Remove {name} from the Equipment List?'),
					yes: () => actor.deleteEquipment(path),
				})
			} else {
				let value = parseInt(eqt.count) - (ev.shiftKey ? 5 : 1)
				if (isNaN(value) || value < 0) value = 0
				await this.actor.updateEqtCount(path, value)
			}
		})

		html.find('.addnoteicon').on('click', this._addNote.bind(this))

		let notesMenuItems = [
			{
				name: 'Edit',
				icon: "<i class='fas fa-edit'></i>",
				callback: e => {
					let path = e[0].dataset.key
					let o = duplicate(GURPS.decode(this.actor, path))
					this.editNotes(this.actor, path, o)
				},
			},
			{
				name: 'Delete',
				icon: "<i class='fas fa-trash'></i>",
				callback: e => {
					GURPS.removeKey(this.actor, e[0].dataset.key)
				},
			},
		]
		new ContextMenu(html, '.notesmenu', notesMenuItems)

		html.find('[data-onethird]').click(ev => {
			let el = ev.currentTarget
			let opt = el.dataset.onethird
			let active = !!this.actor.data.data.conditions[opt]
			this.actor.toggleEffectByName(opt, !active)
		})

		html.find('[data-onethird]').hover(
			function() {
				let opt = $(this).attr('data-onethird')
				let msg = 'Disable&nbsp;' + opt
				if ($(this).hasClass('buttongrey')) msg = 'Enable&nbsp;' + opt
				$(this).append(
					$(
						`<div style='position: absolute;z-index: 1;top: 10px;left: 100%;padding: 5px;width=120px;color:#9f0000;background-color:lightgrey;border: 1px solid grey;border-radius:5px'>${msg}</div>`
					)
				)
			},
			function() {
				$(this).find('div').last().remove()
			}
		)

		html.find('#qnotes').dblclick(ex => {
			let n = this.actor.data.data.additionalresources.qnotes || ''
			n = n.replace(/<br>/g, '\n')
			let actor = this.actor
			new Dialog({
				title: 'Edit Quick Note',
				content: `Enter a Quick Note (a great place to put an On-the-Fly formula!):<br><br><textarea rows="4" id="i">${n}</textarea><br><br>Examples:
        <br>[+1 due to shield]<br>[Dodge +3 retreat]<br>[Dodge +2 Feverish Defense *Cost 1FP]`,
				buttons: {
					save: {
						icon: '<i class="fas fa-save"></i>',
						label: 'Save',
						callback: html => {
							const i = html[0].querySelector('#i')
							actor.update({ 'data.additionalresources.qnotes': i.value.replace(/\n/g, '<br>') })
						},
					},
				},
				render: h => {
					$(h).find('textarea').on('drop', this.dropFoundryLinks)
					$(h).find('input').on('drop', this.dropFoundryLinks)
				},
			}).render(true)
		})

		html.find('#qnotes').on('drop', this.handleQnoteDrop.bind(this))

		html.find('#maneuver').on('change', ev => {
			let target = $(ev.currentTarget)
			this.actor.replaceManeuver(target.val())
		})

		html.find('#posture').on('change', ev => {
			let target = $(ev.currentTarget)
			this.actor.replacePosture(target.val())
		})

		html.find('#move-mode').on('change', ev => {
			let target = $(ev.currentTarget)
			this.actor.setMoveDefault(target.val())
		})

		html.find('#open-modifier-popup').on('click', this._showActiveEffectsListPopup.bind(this))
		html.find('#edit-move-modes').on('click', this._showMoveModeEditorPopup.bind(this))

		html.find('#addFirstResourceTracker').on('click', ev => this._addTracker())
	}

	_createHeaderMenus(html) {
		// add the default menu items for all tables with a headermenu
		let tables = html.find('.headermenu').closest('.gga-table')
		for (const table of tables) {
			let id = `#${table.id}`
			let items = this.getMenuItems(id)
			this._makeHeaderMenu($(table), '.headermenu', items, ClickAndContextMenu)
		}

		let trackermenu = html.find('#combat-trackers')
		this._makeHeaderMenu(
			$(trackermenu[0]),
			'.headermenu',
			[
				{
					name: i18n('GURPS.addTracker'),
					icon: '<i class="fas fa-plus"></i>',
					callback: e => {
						this._addTracker()
					},
				},
			],
			ClickAndContextMenu
		)
	}

	_createEquipmentItemMenus(html) {
		let includeCollapsed = this instanceof GurpsActorEditorSheet

		let opts = [
			this._createMenu(i18n('GURPS.edit'), '<i class="fas fa-edit"></i>', this._editEquipment.bind(this)),
			this._createMenu(
				i18n('GURPS.sortContentsAscending'),
				'<i class="fas fa-sort-amount-down-alt"></i>',
				this._sortContentAscending.bind(this),
				this._isSortable.bind(this, includeCollapsed)
			),
			this._createMenu(
				i18n('GURPS.sortContentsDescending'),
				'<i class="fas fa-sort-amount-down"></i>',
				this._sortContentDescending.bind(this),
				this._isSortable.bind(this, includeCollapsed)
			),
			this._createMenu(i18n('GURPS.delete'), '<i class="fas fa-trash"></i>', this._deleteItem.bind(this)),
		]

		let movedown = this._createMenu(
			i18n('GURPS.moveToOtherEquipment'),
			'<i class="fas fa-level-down-alt"></i>',
			this._moveEquipment.bind(this, 'data.equipment.other')
		)
		new ContextMenu(html, '.equipmenucarried', [movedown, ...opts], { eventName: 'contextmenu' })

		let moveup = this._createMenu(
			i18n('GURPS.moveToCarriedEquipment'),
			'<i class="fas fa-level-up-alt"></i>',
			this._moveEquipment.bind(this, 'data.equipment.carried')
		)
		new ContextMenu(html, '.equipmenuother', [moveup, ...opts], { eventName: 'contextmenu' })
	}

	_editEquipment(target) {
		let path = target[0].dataset.key
		let o = duplicate(GURPS.decode(this.actor, path))
		this.editEquipment(this.actor, path, o)
	}

	_createMenu(label, icon, callback, condition = () => true) {
		return {
			name: label,
			icon: icon,
			callback: callback,
			condition: condition,
		}
	}

	_deleteItem(target) {
		let key = target[0].dataset.key
		if (key.includes('.equipment.')) this.actor.deleteEquipment(key)
		else GURPS.removeKey(this.actor, key)
	}

	_sortContentAscending(target) {
		this._sortContent(target[0].dataset.key, 'contains', false)
		this._sortContent(target[0].dataset.key, 'collapsed', false)
	}

	async _sortContent(parentpath, objkey, reverse) {
		let key = parentpath + '.' + objkey
		let list = getProperty(this.actor, key)
		let t = parentpath + '.-=' + objkey

		await this.actor.update({ [t]: null }) // Delete the whole object

		let sortedobj = {}
		let index = 0
		Object.values(list)
			.sort((a, b) => (reverse ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name)))
			.forEach(o => GURPS.put(sortedobj, o, index++))
		await this.actor.update({ [key]: sortedobj })
	}

	_sortContentDescending(target) {
		this._sortContent(target[0].dataset.key, 'contains', true)
		this._sortContent(target[0].dataset.key, 'collapsed', true)
	}

	_moveEquipment(list, target) {
		let path = target[0].dataset.key
		this.actor.moveEquipment(path, list)
	}

	_hasContents(target) {
		let path = target[0].dataset.key
		let elements = $(target).siblings(`.desc[data-key="${path}.contains"]`)
		return elements.length > 0
	}

	/**
	 *
	 * @param {*} target
	 * @returns true if the object is a container ... ie, it has a non-empty contains collection
	 */
	_isSortable(includeCollapsed, target) {
		let path = target[0].dataset.key
		let x = GURPS.decode(this.actor, path)
		if (x?.contains && Object.keys(x.contains).length > 1) return true
		if (includeCollapsed) return x?.collapsed && Object.keys(x.collapsed).length > 1
		return false
	}

	getMenuItems(elementid) {
		const map = {
			'#ranged': [this.sortAscendingMenu('system.ranged'), this.sortDescendingMenu('system.ranged')],
			'#melee': [this.sortAscendingMenu('system.melee'), this.sortDescendingMenu('system.melee')],
			'#advantages': [this.sortAscendingMenu('system.ads'), this.sortDescendingMenu('system.ads')],
			'#skills': [this.sortAscendingMenu('system.skills'), this.sortDescendingMenu('system.skills')],
			'#spells': [this.sortAscendingMenu('system.spells'), this.sortDescendingMenu('system.spells')],
			'#equipmentcarried': [
				this.addItemMenu(
					i18n('GURPS.equipment'),
					new Equipment(`${i18n('GURPS.equipment')}...`, true),
					'system.equipment.carried'
				),
				this.sortAscendingMenu('system.equipment.carried'),
				this.sortDescendingMenu('system.equipment.carried'),
			],
			'#equipmentother': [
				this.addItemMenu(
					i18n('GURPS.equipment'),
					new Equipment(`${i18n('GURPS.equipment')}...`, true),
					'system.equipment.other'
				),
				this.sortAscendingMenu('system.equipment.other'),
				this.sortDescendingMenu('system.equipment.other'),
			],
		}
		return map[elementid] ?? []
	}

	addItemMenu(name, obj, path) {
		return {
			name: i18n_f('GURPS.editorAddItem', { name: name }, 'Add {name} at the end'),
			icon: '<i class="fas fa-plus"></i>',
			callback: e => {
				let o = GURPS.decode(this.actor, path) || {}
				GURPS.put(o, duplicate(obj))
				this.actor.update({ [path]: o })
			},
		}
	}

	makelistdrag(html, cls, type) {
		html.find(cls).each((i, li) => {
			li.setAttribute('draggable', true)

			li.addEventListener('dragstart', ev => {
				let oldd = ev.dataTransfer.getData('text/plain')
				let eqtkey = ev.currentTarget.dataset.key
				let eqt = getProperty(this.actor, eqtkey) // FYI, may not actually be Equipment

				if (!eqt) return
				if (!!eqt.eqtkey) {
					eqtkey = eqt.eqtkey
					eqt = GURPS.decode(this.actor, eqtkey) // Features added by equipment will point to the equipment
					type = 'equipment'
				}

				var itemData
				if (!!eqt.itemid) {
					itemData = this.actor.items.get(eqt.itemid) // We have to get it now, as the source of the drag, since the target may not be owned by us
					let img = new Image()
					img.src = itemData.img
					const w = 50
					const h = 50
					const preview = DragDrop.createDragImage(img, w, h)
					ev.dataTransfer.setDragImage(preview, 0, 0)
				}

				let newd = {
					actorid: this.actor.id, // may not be useful if this is an unlinked token
					// actor: this.actor, // so send the actor,
					isLinked: !this.actor.isToken,
					type: type,
					key: eqtkey,
					itemid: eqt.itemid,
					itemData: itemData,
				}
				if (!!oldd) mergeObject(newd, JSON.parse(oldd)) // May need to merge in OTF drag info

				let payload = JSON.stringify(newd)
				//console.log(payload)
				return ev.dataTransfer.setData('text/plain', payload)
			})
		})
	}

	async _addNote(event) {
		let parent = $(event.currentTarget).closest('.header')
		let path = parent.attr('data-key')
		let actor = this.actor
		let list = duplicate(getProperty(actor, path))
		let obj = new Note('', true)
		let dlgHtml = await renderTemplate('systems/gurps/templates/note-editor-popup.html', obj)

		let d = new Dialog(
			{
				title: 'Note Editor',
				content: dlgHtml,
				buttons: {
					one: {
						label: 'Create',
						callback: async html => {
							;['notes', 'pageref', 'title'].forEach(a => (obj[a] = html.find(`.${a}`).val()))
							let u = html.find('.save') // Should only find in Note (or equipment)
							if (!!u) obj.save = u.is(':checked')
							GURPS.put(list, obj)
							await actor.update({ [path]: list })
						},
					},
				},
				default: 'one',
			},
			{
				width: 730,
				popOut: true,
				minimizable: false,
				jQuery: true,
			}
		)
		d.render(true)
	}

	async _addTracker(event) {
		this.actor.addTracker()
	}

	handleDblclickeditDrop(ev) {
		let parent = $(ev.currentTarget).closest('[data-key]')
		let path = parent[0].dataset.key
		this.dropFoundryLinks(ev, path + '.notes')
	}

	handleQnoteDrop(ev) {
		this.dropFoundryLinks(ev, 'data.additionalresources.qnotes')
	}

	dropFoundryLinks(ev, modelkey) {
		if (!!ev.originalEvent) ev = ev.originalEvent
		let dragData = JSON.parse(ev.dataTransfer.getData('text/plain'))
		if (!!dragData.uuid) dragData.id = dragData.uuid.split('.').at(-1)
		let add = ''
		var n
		if (dragData.type == 'JournalEntry') {
			n = game.journal.get(dragData.id).name
		}
		if (dragData.type == 'Actor') {
			n = game.actors.get(dragData.id).name
		}
		if (dragData.type == 'RollTable') {
			n = game.tables.get(dragData.id).name
		}
		if (dragData.type == 'Item') {
			n = game.items.get(dragData.id).name
		}
		if (!!n) add = ` [${dragData.type}[${dragData.id}]` + '{' + n + '}]'

		if (!!dragData.otf) {
			let prefix = ''
			if (!!dragData.displayname) {
				let q = '"'
				if (dragData.displayname.includes(q)) q = "'"
				prefix = q + dragData.displayname + q
			}
			add = '[' + prefix + dragData.otf + ']'
		}
		if (!!dragData.bucket) {
			add = '["Modifier Bucket"'
			let sep = ''
			dragData.bucket.forEach(otf => {
				add += sep + '/r [' + otf + ']'
				sep = '\\\\'
			})
			add += ']'
		}

		if (!!add)
			if (!!modelkey) {
				let t = getProperty(this.actor, modelkey) || ''
				this.actor.update({ [modelkey]: t + (t ? ' ' : '') + add })
			} else {
				let t = $(ev.currentTarget).val()
				$(ev.currentTarget).val(t + (t ? ' ' : '') + add)
			}
	}

	/**
	 *
	 * @param {*} ev
	 */
	async editTracker(ev) {
		ev.preventDefault()

		let path = $(ev.currentTarget).closest('[data-gurps-resource]').attr('data-gurps-resource')
		let templates = ResourceTrackerManager.getAllTemplates()
		if (!templates || templates.length == 0) templates = null

		let selectTracker = async function(html) {
			let name = html.find('select option:selected').text().trim()
			let template = templates.find(template => template.tracker.name === name)
			await this.actor.applyTrackerTemplate(path, template)
		}

		// show dialog asking if they want to apply a standard tracker, or edit this tracker
		let buttons = {
			edit: {
				icon: '<i class="fas fa-edit"></i>',
				label: game.i18n.localize('GURPS.resourceEditTracker'),
				callback: () => ResourceTrackerEditor.editForActor(this.actor, path),
			},
			remove: {
				icon: '<i class="fas fa-trash"></i>',
				label: game.i18n.localize('GURPS.resourceDeleteTracker'),
				callback: async () => await this.actor.removeTracker(path),
			},
		}

		if (!!templates) {
			buttons.apply = {
				icon: '<i class="far fa-copy"></i>',
				label: game.i18n.localize('GURPS.resourceCopyTemplate'),
				callback: selectTracker.bind(this),
			}
		}

		let d = new Dialog(
			{
				title: game.i18n.localize('GURPS.resourceUpdateTrackerSlot'),
				content: await renderTemplate('systems/gurps/templates/actor/update-tracker.html', { templates: templates }),
				buttons: buttons,
				default: 'edit',
				templates: templates,
			},
			{ width: 600 }
		)
		d.render(true)
	}

	async _showActiveEffectsListPopup(ev) {
		ev.preventDefault()
		new GurpsActiveEffectListSheet(this.actor).render(true)
	}

	async _showMoveModeEditorPopup(ev) {
		ev.preventDefault()
		new MoveModeEditor(this.actor).render(true)
	}

	async editEquipment(actor, path, obj) {
		// NOTE:  This code is duplicated above.  Haven't refactored yet
		obj.f_count = obj.count // Hack to get around The Furnace's "helpful" Handlebar helper {{count}}
		let dlgHtml = await renderTemplate('systems/gurps/templates/equipment-editor-popup.html', obj)

		let d = new Dialog(
			{
				title: 'Equipment Editor',
				content: dlgHtml,
				buttons: {
					one: {
						label: 'Update',
						callback: async html => {
							;['name', 'uses', 'maxuses', 'techlevel', 'notes', 'pageref'].forEach(
								a => (obj[a] = html.find(`.${a}`).val())
							)
								;['count', 'cost', 'weight'].forEach(a => (obj[a] = parseFloat(html.find(`.${a}`).val())))
							let u = html.find('.save') // Should only find in Note (or equipment)
							if (!!u && obj.save != null) obj.save = u.is(':checked') // only set 'saved' if it was already defined
							let v = html.find('.ignoreImportQty') // Should only find in equipment
							if (!!v) obj.ignoreImportQty = v.is(':checked')
							await actor.update({ [path]: obj })
							await actor.updateParentOf(path, false)
						},
					},
				},
				render: h => {
					$(h).find('textarea').on('drop', this.dropFoundryLinks)
					$(h).find('input').on('drop', this.dropFoundryLinks)
				},
				default: 'one',
			},
			{
				width: 530,
				popOut: true,
				minimizable: false,
				jQuery: true,
			}
		)
		d.render(true)
	}

	async editMelee(actor, path, obj) {
		this.editItem(
			actor,
			path,
			obj,
			'systems/gurps/templates/melee-editor-popup.html',
			'Melee Weapon Editor',
			[
				'name',
				'mode',
				'parry',
				'block',
				'damage',
				'reach',
				'st',
				'notes',
				'import',
				'checkotf',
				'duringotf',
				'passotf',
				'failotf',
			],
			[]
		)
	}

	async editRanged(actor, path, obj) {
		this.editItem(
			actor,
			path,
			obj,
			'systems/gurps/templates/ranged-editor-popup.html',
			'Ranged Weapon Editor',
			[
				'name',
				'mode',
				'range',
				'rof',
				'damage',
				'shots',
				'rcl',
				'st',
				'notes',
				'import',
				'checkotf',
				'duringotf',
				'passotf',
				'failotf',
			],
			['acc', 'bulk']
		)
	}

	async editAds(actor, path, obj) {
		this.editItem(
			actor,
			path,
			obj,
			'systems/gurps/templates/advantage-editor-popup.html',
			'Advantage / Disadvantage / Perk / Quirk Editor',
			['name', 'notes', 'pageref'],
			['points']
		)
	}

	async editSkills(actor, path, obj) {
		this.editItem(
			actor,
			path,
			obj,
			'systems/gurps/templates/skill-editor-popup.html',
			'Skill Editor',
			['name', 'import', 'relativelevel', 'pageref', 'notes', 'checkotf', 'duringotf', 'passotf', 'failotf'],
			['points']
		)
	}

	async editSpells(actor, path, obj) {
		this.editItem(
			actor,
			path,
			obj,
			'systems/gurps/templates/spell-editor-popup.html',
			'Spell Editor',
			[
				'name',
				'import',
				'difficulty',
				'pageref',
				'notes',
				'resist',
				'class',
				'cost',
				'maintain',
				'casttime',
				'duration',
				'college',
				'checkotf',
				'duringotf',
				'passotf',
				'failotf',
			],
			['points']
		)
	}

	async editNotes(actor, path, obj) {
		this.editItem(
			actor,
			path,
			obj,
			'systems/gurps/templates/note-editor-popup.html',
			'Note Editor',
			['pageref', 'notes', 'title'],
			[],
			730
		)
	}

	async editItem(actor, path, obj, html, title, strprops, numprops, width = 560) {
		let dlgHtml = await renderTemplate(html, obj)
		let d = new Dialog(
			{
				title: title,
				content: dlgHtml,
				buttons: {
					one: {
						label: 'Update',
						callback: async html => {
							strprops.forEach(a => (obj[a] = html.find(`.${a}`).val()))
							numprops.forEach(a => (obj[a] = parseFloat(html.find(`.${a}`).val())))

							let u = html.find('.save') // Should only find in Note (or equipment)
							if (!!u) obj.save = u.is(':checked')
							actor.update({ [path]: obj })
						},
					},
				},
				render: h => {
					$(h).find('textarea').on('drop', this.dropFoundryLinks)
					$(h).find('input').on('drop', this.dropFoundryLinks)
				},
			},
			{
				width: width,
				popOut: true,
				minimizable: false,
				jQuery: true,
			}
		)
		d.render(true)
	}

	_makeHeaderMenu(html, cssclass, menuitems, eventname = 'contextmenu') {
		new ContextMenu(html, cssclass, menuitems, { eventName: eventname })
	}

	sortAscendingMenu(key) {
		return {
			name: i18n('GURPS.sortAscending'),
			icon: '<i class="fas fa-sort-amount-down-alt"></i>',
			callback: e => this.sortAscending(key),
		}
	}

	sortDescendingMenu(key) {
		return {
			name: i18n('GURPS.sortDescending'),
			icon: '<i class="fas fa-sort-amount-down"></i>',
			callback: e => this.sortDescending(key),
		}
	}

	async sortAscending(key) {
		let i = key.lastIndexOf('.')
		let parentpath = key.substring(0, i)
		let objkey = key.substr(i + 1)
		let object = GURPS.decode(this.actor, key)
		let t = parentpath + '.-=' + objkey
		await this.actor.update({ [t]: null }) // Delete the whole object
		let sortedobj = {}
		let index = 0
		Object.values(object)
			.sort((a, b) => a.name.localeCompare(b.name))
			.forEach(o => GURPS.put(sortedobj, o, index++))
		await this.actor.update({ [key]: sortedobj })
	}

	async sortDescending(key) {
		let i = key.lastIndexOf('.')
		let parentpath = key.substring(0, i)
		let objkey = key.substr(i + 1)
		let object = GURPS.decode(this.actor, key)
		let t = parentpath + '.-=' + objkey
		await this.actor.update({ [t]: null }) // Delete the whole object
		let sortedobj = {}
		let index = 0
		Object.values(object)
			.sort((a, b) => b.name.localeCompare(a.name))
			.forEach(o => GURPS.put(sortedobj, o, index++))
		await this.actor.update({ [key]: sortedobj })
	}

	/* -------------------------------------------- */

	/** @override */
	async _onDrop(event) {
		let dragData = JSON.parse(event.dataTransfer.getData('text/plain'))

		if (dragData.type === 'damageItem') this.actor.handleDamageDrop(dragData.payload)
		if (dragData.type === 'Item') this.actor.handleItemDrop(dragData)

		this.handleDragFor(event, dragData, 'ranged', 'rangeddraggable')
		this.handleDragFor(event, dragData, 'melee', 'meleedraggable')
		this.handleDragFor(event, dragData, 'ads', 'adsdraggable')
		this.handleDragFor(event, dragData, 'skills', 'skldraggable')
		this.handleDragFor(event, dragData, 'spells', 'spldraggable')
		this.handleDragFor(event, dragData, 'note', 'notedraggable')
		this.handleDragFor(event, dragData, 'reactions', 'reactdraggable')
		this.handleDragFor(event, dragData, 'condmod', 'condmoddraggable')

		if (dragData.type === 'equipment') {
			if ((await this.actor.handleEquipmentDrop(dragData)) != false) return // handle external drag/drop

			// drag/drop in same character sheet
			// Validate that the target is valid for the drop.
			let dropTargetElements = $(event.target).closest('.eqtdraggable, .eqtdragtarget')
			if (dropTargetElements?.length === 0) return

			// Get the target element.
			let dropTarget = dropTargetElements[0]

			let targetkey = dropTarget.dataset.key
			if (!!targetkey) {
				let srckey = dragData.key
				this.actor.moveEquipment(srckey, targetkey, event.shiftKey)
			}
		}
	}

	// Non-equipment list drags
	async handleDragFor(event, dragData, type, cls) {
		if (dragData.type === type) {
			// Validate that the target is valid for the drop.
			let dropTargetElements = $(event.target).closest(`.${cls}`)
			if (dropTargetElements?.length === 0) return

			// Get the target element.
			let dropTarget = dropTargetElements[0]

			// Dropping an item into a container that already contains it does nothing; tell the user and bail.
			let targetkey = dropTarget.dataset.key
			if (!!targetkey) {
				let sourceKey = dragData.key
				if (sourceKey.includes(targetkey) || targetkey.includes(sourceKey)) {
					ui.notifications.error(i18n('GURPS.dragSameContainer'))
					return
				}

				let object = GURPS.decode(this.actor, sourceKey)

				// Because we may be modifing the same list, we have to check the order of the keys and
				// apply the operation that occurs later in the list, first (to keep the indexes the same).
				let sourceTermsArray = sourceKey.split('.')
				sourceTermsArray.splice(0, 2) // Remove the first two elements: data.xxxx
				let targetTermsArray = targetkey.split('.')
				targetTermsArray.splice(0, 2)
				let max = Math.min(sourceTermsArray.length, targetTermsArray.length)

				let isSrcFirst = false
				for (let i = 0; i < max; i++) {
					// Could be a term like parseInt('contains') < parseInt('contains'), which in typical JS jankiness, reduces
					// to NaN < NaN, which is false.
					if (parseInt(sourceTermsArray[i]) < parseInt(targetTermsArray[i])) {
						isSrcFirst = true
						break
					}
				}

				let d = new Dialog({
					title: object.name,
					content: `<p>${i18n('GURPS.dropResolve')}</p>`,
					buttons: {
						one: {
							icon: '<i class="fas fa-level-up-alt"></i>',
							label: `${i18n('GURPS.dropBefore')}`,
							callback: async () => {
								if (!isSrcFirst) {
									await this._removeKey(sourceKey)
									await this._insertBeforeKey(targetkey, object)
								} else {
									await this._insertBeforeKey(targetkey, object)
									await this._removeKey(sourceKey)
								}
							},
						},
						two: {
							icon: '<i class="fas fa-sign-in-alt"></i>',
							label: `${i18n('GURPS.dropInside')}`,
							callback: async () => {
								let key = targetkey + '.contains.' + zeroFill(0)
								if (!isSrcFirst) {
									await this._removeKey(sourceKey)
									await this._insertBeforeKey(key, object)
								} else {
									await this._insertBeforeKey(key, object)
									await this._removeKey(sourceKey)
								}
							},
						},
					},
					default: 'one',
				})
				d.render(true)
			}
		}
	}

	async _insertBeforeKey(targetKey, element) {
		// target key is the whole path, like 'data.melee.00001'
		let components = targetKey.split('.')

		let index = parseInt(components.pop())
		let path = components.join('.')

		let object = GURPS.decode(this.actor, path)
		let array = objectToArray(object)

		// Delete the whole object.
		let last = components.pop()
		let t = `${components.join('.')}.-=${last}`
		await this.actor.internalUpdate({ [t]: null })

		// Insert the element into the array.
		array.splice(index, 0, element)

		// Convert back to an object
		object = arrayToObject(array, 5)

		// update the actor
		await this.actor.internalUpdate({ [path]: object }, { diff: false })
	}

	async _removeKey(sourceKey) {
		// source key is the whole path, like 'data.melee.00001'
		let components = sourceKey.split('.')

		let index = parseInt(components.pop())
		let path = components.join('.')

		let object = GURPS.decode(this.actor, path)
		let array = objectToArray(object)

		// Delete the whole object.
		let last = components.pop()
		let t = `${components.join('.')}.-=${last}`
		await this.actor.internalUpdate({ [t]: null })

		// Remove the element from the array
		array.splice(index, 1)

		// Convert back to an object
		object = arrayToObject(array, 5)

		// update the actor
		await this.actor.internalUpdate({ [path]: object }, { diff: false })
	}

	_onfocus(ev) {
		ev.preventDefault()
		GURPS.SetLastActor(this.actor)
	}

	/** @override */
	setPosition(options = {}) {
		const position = super.setPosition(options)
		const sheetBody = this.element.find('.sheet-body')
		if (!!position.height) {
			const bodyHeight = position.height - 192
			sheetBody.css('height', bodyHeight)
		}
		return position
	}

	get title() {
		const t = this.actor.name
		const sheet = this.actor.getFlag('core', 'sheetClass')
		return sheet === 'gurps.GurpsActorEditorSheet' ? '**** Editing: ' + t + ' ****' : t
	}

	_getHeaderButtons() {
		let buttons = super._getHeaderButtons()

		// Token Configuration
		if (this.options.editable && isConfigurationAllowed(this.actor)) {
			buttons = this.getCustomHeaderButtons().concat(buttons)
		}
		return buttons
	}

	/**
	 * Override this to change the buttons appended to the actor sheet title bar.
	 */
	getCustomHeaderButtons() {
		const sheet = this.actor.getFlag('core', 'sheetClass')
		const isEditor = sheet === 'gurps.GurpsActorEditorSheet'
		const altsheet = game.settings.get(settings.SYSTEM_NAME, settings.SETTING_ALT_SHEET)

		const isFull = sheet === undefined || sheet === 'gurps.GurpsActorSheet'
		let b = [
			{
				label: isFull ? altsheet : 'Full View',
				class: 'toggle',
				icon: 'fas fa-exchange-alt',
				onclick: ev => this._onToggleSheet(ev, altsheet),
			},
		]

		if (!game.settings.get(settings.SYSTEM_NAME, settings.SETTING_BLOCK_IMPORT) || game.user.isTrusted)
			b.push({
				label: 'Import',
				class: 'import',
				icon: 'fas fa-file-import',
				onclick: ev => this._onFileImport(ev),
			})

		if (!isEditor) {
			b.push({
				label: 'Editor',
				class: 'edit',
				icon: 'fas fa-edit',
				onclick: ev => this._onOpenEditor(ev),
			})
		}
		return b
	}

	async _onFileImport(event) {
		event.preventDefault()
		this.actor.importCharacter()
	}

	async _onToggleSheet(event, altsheet) {
		event.preventDefault()
		let newSheet = Object.values(CONFIG.Actor.sheetClasses['character']).filter(s => s.label == altsheet)[0].id

		const original =
			this.actor.getFlag('core', 'sheetClass') ||
			Object.values(CONFIG.Actor.sheetClasses['character']).filter(s => s.default)[0].id
		console.log('original: ' + original)

		if (original != 'gurps.GurpsActorSheet') newSheet = 'gurps.GurpsActorSheet'
		if (event.shiftKey)
			// Hold down the shift key for Simplified
			newSheet = 'gurps.GurpsActorSimplifiedSheet'
		if (game.keyboard.isModifierActive(KeyboardManager.MODIFIER_KEYS.CONTROL))
			// Hold down the Ctrl key (Command on Mac) for Simplified
			newSheet = 'gurps.GurpsActorNpcSheet'

		this.actor.openSheet(newSheet)
	}

	async _onOpenEditor(event) {
		event.preventDefault()
		this.actor.openSheet('gurps.GurpsActorEditorSheet')
	}

	async _onRightClickGurpslink(event) {
		event.preventDefault()
		event.stopImmediatePropagation() // Since this may occur in note or a list (which has its own RMB handler)
		let el = event.currentTarget
		let action = el.dataset.action
		if (!!action) {
			action = JSON.parse(atou(action))
			if (action.type === 'damage' || action.type === 'deriveddamage') {
				GURPS.resolveDamageRoll(event, this.actor, action.orig, action.overridetxt, game.user.isGM, true)
			} else {
				GURPS.whisperOtfToOwner(action.orig, action.overridetxt, event, action, this.actor) // only offer blind rolls for things that can be blind, No need to offer blind roll if it is already blind
			}
		}
	}

	async _onRightClickPdf(event) {
		event.preventDefault()
		let el = event.currentTarget
		GURPS.whisperOtfToOwner('PDF:' + el.innerText, null, event, false, this.actor)
	}

	async _onRightClickGmod(event) {
		event.preventDefault()
		let el = event.currentTarget
		let n = el.dataset.name
		let t = el.innerText
		GURPS.whisperOtfToOwner(t + ' ' + n, null, event, false, this.actor)
	}

	async _onRightClickOtf(event) {
		event.preventDefault()
		let el = event.currentTarget
		let isDamageRoll = el.dataset.hasOwnProperty('damage')
		let otf = event.currentTarget.dataset.otf

		if (isDamageRoll) {
			GURPS.resolveDamageRoll(event, this.actor, otf, null, game.user.isGM)
		} else {
			GURPS.whisperOtfToOwner(event.currentTarget.dataset.otf, null, event, !isDamageRoll, this.actor) // Can't blind roll damages (yet)
		}
	}

	async _onClickRoll(event, targets) {
		GURPS.handleRoll(event, this.actor, { targets: targets })
	}

	async _onClickSplit(event) {
		let element = event.currentTarget
		let key = element.dataset.key
		new SplitDREditor(this.actor, key).render(true)
	}

	async _onNavigate(event) {
		let dataValue = $(event.currentTarget).attr('data-value')
		let windowContent = event.currentTarget.closest('.window-content')
		let target = windowContent.querySelector(`#${dataValue}`)

		// The '33' represents the height of the window title bar + a bit of margin
		// TODO: we should really look this up and use the actual values as found in the DOM.
		windowContent.scrollTop = target.offsetTop - 33

		// add the glowing class to target AND to event.currentTarget, then remove it
		$(target).addClass('glowing')
		$(event.currentTarget).addClass('glowing')

		setTimeout(function() {
			$(target).removeClass('glowing')
			$(event.currentTarget).removeClass('glowing')
		}, 2000)
	}

	async _onClickEnc(ev) {
		ev.preventDefault()
		if (!game.settings.get(settings.SYSTEM_NAME, settings.SETTING_AUTOMATIC_ENCUMBRANCE)) {
			let element = ev.currentTarget
			let key = element.dataset.key
			//////////
			// Check for 'undefined' when clicking on Encumbrance Level 'header'. ~Stevil
			if (key !== undefined) {
				//////////
				let encs = this.actor.data.data.encumbrance
				if (encs[key].current) return // already selected
				for (let enckey in encs) {
					let enc = encs[enckey]
					let t = 'data.encumbrance.' + enckey + '.current'
					if (key === enckey) {
						await this.actor.update({
							[t]: true,
							'data.currentmove': parseInt(enc.move),
							'data.currentdodge': parseInt(enc.dodge),
						})
					} else if (enc.current) {
						await this.actor.update({ [t]: false })
					}
				}
				//////////
			}
			//////////
		} else {
			ui.notifications.warn(
				"You cannot manually change the Encumbrance level. The 'Automatically calculate Encumbrance Level' setting is turned on."
			)
		}
	}

	async _onClickEquip(ev) {
		ev.preventDefault()
		let element = ev.currentTarget
		let key = element.dataset.key
		let eqt = duplicate(GURPS.decode(this.actor, key))
		eqt.equipped = !eqt.equipped
		await this.actor.update({ [key]: eqt })
		await this.actor.updateItemAdditionsBasedOn(eqt, key)
		let p = this.actor.getEquippedParry()
		let b = this.actor.getEquippedBlock()
		await this.actor.update({
			'data.equippedparry': p,
			'data.equippedblock': b,
		})
		this.actor._forceRender()
	}

	deleteItemMenu(obj) {
		return [
			{
				name: 'Delete',
				icon: "<i class='fas fa-trash'></i>",
				callback: e => {
					let key = e[0].dataset.key
					if (key.includes('.equipment.')) this.actor.deleteEquipment(key)
					else GURPS.removeKey(this.actor, key)
				},
			},
		]
	}

	/* -------------------------------------------- */

	/** @override */
	_updateObject(event, formData) {
		return super._updateObject(event, formData)
	}
}

export class GurpsActorTabSheet extends GurpsActorSheet {
	/** @override */
	static get defaultOptions() {
		return mergeObject(super.defaultOptions, {
			classes: ['gurps', 'sheet', 'actor'],
			width: 860,
			height: 600,
			tabs: [{ navSelector: '.gurps-sheet-tabs', contentSelector: '.sheet-body', initial: 'description' }],
			dragDrop: [{ dragSelector: '.item-list .item', dropSelector: null }],
		})
	}

	/* -------------------------------------------- */

	/** @override */
	get template() {
		if (!game.user.isGM && this.actor.limited) return 'systems/gurps/templates/actor/actor-sheet-gcs-limited.hbs'
		return 'systems/gurps/templates/actor/actor-tab-sheet.hbs'
	}
}

export class GurpsActorCombatSheet extends GurpsActorSheet {
	/** @override */
	static get defaultOptions() {
		return mergeObject(super.defaultOptions, {
			classes: ['gurps', 'sheet', 'actor'],
			width: 670,
			height: 'auto',
			tabs: [{ navSelector: '.gurps-sheet-tabs', contentSelector: '.sheet-body', initial: 'description' }],
			dragDrop: [{ dragSelector: '.item-list .item', dropSelector: null }],
		})
	}

	/* -------------------------------------------- */

	/** @override */
	get template() {
		if (!game.user.isGM && this.actor.limited) return 'systems/gurps/templates/actor/actor-sheet-gcs-limited.hbs'
		return 'systems/gurps/templates/actor/combat-sheet.hbs'
	}
}

Hooks.on('getGurpsActorEditorSheetHeaderButtons', sheet => {
	if (sheet.actor.isEmptyActor()) {
		ui.notifications.error('You are editing an EMPTY Actor!')
		setTimeout(
			() =>
				Dialog.prompt({
					title: 'Empty Actor',
					content:
						'You are editing an EMPTY Actor!<br><br>Either use the <b>Import</b> button to enter data, or delete this Actor and use the <b>/mook</b> chat command to create NPCs.<br><br>Press Ok to open the Full View.',
					label: 'Ok',
					callback: async () => {
						sheet.actor.openSheet('gurps.GurpsActorSheet')
					},
					rejectClose: false,
				}),
			500
		)
	}
})

const ClickAndContextMenu = 'click contextmenu'

export class GurpsActorEditorSheet extends GurpsActorSheet {
	/** @override */
	static get defaultOptions() {
		return mergeObject(super.defaultOptions, {
			classes: ['gurps', 'gurpsactorsheet', 'sheet', 'actor'],
			scrollY: [
				'.gurpsactorsheet #advantages #reactions #melee #ranged #skills #spells #equipmentcarried #equipmentother #notes',
			],
			width: 880,
			height: 800,
			tabs: [{ navSelector: '.gurps-sheet-tabs', contentSelector: '.sheet-body', initial: 'description' }],
			dragDrop: [{ dragSelector: '.item-list .item', dropSelector: null }],
		})
	}

	/* -------------------------------------------- */

	/** @override */
	get template() {
		if (!game.user.isGM && this.actor.limited) return 'systems/gurps/templates/actor/actor-sheet-gcs-limited.hbs'
		return 'systems/gurps/templates/actor/actor-sheet-gcs-editor.hbs'
	}

	//TODO: Don't let user change the sheet in case of user having limited access and the sheet is left in editor mode by someone else

	getData() {
		const sheetData = super.getData()
		sheetData.isEditing = true
		return sheetData
	}

	makeDeleteMenu(html, cssclass, obj, eventname = 'contextmenu') {
		new ContextMenu(html, cssclass, this.deleteItemMenu(obj), { eventName: eventname })
	}

	makeHeaderMenu(html, cssclass, name, obj, path, eventname = 'contextmenu') {
		new ContextMenu(html, cssclass, [this.addItemMenu(name, obj, path)], { eventName: eventname })
	}

	activateListeners(html) {
		super.activateListeners(html)
		html.find('textarea').on('drop', this.dropFoundryLinks)
		html.find('input').on('drop', this.dropFoundryLinks)

		html.find('#ignoreinputbodyplan').on('click', this._onClickIgnoreImportBodyPlan.bind(this))
		html.find('label[for="ignoreinputbodyplan"]').on('click', this._onClickIgnoreImportBodyPlan.bind(this))

		html.find('#showflightmove').on('click', this._onClickShowFlightMove.bind(this))
		html.find('label[for="showflightmove"]').on('click', this._onClickShowFlightMove.bind(this))

		html.find('#showflightmove').click(ev => {
			ev.preventDefault()
			let element = ev.currentTarget
			let show = element.checked
			this.actor.update({ 'data.additionalresources.showflightmove': show })
		})

		this.makeDeleteMenu(html, '.hlmenu', new HitLocation('???'), ClickAndContextMenu)
		this.makeDeleteMenu(html, '.reactmenu', new Reaction('+0', '???'), ClickAndContextMenu)
		this.makeDeleteMenu(html, '.condmodmenu', new Modifier('+0', '???'), ClickAndContextMenu)
		this.makeDeleteMenu(html, '.meleemenu', new Melee('???'), ClickAndContextMenu)
		this.makeDeleteMenu(html, '.rangedmenu', new Ranged('???'), 'click context')
		this.makeDeleteMenu(html, '.adsmenu', new Advantage('???'), ClickAndContextMenu)
		this.makeDeleteMenu(html, '.skillmenu', new Skill('???'), ClickAndContextMenu)
		this.makeDeleteMenu(html, '.spellmenu', new Spell('???'), ClickAndContextMenu)
		this.makeDeleteMenu(html, '.notemenu', new Note('???', true), 'contextmenu')

		html.find('#body-plan').change(async e => {
			let bodyplan = e.currentTarget.value
			if (bodyplan !== this.actor.data.data.additionalresources.bodyplan) {
				let hitlocationTable = hitlocationDictionary[bodyplan]
				if (!hitlocationTable) {
					ui.notifications.error(`Unsupported bodyplan value: ${bodyplan}`)
				} else {
					// Try to copy any DR values from hit locations that match
					let hitlocations = {}
					let oldlocations = this.actor.data.data.hitlocations || {}
					let count = 0
					for (let loc in hitlocationTable) {
						let hit = hitlocationTable[loc]
						let originalLoc = Object.values(oldlocations).filter(it => it.where === loc)
						let dr = originalLoc.length === 0 ? 0 : originalLoc[0]?.dr
						let it = new HitLocation(loc, dr, hit.penalty, hit.roll)
						GURPS.put(hitlocations, it, count++)
					}
					this.actor.ignoreRender = true
					await this.actor.update({
						'data.-=hitlocations': null,
						'data.additionalresources.bodyplan': bodyplan,
					})
					await this.actor.update({ 'data.hitlocations': 0 }) // A hack. The delete above doesn't always get rid of the properties, so set it to Zero
					this.actor.ignoreRender = false
					await this.actor.update({ 'data.hitlocations': hitlocations })
				}
			}
		})
	}

	/**
	 * @override
	 * @param {*} elementid
	 * @returns
	 */
	getMenuItems(elementid) {
		// returns an array of menuitems
		let menu = super.getMenuItems(elementid)

		// add any additional items to the menu
		switch (elementid) {
			case '#location':
				return [this.addItemMenu(i18n('GURPS.hitLocation'), new HitLocation('???'), 'data.hitlocations'), ...menu]

			case '#reactions':
				return [
					this.addItemMenu(i18n('GURPS.reaction'), new Reaction('+0', i18n('GURPS.fromEllipses')), 'data.reactions'),
					...menu,
				]

			case '#conditionalmods':
				return [
					this.addItemMenu(
						i18n('GURPS.conditionalModifier'),
						new Modifier('+0', i18n('GURPS.fromEllipses')),
						'data.conditionalmods'
					),
					...menu,
				]

			case '#melee':
				return [
					this.addItemMenu(i18n('GURPS.meleeAttack'), new Ranged(`${i18n('GURPS.meleeAttack')}...`), 'data.melee'),
					...menu,
				]

			case '#ranged':
				return [
					this.addItemMenu(i18n('GURPS.rangedAttack'), new Ranged(`${i18n('GURPS.rangedAttack')}...`), 'data.ranged'),
					...menu,
				]

			case '#advantages':
				return [
					this.addItemMenu(i18n('GURPS.adDisadQuirkPerk'), new Advantage(`${i18n('GURPS.adDisad')}...`), 'data.ads'),
					...menu,
				]

			case '#skills':
				return [this.addItemMenu(i18n('GURPS.skill'), new Skill(`${i18n('GURPS.skill')}...`), 'data.skills'), ...menu]

			case '#spells':
				return [this.addItemMenu(i18n('GURPS.spell'), new Spell(`${i18n('GURPS.spell')}...`), 'data.spells'), ...menu]

			default:
				return menu
		}
	}

	async _onClickIgnoreImportBodyPlan(ev) {
		ev.preventDefault()
		let current = this.actor.data.data.additionalresources.ignoreinputbodyplan
		let ignore = !current
		await this.actor.update({ 'data.additionalresources.ignoreinputbodyplan': ignore })
	}

	async _onClickShowFlightMove(ev) {
		ev.preventDefault()
		let current = this.actor.data.data.additionalresources.showflightmove
		let show = !current
		await this.actor.update({ 'data.additionalresources.showflightmove': show })
	}
}

export class GurpsActorSimplifiedSheet extends GurpsActorSheet {
	/** @override */
	static get defaultOptions() {
		return mergeObject(super.defaultOptions, {
			classes: ['gurps', 'sheet', 'actor'],
			width: 820,
			height: 900,
			tabs: [{ navSelector: '.gurps-sheet-tabs', contentSelector: '.sheet-body', initial: 'description' }],
			dragDrop: [{ dragSelector: '.item-list .item', dropSelector: null }],
		})
	}

	/* -------------------------------------------- */

	/** @override */
	get template() {
		if (!game.user.isGM && this.actor.limited) return 'systems/gurps/templates/actor/actor-sheet-gcs-limited.hbs'
		return 'systems/gurps/templates/simplified.html'
	}

	getData() {
		const data = super.getData()
		data.dodge = this.actor.getCurrentDodge()
		data.defense = this.actor.getTorsoDr()
		return data
	}

	activateListeners(html) {
		super.activateListeners(html)
		html.find('.rollableicon').click(this._onClickRollableIcon.bind(this))
	}

	async _onClickRollableIcon(ev) {
		ev.preventDefault()
		let element = ev.currentTarget
		let val = element.dataset.value
		let parsed = parselink(val)
		GURPS.performAction(parsed.action, this.actor, ev)
	}
}

export class GurpsActorNpcSheet extends GurpsActorSheet {
	/** @override */
	static get defaultOptions() {
		return mergeObject(super.defaultOptions, {
			classes: ['npc-sheet', 'sheet', 'actor'],
			width: 750,
			height: 450,
			dragDrop: [{ dragSelector: '.item-list .item', dropSelector: null }],
		})
	}

	/* -------------------------------------------- */

	/** @override */
	get template() {
		if (!game.user.isGM && this.actor.limited) return 'systems/gurps/templates/actor/actor-sheet-gcs-limited.hbs'
		return 'systems/gurps/templates/actor/npc-sheet-ci.hbs'
	}

	getData() {
		const data = super.getData()
		data.currentdodge = this.actor.data.data.currentdodge
		data.currentmove = this.actor.data.data.currentmove
		data.defense = this.actor.getTorsoDr()
		let p = this.actor.getEquippedParry()
		//    let b = this.actor.getEquippedBlock();      // Don't have a good way to display block yet
		//    if (b > 0)
		//      data.parryblock = p + "/" + b;
		//    else
		data.parryblock = p

		return data
	}

	activateListeners(html) {
		super.activateListeners(html)
		html.find('.npc-sheet').click(ev => {
			this._onfocus(ev)
		})
		html.find('.rollableicon').click(this._onClickRollableIcon.bind(this))
	}

	async _onClickRollableIcon(ev) {
		ev.preventDefault()
		let element = ev.currentTarget
		let val = element.dataset.value
		let parsed = parselink(val)
		GURPS.performAction(parsed.action, this.actor, ev)
	}
}

export class GurpsInventorySheet extends GurpsActorSheet {
	/** @override */
	static get defaultOptions() {
		return mergeObject(super.defaultOptions, {
			classes: ['gurps', 'sheet', 'actor'],
			width: 700,
			height: 400,
			tabs: [],
			scrollY: [],
			dragDrop: [{ dragSelector: 'item-list .item', dropSelector: null }],
		})
	}

	/* -------------------------------------------- */

	/** @override */
	get template() {
		if (!game.user.isGM && this.actor.limited) return 'systems/gurps/templates/actor/actor-sheet-gcs-limited.hbs'
		return 'systems/gurps/templates/inventory-sheet.html'
	}
}
