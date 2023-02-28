export const init = function() {
	//Add support for the Drag Ruler module: https://foundryvtt.com/packages/drag-ruler
	Hooks.once('dragRuler.ready', SpeedProvider => {
		class GURPSSpeedProvider extends SpeedProvider {
			get colors() {
				return [
					{ id: 'walk', default: 0x00ff00, name: 'GURPS.dragrulerWalk' },
					{ id: 'sprint', default: 0xffff00, name: 'GURPS.dragrulerSprint' },
					{ id: 'fly', default: 0xff8000, name: 'GURPS.dragrulerFly' },
				]
			}

			/**
			 * @param {GurpsToken} token
			 */
			getRanges(token) {
				const actordata = token.actor.data.data

				const ranges = [
					{ range: actordata.currentmove, color: 'walk' },
					{ range: actordata.currentsprint, color: 'sprint' },
				]
				return ranges
			}
		}
		dragRuler.registerSystem('gurps', GURPSSpeedProvider)
	})
}
