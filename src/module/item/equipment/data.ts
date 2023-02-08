import { BaseContainerSource, BaseContainerSystemData } from "@item/container/data"
import { Feature, Weapon } from "@module/config"
import { ItemType } from "@module/data"
import { PrereqList } from "@prereq"

export type EquipmentSource = BaseContainerSource<ItemType.Equipment, EquipmentSystemData>

// Export class EquipmentData extends BaseContainerData<EquipmentGURPS> {}
export type CostValueType = "addition" | "percentage" | "multiplier"

export interface EquipmentData extends Omit<EquipmentSource, "effects" | "items">, EquipmentSystemData {
	readonly type: EquipmentSource["type"]
	data: EquipmentSystemData

	readonly _source: EquipmentSource
}

export interface EquipmentSystemData extends Omit<BaseContainerSystemData, "open"> {
	description: string
	prereqs: PrereqList
	equipped: boolean
	quantity: number
	tech_level: string
	legality_class: string
	value: number
	ignore_weight_for_skills: boolean
	weight: string
	uses: number
	max_uses: number
	weapons: Weapon[]
	features: Feature[]
	// Calc: {
	// 	extended_value: string;
	// 	extended_weight: string;
	// 	extended_weight_for_skills: string;
	// };
	// modifiers: Array<any>;
	other: boolean
}