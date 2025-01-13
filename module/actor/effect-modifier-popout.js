import GurpsWiring from '../gurps-wiring.js'
import { i18n, i18n_f, recurselist, sanitize } from '../../lib/utilities.js'
import { gurpslink } from '../utilities/gurpslink.js'
import { parselink } from '../../lib/parselink.js'
import { RulerGURPS } from '../../lib/ranges.js'
import { TokenActions } from '../token-actions.js'
import Maneuvers from './maneuver.js'
import * as Settings from '../../lib/miscellaneous-settings.js'

export const calculateRange = (token1, token2) => {
  if (!token1 || !token2) return undefined
  if (token1 === token2) return undefined

  // const ruler = new Ruler() as Ruler & { totalDistance: number }
  const ruler = new RulerGURPS(game.user)
  ruler._state = Ruler.STATES.MEASURING
  ruler._addWaypoint({ x: token1.x, y: token1.y }, { snap: false })
  ruler.measure({ x: token2.x, y: token2.y }, { gridSpaces: true })
  const horizontalDistance = ruler.totalDistance
  const verticalDistance = Math.abs(token1.document.elevation - token2.document.elevation)
  ruler.clear()

  const dist = Math.sqrt(horizontalDistance ** 2 + verticalDistance ** 2) - 1
  const yards = ruler.convert_to_yards(dist, canvas.scene.grid.units)
  return {
    yards: Math.ceil(dist),
    modifier: ruler.yardsToSpeedRangePenalty(yards),
  }
}

export const getRangedModifier = (source, target) => {
  const taggedModifiersSetting = game.settings.get(Settings.SYSTEM_NAME, Settings.SETTING_USE_TAGGED_MODIFIERS)
  const rangedTag = taggedModifiersSetting.allRangedRolls.split(',')[0]
  const baseTags = `#${rangedTag}`
  let rangeModifier
  let mod = calculateRange(source, target)
  if (mod && mod.modifier !== 0) {
    rangeModifier = game.i18n.format('GURPS.rangeToTarget', {
      modifier: mod.modifier,
      name: target.actor?.name,
      distance: mod.yards,
      unit: canvas.scene.grid.units,
    })
    rangeModifier += ` ${baseTags} @combatmod`
  }
  return rangeModifier
}

export class EffectModifierPopout extends Application {
  constructor(token, callback, options = {}) {
    super(options)
    this._token = token
    this._callback = callback
  }

  /** @override */
  static get defaultOptions() {
    let x = $('#sidebar')
    let sidebarLeft = x.parent().position().left
    return foundry.utils.mergeObject(super.defaultOptions, {
      template: 'systems/gurps/templates/actor/effect-modifier-popout.hbs',
      classes: ['sidebar-popout effect-modifiers-app'],
      popOut: true,
      top: 0,
      width: 550,
      left: sidebarLeft - 555,
      height: 'auto',
      minimizable: true,
      jQuery: true,
      resizable: true,
      title: i18n('GURPS.effectModifierPopout', 'Effect Modifiers'),
    })
  }

  /** @override */
  getData(options) {
    if (!this._token?.actor) return
    let selfMods = []
    selfMods = this.convertModifiers(this._token.actor.system.conditions.self.modifiers)
    selfMods.push(...this.convertModifiers(this._token.actor.system.conditions.usermods))
    selfMods.sort((a, b) => {
      if (a.itemName === b.itemName) {
        return a.desc.localeCompare(b.desc)
      }
      return a.itemName.localeCompare(b.itemName)
    })
    const targetModifiers = this._token
      ? this.convertModifiers(this._token.actor.system.conditions.target.modifiers)
      : []
    return foundry.utils.mergeObject(super.getData(options), {
      selected: this.selectedToken,
      selfmodifiers: selfMods,
      targetmodifiers: targetModifiers,
      targets: this.targets,
    })
  }

