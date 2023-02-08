import { CharacterGURPS } from "@actor"
import { HitLocationTable } from "@actor/character/hit_location"
import { FeatureType } from "@feature"
import { ItemSheetGURPS } from "@item/base"
import { AttributeDefObj } from "@module/attribute"
import { CharItemGURPS, ItemGURPS } from "@module/config"
import { gid, NumberComparison, PrereqType, SETTINGS, StringComparison, StudyType, SYSTEM_NAME } from "@module/data"
import { MeleeWeapon, RangedWeapon } from "@module/weapon"
import { WeaponSheet } from "@module/weapon/sheet"
import { i18n, prepareFormData } from "@util"
import { ItemGCS } from "./document"

// @ts-ignore
export class ItemSheetGCS extends ItemSheetGURPS {
	getData(options?: Partial<DocumentSheetOptions<Item>>): any {
		const itemData = this.object.toObject(false)
		const attributes: Record<string, string> = {}
		const locations: Record<string, string> = {}
		const default_attributes = game.settings.get(
			SYSTEM_NAME,
			`${SETTINGS.DEFAULT_ATTRIBUTES}.attributes`
		) as AttributeDefObj[]
		const default_locations = {
			name: game.settings.get(SYSTEM_NAME, `${SETTINGS.DEFAULT_HIT_LOCATIONS}.name`),
			roll: game.settings.get(SYSTEM_NAME, `${SETTINGS.DEFAULT_HIT_LOCATIONS}.roll`),
			locations: game.settings.get(SYSTEM_NAME, `${SETTINGS.DEFAULT_HIT_LOCATIONS}.locations`),
		} as HitLocationTable
		const actor = this.item.actor as unknown as CharacterGURPS
		if (actor) {
			actor.attributes.forEach(e => {
				if (e.attribute_def.type.includes("_separator")) return
				attributes[e.attr_id] = e.attribute_def.name
			})
			for (const e of actor.HitLocations) {
				locations[e.id] = e.choice_name
			}
		} else {
			default_attributes.forEach(e => {
				if (e.type.includes("_separator")) return
				attributes[e.id] = e.name
			})
			default_locations.locations.forEach(e => {
				locations[e.id] = e.choice_name
			})
		}
		attributes.dodge = i18n("gurps.attributes.dodge")
		attributes.parry = i18n("gurps.attributes.parry")
		attributes.block = i18n("gurps.attributes.block")
		const item = this.item as ItemGCS
		const meleeWeapons = [...item.meleeWeapons].map(e => mergeObject(e[1], { index: e[0] }))
		const rangedWeapons = [...item.rangedWeapons].map(e => mergeObject(e[1], { index: e[0] }))

		const sheetData = {
			...super.getData(options),
			...{
				document: item,
				meleeWeapons: meleeWeapons,
				rangedWeapons: rangedWeapons,
				item: itemData,
				system: (itemData as any).system,
				config: CONFIG.GURPS,
				attributes: attributes,
				locations: locations,
				sysPrefix: "array.system.",
				defaultBodyType: default_locations.name,
			},
		}

		return sheetData
	}

	override activateListeners(html: JQuery<HTMLElement>): void {
		super.activateListeners(html)
		ContextMenu.create(this, html, "#melee div", [
			{ name: i18n("gurps.context_menu.new_melee_weapon"), icon: "", callback: () => this._addMelee() },
		])
		ContextMenu.create(this, html, "#ranged div", [
			{ name: i18n("gurps.context_menu.new_ranged_weapon"), icon: "", callback: () => this._addRanged() },
		])

		html.find(".add")
		html.find(".prereq .add-child").on("click", event => this._addPrereqChild(event))
		html.find(".prereq .add-list").on("click", event => this._addPrereqList(event))
		html.find(".prereq .remove").on("click", event => this._removePrereq(event))
		html.find(".prereq .type").on("change", event => this._onPrereqTypeChange(event))
		html.find("#features .add").on("click", event => this._addFeature(event))
		html.find(".feature .remove").on("click", event => this._removeFeature(event))
		html.find(".feature .type").on("change", event => this._onFeatureTypeChange(event))
		html.find("#defaults .add").on("click", event => this._addDefault(event))
		html.find(".default .remove").on("click", event => this._removeDefault(event))
		html.find("#study .add").on("click", event => this._addStudy(event))
		html.find(".study-entry .remove").on("click", event => this._removeStudy(event))
		html.find(".weapon-list > :not(.header)").on("dblclick", event => this._onWeaponEdit(event))
		html.find("textarea")
			.each(function () {
				const height = this.scrollHeight - 2
				this.setAttribute("style", `height:${height}px;`)
			})
			.on("input", function () {
				const height = this.scrollHeight
				// Const height = this.value.split("\r").length * 24;
				this.style.height = "0"
				this.style.height = `${height}px`
			})

		// Html.find("span.input").on("blur", event => this._onSubmit(event as any));
		html.find(".item").on("dblclick", event => this._openItemSheet(event))
	}

