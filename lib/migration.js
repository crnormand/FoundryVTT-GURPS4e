import { recurselist } from './utilities.js'
import * as Settings from './miscellaneous-settings.js'
import Maneuvers from '../module/actor/maneuver.js'

export class Migration {
	static async migrateTo096(quiet = false) {
		let v = Settings.VERSION_096?.toString()
		if (!quiet) ui.notifications?.info('Please wait, migrating Actors to v' + v)
		console.log('Migrating Actors to v' + v)

		for (let actor of game.actors?.contents || []) {
			let commit = { '_stats.systemVersion': v }

			let data = actor.data.data
			for (const attr in data.attributes) {
				if (data.attributes[attr].import == null)
					commit = {
						...commit,
						...{ ['data.attributes.' + attr + '.import']: data.attributes[attr].value || 1 },
					}
			}

			recurselist(data.skills, (e, k, d) => {
				if (e.import == null) commit = { ...commit, ...{ ['data.skills.' + k + '.import']: e.level || 1 } }
			})

			recurselist(data.spells, (e, k, d) => {
				if (e.import == null) commit = { ...commit, ...{ ['data.spells.' + k + '.import']: e.level || 1 } }
			})

			recurselist(data.melee, (e, k, d) => {
				if (e.import == null) commit = { ...commit, ...{ ['data.melee.' + k + '.import']: e.level || 1 } }
			})

			recurselist(data.ranged, (e, k, d) => {
				if (e.import == null) commit = { ...commit, ...{ ['data.ranged.' + k + '.import']: e.level || 1 } }
			})

			console.log('Updating ' + actor.name)
			console.log(GURPS.objToString(commit))
			await actor.update(commit)
		}
		if (!quiet) ui.notifications?.info('Migration to v' + v + ' complete!')
	}

	/**
	 * @param {boolean | undefined} [quiet]
	 */
	static async migrateTo097(quiet) {
		let v = Settings.VERSION_097?.toString()
		if (!quiet) ui.notifications?.info('Please wait, migrating Actors to v' + v)
		console.log('Migrating Actors to v' + v)
		for (let actor of game.actors?.contents || []) {
			let commit = { 'data.migrationversion': v }
			let data = actor.data.data

			recurselist(data.hitlocations, (e, k, d) => {
				if (e.import == null) commit = { ...commit, ...{ ['data.hitlocations.' + k + '.import']: e.dr } }
			})
			console.log('Updating ' + actor.name)
			console.log(GURPS.objToString(commit))
			try {
				await actor.update(commit)
			} catch (err) {
				console.log('Error trying to update TActors: ' + GURPS.objToString(err))
			}
		}
		if (!quiet) ui.notifications?.info('Migration to v' + v + ' complete!')
	}

	/**
	 * @param {boolean | undefined} [quiet]
	 */
	static async migrateTo0104(quiet) {
		let v = Settings.VERSION_0104?.toString()
		if (!quiet) ui.notifications?.info('Please wait, migrating Tokens to v' + v)
		console.log('Migrating Tokens to v' + v)
		for (const scene of game.scenes?.contents || []) {
			// @ts-ignore
			for (const tokendoc of scene.tokens.contents) {
				let actor = tokendoc.actor
				if (!!actor)
					// data protect against bad tokens
					for (const effect of actor.temporaryEffects) {
						let orig = effect.data.icon

						// Do not migrate maneuver icons until/unless we get .webp versions
						if (Maneuvers.isManeuverIcon(orig)) {
							continue
						}

						let icon = orig.replace('.jpg', '.webp').replace('.png', '.webp')
						console.log(actor.name + ':' + effect.data.label + ' ' + orig + ' -> ' + icon)
						try {
							await actor.updateEmbeddedDocuments('ActiveEffect', [{ _id: effect.id, icon: icon }])
						} catch (err) {
							console.log('Error trying to update Token effects: ' + GURPS.objToString(err))
						}
					}
			}
		}
		if (!quiet) ui.notifications?.info('Migration to v' + v + ' complete!')
	}

	/**
	 * @param {boolean} quiet
	 */
	static async migrateToManeuvers(quiet) {
		if (game.user?.isGM) {
			if (!quiet) ui.notifications?.info('Please wait, migrating tokens to use maneuvers.')

			for (const scene of game.scenes?.contents || []) {
				// @ts-ignore
				for (const tokendoc of scene.tokens.contents) {
					if (tokendoc.actor) {
						let maneuverText = tokendoc.actor.data.data.conditions.maneuver
						try {
							await tokendoc.object.setManeuver(maneuverText)
						} catch (err) {
							console.log('Error trying to update Token maneuvers: ' + GURPS.objToString(err))
						}
						tokendoc.object.drawEffects()
					}
				}
			}

			if (!quiet) ui.notifications?.info('Migration to maneuvers complete.')
		}
	}

	static async fixDataModelProblems(quiet) {
		// let v = Settings.VERSION_097?.toString()
		if (!quiet) ui.notifications?.info('Please wait, resolving data model problems')
		console.log('resolving data model problems')
		for (let actor of game.actors?.contents || []) {
			let data = actor.data.data
			let isupdated = false
			let keys = Object.getOwnPropertyNames(data.melee)
			for (let key of keys) {
				if (!key.match(/^\d{5}$/)) {
					delete data.melee[key]
					isupdated = true
				}
			}

			if (isupdated) {
				console.log('Updating ' + actor.name)
				console.log(GURPS.objToString({ 'data.-=melee': null }))
				await actor.update({ 'data.-=melee': null })
				console.log(GURPS.objToString({ 'data.melee': data.melee }))
				await actor.update({ 'data.melee': data.melee })
			}
		}
		if (!quiet) ui.notifications?.info('Resolving data model problems complete!')
	}
}
