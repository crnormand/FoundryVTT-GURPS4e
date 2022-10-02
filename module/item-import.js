import { zeroFill } from '../lib/utilities.js'

export class ItemImporter {
  constructor() {
    this.count = 0
  }

  static async importItems(text, filename, filepath) {
    let importer = new ItemImporter()
    importer._importItems(text, filename, filepath)
  }

  async _importItems(text, filename, filepath) {
    let j = {}
    try {
      j = JSON.parse(text)
    } catch {
      return ui.notifications.error('The file you uploaded was not of the right format!')
    }
    if (j.type !== 'equipment_list') {
      return ui.notifications.error('The file you uploaded is not a GCS Equipment Library!')
    }
    if (![2, 4].includes(j.version)) {
      return ui.notifications.error('The file you uploaded is not of the right version!')
    }
    let pack = game.packs.find(p => p.metadata.name === filename)
    if (!pack)
      pack = await CompendiumCollection.createCompendium({
        entity: 'Item',
        label: filename,
        name: filename,
        package: 'world',
      })
    let timestamp = new Date()
    ui.notifications.info('Importing Items from ' + filename + '...')
    for (let i of j.rows) {
      await this._importItem(i, pack, filename, timestamp)
    }
    ui.notifications.info('Finished Importing ' + this.count + ' Items!')
  }