	protected _onSubmit(event: Event, context?: any): Promise<Partial<Record<string, unknown>>> {
		return super._onSubmit(event, context)
	}

	private splitArray(s: string): string[] {
		const a: string[] = s.split(",").map(e => e.trim())
		if (a.length === 1 && a[0] === "") return []
		return a
	}

	protected async _updateObject(event: Event, formData: Record<string, any>): Promise<unknown> {
		// FormApplicationGURPS.updateObject(event, formData)
		formData = prepareFormData(event, formData, this.object)
		if (typeof formData["system.tags"] === "string")
			formData["system.tags"] = this.splitArray(formData["system.tags"])
		if (typeof formData["system.college"] === "string")
			formData["system.college"] = this.splitArray(formData["system.college"])
		return super._updateObject(event, formData)
	}

	protected async _addPrereqChild(event: JQuery.ClickEvent): Promise<any> {
		event.preventDefault()
		const path = $(event.currentTarget).data("path").replace("array.", "")
		const prereqs = getProperty(this.item, `${path}.prereqs`)
		prereqs.push({
			type: "trait_prereq",
			name: { compare: StringComparison.Is, qualifier: "" },
			notes: { compare: StringComparison.None, qualifier: "" },
			level: { compare: NumberComparison.AtLeast, qualifier: 0 },
			has: true,
		})
		const formData: any = {}
		formData[`array.${path}.prereqs`] = prereqs
		return this._updateObject(null as unknown as Event, formData)
	}

	protected async _addPrereqList(event: JQuery.ClickEvent): Promise<any> {
		event.preventDefault()
		const path = $(event.currentTarget).data("path").replace("array.", "")
		const prereqs = getProperty(this.item, `${path}.prereqs`)
		prereqs.push({
			type: "prereq_list",
			prereqs: [],
			when_tl: { compare: NumberComparison.None },
		})
		const formData: any = {}
		formData[`array.${path}.prereqs`] = prereqs
		return this._updateObject(null as unknown as Event, formData)
	}

	protected async _removePrereq(event: JQuery.ClickEvent): Promise<any> {
		event.preventDefault()
		let path = $(event.currentTarget).data("path").replace("array.", "")
		const items = path.split(".")
		const index = items.pop()
		path = items.join(".")
		const prereqs = getProperty(this.item, `${path}`)
		prereqs.splice(index, 1)
		const formData: any = {}
		formData[`array.${path}`] = prereqs
		return this._updateObject(null as unknown as Event, formData)
	}

	protected async _onPrereqTypeChange(event: JQuery.ChangeEvent): Promise<any> {
		event.preventDefault()
		const value = event.currentTarget.value
		const PrereqConstructor = CONFIG.GURPS.Prereq.classes[value as PrereqType]
		let path = $(event.currentTarget).data("path").replace("array.", "")
		const items = path.split(".")
		const index = items.pop()
		path = items.join(".")
		const prereqs = getProperty(this.item, `${path}`)
		prereqs[index] = {
			type: value,
			...PrereqConstructor.defaults,
			has: prereqs[index].has,
		}
		const formData: any = {}
		formData[`array.${path}`] = prereqs
		return this._updateObject(null as unknown as Event, formData)
	}