  get targets() {
    let results = []
    for (const target of Array.from(game.user.targets)) {
      let result = {}
      result.name = target.name

      result.targetmodifiers = target.actor
        ? this.convertModifiers(target.actor.system.conditions.target.modifiers)
        : []
      const rangeModifier = getRangedModifier(this.getToken(), target)
      if (rangeModifier) {
        const data = this.convertModifiers([rangeModifier])
        result.targetmodifiers = [...result.targetmodifiers, ...data]
      }
      // Add the range to the target
      results.push(result)
    }
    return results
  }

  convertModifiers(list) {
    return Array.isArray(list)
      ? list.map(it => {
          const tags = this.getTags(it)
          let itemReference = it.match(/@(\S+)/)?.[1] || 'custom'
          let obj = {}
          if (itemReference.includes('system.')) {
            if (itemReference.includes('.conditionalmods.')) {
              obj.name = game.i18n.localize('GURPS.conditionalMods')
            } else if (itemReference.includes('.reactions.')) {
              obj.name = game.i18n.localize('GURPS.reactionMods')
            } else {
              obj = foundry.utils.getProperty(this._token.actor, itemReference)
            }
          } else if (itemReference.match(/\w{3}:/)) {
            const refType = itemReference.match(/(\w{3}):/)[1]
            const refValue = itemReference.match(/\w{3}:(\S+)/)[1]
            switch (refType) {
              case 'man':
                const maneuver = Maneuvers.getManeuver(refValue)
                obj.name = game.i18n.localize(maneuver.label)
                obj.type = 'maneuver'
                break
              case 'eft':
                const effect = this._token?.actor.effects.get(refValue)
                obj.name = effect.name || game.i18n.localize('GURPS.ActiveEffect')
                obj.type = 'active-effect'
            }
          } else {
            obj = this._token?.actor.items.get(itemReference) || {}
          }
          const itemName = obj?.name || itemReference
          const itemType = obj?.type
            ? obj.type
            : it.includes('#maneuver')
              ? 'maneuver'
              : itemReference.includes('system.')
                ? itemReference.split('.')[1]
                : 'notfound'
          const desc = this.getDescription(it, itemReference)
          return {
            link: gurpslink(`[${i18n(desc)}]`),
            desc: i18n(desc),
            itemName,
            itemType,
            itemId: itemReference,
            tags,
          }
        })
      : []
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
    super.activateListeners(html)

    GurpsWiring.hookupGurps(html)

    html.find('a.gurpslink').on('contextmenu', ev => this.onRightClick(ev))
    html.find('.gurpslink').on('contextmenu', ev => this.onRightClick(ev))
    html.find('.glinkmod').on('contextmenu', ev => this.onRightClick(ev))
    html.find('.glinkmodplus').on('contextmenu', ev => this.onRightClick(ev))
    html.find('.glinkmodminus').on('contextmenu', ev => this.onRightClick(ev))
    html.find('.gmod').on('contextmenu', ev => this.onRightClick(ev))

    html.closest('div.effect-modifiers-app').on('drop', ev => this.handleDrop(ev))
    html.find('.modifier-list').on('drop', ev => this.handleDrop(ev))
    html
      .closest('div.effect-modifiers-app')
      .find('.window-title')
      .text(i18n_f('GURPS.effectModifierPopout', { name: this.selectedToken }, 'Effect Modifiers: {name}'))
  }

  _getHeaderButtons() {
    let buttons = super._getHeaderButtons()
    buttons.unshift({
      class: 'trash',
      icon: 'fas fa-trash',
      onclick: async ev => this.clearUserMods(ev),
    })
    buttons.unshift({
      class: 'add',
      icon: 'fas fa-plus',
      onclick: ev => this.addUserMod(ev),
    })
    buttons.unshift({
      class: 'refresh',
      icon: 'fas fa-sync',
      onclick: async ev => this.refreshUserMods(ev),
    })
    return buttons
  }