  async _importItem(i, pack, filename, timestamp) {
    this.count++
    if (i.children?.length)
      for (let ch of i.children) {
        await this._importItem(ch, pack, filename, timestamp)
      }
    let itemData = {
      name: i.description,
      type: 'equipment',
      system: {
        eqt: {
          name: i.description,
          notes: i.notes,
          pageref: i.reference,
          count: i.quantity,
          cost: !!i.value ? parseFloat(i.value) : 0,
          weight: !!i.weight ? parseFloat(i.weight) : 0,
          carried: true,
          equipped: true,
          techlevel: i.tech_level || '',
          categories: i.categories || '',
          legalityclass: i.legality_class || '',
          costsum: !!i.value ? parseFloat(i.value) : 0,
          weightsum: !!i.weight ? parseFloat(i.weight) : 0,
          uses: !!i.max_uses ? i.max_uses.toString() : '',
          maxuses: !!i.max_uses ? i.max_uses.toString() : 0,
          last_import: timestamp,
          uuid: i.id,
        },
        melee: {},
        ranged: {},
        bonuses: '',
        equipped: true,
        carried: true,
      },
    }
    if (i.weapons?.length)
      for (let w of i.weapons) {
        let otf_list = []
        if (w.defaults)
          for (let d of w.defaults) {
            let mod = !!d.modifier ? (d.modifier > -1 ? `+${d.modifier}` : d.modifier.toString()) : ''
            if (d.type === 'skill') {
              //otf_list.push(`S:${d.name.replace(/ /g, "*")}` + (d.specialization ? `*(${d.specialization.replace(/ /g, "*")})` : "") + mod);
              otf_list.push(`S:"${d.name}` + (d.specialization ? `*(${d.specialization})` : '') + '"' + mod)
            } else if (
              [
                '10',
                'st',
                'dx',
                'iq',
                'ht',
                'per',
                'will',
                'vision',
                'hearing',
                'taste_smell',
                'touch',
                'parry',
                'block',
              ].includes(d.type)
            ) {
              otf_list.push(d.type.replace('_', ' ') + mod)
            }
          }
        if (w.type === 'melee_weapon') {
          let wep = {
            block: w.block || '',
            damage: w.calc.damage || '',
            mode: w.usage || '',
            name: itemData.name,
            notes: itemData.eqt.notes || '',
            pageref: itemData.system.eqt.pageref || '',
            parry: w.parry || '',
            reach: w.reach || '',
            st: w.strength || '',
            otf: otf_list.join('|') || '',
          }
          itemData.system.melee[zeroFill(Object.keys(itemData.system.melee).length + 1)] = wep
        } else if (w.type === 'ranged_weapon') {
          let wep = {
            acc: w.accuracy || '',
            ammo: '',
            bulk: w.bulk || '',
            damage: w.calc.damage || '',
            mode: w.usage,
            name: itemData.name,
            notes: itemData.system.eqt.notes || '',
            pageref: itemData.system.eqt.pageref || '',
            range: w.range,
            rcl: w.recoil,
            rof: w.rate_of_fire,
            shots: w.shots,
            st: w.strength,
            otf: otf_list.join('|') || '',
          }
          itemData.system.ranged[zeroFill(Object.keys(itemData.system.ranged).length + 1)] = wep
        }
      }
    let bonus_list = []
    let feat_list = []
    if (i.features?.length)
      for (let f of i.features) {
        feat_list.push(f)
      }
    if (i.modifiers?.length)
      for (let m of i.modifiers) {
        if (!m.disabled && m.features?.length)
          for (let f of m.features) {
            feat_list.push(f)
          }
      }
    if (feat_list.length)
      for (let f of feat_list) {
        let bonus = !!f.amount ? (f.amount > -1 ? `+${f.amount}` : f.amount.toString()) : ''
        if (f.type === 'attribute_bonus') {
          bonus_list.push(`${f.attribute} ${bonus}`)
        } else if (f.type === 'dr_bonus') {
          bonus_list.push(`DR ${bonus} *${f.location}`)
        } else if (f.type === 'skill_bonus') {
          if (f.selection_type === 'skills_with_name' && f.name?.compare === 'is') {
            if (f.specialization?.compare === 'is') {
              bonus_list.push(
                `A:${(f.name.qualifier || '').replace(/ /g, '*')}${(f.specialization.qualifier || '').replace(
                  / /g,
                  '*'
                )} ${bonus}`
              )
            } else if (!f.specialization) {
              bonus_list.push(`A:${(f.name.qualifier || '').replace(/ /g, '*')} ${bonus}`)
            }
          } else if (f.selection_type === 'weapons_with_name' && f.name?.compare === 'is') {
            if (f.specialization?.compare === 'is') {
              bonus_list.push(
                `A:${(f.name.qualifier || '').replace(/ /g, '*')}${(f.specialization.qualifier || '').replace(
                  / /g,
                  '*'
                )} ${bonus}`
              )
            } else if (!f.specialization) {
              bonus_list.push(`A:${(f.name.qualifier || '').replace(/ /g, '*')} ${bonus}`)
            }
          } else if (f.selection_type === 'this_weapon') {
            bonus_list.push(`A:${itemData.name.replace(/ /g, '*')} ${bonus}`)
          }
        } else if (f.type === 'spell_bonus') {
          if (f.match === 'spell_name' && f.name?.compare === 'is') {
            bonus_list.push(`S:${(f.name.qualifier || '').replace(/ /g, '*')} ${bonus}`)
          }
        } else if (f.type === 'weapon_bonus') {
          if (f.selection_type === 'weapons_with_name') {
            if (f.specialization?.compare === 'is') {
              bonus_list.push(
                `D:${(f.name?.qualifier || '').replace(/ /g, '*')}${(f.specialization.qualifier || '').replace(
                  / /g,
                  '*'
                )} ${bonus}`
              )
            } else if (!f.specialization) {
              bonus_list.push(`D:${(f.name?.qualifier || '').replace(/ /g, '*')} ${bonus}`)
            }
          } else if (f.selection_type === 'this_weapon') {
            bonus_list.push(`D:${itemData.name.replace(/ /g, '*')} ${bonus}`)
          }
        }
      }
    itemData.system.bonuses = bonus_list.join('\n')
    const cachedItems = []
    for (let i of pack.index) {
      cachedItems.push(await pack.getDocument(i._id))
    }
    let oi = await cachedItems.find(p => p.system.eqt.uuid === itemData.eqt.uuid)
    if (!!oi) {
      let oldData = duplicate(oi.data)
      let newData = duplicate(itemData)
      delete oldData.eqt.uuid
      delete newData.eqt.uuid
      if (oldData != newData) {
        return oi.update(itemData)
      }
    } else {
      return Item.create(itemData, { pack: `world.${filename}` })
    }
  }
}