	_addMelee() {
		const weapons = (this.item.system as any).weapons
		const newMelee = new MeleeWeapon({ type: "melee_weapon" })
		weapons.push(newMelee)
		const update: any = {}
		update["system.weapons"] = weapons
		return this.item.update(update)
	}

	_addRanged() {
		const weapons = (this.item.system as any).weapons
		const newRanged = new RangedWeapon({ type: "ranged_weapon" })
		weapons.push(newRanged)
		const update: any = {}
		update["system.weapons"] = weapons
		return this.item.update(update)
	}

	protected async _addFeature(event: JQuery.ClickEvent): Promise<any> {
		event.preventDefault()
		const features = (this.item.system as any).features
		features.push({
			type: FeatureType.AttributeBonus,
			attribute: "st",
			limitation: "none",
			amount: 1,
			per_level: false,
			levels: 0,
		})
		const update: any = {}
		update["system.features"] = features
		return this.item.update(update)
	}

	protected async _removeFeature(event: JQuery.ClickEvent): Promise<any> {
		const index = $(event.currentTarget).data("index")
		const features = (this.item.system as any).features
		features.splice(index, 1)
		const update: any = {}
		update["system.features"] = features
		return this.item.update(update)
	}

	protected async _addDefault(event: JQuery.ClickEvent): Promise<any> {
		event.preventDefault()
		const defaults = (this.item.system as any).defaults ?? []
		defaults.push({
			type: gid.Skill,
			name: "",
			specialization: "",
			modifier: 0,
		})
		const update: any = {}
		update["system.defaults"] = defaults
		return this.item.update(update)
	}

	protected async _removeDefault(event: JQuery.ClickEvent): Promise<any> {
		const index = $(event.currentTarget).data("index")
		const defaults = (this.item.system as any).defaults ?? []
		defaults.splice(index, 1)
		const update: any = {}
		update["system.defaults"] = defaults
		return this.item.update(update)
	}

	protected async _addStudy(event: JQuery.ClickEvent): Promise<any> {
		event.preventDefault()
		const study = (this.item.system as any).study
		study.push({
			type: StudyType.Self,
			hours: 0,
			note: "",
		})
		const update: any = {}
		update["system.study"] = study
		return this.item.update(update)
	}

	protected async _removeStudy(event: JQuery.ClickEvent): Promise<any> {
		const index = $(event.currentTarget).data("index")
		const study = (this.item.system as any).study
		study.splice(index, 1)
		const update: any = {}
		update["system.study"] = study
		return this.item.update(update)
	}

	protected async _onFeatureTypeChange(event: JQuery.ChangeEvent): Promise<any> {
		const value = event.currentTarget.value
		const index = $(event.currentTarget).data("index")
		const FeatureConstructor = CONFIG.GURPS.Feature.classes[value as FeatureType]
		const features = (this.item.system as any).features
		features[index] = {
			type: value,
			...FeatureConstructor.defaults,
		}
		// Const preUpdate: any = {}
		const update: any = {}
		// PreUpdate[`system.features.${index}`] = {}
		update["system.features"] = features
		// Await this.item.update(preUpdate, { render: false })
		return this.item.update(update)
	}

	protected async _onWeaponEdit(event: JQuery.DoubleClickEvent): Promise<any> {
		event.preventDefault()
		const uuid = $(event.currentTarget).data("uuid")
		new WeaponSheet(this.item as CharItemGURPS, uuid, {}).render(true)
	}

	protected override _getHeaderButtons(): Application.HeaderButton[] {
		const buttons: Application.HeaderButton[] = []
		const all_buttons = [...buttons, ...super._getHeaderButtons()]
		all_buttons.at(-1)!.label = ""
		all_buttons.at(-1)!.icon = "gcs-circled-x"
		return all_buttons
	}

	protected async _openItemSheet(event: JQuery.DoubleClickEvent) {
		event.preventDefault()
		const uuid = $(event.currentTarget).data("uuid")
		const item = (await fromUuid(uuid)) as ItemGURPS
		item?.sheet?.render(true)
	}
}

// @ts-ignore
export interface ItemSheetGCS extends ItemSheetGURPS {
	object: ItemGCS
}