  async refreshUserMods(event) {
    const actor = this.getToken()?.actor
    if (actor) {
      const userMods = foundry.utils.getProperty(actor, 'system.conditions.usermods') || []
      const customMods = userMods.filter(it => it.includes('@custom'))
      const itemMods = actor.applyItemModEffects({})
      let sheetMods = []

      const taggedSettings = game.settings.get(Settings.SYSTEM_NAME, Settings.SETTING_USE_TAGGED_MODIFIERS)
      if (taggedSettings.checkConditionals) {
        const conditionalMods = foundry.utils.getProperty(actor, 'system.conditionalmods') || {}
        recurselist(conditionalMods, (e, _k, _d) => {
          const mod = parseInt(e.modifier) || 0
          const signal = mod > 0 ? '+' : '-'
          const source = `system.conditionalmods.${_k}`
          if (mod !== 0) sheetMods.push(`${signal}${Math.abs(mod)} ${e.situation} @${source}`)
        })
      }
      if (taggedSettings.checkReactions) {
        const reactionMods = foundry.utils.getProperty(actor, 'system.reactions') || {}
        recurselist(reactionMods, (e, _k, _d) => {
          const mod = parseInt(e.modifier) || 0
          const signal = mod > 0 ? '+' : '-'
          const source = `system.reactions.${_k}`
          if (mod !== 0) sheetMods.push(`${signal}${Math.abs(mod)} ${e.situation} @${source}`)
        })
      }
      const newMods = [...itemMods['system.conditions.usermods'], ...customMods, ...sheetMods]
      await actor.internalUpdate({ 'system.conditions.usermods': newMods })
      // Check if combat
      if (!!game.combat?.isActive) {
        const actions = await TokenActions.fromToken(this.getToken())
        await actions.addModifiers()
      }
      await this.render(true)
      ui.notifications.info(i18n('GURPS.userModsRefreshed'))
    }
  }

  async clearUserMods(event) {
    const actor = this.getToken()?.actor
    // Add a Confirm dialog
    await Dialog.confirm({
      title: i18n('GURPS.confirmClearUserMods'),
      content: i18n('GURPS.confirmClearHintUserMods'),
      yes: async () => {
        if (actor) {
          await actor.update({ 'system.conditions.usermods': [] })
          await this.render(true)
        }
      },
      defaultYes: false,
    })
  }

  addUserMod(event) {
    if (this.getToken()) {
      setTimeout(() => $.find('#GURPS-user-mod-input')[0].focus(), 200)
      Dialog.prompt({
        title: 'Enter new modifier:',
        content:
          "<input type='text' id='GURPS-user-mod-input' style='text-align: left;' placeholder ='Ex.: +1 GM&#39s Luck #hit #damage #check #combat'>'",
        label: 'Add (or press Enter)',
        callback: html => {
          let mod = html.find('#GURPS-user-mod-input').val()
          // Because the '@' separator is a reserved character, we will replace it with space
          mod = mod.replace('@', ' ')
          if (!!mod) {
            let action = parselink(mod)
            if (action.action?.type === 'modifier') this._addUserMod(mod)
            else ui.notifications.warn(i18n('GURPS.chatUnrecognizedFormat'))
          }
        },
        rejectClose: false,
      })
    } else ui.notifications.warn(i18n('GURPS.chatYouMustHaveACharacterSelected'))
  }

