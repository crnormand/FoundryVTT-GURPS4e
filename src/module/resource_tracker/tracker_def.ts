import { reserved_ids } from "@module/attribute/attribute_def"
import { PoolThreshold, PoolThresholdDef } from "@module/attribute/pool_threshold"
import { sanitize, VariableResolver } from "@util"

export interface ResourceTrackerDefObj {
	id: string
	name: string
	full_name: string
	max: number
	min: number
	isMaxEnforced: boolean
	isMinEnforced: boolean
	thresholds?: PoolThresholdDef[]
	order: number
}

export class ResourceTrackerDef {
	def_id = ""

	name = ""

	full_name = ""

	thresholds: PoolThreshold[] = []

	order = 0

	max = 10

	min = 0

	isMaxEnforced = false

	isMinEnforced = false

	constructor(data?: ResourceTrackerDefObj) {
		if (data) {
			const thr: PoolThreshold[] = []
			if (data.thresholds)
				for (const t of data.thresholds) {
					thr.push(new PoolThreshold(t))
				}
			data.thresholds = thr
			Object.assign(this, data)
		}
	}

	get id(): string {
		return this.def_id
	}

	set id(v: string) {
		this.def_id = sanitize(v, false, reserved_ids)
	}

	get resolveFullName(): string {
		if (!this.full_name) return this.name
		return this.full_name
	}

	get combinedName(): string {
		if (!this.full_name) return this.name
		if (!this.name || this.name === this.full_name) return this.full_name
		return `${this.full_name} (${this.name})`
	}

	baseValue(_resolver: VariableResolver): number {
		return this.max
		// Return evaluateToNumber(this.tracker_base, resolver)
	}
}

export interface ResourceTrackerDef {
	id: string
}