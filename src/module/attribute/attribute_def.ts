import { PoolThreshold, PoolThresholdDef } from "./pool_threshold"
import { DamageProgression, gid } from "@module/data"
import { VariableResolver, evaluateToNumber, sanitize } from "@util"
import { CharacterGURPS } from "@actor"

export enum AttributeType {
	Integer = "integer",
	Decimal = "decimal",
	Pool = "pool",
	PrimarySeparator = "primary_separator",
	SecondarySeparator = "secondary_separator",
	PoolSeparator = "pool_separator",
}

export const reserved_ids: string[] = [gid.Skill, gid.Parry, gid.Block, gid.Dodge, gid.SizeModifier, gid.Ten]

export class AttributeDef {
	// Def_id = "";
	// type: AttributeType = "integer";
	// name = "";
	// full_name = "";
	// attribute_base = "10";
	// cost_per_point = 10;
	// cost_adj_percent_per_sm = 0;
	// thresholds?: PolThreshold[];
	// order = 0;

	constructor(data?: AttributeDefObj) {
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
		console.log(this, v)
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

	get isPrimary(): boolean {
		if (this.type === AttributeType.PrimarySeparator) return true
		if (this.type.includes("_separator")) return false
		return !isNaN(parseInt(this.attribute_base))
	}

	baseValue(resolver: VariableResolver): number {
		return evaluateToNumber(this.attribute_base, resolver)
	}

	computeCost(actor: CharacterGURPS, value: number, cost_reduction: number, size_modifier: number): number {
		let cost = value * this.cost_per_point
		if (
			size_modifier > 0 &&
			this.cost_adj_percent_per_sm > 0 &&
			!(this.def_id === "hp" && actor.settings.damage_progression === DamageProgression.KnowingYourOwnStrength)
		)
			cost_reduction = size_modifier * this.cost_adj_percent_per_sm
		if (cost_reduction > 0) {
			if (cost_reduction > 80) cost_reduction = 80
			cost = (cost * (100 - cost_reduction)) / 100
		}
		return Math.round(cost)
	}
}

export interface AttributeDefObj {
	id: string
	type: AttributeType
	name: string
	full_name?: string
	attribute_base: string
	cost_per_point: number
	cost_adj_percent_per_sm?: number
	thresholds?: PoolThresholdDef[]
	order?: number
}

export interface AttributeDef {
	def_id: string
	type: AttributeType
	name: string
	full_name: string
	attribute_base: string
	cost_per_point: number
	cost_adj_percent_per_sm: number
	thresholds?: PoolThreshold[]
	order: number
}