  getDescription(text, itemRef) {
    const regex = /^(.*?)(?=[#@])/
    const desc = text.match(regex)?.[1]
    return !!desc ? desc.trim() : text
  }

  getTags(text) {
    const tags = text.match(/#(\S+)/g)?.map(it => it.slice(1))
    return !!tags ? tags : []
  }

  onRightClick(event) {
    event.preventDefault()
    event.stopImmediatePropagation() // Since this may occur in note or a list (which has its own RMB handler)
    let el = event.currentTarget
    let text = sanitize(el.innerHTML)
    const itemId = $(el).closest('.me-link').data().itemId
    const itemType = $(el).closest('.me-link').data().type
    if (!!itemId && itemId.includes('system.') && itemType !== 'maneuver') {
      this._token.actor.sheet?.render(true)
      return
    }
    if (!!itemId && itemId !== 'custom' && itemType !== 'maneuver' && itemType !== 'active-effect') {
      const item = this._token.actor.items.get(itemId)
      if (item) {
        item.sheet.render(true)
      }
      return
    }
    if (!!itemId && itemType === 'active-effect') {
      const effectId = itemId.split(':')[1]
      const effect = this._token.actor.effects.get(effectId)
      if (effect) {
        effect.sheet.render(true)
      }
      return
    }
    let t = this.getToken()
    if (t && t.actor) {
      let umods = t.actor.system.conditions.usermods
      if (umods) {
        let m = umods.filter(i => !sanitize(i).includes(this.getDescription(text)))
        if (umods.length !== m.length) t.actor.update({ 'system.conditions.usermods': m }).then(() => this.render(true))
      }
    }
  }

  handleDrop(ev) {
    ev.preventDefault()
    ev.stopImmediatePropagation()
    if (!!ev.originalEvent) ev = ev.originalEvent
    let dragData = JSON.parse(ev.dataTransfer.getData('text/plain'))
    let add = ''
    if (!!dragData.otf) {
      let action = parselink(dragData.otf)
      if (action.action?.type == 'modifier' || action.action?.type == 'damage') add = dragData.otf
    }
    if (!!dragData.bucket) {
      let sep = ''
      dragData.bucket.forEach(otf => {
        add += sep + otf.trim()
        sep = ' & '
      })
    }
    if (add.length == 0) return
    this._addUserMod(add)
  }

  _addUserMod(mod) {
    let t = this.getToken()
    if (t && t.actor) {
      mod += ' (' + i18n('GURPS.equipmentUserCreated') + ')'
      let m = t.actor.system.conditions.usermods ? [...t.actor.system.conditions.usermods] : []
      m.push(`${mod} @custom`)
      t.actor.update({ 'system.conditions.usermods': m }).then(() => this.render(true))
    } else ui.notifications.warn(i18n('GURPS.chatYouMustHaveACharacterSelected'))
  }

  /** @override */
  async close(options) {
    this._callback.close(options)
  }

  async closeApp(options) {
    super.close(options)
  }
}

/**
 * Cleans up tags to be used in the settings
 * @param {string} tags
 * @returns {string[]}
 */
export const cleanTags = tags =>
  (tags || '')
    .split(',')
    .map(it => it.trim())
    .filter(it => !!it)
    .map(it => it.toLowerCase())
    .map(it => it.replace(/\W/g, ''))

export class TaggedModifierSettings extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      title: game.i18n.localize('GURPS.settingUseTaggedModifiers'),
      id: 'use-tagged-modifiers',
      template: 'systems/gurps/templates/tagged-modifier-settings.hbs',
      width: 500,
      closeOnSubmit: true,
      tabs: [{ navSelector: '.gurps-sheet-tabs', contentSelector: '.content', initial: 'all-rolls-tab' }],
    })
  }

  getData() {
    return {
      ...game.settings.get(Settings.SYSTEM_NAME, Settings.SETTING_USE_TAGGED_MODIFIERS),
    }
  }

  async _updateObject(event, formData) {
    const cleanData = Object.keys(formData).reduce((acc, key) => {
      if (typeof formData[key] === 'string') {
        if (key.toLowerCase().includes('combat')) {
          acc[key] = cleanTags(formData[key])[0]
        } else {
          acc[key] = cleanTags(formData[key]).join(', ')
        }
      } else {
        acc[key] = formData[key]
      }
      return acc
    }, {})
    await game.settings.set(Settings.SYSTEM_NAME, Settings.SETTING_USE_TAGGED_MODIFIERS, cleanData)
  }
}
